import test, { after } from 'node:test';
import assert from 'node:assert/strict';
import { createServer, get as httpGet } from 'node:http';
import { spawn } from 'node:child_process';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join, dirname, resolve, basename } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { setTimeout as delay } from 'node:timers/promises';
import { DatabaseSync } from 'node:sqlite';
import { build } from 'esbuild';
import { startServer } from '../server.mjs';
import { serverchanEndpoint, validateTaskConfig } from '../dist/server-core.mjs';

const directory = await mkdtemp(join(tmpdir(), 'anyrouter-check-'));
after(async () => {
  assert.equal(dirname(resolve(directory)), resolve(tmpdir()));
  assert.ok(basename(directory).startsWith('anyrouter-check-'));
  await rm(directory, { recursive: true, force: true });
});
const bundlePath = join(directory, 'browser.mjs');
await build({
  stdin: { contents: [
    "export * from './src/live/live-task-engine.ts';",
    "export * from './src/live/anyrouter-gateway.ts';",
    "export * from './src/live/sse-parser.ts';",
    "export * from './src/live/request-errors.ts';",
    "export * from './src/core/storage.ts';",
    "export * from './src/core/store.ts';",
    "export { createClaudeRequestIdentity } from './src/live/claude-contract.ts';",
    "export { createCodexRequestIdentity } from './src/live/codex-contract.ts';",
  ].join('\n'), resolveDir: fileURLToPath(new URL('../', import.meta.url)) },
  outfile: bundlePath, bundle: true, platform: 'node', format: 'esm', logLevel: 'silent',
});
const { LiveTaskEngine, AnyRouterGateway, SseParser, readSseStream,
  retryableModelError, retryAfterMilliseconds, saveTasks, loadTasks, saveSettings, loadSettings, loadServerKeys, AppStore, createClaudeRequestIdentity, createCodexRequestIdentity } = await import(pathToFileURL(bundlePath));

async function until(check, message) {
  const deadline = Date.now() + 5000;
  while (Date.now() < deadline) {
    const result = await check();
    if (result) return result;
    await delay(20);
  }
  assert.fail(message);
}

async function loginCookie(app, password) {
  const response = await fetch(app.url + '/api/auth/login', { method: 'POST',
    headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ password }) });
  assert.equal(response.status, 200);
  const cookie = response.headers.get('set-cookie');
  assert.match(cookie, /HttpOnly; SameSite=Strict/);
  return cookie.split(';')[0];
}

async function saveKey(app, record, cookie = '') {
  const response = await fetch(app.url + '/api/keys', { method: 'POST',
    headers: { 'Content-Type': 'application/json', Cookie: cookie }, body: JSON.stringify(record) });
  assert.equal(response.status, 201);
  return response.json();
}

test('SSE byte boundaries, cancellation and retry classification', async () => {
  const parser = new SseParser();
  assert.deepEqual(parser.push(': ping\r\nevent: message_sta'), []);
  assert.deepEqual(parser.push('rt\r\ndata: {"type":"message_start"}\r\n\r\n'), [
    { event: 'message_start', data: '{"type":"message_start"}' },
  ]);
  const bytes = new TextEncoder().encode('data: 测试\n\n'), events = [];
  await readSseStream(new ReadableStream({ start(controller) {
    for (const byte of bytes) controller.enqueue(new Uint8Array([byte]));
    controller.close();
  } }), event => { events.push(event.data); });
  assert.deepEqual(events, ['测试']);
  let cancelled = false;
  const controller = new AbortController();
  const reading = readSseStream(new ReadableStream({ cancel() { cancelled = true; } }), () => {}, { signal: controller.signal });
  controller.abort();
  await assert.rejects(reading, { name: 'AbortError' });
  assert.equal(cancelled, true);
  assert.equal(retryableModelError('HTTP 503 busy'), true);
  assert.equal(retryableModelError('HTTP 429 insufficient_quota'), false);
  assert.equal(retryableModelError('HTTP 401 invalid_api_key'), false);
  assert.equal(retryAfterMilliseconds('2'), 2000);
  assert.equal(retryAfterMilliseconds('Fri, 18 Sep 2026 00:00:02 GMT', Date.parse('2026-09-18T00:00:00Z')), 2000);
});

test('large probe and concurrency settings persist without fixed caps', () => {
  const data = new Map();
  const storage = { getItem: key => data.get(key) ?? null, setItem: (key, value) => data.set(key, value) };
  const settings = { ...loadSettings(storage), attempts: 20001, concurrency: 128,
    showdocPushUrl: 'https://push.showdoc.com.cn/server/api/push/showdoc-test-only' };
  saveSettings(settings, storage);
  assert.deepEqual(loadSettings(storage), settings);
  const config = { ...settings, name: 'Large limits', channel: 'gpt', keyId: 'local',
    baseUrl: 'http://127.0.0.1:1', model: 'gpt-test', prompt: 'Reply OK', maxAttempts: settings.attempts, oneMillion: false };
  assert.equal(validateTaskConfig(config).maxAttempts, 20001);
  assert.equal(validateTaskConfig(config).concurrency, 128);
  for (const field of ['maxAttempts', 'concurrency']) {
    for (const value of [0, -1, 1.5, Infinity, NaN, Number.MAX_SAFE_INTEGER + 1]) {
      assert.throws(() => validateTaskConfig({ ...config, [field]: value }));
    }
  }
});

