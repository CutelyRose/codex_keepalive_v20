import { MAX_EVENTS, MAX_RESPONSE_SUMMARY_BYTES } from '../core/constants';
import { notificationConfigured, validateTaskConfig } from '../core/task-config';
import type {
  NotificationClient,
  NotificationPayload,
  NotificationReceipt,
  Task,
  TaskConfig,
  TaskEvent,
} from '../core/types';
import {
  isAcceptedStatus,
  isSchedulableStatus,
  isTerminalStatus,
  isTaskActive,
  keyTail,
  makeId,
  randomUUID,
  truncateUtf8,
} from '../core/utils';
import { NotificationReadError, NotificationApiClient } from './notification-client';
import { ModelRequestError, retryableModelError, retryAfterMilliseconds } from './request-errors';
import {
  buildTaskRequest,
  type BuiltRequest,
} from './request-builders';
import { parseSseJson, readSseStream, type SseEvent } from './sse-parser';
import { apiHost } from '../core/api-url';

type TimerHandle = ReturnType<typeof globalThis.setTimeout>;

/** One parallel probe inside a round. It owns its own timers and abort handle. */
interface AttemptLane {
  controller: AbortController;
  firstEventTimer?: TimerHandle;
  totalTimer?: TimerHandle;
  idleTimer?: TimerHandle;
  /** A sibling already saw the success event, so this lane must unwind without touching task state. */
  superseded: boolean;
  /** Private stream buffer; only the lane that wins a multi-lane round publishes it. */
  summary: string;
}

/** Shared state for one round of parallel lanes. */
interface RoundState {
  won: boolean;
  lanes: AttemptLane[];
}

interface LaneResult {
  /** This lane saw the success event; the round is won and no failure is reported. */
  accepted: boolean;
  detail?: string;
  retryable?: boolean;
  retryAfterMs?: number;
  sawEvent?: boolean;
}

interface TaskRuntime {
  generation: number;
  retryTimer?: TimerHandle;
  lanes: Set<AttemptLane>;
  notificationTimer?: TimerHandle;
  notificationInFlight?: boolean;
}

export interface LiveTaskEngineOptions {
  getKey: (keyId: string) => string | undefined;
  fetchImpl?: typeof fetch;
  notificationClient?: NotificationClient;
  notificationPollMs?: number;
  onChange?: (immediate: boolean) => void;
  now?: () => number;
  buildRequest?: (config: TaskConfig, token: string, sessionId: string) => BuiltRequest;
}

/**
 * Browser-side AnyRouter scheduler. Model traffic goes directly to AnyRouter;
 * notification jobs are sent to the same-origin notification service.
 */
export class LiveTaskEngine {
  readonly tasks = new Map<string, Task>();
  private readonly runtimes = new Map<string, TaskRuntime>();
  private readonly getKey: LiveTaskEngineOptions['getKey'];
  private readonly fetchImpl: typeof fetch;
  private readonly notificationClient: NotificationClient;
  private readonly notificationPollMs: number;
  private readonly onChange: (immediate: boolean) => void;
  private readonly now: () => number;
  private readonly buildRequest: NonNullable<LiveTaskEngineOptions['buildRequest']>;
  private disposed = false;
  private readonly onPollEnvironmentChange = (): void => {
    for (const task of this.tasks.values()) {
      const runtime = this.runtimes.get(task.id);
      if (runtime?.notificationTimer) globalThis.clearTimeout(runtime.notificationTimer);
      if (runtime) runtime.notificationTimer = undefined;
      if (pollingAvailable() && !task.notificationPollingPaused && notificationPending(task)) {
        this.scheduleNotificationPoll(task);
      }
    }
  };

  constructor(options: LiveTaskEngineOptions) {
    this.getKey = options.getKey;
    this.fetchImpl = options.fetchImpl ?? fetch.bind(globalThis);
    this.notificationClient = options.notificationClient ?? new NotificationApiClient();
    this.notificationPollMs = options.notificationPollMs ?? 2_000;
    this.onChange = options.onChange ?? (() => undefined);
    this.now = options.now ?? (() => Date.now());
    this.buildRequest = options.buildRequest ?? ((config, token, sessionId) => buildTaskRequest(config, token, { sessionId }));
    globalThis.addEventListener?.('online', this.onPollEnvironmentChange);
    globalThis.addEventListener?.('offline', this.onPollEnvironmentChange);
    globalThis.document?.addEventListener('visibilitychange', this.onPollEnvironmentChange);
  }

