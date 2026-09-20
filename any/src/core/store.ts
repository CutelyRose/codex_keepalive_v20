import { DEFAULT_SETTINGS } from './constants';
import { AnyRouterGateway } from '../live/anyrouter-gateway';
import { LiveTaskEngine } from '../live/live-task-engine';
import { PythonTaskEngine } from '../live/python-task-engine';
import { validateTaskConfig } from './task-config';
import { loadKeys, loadSettings, loadTasks, saveKeys, saveSettings, saveTasks } from './storage';
import type { AppSettings, KeyRecord, SchedulerChoice, StoreChangeDetail, Task, TaskConfig } from './types';
import { makeId } from './utils';
import { normalizeApiBaseUrl } from './api-url';

export class AppStore extends EventTarget {
  keys = loadKeys();
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

  constructor() {
    super();
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
    const record: KeyRecord = {
      id: makeId('key'), alias: alias.trim(), value: value.trim(),
      baseUrl: normalizeApiBaseUrl(baseUrl), authStatus: 'checking', models: [],
    };
    if (!record.alias || !record.value) throw new Error('别名和 API Key 不能为空');
    this.keys = [record, ...this.keys];
    this.persistKeys();
    await this.authenticateKey(record.id);
    return record;
  }

  async authenticateKey(id: string, scheduler: SchedulerChoice = this.authScheduler): Promise<boolean> {
    const record = this.keys.find((key) => key.id === id);
    if (!record) return false;
    record.authStatus = 'checking';
    record.error = undefined;
    this.persistKeys();
    const { value, baseUrl } = record;
    const results = await Promise.all([
      ...(scheduler !== 'python' ? [this.gateway.authenticate(value, baseUrl)] : []),
      ...(scheduler !== 'browser' ? [this.python.authenticate(value, baseUrl)] : []),
    ]);
    const result = results.find(item => !item.ok) ?? results[0];
    const current = this.keys.find((key) => key.id === id);
    if (!current || current.value !== value || current.baseUrl !== baseUrl) return false;
    current.authStatus = result.ok ? 'ready' : 'error';
    current.models = result.models;
    current.error = result.error;
    if (result.ok) current.lastAuthenticatedAt = Date.now();
    this.persistKeys();
    return result.ok;
  }

  async deleteKey(id: string): Promise<boolean> {
    if (!this.keys.some((key) => key.id === id)) return false;
    for (const task of this.engine.list()) {
      if (task.config.keyId === id) await this.engine.cancel(task.id);
    }
    this.keys = this.keys.filter((key) => key.id !== id);
    this.persistKeys();
    return true;
  }

  async updateKeyBaseUrl(id: string, baseUrl: string): Promise<boolean> {
    const record = this.keys.find((key) => key.id === id);
    if (!record) return false;
    record.baseUrl = normalizeApiBaseUrl(baseUrl);
    record.models = [];
    record.lastAuthenticatedAt = undefined;
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
    if (scheduler !== 'browser') tasks.push(await this.python.create(config, key.value));
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
  }

  private async action(id: string, action: 'pause' | 'resume' | 'retryNow' | 'cancel' | 'remove'): Promise<boolean> {
    if (this.browser.get(id)) return this.browser[action](id);
    return this.python.get(id) ? this.python.action(id, action) : false;
  }

  private async many(ids: string[], action: 'pause' | 'cancel' | 'remove'): Promise<number> {
    const results = await Promise.all(ids.map(id => this.action(id, action)));
    return results.filter(Boolean).length;
  }

  private persistKeys(): void {
    saveKeys(this.keys);
    this.emit('keys');
  }

  private emit(kind: StoreChangeDetail['kind']): void {
    this.dispatchEvent(new CustomEvent<StoreChangeDetail>('change', { detail: { kind } }));
  }
}