test('browser engine sends direct GPT/Claude traffic, runs configured concurrency and cancels losing streams', async t => {
  t.mock.method(crypto, 'randomUUID', () => { throw new Error('randomUUID is unavailable over plain HTTP'); });
  const uuidPattern = /^[a-f0-9]{8}-[a-f0-9]{4}-4[a-f0-9]{3}-[89ab][a-f0-9]{3}-[a-f0-9]{12}$/;
  assert.match(createClaudeRequestIdentity().sessionId, uuidPattern);
  assert.match(createCodexRequestIdentity().sessionId.replace(/^session_/, ''), uuidPattern);
  const requests = [], counts = new Map(), engines = [];
  let closedStreams = 0;
  let finishParallel;
  const upstream = createServer(async (req, res) => {
    const chunks = [];
    for await (const chunk of req) chunks.push(chunk);
    const body = chunks.length ? JSON.parse(Buffer.concat(chunks)) : undefined;
    requests.push({ path: req.url, headers: req.headers, body });
    assert.equal(req.headers.authorization, 'Bearer sk-frontend-test-only');
    if (req.url === '/v1/models') {
      res.setHeader('Content-Type', 'application/json');
      res.end('{"data":[{"id":"gpt-busy"},{"id":"claude-local"}]}'); return;
    }
    const count = (counts.get(body.model) ?? 0) + 1;
    counts.set(body.model, count);
    if (body.model === 'gpt-fatal' || body.model === 'gpt-busy' && count === 1) {
      res.writeHead(body.model === 'gpt-fatal' ? 401 : 503, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({ error: { message: body.model === 'gpt-fatal' ? 'invalid_api_key' : 'busy' } })); return;
    }
    res.writeHead(200, { 'Content-Type': 'text/event-stream' });
    if (body.model === 'gpt-hold' || body.model === 'gpt-parallel' && count > 1) {
      res.write('event: ping\ndata: {"type":"ping","source":"sibling"}\n\n');
      res.on('close', () => { closedStreams += 1; });
      if (body.model === 'gpt-parallel' && count === 20) finishParallel();
      return;
    }
    const send = () => {
      const event = req.url.startsWith('/v1/messages') ? 'message_start' : 'response.created';
      res.write(`event: ${event}\ndata: {"type":"${event}"}\n\n`);
      if (body.model === 'gpt-interrupted') setTimeout(() => res.destroy(), 40);
      else res.end('data: [DONE]\n\n');
    };
    if (body.model === 'gpt-parallel') finishParallel = send;
    else send();
  });
  await new Promise(resolveListen => upstream.listen(0, '127.0.0.1', resolveListen));
  t.after(async () => {
    engines.forEach(engine => engine.dispose());
    upstream.closeAllConnections();
    await new Promise(resolveClose => upstream.close(resolveClose));
  });
  const baseUrl = `http://127.0.0.1:${upstream.address().port}`;
  const auth = await new AnyRouterGateway().authenticate('sk-frontend-test-only', baseUrl);
  assert.equal(auth.ok, true);
  assert.deepEqual(auth.models, ['claude-local', 'gpt-busy']);
  const engine = new LiveTaskEngine({ getKey: () => 'sk-frontend-test-only' });
  engines.push(engine);
  const config = { name: 'Browser test', channel: 'gpt', keyId: 'local', baseUrl, model: 'gpt-busy', prompt: 'Reply OK',
    maxAttempts: 2, concurrency: 1, intervalSeconds: .5, timeoutSeconds: 30, keepalive: false,
    keepaliveMinSeconds: .5, keepaliveMaxSeconds: .5, telegramChatId: '', telegramBotToken: '', oneMillion: false };
  const task = engine.create(config);
  assert.match(task.sessionId, uuidPattern);
  await until(() => task.status === 'accepted-completed', 'busy request did not retry and complete');
  assert.equal(task.attemptsMade, 2);
  const gpt = requests.find(request => request.path === '/v1/responses');
  assert.equal(gpt.body.stream, true);
  assert.equal(gpt.body.store, false);
  assert.equal(gpt.headers.originator, 'Codex CLI');
  assert.equal(gpt.headers['session-id'], gpt.body.client_metadata.session_id);
  assert.equal(gpt.body.prompt_cache_key, gpt.headers['thread-id']);

  const claude = engine.create({ ...config, channel: 'claude', model: 'claude-local[1m]', oneMillion: true });
  await until(() => claude.status === 'accepted-completed', 'Claude did not receive message_start');
  const message = requests.find(request => request.path === '/v1/messages?beta=true');
  assert.equal(message.body.model, 'claude-local');
  assert.equal(message.headers['x-api-key'], 'sk-frontend-test-only');
  assert.equal(message.headers['anthropic-dangerous-direct-browser-access'], 'true');
  assert.match(message.headers['anthropic-beta'], /context-1m/);
  assert.equal(message.body.tools.length, 26);

  const parallel = engine.create({ ...config, model: 'gpt-parallel', concurrency: 24, maxAttempts: 20 });
  await until(() => parallel.status === 'accepted-completed' && closedStreams === 19, 'configured parallel requests did not finish and cancel losing streams');
  assert.equal(parallel.attemptsMade, 20);
  assert.equal(parallel.events.filter(event => event.title === '已成功挤入').length, 1);
  assert.equal(parallel.responseSummary.includes('sibling'), false);
  const fatal = engine.create({ ...config, model: 'gpt-fatal', maxAttempts: 5 });
  await until(() => fatal.stopReason === 'permanent-error', 'authentication error did not stop retries');
  assert.equal(fatal.attemptsMade, 1);
  const interrupted = engine.create({ ...config, model: 'gpt-interrupted' });
  await until(() => interrupted.status === 'accepted-stream-interrupted', 'accepted stream interruption was lost');
  await delay(600);
  assert.equal(interrupted.attemptsMade, 1);
  assert.equal(counts.get('gpt-parallel'), 20);
  assert.equal(counts.get('gpt-fatal'), 1);

  const held = engine.create({ ...config, model: 'gpt-hold' });
  await until(() => counts.has('gpt-hold'), 'hold request did not start');
  assert.equal(engine.pause(held.id), true);
  await until(() => closedStreams === 20, 'pause did not abort direct stream');
  assert.equal(engine.resume(held.id), true);
  await until(() => counts.get('gpt-hold') === 2, 'resume did not start a new request');
  const data = new Map();
  const storage = { getItem: key => data.get(key) ?? null, setItem: (key, value) => data.set(key, value) };
  saveTasks(engine.list(), storage);
  const restored = new LiveTaskEngine({ getKey: () => 'sk-frontend-test-only' });
  engines.push(restored); restored.restore(loadTasks(storage));
  assert.equal(restored.get(held.id).status, 'paused');
  assert.equal(restored.get(parallel.id).config.concurrency, 24);
  assert.equal(restored.get(parallel.id).sessionId, parallel.sessionId);
  assert.equal(restored.get(parallel.id).successes, 1);
  assert.equal(restored.get(parallel.id).probeAttempts, 0);
  assert.equal(engine.remove(held.id), true);
  await until(() => closedStreams === 21, 'deleting a task did not abort its stream');
  assert.equal(engine.get(held.id), undefined);
});