  list(): Task[] {
    return [...this.tasks.values()].sort((a, b) => b.startedAt - a.startedAt);
  }

  get(id: string): Task | undefined {
    return this.tasks.get(id);
  }

  restore(tasks: Task[]): void {
    for (const source of tasks) {
      const task = cloneTask(source);
      if (isTaskActive(task)) {
        task.pausedFrom = task.status;
        task.status = 'paused';
        task.nextAttemptAt = undefined;
        task.updatedAt = this.now();
        this.addEvent(task, 'task.restored', '任务已恢复', '页面刷新后任务已暂停；点击继续可重新调度。', 'warning');
      } else if (task.status === 'accepted-streaming') {
        task.status = 'accepted-stream-interrupted';
        task.completedAt = this.now();
        task.updatedAt = this.now();
        task.lastError = '页面刷新中断了响应流';
        this.addEvent(task, 'stream.interrupted', '响应流已中断', '成功状态仍然有效，不会重新请求模型。', 'warning');
      }
      this.tasks.set(task.id, task);
      this.runtimes.set(task.id, { generation: 0, lanes: new Set() });
      if (
        task.notificationId &&
        (task.notificationStatus === 'queued' || task.notificationStatus === 'retrying')
      ) this.scheduleNotificationPoll(task);
    }
    if (tasks.length) this.emit();
  }

  create(config: TaskConfig): Task {
    config = validateTaskConfig(config);
    const now = this.now();
    const task: Task = {
      id: makeId('task'),
      scheduler: 'browser',
      sessionId: randomUUID(),
      config: { ...config },
      status: 'running',
      attemptsMade: 0,
      probeAttempts: 0,
      successes: 0,
      healthy: false,
      notificationConfigured: notificationConfigured(config),
      startedAt: now,
      updatedAt: now,
      responseSummary: '',
      events: [],
      notificationStatus: 'not-requested',
      notificationAttempts: 0,
    };
    this.tasks.set(task.id, task);
    this.runtimes.set(task.id, { generation: 0, lanes: new Set() });
    this.addEvent(task, 'task.created', '任务已创建', '浏览器独立调度器已启动。', 'info');
    this.emit();
    this.scheduleAttempt(task, 0);
    return task;
  }

  pause(id: string): boolean {
    const task = this.tasks.get(id);
    if (!task || !isTaskActive(task)) return false;
    const previous = task.status;
    this.stopModelWork(id);
    task.pausedFrom = previous;
    task.status = 'paused';
    task.nextAttemptAt = undefined;
    task.updatedAt = this.now();
    this.addEvent(task, 'task.paused', '任务已暂停', '继续后从当前时间调度，不补发积压请求。', 'warning');
    this.emit();
    return true;
  }

  resume(id: string): boolean {
    const task = this.tasks.get(id);
    if (!task || task.status !== 'paused') return false;
    if (!task.healthy && task.probeAttempts >= task.config.maxAttempts) {
      this.exhaust(task);
      return false;
    }
    task.status = 'running';
    task.pausedFrom = undefined;
    task.updatedAt = this.now();
    this.addEvent(task, 'task.resumed', '任务已继续', '下一次请求将从当前时间立即发起。', 'info');
    this.emit();
    this.scheduleAttempt(task, 0);
    return true;
  }

  cancel(id: string): boolean {
    const task = this.tasks.get(id);
    if (!task || isTerminalStatus(task.status) || (isAcceptedStatus(task.status) && !task.config.keepalive)) return false;
    this.clearAllRuntime(id);
    task.status = 'cancelled';
    task.nextAttemptAt = undefined;
    task.completedAt = this.now();
    task.updatedAt = this.now();
    this.addEvent(task, 'task.cancelled', '任务已取消', '当前连接和后续请求均已停止。', 'neutral');
    this.emit();
    return true;
  }

  retryNow(id: string): boolean {
    const task = this.tasks.get(id);
    if (!task || !['waiting', 'keepalive', 'paused'].includes(task.status)) return false;
    if (!task.healthy && task.probeAttempts >= task.config.maxAttempts) {
      this.exhaust(task);
      return false;
    }
    this.stopModelWork(id);
    task.status = 'running';
    task.pausedFrom = undefined;
    task.nextAttemptAt = undefined;
    task.updatedAt = this.now();
    this.addEvent(task, 'task.retry-now', '立即重试', '已跳过剩余等待时间。', 'info');
    this.emit();
    this.scheduleAttempt(task, 0);
    return true;
  }

