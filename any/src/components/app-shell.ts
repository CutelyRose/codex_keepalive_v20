import { LIMITS, MODEL_ID_PATTERN } from '../core/constants';
import { DEFAULT_API_BASE_URL, normalizeApiBaseUrl } from '../core/api-url';
import { AppStore } from '../core/store';
import { serverRequest } from '../core/api-client';
import {
  getTheme,
  initializeTheme,
  themeChangeEventName,
  toggleTheme,
} from '../core/theme';
import type {
  AppSettings,
  Channel,
  KeyRecord,
  NotificationStatus,
  NotificationSettings,
  Scheduler,
  SchedulerChoice,
  Task,
  TaskConfig,
  TaskStatus,
} from '../core/types';
import {
  countdownLabel,
  escapeHtml,
  formatDateTime,
  formatDuration,
  formatTime,
  isAcceptedStatus,
  isTaskActive,
  keyTail,
  maskKey,
  modelsForChannel,
} from '../core/utils';

type Page = 'overview' | 'keys' | 'create' | 'tasks' | 'settings';
type NotificationProvider = 'showdoc' | 'serverchan' | 'telegram';

interface TaskDraft extends NotificationSettings {
  notificationProvider: NotificationProvider;
  scheduler: SchedulerChoice;
  name: string;
  channel: Channel;
  keyId: string;
  modelChoice: string;
  customModel: string;
  prompt: string;
  maxAttempts: number;
  intervalSeconds: number;
  timeoutSeconds: number;
  concurrency: number;
  keepalive: boolean;
  keepaliveMinSeconds: number;
  keepaliveMaxSeconds: number;
  oneMillion: boolean;
}

const PAGE_META: Record<Page, { eyebrow: string; title: string; subtitle: string }> = {
  overview: {
    eyebrow: '工作区概览',
    title: '准备好开始调度',
    subtitle: '查看任务、凭据和模型请求状态。',
  },
  keys: {
    eyebrow: '访问凭据',
    title: 'Key 管理',
    subtitle: '管理 API Key、服务地址、鉴权状态与模型列表。',
  },
  create: {
    eyebrow: '任务编排',
    title: '新建请求任务',
    subtitle: '配置请求通道、模型、探针和重试参数。',
  },
  tasks: {
    eyebrow: '实时运行',
    title: '任务中心',
    subtitle: '跟踪双端任务、自动保活和下次请求时间。',
  },
  settings: {
    eyebrow: '默认配置',
    title: '默认设置',
    subtitle: '为新任务预设请求次数、间隔、超时和通知参数。',
  },
};

const STATUS_META: Record<TaskStatus, { label: string; tone: string; description: string }> = {
  running: { label: '运行中', tone: 'blue', description: '正在准备下一次请求' },
  requesting: { label: '请求中', tone: 'violet', description: '等待首个 SSE 事件' },
  waiting: { label: '等待重试', tone: 'amber', description: '固定间隔倒计时' },
  keepalive: { label: '保活中', tone: 'green', description: '等待下一次保活请求' },
  paused: { label: '已暂停', tone: 'neutral', description: '调度已暂停' },
  'accepted-streaming': { label: '已挤入 · 读取中', tone: 'green', description: '成功事件已确认' },
  'accepted-completed': { label: '已挤入 · 完成', tone: 'green', description: '响应流正常结束' },
  'accepted-stream-interrupted': {
    label: '已挤入 · 流中断',
    tone: 'amber',
    description: '成功状态保持有效',
  },
  exhausted: { label: '已耗尽', tone: 'red', description: '达到最大尝试次数' },
  cancelled: { label: '已取消', tone: 'neutral', description: '任务已停止' },
};

const NOTIFICATION_META: Record<NotificationStatus, { label: string; tone: string }> = {
  'not-requested': { label: '未配置', tone: 'neutral' },
  queued: { label: '待发送', tone: 'blue' },
  retrying: { label: '重试中', tone: 'amber' },
  sent: { label: '已发送', tone: 'green' },
  dead: { label: '通知失败', tone: 'red' },
};

function notificationMeta(task: Task): { label: string; tone: string } {
  if (task.notificationPollingPaused) return { label: '查询已暂停', tone: 'amber' };
  if (
    task.notificationStatus === 'not-requested' &&
    task.notificationConfigured
  ) {
    return { label: '等待成功', tone: 'blue' };
  }
  return NOTIFICATION_META[task.notificationStatus];
}

function taskStatusMeta(task: Task): { label: string; tone: string; description: string } {
  if (task.status === 'requesting' && task.healthy) return { label: '保活请求中', tone: 'green', description: '正在确认连接可用' };
  return task.stopReason === 'permanent-error'
    ? { label: '错误停止', tone: 'red', description: '请修正凭据、额度或配置后重新开始' }
    : STATUS_META[task.status];
}

const NAV_ITEMS: Array<{ page: Page; label: string; icon: string }> = [
  { page: 'overview', label: '概览', icon: 'overview' },
  { page: 'keys', label: 'Key 管理', icon: 'key' },
  { page: 'create', label: '新建任务', icon: 'plus' },
  { page: 'tasks', label: '任务中心', icon: 'tasks' },
  { page: 'settings', label: '设置', icon: 'settings' },
];

export class AppShell extends HTMLElement {
  initialKeys: KeyRecord[] = [];
  passwordRequired = false;
  private store!: AppStore;
  private page: Page = 'overview';
  private schedulerFilter: Scheduler | 'all' = 'all';
  private taskDraft!: TaskDraft;
  private selectedTaskIds = new Set<string>();
  private openTaskId?: string;
  private editingKeyId?: string;
  private ticker?: number;
  private lastFocused?: HTMLElement;
  private suppressViewRender = false;
  private submittingTask = false;
  private readonly cardMarkup = new Map<string, string>();
  private readonly onThemeChange = (): void => {
    this.updateThemeToggle();
  };
  private readonly onStoreChange = (event: Event): void => {
    this.updateHeaderCounts();
    this.updateSchedulerBar();
    if (this.suppressViewRender) return;
    if ((event as CustomEvent).detail?.kind === 'tasks' && !['overview', 'tasks'].includes(this.page)) {
      if (this.openTaskId) this.renderDrawer(false);
      return;
    }
    if (this.page === 'overview' || this.page === 'tasks' || this.page === 'keys' || this.page === 'create') {
      this.ensureDraft();
      this.renderView();
    }
    if (this.openTaskId) this.renderDrawer(false);
  };
  private readonly onHashChange = (): void => {
    const next = window.location.hash.slice(1) as Page;
    if (PAGE_META[next]) this.navigate(next, false);
  };

  connectedCallback(): void {
    if (this.store) return;
    initializeTheme();
    this.store = new AppStore(this.initialKeys);
    this.initialKeys = [];
    this.page = this.validPage(window.location.hash.slice(1)) ?? 'overview';
    this.taskDraft = this.makeDraft();
    this.renderShell();
    this.store.addEventListener('change', this.onStoreChange);
    window.addEventListener('hashchange', this.onHashChange);
    window.addEventListener(themeChangeEventName(), this.onThemeChange);
    this.addEventListener('click', (event) => { void this.handleClick(event).catch(error => this.toast(error instanceof Error ? error.message : '操作失败', 'danger')); });
    this.addEventListener('change', (event) => this.handleChange(event));
    this.addEventListener('input', (event) => this.handleInput(event));
    this.addEventListener('submit', (event) => { void this.handleSubmit(event).catch(error => this.toast(error instanceof Error ? error.message : '保存失败', 'danger')); });
    this.addEventListener('keydown', (event) => this.handleKeydown(event));
    this.ticker = window.setInterval(() => this.updateCountdowns(), 250);
    this.renderView();
    this.updateHeaderCounts();
    this.updateSchedulerBar();
  }

  disconnectedCallback(): void {
    if (!this.store) return;
    this.store.removeEventListener('change', this.onStoreChange);
    window.removeEventListener('hashchange', this.onHashChange);
    window.removeEventListener(themeChangeEventName(), this.onThemeChange);
    if (this.ticker) window.clearInterval(this.ticker);
    this.store.dispose();
  }

  private renderShell(): void {
    this.innerHTML = `
      <div class="app-frame">
        <aside class="sidebar" aria-label="主要导航">
          <div class="brand-lockup">
            <span class="brand-mark" aria-hidden="true">${icon('spark')}</span>
            <span class="brand-copy"><strong>AnyRouter</strong><small>Dual Scheduler</small></span>
          </div>
          <div class="mode-card">
            <span class="mode-icon" aria-hidden="true">${icon('pulse')}</span>
            <div><strong>请求与保活</strong><span>浏览器 + Python 双端</span></div>
          </div>
          <nav class="sidebar-nav">${this.navMarkup(false)}</nav>
          <div class="sidebar-foot">
            <span class="version-label">AnyRouter Console</span>
          </div>
        </aside>

        <div class="workspace">
          <header class="topbar">
            <div class="mobile-brand"><span class="brand-mark" aria-hidden="true">${icon('spark')}</span><strong>AnyRouter</strong></div>
             <div class="connection-chip"><span class="connection-dot"></span><span>Responses · Messages · 成功通知</span></div>
            <div class="topbar-actions">
              <span class="topbar-stat"><b id="header-running">0</b> 运行中</span>
              ${this.themeToggleMarkup()}
              <button class="icon-button" type="button" aria-label="查看任务中心" data-nav="tasks">${icon('bell')}</button>
              <button class="avatar-button" type="button" aria-label="打开设置" data-nav="settings">AR</button>
              ${this.passwordRequired ? `<button class="icon-button" type="button" aria-label="退出登录" title="退出登录" data-action="logout">${icon('logout')}</button>` : ''}
            </div>
          </header>
          <main id="main-content" class="main-content" tabindex="-1">
            <div id="scheduler-bar"></div>
            <div id="view-root"></div>
          </main>
        </div>

        <nav class="bottom-nav" aria-label="移动端主要导航">${this.navMarkup(true)}</nav>
        <div id="drawer-host"></div>
        <div class="toast-region" aria-live="polite" aria-atomic="true" id="toast-region"></div>

        <dialog class="key-dialog" id="key-dialog" aria-labelledby="key-dialog-title">
          <form method="dialog" id="key-form" class="dialog-card">
            <div class="dialog-head">
              <div>
                <span class="eyebrow">API 凭据</span>
                <h2 id="key-dialog-title">添加 Key</h2>
              </div>
              <button class="icon-button" type="button" data-action="close-key-dialog" aria-label="关闭添加 Key 对话框">${icon('close')}</button>
            </div>
            <div class="info-banner compact"><span aria-hidden="true">${icon('info')}</span><p>默认使用 AnyRouter，也可连接其他兼容服务。</p></div>
            <label class="field"><span>别名</span><input name="alias" autocomplete="off" maxlength="40" placeholder="例如：开发环境" required /></label>
            <label class="field"><span>API Base URL</span><input name="baseUrl" type="url" value="https://anyrouter.top" maxlength="500" placeholder="https://anyrouter.top" required /><small>可填写服务根地址或以 /v1 结尾的 SDK 地址。</small></label>
            <label class="field"><span>API Key</span><input name="key" type="password" autocomplete="off" minlength="8" maxlength="256" placeholder="sk-…" required /></label>
            <div class="dialog-actions">
              <button class="button secondary" type="button" data-action="close-key-dialog">取消</button>
              <button class="button primary" type="submit" id="add-key-submit">鉴权并保存</button>
            </div>
          </form>
        </dialog>
        <dialog class="key-dialog" id="key-base-url-dialog" aria-labelledby="key-base-url-title">
          <form method="dialog" id="key-base-url-form" class="dialog-card">
            <div class="dialog-head">
              <div><span class="eyebrow">兼容服务</span><h2 id="key-base-url-title">修改 API 地址</h2></div>
              <button class="icon-button" type="button" data-action="close-key-base-url-dialog" aria-label="关闭修改 API 地址对话框">${icon('close')}</button>
            </div>
            <label class="field"><span>API Base URL</span><input name="baseUrl" type="url" maxlength="500" required /><small>保存后会清空旧模型缓存，并使用新地址重新鉴权。</small></label>
            <div class="dialog-actions">
              <button class="button secondary" type="button" data-action="close-key-base-url-dialog">取消</button>
              <button class="button primary" type="submit" id="save-key-base-url">保存并重新鉴权</button>
            </div>
          </form>
        </dialog>
      </div>
    `;
  }

