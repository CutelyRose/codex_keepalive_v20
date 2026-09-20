import { createServer } from 'node:http';
import { DatabaseSync } from 'node:sqlite';
import { createHash, randomUUID, timingSafeEqual } from 'node:crypto';
import { mkdir, readFile } from 'node:fs/promises';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { parseArgs } from 'node:util';
import { PythonBridge } from './python-bridge.mjs';
import { buildTaskRequest, validateTaskConfig, apiEndpoint, notificationConfigured,
  validateNotificationSettings, serverchanEndpoint } from './dist/task-requests.mjs';

const ROOT = dirname(fileURLToPath(import.meta.url));
const RETRYABLE_HTTP = new Set([408, 409, 425, 429, 500, 502, 503, 504, 529]);

function problem(status, message) { return Object.assign(new Error(message), { status }); }

function textField(value, name, max) {
  if (typeof value !== 'string' || !value.trim() || value.length > max) {
    throw problem(400, `${name} 必须为 1–${max} 字符`);
  }
  return value.trim();
}

function numberField(value, name) {
  if (!Number.isSafeInteger(value) || value < 0) throw problem(400, `${name} 必须为非负整数`);
  return value;
}

function notificationPayload(input) {
  if (input.channel !== 'gpt' && input.channel !== 'claude') throw problem(400, '通道必须为 gpt 或 claude');
  const model = textField(input.model, '模型', 160);
  if (!/^[A-Za-z0-9._:/\[\]-]+$/.test(model)) throw problem(400, '模型 ID 格式无效');
  let config;
  try {
    config = validateNotificationSettings({ telegramChatId: input.chatId ?? '', telegramBotToken: input.botToken ?? '',
      serverchanSendKey: input.sendKey, serverchanTags: input.tags });
  } catch (error) { throw problem(400, error.message); }
  if (!notificationConfigured(config)) throw problem(400, '请填写 Telegram 或 Server 酱通知凭据');
  return {
    taskId: textField(input.taskId, '任务 ID', 200), taskName: textField(input.taskName, '任务名称', 100),
    channel: input.channel, model, keyTail: textField(input.keyTail, 'Key 尾号', 4),
    attempts: numberField(input.attempts, '尝试次数'), elapsedMs: numberField(input.elapsedMs, '耗时'),
    acceptedAt: numberField(input.acceptedAt, '成功时间'),
    ...(config.serverchanSendKey ? { sendKey: config.serverchanSendKey, tags: config.serverchanTags } :
      { chatId: config.telegramChatId, botToken: config.telegramBotToken }),
  };
}

function safeError(error, ...secrets) {
  let message = error instanceof Error ? error.message : String(error);
  for (const secret of secrets) if (secret) message = message.replaceAll(secret, '[redacted]');
  return message.replace(/sk-[A-Za-z0-9._-]+/g, '[redacted]')
    .replace(/\b(?:SCT[A-Za-z0-9_-]+|sctp\d+t[A-Za-z0-9_-]+)/g, '[redacted]')
    .replace(/\b\d{6,}:[A-Za-z0-9_-]+/g, '[redacted]').slice(0, 500);
}

function notificationView(record) {
  const { id, status, attempts, error, nextAttemptAt } = record;
  return { id, status, attempts, error, nextAttemptAt };
}

async function jsonBody(request) {
  if (!request.headers['content-type']?.toLowerCase().startsWith('application/json')) {
    throw problem(415, '请求必须使用 application/json');
  }
  const chunks = [];
  let length = 0;
  for await (const chunk of request) {
    length += chunk.length;
    if (length > 16 * 1024) throw problem(413, '请求体超过 16 KiB');
    chunks.push(chunk);
  }
  let value;
  try { value = JSON.parse(Buffer.concat(chunks).toString('utf8')); }
  catch { throw problem(400, '请求体不是有效 JSON'); }
  if (!value || typeof value !== 'object' || Array.isArray(value)) throw problem(400, '请求体必须为对象');
  return value;
}