test('local server hosts both schedulers and durable notification delivery', async t => {
  const messages = [];
  const telegram = createServer(async (req, res) => {
    const chunks = [];
    for await (const chunk of req) chunks.push(chunk);
    const body = JSON.parse(Buffer.concat(chunks));
    messages.push(body);
    const count = messages.filter(item => item.chat_id === body.chat_id).length;
    res.setHeader('Content-Type', 'application/json');
    if (body.chat_id === '-1002') {
      res.writeHead(400); res.end('{"ok":false,"error_code":400,"description":"invalid chat for 123456:local_test"}');
    } else if (count === 1) {
      res.writeHead(429); res.end('{"ok":false,"error_code":429,"parameters":{"retry_after":1}}');
    } else res.end('{"ok":true}');
  });
  await new Promise(resolveListen => telegram.listen(0, '127.0.0.1', resolveListen));
  let clock = Date.now();
  const options = { port: 0, dbPath: join(directory, 'notifications.sqlite'), now: () => clock,
    telegramBaseUrl: `http://127.0.0.1:${telegram.address().port}` };
  let app = await startServer(options);
  t.after(async () => {
    await app.close(); telegram.closeAllConnections();
    await new Promise(resolveClose => telegram.close(resolveClose));
  });
  const post = (path, body, headers = {}) => fetch(app.url + path, {
    method: 'POST', headers: { 'Content-Type': 'application/json', ...headers }, body: JSON.stringify(body),
  });
  const receipt = async id => (await fetch(`${app.url}/api/notifications/${id}`)).json();
  const payload = { taskId: 'test-notification', taskName: 'Test', channel: 'gpt', model: 'gpt-test',
    keyTail: '0001', attempts: 2, elapsedMs: 1500, acceptedAt: clock, chatId: '-1001', botToken: '123456:local_test' };
  const home = await fetch(app.url);
  assert.equal(home.status, 200);
  assert.match(home.headers.get('content-security-policy'), /connect-src 'self' https: http:/);
  assert.deepEqual(await (await fetch(app.url + '/api/health')).json(), { ok: true });
  for (const path of ['/api/proxy', '/api/keepalive/task', '/api/scheduled-keepalive/task']) {
    assert.equal((await post(path, {})).status, 404);
  }
  assert.equal((await post('/api/notifications', payload, { Origin: 'https://untrusted.example' })).status, 403);
  assert.equal((await post('/api/notifications', { ...payload, botToken: 'bad' })).status, 400);
  for (const path of ['/server.mjs', '/data/notifications.sqlite']) assert.equal((await fetch(app.url + path)).status, 404);
  const result = await post('/api/notifications', payload);
  assert.equal(result.status, 202);
  const first = await result.json();
  const retrying = await until(async () => { const value = await receipt(first.id); return value.status === 'retrying' && value; }, 'notification did not retry');
  assert.equal(retrying.nextAttemptAt, clock + 1000);
  assert.equal((await (await post('/api/notifications', payload)).json()).id, first.id);
  clock += 1000; await app.tick();
  assert.equal((await receipt(first.id)).status, 'sent');
  assert.equal(messages.filter(message => message.chat_id === '-1001').length, 2);
  const failed = await (await post('/api/notifications', { ...payload, taskId: 'bad-chat', chatId: '-1002' })).json();
  const dead = await until(async () => { const value = await receipt(failed.id); return value.status === 'dead' && value; }, 'permanent Telegram error did not stop');
  assert.equal(dead.error.includes(payload.botToken), false);
  const pending = await (await post('/api/notifications', { ...payload, taskId: 'restart', chatId: '-1003' })).json();
  await until(async () => (await receipt(pending.id)).status === 'retrying', 'restart fixture did not reach retry');
  await app.close(); clock += 1000; app = await startServer(options);
  await until(async () => (await receipt(pending.id)).status === 'sent', 'queued notification did not survive restart');
  const db = new DatabaseSync(options.dbPath, { readOnly: true });
  try {
    for (const row of db.prepare('SELECT payload FROM notifications').all()) {
      const record = JSON.parse(row.payload);
      assert.equal(record.payload.botToken, undefined);
      assert.equal(record.payload.chatId, undefined);
    }
    assert.equal(db.prepare('SELECT count(*) AS count FROM tasks').get().count, 0);
  } finally { db.close(); }
});