  remove(id: string): boolean {
    if (!this.tasks.has(id)) return false;
    // Stops timers and aborts in-flight lanes; their continuations see a stale generation and unwind.
    this.clearAllRuntime(id);
    this.tasks.delete(id);
    this.runtimes.delete(id);
    this.emit();
    return true;
  }

  pauseMany(ids: string[]): number {
    return ids.reduce((count, id) => count + Number(this.pause(id)), 0);
  }

  cancelMany(ids: string[]): number {
    return ids.reduce((count, id) => count + Number(this.cancel(id)), 0);
  }

  removeMany(ids: string[]): number {
    return ids.reduce((count, id) => count + Number(this.remove(id)), 0);
  }

  dispose(): void {
    this.disposed = true;
    for (const id of this.runtimes.keys()) this.clearAllRuntime(id);
    globalThis.removeEventListener?.('online', this.onPollEnvironmentChange);
    globalThis.removeEventListener?.('offline', this.onPollEnvironmentChange);
    globalThis.document?.removeEventListener('visibilitychange', this.onPollEnvironmentChange);
  }

  private scheduleAttempt(task: Task, delayMs: number): void {
    if (this.disposed || !isSchedulableStatus(task.status) || isAcceptedStatus(task.status)) return;
    const runtime = this.ensureRuntime(task.id);
    if (runtime.retryTimer) globalThis.clearTimeout(runtime.retryTimer);
    runtime.retryTimer = undefined;
    task.status = task.healthy && task.config.keepalive ? 'keepalive' : delayMs > 0 ? 'waiting' : 'running';
    task.nextAttemptAt = delayMs > 0 ? this.now() + delayMs : undefined;
    task.updatedAt = this.now();
    this.emit();
    runtime.retryTimer = globalThis.setTimeout(() => {
      runtime.retryTimer = undefined;
      void this.beginAttempt(task.id);
    }, delayMs);
  }

  /**
   * Runs one round. A round fires `concurrency` parallel lanes that share a generation and a
   * single attempts budget; the first lane to see a success event wins and the rest are aborted.
   * When no lane succeeds, the round reports exactly one failure and the normal retry cadence
   * resumes. `concurrency: 1` degenerates to the original single-probe behaviour.
   */
  private async beginAttempt(id: string): Promise<void> {
    const task = this.tasks.get(id);
    const runtime = this.runtimes.get(id);
    if (
      this.disposed ||
      !task ||
      !runtime ||
      !isSchedulableStatus(task.status) ||
      isAcceptedStatus(task.status)
    ) return;
    if (!task.healthy && task.probeAttempts >= task.config.maxAttempts) {
      this.exhaust(task);
      return;
    }

    const token = this.getKey(task.config.keyId)?.trim();
    const generation = ++runtime.generation;
    const laneCount = task.healthy ? 1 : Math.min(task.config.concurrency, task.config.maxAttempts - task.probeAttempts);
    const round: RoundState = { won: false, lanes: [] };

    task.status = 'requesting';
    task.nextAttemptAt = undefined;
    task.lastError = undefined;
    task.completedAt = undefined;
    task.responseSummary = '';
    task.lastAttemptAt = this.now();
    task.updatedAt = this.now();
    for (let index = 0; index < laneCount; index += 1) {
      const lane: AttemptLane = { controller: new AbortController(), superseded: false, summary: '' };
      round.lanes.push(lane);
      runtime.lanes.add(lane);
      task.attemptsMade += 1;
      if (!task.healthy) task.probeAttempts += 1;
      this.addEvent(
        task,
        'request.started',
        `第 ${task.attemptsMade} 次探针`,
        `${task.config.channel === 'gpt' ? 'Responses' : 'Claude Messages'} 流正在建立。`,
        'neutral',
      );
    }
    this.emit();

    const results = await Promise.all(
      round.lanes.map((lane) => this.runLane(task, runtime, generation, token, lane, round)),
    );

    if (this.disposed || !this.isCurrent(task, generation)) return;
    if (round.won) {
      if (task.config.keepalive && isAcceptedStatus(task.status)) {
        const seconds = task.config.keepaliveMinSeconds + Math.random() * (task.config.keepaliveMaxSeconds - task.config.keepaliveMinSeconds);
        task.status = 'keepalive';
        task.completedAt = undefined;
        this.addEvent(task, 'keepalive.waiting', '自动保活', `下一次保活间隔 ${seconds.toFixed(1)} 秒。`, 'success');
        this.scheduleAttempt(task, Math.max(0, (task.lastAttemptAt ?? this.now()) + seconds * 1000 - this.now()));
      }
      return;
    }
    if (isAcceptedStatus(task.status)) return;

    const failures = results.flatMap((result) => (result.detail ? [result] : []));
    const detail = failures.length
      ? roundFailureDetail(failures.map((failure) => failure.detail as string))
      : results.some((result) => result.sawEvent)
        ? 'SSE 流结束但未收到成功信号'
        : '空 SSE 流未返回事件';
    this.failAttempt(
      task,
      detail,
      failures.every((failure) => failure.retryable !== false),
      failures.reduce((max, failure) => Math.max(max, failure.retryAfterMs ?? 0), 0),
    );
  }

