import { spawn } from 'node:child_process';
import { createInterface } from 'node:readline';
import { fileURLToPath } from 'node:url';

export class PythonBridge {
  pending = new Map();
  sequence = 0;
  closed = false;

  constructor(dbPath, notificationUrl, authorization = '') {
    this.child = spawn(process.env.ANYROUTER_PYTHON || (process.platform === 'win32' ? 'python' : 'python3'), [
      '-B', '-u', '-X', 'utf8', fileURLToPath(new URL('./python_scheduler.py', import.meta.url)),
      '--db', dbPath, '--notification-url', notificationUrl,
    ], { stdio: ['pipe', 'pipe', 'pipe'], windowsHide: true,
      env: { ...process.env, ANYROUTER_INTERNAL_AUTH: authorization } });
    this.child.stderr.resume();
    this.ready = new Promise((resolve, reject) => {
      const timer = setTimeout(() => reject(new Error('Python 启动超时')), 15_000);
      this.startup = { resolve: () => { clearTimeout(timer); resolve(); }, reject: (error) => { clearTimeout(timer); reject(error); } };
    });
    createInterface({ input: this.child.stdout }).on('line', line => {
      let message;
      try { message = JSON.parse(line); }
      catch { this.fail(new Error('Python 返回了无效数据')); return; }
      if (message.ready) { this.startup.resolve(); return; }
      const call = this.pending.get(message.id);
      if (!call) return;
      this.pending.delete(message.id); clearTimeout(call.timer);
      if (message.error) call.reject(new Error(message.error));
      else call.resolve(message.result);
    });
    this.child.on('error', () => this.fail(new Error('无法启动 Python；请安装 Python 3.11+，或设置 ANYROUTER_PYTHON')));
    this.exited = new Promise(resolve => this.child.once('close', code => {
      this.fail(new Error(`Python 调度进程已退出（${code ?? 'signal'}）`)); resolve();
    }));
    this.child.stdin.on('error', () => this.fail(new Error('Python 通信已断开')));
  }

  fail(error) {
    this.error = error;
    this.startup.reject(error);
    for (const call of this.pending.values()) { clearTimeout(call.timer); call.reject(error); }
    this.pending.clear();
  }

  async call(method, params = {}) {
    await this.ready;
    if (this.closed || this.error) throw this.error || new Error('Python 已停止');
    const id = ++this.sequence;
    return new Promise((resolve, reject) => {
      const timer = setTimeout(() => { this.pending.delete(id); reject(new Error('Python 操作超时')); }, 25_000);
      this.pending.set(id, { resolve, reject, timer });
      this.child.stdin.write(JSON.stringify({ id, method, params }) + '\n');
    });
  }

  async close() {
    if (this.closed) return;
    this.closed = true;
    this.child.stdin.end();
    const timer = setTimeout(() => this.child.kill(), 10_000);
    await this.exited;
    clearTimeout(timer);
  }
}