test('browser and server run together, recover keepalive and preserve backend ownership', async t => {
  const seen = new Map(), requests = [];
  let closedLosers = 0;
  let finishParallel;
  const upstream = createServer(async (req, res) => {
    assert.equal(req.headers.authorization, 'Bearer sk-dual-test-only');
    res.setHeader('Content-Type', 'application/json');
    if (req.url === '/v1/models') { res.end('{"data":[{"id":"gpt-browser"},{"id":"gpt-server"},{"id":"claude-server"}]}'); return; }
    const chunks = [];
    for await (const chunk of req) chunks.push(chunk);
    const body = JSON.parse(Buffer.concat(chunks));
    const count = (seen.get(body.model) ?? 0) + 1;
    seen.set(body.model, count);
    requests.push({ headers: req.headers, body });
    if (body.model === 'gpt-fatal' || count === 2 && ['gpt-browser', 'gpt-server'].includes(body.model)) {
      res.writeHead(body.model === 'gpt-fatal' ? 401 : 503);
      res.end('{"error":{"message":"' + (body.model === 'gpt-fatal' ? 'invalid_api_key' : 'busy') + '"}}'); return;
    }
    res.setHeader('Content-Type', 'text/event-stream');
    if (body.model === 'gpt-fixed-length') {
      res.end('event: response.created\ndata: {"type":"response.created"}\n\ndata: [DONE]\n\n');
      return;
    }
    if (body.model === 'gpt-parallel' && count > 1 || body.model === 'gpt-held') {
      res.write('event: ping\ndata: {"type":"ping"}\n\n');
      res.on('close', () => { closedLosers++; });
      if (body.model === 'gpt-parallel' && count === 20) finishParallel();
      return;
    }
    const finish = () => {
      const type = body.model.startsWith('claude') ? 'message_start' : 'response.created';
      res.write(`event: ${type}\ndata: {"type":"${type}"}\n\n`);
      res.end('data: [DONE]\n\n');
    };
    if (body.model === 'gpt-parallel') finishParallel = finish;
    else finish();
  });
  await new Promise(resolveListen => upstream.listen(0, '127.0.0.1', resolveListen));
  const baseUrl = `http://127.0.0.1:${upstream.address().port}`;
  const options = { port: 0, dbPath: join(directory, 'dual', 'notifications.sqlite') };
  let app = await startServer(options);
  const browser = new LiveTaskEngine({ getKey: () => 'sk-dual-test-only' });
  t.after(async () => {
    browser.dispose(); await app.close(); upstream.closeAllConnections();
    await new Promise(resolveClose => upstream.close(resolveClose));
  });
  const call = async (path = '', method = 'GET', body) => {
    const response = await fetch(`${app.url}/api/${path}`, {
      method, ...(body ? { headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body) } : {}),
    });
    const result = await response.json();
    assert.equal(response.ok, true, JSON.stringify(result));
    return result;
  };
  const config = { name: 'Dual keepalive', channel: 'gpt', keyId: 'dual', baseUrl, model: 'gpt-server', prompt: 'Reply OK',
    maxAttempts: 2, concurrency: 1, intervalSeconds: .5, timeoutSeconds: 30, keepalive: true,
    keepaliveMinSeconds: .5, keepaliveMaxSeconds: .5, telegramChatId: '', telegramBotToken: '', oneMillion: false };
  await saveKey(app, { id: 'dual', alias: 'Dual', value: 'sk-dual-test-only', baseUrl });
  const auth = await call('models', 'POST', { keyId: 'dual' });
  assert.equal(auth.ok, true);
  const local = browser.create({ ...config, model: 'gpt-browser' });
  const remote = await call('tasks', 'POST', { config });
  assert.equal(remote.scheduler, 'server');
  assert.equal(JSON.stringify(remote).includes('sk-dual-test-only'), false);
  await until(() => local.successes >= 2 && seen.get('gpt-server') >= 3, 'both schedulers failed to recover keepalive');
  let rows = await call('tasks');
  const recovered = await until(async () => (await call('tasks')).find(task => task.id === remote.id && task.successes >= 2), 'server recovery not recorded');
  assert.equal(recovered.probeAttempts, 0);
  assert.deepEqual(recovered.events, []);
  const detailed = (await call(`tasks?detail=${remote.id}`)).find(task => task.id === remote.id);
  assert.equal(detailed.events.some(event => event.type === 'request.failed'), true);
  assert.equal(local.events.some(event => event.type === 'request.failed'), true);
  for (const model of ['gpt-browser', 'gpt-server']) {
    const modelRequests = requests.filter(item => item.body.model === model);
    assert.equal(new Set(modelRequests.map(item => item.headers['session-id'])).size, 1, 'keepalive changed sessions');
    for (const item of modelRequests) assert.equal(item.headers['session-id'], item.body.client_metadata.session_id);
  }
  assert.notEqual(local.sessionId, remote.sessionId);
  assert.equal(browser.pause(local.id), true);
  const localCount = seen.get('gpt-browser'), serverCount = seen.get('gpt-server');
  browser.dispose();
  await until(() => seen.get('gpt-server') > serverCount, 'server stopped when browser was disposed');
  assert.equal(seen.get('gpt-browser'), localCount);
  await call(`tasks/${remote.id}/pause`, 'POST');
  await delay(100);
  const pausedCount = seen.get('gpt-server');
  await delay(650);
  assert.equal(seen.get('gpt-server'), pausedCount, 'paused server task kept sending');
  await app.close(); app = await startServer(options);
  rows = await call('tasks');
  assert.equal(rows.find(task => task.id === remote.id).status, 'paused');
  await delay(600);
  assert.equal(seen.get('gpt-server'), pausedCount, 'restart resumed a paused task');
  await call(`tasks/${remote.id}/resume`, 'POST');
  await until(() => seen.get('gpt-server') > pausedCount, 'server task did not resume');
  await app.close();
  const stoppedCount = seen.get('gpt-server');
  app = await startServer(options);
  await until(() => seen.get('gpt-server') > stoppedCount, 'active task did not recover after service restart');
  await call(`tasks/${remote.id}/cancel`, 'POST');

  const parallel = await call('tasks', 'POST', { config: { ...config, model: 'gpt-parallel', keepalive: false, concurrency: 24, maxAttempts: 20 } });
  const completed = await until(async () => (await call('tasks')).find(task => task.id === parallel.id && task.status === 'accepted-completed'), 'server parallel round did not finish');
  assert.equal(completed.attemptsMade, 20);
  assert.equal(completed.successes, 1);
  assert.equal(closedLosers, 19);
  const claude = await call('tasks', 'POST', { config: { ...config, channel: 'claude', model: 'claude-server[1m]', keepalive: false } });
  await until(async () => (await call('tasks')).some(task => task.id === claude.id && task.status === 'accepted-completed'), 'server Claude did not complete');
  const claudeRequest = requests.find(item => item.body.model === 'claude-server');
  assert.equal(claudeRequest.body.tools.length, 26);
  assert.match(claudeRequest.headers['anthropic-beta'], /context-1m/);
  const fixedLength = await call('tasks', 'POST', { config: { ...config, model: 'gpt-fixed-length', keepalive: false } });
  await until(async () => (await call('tasks')).some(task => task.id === fixedLength.id && task.status === 'accepted-completed'), 'server fixed-length SSE did not complete');
  const fatal = await call('tasks', 'POST', { config: { ...config, model: 'gpt-fatal' } });
  await until(async () => (await call('tasks')).some(task => task.id === fatal.id && task.stopReason === 'permanent-error'), 'server did not stop a permanent failure');
  assert.equal(seen.get('gpt-fatal'), 1);
  const held = await call('tasks', 'POST', { config: { ...config, model: 'gpt-held' } });
  await until(() => seen.has('gpt-held'), 'server held stream did not start');
  await call(`tasks/${held.id}`, 'DELETE');
  await until(() => closedLosers === 20, 'server delete did not stop the held stream');
  assert.equal((await call('tasks')).some(task => task.id === held.id), false);
  const invalid = await fetch(`${app.url}/api/tasks`, { method: 'POST', headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ config: { ...config, keepaliveMinSeconds: 20, keepaliveMaxSeconds: 10 } }) });
  assert.equal(invalid.status, 400);
  await app.close();
  const db = new DatabaseSync(options.dbPath, { readOnly: true });
  try {
    const rows = db.prepare('SELECT payload FROM tasks').all();
    assert.ok(rows.length > 0);
    for (const row of rows) assert.equal(row.payload.includes('sk-dual-test-only'), false, 'task records stored the API key');
  } finally { db.close(); }
});

