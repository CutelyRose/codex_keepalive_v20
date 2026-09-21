import { DEFAULT_SETTINGS, STORAGE_KEYS } from './constants';
import { AnyRouterGateway } from '../live/anyrouter-gateway';
import { LiveTaskEngine } from '../live/live-task-engine';
import { PythonTaskEngine } from '../live/python-task-engine';
import { validateTaskConfig } from './task-config';
import { loadSettings, loadTasks, saveSettings, saveTasks } from './storage';
import type { AppSettings, KeyRecord, SchedulerChoice, StoreChangeDetail, Task, TaskConfig } from './types';
import { normalizeApiBaseUrl } from './api-url';
import { serverRequest } from './api-client';

export async function loadServerKeys(): Promise<KeyRecord[]> {
  const local = localStorage.getItem(STORAGE_KEYS.keys);
  if (local) {
    let keys: unknown;
    try { keys = JSON.parse(local); }
    catch { throw new Error('浏览器 Key 数据无效，未执行迁移'); }
    if (!Array.isArray(keys)) throw new Error('浏览器 Key 数据无效，未执行迁移');
    for (const key of keys) await serverRequest('/api/keys', 'POST', key);
    localStorage.removeItem(STORAGE_KEYS.keys);
  }
  return serverRequest<KeyRecord[]>('/api/keys');
}

export class AppStore extends EventTarget {
  keys: KeyRecord[];
  private keysRevision = 0;
  settings = loadSettings();
  private readonly browser: LiveTaskEngine;
  readonly python: PythonTaskEngine;
  authScheduler: SchedulerChoice = 'browser';
  readonly engine = {
    list: (): Task[] => [...this.browser.list(), ...this.python.list()].sort((a, b) => b.startedAt - a.startedAt),
    get: (id: string): Task | undefined => this.browser.get(id) ?? this.python.get(id),
    pause: (id: string) => this.action(id, 'pause'),
    resume: (id: string) => this.action(id, 'resume'),
    retryNow: (id: string) => this.action(id, 'retryNow'),
    cancel: (id: string) => this.action(id, 'cancel'),
    pauseMany: (ids: string[]) => this.many(ids, 'pause'),
    cancelMany: (ids: string[]) => this.many(ids, 'cancel'),
    removeMany: (ids: string[]) => this.many(ids, 'remove'),
    refreshNotification: (id: string) => this.browser.get(id) ? this.browser.refreshNotification(id) : this.python.refresh(),
  };
  private readonly gateway = new AnyRouterGateway();
  private browserUpdate?: ReturnType<typeof setTimeout>;
  private readonly flushBrowser = (): void => {
    clearTimeout(this.browserUpdate);
    this.browserUpdate = undefined;
    saveTasks(this.browser.list());
    this.emit('tasks');
  };
  private readonly onPageHide = (): void => {
    if (this.browserUpdate !== undefined) this.flushBrowser();
  };

  constructor(keys: KeyRecord[] = []) {
    super();
    this.keys = keys;
    this.browser = new LiveTaskEngine({
      getKey: (id) => this.keys.find((key) => key.id === id)?.value,
      onChange: (immediate) => {
        if (immediate) this.flushBrowser();
        else if (this.browserUpdate === undefined) this.browserUpdate = setTimeout(this.flushBrowser, 250);
      },
    });
    this.python = new PythonTaskEngine(() => this.emit('tasks'));
    this.browser.restore(loadTasks());
    globalThis.addEventListener?.('pagehide', this.onPageHide);
  }

  async addKey(alias: string, value: string, baseUrl: string): Promise<KeyRecord> {
    ++this.keysRevision;
    const record = await serverRequest<KeyRecord>('/api/keys', 'POST', { alias, value, baseUrl });
    ++this.keysRevision;
    this.keys = [record, ...this.keys];
    this.emit('keys');
    await this.authenticateKey(record.id);
    return this.keys.find(key => key.id === record.id) ?? record;
  }

  async refreshKeys(): Promise<void> {
    const revision = ++this.keysRevision;
    const keys = await serverRequest<KeyRecord[]>('/api/keys');
    if (revision !== this.keysRevision) return;
    if (JSON.stringify(keys) === JSON.stringify(this.keys)) return;
    for (const task of this.browser.list()) {
      if (!keys.some(key => key.id === task.config.keyId)) this.browser.cancel(task.id);
    }
    this.keys = keys;
    this.emit('keys');
  }

