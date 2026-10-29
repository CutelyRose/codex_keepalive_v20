import { createServer } from 'node:http';
import { DatabaseSync } from 'node:sqlite';
import { createHash, randomBytes, randomUUID, timingSafeEqual } from 'node:crypto';
import { mkdir, readFile } from 'node:fs/promises';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { parseArgs } from 'node:util';
import { ServerTaskEngine, AnyRouterGateway, NotificationReadError, validatePoolTaskConfig, normalizeApiBaseUrl, notificationConfigured,
  validateNotificationSettings, serverchanEndpoint } from './dist/server-core.mjs';

const ROOT = dirname(fileURLToPath(import.meta.url));
const RETRYABLE_HTTP = new Set([408, 409, 425, 429, 500, 502, 503, 504, 529]);
const SESSION_SECONDS = 7 * 24 * 60 * 60;
/** Server tasks are saved in batches; a crash loses at most this much progress. */
const TASK_SAVE_MS = 1000;

function problem(status, message) { return Object.assign(new Error(message), { status }); }
function digest(value) { return createHash('sha256').update(value).digest(); }

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

function keyRecord(input) {
  const id = input.id === undefined ? `key_${randomUUID()}` : textField(input.id, 'Key ID', 160);
  if (!/^[A-Za-z0-9_-]+$/.test(id)) throw problem(400, 'Key ID 格式无效');
  const value = textField(input.value, 'API Key', 256);
  if (value.length < 8 || /\s/.test(value)) throw problem(400, 'API Key 格式无效');
  let baseUrl;
  try { baseUrl = normalizeApiBaseUrl(textField(input.baseUrl, 'API Base URL', 500)); }
  catch (error) { throw problem(400, error.message); }
  const authStatus = input.authStatus ?? 'checking', models = input.models ?? [];
  if (!['checking', 'ready', 'error'].includes(authStatus) || !Array.isArray(models) ||
      models.length > 2000 || models.some(model => typeof model !== 'string' || !model || model.length > 160)) {
    throw problem(400, 'Key 鉴权状态或模型列表无效');
  }
  if (input.error !== undefined && typeof input.error !== 'string') throw problem(400, 'Key 错误信息无效');
  return { id, alias: textField(input.alias, '别名', 40), value, baseUrl, authStatus, models: [...new Set(models)].sort(),
    ...(input.lastAuthenticatedAt === undefined ? {} : { lastAuthenticatedAt: numberField(input.lastAuthenticatedAt, '鉴权时间') }),
    ...(input.error ? { error: safeError(input.error, value) } : {}) };
}

function notificationPayload(input) {
  if (input.channel !== 'gpt' && input.channel !== 'claude') throw problem(400, '通道必须为 gpt 或 claude');
  const model = textField(input.model, '模型', 160);
  if (!/^[A-Za-z0-9._:/\[\]-]+$/.test(model)) throw problem(400, '模型 ID 格式无效');
  let config;
  try {
    config = validateNotificationSettings({ telegramChatId: input.chatId ?? '', telegramBotToken: input.botToken ?? '',
      serverchanSendKey: input.sendKey, serverchanTags: input.tags, showdocPushUrl: input.showdocUrl });
  } catch (error) { throw problem(400, error.message); }
  if (!notificationConfigured(config)) throw problem(400, '请填写所选通知方式的推送参数');
  return {
    taskId: textField(input.taskId, '任务 ID', 200), taskName: textField(input.taskName, '任务名称', 100),
    channel: input.channel, model, keyTail: textField(input.keyTail, 'Key 尾号', 4),
    attempts: numberField(input.attempts, '尝试次数'), elapsedMs: numberField(input.elapsedMs, '耗时'),
    acceptedAt: numberField(input.acceptedAt, '成功时间'),
    ...(config.showdocPushUrl ? { showdocUrl: config.showdocPushUrl } :
      config.serverchanSendKey ? { sendKey: config.serverchanSendKey, tags: config.serverchanTags } :
      { chatId: config.telegramChatId, botToken: config.telegramBotToken }),
  };
}