test('server recognizes success before EOF and uses the environment proxy for authentication and tasks', async t => {
  const streams = new Map(), requests = [];
  const target = 'http://anyrouter-proxy.invalid';
  const proxy = createServer(async (req, res) => {
    assert.equal(req.headers.authorization, 'Bearer sk-proxy-test-only');
    requests.push(new URL(req.url, `http://${req.headers.host}`).href);
    if (new URL(req.url, target).pathname === '/v1/models') {
      res.setHeader('Content-Type', 'application/json');
      res.end('{"data":[{"id":"gpt-proxy"}]}'); return;
    }
    const chunks = [];
    for await (const chunk of req) chunks.push(chunk);
    const body = JSON.parse(Buffer.concat(chunks));
    const type = body.model.startsWith('claude') ? 'message_start' : 'response.created';
    res.writeHead(200, { 'Content-Type': 'text/event-stream' });
    res.write(`event: message\ndata: {"type":"${type}"}\n\n`);
    streams.set(body.model, res);
  });
  // Tunnelled requests are answered by this same server, standing in for the unreachable target.
  proxy.on('connect', (req, socket, head) => {
    socket.write('HTTP/1.1 200 Connection Established\r\n\r\n');
    if (head.length) socket.unshift(head);
    proxy.emit('connection', socket);
  });
  await new Promise(resolveListen => proxy.listen(0, '127.0.0.1', resolveListen));
  const proxyUrl = `http://127.0.0.1:${proxy.address().port}`;
  const port = await new Promise(resolvePort => {
    const probe = createServer().listen(0, '127.0.0.1', () => { const { port } = probe.address(); probe.close(() => resolvePort(port)); });
  });
  const env = Object.fromEntries(Object.entries(process.env).filter(([key]) => !/_proxy$/i.test(key)));
  const child = spawn(process.execPath, ['--use-env-proxy', 'server.mjs'], {
    cwd: fileURLToPath(new URL('../', import.meta.url)), windowsHide: true, stdio: ['ignore', 'pipe', 'inherit'],
    env: { ...env, HTTP_PROXY: proxyUrl, HTTPS_PROXY: proxyUrl, NO_PROXY: '127.0.0.1,localhost',
      ANYROUTER_PORT: String(port), ANYROUTER_DATA_DIR: join(directory, 'proxy') },
  });
  const exited = new Promise(resolveExit => child.once('exit', resolveExit));
  t.after(async () => {
    child.kill(); await exited; proxy.closeAllConnections();
    await new Promise(resolveClose => proxy.close(resolveClose));
  });
  await new Promise((resolveReady, reject) => {
    child.stdout.on('data', chunk => { if (String(chunk).includes('AnyRouter console:')) resolveReady(); });
    child.once('exit', code => reject(new Error(`server exited (${code})`)));
  });
  const app = { url: `http://127.0.0.1:${port}` };
  const call = async (path, body) => {
    const response = await fetch(`${app.url}/api/${path}`, body ? {
      method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body),
    } : {});
    const data = await response.json();
    assert.equal(response.ok, true, JSON.stringify(data));
    return data;
  };
  await saveKey(app, { id: 'proxy-test', alias: 'Proxy', value: 'sk-proxy-test-only', baseUrl: target });
  await saveKey(app, { id: 'direct-test', alias: 'Direct', value: 'sk-proxy-test-only', baseUrl: proxyUrl });
  assert.equal((await call('models', { keyId: 'proxy-test' })).ok, true);
  for (const [channel, baseUrl] of [['gpt', proxyUrl], ['gpt', target], ['claude', target]]) {
    const config = { name: 'Stream success', channel, keyId: baseUrl === target ? 'proxy-test' : 'direct-test', baseUrl,
      model: `${channel}-${baseUrl === target ? 'proxy' : 'direct'}`, prompt: 'Reply OK',
      maxAttempts: 2, concurrency: 1, intervalSeconds: .5, timeoutSeconds: 30, keepalive: baseUrl === target,
      keepaliveMinSeconds: 60, keepaliveMaxSeconds: 90, telegramChatId: '', telegramBotToken: '', oneMillion: false };
    const task = await call('tasks', { config });
    const accepted = await until(async () => (await call('tasks')).find(row =>
      row.id === task.id && row.status === 'accepted-streaming'), `${config.model} did not recognize success while the stream was open`);
    assert.equal(accepted.successes, 1);
    assert.equal(accepted.healthy, true);
    assert.equal(accepted.probeAttempts, 0);
    streams.get(config.model).end('data: [DONE]\n\n');
    const completed = await until(async () => (await call('tasks')).find(row => row.id === task.id &&
      row.status === (config.keepalive ? 'keepalive' : 'accepted-completed')), `${config.model} did not leave probing`);
    assert.equal(completed.attemptsMade, 1);
    if (config.keepalive) assert.ok(completed.nextAttemptAt > Date.now() + 50_000);
  }
  assert.equal(requests.filter(url => url === `${target}/v1/responses`).length, 1);
  assert.equal(requests.filter(url => url === `${target}/v1/messages?beta=true`).length, 1);
});

test('protected deployment delivers ServerChan from both schedulers and restores retries', async t => {
  const messages = [], counts = new Map();
  const upstream = createServer(async (req, res) => {
    const chunks = [];
    for await (const chunk of req) chunks.push(chunk);
    const body = JSON.parse(Buffer.concat(chunks));
    if (req.url === '/v1/responses') {
      res.writeHead(200, { 'Content-Type': 'text/event-stream' });
      res.end('data: {"type":"response.created"}\n\ndata: [DONE]\n\n');
      return;
    }
    assert.match(req.url, /^\/SCT[A-Za-z0-9_-]+\.send$/);
    messages.push(body);
    const count = (counts.get(body.title) ?? 0) + 1;
    counts.set(body.title, count);
    res.setHeader('Content-Type', 'application/json');
    if (body.title.includes('Permanent')) {
      res.end('{"code":400,"message":"invalid SCTserverchan-test-only"}');
    } else if (body.title.includes('Retry') && count === 1) {
      res.writeHead(429, { 'Retry-After': '1' }); res.end('{"code":429,"message":"busy"}');
    } else res.end('{"code":0,"data":{"errno":0}}');
  });
  await new Promise(resolveListen => upstream.listen(0, '127.0.0.1', resolveListen));
  const baseUrl = `http://127.0.0.1:${upstream.address().port}`;
  let clock = Date.now();
  const options = { host: '0.0.0.0', port: 0, origin: 'https://console.example.test', password: 'local-admin-test-only',
    dbPath: join(directory, 'serverchan', 'notifications.sqlite'), now: () => clock, serverchanBaseUrl: baseUrl };
  await assert.rejects(startServer({ host: '0.0.0.0', port: 0 }), /ANYROUTER_ORIGIN/);
  let app = await startServer(options);
  let cookie = await loginCookie(app, options.password);
  const request = (path, body, headers = {}) => fetch(app.url + path, {
    headers: { Cookie: cookie, ...(body ? { 'Content-Type': 'application/json' } : {}), ...headers },
    ...(body ? { method: 'POST', body: JSON.stringify(body) } : {}),
  });
  const receipt = async id => (await request(`/api/notifications/${id}`)).json();
  const browser = new LiveTaskEngine({ getKey: () => 'sk-serverchan-test-only', notificationPollMs: 10,
    notificationClient: {
      enqueue: async payload => (await request('/api/notifications', payload)).json(),
      get: receipt,
    } });
  t.after(async () => {
    browser.dispose(); await app.close(); upstream.closeAllConnections();
    await new Promise(resolveClose => upstream.close(resolveClose));
  });
  for (const path of ['/api/keys', '/api/tasks']) {
    const denied = await fetch(app.url + path);
    assert.equal(denied.status, 401);
    assert.equal(denied.headers.get('www-authenticate'), null);
  }
  for (const path of ['/', '/assets/app.js']) assert.equal((await fetch(app.url + path)).status, 200);
  assert.equal((await (await fetch(app.url + '/api/health')).json()).ok, true);
  assert.equal((await request('/api/tasks', undefined, { Cookie: 'anyrouter_session=invalid' })).status, 401);
  const hostStatus = host => new Promise((resolveResponse, reject) => {
    httpGet(app.url, { headers: { Host: host, Cookie: cookie, Origin: options.origin,
      'X-Forwarded-Host': 'console.example.test' } }, response => {
      response.resume(); resolveResponse(response.statusCode);
    }).on('error', reject);
  });
  assert.equal(await hostStatus('untrusted.example'), 403);
  assert.equal(await hostStatus('console.example.test'), 200);
  assert.equal((await request('/api/tasks', undefined, { Origin: 'https://untrusted.example' })).status, 403);
  assert.equal(serverchanEndpoint('sctp123tlocal_test'), 'https://123.push.ft07.com/send/sctp123tlocal_test.send');
  const config = { name: 'Browser ServerChan', channel: 'gpt', keyId: 'local', baseUrl, model: 'gpt-notice', prompt: 'Reply OK',
    maxAttempts: 1, concurrency: 1, intervalSeconds: .5, timeoutSeconds: 30, keepalive: false,
    keepaliveMinSeconds: 60, keepaliveMaxSeconds: 90, telegramChatId: '', telegramBotToken: '',
    serverchanSendKey: 'SCTserverchan-test-only', serverchanTags: '服务器报警|图片', oneMillion: false };
  const local = browser.create(config);
  await saveKey(app, { id: 'local', alias: 'ServerChan', value: 'sk-serverchan-test-only', baseUrl }, cookie);
  const created = await request('/api/tasks', { config: { ...config, name: 'Server ServerChan' } });
  assert.equal(created.status, 201);
  const remote = await created.json();
  assert.equal(remote.config.serverchanSendKey, '');
  await until(() => local.notificationStatus === 'sent', 'browser did not send ServerChan');
  await until(async () => (await (await request('/api/tasks')).json()).some(task => task.id === remote.id && task.notificationStatus === 'sent'),
    'server task did not send ServerChan');
  assert.equal(messages.length, 2);
  assert.ok(messages.every(message => message.tags === '服务器报警|图片' && message.desp.includes('Key 尾号：only')));
  assert.equal(JSON.stringify(messages).includes(config.serverchanSendKey), false);
  const payload = { taskId: 'sc-retry', taskName: 'Retry restart', channel: 'gpt', model: 'gpt-notice', keyTail: 'test',
    attempts: 1, elapsedMs: 1, acceptedAt: clock, sendKey: config.serverchanSendKey, tags: 'test' };
  assert.equal((await request('/api/notifications', { ...payload, sendKey: '../bad' })).status, 400);
  assert.equal((await request('/api/notifications', { ...payload, botToken: '123456:local_test', chatId: '-1001' })).status, 400);
  const permanent = await (await request('/api/notifications', { ...payload, taskId: 'sc-dead', taskName: 'Permanent' })).json();
  const dead = await until(async () => { const value = await receipt(permanent.id); return value.status === 'dead' && value; }, 'permanent ServerChan error retried');
  assert.equal(dead.attempts, 1);
  assert.equal(dead.error.includes(config.serverchanSendKey), false);
  const pending = await (await request('/api/notifications', payload)).json();
  await until(async () => (await receipt(pending.id)).status === 'retrying', 'ServerChan did not retry HTTP 429');
  await app.close(); clock += 1000; app = await startServer(options);
  cookie = await loginCookie(app, options.password);
  await until(async () => (await receipt(pending.id)).status === 'sent', 'ServerChan retry did not survive restart');
  assert.equal((await (await request('/api/notifications', payload)).json()).id, pending.id);
  assert.equal(counts.get('任务已接入：Retry restart'), 2);
  const db = new DatabaseSync(options.dbPath, { readOnly: true });
  try {
    assert.ok(db.prepare('SELECT payload FROM notifications').all().every(row => !row.payload.includes(config.serverchanSendKey)));
  } finally { db.close(); }
});

