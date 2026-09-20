import test, { after } from 'node:test';
import assert from 'node:assert/strict';
import { createServer, get as httpGet } from 'node:http';
import { execFileSync } from 'node:child_process';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join, dirname, resolve, basename } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { setTimeout as delay } from 'node:timers/promises';
import { DatabaseSync } from 'node:sqlite';
import { build } from 'esbuild';
import { startServer } from '../server.mjs';
import { serverchanEndpoint } from '../dist/task-requests.mjs';

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
  retryableModelError, retryAfterMilliseconds, saveTasks, loadTasks, AppStore, createClaudeRequestIdentity, createCodexRequestIdentity } = await import(pathToFileURL(bundlePath));

async function until(check, message) {
  const deadline = Date.now() + 5000;
  while (Date.now() < deadline) {
    const result = await check();
    if (result) return result;
    await delay(20);
  }
  assert.fail(message);
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

test('browser engine sends direct GPT/Claude traffic, bounds concurrency and cancels losing streams', async t => {
  t.mock.method(crypto, 'randomUUID', () => { throw new Error('randomUUID is unavailable over plain HTTP'); });
  const uuidPattern = /^[a-f0-9]{8}-[a-f0-9]{4}-4[a-f0-9]{3}-[89ab][a-f0-9]{3}-[a-f0-9]{12}$/;
  assert.match(createClaudeRequestIdentity().sessionId, uuidPattern);
  assert.match(createCodexRequestIdentity().sessionId.replace(/^session_/, ''), uuidPattern);
  const requests = [], counts = new Map(), engines = [];
  let closedStreams = 0;
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
      res.on('close', () => { closedStreams += 1; }); return;
    }
    const send = () => {
      const event = req.url.startsWith('/v1/messages') ? 'message_start' : 'response.created';
      res.write(`event: ${event}\ndata: {"type":"${event}"}\n\n`);
      if (body.model === 'gpt-interrupted') setTimeout(() => res.destroy(), 40);
      else res.end('data: [DONE]\n\n');
    };
    if (body.model === 'gpt-parallel') setTimeout(send, 80);
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

  const parallel = engine.create({ ...config, model: 'gpt-parallel', concurrency: 4, maxAttempts: 3 });
  await until(() => parallel.status === 'accepted-completed' && closedStreams === 2, 'losing streams were not cancelled');
  assert.equal(parallel.attemptsMade, 3);
  assert.equal(parallel.events.filter(event => event.title === '已成功挤入').length, 1);
  assert.equal(parallel.responseSummary.includes('sibling'), false);
  const fatal = engine.create({ ...config, model: 'gpt-fatal', maxAttempts: 5 });
  await until(() => fatal.stopReason === 'permanent-error', 'authentication error did not stop retries');
  assert.equal(fatal.attemptsMade, 1);
  const interrupted = engine.create({ ...config, model: 'gpt-interrupted' });
  await until(() => interrupted.status === 'accepted-stream-interrupted', 'accepted stream interruption was lost');
  await delay(600);
  assert.equal(interrupted.attemptsMade, 1);
  assert.equal(counts.get('gpt-parallel'), 3);
  assert.equal(counts.get('gpt-fatal'), 1);

  const held = engine.create({ ...config, model: 'gpt-hold' });
  await until(() => counts.has('gpt-hold'), 'hold request did not start');
  assert.equal(engine.pause(held.id), true);
  await until(() => closedStreams === 3, 'pause did not abort direct stream');
  assert.equal(engine.resume(held.id), true);
  await until(() => counts.get('gpt-hold') === 2, 'resume did not start a new request');
  const data = new Map();
  const storage = { getItem: key => data.get(key) ?? null, setItem: (key, value) => data.set(key, value) };
  saveTasks(engine.list(), storage);
  const restored = new LiveTaskEngine({ getKey: () => 'sk-frontend-test-only' });
  engines.push(restored); restored.restore(loadTasks(storage));
  assert.equal(restored.get(held.id).status, 'paused');
  assert.equal(restored.get(parallel.id).config.concurrency, 4);
  assert.equal(restored.get(parallel.id).sessionId, parallel.sessionId);
  assert.equal(restored.get(parallel.id).successes, 1);
  assert.equal(restored.get(parallel.id).probeAttempts, 0);
  assert.equal(engine.remove(held.id), true);
  await until(() => closedStreams === 4, 'deleting a task did not abort its stream');
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
  assert.deepEqual((await (await fetch(app.url + '/api/health')).json()).modelRequests, ['browser', 'python']);
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
    assert.equal(db.prepare("SELECT count(*) AS count FROM sqlite_master WHERE name='tasks'").get().count, 0);
  } finally { db.close(); }
});