function safeError(error, ...secrets) {
  let message = error instanceof Error ? error.message : String(error);
  for (const secret of secrets) if (secret) message = message.replaceAll(secret, '[redacted]');
  return message.replace(/sk-[A-Za-z0-9._-]+/g, '[redacted]')
    .replace(/https:\/\/push\.showdoc\.com\.cn\/server\/api\/push\/[A-Za-z0-9_-]+/g, '[redacted]')
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

/** Browser and server tasks share the site and notification queue. */
export async function startServer({
  port = 8787, dbPath = join(ROOT, 'data', 'notifications.sqlite'),
  host = '127.0.0.1', origin = '', password = '',
  now = Date.now, telegramBaseUrl = 'https://api.telegram.org', serverchanBaseUrl, showdocBaseUrl,
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
  const passwordDigest = digest(password);
  const sessions = new Map(), loginFailures = new Map();
  process.umask(0o077);
  await mkdir(dirname(resolve(dbPath)), { recursive: true, mode: 0o700 });
  const db = new DatabaseSync(dbPath);
  db.exec(`PRAGMA journal_mode=WAL;
    CREATE TABLE IF NOT EXISTS notifications (id TEXT PRIMARY KEY, task_id TEXT NOT NULL UNIQUE, payload TEXT NOT NULL);
    CREATE TABLE IF NOT EXISTS api_keys (id TEXT PRIMARY KEY, payload TEXT NOT NULL);
    CREATE TABLE IF NOT EXISTS tasks (id TEXT PRIMARY KEY, payload TEXT NOT NULL);`);
  const notifications = new Map(db.prepare("SELECT id,payload FROM notifications WHERE json_extract(payload, '$.status') IN ('queued','retrying')")
    .all().map(r => [r.id, JSON.parse(r.payload)]));
  const noticeWrite = db.prepare('INSERT INTO notifications VALUES (?,?,?) ON CONFLICT(id) DO UPDATE SET payload=excluded.payload');
  const noticeByTask = db.prepare('SELECT payload FROM notifications WHERE task_id=?');
  const noticeById = db.prepare('SELECT payload FROM notifications WHERE id=?');
  const keyById = db.prepare('SELECT payload FROM api_keys WHERE id=?');
  const taskWrite = db.prepare('INSERT INTO tasks VALUES (?,?) ON CONFLICT(id) DO UPDATE SET payload=excluded.payload');
  const taskDelete = db.prepare('DELETE FROM tasks WHERE id=?');
  const savedTasks = new Map(db.prepare('SELECT id,payload FROM tasks').all().map(row => [row.id, row.payload]));
  const deliveries = new Map();
  const gateway = new AnyRouterGateway();
  let closing = false, timer, saveTimer, engine;

  function findKey(id) {
    const row = keyById.get(textField(id, 'Key ID', 160));
    if (!row) throw problem(404, 'Key 不存在，请刷新列表');
    return JSON.parse(row.payload);
  }

  /** Writes only tasks whose state changed since the last save, in one transaction. */
  function saveTasks() {
    clearTimeout(saveTimer); saveTimer = undefined;
    db.exec('BEGIN');
    try {
      for (const task of engine.list()) {
        const payload = JSON.stringify(task);
        if (savedTasks.get(task.id) !== payload) { taskWrite.run(task.id, payload); savedTasks.set(task.id, payload); }
      }
      for (const id of savedTasks.keys()) if (!engine.get(id)) { taskDelete.run(id); savedTasks.delete(id); }
      db.exec('COMMIT');
    } catch (error) { db.exec('ROLLBACK'); throw error; }
  }

  function sessionCookie(response, token, maxAge) {
    response.setHeader('Set-Cookie', `anyrouter_session=${token}; Path=/; HttpOnly; SameSite=Strict; Max-Age=${maxAge}${origin.startsWith('https:') ? '; Secure' : ''}`);
  }

  function findNotice(id) {
    if (!id) return;
    const row = noticeById.get(id);
    return row && JSON.parse(row.payload);
  }

  /** Public task state: notification credentials stay on the server; history only for the opened task. */
  function taskView(task, details = true) {
    return { ...task, config: { ...task.config, telegramBotToken: '', serverchanSendKey: '', showdocPushUrl: '' },
      events: details ? task.events : [], responseSummary: details ? task.responseSummary : '' };
  }

  function createTask(input) {
    const key = findKey(input?.keyId);
    try { return engine.create({ ...input, baseUrl: key.baseUrl }); }
    catch (error) { throw problem(400, error.message); }
  }

  function createPool(input) {
    let config;
    try { config = validatePoolTaskConfig(input); }
    catch (error) { throw problem(400, error.message); }
    const keys = config.keyIds.map(findKey);
    if (new Set(keys.map(key => key.value)).size !== keys.length) throw problem(400, 'Key 池不能包含相同凭据');
    if (keys.some(key => key.authStatus !== 'ready')) throw problem(400, '池成员须先通过鉴权');
    try {
      return engine.createPool(config, keys.map(key => ({ keyId: key.id, alias: key.alias, keyTail: key.value.slice(-4), baseUrl: key.baseUrl })));
    } catch (error) { throw problem(400, error.message); }
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
      const showdoc = Boolean(payload.showdocUrl), serverchan = Boolean(payload.sendKey);
      const provider = showdoc ? 'ShowDoc' : serverchan ? 'Server 酱' : 'Telegram';
      const endpoint = showdoc ? (showdocBaseUrl ? `${showdocBaseUrl}${new URL(payload.showdocUrl).pathname}` : payload.showdocUrl)
        : serverchan ? (serverchanBaseUrl ? `${serverchanBaseUrl}/${payload.sendKey}.send` : serverchanEndpoint(payload.sendKey))
        : `${telegramBaseUrl}/bot${payload.botToken}/sendMessage`;
      const response = await fetch(endpoint, {
        method: 'POST', headers: { 'Content-Type': showdoc ? 'application/x-www-form-urlencoded;charset=UTF-8' : 'application/json' },
        body: showdoc ? new URLSearchParams({ title: `任务已接入：${payload.taskName}`, content: text }).toString()
          : JSON.stringify(serverchan ? { title: [...`任务已接入：${payload.taskName}`].slice(0, 32).join(''),
            desp: text.split('\n').join('\n\n'), tags: payload.tags } : { chat_id: payload.chatId, text }), redirect: 'error',
        signal: AbortSignal.any([controller.signal, AbortSignal.timeout(20_000)]),
      });
      let result;
      try { result = await response.json(); }
      catch { throw Object.assign(new Error(`${provider} HTTP ${response.status} 返回无效 JSON`), { retryable: RETRYABLE_HTTP.has(response.status) }); }
      const accepted = showdoc ? result.error_code === 0
        : serverchan ? result.code === 0 && (result.data?.errno === undefined || result.data.errno === 0) : result.ok === true;
      if (!response.ok || !accepted) {
        const status = showdoc || serverchan ? response.status : result.error_code ?? response.status;
        throw Object.assign(new Error((showdoc ? result.error_message : serverchan ? result.message || result.data?.error : result.description) || `${provider} HTTP ${status}`), {
          retryable: RETRYABLE_HTTP.has(status), retryAfter: showdoc || serverchan ? Number(response.headers.get('Retry-After')) : result.parameters?.retry_after,
        });
      }
      if (closing || controller.signal.aborted) return;
      record.status = 'sent';
      record.error = undefined;
    } catch (error) {
      if (closing || controller.signal.aborted) return;
      record.error = safeError(error, payload.botToken, payload.chatId, payload.sendKey, payload.showdocUrl, payload.showdocUrl?.split('/').at(-1));
      record.status = error.retryable !== false && record.attempts < 5 ? 'retrying' : 'dead';
      const delay = Number.isFinite(error.retryAfter) && error.retryAfter > 0
        ? error.retryAfter * 1000 : 2000 * 2 ** (record.attempts - 1);
      record.nextAttemptAt = now() + delay;
    }
    if (record.status === 'sent' || record.status === 'dead') {
      delete record.payload.botToken;
      delete record.payload.chatId;
      delete record.payload.sendKey;
      delete record.payload.showdocUrl;
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
      reply(response, closing ? 503 : 200, { ok: !closing }); return;
    }
    const sessionToken = /(?:^|;\s*)anyrouter_session=([A-Za-z0-9_-]{43})(?:;|$)/.exec(request.headers.cookie ?? '')?.[1] ?? '';
    const sessionId = digest(sessionToken).toString('hex');
    const authenticated = !password || (sessions.get(sessionId) ?? 0) > now();
    if (path === '/api/auth/session' && request.method === 'GET') {
      reply(response, 200, { authenticated, passwordRequired: Boolean(password) }); return;
    }
    if (path === '/api/auth/login' && request.method === 'POST') {
      const input = await jsonBody(request), at = now(), address = request.socket.remoteAddress;
      for (const [id, expires] of sessions) if (expires <= at) sessions.delete(id);
      for (const [ip, failure] of loginFailures) if (failure.until <= at) loginFailures.delete(ip);
      const failure = loginFailures.get(address);
      if (failure?.count >= 5) {
        response.setHeader('Retry-After', String(Math.ceil((failure.until - at) / 1000)));
        throw problem(429, '尝试次数过多，请一分钟后重试');
      }
      if (typeof input.password !== 'string' || input.password.length > 1024) throw problem(400, '管理密码格式无效');
      if (password && !timingSafeEqual(passwordDigest, digest(input.password))) {
        loginFailures.set(address, { count: (failure?.count ?? 0) + 1, until: failure?.until ?? at + 60_000 });
        throw problem(401, '管理密码不正确');
      }
      loginFailures.delete(address);
      sessions.delete(sessionId);
      const token = randomBytes(32).toString('base64url');
      sessions.set(digest(token).toString('hex'), at + SESSION_SECONDS * 1000);
      sessionCookie(response, token, SESSION_SECONDS);
      reply(response, 200, { authenticated: true }); return;
    }
    if (path === '/api/auth/logout' && request.method === 'POST') {
      sessions.delete(sessionId);
      sessionCookie(response, '', 0);
      reply(response, 200, { authenticated: false }); return;
    }
    if (path.startsWith('/api/') && !authenticated) throw problem(401, '请先登录');
    if (path === '/api/keys') {
      if (request.method === 'GET') {
        reply(response, 200, db.prepare('SELECT payload FROM api_keys ORDER BY rowid DESC').all().map(row => JSON.parse(row.payload))); return;
      }
      if (request.method === 'POST') {
        const record = keyRecord(await jsonBody(request));
        const existing = db.prepare('SELECT payload FROM api_keys WHERE id=?').get(record.id);
        if (existing) {
          const saved = JSON.parse(existing.payload);
          if (saved.value !== record.value) throw problem(409, 'Key ID 已被其他凭据使用');
          reply(response, 200, saved); return;
        }
        db.prepare('INSERT INTO api_keys VALUES (?,?)').run(record.id, JSON.stringify(record));
        reply(response, 201, record); return;
      }
    }
    const keyPath = path.match(/^\/api\/keys\/([A-Za-z0-9_-]+)$/);
    if (keyPath) {
      const record = findKey(keyPath[1]);
      if (request.method === 'PATCH') {
        const input = await jsonBody(request);
        let next;
        if (input.baseUrl !== undefined && input.auth === undefined) {
          next = keyRecord({ ...record, baseUrl: input.baseUrl, authStatus: 'checking', models: [], error: undefined, lastAuthenticatedAt: undefined });
        } else {
          if (input.baseUrl !== undefined || !input.auth || typeof input.auth.ok !== 'boolean') throw problem(400, 'Key 更新参数无效');
          if (input.expectedBaseUrl !== record.baseUrl) throw problem(409, 'API 地址已变化，请刷新后重新鉴权');
          next = keyRecord({ ...record, authStatus: input.auth.ok ? 'ready' : 'error', models: input.auth.models,
            error: input.auth.ok ? undefined : input.auth.error, lastAuthenticatedAt: input.auth.ok ? now() : record.lastAuthenticatedAt });
        }
        db.prepare('UPDATE api_keys SET payload=? WHERE id=?').run(JSON.stringify(next), record.id);
        reply(response, 200, next); return;
      }
      if (request.method === 'DELETE') {
        for (const task of engine.list()) {
          if (task.config.keyId === record.id || task.config.keyIds?.includes(record.id)) engine.cancel(task.id);
        }
        db.prepare('DELETE FROM api_keys WHERE id=?').run(record.id);
        reply(response, 200, true); return;
      }
    }
    if (path === '/api/models' && request.method === 'POST') {
      const key = findKey((await jsonBody(request)).keyId);
      reply(response, 200, await gateway.authenticate(key.value, key.baseUrl)); return;
    }
    if (path === '/api/tasks') {
      if (request.method === 'GET') {
        const detail = url.searchParams.get('detail');
        reply(response, 200, engine.list().map(task => taskView(task, task.id === detail))); return;
      }
      if (request.method === 'POST') {
        const { config } = await jsonBody(request);
        reply(response, 201, taskView(config && 'keyIds' in config ? createPool(config) : createTask(config))); return;
      }
    }
    const taskPath = path.match(/^\/api\/tasks\/(task_[a-f0-9-]{36})(?:\/(pause|resume|retryNow|cancel|restart))?$/);
    if (taskPath) {
      const [, id, action] = taskPath;
      const source = engine.get(id);
      if (!source) throw problem(404, '服务端任务不存在');
      if (request.method === 'DELETE' && !action) { reply(response, 200, engine.remove(id)); return; }
      if (request.method === 'POST' && action === 'restart') {
        reply(response, 201, taskView('keyIds' in source.config ? createPool(source.config) : createTask(source.config))); return;
      }
      if (request.method === 'POST' && action) { reply(response, 200, engine[action](id)); return; }
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

  engine = new ServerTaskEngine({
    now,
    getKey: id => { const row = keyById.get(id); return row && JSON.parse(row.payload).value; },
    notificationClient: {
      async enqueue(payload) { const record = enqueue(notificationPayload(payload)); void tick(); return notificationView(record); },
      async get(id) {
        const record = findNotice(id);
        if (!record) throw new NotificationReadError('通知回执不存在', 404);
        return notificationView(record);
      },
    },
    onChange: () => {
      saveTimer ??= setTimeout(() => {
        try { saveTasks(); } catch { console.error('Failed to save server tasks; check the local database.'); }
      }, TASK_SAVE_MS);
    },
  });
  engine.restoreServer([...savedTasks.values()].map(payload => JSON.parse(payload)));

  const server = createServer((request, response) => {
    void handle(request, response).catch(error => {
      if (response.destroyed || response.writableEnded) return;
      if (response.headersSent) { response.destroy(); return; }
      reply(response, error.status ?? 500, { error: error.status ? error.message : '本地服务操作失败，请检查数据目录' });
    });
  });
  try {
    await new Promise((accept, reject) => {
      server.once('error', reject); server.listen(port, host, accept);
    });
  } catch (error) { engine.dispose(); clearTimeout(saveTimer); db.close(); throw error; }
  const boundAddress = server.address().address;
  const localHost = boundAddress === '0.0.0.0' ? '127.0.0.1' : boundAddress === '::' ? '[::1]' :
    boundAddress.includes(':') ? `[${boundAddress}]` : boundAddress;
  timer = setInterval(() => void tick(), 1000);
  void tick();
  return {
    server, url: `http://${localHost}:${server.address().port}`, tick,
    async close() {
      if (closing) return;
      closing = true; clearInterval(timer);
      engine.dispose();
      saveTasks();
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
    console.log('Browser and server schedulers can run together. Press Ctrl+C to stop the service.');
    for (const signal of ['SIGINT', 'SIGTERM']) process.once(signal, () => void app.close());
  } catch (error) {
    console.error(error.message); process.exitCode = 1;
  }
}
