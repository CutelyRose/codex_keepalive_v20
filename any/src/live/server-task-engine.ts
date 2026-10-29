import { notificationConfigured, validatePoolTaskConfig } from '../core/task-config';
import type { ManagedTask, PoolMember, PoolTaskConfig, Task, TaskConfig } from '../core/types';
import { isTaskActive, isTerminalStatus, makeId, randomUUID } from '../core/utils';
import {
  LiveTaskEngine,
  MAX_TIMER_MS,
  type AttemptLane,
  type LaneResult,
  type LiveTaskEngineOptions,
  type RoundState,
} from './live-task-engine';

export const MAX_SERVER_TASKS = 128;
/** Rounds in flight across all server tasks; a pool holds one slot while any member request is open. */
export const MAX_SERVER_ROUNDS = 8;
const RECOVERY_MS = 30_000;

interface MemberRound extends RoundState {
  keyId: string;
  epoch: number;
  started: number;
  pending: number;
  outcomes: Array<LaneResult & { finishedAt: number }>;
}

interface PoolRuntime {
  epoch: number;
  active: Map<string, MemberRound>;
  physical: Set<AttemptLane>;
  slot: boolean;
  timer?: ReturnType<typeof globalThis.setTimeout>;
}

type PoolTask = Task & { pool: NonNullable<Task['pool']> };
export type NewPoolMember = Pick<PoolMember, 'keyId' | 'alias' | 'keyTail' | 'baseUrl'>;

/**
 * Server scheduler: ordinary tasks run the shared browser engine; Key pools add a member state machine.
 * Pool: every member races, the first success keeps alive alone, a failed leader retries alone for 30 seconds,
 * then the whole pool races again.
 */
export class ServerTaskEngine extends LiveTaskEngine {
  private readonly pools = new Map<string, PoolRuntime>();
  private readonly queue = new Set<string>();
  private rounds = 0;

  constructor(options: Omit<LiveTaskEngineOptions, 'scheduler'>) {
    super({ ...options, scheduler: 'server' });
  }

  override create(config: TaskConfig): Task {
    this.checkCapacity();
    return super.create(config);
  }

  createPool(input: PoolTaskConfig, members: NewPoolMember[]): ManagedTask {
    this.checkCapacity();
    const config = validatePoolTaskConfig(input);
    const now = this.now();
    const task = {
      id: makeId('task'), scheduler: 'server', sessionId: randomUUID(), config: { ...config },
      status: 'running', attemptsMade: 0, probeAttempts: 0, successes: 0, healthy: false,
      notificationConfigured: notificationConfigured(config),
      startedAt: now, updatedAt: now, responseSummary: '', events: [], notificationStatus: 'not-requested', notificationAttempts: 0,
      pool: { phase: 'racing', races: 1, members: members.map(member => ({
        ...member, sessionId: randomUUID(), attemptsMade: 0, successes: 0, disabled: false,
      })) },
    } as unknown as PoolTask;
    this.tasks.set(task.id, task);
    this.ensureRuntime(task.id);
    this.pools.set(task.id, { epoch: 0, active: new Map(), physical: new Set(), slot: false });
    this.addEvent(task, 'task.created', '任务已创建', `${members.length} 个 Key 同时挤入。`, 'info');
    this.tick(task.id);
    return task;
  }

  /** Service restart: active tasks continue from saved timing; an open success stream cannot resume. */
  restoreServer(tasks: ManagedTask[]): void {
    const now = this.now();
    for (const source of tasks) {
      const task = source as Task;
      this.tasks.set(task.id, task);
      this.ensureRuntime(task.id);
      const active = isTaskActive(task);
      if (task.pool) {
        const runtime: PoolRuntime = { epoch: 0, active: new Map(), physical: new Set(), slot: false };
        this.pools.set(task.id, runtime);
        if (active) {
          const pool = task.pool;
          if (pool.phase === 'keeping') {
            this.recover(task as PoolTask, now);
            const leader = pool.members.find(member => member.keyId === pool.activeKeyId);
            if (leader) leader.nextAttemptAt = Math.max(now, leader.retryAfterAt ?? 0);
          }
          task.status = 'waiting';
          this.tick(task.id);
        }
      } else if (active) {
        if (!task.healthy && task.probeAttempts >= task.config.maxAttempts) {
          task.status = 'exhausted';
          task.completedAt = now;
        } else {
          this.addEvent(task, 'task.restored', '服务端任务已恢复', '按保存的状态继续调度。', 'info');
          this.scheduleAttempt(task, Math.max(0, (task.nextAttemptAt ?? now) - now));
        }
      } else if (task.status === 'accepted-streaming') {
        task.status = 'accepted-stream-interrupted';
        task.completedAt = now;
        this.addEvent(task, 'stream.interrupted', '成功流已中断', '服务重启前已确认成功，本任务不会重复请求。', 'warning');
      }
      if (task.notificationId && ['queued', 'retrying'].includes(task.notificationStatus)) this.scheduleNotificationPoll(task);
    }
    this.emit();
  }