  private themeToggleMarkup(): string {
    const theme = getTheme();
    const next = theme === 'dark' ? '浅色' : '深色';
    return `<button class="icon-button theme-toggle" type="button" data-action="toggle-theme" aria-label="切换到${next}模式" title="切换到${next}模式" aria-pressed="${theme === 'dark'}">${icon(theme === 'dark' ? 'sun' : 'moon')}</button>`;
  }

  private visibleTasks(): Task[] {
    return this.store.engine.list().filter(task => this.schedulerFilter === 'all' || task.scheduler === this.schedulerFilter);
  }

  private updateSchedulerBar(): void {
    this.store.authScheduler = this.schedulerFilter === 'python' ? 'python' : 'browser';
    const bar = this.querySelector<HTMLElement>('#scheduler-bar');
    if (!bar) return;
    const tasks = this.store.engine.list();
    const markup = `<div class="scheduler-toolbar"><div class="scheduler-switch" role="group" aria-label="查看调度端">${(['all', 'browser', 'python'] as const).map(mode => {
      const count = tasks.filter(task => (mode === 'all' || task.scheduler === mode) && isTaskActive(task)).length;
      return `<button type="button" data-action="filter-scheduler" data-scheduler="${mode}" aria-pressed="${this.schedulerFilter === mode}">${mode === 'all' ? '全部' : mode === 'browser' ? '浏览器调度' : 'Python 调度'} <span>${count}</span></button>`;
    }).join('')}</div><span class="scheduler-service" role="status">${this.store.python.connected ? 'Python 已连接' : this.store.python.error ? 'Python 未连接' : '正在连接 Python…'}</span></div><p class="scheduler-help">双端可同时运行。浏览器任务需保持页面打开；Python 任务随本地服务持续运行。</p>${this.store.python.error ? `<p class="scheduler-error" role="alert">${escapeHtml(this.store.python.error)} <button type="button" class="text-button" data-action="refresh-python">重新连接</button></p>` : ''}`;
    if (bar.innerHTML !== markup) {
      const focused = bar.contains(document.activeElement) ? (document.activeElement as HTMLElement).dataset.scheduler : undefined;
      bar.innerHTML = markup;
      if (focused) bar.querySelector<HTMLElement>(`[data-scheduler="${focused}"]`)?.focus();
    }
  }

  private updateThemeToggle(): void {
    const theme = getTheme();
    const next = theme === 'dark' ? '浅色' : '深色';
    this.querySelectorAll<HTMLElement>('[data-action="toggle-theme"]').forEach((button) => {
      button.setAttribute('aria-label', `切换到${next}模式`);
      button.setAttribute('title', `切换到${next}模式`);
      button.setAttribute('aria-pressed', String(theme === 'dark'));
      const iconNode = button.querySelector('svg');
      if (iconNode) iconNode.outerHTML = icon(theme === 'dark' ? 'sun' : 'moon');
    });
    this.querySelectorAll<HTMLElement>('[data-theme-toggle-label]').forEach((label) => {
      label.textContent = `${theme === 'dark' ? '深色' : '浅色'}模式`;
    });
  }

  private navMarkup(mobile: boolean): string {
    return NAV_ITEMS.map(
      (item) => `
        <a class="nav-item ${mobile ? 'mobile-nav-item' : ''}" href="#${item.page}" data-nav="${item.page}" aria-label="${escapeHtml(item.label)}">
          <span class="nav-icon" aria-hidden="true">${icon(item.icon)}</span>
          <span>${escapeHtml(item.label)}</span>
          ${mobile ? '' : '<span class="nav-chevron" aria-hidden="true">›</span>'}
        </a>`,
    ).join('');
  }

  private renderView(): void {
    const root = this.querySelector<HTMLElement>('#view-root');
    if (!root) return;
    const taskList = root.querySelector<HTMLElement>('.task-list');
    if (this.page === 'tasks' && taskList && this.visibleTasks().length) {
      this.updateTaskList(taskList);
      return;
    }
    this.cardMarkup.clear();
    const keyDialog = this.querySelector<HTMLDialogElement>('#key-dialog');
    const keyDialogWasOpen = keyDialog?.open ?? false;
    const meta = this.pageMeta();
    root.innerHTML = `
      <section class="page" data-page="${this.page}" aria-labelledby="page-heading">
        <header class="page-header">
          <div>
            <span class="eyebrow">${escapeHtml(meta.eyebrow)}</span>
            <h1 id="page-heading" tabindex="-1">${escapeHtml(meta.title)}</h1>
            <p>${escapeHtml(meta.subtitle)}</p>
          </div>
          ${this.pageActions()}
        </header>
        ${this.viewMarkup()}
      </section>
    `;
    if (keyDialogWasOpen && keyDialog && !keyDialog.open) keyDialog.showModal();
    this.updateNavState();
    this.updateCountdowns();
  }

  private pageActions(): string {
    if (this.page === 'keys') {
      return `<div class="key-page-actions"><button class="button secondary" type="button" data-action="refresh-keys">${icon('refresh')} 刷新列表</button><button class="button primary" type="button" data-action="open-key-dialog">${icon('plus')} 添加 Key</button></div>`;
    }
    if (this.page === 'tasks') {
      return `<button class="button primary" type="button" data-nav="create">${icon('plus')} 新建任务</button>`;
    }
    if (this.page === 'overview') {
      return `<button class="button primary desktop-only-action" type="button" data-nav="create">${icon('plus')} 新建任务</button>`;
    }
    return '';
  }

  private viewMarkup(): string {
    switch (this.page) {
      case 'overview':
        return this.overviewMarkup();
      case 'keys':
        return this.keysMarkup();
      case 'create':
        return this.createMarkup();
      case 'tasks':
        return this.tasksMarkup();
      case 'settings':
        return this.settingsMarkup();
    }
  }

  private overviewMarkup(): string {
    const tasks = this.visibleTasks();
    const running = tasks.filter(isTaskActive).length;
    const accepted = tasks.filter((task) => task.successes > 0).length;
    const exhausted = tasks.filter((task) => task.status === 'exhausted').length;
    const recent = tasks.slice(0, 4);
    return `
      <div class="review-banner">
        <div class="review-copy">
          <span class="review-icon" aria-hidden="true">${icon('spark')}</span>
           <div><strong>多通道请求调度</strong><p>管理独立任务、重试策略和成功通知。</p></div>
        </div>
        <button class="button subtle" type="button" ${this.store.keys.length ? 'data-nav="keys"' : 'data-action="open-key-dialog"'}>${this.store.keys.length ? '查看 Key' : '添加 Key'} ${icon('arrow')}</button>
      </div>
      <div class="metrics-grid" aria-label="任务指标">
        <ar-metric-card label="运行中" value="${running}" hint="独立并发调度" tone="blue" icon="pulse"></ar-metric-card>
        <ar-metric-card label="已成功挤入" value="${accepted}" hint="首个成功事件" tone="green" icon="check"></ar-metric-card>
        <ar-metric-card label="尝试已耗尽" value="${exhausted}" hint="达到次数上限" tone="amber" icon="clock"></ar-metric-card>
        <ar-metric-card label="可用 Key" value="${this.store.keys.filter((key) => key.authStatus === 'ready').length}" hint="${this.store.keys.length} 个凭据" tone="violet" icon="key"></ar-metric-card>
      </div>
      <div class="overview-grid overview-grid-single">
        <section class="surface active-panel" aria-labelledby="active-heading">
          <div class="section-head"><div><span class="section-kicker">实时状态</span><h2 id="active-heading">最近任务</h2></div><button class="text-button" type="button" data-nav="tasks">查看全部 ${icon('arrow')}</button></div>
           ${recent.length ? `<div class="compact-task-list">${recent.map((task) => this.compactTaskMarkup(task)).join('')}</div>` : this.emptyState('rocket', '还没有运行记录', '添加 Key 并创建任务，状态会在这里实时更新。', '<button class="button secondary" type="button" data-nav="create">创建第一个任务</button>')}
        </section>
      </div>
      <section class="surface protocol-strip" aria-label="通道说明">
        <div class="protocol-item"><span class="channel-logo gpt-logo">G</span><div><strong>GPT Responses</strong><span><code>response.created</code> / <code>in_progress</code> 为成功</span></div></div>
        <span class="protocol-divider"></span>
        <div class="protocol-item"><span class="channel-logo claude-logo">C</span><div><strong>Claude Code Messages</strong><span><code>message_start</code> 为成功</span></div></div>
        <span class="protocol-divider"></span>
        <div class="protocol-item"><span class="channel-logo local-logo">N</span><div><strong>成功通知</strong><span>ShowDoc、Telegram、Server 酱</span></div></div>
      </section>
    `;
  }

  private compactTaskMarkup(task: Task): string {
    const status = taskStatusMeta(task);
    return `
      <button class="compact-task" type="button" data-action="open-task" data-task-id="${task.id}">
        <span class="channel-logo ${task.config.channel === 'gpt' ? 'gpt-logo' : 'claude-logo'}">${task.config.channel === 'gpt' ? 'G' : 'C'}</span>
        <span class="compact-task-main"><strong>${escapeHtml(task.config.name)}</strong><small>${task.scheduler === 'python' ? 'Python' : '浏览器'} · ${escapeHtml(task.config.model)}</small></span>
        <span class="compact-attempt"><b>${task.attemptsMade}</b><small>累计请求 · 成功 ${task.successes}</small></span>
        <ar-status-pill label="${status.label}" tone="${status.tone}" dot></ar-status-pill>
        <span class="row-arrow" aria-hidden="true">${icon('chevron')}</span>
      </button>
    `;
  }

  private keysMarkup(): string {
    if (!this.store.keys.length) {
      return `
        <section class="surface empty-surface">
          ${this.emptyState('key', '还没有 API Key', '添加 API Key，通过模型接口鉴权后即可创建任务。', '<button class="button primary" type="button" data-action="open-key-dialog">添加 Key</button>')}
        </section>
      `;
    }
    return `
      <div class="summary-row">
        <div><span>Key 总数</span><strong>${this.store.keys.length}</strong></div>
        <div><span>鉴权通过</span><strong>${this.store.keys.filter((key) => key.authStatus === 'ready').length}</strong></div>
        <div><span>缓存模型</span><strong>${new Set(this.store.keys.flatMap((key) => key.models)).size}</strong></div>
        <p><span aria-hidden="true">${icon('database')}</span> 已保存到服务器，可跨设备使用</p>
      </div>
      <section class="surface key-table-wrap" aria-labelledby="key-list-heading">
        <div class="section-head key-list-head"><div><span class="section-kicker">凭据列表</span><h2 id="key-list-heading">API Key</h2></div><span class="muted-text">兼容服务鉴权 · 模型列表</span></div>
        <div class="key-list">
          ${this.store.keys.map((key) => this.keyRowMarkup(key)).join('')}
        </div>
      </section>
    `;
  }