  private async runLane(
    task: Task,
    runtime: TaskRuntime,
    generation: number,
    token: string | undefined,
    lane: AttemptLane,
    round: RoundState,
  ): Promise<LaneResult> {
    const controller = lane.controller;
    let timeoutDetail: string | undefined;
    let accepted = false;
    let sawEvent = false;
    const armIdleTimer = (): void => {
      if (lane.idleTimer) globalThis.clearTimeout(lane.idleTimer);
      lane.idleTimer = globalThis.setTimeout(() => {
        timeoutDetail = '响应流 60 秒无数据';
        controller.abort();
      }, 60_000);
    };
    try {
      if (!token) throw new ModelRequestError('本地 Key 已不存在或为空', false);
      let request: BuiltRequest;
      try { request = this.buildRequest(task.config, token, task.sessionId); }
      catch (error) { throw new ModelRequestError(errorMessage(error), false); }
      lane.firstEventTimer = globalThis.setTimeout(() => {
        timeoutDetail = `成功首事件超时（${task.config.timeoutSeconds} 秒）`;
        controller.abort();
      }, task.config.timeoutSeconds * 1_000);
      lane.totalTimer = globalThis.setTimeout(() => {
        timeoutDetail = '完整响应超过 10 分钟总期限';
        controller.abort();
      }, 10 * 60_000);

      const response = await this.fetchImpl(request.url, {
        method: 'POST',
        headers: request.headers,
        body: request.body,
        signal: controller.signal,
        cache: 'no-store',
      });
      if (!response.ok) {
        const detail = await responseError(response);
        throw new ModelRequestError(
          `${apiHost(task.config.baseUrl)} · ${detail}`,
          retryableModelError(detail, response.status),
          retryAfterMilliseconds(response.headers.get('Retry-After'), this.now()),
        );
      }
      if (!response.body) throw new ModelRequestError('响应不包含可读取的 SSE 流');
      armIdleTimer();

      await readSseStream(response.body, async (event) => {
        if (lane.superseded || !this.isCurrent(task, generation)) {
          throw new DOMException('任务已停止', 'AbortError');
        }

        const chunk = serializeSseEvent(event);
        // A single-lane round streams straight into the task. In a multi-lane round each lane buffers
        // privately and only the winning lane publishes, so parallel streams never interleave.
        if (round.lanes.length === 1 || round.won) this.appendSummary(task, chunk);
        else lane.summary = truncateUtf8(`${lane.summary}${chunk}`, MAX_RESPONSE_SUMMARY_BYTES);

        const payload = parseSseJson(event);
        const type = resolveEventType(event, payload);
        const meaningful = isMeaningfulEvent(event, type);
        if (meaningful && !sawEvent) {
          sawEvent = true;
        }
        if (!meaningful) {
          this.emit(false);
          return;
        }
        if (isSuccessEvent(task.config.channel, type)) {
          if (!round.won) {
            accepted = true;
            this.clearLaneTimer(lane, 'firstEventTimer');
            if (round.lanes.length > 1) task.responseSummary = lane.summary;
            winRound(round, lane);
            this.accept(task, type, token);
          } else {
            this.addEvent(task, type, '收到流事件', '成功后的响应流仍在读取。', 'info');
            this.emit(false);
          }
          return;
        }

        if (isFailureEvent(type)) {
          const detail = sseErrorDetail(type, payload, event.data);
          this.addEvent(task, type, accepted ? '成功后的流错误' : 'SSE 返回错误', detail, 'danger');
          this.emit();
          throw new ModelRequestError(detail, retryableModelError(detail));
        }

        if (event.data !== '[DONE]') {
          this.addEvent(task, type, '收到 SSE 事件', '继续等待成功信号。', 'info');
          this.emit(false);
        }
      }, { signal: controller.signal, maxBytes: 2 * 1024 * 1024, onData: armIdleTimer });

      if (lane.superseded) return { accepted: false };
      this.clearLaneTimer(lane, 'firstEventTimer');
      if (!this.isCurrent(task, generation)) return { accepted: false };
      if (accepted || isAcceptedStatus(task.status)) {
        task.status = 'accepted-completed';
        task.completedAt = this.now();
        task.updatedAt = this.now();
        task.lastError = undefined;
        this.addEvent(task, 'stream.completed', '响应流已结束', '成功连接已正常读取至结束。', 'success');
        this.emit();
        return { accepted: true };
      }
      return { accepted: false, sawEvent };
    } catch (error) {
      if (lane.superseded) return { accepted: false };
      this.clearLaneTimer(lane, 'firstEventTimer');
      if (!this.isCurrent(task, generation)) return { accepted: false };
      const rawDetail = timeoutDetail ?? errorMessage(error);
      const detail = token
        ? withApiHost(task.config.baseUrl, rawDetail)
        : rawDetail;
      if (accepted || isAcceptedStatus(task.status)) {
        task.status = 'accepted-stream-interrupted';
        task.completedAt = this.now();
        task.updatedAt = this.now();
        task.lastError = detail;
        this.addEvent(
          task,
          'stream.interrupted',
          '流已中断',
          `${detail}；成功信号已经确认，不会重新请求模型。`,
          'warning',
        );
        this.emit();
        return { accepted: true };
      }
      return {
        accepted: false,
        detail,
        retryable: error instanceof ModelRequestError
          ? error.retryable
          : !/大小限制/.test(detail) && retryableModelError(detail),
        retryAfterMs: error instanceof ModelRequestError ? error.retryAfterMs : undefined,
        sawEvent,
      };
    } finally {
      this.clearLaneTimers(lane);
      controller.abort();
      runtime.lanes.delete(lane);
    }
  }