  override pause(id: string): boolean {
    const task = this.poolTask(id);
    if (!task) return super.pause(id);
    if (!isTaskActive(task)) return false;
    this.stop(task);
    task.status = 'paused';
    this.addEvent(task, 'task.paused', '任务已暂停', '继续后原保活号重新获得 30 秒恢复期。', 'warning');
    this.emit();
    return true;
  }

  override resume(id: string): boolean {
    const task = this.poolTask(id);
    if (!task) return super.resume(id);
    if (task.status !== 'paused') return false;
    this.resumePool(task, true);
    return true;
  }

  override retryNow(id: string): boolean {
    const task = this.poolTask(id);
    if (!task) return super.retryNow(id);
    if (!['waiting', 'keepalive', 'paused'].includes(task.status)) return false;
    this.resumePool(task, task.status === 'paused');
    return true;
  }

  override cancel(id: string): boolean {
    const task = this.poolTask(id);
    if (!task) return super.cancel(id);
    if (isTerminalStatus(task.status)) return false;
    this.stop(task);
    task.status = 'cancelled';
    task.completedAt = this.now();
    this.addEvent(task, 'task.cancelled', '任务已取消', '全部成员的连接和后续请求均已停止。', 'neutral');
    this.emit();
    return true;
  }

  override remove(id: string): boolean {
    const task = this.poolTask(id);
    if (task) {
      this.stop(task);
      this.pools.delete(id);
    }
    this.queue.delete(id);
    return super.remove(id);
  }

  override dispose(): void {
    for (const runtime of this.pools.values()) {
      globalThis.clearTimeout(runtime.timer);
      this.invalidate(runtime);
    }
    super.dispose();
  }

  protected override async beginAttempt(id: string): Promise<void> {
    if (this.rounds >= MAX_SERVER_ROUNDS) {
      this.queue.add(id);
      return;
    }
    this.rounds += 1;
    try { await super.beginAttempt(id); }
    finally {
      this.rounds -= 1;
      this.drain();
    }
  }

  private checkCapacity(): void {
    if (this.tasks.size >= MAX_SERVER_TASKS) throw new Error(`服务端最多保存 ${MAX_SERVER_TASKS} 个任务`);
  }

  private drain(): void {
    for (const id of this.queue) {
      if (this.disposed || this.rounds >= MAX_SERVER_ROUNDS) return;
      this.queue.delete(id);
      if (this.pools.has(id)) this.tick(id);
      else void this.beginAttempt(id);
    }
  }

  private poolTask(id: string): PoolTask | undefined {
    const task = this.tasks.get(id);
    return task?.pool ? task as PoolTask : undefined;
  }

  private eligible(task: PoolTask): PoolMember[] {
    const { pool } = task;
    return pool.members.filter(member => !member.disabled && (pool.phase === 'racing' || member.keyId === pool.activeKeyId));
  }

  private invalidate(runtime: PoolRuntime): void {
    runtime.epoch += 1;
    for (const lane of runtime.physical) lane.controller.abort();
    runtime.active.clear();
  }

  private stop(task: PoolTask): void {
    const runtime = this.pools.get(task.id);
    if (runtime) {
      globalThis.clearTimeout(runtime.timer);
      this.invalidate(runtime);
    }
    delete task.pool.recoveryDeadline;
    task.nextAttemptAt = undefined;
    task.updatedAt = this.now();
  }