  private keyRowMarkup(key: KeyRecord): string {
    const status = key.authStatus === 'ready'
      ? { label: '鉴权通过', tone: 'green' }
      : key.authStatus === 'checking'
        ? { label: '鉴权中', tone: 'blue' }
        : { label: '鉴权失败', tone: 'red' };
    return `
      <article class="key-row" data-key-id="${key.id}">
        <div class="key-identity"><span class="key-avatar" aria-hidden="true">${escapeHtml(key.alias.slice(0, 1).toUpperCase())}</span><div><strong>${escapeHtml(key.alias)}</strong><code>${escapeHtml(maskKey(key.value))}</code></div></div>
        <div class="key-cell"><span class="cell-label">状态</span><ar-status-pill label="${status.label}" tone="${status.tone}" dot></ar-status-pill>${key.error ? `<small class="error-text">${escapeHtml(key.error)}</small>` : ''}</div>
        <div class="key-cell"><span class="cell-label">可用模型</span><strong>${key.models.length}</strong><small>${key.models.length ? `${modelsForChannel(key.models, 'gpt').length} GPT · ${modelsForChannel(key.models, 'claude').length} Claude` : '等待鉴权'}</small></div>
        <div class="key-cell"><span class="cell-label">API 服务</span><strong title="${escapeHtml(key.baseUrl)}">${escapeHtml(key.baseUrl)}</strong><small>${escapeHtml(formatDateTime(key.lastAuthenticatedAt))}</small></div>
        <div class="row-actions">
          <button class="icon-button" type="button" data-action="edit-key-base-url" data-key-id="${key.id}" aria-label="修改 ${escapeHtml(key.alias)} 的 API 地址">${icon('settings')}</button>
          <button class="button tiny secondary" type="button" data-action="reauth-key" data-key-id="${key.id}" ${key.authStatus === 'checking' ? 'disabled' : ''}>${icon('refresh')} 重新鉴权</button>
          <button class="icon-button danger-ghost" type="button" data-action="delete-key" data-key-id="${key.id}" aria-label="删除 ${escapeHtml(key.alias)}">${icon('trash')}</button>
        </div>
      </article>
    `;
  }

  private createMarkup(): string {
    this.ensureDraft();
    const key = this.store.keys.find((item) => item.id === this.taskDraft.keyId);
    const channelModels = key ? modelsForChannel(key.models, this.taskDraft.channel) : [];
    const hasReadyKey = this.store.keys.some((item) => item.authStatus === 'ready');
    if (!hasReadyKey) {
      return `
        <section class="surface empty-surface">
          ${this.emptyState('lock', '需要一个鉴权通过的 Key', '任务创建前必须通过 /v1/models 鉴权。', '<button class="button primary" type="button" data-action="open-key-dialog">添加 Key</button>')}
        </section>
      `;
    }
    const modelOptions = channelModels
      .map((model) => `<option value="${escapeHtml(model)}" ${this.taskDraft.modelChoice === model ? 'selected' : ''}>${escapeHtml(model)}</option>`)
      .join('');
    return `
      <form id="task-form" class="task-form" novalidate>
        <div class="form-main">
          <section class="surface form-section" aria-labelledby="channel-heading">
            <div class="form-section-head"><span class="step-number">01</span><div><h2 id="channel-heading">选择请求通道</h2><p>GPT 使用 Responses API，Claude Code 使用 Messages API。</p></div></div>
            <label class="field scheduler-field"><span>调度端</span><select name="scheduler" aria-label="任务调度端">${(['browser', 'python', 'both'] as const).map(mode => `<option value="${mode}" ${this.taskDraft.scheduler === mode ? 'selected' : ''}>${mode === 'browser' ? '浏览器调度' : mode === 'python' ? 'Python 调度' : '双端同时调度'}</option>`).join('')}</select><small>双端会各创建一个独立任务，使用同一份参数，分别发起请求和计费。</small></label>
            <div class="channel-selector" role="radiogroup" aria-label="请求通道">
              ${channelOption('gpt', 'GPT 通用', 'Responses API', 'response.created', this.taskDraft.channel)}
              ${channelOption('claude', 'Claude Code', 'Messages API', 'message_start', this.taskDraft.channel)}
            </div>
          </section>

          <section class="surface form-section" aria-labelledby="model-heading">
            <div class="form-section-head"><span class="step-number">02</span><div><h2 id="model-heading">凭据与模型</h2><p>从鉴权结果中选择 Key 和模型，也可填写自定义模型 ID。</p></div></div>
            <div class="field-grid two-cols">
              <label class="field"><span>Key</span><select name="keyId" required>${this.store.keys.map((item) => `<option value="${item.id}" ${item.id === this.taskDraft.keyId ? 'selected' : ''} ${item.authStatus !== 'ready' ? 'disabled' : ''}>${escapeHtml(item.alias)} · ${escapeHtml(keyTail(item.value))}${item.authStatus !== 'ready' ? '（不可用）' : ''}</option>`).join('')}</select></label>
              <label class="field"><span>模型</span><select name="modelChoice" required>${modelOptions}<option value="__custom__" ${this.taskDraft.modelChoice === '__custom__' ? 'selected' : ''}>自定义模型 ID…</option></select></label>
            </div>
            <div class="info-banner compact service-banner"><span aria-hidden="true">${icon('pulse')}</span><p><strong>API 服务</strong> ${escapeHtml(key?.baseUrl ?? '—')}</p></div>
            ${this.taskDraft.modelChoice === '__custom__' ? `<label class="field custom-model-field"><span>自定义模型 ID</span><input name="customModel" value="${escapeHtml(this.taskDraft.customModel)}" pattern="${MODEL_ID_PATTERN}" maxlength="100" placeholder="${this.taskDraft.channel === 'gpt' ? 'gpt-custom-model' : 'claude-custom-model'}" required /><small>模型 ID 将按原样发送到对应通道。</small></label>` : ''}
            ${this.taskDraft.channel === 'claude' ? `
              <label class="switch-row">
                <span class="switch-control"><input type="checkbox" name="oneMillion" ${this.taskDraft.oneMillion ? 'checked' : ''} /><span class="switch-ui" aria-hidden="true"></span></span>
                <span><strong>开启 1M 上下文兼容</strong><small>Claude Code 1M 上下文；默认开启。</small></span>
                <ar-status-pill label="AnyRouter 约定" tone="violet"></ar-status-pill>
              </label>
            ` : ''}
          </section>

          <section class="surface form-section" aria-labelledby="probe-heading">
            <div class="form-section-head"><span class="step-number">03</span><div><h2 id="probe-heading">探针与重试策略</h2><p>每一轮可并行发起多个探针，先挤入者结束该轮，其余线程立即停止。</p></div></div>
            <label class="field"><span>任务名称</span><input name="name" value="${escapeHtml(this.taskDraft.name)}" maxlength="60" required /></label>
            <label class="field"><span>探针提示词</span><textarea name="prompt" rows="3" maxlength="1000" required>${escapeHtml(this.taskDraft.prompt)}</textarea><small>默认只要求返回 OK，以降低探针开销。</small></label>
            <div class="field-grid two-cols">
              ${numberField('maxAttempts', '每轮探活上限', this.taskDraft.maxAttempts, LIMITS.attempts.min, undefined, 1, '次')}
              ${numberField('concurrency', '并发线程', this.taskDraft.concurrency, LIMITS.concurrency.min, undefined, 1, '线程')}
              ${numberField('intervalSeconds', '请求间隔', this.taskDraft.intervalSeconds, LIMITS.intervalSeconds.min, LIMITS.intervalSeconds.max, 0.5, '秒')}
              ${numberField('timeoutSeconds', '首事件超时', this.taskDraft.timeoutSeconds, LIMITS.timeoutSeconds.min, LIMITS.timeoutSeconds.max, 1, '秒')}
            </div>
            <p class="field-help">探活按实际并发请求计数；成功后重置探活预算。保活每次发送一个请求，失败后按探活策略恢复。</p>
            <label class="switch-row"><span class="switch-control"><input type="checkbox" name="keepalive" ${this.taskDraft.keepalive ? 'checked' : ''} /><span class="switch-ui" aria-hidden="true"></span></span><span><strong>成功后自动保活</strong><small>关闭后，任务在首次成功时结束。</small></span></label>
            <div class="field-grid two-cols">
              ${numberField('keepaliveMinSeconds', '保活最短间隔', this.taskDraft.keepaliveMinSeconds, LIMITS.keepaliveMinSeconds.min, LIMITS.keepaliveMinSeconds.max, 0.5, '秒')}
              ${numberField('keepaliveMaxSeconds', '保活最长间隔', this.taskDraft.keepaliveMaxSeconds, LIMITS.keepaliveMaxSeconds.min, LIMITS.keepaliveMaxSeconds.max, 0.5, '秒')}
            </div>
          </section>

          <section class="surface form-section" aria-labelledby="notify-heading">
            <div class="form-section-head"><span class="step-number">04</span><div><h2 id="notify-heading">成功通知</h2><p>首次成功或故障恢复后发送任务摘要。</p></div></div>
            ${this.notificationFields(this.taskDraft, this.taskDraft.notificationProvider)}
          </section>
        </div>
        <aside class="surface launch-panel">
          <span class="section-kicker">启动前确认</span><h2>任务摘要</h2>
          <dl class="launch-summary">
            <div><dt>调度端</dt><dd data-summary-field="scheduler">${this.taskDraft.scheduler === 'both' ? '浏览器 + Python' : this.taskDraft.scheduler === 'python' ? 'Python' : '浏览器'}</dd></div>
            <div><dt>通道</dt><dd data-summary-field="channel"><span class="channel-logo ${this.taskDraft.channel === 'gpt' ? 'gpt-logo' : 'claude-logo'}">${this.taskDraft.channel === 'gpt' ? 'G' : 'C'}</span>${this.taskDraft.channel === 'gpt' ? 'GPT Responses' : 'Claude Messages'}</dd></div>
            <div><dt>Key</dt><dd data-summary-field="key">${key ? `${escapeHtml(key.alias)} · ${escapeHtml(keyTail(key.value))}` : '—'}</dd></div>
            <div><dt>API 服务</dt><dd data-summary-field="base-url" title="${escapeHtml(key?.baseUrl ?? '')}">${escapeHtml(key?.baseUrl ?? '—')}</dd></div>
            <div><dt>模型</dt><dd data-summary-field="model">${escapeHtml(this.displayDraftModel())}</dd></div>
            <div><dt>重试</dt><dd data-summary-field="attempts">最多 ${this.taskDraft.maxAttempts} 次</dd></div>
            <div><dt>并发</dt><dd data-summary-field="concurrency">${this.taskDraft.concurrency} 线程</dd></div>
            <div><dt>间隔</dt><dd data-summary-field="interval">${this.taskDraft.intervalSeconds} 秒</dd></div>
            <div><dt>自动保活</dt><dd data-summary-field="keepalive">${this.taskDraft.keepalive ? `${this.taskDraft.keepaliveMinSeconds}–${this.taskDraft.keepaliveMaxSeconds} 秒` : '关闭'}</dd></div>
          </dl>
          <div class="launch-guard"><span aria-hidden="true">${icon('shield')}</span><p><strong>客户端兼容请求</strong>支持 Codex Responses 与 Claude Code Messages。</p></div>
          <button class="button primary large full" type="submit" ${this.submittingTask ? 'disabled' : ''}>${this.submittingTask ? `${icon('spinner')} 正在鉴权…` : `${icon('play')} 启动任务`}</button>
          <button class="text-button centered" type="button" data-action="reset-task-form">恢复默认参数</button>
        </aside>
      </form>
    `;
  }

  private tasksMarkup(): string {
    const tasks = this.visibleTasks();
    if (!tasks.length) {
      return `<section class="surface empty-surface">${this.emptyState('tasks', '任务中心还是空的', '创建 GPT 或 Claude 任务，查看重试和成功状态。', '<button class="button primary" type="button" data-nav="create">新建任务</button>')}</section>`;
    }
    const selectedCount = [...this.selectedTaskIds].filter((id) => this.store.engine.get(id)).length;
    return `
      <div class="task-toolbar surface">
        <label class="check-label"><input type="checkbox" data-action="select-all-tasks" ${selectedCount === tasks.length ? 'checked' : ''} /><span>选择全部</span></label>
        <span class="selection-count">已选择 ${selectedCount} 个</span>
        <span class="toolbar-divider"></span>
        <button class="button tiny secondary" type="button" data-action="batch-pause" ${selectedCount ? '' : 'disabled'}>${icon('pause')} 批量暂停</button>
        <button class="button tiny secondary danger-text" type="button" data-action="batch-cancel" ${selectedCount ? '' : 'disabled'}>${icon('close')} 批量取消</button>
        <button class="button tiny secondary danger-text" type="button" data-action="batch-delete" ${selectedCount ? '' : 'disabled'}>${icon('trash')} 删除任务</button>
        <div class="toolbar-legend"><span><i class="legend-dot running"></i> 活跃 ${tasks.filter(isTaskActive).length}</span><span><i class="legend-dot accepted"></i> 曾成功 ${tasks.filter((task) => task.successes > 0).length}</span></div>
      </div>
      <section class="task-list" aria-label="任务列表">
        ${tasks.map((task) => { const markup = this.taskCardMarkup(task); this.cardMarkup.set(task.id, markup); return markup; }).join('')}
      </section>
    `;
  }