function reply(response, status, value) {
  response.writeHead(status, { 'Content-Type': 'application/json; charset=utf-8', 'Cache-Control': 'no-store' });
  response.end(status === 204 ? undefined : JSON.stringify(value));
}

/** Browser and Python tasks share the site and notification queue. */
export async function startServer({
  port = 8787, dbPath = join(ROOT, 'data', 'notifications.sqlite'),
  host = '127.0.0.1', origin = '', password = '',
  now = Date.now, telegramBaseUrl = 'https://api.telegram.org', serverchanBaseUrl,
} = {}) {
  if (origin) {
    const url = new URL(origin);
    if (!['http:', 'https:'].includes(url.protocol) || url.username || url.password || url.pathname !== '/' || url.search || url.hash) {
      throw new Error('ANYROUTER_ORIGIN 必须是完整站点地址，例如 http://192.0.2.10:8787');
    }
    origin = url.origin;
  }
  if (!['127.0.0.1', '::1', 'localhost'].includes(host) && (!origin || !password)) {
    throw new Error('远程监听必须配置 ANYROUTER_ORIGIN 和 ANYROUTER_PASSWORD');
  }
  const authorization = password ? 'Basic ' + Buffer.from('admin:' + password).toString('base64') : '';
  const authDigest = createHash('sha256').update(authorization).digest();
  process.umask(0o077);
  await mkdir(dirname(resolve(dbPath)), { recursive: true, mode: 0o700 });
  const db = new DatabaseSync(dbPath);
  db.exec(`PRAGMA journal_mode=WAL;
    CREATE TABLE IF NOT EXISTS notifications (id TEXT PRIMARY KEY, task_id TEXT NOT NULL UNIQUE, payload TEXT NOT NULL);`);
  const notifications = new Map(db.prepare("SELECT id,payload FROM notifications WHERE json_extract(payload, '$.status') IN ('queued','retrying')")
    .all().map(r => [r.id, JSON.parse(r.payload)]));
  const noticeWrite = db.prepare('INSERT INTO notifications VALUES (?,?,?) ON CONFLICT(id) DO UPDATE SET payload=excluded.payload');
  const noticeByTask = db.prepare('SELECT payload FROM notifications WHERE task_id=?');
  const noticeById = db.prepare('SELECT payload FROM notifications WHERE id=?');
  const deliveries = new Map();
  let closing = false, timer, python;

  function findNotice(id) {
    if (!id) return;
    const row = noticeById.get(id);
    return row && JSON.parse(row.payload);
  }

  function pythonView(task) {
    const notice = findNotice(task.notificationId);
    if (notice) Object.assign(task, { notificationStatus: notice.status, notificationAttempts: notice.attempts,
      notificationNextAttemptAt: notice.nextAttemptAt, notificationReadError: notice.error });
    return task;
  }

  async function createPythonTask(input) {
    let config;
    try { config = validateTaskConfig(input.config); }
    catch (error) { throw problem(400, error.message); }
    const token = textField(input.token, 'API Key', 256);
    if (/[\r\n]/.test(token)) throw problem(400, 'API Key 不能包含换行');
    const sessionId = randomUUID(), at = now();
    const request = buildTaskRequest(config, token, { sessionId });
    return python.call('create', {
      task: { id: `python_${randomUUID()}`, scheduler: 'python', sessionId, config, status: 'running',
        attemptsMade: 0, probeAttempts: 0, successes: 0, healthy: false, startedAt: at, updatedAt: at,
        responseSummary: '', events: [], notificationStatus: 'not-requested', notificationAttempts: 0,
        notificationConfigured: notificationConfigured(config) },
      request: { url: request.url, headers: Object.fromEntries([...request.headers].map(([key, value]) =>
        [key.toLowerCase() === 'authorization' ? 'Authorization' : key, value])), body: request.body },
    });
  }

  function saveNotice(record) {
    record.updatedAt = now();
    noticeWrite.run(record.id, record.payload.taskId, JSON.stringify(record));
    if (['queued', 'retrying'].includes(record.status)) notifications.set(record.id, record);
    else notifications.delete(record.id);
  }

  function enqueue(payload) {
    const existing = noticeByTask.get(payload.taskId);
    if (existing) return JSON.parse(existing.payload);
    const record = {
      id: randomUUID(), status: 'queued', attempts: 0, createdAt: now(),
      nextAttemptAt: now(), payload,
    };
    saveNotice(record);
    return record;
  }

  async function deliver(record, controller) {
    record.attempts += 1;
    saveNotice(record);
    const payload = record.payload;
    try {
      const text = [
        `任务已接入：${payload.taskName}`, `${payload.channel.toUpperCase()} · ${payload.model}`,
        `Key 尾号：${payload.keyTail}`, `尝试：${payload.attempts} 次`,
        `耗时：${Math.round(payload.elapsedMs / 1000)} 秒`,
      ].join('\n');
      const serverchan = Boolean(payload.sendKey);
      const provider = serverchan ? 'Server 酱' : 'Telegram';
      const endpoint = serverchan ? (serverchanBaseUrl ? `${serverchanBaseUrl}/${payload.sendKey}.send` : serverchanEndpoint(payload.sendKey))
        : `${telegramBaseUrl}/bot${payload.botToken}/sendMessage`;
      const response = await fetch(endpoint, {
        method: 'POST', headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(serverchan ? { title: [...`任务已接入：${payload.taskName}`].slice(0, 32).join(''),
          desp: text.split('\n').join('\n\n'), tags: payload.tags } : { chat_id: payload.chatId, text }), redirect: 'error',
        signal: AbortSignal.any([controller.signal, AbortSignal.timeout(20_000)]),
      });
      let result;
      try { result = await response.json(); }
      catch { throw Object.assign(new Error(`${provider} HTTP ${response.status} 返回无效 JSON`), { retryable: RETRYABLE_HTTP.has(response.status) }); }
      const accepted = serverchan ? result.code === 0 && (result.data?.errno === undefined || result.data.errno === 0) : result.ok === true;
      if (!response.ok || !accepted) {
        const status = serverchan ? response.status : result.error_code ?? response.status;
        throw Object.assign(new Error((serverchan ? result.message || result.data?.error : result.description) || `${provider} HTTP ${status}`), {
          retryable: RETRYABLE_HTTP.has(status), retryAfter: serverchan ? Number(response.headers.get('Retry-After')) : result.parameters?.retry_after,
        });
      }
      if (closing || controller.signal.aborted) return;
      record.status = 'sent';
      record.error = undefined;
    } catch (error) {
      if (closing || controller.signal.aborted) return;
      record.error = safeError(error, payload.botToken, payload.chatId, payload.sendKey);
      record.status = error.retryable !== false && record.attempts < 5 ? 'retrying' : 'dead';
      const delay = Number.isFinite(error.retryAfter) && error.retryAfter > 0
        ? error.retryAfter * 1000 : 2000 * 2 ** (record.attempts - 1);
      record.nextAttemptAt = now() + delay;
    }
    if (record.status === 'sent' || record.status === 'dead') {
      delete record.payload.botToken;
      delete record.payload.chatId;
      delete record.payload.sendKey;
      delete record.nextAttemptAt;
    }
    saveNotice(record);
  }

  function tick() {
    if (closing) return Promise.resolve();
    const work = [];
    for (const record of notifications.values()) {
      if (deliveries.size >= 4) break;
      if (!['queued', 'retrying'].includes(record.status) || record.nextAttemptAt > now() || deliveries.has(record.id)) continue;
      const delivery = { controller: new AbortController() };
      deliveries.set(record.id, delivery);
      delivery.promise = deliver(record, delivery.controller).catch(() => {
        console.error('Failed to persist a notification; check the local database.');
      }).finally(() => deliveries.delete(record.id));
      work.push(delivery.promise);
    }
    return Promise.allSettled(work);
  }

  async function handle(request, response) {
    const boundPort = server.address().port;
    const localHosts = [`127.0.0.1:${boundPort}`, `localhost:${boundPort}`, `[::1]:${boundPort}`, `${localHost}:${boundPort}`];
    const allowedHosts = [...localHosts, ...(origin ? [new URL(origin).host] : [])];
    if (!allowedHosts.includes(request.headers.host)) throw problem(403, '访问域名不在允许范围');
    if (request.headers.origin && ![...localHosts.map(host => `http://${host}`), origin].includes(request.headers.origin)) {
      throw problem(403, '拒绝跨站请求');
    }
    if (request.headers['sec-fetch-site'] === 'cross-site') throw problem(403, '拒绝跨站请求');
    const url = new URL(request.url, 'http://localhost');
    const path = url.pathname;
    if (path === '/api/health' && request.method === 'GET') {
      const healthy = !closing && Boolean(python) && await python.call('health').catch(() => false);
      reply(response, healthy ? 200 : 503, { ok: healthy, modelRequests: ['browser', 'python'], python: healthy }); return;
    }
    if (authorization && !timingSafeEqual(authDigest, createHash('sha256').update(request.headers.authorization ?? '').digest())) {
      response.setHeader('WWW-Authenticate', 'Basic realm="AnyRouter", charset="UTF-8"');
      throw problem(401, '请输入管理密码');
    }
    if (path === '/api/python/models' && request.method === 'POST') {
      const input = await jsonBody(request);
      const token = textField(input.token, 'API Key', 256);
      if (/[\r\n]/.test(token)) throw problem(400, 'API Key 不能包含换行');
      let url;
      try { url = apiEndpoint(input.baseUrl, 'models'); }
      catch (error) { throw problem(400, error.message); }
      reply(response, 200, await python.call('models', { url, token })); return;
    }
    if (path === '/api/python/tasks') {
      if (request.method === 'GET') { reply(response, 200, (await python.call('list', { detail: url.searchParams.get('detail') })).map(pythonView)); return; }
      if (request.method === 'POST') { reply(response, 201, pythonView(await createPythonTask(await jsonBody(request)))); return; }
    }
    const pythonTask = path.match(/^\/api\/python\/tasks\/(python_[a-f0-9-]{36})(?:\/(pause|resume|retryNow|cancel|restart))?$/);
    if (pythonTask) {
      const [, id, action] = pythonTask;
      if (request.method === 'DELETE' && !action) { reply(response, 200, await python.call('remove', { id })); return; }
      if (request.method === 'POST' && action) {
        if (action === 'restart') {
          const source = await python.call('restart', { id });
          reply(response, 201, await createPythonTask({ config: source.task.config, token: source.request.headers.Authorization.slice(7) }));
        } else reply(response, 200, await python.call(action, { id }));
        return;
      }
    }
    if (path === '/api/notifications' && request.method === 'POST') {
      const record = enqueue(notificationPayload(await jsonBody(request)));
      reply(response, 202, notificationView(record)); void tick(); return;
    }
    const notificationId = path.match(/^\/api\/notifications\/([a-f0-9-]{36})$/)?.[1];
    if (notificationId && request.method === 'GET') {
      const record = findNotice(notificationId);
      if (!record) throw problem(404, '通知不存在');
      reply(response, 200, notificationView(record)); return;
    }
    if (path.startsWith('/api/')) throw problem(404, '接口不存在');
    if (request.method !== 'GET' && request.method !== 'HEAD') throw problem(405, '不支持该请求方法');
    if (path === '/favicon.ico') { reply(response, 204); return; }
    const file = path === '/' || path === '/index.html' ? 'index.html' :
      /^\/assets\/[A-Za-z0-9_.-]+\.(?:js|css)$/.test(path) ? path.slice(1) : undefined;
    if (!file) throw problem(404, '页面不存在');
    let content;
    try { content = await readFile(join(ROOT, 'dist', file)); }
    catch (error) { if (error.code === 'ENOENT') throw problem(404, '页面尚未构建，请运行 npm run build'); throw error; }
    response.writeHead(200, {
      'Content-Type': file.endsWith('.js') ? 'text/javascript; charset=utf-8' : file.endsWith('.css') ? 'text/css; charset=utf-8' : 'text/html; charset=utf-8',
      'Content-Length': content.length, 'Cache-Control': 'no-cache', 'X-Content-Type-Options': 'nosniff',
      'Content-Security-Policy': "default-src 'self'; script-src 'self' 'unsafe-inline'; style-src 'self' 'unsafe-inline'; connect-src 'self' https: http:; img-src 'self' data:; frame-ancestors 'none'; base-uri 'none'",
    });
    response.end(request.method === 'HEAD' ? undefined : content);
  }

  const server = createServer((request, response) => {
    void handle(request, response).catch(error => {
      if (response.destroyed || response.writableEnded) return;
      if (response.headersSent) { response.destroy(); return; }
      reply(response, error.status ?? 500, { error: error.status ? error.message : '本地服务操作失败，请检查 Python 进程和数据目录' });
    });
  });
  try {
    await new Promise((accept, reject) => {
      server.once('error', reject); server.listen(port, host, accept);
    });
  } catch (error) { db.close(); throw error; }
  const boundAddress = server.address().address;
  const localHost = boundAddress === '0.0.0.0' ? '127.0.0.1' : boundAddress === '::' ? '[::1]' :
    boundAddress.includes(':') ? `[${boundAddress}]` : boundAddress;
  python = new PythonBridge(join(dirname(resolve(dbPath)), 'python-tasks.sqlite'), `http://${localHost}:${server.address().port}/api/notifications`, authorization);
  try { await python.ready; }
  catch (error) { await python.close(); server.closeAllConnections(); await new Promise(resolveClose => server.close(resolveClose)); db.close(); throw error; }
  timer = setInterval(() => void tick(), 1000);
  void tick();
  return {
    server, url: `http://${localHost}:${server.address().port}`, tick,
    async close() {
      if (closing) return;
      closing = true; clearInterval(timer);
      await python.close();
      const work = [...deliveries.values()];
      for (const active of work) active.controller.abort();
      server.closeAllConnections();
      await Promise.allSettled(work.map(active => active.promise));
      await new Promise(resolveClose => server.close(resolveClose));
      db.close();
    },
  };
}

if (process.argv[1] && import.meta.url === pathToFileURL(resolve(process.argv[1])).href) {
  const { values } = parseArgs({ options: { port: { type: 'string', default: process.env.ANYROUTER_PORT || '8787' } } });
  const port = Number(values.port);
  if (!Number.isInteger(port) || port < 1 || port > 65535) throw new Error('Port must be 1–65535');
  try {
    const app = await startServer({ port, host: process.env.ANYROUTER_HOST || '127.0.0.1',
      origin: process.env.ANYROUTER_ORIGIN, password: process.env.ANYROUTER_PASSWORD,
      dbPath: join(process.env.ANYROUTER_DATA_DIR || join(ROOT, 'data'), 'notifications.sqlite') });
    console.log(`AnyRouter console: ${process.env.ANYROUTER_ORIGIN || app.url}`);
    console.log('Browser and Python schedulers can run together. Press Ctrl+C to stop the service.');
    for (const signal of ['SIGINT', 'SIGTERM']) process.once(signal, () => void app.close());
  } catch (error) {
    console.error(error.message); process.exitCode = 1;
  }
}