  private recover(task: PoolTask, at: number): void {
    if (task.pool.recoveryDeadline === undefined) {
      task.pool.recoveryDeadline = at + RECOVERY_MS;
      task.pool.phase = 'recovering';
      this.addEvent(task, 'pool.recovering', '保活号独自恢复', '30 秒内未成功则全池重新挤入。', 'warning');
    }
    task.healthy = false;
  }

  private race(task: PoolTask): void {
    const { pool } = task;
    const now = this.now();
    this.invalidate(this.pools.get(task.id)!);
    delete pool.recoveryDeadline;
    delete pool.activeKeyId;
    pool.phase = 'racing';
    pool.races += 1;
    task.healthy = false;
    task.status = 'waiting';
    for (const member of pool.members) member.nextAttemptAt = Math.max(now, member.retryAfterAt ?? 0);
    this.addEvent(task, 'pool.racing', '全池重新挤入', '全部可用成员参与，首个成功者保活。', 'warning');
  }

  /** The recovery deadline wins every tie: it is checked before any stream event or schedule step. */
  private expire(task: PoolTask): void {
    if (isTaskActive(task) && task.pool.recoveryDeadline !== undefined && this.now() >= task.pool.recoveryDeadline) {
      this.race(task);
      this.emit();
    }
  }

  private resumePool(task: PoolTask, wasPaused: boolean): void {
    const now = this.now();
    this.invalidate(this.pools.get(task.id)!);
    task.status = 'waiting';
    task.completedAt = undefined;
    if (wasPaused) {
      const leader = task.pool.members.find(member => member.keyId === task.pool.activeKeyId && !member.disabled);
      if (leader) {
        delete task.pool.recoveryDeadline;
        this.recover(task, now);
      } else this.race(task);
    }
    // retryNow skips the interval, never the recovery deadline or a member's Retry-After.
    for (const member of this.eligible(task)) member.nextAttemptAt = Math.max(now, member.retryAfterAt ?? 0);
    this.addEvent(task, 'task.resumed', '池任务已继续', '', 'info');
    this.tick(task.id);
  }

  private tick(id: string): void {
    const task = this.poolTask(id);
    const runtime = this.pools.get(id);
    if (this.disposed || !task || !runtime) return;
    globalThis.clearTimeout(runtime.timer);
    runtime.timer = undefined;
    if (!isTaskActive(task)) return;
    this.expire(task);
    if (task.pool.members.every(member => member.disabled)) {
      this.stop(task);
      Object.assign(task, { status: 'exhausted', healthy: false, stopReason: 'permanent-error', completedAt: this.now() });
      this.addEvent(task, 'pool.exhausted', '池已停止', '全部成员不可用，请查看成员错误。', 'danger');
      this.emit();
      return;
    }
    const now = this.now();
    for (const member of this.eligible(task)) {
      if (runtime.active.has(member.keyId) || (member.nextAttemptAt ?? 0) > now) continue;
      if (!runtime.slot) {
        if (this.rounds >= MAX_SERVER_ROUNDS) {
          this.queue.add(id);
          break;
        }
        runtime.slot = true;
        this.rounds += 1;
      }
      this.launch(task, runtime, member);
    }
    if (!runtime.active.size) task.status = task.pool.phase === 'keeping' ? 'keepalive' : 'waiting';
    const due = this.eligible(task).filter(member => !runtime.active.has(member.keyId)).map(member => member.nextAttemptAt ?? now);
    task.nextAttemptAt = due.length ? Math.min(...due) : undefined;
    const wake = Math.min(...due.filter(at => at > now), task.pool.recoveryDeadline ?? Infinity);
    if (wake !== Infinity) runtime.timer = globalThis.setTimeout(() => this.tick(id), Math.min(MAX_TIMER_MS, wake - now));
    this.emit();
  }