  private taskCardMarkup(task: Task): string {
    const status = taskStatusMeta(task);
    const notification = notificationMeta(task);
    const progress = Math.min(100, (task.probeAttempts / task.config.maxAttempts) * 100);
    const canPause = isTaskActive(task);
    const canResume = task.status === 'paused';
    const canCancel = isTaskActive(task) || task.status === 'paused';
    const canRetry = ['waiting', 'keepalive', 'paused'].includes(task.status);
    return `
      <article class="task-card ${isAcceptedStatus(task.status) ? 'task-accepted' : ''}" data-task-id="${task.id}">
        <div class="task-card-select"><input type="checkbox" data-action="select-task" data-task-id="${task.id}" aria-label="选择任务 ${escapeHtml(task.config.name)}" ${this.selectedTaskIds.has(task.id) ? 'checked' : ''} /></div>
        <button class="task-card-main" type="button" data-action="open-task" data-task-id="${task.id}" aria-label="查看 ${escapeHtml(task.config.name)} 详情">
          <span class="channel-logo ${task.config.channel === 'gpt' ? 'gpt-logo' : 'claude-logo'}">${task.config.channel === 'gpt' ? 'G' : 'C'}</span>
          <span class="task-title"><strong>${escapeHtml(task.config.name)}</strong><small><span class="scheduler-label ${task.scheduler}">${task.scheduler === 'python' ? 'Python' : '浏览器'}</span> ${escapeHtml(task.config.model)}</small></span>
        </button>
        <div class="task-state"><span class="cell-label">状态</span><ar-status-pill label="${status.label}" tone="${status.tone}" dot></ar-status-pill><small>${escapeHtml(status.description)}</small></div>
        <div class="task-progress-cell"><span class="cell-label">探活 ${task.probeAttempts} / ${task.config.maxAttempts}</span><div class="attempt-line"><strong>${task.attemptsMade}</strong><span>次 · 成功 ${task.successes}</span></div><div class="progress-track" role="progressbar" aria-label="探活进度" aria-valuemin="0" aria-valuemax="${task.config.maxAttempts}" aria-valuenow="${task.probeAttempts}"><span style="width:${progress}%"></span></div></div>
        <div class="task-next"><span class="cell-label">下次请求</span><strong data-countdown-task="${task.id}">—</strong><small>${task.status === 'requesting' ? '等待首事件' : task.lastError ? escapeHtml(task.lastError) : task.healthy && task.config.keepalive ? `保活 ${task.config.keepaliveMinSeconds}–${task.config.keepaliveMaxSeconds} 秒` : `探活 ${task.config.intervalSeconds} 秒`}</small></div>
        <div class="task-notification"><span class="cell-label">通知</span><ar-status-pill label="${notification.label}" tone="${notification.tone}"></ar-status-pill><small>${task.notificationAttempts ? `${task.notificationAttempts} 次投递` : '成功通知'}</small></div>
        <div class="task-actions">
          ${canPause ? `<button class="icon-button" type="button" data-action="pause-task" data-task-id="${task.id}" aria-label="暂停 ${escapeHtml(task.config.name)}">${icon('pause')}</button>` : ''}
          ${canResume ? `<button class="icon-button action-green" type="button" data-action="resume-task" data-task-id="${task.id}" aria-label="继续 ${escapeHtml(task.config.name)}">${icon('play')}</button>` : ''}
          ${canRetry ? `<button class="icon-button" type="button" data-action="retry-task" data-task-id="${task.id}" aria-label="立即重试 ${escapeHtml(task.config.name)}">${icon('refresh')}</button>` : ''}
          ${canCancel ? `<button class="icon-button danger-ghost" type="button" data-action="cancel-task" data-task-id="${task.id}" aria-label="取消 ${escapeHtml(task.config.name)}">${icon('close')}</button>` : ''}
          ${!canPause && !canResume && !canCancel ? `<button class="icon-button" type="button" data-action="restart-task" data-task-id="${task.id}" aria-label="重新开始 ${escapeHtml(task.config.name)}">${icon('refresh')}</button>` : ''}
          <button class="icon-button danger-ghost" type="button" data-action="delete-task" data-task-id="${task.id}" aria-label="删除 ${escapeHtml(task.config.name)}">${icon('trash')}</button>
          <button class="icon-button" type="button" data-action="open-task" data-task-id="${task.id}" aria-label="打开 ${escapeHtml(task.config.name)} 详情">${icon('more')}</button>
        </div>
      </article>
    `;
  }

  private updateTaskList(list: HTMLElement): void {
    const tasks = this.visibleTasks();
    const existing = new Map([...list.querySelectorAll<HTMLElement>('.task-card')].map(node => [node.dataset.taskId!, node]));
    let cursor = list.firstElementChild;
    for (const task of tasks) {
      let node = existing.get(task.id);
      const markup = this.taskCardMarkup(task);
      if (!node || this.cardMarkup.get(task.id) !== markup) {
        const focused = node?.contains(document.activeElement) ? (document.activeElement as HTMLElement).dataset.action : undefined;
        const template = document.createElement('template');
        template.innerHTML = markup;
        const next = template.content.firstElementChild as HTMLElement;
        if (node === cursor) cursor = next;
        node?.replaceWith(next);
        node = next;
        this.cardMarkup.set(task.id, markup);
        if (focused) node.querySelector<HTMLElement>(`[data-action="${focused}"]`)?.focus({ preventScroll: true });
      }
      if (node !== cursor) list.insertBefore(node, cursor);
      cursor = node.nextElementSibling;
      existing.delete(task.id);
    }
    for (const [id, node] of existing) { node.remove(); this.cardMarkup.delete(id); }
    const toolbar = this.querySelector<HTMLElement>('.task-toolbar')!;
    const selected = tasks.filter(task => this.selectedTaskIds.has(task.id)).length;
    toolbar.querySelector<HTMLInputElement>('[data-action="select-all-tasks"]')!.checked = selected === tasks.length;
    toolbar.querySelector<HTMLElement>('.selection-count')!.textContent = `已选择 ${selected} 个`;
    for (const button of toolbar.querySelectorAll<HTMLButtonElement>('button')) button.disabled = !selected;
    const legend = toolbar.querySelector<HTMLElement>('.toolbar-legend')!;
    const markup = `<span><i class="legend-dot running"></i> 活跃 ${tasks.filter(isTaskActive).length}</span><span><i class="legend-dot accepted"></i> 曾成功 ${tasks.filter(task => task.successes > 0).length}</span>`;
    if (legend.innerHTML !== markup) legend.innerHTML = markup;
    this.updateCountdowns();
  }

  private notificationProvider(config: NotificationSettings): NotificationProvider {
    return config.showdocPushUrl ? 'showdoc' : config.serverchanSendKey ? 'serverchan'
      : config.telegramChatId || config.telegramBotToken ? 'telegram' : 'showdoc';
  }

  private notificationFields(config: NotificationSettings, provider = this.notificationProvider(config)): string {
    return `<div class="notification-fields">
      <p class="field-help">选择推送方式，再填写对应参数；参数留空则关闭通知。发送任务名、模型、Key 尾号、尝试次数和耗时。</p>
      <label class="field"><span>推送方式</span><select name="notificationProvider">
        <option value="showdoc" ${provider === 'showdoc' ? 'selected' : ''}>ShowDoc 推送</option>
        <option value="serverchan" ${provider === 'serverchan' ? 'selected' : ''}>Server 酱</option>
        <option value="telegram" ${provider === 'telegram' ? 'selected' : ''}>Telegram</option>
      </select></label>
      <div data-notification-provider="showdoc" ${provider !== 'showdoc' ? 'hidden' : ''}>
        <label class="field"><span>ShowDoc 推送 URL <small class="optional">可选</small></span><input name="showdocPushUrl" type="password" value="${escapeHtml(config.showdocPushUrl ?? '')}" maxlength="1024" autocomplete="off" placeholder="https://push.showdoc.com.cn/server/api/push/…" ${provider !== 'showdoc' ? 'disabled' : ''} /><small>从 <a href="https://push.showdoc.com.cn/" target="_blank" rel="noopener noreferrer">ShowDoc 推送服务</a>复制完整推送 URL。</small></label>
      </div>
      <div data-notification-provider="serverchan" ${provider !== 'serverchan' ? 'hidden' : ''}>
        <label class="field"><span>Server 酱 SendKey <small class="optional">可选</small></span><input name="serverchanSendKey" type="password" value="${escapeHtml(config.serverchanSendKey ?? '')}" maxlength="256" autocomplete="off" placeholder="SCT… 或 sctp…" ${provider !== 'serverchan' ? 'disabled' : ''} /><small>支持 Turbo 和 Server 酱 3。</small></label>
        <label class="field"><span>Server 酱标签 <small class="optional">可选</small></span><input name="serverchanTags" value="${escapeHtml(config.serverchanTags ?? '')}" maxlength="128" placeholder="服务器报警|图片" ${provider !== 'serverchan' ? 'disabled' : ''} /><small>多个标签用 | 分隔。</small></label>
      </div>
      <div data-notification-provider="telegram" ${provider !== 'telegram' ? 'hidden' : ''}>
        <label class="field"><span>Telegram Chat ID <small class="optional">可选</small></span><input name="telegramChatId" value="${escapeHtml(config.telegramChatId)}" maxlength="128" placeholder="-1001234567890" ${provider !== 'telegram' ? 'disabled' : ''} /></label>
        <label class="field"><span>Telegram Bot Token <small class="optional">可选</small></span><input name="telegramBotToken" type="password" value="${escapeHtml(config.telegramBotToken)}" maxlength="256" autocomplete="off" placeholder="123456:ABC..." ${provider !== 'telegram' ? 'disabled' : ''} /></label>
      </div>
    </div>`;
  }