test('ShowDoc delivers from both schedulers, restores retries and protects push credentials', async t => {
  const messages = [], counts = new Map();
  const showdocUrl = 'https://push.showdoc.com.cn/server/api/push/showdoc-test-only';
  const upstream = createServer(async (req, res) => {
    const chunks = [];
    for await (const chunk of req) chunks.push(chunk);
    if (req.url === '/v1/responses') {
      res.writeHead(200, { 'Content-Type': 'text/event-stream' });
      res.end('data: {"type":"response.created"}\n\ndata: [DONE]\n\n');
      return;
    }
    assert.equal(req.url, '/server/api/push/showdoc-test-only');
    assert.match(req.headers['content-type'], /^application\/x-www-form-urlencoded/);
    const body = Object.fromEntries(new URLSearchParams(Buffer.concat(chunks).toString('utf8')));
    assert.deepEqual(Object.keys(body).sort(), ['content', 'title']);
    messages.push(body);
    const count = (counts.get(body.title) ?? 0) + 1;
    counts.set(body.title, count);
    res.setHeader('Content-Type', 'application/json');
    if (body.title.includes('Permanent')) {
      res.end(JSON.stringify({ error_code: 10107, error_message: `Rejected ${showdocUrl} showdoc-test-only` }));
    } else if (body.title.includes('Retry') && count === 1) {
      res.writeHead(429, { 'Retry-After': '1' });
      res.end('{"error_code":429,"error_message":"busy"}');
    } else res.end('{"error_code":0,"data":{}}');
  });
  await new Promise(resolveListen => upstream.listen(0, '127.0.0.1', resolveListen));
  const baseUrl = `http://127.0.0.1:${upstream.address().port}`;
  let clock = Date.now();
  const options = { port: 0, dbPath: join(directory, 'showdoc', 'notifications.sqlite'),
    now: () => clock, showdocBaseUrl: baseUrl };
  let app = await startServer(options);
  const post = (path, body) => fetch(app.url + path, {
    method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body),
  });
  const receipt = async id => (await fetch(`${app.url}/api/notifications/${id}`)).json();
  const tasks = async () => (await fetch(app.url + '/api/tasks')).json();
  const browser = new LiveTaskEngine({ getKey: () => 'sk-showdoc-test-only', notificationPollMs: 10,
    notificationClient: { enqueue: async payload => (await post('/api/notifications', payload)).json(), get: receipt } });
  t.after(async () => {
    browser.dispose(); await app.close(); upstream.closeAllConnections();
    await new Promise(resolveClose => upstream.close(resolveClose));
  });
  const config = { name: 'Browser ShowDoc', channel: 'gpt', keyId: 'local', baseUrl, model: 'gpt-notice', prompt: 'Reply OK',
    maxAttempts: 20001, concurrency: 1, intervalSeconds: .5, timeoutSeconds: 30, keepalive: false,
    keepaliveMinSeconds: 60, keepaliveMaxSeconds: 90, telegramChatId: '', telegramBotToken: '',
    showdocPushUrl: showdocUrl, oneMillion: false };
  const local = browser.create(config);
  await saveKey(app, { id: 'local', alias: 'ShowDoc', value: 'sk-showdoc-test-only', baseUrl });
  const created = await post('/api/tasks', { config: { ...config, name: 'Server ShowDoc' } });
  assert.equal(created.status, 201);
  const remote = await created.json();
  assert.equal(remote.config.showdocPushUrl, '');
  assert.equal(remote.notificationConfigured, true);
  await until(() => local.notificationStatus === 'sent', 'browser did not send ShowDoc');
  await until(async () => (await tasks()).some(task => task.id === remote.id && task.notificationStatus === 'sent'), 'server did not send ShowDoc');
  assert.equal(messages.length, 2);
  assert.ok(messages.every(message => message.title.startsWith('任务已接入：') && message.content.includes('Key 尾号：only')));
  assert.equal(JSON.stringify(messages).includes(showdocUrl), false);
  const payload = { taskId: 'showdoc-retry', taskName: 'Retry restart', channel: 'gpt', model: 'gpt-notice', keyTail: 'test',
    attempts: 1, elapsedMs: 1, acceptedAt: clock, showdocUrl };
  for (const invalid of ['http://push.showdoc.com.cn/server/api/push/test',
    'https://other.example/server/api/push/test', `${showdocUrl}?redirect=1`]) {
    assert.equal((await post('/api/notifications', { ...payload, showdocUrl: invalid })).status, 400);
  }
  assert.equal((await post('/api/notifications', { ...payload, sendKey: 'SCTtest' })).status, 400);
  const permanent = await (await post('/api/notifications', { ...payload, taskId: 'showdoc-dead', taskName: 'Permanent' })).json();
  const dead = await until(async () => { const value = await receipt(permanent.id); return value.status === 'dead' && value; }, 'ShowDoc business error did not stop');
  assert.equal(dead.attempts, 1);
  assert.equal(dead.error.includes('showdoc-test-only'), false);
  const pending = await (await post('/api/notifications', payload)).json();
  const retrying = await until(async () => { const value = await receipt(pending.id); return value.status === 'retrying' && value; }, 'ShowDoc HTTP 429 did not retry');
  assert.equal(retrying.nextAttemptAt, clock + 1000);
  await app.close(); clock += 1000; app = await startServer(options);
  await until(async () => (await receipt(pending.id)).status === 'sent', 'ShowDoc retry did not survive restart');
  assert.equal((await (await post('/api/notifications', payload)).json()).id, pending.id);
  assert.equal(counts.get('任务已接入：Retry restart'), 2);
  clock = Date.now();
  const restarted = await post(`/api/tasks/${remote.id}/restart`);
  assert.equal(restarted.status, 201);
  const again = await restarted.json();
  assert.equal(again.config.showdocPushUrl, '');
  await until(async () => (await tasks()).some(task => task.id === again.id && task.notificationStatus === 'sent'), 'restarted server task lost ShowDoc credentials');
  const db = new DatabaseSync(options.dbPath, { readOnly: true });
  try {
    assert.ok(db.prepare('SELECT payload FROM notifications').all().every(row => !row.payload.includes('showdoc-test-only')));
  } finally { db.close(); }
});