  private launch(task: PoolTask, runtime: PoolRuntime, member: PoolMember): void {
    const count = task.pool.phase === 'keeping' ? 1 : task.config.concurrency;
    const round: MemberRound = {
      won: false, lanes: [], solo: false, quiet: true,
      config: { ...task.config, baseUrl: member.baseUrl } as unknown as TaskConfig,
      sessionId: member.sessionId, token: this.getKey(member.keyId)?.trim(),
      keyId: member.keyId, epoch: runtime.epoch, started: this.now(), pending: count, outcomes: [],
      current: () => {
        this.expire(task);
        return this.valid(task, runtime, round);
      },
      win: (lane, type) => this.claim(task, runtime, round, lane, type),
    };
    runtime.active.set(member.keyId, round);
    const lanes = this.ensureRuntime(task.id).lanes;
    for (let index = 0; index < count; index += 1) {
      const lane: AttemptLane = { controller: new AbortController(), superseded: false, summary: '' };
      round.lanes.push(lane);
      runtime.physical.add(lane);
      lanes.add(lane);
    }
    member.attemptsMade += count;
    task.attemptsMade += count;
    task.status = 'requesting';
    task.lastAttemptAt = this.now();
    task.updatedAt = this.now();
    this.addEvent(task, 'request.started', '池成员请求', `${member.alias} · 并发 ${count}`, 'neutral');
    for (const lane of round.lanes) {
      void this.runLane(task, this.ensureRuntime(task.id), round, lane)
        .then(result => this.finish(task, runtime, round, lane, result));
    }
  }

  private valid(task: PoolTask, runtime: PoolRuntime, round: MemberRound): boolean {
    return !this.disposed && this.tasks.get(task.id) === task && this.pools.get(task.id) === runtime &&
      round.epoch === runtime.epoch && runtime.active.get(round.keyId) === round;
  }

  /** First success in the whole pool: that lane keeps alive, every other member request is cancelled. */
  private claim(task: PoolTask, runtime: PoolRuntime, round: MemberRound, winner: AttemptLane, type: string): void {
    round.won = true;
    for (const [keyId, other] of runtime.active) {
      for (const lane of other.lanes) {
        if (lane === winner) continue;
        lane.superseded = true;
        lane.controller.abort();
      }
      if (other !== round) runtime.active.delete(keyId);
    }
    const member = task.pool.members.find(item => item.keyId === round.keyId)!;
    delete task.pool.recoveryDeadline;
    task.pool.phase = 'keeping';
    task.pool.activeKeyId = member.keyId;
    member.successes += 1;
    delete member.lastError;
    this.accept(task, type, round.token as string, member);
  }

  private finish(task: PoolTask, runtime: PoolRuntime, round: MemberRound, lane: AttemptLane, result: LaneResult): void {
    runtime.physical.delete(lane);
    round.pending -= 1;
    if (!result.stale && this.valid(task, runtime, round)) {
      round.outcomes.push({ ...result, finishedAt: this.now() });
      // A won round settles with its winner; an unanswered round waits for every lane.
      if (round.won ? result.accepted : !round.pending) this.settle(task, round, result);
    }
    if (runtime.slot && !runtime.physical.size) {
      runtime.slot = false;
      this.rounds -= 1;
      this.drain();
    }
    this.tick(task.id);
  }

  private settle(task: PoolTask, round: MemberRound, result: LaneResult): void {
    this.pools.get(task.id)!.active.delete(round.keyId);
    const member = task.pool.members.find(item => item.keyId === round.keyId)!;
    const now = this.now();
    member.retryAfterAt = Math.max(member.retryAfterAt ?? 0, ...round.outcomes.map(outcome => outcome.finishedAt + (outcome.retryAfterMs ?? 0)));
    if (round.won && result.detail === undefined) {
      const { keepaliveMinSeconds: min, keepaliveMaxSeconds: max } = task.config;
      member.nextAttemptAt = Math.max(now, round.started + (min + Math.random() * (max - min)) * 1000);
      return;
    }
    // Failed round or abnormal end of the leader's success stream.
    const failure = round.outcomes.find(outcome => outcome.retryable === false) ?? result;
    member.lastError = failure.detail ?? (failure.sawEvent ? 'SSE 流结束但未收到成功信号' : '空 SSE 流未返回事件');
    member.disabled = failure.retryable === false;
    task.lastError = `${member.alias} · ${member.lastError}`;
    if (task.pool.activeKeyId === member.keyId) this.recover(task, now);
    member.nextAttemptAt = Math.max(now + task.config.intervalSeconds * 1000, member.retryAfterAt);
    this.addEvent(task, 'request.failed', member.disabled ? '成员不可用' : '成员等待重试', task.lastError, 'warning');
  }
}