  private settingsMarkup(): string {
    const settings = this.store.settings;
    return `
      <div class="settings-layout">
        <form id="settings-form" class="surface settings-form">
          <div class="section-head"><div><span class="section-kicker">任务默认值</span><h2>重试参数</h2></div><span class="settings-icon" aria-hidden="true">${icon('sliders')}</span></div>
          <p class="section-description">只影响后续新建任务；已运行任务保持原配置。</p>
          <div class="field-grid two-cols settings-numbers">
            ${numberField('attempts', '默认请求次数', settings.attempts, LIMITS.attempts.min, undefined, 1, '次')}
            ${numberField('concurrency', '默认并发线程', settings.concurrency, LIMITS.concurrency.min, undefined, 1, '线程')}
            ${numberField('intervalSeconds', '默认请求间隔', settings.intervalSeconds, LIMITS.intervalSeconds.min, LIMITS.intervalSeconds.max, 0.5, '秒')}
            ${numberField('timeoutSeconds', '默认首事件超时', settings.timeoutSeconds, LIMITS.timeoutSeconds.min, LIMITS.timeoutSeconds.max, 1, '秒')}
            ${numberField('keepaliveMinSeconds', '保活最短间隔', settings.keepaliveMinSeconds, LIMITS.keepaliveMinSeconds.min, LIMITS.keepaliveMinSeconds.max, 0.5, '秒')}
            ${numberField('keepaliveMaxSeconds', '保活最长间隔', settings.keepaliveMaxSeconds, LIMITS.keepaliveMaxSeconds.min, LIMITS.keepaliveMaxSeconds.max, 0.5, '秒')}
          </div>
          <label class="switch-row"><span class="switch-control"><input type="checkbox" name="keepalive" ${settings.keepalive ? 'checked' : ''} /><span class="switch-ui" aria-hidden="true"></span></span><span><strong>默认开启自动保活</strong><small>浏览器和 Python 使用同一套默认参数。</small></span></label>
          <hr />
          <div class="section-head"><div><span class="section-kicker">界面外观</span><h2>颜色模式</h2></div><span class="settings-icon" aria-hidden="true">${icon('moon')}</span></div>
          <p class="section-description">选择会保存在当前浏览器，并同步应用到任务后台。</p>
          <div class="theme-setting-row">
            <div><strong data-theme-toggle-label>${getTheme() === 'dark' ? '深色' : '浅色'}模式</strong><small>在弱光环境下减少屏幕亮度。</small></div>
            ${this.themeToggleMarkup()}
          </div>
          <hr />
          <div class="section-head"><div><span class="section-kicker">通知默认值</span><h2>成功通知</h2></div><span class="settings-icon" aria-hidden="true">${icon('send')}</span></div>
          ${this.notificationFields(settings)}
          <div class="form-actions"><button class="button secondary" type="button" data-action="reset-settings">恢复默认</button><button class="button primary" type="submit">${icon('check')} 保存设置</button></div>
        </form>
        <aside class="settings-side">
          <section class="surface persistence-card">
            <span class="settings-hero-icon" aria-hidden="true">${icon('database')}</span>
            <h2>工作区数据</h2>
            <p>管理凭据、模型列表、任务记录和默认设置。</p>
            <ul><li>${icon('check')} 多 Key 与模型列表</li><li>${icon('check')} 任务记录与响应摘要</li><li>${icon('check')} 通知默认值</li></ul>
          </section>
          <section class="surface gate-card"><span class="section-kicker">服务功能</span><h2>请求通道</h2><p>支持 GPT Responses、Claude Code Messages，以及 ShowDoc、Telegram、Server 酱通知。</p><ar-status-pill label="双端调度 · 成功通知" tone="green" dot></ar-status-pill></section>
        </aside>
      </div>
    `;
  }

  private renderDrawer(shouldFocus: boolean): void {
    const host = this.querySelector<HTMLElement>('#drawer-host');
    if (!host) return;
    const task = this.openTaskId ? this.store.engine.get(this.openTaskId) : undefined;
    if (!task) {
      this.closeDrawer();
      return;
    }
    const status = taskStatusMeta(task);
    const notification = notificationMeta(task);
    const existing = host.querySelector<HTMLElement>(
      `.task-drawer[data-drawer-task-id="${CSS.escape(task.id)}"]`,
    );
    if (existing && !shouldFocus) {
      this.updateDrawer(existing, task);
      return;
    }
    host.innerHTML = `
      <div class="drawer-layer" data-action="drawer-backdrop">
        <section class="task-drawer" data-drawer-task-id="${escapeHtml(task.id)}" role="dialog" aria-modal="true" aria-labelledby="drawer-title">
          <header class="drawer-head">
            <div class="drawer-title-wrap"><span class="channel-logo ${task.config.channel === 'gpt' ? 'gpt-logo' : 'claude-logo'}">${task.config.channel === 'gpt' ? 'G' : 'C'}</span><div><span class="eyebrow">任务详情</span><h2 id="drawer-title">${escapeHtml(task.config.name)}</h2></div></div>
            <button class="icon-button drawer-close" type="button" data-action="close-drawer" aria-label="关闭任务详情">${icon('close')}</button>
          </header>
          <div class="drawer-body">
            <div class="drawer-status-card">
              <div><span class="cell-label">当前状态</span><ar-status-pill data-drawer-field="status" label="${status.label}" tone="${status.tone}" dot></ar-status-pill></div>
              <div><span class="cell-label">累计请求 / 成功</span><strong data-drawer-field="attempts">${task.attemptsMade} / ${task.successes}</strong></div>
              <div><span class="cell-label">总耗时</span><strong data-drawer-field="duration">${formatDuration((task.completedAt ?? Date.now()) - task.startedAt)}</strong></div>
            </div>
            <dl class="detail-grid">
              <div><dt>调度端</dt><dd>${task.scheduler === 'python' ? 'Python 后台' : '当前浏览器'}</dd></div>
              <div><dt>自动保活</dt><dd>${task.config.keepalive ? `${task.config.keepaliveMinSeconds}–${task.config.keepaliveMaxSeconds} 秒` : '关闭'}</dd></div>
              <div><dt>实际模型</dt><dd>${escapeHtml(task.config.model)}</dd></div>
              <div><dt>通道</dt><dd>${task.config.channel === 'gpt' ? 'GPT · /v1/responses' : 'Claude · /v1/messages?beta=true'}</dd></div>
              <div><dt>API 服务</dt><dd title="${escapeHtml(task.config.baseUrl)}">${escapeHtml(task.config.baseUrl)}</dd></div>
              <div><dt>启动时间</dt><dd>${formatDateTime(task.startedAt)}</dd></div>
              <div><dt>最近成功</dt><dd data-drawer-field="accepted-at">${formatDateTime(task.acceptedAt)}</dd></div>
            </dl>
            <section class="drawer-section" aria-labelledby="notice-state-heading"><div class="drawer-section-head"><h3 id="notice-state-heading">通知状态</h3><ar-status-pill data-drawer-field="notification-status" label="${notification.label}" tone="${notification.tone}"></ar-status-pill></div><div class="notice-summary"><span aria-hidden="true">${icon('send')}</span><p data-drawer-field="notification-description">${escapeHtml(this.notificationDescription(task))}</p><strong data-drawer-field="notification-attempts">${task.notificationAttempts || 0} 次</strong></div><button class="button secondary tiny" type="button" data-action="refresh-notification" data-task-id="${task.id}" data-drawer-field="notification-refresh" ${task.notificationId ? '' : 'disabled'}>手动刷新回执</button></section>
            <section class="drawer-section" aria-labelledby="response-heading"><div class="drawer-section-head"><h3 id="response-heading">响应摘要</h3><span data-drawer-field="response-bytes">${new TextEncoder().encode(task.responseSummary).length} / 8192 bytes</span></div><pre class="response-box" data-drawer-field="response-summary">${escapeHtml(task.responseSummary || '尚未收到成功响应正文。')}</pre></section>
            <section class="drawer-section" aria-labelledby="events-heading"><div class="drawer-section-head"><h3 id="events-heading">结构化事件</h3><span data-drawer-field="event-count">${task.events.length} / 200</span></div><ol class="event-timeline">${[...task.events].reverse().map((event) => this.drawerEventMarkup(event)).join('')}</ol></section>
          </div>
          <footer class="drawer-foot">
            <span>Task ID · ${escapeHtml(task.id.slice(-12))}</span>
            <div data-drawer-field="actions">${this.drawerActionsMarkup(task)}</div>
          </footer>
        </section>
      </div>
    `;
    if (shouldFocus) window.setTimeout(() => host.querySelector<HTMLElement>('.drawer-close')?.focus(), 0);
  }

  private updateDrawer(drawer: HTMLElement, task: Task): void {
    const status = taskStatusMeta(task);
    const notification = notificationMeta(task);
    this.updatePill(drawer, 'status', status.label, status.tone);
    this.updatePill(drawer, 'notification-status', notification.label, notification.tone);
    this.updateDrawerText(drawer, 'attempts', `${task.attemptsMade} / ${task.successes}`);
    this.updateDrawerText(
      drawer,
      'duration',
      formatDuration((task.completedAt ?? Date.now()) - task.startedAt),
    );
    this.updateDrawerText(drawer, 'accepted-at', formatDateTime(task.acceptedAt));
    this.updateDrawerText(drawer, 'notification-description', this.notificationDescription(task));
    this.updateDrawerText(drawer, 'notification-attempts', `${task.notificationAttempts || 0} 次`);
    const notificationRefresh = drawer.querySelector<HTMLButtonElement>('[data-drawer-field="notification-refresh"]');
    if (notificationRefresh) notificationRefresh.disabled = !task.notificationId;
    this.updateDrawerText(
      drawer,
      'response-bytes',
      `${new TextEncoder().encode(task.responseSummary).length} / 8192 bytes`,
    );
    this.updateDrawerText(
      drawer,
      'response-summary',
      task.responseSummary || '尚未收到成功响应正文。',
    );
    this.updateDrawerText(drawer, 'event-count', `${task.events.length} / 200`);
    this.updateDrawerEvents(drawer, task);

    const actions = drawer.querySelector<HTMLElement>('[data-drawer-field="actions"]');
    const nextActions = this.drawerActionsMarkup(task);
    if (actions && actions.innerHTML !== nextActions) actions.innerHTML = nextActions;
  }

  private updateDrawerText(drawer: HTMLElement, field: string, value: string): void {
    const node = drawer.querySelector<HTMLElement>(`[data-drawer-field="${field}"]`);
    if (node && node.textContent !== value) node.textContent = value;
  }

  private updatePill(drawer: HTMLElement, field: string, label: string, tone: string): void {
    const pill = drawer.querySelector<HTMLElement>(`[data-drawer-field="${field}"]`);
    if (!pill) return;
    if (pill.getAttribute('label') !== label) pill.setAttribute('label', label);
    if (pill.getAttribute('tone') !== tone) pill.setAttribute('tone', tone);
  }

  private updateDrawerEvents(drawer: HTMLElement, task: Task): void {
    const timeline = drawer.querySelector<HTMLOListElement>('.event-timeline');
    if (!timeline) return;
    const existing = new Map(
      [...timeline.querySelectorAll<HTMLElement>('[data-event-id]')].map((node) => [
        node.dataset.eventId ?? '',
        node,
      ]),
    );
    let cursor: ChildNode | null = timeline.firstChild;
    for (const event of [...task.events].reverse()) {
      let node = existing.get(event.id);
      if (!node) {
        const template = document.createElement('template');
        template.innerHTML = this.drawerEventMarkup(event);
        node = template.content.firstElementChild as HTMLElement;
      }
      existing.delete(event.id);
      if (node !== cursor) timeline.insertBefore(node, cursor);
      cursor = node.nextSibling;
    }
    for (const stale of existing.values()) stale.remove();
  }

  private drawerEventMarkup(event: Task['events'][number]): string {
    return `<li class="event-${event.tone}" data-event-id="${escapeHtml(event.id)}"><span class="event-node"></span><div><span class="event-meta"><code>${escapeHtml(event.type)}</code><time>${formatTime(event.at)}</time></span><strong>${escapeHtml(event.title)}</strong><p>${escapeHtml(event.detail)}</p></div></li>`;
  }

  private drawerActionsMarkup(task: Task): string {
    return `${isTaskActive(task) ? `<button class="button secondary" type="button" data-action="pause-task" data-task-id="${task.id}">${icon('pause')} 暂停</button>` : task.status !== 'paused' ? `<button class="button secondary" type="button" data-action="restart-task" data-task-id="${task.id}">${icon('refresh')} 重新开始</button>` : ''}${task.status === 'paused' ? `<button class="button secondary" type="button" data-action="resume-task" data-task-id="${task.id}">${icon('play')} 继续</button>` : ''}${['waiting', 'keepalive', 'paused'].includes(task.status) ? `<button class="button secondary" type="button" data-action="retry-task" data-task-id="${task.id}">${icon('refresh')} 立即请求</button>` : ''}<button class="button primary" type="button" data-action="close-drawer">完成</button>`;
  }

  private async handleSubmit(event: SubmitEvent): Promise<void> {
    const form = event.target as HTMLFormElement;
    if (form.id === 'key-form') {
      event.preventDefault();
      await this.submitKey(form);
      return;
    }
    if (form.id === 'key-base-url-form') {
      event.preventDefault();
      await this.submitKeyBaseUrl(form);
      return;
    }
    if (form.id === 'task-form') {
      event.preventDefault();
      await this.submitTask(form);
      return;
    }
    if (form.id === 'settings-form') {
      event.preventDefault();
      this.submitSettings(form);
    }
  }