test('browser and Python run together, recover keepalive and preserve backend ownership', async t => {
  const seen = new Map(), requests = [];
  let closedLosers = 0;
  const upstream = createServer(async (req, res) => {
    assert.equal(req.headers.authorization, 'Bearer sk-dual-test-only');
    res.setHeader('Content-Type', 'application/json');
    if (req.url === '/v1/models') { res.end('{"data":[{"id":"gpt-browser"},{"id":"gpt-python"},{"id":"claude-python"}]}'); return; }
    const chunks = [];
    for await (const chunk of req) chunks.push(chunk);
    const body = JSON.parse(Buffer.concat(chunks));
    const count = (seen.get(body.model) ?? 0) + 1;
    seen.set(body.model, count);
    requests.push({ headers: req.headers, body });
    if (body.model === 'gpt-fatal' || count === 2 && ['gpt-browser', 'gpt-python'].includes(body.model)) {
      res.writeHead(body.model === 'gpt-fatal' ? 401 : 503);
      res.end('{"error":{"message":"' + (body.model === 'gpt-fatal' ? 'invalid_api_key' : 'busy') + '"}}'); return;
    }
    res.setHeader('Content-Type', 'text/event-stream');
    if (body.model === 'gpt-parallel' && count > 1 || body.model === 'gpt-held') {
      res.write('event: ping\ndata: {"type":"ping"}\n\n');
      res.on('close', () => { closedLosers++; }); return;
    }
    const finish = () => {
      const type = body.model.startsWith('claude') ? 'message_start' : 'response.created';
      res.write(`event: ${type}\ndata: {"type":"${type}"}\n\n`);
      res.end('data: [DONE]\n\n');
    };
    if (body.model === 'gpt-parallel') setTimeout(finish, 150);
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
    const response = await fetch(`${app.url}/api/python/${path}`, {
      method, ...(body ? { headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body) } : {}),
    });
    const result = await response.json();
    assert.equal(response.ok, true, JSON.stringify(result));
    return result;
  };
  const config = { name: 'Dual keepalive', channel: 'gpt', keyId: 'dual', baseUrl, model: 'gpt-python', prompt: 'Reply OK',
    maxAttempts: 2, concurrency: 1, intervalSeconds: .5, timeoutSeconds: 30, keepalive: true,
    keepaliveMinSeconds: .5, keepaliveMaxSeconds: .5, telegramChatId: '', telegramBotToken: '', oneMillion: false };
  const auth = await call('models', 'POST', { baseUrl, token: 'sk-dual-test-only' });
  assert.equal(auth.ok, true);
  const local = browser.create({ ...config, model: 'gpt-browser' });
  const remote = await call('tasks', 'POST', { config, token: 'sk-dual-test-only' });
  assert.equal(remote.scheduler, 'python');
  assert.equal(JSON.stringify(remote).includes('sk-dual-test-only'), false);
  await until(() => local.successes >= 2 && seen.get('gpt-python') >= 3, 'both schedulers failed to recover keepalive');
  let rows = await call('tasks');
  const recovered = await until(async () => (await call('tasks')).find(task => task.id === remote.id && task.successes >= 2), 'Python recovery not recorded');
  assert.equal(recovered.probeAttempts, 0);
  assert.deepEqual(recovered.events, []);
  const detailed = (await call(`tasks?detail=${remote.id}`)).find(task => task.id === remote.id);
  assert.equal(detailed.events.some(event => event.type === 'request.failed'), true);
  assert.equal(local.events.some(event => event.type === 'request.failed'), true);
  for (const model of ['gpt-browser', 'gpt-python']) {
    const modelRequests = requests.filter(item => item.body.model === model);
    assert.equal(new Set(modelRequests.map(item => item.headers['session-id'])).size, 1, 'keepalive changed sessions');
    for (const item of modelRequests) assert.equal(item.headers['session-id'], item.body.client_metadata.session_id);
  }
  assert.notEqual(local.sessionId, remote.sessionId);
  assert.equal(browser.pause(local.id), true);
  const localCount = seen.get('gpt-browser'), pythonCount = seen.get('gpt-python');
  browser.dispose();
  await until(() => seen.get('gpt-python') > pythonCount, 'Python stopped when browser was disposed');
  assert.equal(seen.get('gpt-browser'), localCount);
  await call(`tasks/${remote.id}/pause`, 'POST');
  await delay(100);
  const pausedCount = seen.get('gpt-python');
  await delay(650);
  assert.equal(seen.get('gpt-python'), pausedCount, 'paused Python kept sending');
  await app.close(); app = await startServer(options);
  rows = await call('tasks');
  assert.equal(rows.find(task => task.id === remote.id).status, 'paused');
  await delay(600);
  assert.equal(seen.get('gpt-python'), pausedCount, 'restart resumed a paused task');
  await call(`tasks/${remote.id}/resume`, 'POST');
  await until(() => seen.get('gpt-python') > pausedCount, 'Python did not resume');
  await app.close();
  const stoppedCount = seen.get('gpt-python');
  app = await startServer(options);
  await until(() => seen.get('gpt-python') > stoppedCount, 'active task did not recover after service restart');
  await call(`tasks/${remote.id}/cancel`, 'POST');

  const parallel = await call('tasks', 'POST', { config: { ...config, model: 'gpt-parallel', keepalive: false, concurrency: 4, maxAttempts: 3 }, token: 'sk-dual-test-only' });
  const completed = await until(async () => (await call('tasks')).find(task => task.id === parallel.id && task.status === 'accepted-completed'), 'Python parallel round did not finish');
  assert.equal(completed.attemptsMade, 3);
  assert.equal(completed.successes, 1);
  assert.equal(closedLosers, 2);
  const claude = await call('tasks', 'POST', { config: { ...config, channel: 'claude', model: 'claude-python[1m]', keepalive: false }, token: 'sk-dual-test-only' });
  await until(async () => (await call('tasks')).some(task => task.id === claude.id && task.status === 'accepted-completed'), 'Python Claude did not complete');
  const claudeRequest = requests.find(item => item.body.model === 'claude-python');
  assert.equal(claudeRequest.body.tools.length, 26);
  assert.match(claudeRequest.headers['anthropic-beta'], /context-1m/);
  const fatal = await call('tasks', 'POST', { config: { ...config, model: 'gpt-fatal' }, token: 'sk-dual-test-only' });
  await until(async () => (await call('tasks')).some(task => task.id === fatal.id && task.stopReason === 'permanent-error'), 'Python did not stop a permanent failure');
  assert.equal(seen.get('gpt-fatal'), 1);
  const held = await call('tasks', 'POST', { config: { ...config, model: 'gpt-held' }, token: 'sk-dual-test-only' });
  await until(() => seen.has('gpt-held'), 'Python held stream did not start');
  await call(`tasks/${held.id}`, 'DELETE');
  await until(() => closedLosers === 3, 'Python delete did not stop the held stream');
  assert.equal((await call('tasks')).some(task => task.id === held.id), false);
  const invalid = await fetch(`${app.url}/api/python/tasks`, { method: 'POST', headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ config: { ...config, keepaliveMinSeconds: 20, keepaliveMaxSeconds: 10 }, token: 'sk-dual-test-only' }) });
  assert.equal(invalid.status, 400);
  const db = new DatabaseSync(join(directory, 'dual', 'python-tasks.sqlite'), { readOnly: true });
  try {
    if (process.platform === 'win32') {
      for (const row of db.prepare('SELECT payload FROM tasks').all()) assert.equal(Buffer.from(row.payload).includes(Buffer.from('sk-dual-test-only')), false);
    }
  } finally { db.close(); }
  await app.close();
  execFileSync(process.env.ANYROUTER_PYTHON || (process.platform === 'win32' ? 'python' : 'python3'), ['-B', '-X', 'utf8', '-c', `
import sys
from unittest.mock import patch
from python_scheduler import WebRuntime, poll

with patch.object(WebRuntime, 'start'):
    runtime = WebRuntime(sys.argv[1], 'http://127.0.0.1:1/api/notifications')
try:
    task = next(t for t in runtime.tasks if t.args.model == 'gpt-parallel')
    data = runtime.entries[task.id]['task']
    data.update(status='accepted-streaming', healthy=True)
    task.paused = False
    task.launched = 1
    job = poll.Job(1, 'Reply OK', '', runtime.clock() - task.args.timeout - 1,
                   task.session_id, settings=task.args, task_id=task.id)
    task.awaiting[1] = (job, task.revision)
    runtime.step()
    assert data['status'] == 'accepted-stream-interrupted', data['status']
    assert data['healthy'] and data['successes'] == 1
    assert not runtime.records and not task.records
    assert runtime.db.execute('PRAGMA journal_mode').fetchone()[0] == 'wal'
    assert runtime.command('health', {}) is False
finally:
    runtime.close()
`, join(directory, 'dual', 'python-tasks.sqlite')], { cwd: fileURLToPath(new URL('../', import.meta.url)), windowsHide: true });
});