test('login protects shared server keys, migration is resumable and key data survives restart', async t => {
  const seen = [];
  const upstream = createServer((req, res) => {
    req.resume();
    seen.push({ url: req.url, authorization: req.headers.authorization });
    if (req.url.endsWith('/models')) {
      res.writeHead(200, { 'Content-Type': 'application/json' });
      res.end('{"data":[{"id":"gpt-shared"}]}');
    } else {
      res.writeHead(200, { 'Content-Type': 'text/event-stream' });
      res.write('event: ping\ndata: {"type":"ping"}\n\n');
    }
  });
  await new Promise(done => upstream.listen(0, '127.0.0.1', done));
  const baseUrl = `http://127.0.0.1:${upstream.address().port}`;
  let clock = Date.now();
  const options = { port: 0, password: 'shared-admin-test-only', origin: 'https://shared.example.test',
    dbPath: join(directory, 'shared-keys', 'notifications.sqlite'), now: () => clock };
  let app = await startServer(options), store;
  const data = new Map(), nativeFetch = globalThis.fetch;
  const storageDescriptor = Object.getOwnPropertyDescriptor(globalThis, 'localStorage');
  Object.defineProperty(globalThis, 'localStorage', { configurable: true, value: {
    getItem: key => data.get(key) ?? null, setItem: (key, value) => data.set(key, value), removeItem: key => data.delete(key),
  } });
  t.after(async () => {
    store?.dispose(); await app.close(); upstream.closeAllConnections();
    await new Promise(done => upstream.close(done));
    if (storageDescriptor) Object.defineProperty(globalThis, 'localStorage', storageDescriptor);
    else delete globalThis.localStorage;
  });
  const request = (path, method = 'GET', body, cookie = '') => nativeFetch(app.url + path, {
    method, headers: { Cookie: cookie, 'Content-Type': 'application/json' },
    ...(body === undefined ? {} : { body: JSON.stringify(body) }),
  });
  assert.equal((await (await request('/api/auth/session')).json()).authenticated, false);
  assert.equal((await request('/api/keys')).status, 401);
  assert.equal((await nativeFetch(app.url + '/api/keys', {
    headers: { Authorization: 'Basic ' + Buffer.from('admin:' + options.password).toString('base64') },
  })).status, 401);
  assert.equal((await nativeFetch(app.url + '/api/auth/login', { method: 'POST',
    headers: { Origin: 'https://untrusted.example', 'Content-Type': 'application/json' },
    body: JSON.stringify({ password: options.password }) })).status, 403);
  for (let attempt = 0; attempt < 5; attempt++) {
    assert.equal((await request('/api/auth/login', 'POST', { password: 'wrong' })).status, 401);
  }
  const limited = await request('/api/auth/login', 'POST', { password: options.password });
  assert.equal(limited.status, 429);
  assert.equal(limited.headers.get('retry-after'), '60');
  clock += 60_000;
  const login = await request('/api/auth/login', 'POST', { password: options.password });
  assert.equal(login.status, 200);
  assert.match(login.headers.get('set-cookie'), /HttpOnly; SameSite=Strict; Max-Age=604800; Secure/);
  let cookie = login.headers.get('set-cookie').split(';')[0];
  const otherCookie = await loginCookie(app, options.password);
  assert.notEqual(cookie, otherCookie);
  t.mock.method(globalThis, 'fetch', (input, init) => typeof input === 'string' && input.startsWith('/')
    ? nativeFetch(app.url + input, { ...init, headers: { ...init?.headers, Cookie: cookie } })
    : nativeFetch(input, init));

  const storageKey = 'anyrouter-console:keys:v1';
  const first = { id: 'key_import_1', alias: 'Imported one', value: 'sk-import-one-test-only', baseUrl,
    authStatus: 'ready', models: ['gpt-shared'] };
  const second = { ...first, id: 'key_import_2', alias: 'Imported two', value: 'bad' };
  data.set(storageKey, JSON.stringify([first, second]));
  await assert.rejects(loadServerKeys(), /API Key/);
  assert.ok(data.has(storageKey), 'failed migration erased the original keys');
  assert.equal((await (await request('/api/keys', 'GET', undefined, otherCookie)).json()).length, 1);
  second.value = 'sk-import-two-test-only';
  data.set(storageKey, JSON.stringify([first, second]));
  const imported = await loadServerKeys();
  assert.equal(data.has(storageKey), false);
  assert.equal(imported.length, 2, 'retrying migration duplicated a key');
  assert.deepEqual(imported.find(key => key.id === first.id), first);
  assert.deepEqual(await (await request('/api/keys', 'GET', undefined, otherCookie)).json(), imported);
  assert.equal((await request('/api/keys', 'POST', { ...first, value: 'sk-different-test-only' }, cookie)).status, 409);
  assert.equal((await request('/api/keys', 'POST', { ...first, id: 'bad/id' }, cookie)).status, 400);

  clock = Date.now();
  store = new AppStore(imported);
  const key = await store.addKey('Shared key', 'sk-shared-test-only', baseUrl);
  assert.equal(key.authStatus, 'ready');
  assert.deepEqual(key.models, ['gpt-shared']);
  assert.equal(await store.updateKeyBaseUrl(key.id, baseUrl + '/changed/v1'), true);
  assert.equal(key.baseUrl, baseUrl + '/changed');
  assert.equal((await request(`/api/keys/${key.id}`, 'PATCH', { expectedBaseUrl: baseUrl,
    auth: { ok: true, models: ['stale-model'] } }, otherCookie)).status, 409);
  const shared = (await (await request('/api/keys', 'GET', undefined, otherCookie)).json()).find(row => row.id === key.id);
  assert.equal(shared.baseUrl, key.baseUrl);
  assert.deepEqual(shared.models, ['gpt-shared']);
  assert.equal(data.has(storageKey), false, 'key edits wrote a browser credential copy');
  const config = { name: 'Shared credential task', channel: 'gpt', keyId: key.id, baseUrl: 'http://127.0.0.1:1',
    model: 'gpt-shared', prompt: 'Reply OK', maxAttempts: 1, concurrency: 1, intervalSeconds: .5, timeoutSeconds: 30,
    keepalive: false, keepaliveMinSeconds: 60, keepaliveMaxSeconds: 90, telegramChatId: '', telegramBotToken: '', oneMillion: false };
  const created = await request('/api/tasks', 'POST', { config, token: 'sk-must-not-be-used' }, otherCookie);
  assert.equal(created.status, 201);
  const task = await created.json();
  assert.equal(task.config.baseUrl, key.baseUrl);
  await until(() => seen.some(item => item.url === '/changed/v1/responses'), 'server did not use the server key address');
  assert.ok(seen.every(item => item.authorization === 'Bearer sk-shared-test-only'));
  assert.equal((await request(`/api/keys/${key.id}`, 'DELETE', undefined, otherCookie)).status, 200);
  await store.refreshKeys();
  assert.equal(store.keys.some(row => row.id === key.id), false);
  const cancelled = (await (await request('/api/tasks', 'GET', undefined, cookie)).json()).find(row => row.id === task.id);
  assert.equal(cancelled.status, 'cancelled');
  store.dispose();

  await app.close(); app = await startServer(options);
  assert.equal((await request('/api/keys', 'GET', undefined, cookie)).status, 401);
  cookie = await loginCookie(app, options.password);
  assert.deepEqual((await (await request('/api/keys', 'GET', undefined, cookie)).json()).map(row => row.id).sort(), [first.id, second.id]);
  clock += 7 * 24 * 60 * 60 * 1000;
  assert.equal((await request('/api/keys', 'GET', undefined, cookie)).status, 401);
  cookie = await loginCookie(app, options.password);
  assert.equal((await request('/api/auth/logout', 'POST', undefined, cookie)).status, 200);
  assert.equal((await request('/api/keys', 'GET', undefined, cookie)).status, 401, 'logout left the cookie authorized');
});