  private async submitKey(form: HTMLFormElement): Promise<void> {
    if (!form.reportValidity()) return;
    const submit = this.querySelector<HTMLButtonElement>('#add-key-submit');
    if (submit) {
      submit.disabled = true;
      submit.innerHTML = `${icon('spinner')} 鉴权中…`;
    }
    const data = new FormData(form);
    let record: KeyRecord;
    try {
      record = await this.store.addKey(
        String(data.get('alias') ?? ''),
        String(data.get('key') ?? ''),
        String(data.get('baseUrl') ?? DEFAULT_API_BASE_URL),
      );
    } catch (error) {
      this.toast(error instanceof Error ? error.message : 'API 地址无效', 'danger');
      if (submit) {
        submit.disabled = false;
        submit.textContent = '鉴权并保存';
      }
      return;
    }
    if (record.authStatus === 'ready') {
      this.closeKeyDialog();
      form.reset();
      this.ensureDraft(true);
      this.toast(`${record.alias} 已通过鉴权`, 'success');
    } else {
      this.toast(record.error ?? '鉴权失败', 'danger');
    }
    if (submit) {
      submit.disabled = false;
      submit.textContent = '鉴权并保存';
    }
  }

  private validIntervals(form: HTMLFormElement): boolean {
    const minimum = form.elements.namedItem('keepaliveMinSeconds') as HTMLInputElement;
    const maximum = form.elements.namedItem('keepaliveMaxSeconds') as HTMLInputElement;
    maximum.setCustomValidity(Number(minimum.value) > Number(maximum.value) ? '最长间隔不能小于最短间隔' : '');
    return form.reportValidity();
  }

  private async submitTask(form: HTMLFormElement): Promise<void> {
    if (!this.validIntervals(form) || this.submittingTask) return;
    const data = new FormData(form);
    const scheduler = String(data.get('scheduler')) as SchedulerChoice;
    const channel = String(data.get('channel')) as Channel;
    const keyId = String(data.get('keyId'));
    const key = this.store.keys.find((record) => record.id === keyId);
    if (!key) {
      this.toast('所选 Key 已不存在', 'danger');
      return;
    }
    const modelChoice = String(data.get('modelChoice'));
    const customModel = String(data.get('customModel') ?? '').trim();
    let model = modelChoice === '__custom__' ? customModel : modelChoice;
    const oneMillion = data.get('oneMillion') === 'on';
    if (channel === 'claude' && oneMillion && !/\[1m\]$/i.test(model)) model = `${model}[1m]`;
    const config: TaskConfig = {
      name: String(data.get('name')).trim(),
      channel,
      keyId,
      baseUrl: key.baseUrl,
      model,
      prompt: String(data.get('prompt')).trim(),
      maxAttempts: Number(data.get('maxAttempts')),
      intervalSeconds: Number(data.get('intervalSeconds')),
      timeoutSeconds: Number(data.get('timeoutSeconds')),
      concurrency: Number(data.get('concurrency')),
      keepalive: data.get('keepalive') === 'on',
      keepaliveMinSeconds: Number(data.get('keepaliveMinSeconds')),
      keepaliveMaxSeconds: Number(data.get('keepaliveMaxSeconds')),
      telegramChatId: String(data.get('telegramChatId') ?? '').trim(),
      telegramBotToken: String(data.get('telegramBotToken') ?? '').trim(),
      showdocPushUrl: String(data.get('showdocPushUrl') ?? '').trim(),
      serverchanSendKey: String(data.get('serverchanSendKey') ?? '').trim(),
      serverchanTags: String(data.get('serverchanTags') ?? '').trim(),
      oneMillion,
    };

    this.submittingTask = true;
    this.suppressViewRender = true;
    this.renderView();
    try {
      const authOk = await this.store.authenticateKey(keyId, scheduler);
      if (!authOk) { this.toast('启动已停止：所选调度端鉴权未通过', 'danger'); return; }
      const tasks = await this.store.createTask(config, scheduler);
      this.schedulerFilter = scheduler === 'both' ? 'all' : scheduler;
      this.taskDraft = this.makeDraft();
      this.toast(`已启动 ${tasks.length} 个独立任务`, 'success');
      this.navigate('tasks');
      this.updateSchedulerBar();
    } finally {
      this.suppressViewRender = false;
      this.submittingTask = false;
      if (this.page === 'create') this.renderView();
    }
  }

  private async submitKeyBaseUrl(form: HTMLFormElement): Promise<void> {
    if (!form.reportValidity() || !this.editingKeyId) return;
    const data = new FormData(form);
    const submit = this.querySelector<HTMLButtonElement>('#save-key-base-url');
    if (submit) submit.disabled = true;
    try {
      const baseUrl = normalizeApiBaseUrl(String(data.get('baseUrl') ?? ''));
      const ok = await this.store.updateKeyBaseUrl(this.editingKeyId, baseUrl);
      this.closeKeyBaseUrlDialog();
      this.ensureDraft(true);
      this.toast(ok ? 'API 地址已保存并通过鉴权' : 'API 地址已保存，但重新鉴权失败', ok ? 'success' : 'danger');
    } catch (error) {
      this.toast(error instanceof Error ? error.message : 'API 地址无效', 'danger');
    } finally {
      if (submit) submit.disabled = false;
    }
  }

  private submitSettings(form: HTMLFormElement): void {
    if (!this.validIntervals(form)) return;
    const data = new FormData(form);
    const settings: AppSettings = {
      attempts: Number(data.get('attempts')),
      intervalSeconds: Number(data.get('intervalSeconds')),
      timeoutSeconds: Number(data.get('timeoutSeconds')),
      concurrency: Number(data.get('concurrency')),
      keepalive: data.get('keepalive') === 'on',
      keepaliveMinSeconds: Number(data.get('keepaliveMinSeconds')),
      keepaliveMaxSeconds: Number(data.get('keepaliveMaxSeconds')),
      telegramChatId: String(data.get('telegramChatId') ?? '').trim(),
      telegramBotToken: String(data.get('telegramBotToken') ?? '').trim(),
      showdocPushUrl: String(data.get('showdocPushUrl') ?? '').trim(),
      serverchanSendKey: String(data.get('serverchanSendKey') ?? '').trim(),
      serverchanTags: String(data.get('serverchanTags') ?? '').trim(),
    };
    this.store.updateSettings(settings);
    this.taskDraft = this.makeDraft();
    this.toast('默认设置已保存', 'success');
  }

  private async handleClick(event: Event): Promise<void> {
    const target = (event.target as HTMLElement).closest<HTMLElement>('[data-nav], [data-action]');
    if (!target) return;
    const nav = target.dataset.nav as Page | undefined;
    if (nav) {
      event.preventDefault();
      this.navigate(nav);
      return;
    }
    const action = target.dataset.action;
    const taskId = target.dataset.taskId;
    const keyId = target.dataset.keyId;
    switch (action) {
      case 'logout':
        await serverRequest('/api/auth/logout', 'POST');
        window.dispatchEvent(new Event('authentication-required'));
        break;
      case 'refresh-keys':
        await this.store.refreshKeys();
        this.toast('已同步服务器 Key 列表', 'success');
        break;
      case 'filter-scheduler': {
        this.schedulerFilter = target.dataset.scheduler as Scheduler | 'all';
        this.selectedTaskIds.clear();
        this.closeDrawer();
        if (this.page === 'create' && this.schedulerFilter !== 'all') this.taskDraft.scheduler = this.schedulerFilter;
        this.updateSchedulerBar();
        this.renderView();
        break;
      }
      case 'refresh-python':
        await this.store.python.refresh();
        break;
      case 'open-key-dialog':
        this.openKeyDialog();
        break;
      case 'toggle-theme':
        toggleTheme();
        break;
      case 'close-key-dialog':
        this.closeKeyDialog();
        break;
      case 'edit-key-base-url':
        if (keyId) this.openKeyBaseUrlDialog(keyId);
        break;
      case 'close-key-base-url-dialog':
        this.closeKeyBaseUrlDialog();
        break;
      case 'reauth-key':
        if (keyId) await this.reauthenticate(keyId);
        break;
      case 'delete-key':
        if (keyId && await this.store.deleteKey(keyId)) {
          this.ensureDraft(true);
          this.toast('Key 已删除', 'neutral');
        }
        break;
      case 'reset-task-form':
        this.taskDraft = this.makeDraft();
        this.renderView();
        this.toast('已恢复默认任务参数', 'neutral');
        break;
      case 'pause-task':
        if (taskId && await this.store.engine.pause(taskId)) this.toast('任务已暂停', 'neutral');
        break;
      case 'resume-task':
        if (taskId && await this.store.engine.resume(taskId)) this.toast('任务已继续', 'success');
        break;
      case 'retry-task':
        if (taskId && await this.store.engine.retryNow(taskId)) this.toast('已立即发起下一次请求', 'success');
        break;
      case 'refresh-notification':
        if (taskId) void this.store.engine.refreshNotification(taskId);
        break;
      case 'cancel-task':
        if (taskId && await this.store.engine.cancel(taskId)) this.toast('任务已取消', 'neutral');
        break;
      case 'restart-task': {
        if (taskId) {
          try {
            await this.store.restartTask(taskId);
          } catch (error) {
            this.toast(error instanceof Error ? error.message : '任务重新开始失败', 'danger');
            break;
          }
          this.closeDrawer();
          this.toast('已按原配置重新开始任务', 'success');
        }
        break;
      }
      case 'open-task':
        if (taskId) this.openDrawer(taskId);
        break;
      case 'close-drawer':
        this.closeDrawer();
        break;
      case 'drawer-backdrop':
        if (event.target === target) this.closeDrawer();
        break;
      case 'batch-pause': {
        const count = await this.store.engine.pauseMany([...this.selectedTaskIds]);
        this.toast(`已暂停 ${count} 个可运行任务`, 'neutral');
        break;
      }
      case 'batch-cancel': {
        const count = await this.store.engine.cancelMany([...this.selectedTaskIds]);
        this.toast(`已取消 ${count} 个可运行任务`, 'neutral');
        break;
      }
      case 'delete-task': {
        if (taskId && this.store.engine.get(taskId) && this.confirmDelete(1)) {
          await this.forgetTasks([taskId]);
        }
        break;
      }
      case 'batch-delete': {
        const ids = [...this.selectedTaskIds].filter((id) => this.store.engine.get(id));
        if (ids.length && this.confirmDelete(ids.length)) await this.forgetTasks(ids);
        break;
      }
      case 'reset-settings':
        this.store.resetSettings();
        this.taskDraft = this.makeDraft();
        this.toast('已恢复默认探活与保活参数', 'neutral');
        break;
    }
  }

  private handleChange(event: Event): void {
    const target = event.target as HTMLInputElement | HTMLSelectElement;
    if (target.name === 'notificationProvider') {
      const section = target.closest('.notification-fields')!;
      for (const fields of section.querySelectorAll<HTMLElement>('[data-notification-provider]')) {
        fields.hidden = fields.dataset.notificationProvider !== target.value;
        for (const input of fields.querySelectorAll<HTMLInputElement>('input')) input.disabled = fields.hidden;
      }
      if (target.closest('#task-form')) this.captureDraft();
      return;
    }
    if (target.dataset.action === 'select-task') {
      const checkbox = target as HTMLInputElement;
      if (checkbox.checked) this.selectedTaskIds.add(target.dataset.taskId ?? '');
      else this.selectedTaskIds.delete(target.dataset.taskId ?? '');
      this.renderView();
      return;
    }
    if (target.dataset.action === 'select-all-tasks') {
      const checkbox = target as HTMLInputElement;
      this.selectedTaskIds.clear();
      if (checkbox.checked) {
        for (const task of this.visibleTasks()) this.selectedTaskIds.add(task.id);
      }
      this.renderView();
      return;
    }
    if (!target.closest('#task-form')) return;
    this.captureDraft();
    if (target.name === 'channel' || target.name === 'keyId') {
      this.syncDraftModel(true);
      this.renderView();
    } else if (target.name === 'modelChoice') {
      this.renderView();
    } else if (['oneMillion', 'scheduler', 'keepalive'].includes(target.name)) {
      this.renderView();
    }
  }