  private accept(task: Task, eventType: string, token: string): void {
    const runtime = this.ensureRuntime(task.id);
    if (runtime.retryTimer) globalThis.clearTimeout(runtime.retryTimer);
    runtime.retryTimer = undefined;
    const now = this.now();
    const shouldNotify = !task.healthy && (!task.lastNotifiedAt || now - task.lastNotifiedAt >= 300_000);
    task.healthy = true;
    task.probeAttempts = 0;
    task.successes += 1;
    task.status = 'accepted-streaming';
    task.acceptedAt = now;
    task.updatedAt = now;
    task.nextAttemptAt = undefined;
    task.lastError = undefined;
    this.addEvent(
      task,
      eventType,
      '已成功挤入',
      task.config.keepalive ? '成功后按保活间隔继续请求；保活失败则恢复探活。' : `${eventType} 已到达；本任务成功后结束。`,
      'success',
    );
    this.emit();
    if (shouldNotify) {
      task.lastNotifiedAt = now;
      void this.startNotification(task, token);
    }
  }

  private failAttempt(task: Task, detail: string, retryable = true, retryAfterMs = 0): void {
    if (!isSchedulableStatus(task.status) || isAcceptedStatus(task.status)) return;
    task.lastError = detail;
    if (task.healthy) task.probeAttempts = 1;
    task.healthy = false;
    task.updatedAt = this.now();
    if (!retryable) {
      this.stopModelWork(task.id);
      task.status = 'exhausted';
      task.stopReason = 'permanent-error';
      task.completedAt = this.now();
      task.nextAttemptAt = undefined;
      this.addEvent(task, 'task.permanent-error', '错误停止', `${detail}；自动重试已停止，请修正配置后重新开始。`, 'danger');
      this.emit();
      return;
    }
    const willRetry = task.probeAttempts < task.config.maxAttempts;
    const transient = willRetry && isTransientHttpFailure(detail);
    this.addEvent(
      task,
      'request.failed',
      transient ? '服务繁忙，等待重试' : '本次未挤入',
      detail,
      transient ? 'warning' : 'danger',
    );
    if (task.probeAttempts >= task.config.maxAttempts) {
      this.exhaust(task);
      return;
    }
    this.scheduleAttempt(task, Math.max(0, (task.lastAttemptAt ?? this.now()) + task.config.intervalSeconds * 1000 - this.now(), retryAfterMs));
  }