test('stream progress batches storage writes while success, pagehide and pause persist immediately', async t => {
  const data = new Map(), events = new EventTarget();
  let writes = 0, stream;
  const replacements = {
    localStorage: { getItem: key => data.get(key) ?? null, setItem: (key, value) => { data.set(key, value); if (key.includes(':tasks:')) writes++; } },
    addEventListener: events.addEventListener.bind(events), removeEventListener: events.removeEventListener.bind(events),
  };
  const descriptors = Object.fromEntries(Object.keys(replacements).map(key => [key, Object.getOwnPropertyDescriptor(globalThis, key)]));
  for (const [key, value] of Object.entries(replacements)) Object.defineProperty(globalThis, key, { value, configurable: true });
  t.mock.method(globalThis, 'fetch', async url => {
    if (url === '/api/tasks') return Response.json([]);
    assert.equal(url, 'http://127.0.0.1:1/v1/responses');
    return new Response(new ReadableStream({ start(controller) { stream = controller; } }), { headers: { 'Content-Type': 'text/event-stream' } });
  });
  const store = new AppStore();
  t.after(() => {
    store.dispose();
    for (const [key, descriptor] of Object.entries(descriptors)) {
      if (descriptor) Object.defineProperty(globalThis, key, descriptor);
      else delete globalThis[key];
    }
  });
  store.keys = [{ id: 'local', value: 'sk-batch-test-only', alias: 'Test', baseUrl: 'http://127.0.0.1:1', authStatus: 'ready', models: [] }];
  const [task] = await store.createTask({ name: 'Batch test', channel: 'gpt', keyId: 'local', baseUrl: 'http://127.0.0.1:1', model: 'gpt-test', prompt: 'Reply OK',
    maxAttempts: 1, concurrency: 1, intervalSeconds: .5, timeoutSeconds: 30, keepalive: true,
    keepaliveMinSeconds: 60, keepaliveMaxSeconds: 90, telegramChatId: '', telegramBotToken: '', oneMillion: false }, 'browser');
  await until(() => stream, 'stream did not open');
  const send = text => stream.enqueue(new TextEncoder().encode(text));
  const storedTask = () => JSON.parse(data.get('anyrouter-console:tasks:v1'))[0];
  send('data: {"type":"response.created"}\n\n');
  await until(() => task.status === 'accepted-streaming', 'first success was delayed');
  assert.equal(storedTask().status, 'accepted-streaming');
  const before = writes;
  send('data: {"type":"response.output_text.delta","delta":"x"}\n\n'.repeat(80));
  await until(() => task.events.length >= 83, 'stream progress was not processed');
  assert.equal(writes, before);
  await until(() => writes === before + 1, 'progress writes were not batched');
  const count = task.events.length;
  send('data: {"type":"response.output_text.delta","delta":"last"}\n\n');
  await until(() => task.events.length > count, 'last progress event missing');
  events.dispatchEvent(new Event('pagehide'));
  assert.equal(writes, before + 2);
  assert.equal(storedTask().events.length, task.events.length);
  await store.engine.pause(task.id);
  assert.equal(storedTask().status, 'paused');
});