  async authenticateKey(id: string, scheduler: SchedulerChoice = this.authScheduler): Promise<boolean> {
    const record = this.keys.find((key) => key.id === id);
    if (!record) return false;
    record.authStatus = 'checking';
    record.error = undefined;
    ++this.keysRevision;
    this.emit('keys');
    const { value, baseUrl } = record;
    const results = await Promise.all([
      ...(scheduler !== 'python' ? [this.gateway.authenticate(value, baseUrl)] : []),
      ...(scheduler !== 'browser' ? [this.python.authenticate(id)] : []),
    ]);
    const result = results.find(item => !item.ok) ?? results[0];
    const current = this.keys.find((key) => key.id === id);
    if (!current || current.value !== value || current.baseUrl !== baseUrl) return false;
    try {
      const saved = await serverRequest<KeyRecord>(`/api/keys/${id}`, 'PATCH', { expectedBaseUrl: baseUrl, auth: result });
      Object.assign(current, saved);
      if (!saved.error) delete current.error;
    } catch (error) {
      current.authStatus = 'error';
      current.error = error instanceof Error ? error.message : '鉴权结果保存失败';
      throw error;
    } finally { ++this.keysRevision; this.emit('keys'); }
    return result.ok;
  }

  async deleteKey(id: string): Promise<boolean> {
    if (!this.keys.some((key) => key.id === id)) return false;
    ++this.keysRevision;
    await serverRequest(`/api/keys/${id}`, 'DELETE');
    ++this.keysRevision;
    for (const task of this.browser.list()) {
      if (task.config.keyId === id) this.browser.cancel(task.id);
    }
    this.keys = this.keys.filter((key) => key.id !== id);
    await this.python.refresh();
    this.emit('keys');
    return true;
  }

  async updateKeyBaseUrl(id: string, baseUrl: string): Promise<boolean> {
    const record = this.keys.find((key) => key.id === id);
    if (!record) return false;
    ++this.keysRevision;
    const saved = await serverRequest<KeyRecord>(`/api/keys/${id}`, 'PATCH', { baseUrl });
    ++this.keysRevision;
    Object.assign(record, saved, { error: undefined, lastAuthenticatedAt: undefined });
    return this.authenticateKey(id);
  }

  updateSettings(settings: AppSettings): void {
    saveSettings(settings);
    this.settings = { ...settings };
    this.emit('settings');
  }

  resetSettings(): void { this.updateSettings({ ...DEFAULT_SETTINGS }); }

  async createTask(config: TaskConfig, scheduler: SchedulerChoice): Promise<Task[]> {
    const key = this.keys.find((record) => record.id === config.keyId);
    if (!key || key.authStatus !== 'ready') throw new Error('任务对应的 Key 未通过鉴权');
    config = validateTaskConfig({ ...config, baseUrl: key.baseUrl });
    const tasks: Task[] = [];
    if (scheduler !== 'browser') tasks.push(await this.python.create(config));
    if (scheduler !== 'python') tasks.push(this.browser.create(config));
    return tasks;
  }

  async restartTask(id: string): Promise<Task> {
    const source = this.engine.get(id);
    if (!source) throw new Error('任务不存在');
    if (source.scheduler === 'python') return this.python.restart(id);
    return this.browser.create({ ...source.config, baseUrl: normalizeApiBaseUrl(source.config.baseUrl) });
  }

  dispose(): void {
    this.onPageHide();
    globalThis.removeEventListener?.('pagehide', this.onPageHide);
    this.browser.dispose(); this.python.dispose();
    this.keys = [];
  }

  private async action(id: string, action: 'pause' | 'resume' | 'retryNow' | 'cancel' | 'remove'): Promise<boolean> {
    if (this.browser.get(id)) return this.browser[action](id);
    return this.python.get(id) ? this.python.action(id, action) : false;
  }

  private async many(ids: string[], action: 'pause' | 'cancel' | 'remove'): Promise<number> {
    const results = await Promise.all(ids.map(id => this.action(id, action)));
    return results.filter(Boolean).length;
  }

  private emit(kind: StoreChangeDetail['kind']): void {
    this.dispatchEvent(new CustomEvent<StoreChangeDetail>('change', { detail: { kind } }));
  }
}