  private exhaust(task: Task): void {
    this.stopModelWork(task.id);
    task.status = 'exhausted';
    task.nextAttemptAt = undefined;
    task.completedAt = this.now();
    task.updatedAt = this.now();
    this.addEvent(
      task,
      'task.exhausted',
      '尝试次数已耗尽',
      `本轮探活已完成 ${task.probeAttempts}/${task.config.maxAttempts} 次尝试。`,
      'danger',
    );
    this.emit();
  }

  private async startNotification(task: Task, token: string): Promise<void> {
    if (!task.notificationConfigured || !task.acceptedAt) return;
    task.notificationStatus = 'queued';
    task.notificationId = undefined;
    this.addEvent(task, 'notification.queued', '通知待发送', '通知已提交到 通知服务独立队列。', 'info');
    this.emit();

    const payload: NotificationPayload = {
      taskId: `${task.id}:${task.acceptedAt}`,
      taskName: task.config.name,
      channel: task.config.channel,
      model: task.config.model,
      keyTail: keyTail(token),
      attempts: task.attemptsMade,
      elapsedMs: task.acceptedAt - task.startedAt,
      acceptedAt: task.acceptedAt,
      showdocUrl: task.config.showdocPushUrl,
      chatId: task.config.telegramChatId.trim(),
      botToken: task.config.telegramBotToken.trim(),
      sendKey: task.config.serverchanSendKey,
      tags: task.config.serverchanTags,
    };
    try {
      const receipt = await this.notificationClient.enqueue(payload);
      if (!this.tasks.has(task.id)) return;
      task.notificationId = receipt.id;
      this.applyNotificationReceipt(task, receipt);
      if (receipt.status === 'queued' || receipt.status === 'retrying') {
        this.scheduleNotificationPoll(task);
      }
    } catch (error) {
      task.notificationStatus = 'dead';
      this.addEvent(task, 'notification.dead', '通知入队失败', errorMessage(error), 'danger');
      this.emit();
    }
  }

  private scheduleNotificationPoll(task: Task): void {
    if (this.disposed || !this.tasks.has(task.id)) return;
    if (!pollingAvailable() || !notificationPending(task) || task.notificationPollingPaused) return;
    const runtime = this.ensureRuntime(task.id);
    if (runtime.notificationInFlight) return;
    if (runtime.notificationTimer) globalThis.clearTimeout(runtime.notificationTimer);
    runtime.notificationTimer = globalThis.setTimeout(() => {
      runtime.notificationTimer = undefined;
      if ((task.notificationNextAttemptAt ?? 0) > this.now()) this.scheduleNotificationPoll(task);
      else void this.pollNotification(task.id);
    }, Math.min(2_147_483_647, Math.max(
      this.notificationPollMs * 2 ** (task.notificationReadFailures ?? 0),
      (task.notificationNextAttemptAt ?? 0) - this.now(),
    )));
  }

  async refreshNotification(taskId: string): Promise<void> {
    const task = this.tasks.get(taskId);
    if (!task?.notificationId || this.disposed) return;
    task.notificationReadFailures = 0;
    task.notificationPollingPaused = false;
    task.notificationReadError = undefined;
    await this.pollNotification(taskId, true);
  }

  private async pollNotification(taskId: string, manual = false): Promise<void> {
    const task = this.tasks.get(taskId);
    if (this.disposed || !task?.notificationId || (!manual && !pollingAvailable())) return;
    const runtime = this.ensureRuntime(taskId);
    if (runtime.notificationInFlight) return;
    if (runtime.notificationTimer) globalThis.clearTimeout(runtime.notificationTimer);
    runtime.notificationTimer = undefined;
    runtime.notificationInFlight = true;
    try {
      const receipt = await this.notificationClient.get(task.notificationId);
      if (this.disposed) return;
      this.applyNotificationReceipt(task, receipt);
    } catch (error) {
      if (this.disposed) return;
      task.notificationReadFailures = (task.notificationReadFailures ?? 0) + 1;
      const missing = error instanceof NotificationReadError && [404, 410].includes(error.status);
      task.notificationPollingPaused = missing || task.notificationReadFailures >= 5;
      task.notificationReadError = missing ? '通知回执已过期或不存在' : '通知状态读取失败';
      if (task.notificationPollingPaused) {
        this.addEvent(task, 'notification.poll-paused', '通知查询已停止', `${task.notificationReadError}，可手动刷新；实际投递不受影响。`, 'warning');
      }
      this.emit();
    } finally {
      runtime.notificationInFlight = false;
      this.scheduleNotificationPoll(task);
    }
  }

