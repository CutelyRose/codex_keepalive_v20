import type { AuthResult, Task, TaskConfig } from '../core/types';
import { serverRequest } from '../core/api-client';

export class PythonTaskEngine {
  private tasks = new Map<string, Task>();
  private timer?: ReturnType<typeof setTimeout>;
  private disposed = false;
  private revision = 0;
  private detailId?: string;
  error = '';
  connected = false;

  constructor(private readonly onChange: () => void) { void this.poll(); }

  list(): Task[] { return [...this.tasks.values()]; }
  get(id: string): Task | undefined { return this.tasks.get(id); }

  setDetail(id?: string): void {
    if (id === this.detailId) return;
    this.detailId = id;
    void this.refresh();
  }

  private async request<T>(path: string, method = 'GET', body?: unknown): Promise<T> {
    return serverRequest<T>(`/api/python/${path}`, method, body);
  }

  async authenticate(keyId: string): Promise<AuthResult> {
    try { return await this.request<AuthResult>('models', 'POST', { keyId }); }
    catch (error) { return { ok: false, models: [], error: error instanceof Error ? error.message : 'Python 鉴权失败' }; }
  }

  async create(config: TaskConfig): Promise<Task> {
    ++this.revision;
    const task = await this.request<Task>('tasks', 'POST', { config });
    ++this.revision;
    this.tasks.set(task.id, task); this.onChange();
    return task;
  }

  async restart(id: string): Promise<Task> {
    ++this.revision;
    const task = await this.request<Task>(`tasks/${id}/restart`, 'POST');
    ++this.revision;
    this.tasks.set(task.id, task); this.onChange();
    return task;
  }

  async action(id: string, action: 'pause' | 'resume' | 'retryNow' | 'cancel' | 'remove'): Promise<boolean> {
    ++this.revision;
    const result = await this.request<boolean>(`tasks/${id}${action === 'remove' ? '' : '/' + action}`, action === 'remove' ? 'DELETE' : 'POST');
    if (action === 'remove') this.tasks.delete(id);
    await this.refresh();
    return result;
  }

  async refresh(): Promise<void> {
    const revision = ++this.revision;
    try {
      const tasks = await this.request<Task[]>(`tasks${this.detailId ? '?detail=' + encodeURIComponent(this.detailId) : ''}`);
      if (this.disposed || revision !== this.revision) return;
      if (this.connected && !this.error && JSON.stringify(tasks) === JSON.stringify(this.list())) return;
      this.tasks = new Map(tasks.map(task => [task.id, task]));
      this.error = '';
      this.connected = true;
    } catch (error) {
      if (this.disposed || revision !== this.revision) return;
      this.error = error instanceof Error ? error.message : 'Python 状态读取失败';
      this.connected = false;
    }
    this.onChange();
  }

  private async poll(): Promise<void> {
    await this.refresh();
    if (!this.disposed) this.timer = setTimeout(() => void this.poll(), 1500);
  }

  dispose(): void {
    this.disposed = true;
    ++this.revision;
    clearTimeout(this.timer);
  }
}