  private handleInput(event: Event): void {
    const target = event.target as HTMLInputElement | HTMLTextAreaElement;
    if (target.name === 'keepaliveMinSeconds' || target.name === 'keepaliveMaxSeconds') {
      (target.form?.elements.namedItem('keepaliveMaxSeconds') as HTMLInputElement | null)?.setCustomValidity('');
    }
    if (!target.closest('#task-form')) return;
    this.captureDraft();
    const summaryNames = new Set(['maxAttempts', 'intervalSeconds', 'concurrency', 'name', 'customModel', 'keepaliveMinSeconds', 'keepaliveMaxSeconds']);
    if (summaryNames.has(target.name)) this.updateLaunchSummary();
  }

  private handleKeydown(event: KeyboardEvent): void {
    if (event.key === 'Escape' && this.openTaskId) {
      event.preventDefault();
      this.closeDrawer();
      return;
    }
    if (event.key !== 'Tab' || !this.openTaskId) return;
    const drawer = this.querySelector<HTMLElement>('.task-drawer');
    if (!drawer) return;
    const focusable = [...drawer.querySelectorAll<HTMLElement>('button:not([disabled]), input:not([disabled]), select:not([disabled]), [tabindex]:not([tabindex="-1"])')];
    if (!focusable.length) return;
    const first = focusable[0];
    const last = focusable.at(-1);
    if (!first || !last) return;
    if (event.shiftKey && document.activeElement === first) {
      event.preventDefault();
      last.focus();
    } else if (!event.shiftKey && document.activeElement === last) {
      event.preventDefault();
      first.focus();
    }
  }

  private confirmDelete(count: number): boolean {
    return window.confirm(
      count === 1
        ? '删除这个任务？事件记录和响应摘要会一并从本地清除，无法恢复。'
        : `删除这 ${count} 个任务？事件记录和响应摘要会一并从本地清除，无法恢复。`,
    );
  }

  private async forgetTasks(ids: string[]): Promise<void> {
    // Drop selection and the open drawer first: removal re-renders synchronously from the store event.
    for (const id of ids) this.selectedTaskIds.delete(id);
    if (this.openTaskId && ids.includes(this.openTaskId)) this.closeDrawer();
    const count = await this.store.engine.removeMany(ids);
    this.toast(`已删除 ${count} 个任务记录`, 'neutral');
  }

  private captureDraft(): void {
    const form = this.querySelector<HTMLFormElement>('#task-form');
    if (!form) return;
    const data = new FormData(form);
    this.taskDraft = {
      notificationProvider: String(data.get('notificationProvider')) as NotificationProvider,
      scheduler: String(data.get('scheduler') ?? this.taskDraft.scheduler) as SchedulerChoice,
      name: String(data.get('name') ?? this.taskDraft.name),
      channel: String(data.get('channel') ?? this.taskDraft.channel) as Channel,
      keyId: String(data.get('keyId') ?? this.taskDraft.keyId),
      modelChoice: String(data.get('modelChoice') ?? this.taskDraft.modelChoice),
      customModel: String(data.get('customModel') ?? this.taskDraft.customModel),
      prompt: String(data.get('prompt') ?? this.taskDraft.prompt),
      maxAttempts: Number(data.get('maxAttempts') ?? this.taskDraft.maxAttempts),
      intervalSeconds: Number(data.get('intervalSeconds') ?? this.taskDraft.intervalSeconds),
      timeoutSeconds: Number(data.get('timeoutSeconds') ?? this.taskDraft.timeoutSeconds),
      concurrency: Number(data.get('concurrency') ?? this.taskDraft.concurrency),
      keepalive: data.get('keepalive') === 'on',
      keepaliveMinSeconds: Number(data.get('keepaliveMinSeconds') ?? this.taskDraft.keepaliveMinSeconds),
      keepaliveMaxSeconds: Number(data.get('keepaliveMaxSeconds') ?? this.taskDraft.keepaliveMaxSeconds),
      telegramChatId: String(data.get('telegramChatId') ?? this.taskDraft.telegramChatId),
      telegramBotToken: String(data.get('telegramBotToken') ?? this.taskDraft.telegramBotToken),
      showdocPushUrl: String(data.get('showdocPushUrl') ?? this.taskDraft.showdocPushUrl ?? ''),
      serverchanSendKey: String(data.get('serverchanSendKey') ?? this.taskDraft.serverchanSendKey ?? ''),
      serverchanTags: String(data.get('serverchanTags') ?? this.taskDraft.serverchanTags ?? ''),
      oneMillion: form.elements.namedItem('oneMillion')
        ? data.get('oneMillion') === 'on'
        : this.taskDraft.oneMillion,
    };
  }

  private updateLaunchSummary(): void {
    // Draft inputs are retained; a small delayed render keeps the sticky summary accurate without every keystroke.
    const panel = this.querySelector<HTMLElement>('.launch-panel');
    if (!panel) return;
    const modelRow = panel.querySelector<HTMLElement>('[data-summary-field="model"]');
    const retryRow = panel.querySelector<HTMLElement>('[data-summary-field="attempts"]');
    const concurrencyRow = panel.querySelector<HTMLElement>('[data-summary-field="concurrency"]');
    const intervalRow = panel.querySelector<HTMLElement>('[data-summary-field="interval"]');
    const keepaliveRow = panel.querySelector<HTMLElement>('[data-summary-field="keepalive"]');
    if (modelRow) modelRow.textContent = this.displayDraftModel();
    if (retryRow) retryRow.textContent = `最多 ${this.taskDraft.maxAttempts || 0} 次`;
    if (concurrencyRow) concurrencyRow.textContent = `${this.taskDraft.concurrency || 0} 线程`;
    if (intervalRow) intervalRow.textContent = `${this.taskDraft.intervalSeconds || 0} 秒`;
    if (keepaliveRow) keepaliveRow.textContent = this.taskDraft.keepalive ? `${this.taskDraft.keepaliveMinSeconds}–${this.taskDraft.keepaliveMaxSeconds} 秒` : '关闭';
  }

  private makeDraft(): TaskDraft {
    const readyKey = this.store.keys.find((key) => key.authStatus === 'ready');
    const channel: Channel = 'gpt';
    const models = readyKey ? modelsForChannel(readyKey.models, channel) : [];
    return {
      scheduler: this.schedulerFilter === 'all' ? this.taskDraft?.scheduler ?? 'browser' : this.schedulerFilter,
      notificationProvider: this.notificationProvider(this.store.settings),
      name: `GPT 队列探针 ${new Intl.DateTimeFormat('zh-CN', { hour: '2-digit', minute: '2-digit', hour12: false }).format(new Date())}`,
      channel,
      keyId: readyKey?.id ?? '',
      modelChoice: preferredModel(models, channel),
      customModel: '',
      prompt: '请只返回 OK。',
      maxAttempts: this.store.settings.attempts,
      intervalSeconds: this.store.settings.intervalSeconds,
      timeoutSeconds: this.store.settings.timeoutSeconds,
      concurrency: this.store.settings.concurrency,
      keepalive: this.store.settings.keepalive,
      keepaliveMinSeconds: this.store.settings.keepaliveMinSeconds,
      keepaliveMaxSeconds: this.store.settings.keepaliveMaxSeconds,
      telegramChatId: this.store.settings.telegramChatId,
      telegramBotToken: this.store.settings.telegramBotToken,
      showdocPushUrl: this.store.settings.showdocPushUrl,
      serverchanSendKey: this.store.settings.serverchanSendKey,
      serverchanTags: this.store.settings.serverchanTags,
      oneMillion: true,
    };
  }

  private ensureDraft(force = false): void {
    const keyStillReady = this.store.keys.some(
      (key) => key.id === this.taskDraft?.keyId && key.authStatus === 'ready',
    );
    if (force || !this.taskDraft || !keyStillReady) this.taskDraft = this.makeDraft();
    this.syncDraftModel(false);
  }

  private syncDraftModel(force: boolean): void {
    const key = this.store.keys.find((item) => item.id === this.taskDraft.keyId);
    const models = key ? modelsForChannel(key.models, this.taskDraft.channel) : [];
    if (
      force ||
      (this.taskDraft.modelChoice !== '__custom__' && !models.includes(this.taskDraft.modelChoice))
    ) {
      this.taskDraft.modelChoice = preferredModel(models, this.taskDraft.channel);
    }
    if (this.taskDraft.channel === 'claude' && this.taskDraft.name.startsWith('GPT 队列探针')) {
      this.taskDraft.name = this.taskDraft.name.replace('GPT', 'Claude');
    }
    if (this.taskDraft.channel === 'gpt' && this.taskDraft.name.startsWith('Claude 队列探针')) {
      this.taskDraft.name = this.taskDraft.name.replace('Claude', 'GPT');
    }
  }

  private displayDraftModel(): string {
    let model = this.taskDraft.modelChoice === '__custom__'
      ? this.taskDraft.customModel || '自定义模型'
      : this.taskDraft.modelChoice;
    if (this.taskDraft.channel === 'claude' && this.taskDraft.oneMillion && !/\[1m\]$/i.test(model)) {
      model = `${model}[1m]`;
    }
    return model;
  }

  private navigate(page: Page, updateHash = true): void {
    if (!PAGE_META[page]) return;
    this.page = page;
    if (page === 'keys' || page === 'create') {
      void this.store.refreshKeys().catch(error => this.toast(error instanceof Error ? error.message : 'Key 列表读取失败', 'danger'));
    }
    if (updateHash && window.location.hash !== `#${page}`) {
      history.pushState(null, '', `#${page}`);
    }
    this.renderView();
    window.scrollTo({ top: 0, behavior: 'auto' });
    this.querySelector<HTMLElement>('#page-heading')?.focus({ preventScroll: true });
  }

  private openKeyDialog(): void {
    const dialog = this.querySelector<HTMLDialogElement>('#key-dialog');
    if (!dialog) return;
    this.lastFocused = document.activeElement as HTMLElement;
    dialog.showModal();
    window.setTimeout(() => dialog.querySelector<HTMLInputElement>('input')?.focus(), 0);
  }

  private closeKeyDialog(): void {
    const dialog = this.querySelector<HTMLDialogElement>('#key-dialog');
    if (dialog?.open) dialog.close();
    this.lastFocused?.focus();
  }

  private openKeyBaseUrlDialog(id: string): void {
    const key = this.store.keys.find((record) => record.id === id);
    const dialog = this.querySelector<HTMLDialogElement>('#key-base-url-dialog');
    const input = dialog?.querySelector<HTMLInputElement>('input[name="baseUrl"]');
    if (!key || !dialog || !input) return;
    this.editingKeyId = id;
    this.lastFocused = document.activeElement as HTMLElement;
    input.value = key.baseUrl;
    dialog.showModal();
    window.setTimeout(() => input.focus(), 0);
  }

  private closeKeyBaseUrlDialog(): void {
    const dialog = this.querySelector<HTMLDialogElement>('#key-base-url-dialog');
    if (dialog?.open) dialog.close();
    this.editingKeyId = undefined;
    this.lastFocused?.focus();
  }

  private openDrawer(id: string): void {
    this.lastFocused = document.activeElement as HTMLElement;
    this.openTaskId = id;
    this.store.python.setDetail(this.store.python.get(id) ? id : undefined);
    document.body.classList.add('drawer-open');
    this.renderDrawer(true);
  }

  private closeDrawer(): void {
    const id = this.openTaskId;
    const host = this.querySelector<HTMLElement>('#drawer-host');
    if (host) host.innerHTML = '';
    this.openTaskId = undefined;
    this.store.python.setDetail(undefined);
    document.body.classList.remove('drawer-open');
    if (this.lastFocused?.isConnected) this.lastFocused.focus();
    else if (id) this.querySelector<HTMLElement>(`[data-action="open-task"][data-task-id="${CSS.escape(id)}"]`)?.focus();
  }