  private applyNotificationReceipt(task: Task, receipt: NotificationReceipt): void {
    if (!this.tasks.has(task.id)) return;
    const changed =
      task.notificationStatus !== receipt.status ||
      task.notificationAttempts !== receipt.attempts;
    task.notificationStatus = receipt.status;
    task.notificationAttempts = receipt.attempts;
    task.notificationNextAttemptAt = receipt.nextAttemptAt;
    task.notificationReadFailures = 0;
    task.notificationPollingPaused = false;
    task.notificationReadError = undefined;
    task.updatedAt = this.now();
    if (changed) {
      const meta = receipt.status === 'sent'
        ? ['notification.sent', '通知已发送', '成功摘要已投递。', 'success'] as const
        : receipt.status === 'dead'
          ? ['notification.dead', '通知失败', receipt.error ?? '通知任务已停止重试。', 'danger'] as const
          : receipt.status === 'retrying'
            ? ['notification.retrying', '通知正在重试', receipt.error ?? '通知服务将按退避策略再次投递。', 'warning'] as const
            : ['notification.queued', '通知仍在队列', '等待 通知服务投递。', 'info'] as const;
      this.addEvent(task, meta[0], meta[1], meta[2], meta[3]);
    }
    this.emit();
  }

  private addEvent(
    task: Task,
    type: string,
    title: string,
    detail: string,
    tone: TaskEvent['tone'],
  ): void {
    task.events.push({ id: makeId('event'), at: this.now(), type, title, detail, tone });
    if (task.events.length > MAX_EVENTS) {
      task.events.splice(0, task.events.length - MAX_EVENTS);
    }
  }

  private appendSummary(task: Task, chunk: string): void {
    task.responseSummary = truncateUtf8(
      `${task.responseSummary}${chunk}`,
      MAX_RESPONSE_SUMMARY_BYTES,
    );
  }

  private isCurrent(task: Task, generation: number): boolean {
    const runtime = this.runtimes.get(task.id);
    return !this.disposed && runtime?.generation === generation && this.tasks.has(task.id);
  }

  private ensureRuntime(id: string): TaskRuntime {
    const existing = this.runtimes.get(id);
    if (existing) return existing;
    const runtime: TaskRuntime = { generation: 0, lanes: new Set() };
    this.runtimes.set(id, runtime);
    return runtime;
  }

  private stopModelWork(id: string): void {
    const runtime = this.runtimes.get(id);
    if (!runtime) return;
    runtime.generation += 1;
    if (runtime.retryTimer) globalThis.clearTimeout(runtime.retryTimer);
    runtime.retryTimer = undefined;
    for (const lane of runtime.lanes) {
      this.clearLaneTimers(lane);
      lane.controller.abort();
    }
    runtime.lanes.clear();
  }

  private clearLaneTimer(
    lane: AttemptLane,
    name: 'firstEventTimer' | 'totalTimer' | 'idleTimer',
  ): void {
    const timer = lane[name];
    if (timer) globalThis.clearTimeout(timer);
    lane[name] = undefined;
  }

  private clearLaneTimers(lane: AttemptLane): void {
    this.clearLaneTimer(lane, 'firstEventTimer');
    this.clearLaneTimer(lane, 'totalTimer');
    this.clearLaneTimer(lane, 'idleTimer');
  }

  private clearAllRuntime(id: string): void {
    const runtime = this.runtimes.get(id);
    if (!runtime) return;
    this.stopModelWork(id);
    if (runtime.notificationTimer) globalThis.clearTimeout(runtime.notificationTimer);
    runtime.notificationTimer = undefined;
  }

  private emit(immediate = true): void {
    this.onChange(immediate);
  }
}

function cloneTask(task: Task): Task {
  return {
    ...task,
    config: { ...task.config },
    events: task.events.map((event) => ({ ...event })),
  };
}

function withApiHost(baseUrl: string, detail: string): string {
  const host = apiHost(baseUrl);
  return detail.startsWith(`${host} ·`) ? detail : `${host} · ${detail}`;
}

function resolveEventType(event: SseEvent, payload?: Record<string, unknown>): string {
  if (event.event && event.event !== 'message') return event.event;
  return typeof payload?.type === 'string' ? payload.type : event.event || 'message';
}

function isSuccessEvent(channel: TaskConfig['channel'], type: string): boolean {
  return channel === 'gpt'
    ? type === 'response.created' || type === 'response.in_progress'
    : type === 'message_start';
}