test('Python recognizes success before EOF and uses the same proxy as authentication', async t => {
  const streams = new Map(), requests = [];
  const target = 'http://anyrouter-proxy.invalid';
  const proxy = createServer(async (req, res) => {
    assert.equal(req.headers.authorization, 'Bearer sk-proxy-test-only');
    requests.push(req.url);
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
  await new Promise(resolveListen => proxy.listen(0, '127.0.0.1', resolveListen));
  const proxyUrl = `http://127.0.0.1:${proxy.address().port}`;
  let app;
  t.after(async () => {
    await app?.close(); proxy.closeAllConnections();
    await new Promise(resolveClose => proxy.close(resolveClose));
  });
  const env = { http_proxy: proxyUrl, https_proxy: proxyUrl, no_proxy: '127.0.0.1,localhost' };
  const saved = Object.fromEntries(Object.keys(env).map(key => [key, process.env[key]]));
  try {
    Object.assign(process.env, env);
    app = await startServer({ port: 0, dbPath: join(directory, 'proxy', 'notifications.sqlite') });
  } finally {
    for (const [key, value] of Object.entries(saved)) {
      if (value === undefined) delete process.env[key];
      else process.env[key] = value;
    }
  }
  const call = async (path, body) => {
    const response = await fetch(`${app.url}/api/python/${path}`, body ? {
      method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body),
    } : {});
    const data = await response.json();
    assert.equal(response.ok, true, JSON.stringify(data));
    return data;
  };
  assert.equal((await call('models', { baseUrl: target, token: 'sk-proxy-test-only' })).ok, true);
  for (const [channel, baseUrl] of [['gpt', proxyUrl], ['gpt', target], ['claude', target]]) {
    const config = { name: 'Stream success', channel, keyId: 'proxy-test', baseUrl,
      model: `${channel}-${baseUrl === target ? 'proxy' : 'direct'}`, prompt: 'Reply OK',
      maxAttempts: 2, concurrency: 1, intervalSeconds: .5, timeoutSeconds: 30, keepalive: baseUrl === target,
      keepaliveMinSeconds: 60, keepaliveMaxSeconds: 90, telegramChatId: '', telegramBotToken: '', oneMillion: false };
    const task = await call('tasks', { config, token: 'sk-proxy-test-only' });
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
  const authorization = 'Basic ' + Buffer.from('admin:' + options.password).toString('base64');
  const request = (path, body, headers = {}) => fetch(app.url + path, {
    headers: { Authorization: authorization, ...(body ? { 'Content-Type': 'application/json' } : {}), ...headers },
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
  for (const path of ['/', '/assets/app.js', '/api/python/tasks']) {
    const denied = await fetch(app.url + path);
    assert.equal(denied.status, 401);
    assert.match(denied.headers.get('www-authenticate'), /Basic/);
  }
  assert.equal((await (await fetch(app.url + '/api/health')).json()).ok, true);
  assert.equal((await request('/', undefined, { Authorization: 'Basic invalid' })).status, 401);
  const hostStatus = host => new Promise((resolveResponse, reject) => {
    httpGet(app.url, { headers: { Host: host, Authorization: authorization, Origin: options.origin,
      'X-Forwarded-Host': 'console.example.test' } }, response => {
      response.resume(); resolveResponse(response.statusCode);
    }).on('error', reject);
  });
  assert.equal(await hostStatus('untrusted.example'), 403);
  assert.equal(await hostStatus('console.example.test'), 200);
  assert.equal((await request('/api/python/tasks', undefined, { Origin: 'https://untrusted.example' })).status, 403);
  assert.equal(serverchanEndpoint('sctp123tlocal_test'), 'https://123.push.ft07.com/send/sctp123tlocal_test.send');
  const config = { name: 'Browser ServerChan', channel: 'gpt', keyId: 'local', baseUrl, model: 'gpt-notice', prompt: 'Reply OK',
    maxAttempts: 1, concurrency: 1, intervalSeconds: .5, timeoutSeconds: 30, keepalive: false,
    keepaliveMinSeconds: 60, keepaliveMaxSeconds: 90, telegramChatId: '', telegramBotToken: '',
    serverchanSendKey: 'SCTserverchan-test-only', serverchanTags: '服务器报警|图片', oneMillion: false };
  const local = browser.create(config);
  const created = await request('/api/python/tasks', { config: { ...config, name: 'Python ServerChan' }, token: 'sk-serverchan-test-only' });
  assert.equal(created.status, 201);
  const remote = await created.json();
  assert.equal(remote.config.serverchanSendKey, '');
  await until(() => local.notificationStatus === 'sent', 'browser did not send ServerChan');
  await until(async () => (await (await request('/api/python/tasks')).json()).some(task => task.id === remote.id && task.notificationStatus === 'sent'),
    'Python authenticated notification callback did not send ServerChan');
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
  await until(async () => (await receipt(pending.id)).status === 'sent', 'ServerChan retry did not survive restart');
  assert.equal((await (await request('/api/notifications', payload)).json()).id, pending.id);
  assert.equal(counts.get('任务已接入：Retry restart'), 2);
  const db = new DatabaseSync(options.dbPath, { readOnly: true });
  try {
    assert.ok(db.prepare('SELECT payload FROM notifications').all().every(row => !row.payload.includes(config.serverchanSendKey)));
  } finally { db.close(); }
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
    if (url === '/api/python/tasks') return Response.json([]);
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