  private async reauthenticate(id: string): Promise<void> {
    this.toast('正在刷新鉴权和模型列表…', 'neutral');
    const ok = await this.store.authenticateKey(id);
    this.toast(ok ? '模型缓存已刷新' : '鉴权失败', ok ? 'success' : 'danger');
  }

  private toast(message: string, tone: 'success' | 'danger' | 'neutral'): void {
    const region = this.querySelector<HTMLElement>('#toast-region');
    if (!region) return;
    const toast = document.createElement('div');
    toast.className = `toast toast-${tone}`;
    toast.innerHTML = `<span aria-hidden="true">${icon(tone === 'success' ? 'check' : tone === 'danger' ? 'warning' : 'info')}</span><p>${escapeHtml(message)}</p>`;
    region.append(toast);
    window.setTimeout(() => toast.classList.add('toast-leaving'), 2_600);
    window.setTimeout(() => toast.remove(), 3_000);
  }

  private updateHeaderCounts(): void {
    const count = this.store.engine.list().filter(isTaskActive).length;
    const node = this.querySelector<HTMLElement>('#header-running');
    if (node) node.textContent = String(count);
  }

  private updateCountdowns(): void {
    for (const node of this.querySelectorAll<HTMLElement>('[data-countdown-task]')) {
      const task = this.store.engine.get(node.dataset.countdownTask ?? '');
      const value = task?.nextAttemptAt ? countdownLabel(task.nextAttemptAt) : '—';
      if (node.textContent !== value) node.textContent = value;
    }
  }

  private updateNavState(): void {
    for (const item of this.querySelectorAll<HTMLElement>('[data-nav]')) {
      const active = item.dataset.nav === this.page;
      item.classList.toggle('active', active);
      if (active) item.setAttribute('aria-current', 'page');
      else item.removeAttribute('aria-current');
    }
  }

  private notificationDescription(task: Task): string {
    if (task.notificationPollingPaused) return `${task.notificationReadError ?? '连续 5 次读取失败'}；自动查询已停止，可手动刷新。投递由通知服务独立处理。`;
    if (!task.notificationConfigured) {
      return '填写 Telegram 凭据或 Server 酱 SendKey 可启用成功通知。';
    }
    switch (task.notificationStatus) {
      case 'queued':
        return '任务成功时即时进入通知队列。';
      case 'retrying':
        return '通知服务暂时失败，队列独立重试。';
      case 'sent':
        return '成功摘要已投递。';
      case 'dead':
        return task.notificationReadError || '通知投递失败。';
      default:
        return '通知已配置，模型成功后立即创建通知。';
    }
  }

  private pageMeta(): { eyebrow: string; title: string; subtitle: string } {
    const meta = PAGE_META[this.page];
    switch (this.page) {
      case 'overview':
        return { ...meta, subtitle: '查看任务、凭据和模型请求状态。' };
      case 'keys':
        return { ...meta, subtitle: '凭据统一保存在服务器，登录后可在不同设备使用。' };
      case 'create':
        return { ...meta, subtitle: '配置请求通道、模型、探针和重试参数。' };
      default:
        return meta;
    }
  }

  private emptyState(iconName: string, title: string, body: string, action: string): string {
    return `<div class="empty-state"><span class="empty-icon" aria-hidden="true">${icon(iconName)}</span><h2>${escapeHtml(title)}</h2><p>${escapeHtml(body)}</p>${action}</div>`;
  }

  private validPage(value: string): Page | undefined {
    return value in PAGE_META ? (value as Page) : undefined;
  }
}

function channelOption(
  channel: Channel,
  title: string,
  api: string,
  event: string,
  selected: Channel,
): string {
  return `
    <label class="channel-option ${selected === channel ? 'selected' : ''}">
      <input type="radio" name="channel" value="${channel}" ${selected === channel ? 'checked' : ''} />
      <span class="channel-logo ${channel === 'gpt' ? 'gpt-logo' : 'claude-logo'}">${channel === 'gpt' ? 'G' : 'C'}</span>
      <span class="channel-option-copy"><strong>${escapeHtml(title)}</strong><small>${escapeHtml(api)}</small><code>${escapeHtml(event)}</code></span>
      <span class="radio-check" aria-hidden="true">${icon('check')}</span>
    </label>
  `;
}

function numberField(
  name: string,
  label: string,
  value: number,
  min: number,
  max: number | undefined,
  step: number,
  unit: string,
): string {
  return `<label class="field"><span>${escapeHtml(label)}</span><span class="input-unit"><input type="number" name="${escapeHtml(name)}" value="${value}" min="${min}" ${max === undefined ? '' : `max="${max}"`} step="${step}" required /><i>${escapeHtml(unit)}</i></span><small>${max === undefined ? `至少 ${min.toLocaleString()}，不设最大值` : `范围 ${min.toLocaleString()}–${max.toLocaleString()}`}</small></label>`;
}

function preferredModel(models: string[], channel: Channel): string {
  if (!models.length) return '__custom__';
  if (channel === 'gpt') {
    return models.find((model) => model !== 'gpt-5-codex') ?? models[0]!;
  }
  return models.find((model) => /claude-(sonnet|opus)-4/.test(model)) ?? models[0]!;
}

export function icon(name: string): string {
  const paths: Record<string, string> = {
    spark: '<path d="m12 2 1.7 5.2L19 9l-5.3 1.8L12 16l-1.7-5.2L5 9l5.3-1.8L12 2Z"/><path d="m18.5 15 .8 2.2 2.2.8-2.2.8-.8 2.2-.8-2.2-2.2-.8 2.2-.8.8-2.2Z"/>',
    overview: '<rect x="3" y="3" width="7" height="7" rx="2"/><rect x="14" y="3" width="7" height="7" rx="2"/><rect x="3" y="14" width="7" height="7" rx="2"/><rect x="14" y="14" width="7" height="7" rx="2"/>',
    key: '<circle cx="8" cy="15" r="3"/><path d="m10.5 13.5 8-8M16 8l2 2M14 10l2 2"/>',
    plus: '<path d="M12 5v14M5 12h14"/>',
    tasks: '<rect x="4" y="5" width="16" height="15" rx="2"/><path d="M8 3v4M16 3v4M8 11h8M8 15h5"/>',
    settings: '<circle cx="12" cy="12" r="3"/><path d="M19.4 15a1.7 1.7 0 0 0 .3 1.9l.1.1-2.8 2.8-.1-.1a1.7 1.7 0 0 0-1.9-.3 1.7 1.7 0 0 0-1 1.6v.2h-4V21a1.7 1.7 0 0 0-1-1.6 1.7 1.7 0 0 0-1.9.3l-.1.1L4.2 17l.1-.1a1.7 1.7 0 0 0 .3-1.9A1.7 1.7 0 0 0 3 14H2.8v-4H3a1.7 1.7 0 0 0 1.6-1 1.7 1.7 0 0 0-.3-1.9L4.2 7 7 4.2l.1.1A1.7 1.7 0 0 0 9 4.6 1.7 1.7 0 0 0 10 3V2.8h4V3a1.7 1.7 0 0 0 1 1.6 1.7 1.7 0 0 0 1.9-.3l.1-.1L19.8 7l-.1.1a1.7 1.7 0 0 0-.3 1.9 1.7 1.7 0 0 0 1.6 1h.2v4H21a1.7 1.7 0 0 0-1.6 1Z"/>',
    shield: '<path d="M12 3 4.5 6v5.5c0 4.6 3.2 7.7 7.5 9.5 4.3-1.8 7.5-4.9 7.5-9.5V6L12 3Z"/><path d="m9 12 2 2 4-4"/>',
    bell: '<path d="M18 8a6 6 0 0 0-12 0c0 7-3 7-3 9h18c0-2-3-2-3-9M10 21h4"/>',
    close: '<path d="m6 6 12 12M18 6 6 18"/>',
    info: '<circle cx="12" cy="12" r="9"/><path d="M12 11v6M12 7h.01"/>',
    arrow: '<path d="M5 12h14M14 7l5 5-5 5"/>',
    chevron: '<path d="m9 5 7 7-7 7"/>',
    moon: '<path d="M20 15.5A8 8 0 1 1 8.5 4 6.5 6.5 0 0 0 20 15.5Z"/>',
    sun: '<circle cx="12" cy="12" r="4"/><path d="M12 2v2M12 20v2M4.9 4.9l1.4 1.4M17.7 17.7l1.4 1.4M2 12h2M20 12h2M4.9 19.1l1.4-1.4M17.7 6.3l1.4-1.4"/>',
    lock: '<rect x="5" y="10" width="14" height="11" rx="2"/><path d="M8 10V7a4 4 0 0 1 8 0v3"/>',
    logout: '<path d="M9 4H5a2 2 0 0 0-2 2v12a2 2 0 0 0 2 2h4M9 12h12m-5-5 5 5-5 5"/>',
    refresh: '<path d="M20 6v5h-5M4 18v-5h5"/><path d="M18.2 9A7 7 0 0 0 6.5 6.5L4 9M5.8 15A7 7 0 0 0 17.5 17.5L20 15"/>',
    trash: '<path d="M4 7h16M9 7V4h6v3M6 7l1 14h10l1-14M10 11v6M14 11v6"/>',
    spinner: '<path d="M21 12a9 9 0 1 1-6.2-8.6"/>',
    play: '<path d="m8 5 11 7-11 7V5Z"/>',
    pause: '<path d="M8 5v14M16 5v14"/>',
    more: '<circle cx="5" cy="12" r="1" fill="currentColor"/><circle cx="12" cy="12" r="1" fill="currentColor"/><circle cx="19" cy="12" r="1" fill="currentColor"/>',
    sliders: '<path d="M4 6h10M18 6h2M4 12h2M10 12h10M4 18h7M15 18h5"/><circle cx="16" cy="6" r="2"/><circle cx="8" cy="12" r="2"/><circle cx="13" cy="18" r="2"/>',
    send: '<path d="m22 2-7 20-4-9-9-4 20-7Z"/><path d="M22 2 11 13"/>',
    database: '<ellipse cx="12" cy="5" rx="8" ry="3"/><path d="M4 5v6c0 1.7 3.6 3 8 3s8-1.3 8-3V5M4 11v6c0 1.7 3.6 3 8 3s8-1.3 8-3v-6"/>',
    check: '<path d="m5 12 4 4L19 6"/>',
    warning: '<path d="M10.3 4.2 2.4 18a2 2 0 0 0 1.7 3h15.8a2 2 0 0 0 1.7-3L13.7 4.2a2 2 0 0 0-3.4 0Z"/><path d="M12 9v4M12 17h.01"/>',
    clock: '<circle cx="12" cy="12" r="9"/><path d="M12 7v5l3 2"/>',
    rocket: '<path d="M14 5c3-3 6-2 6-2s1 3-2 6l-5 5-4-4 5-5Z"/><path d="M9 10H5l-3 3 5 1M13 14v4l-3 3-1-5M5 18l-2 2"/>',
    pulse: '<path d="M3 12h4l2.5-6 4 12 2.5-6h5"/>',
    heartbeat: '<path d="M3 12h4l2-5 4 10 2-5h6"/><path d="M20.8 4.6a5.5 5.5 0 0 0-7.8 0L12 5.7l-1.1-1.1a5.5 5.5 0 0 0-7.8 7.8L12 21l8.8-8.6a5.5 5.5 0 0 0 0-7.8Z"/>',
    sunrise: '<path d="M4 18h16M6 14a6 6 0 0 1 12 0M12 3v4M4.2 7.2 7 10M19.8 7.2 17 10"/>',
  };
  return `<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round" focusable="false">${paths[name] ?? paths.info}</svg>`;
}

if (!customElements.get('ar-app')) {
  customElements.define('ar-app', AppShell);
}