function isFailureEvent(type: string): boolean {
  return type === 'error' || type === 'response.failed';
}

function isMeaningfulEvent(event: SseEvent, type: string): boolean {
  return event.data !== '' && event.data !== '[DONE]' && type !== 'ping';
}

function serializeSseEvent(event: SseEvent): string {
  const eventLine = event.event && event.event !== 'message' ? `event: ${event.event}\n` : '';
  const dataLines = event.data.split('\n').map((line) => `data: ${line}`).join('\n');
  return `${eventLine}${dataLines}\n\n`;
}

function sseErrorDetail(
  type: string,
  payload: Record<string, unknown> | undefined,
  raw: string,
): string {
  const nested = findMessage(payload);
  const compact = [findErrorCode(payload), nested || raw || type].filter(Boolean).join(' · ').replace(/\s+/g, ' ').slice(0, 500);
  return `${type} · ${compact}`;
}

function findMessage(value: unknown, depth = 0): string | undefined {
  if (depth > 4 || !value || typeof value !== 'object') return undefined;
  const record = value as Record<string, unknown>;
  if (typeof record.message === 'string') return record.message;
  if (typeof record.error === 'string') return record.error;
  for (const key of ['error', 'response', 'detail']) {
    const found = findMessage(record[key], depth + 1);
    if (found) return found;
  }
  return undefined;
}

async function responseError(response: Response): Promise<string> {
  let detail = '';
  try {
    const reader = response.body?.getReader();
    const decoder = new TextDecoder();
    let raw = '';
    let bytes = 0;
    if (reader) {
      try {
        while (bytes < 4 * 1024) {
          const { value, done } = await reader.read();
          if (value) {
            raw += decoder.decode(value.subarray(0, 4 * 1024 - bytes), { stream: true });
            bytes += value.byteLength;
          }
          if (done) break;
        }
        raw += decoder.decode();
      } finally {
        void reader.cancel().catch(() => undefined);
        reader.releaseLock();
      }
    }
    if (raw) {
      try {
        const parsed: unknown = JSON.parse(raw);
        detail = [findErrorCode(parsed), findMessage(parsed) ?? raw].filter(Boolean).join(' · ');
      } catch {
        detail = raw;
      }
    }
  } catch {
    // Keep the status-only message when an error body cannot be read.
  }
  const compact = detail.replace(/\s+/g, ' ').slice(0, 500);
  return `HTTP ${response.status}${compact ? ` · ${compact}` : ''}`;
}

function findErrorCode(value: unknown, depth = 0): string | undefined {
  if (depth > 4 || !value || typeof value !== 'object') return undefined;
  const record = value as Record<string, unknown>;
  if (typeof record.code === 'string') return record.code;
  if (typeof record.type === 'string' && /error|quota/i.test(record.type)) return record.type;
  for (const key of ['error', 'response', 'detail']) {
    const found = findErrorCode(record[key], depth + 1);
    if (found) return found;
  }
  return undefined;
}

function notificationPending(task: Task): boolean {
  return Boolean(task.notificationId && ['queued', 'retrying'].includes(task.notificationStatus));
}

function pollingAvailable(): boolean {
  return globalThis.document?.visibilityState !== 'hidden' && globalThis.navigator?.onLine !== false;
}

function errorMessage(error: unknown): string {
  if (error instanceof Error && error.message) return error.message;
  return '未知网络错误';
}

function isTransientHttpFailure(detail: string): boolean {
  return /HTTP (?:408|409|425|429|500|502|503|504|529)\b/.test(detail);
}

/** Marks the round won and stops every sibling lane without letting it report a failure. */
function winRound(round: RoundState, winner: AttemptLane): void {
  round.won = true;
  for (const sibling of round.lanes) {
    if (sibling === winner) continue;
    sibling.superseded = true;
    sibling.controller.abort();
  }
}

/**
 * Collapses one round's lane errors into a single readable failure. A single-lane round returns
 * that lane's detail untouched so `concurrency: 1` reads exactly as it did before.
 */
function roundFailureDetail(details: string[]): string {
  const [primary, ...rest] = details;
  if (!primary) return '';
  const extras = [...new Set(rest)].filter((detail) => detail !== primary);
  if (!extras.length) return primary;
  const suffix = extras
    .slice(0, 3)
    .map((detail) => (detail.length > 120 ? `${detail.slice(0, 119)}…` : detail))
    .join('；');
  return `${primary}；并发其他线程：${suffix}`;
}
