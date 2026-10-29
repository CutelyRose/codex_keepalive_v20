// Deterministic server scheduling checks: mocked clock and in-memory upstream, no network.
import test from 'node:test';
import assert from 'node:assert/strict';
import { ServerTaskEngine } from '../dist/server-core.mjs';

const encoder = new TextEncoder();
const settle = async () => { for (let index = 0; index < 20; index++) await new Promise(done => setImmediate(done)); };

/** Each fetch call stays open until the test answers it. */
function upstream() {
  const calls = [];
  const fetchImpl = (url, init) => new Promise((resolve, reject) => {
    let stream;
    const call = {
      token: init.headers.get('authorization').slice(7), aborted: false,
      accept() {
        resolve(new Response(new ReadableStream({ start(controller) { stream = controller; } }), { headers: { 'Content-Type': 'text/event-stream' } }));
        stream.enqueue(encoder.encode('event: response.created\ndata: {"type":"response.created"}\n\n'));
      },
      end() { stream.close(); },
      cut() { stream.error(new Error('socket hang up')); },
      fail(status = 503, headers = {}, body = '{"error":{"message":"busy"}}') { resolve(new Response(body, { status, headers })); },
    };
    init.signal.addEventListener('abort', () => {
      call.aborted = true;
      reject(new DOMException('aborted', 'AbortError'));
    });
    calls.push(call);
  });
  return { calls, fetchImpl, open: () => calls.filter(call => !call.aborted && !call.done) };
}

function setup(t, count = 2, options = {}) {
  t.mock.timers.enable({ apis: ['setTimeout', 'Date'], now: 1_000_000 });
  const server = upstream(), notices = [];
  const engine = new ServerTaskEngine({ getKey: id => `sk-${id}`, fetchImpl: server.fetchImpl,
    notificationClient: { enqueue: async payload => { notices.push(payload); return { id: 'notice', status: 'sent', attempts: 1 }; },
      get: async () => ({ id: 'notice', status: 'sent', attempts: 1 }) }, ...options });
  t.after(() => engine.dispose());
  const create = (size = count, extra = {}) => engine.createPool({ name: 'Pool test', keyIds: Array.from({ length: size }, (_, n) => `key-${n}`),
    channel: 'gpt', model: 'gpt-test', prompt: 'OK', concurrency: 1, intervalSeconds: .5, timeoutSeconds: 120, keepalive: true,
    keepaliveMinSeconds: 1, keepaliveMaxSeconds: 1, oneMillion: false, telegramChatId: '', telegramBotToken: '', ...extra },
  Array.from({ length: size }, (_, n) => ({ keyId: `key-${n}`, alias: `key-${n}`, keyTail: `000${n}`.slice(-4), baseUrl: 'http://127.0.0.1:1' })));
  const tick = async ms => { t.mock.timers.tick(ms); await settle(); };
  return { engine, server, notices, create, tick };
}

const of = (server, key) => server.calls.filter(call => call.token === `sk-${key}`);
const last = (server, key) => of(server, key).at(-1);

/** Leader key-0 wins, finishes its stream, then fails one keepalive request: recovery has started. */
async function recovering(context) {
  const { server, create, tick } = context;
  const task = create();
  await settle();
  last(server, 'key-0').accept(); await settle();
  last(server, 'key-0').end(); await settle();
  await tick(1000);
  last(server, 'key-0').fail(); await settle();
  assert.equal(task.pool.phase, 'recovering');
  return task;
}

test('all members race, only the first success keeps alive and the others stop', async t => {
  const { server, create, tick } = setup(t);
  const task = create(12);
  await settle();
  assert.equal(server.calls.length, 12);
  last(server, 'key-0').accept();
  last(server, 'key-1').accept();
  await settle();
  assert.equal(task.successes, 1);
  assert.equal(task.pool.activeKeyId, 'key-0');
  assert.equal(server.calls.filter(call => call.aborted).length, 11);
  last(server, 'key-0').end(); await settle();
  assert.equal(task.status, 'keepalive');
  await tick(1000);
  assert.equal(server.calls.length, 13);
  assert.equal(last(server, 'key-0'), server.calls.at(-1));
  assert.equal(task.pool.members[1].attemptsMade, 1);
});

test('leader recovering at 29.9 seconds keeps alive; failures never extend the deadline', async t => {
  const context = setup(t);
  const task = await recovering(context);
  const deadline = task.pool.recoveryDeadline;
  assert.equal(deadline, Date.now() + 30_000);
  await context.tick(500);
  last(context.server, 'key-0').fail(); await settle();
  assert.equal(task.pool.recoveryDeadline, deadline);
  await context.tick(deadline - 100 - Date.now());
  last(context.server, 'key-0').accept(); await settle();
  assert.equal(task.pool.phase, 'keeping');
  assert.equal(task.pool.recoveryDeadline, undefined);
  assert.equal(of(context.server, 'key-1').length, 1);
});

test('deadline preempts a hung request and a late success cannot keep the old leader', async t => {
  const context = setup(t);
  const task = await recovering(context);
  await context.tick(500);
  const hung = last(context.server, 'key-0');
  await context.tick(task.pool.recoveryDeadline - Date.now());
  assert.equal(task.pool.phase, 'racing');
  assert.equal(task.pool.races, 2);
  assert.equal(hung.aborted, true);
  assert.equal(context.server.open().length, 2);
  last(context.server, 'key-1').accept(); await settle();
  assert.equal(task.pool.activeKeyId, 'key-1');
});

test('a success event exactly at the deadline is rejected in favour of a new race', async t => {
  const context = setup(t);
  const task = await recovering(context);
  await context.tick(500);
  const attempt = last(context.server, 'key-0');
  attempt.accept();
  t.mock.timers.setTime(task.pool.recoveryDeadline);
  await settle();
  assert.equal(task.pool.phase, 'racing');
  assert.equal(task.successes, 1);
});

test('stream interruption starts recovery and retryNow keeps its deadline', async t => {
  const { server, engine, create, tick } = setup(t);
  const task = create();
  await settle();
  last(server, 'key-0').accept(); await settle();
  last(server, 'key-0').cut(); await settle();
  const deadline = task.pool.recoveryDeadline;
  assert.equal(deadline, Date.now() + 30_000);
  await tick(100);
  assert.equal(task.status, 'waiting');
  assert.equal(engine.retryNow(task.id), true);
  await settle();
  assert.equal(task.pool.recoveryDeadline, deadline);
  assert.deepEqual(server.open().map(call => call.token), ['sk-key-0']);
});

test('only the winner submits a notification, with its member identity', async t => {
  const { server, notices, create, tick } = setup(t);
  create(2, { showdocPushUrl: 'https://push.showdoc.com.cn/server/api/push/test' });
  await settle();
  last(server, 'key-0').accept(); last(server, 'key-1').accept(); await settle();
  assert.equal(notices.length, 1);
  assert.equal(notices[0].taskName, 'Pool test · key-0');
  assert.equal(notices[0].keyTail, 'ey-0');
  last(server, 'key-0').end(); await settle();
  await tick(1000);
  last(server, 'key-0').accept(); await settle();
  assert.equal(notices.length, 1, 'continued keepalive notified again');
});

test('Retry-After is kept per member across the race transition', async t => {
  const { server, create, tick } = setup(t);
  const task = create();
  await settle();
  last(server, 'key-0').accept(); await settle();
  last(server, 'key-0').end(); await settle();
  await tick(1000);
  last(server, 'key-0').fail(429, { 'Retry-After': '60' }); await settle();
  await tick(30_000);
  assert.equal(task.pool.phase, 'racing');
  assert.deepEqual(server.open().map(call => call.token), ['sk-key-1']);
  await tick(30_000);
  assert.equal(server.open().length, 2);
});

test('a permanent member error is isolated and an all-invalid pool stops', async t => {
  const { server, create } = setup(t);
  const task = create();
  await settle();
  last(server, 'key-0').fail(401, {}, '{"error":{"message":"invalid_api_key"}}'); await settle();
  assert.equal(task.pool.members[0].disabled, true);
  assert.notEqual(task.status, 'exhausted');
  last(server, 'key-1').fail(401, {}, '{"error":{"message":"invalid_api_key"}}'); await settle();
  assert.equal(task.status, 'exhausted');
  assert.equal(task.stopReason, 'permanent-error');
});

test('pause, resume, cancel and delete leave other pools alone', async t => {
  const context = setup(t);
  const { engine, server } = context;
  const task = await recovering(context);
  const other = context.create();
  await settle();
  const before = server.calls.length;
  assert.equal(engine.pause(task.id), true);
  await context.tick(100_000);
  assert.equal(task.status, 'paused');
  assert.equal(task.pool.recoveryDeadline, undefined);
  assert.equal(server.calls.length, before, 'paused pool kept sending');
  assert.equal(engine.resume(task.id), true);
  assert.equal(task.pool.recoveryDeadline, Date.now() + 30_000);
  await settle();
  assert.equal(server.calls.length, before + 1);
  const attempt = server.calls.at(-1);
  assert.equal(engine.cancel(task.id), true);
  assert.equal(attempt.aborted, true);
  assert.equal(task.status, 'cancelled');
  assert.equal(engine.remove(task.id), true);
  assert.equal(engine.get(task.id), undefined);
  assert.notEqual(engine.get(other.id).status, 'cancelled');
});

test('restart keeps saved deadlines and sessions, races after expiry, and leaves paused pools stopped', async t => {
  const context = setup(t);
  const source = context.create();
  context.engine.dispose();
  const saved = phase => JSON.parse(JSON.stringify({ ...source, id: `${source.id}-${phase}`, status: 'waiting',
    pool: { ...source.pool, phase: 'recovering', activeKeyId: 'key-0', recoveryDeadline: Date.now() + 9000 } }));
  const kept = saved('kept'), expired = saved('expired'), paused = saved('paused'), keeping = saved('keeping');
  expired.pool.recoveryDeadline = Date.now() - 1000;
  paused.status = 'paused';
  Object.assign(keeping, { status: 'keepalive', healthy: true });
  Object.assign(keeping.pool, { phase: 'keeping', recoveryDeadline: undefined });
  keeping.pool.members[0].nextAttemptAt = Date.now() + 90_000;
  const server = upstream();
  const engine = new ServerTaskEngine({ getKey: id => `sk-${id}`, fetchImpl: server.fetchImpl, notificationClient: { enqueue: async () => ({}), get: async () => ({}) } });
  t.after(() => engine.dispose());
  engine.restoreServer([kept, expired, paused, keeping]);
  await settle();
  assert.equal(engine.get(kept.id).pool.recoveryDeadline, Date.now() + 9000);
  assert.deepEqual(engine.get(kept.id).pool.members.map(member => member.sessionId), source.pool.members.map(member => member.sessionId));
  assert.equal(engine.get(expired.id).pool.phase, 'racing');
  assert.equal(engine.get(paused.id).status, 'paused');
  assert.equal(engine.get(keeping.id).pool.phase, 'recovering');
  assert.equal(engine.get(keeping.id).pool.recoveryDeadline, Date.now() + 30_000);
  // kept + keeping leaders request immediately, expired races with both members; paused sends nothing.
  assert.equal(server.calls.length, 4);
});

test('server rounds share eight slots; queued tasks start when a slot frees', async t => {
  const { engine, server } = setup(t);
  const tasks = Array.from({ length: 9 }, (_, n) => engine.create({ name: `Task ${n}`, channel: 'gpt', keyId: `key-${n}`, baseUrl: 'http://127.0.0.1:1',
    model: 'gpt-test', prompt: 'OK', maxAttempts: 5, concurrency: 1, intervalSeconds: .5, timeoutSeconds: 120, keepalive: false,
    keepaliveMinSeconds: 1, keepaliveMaxSeconds: 1, oneMillion: false, telegramChatId: '', telegramBotToken: '' }));
  t.mock.timers.tick(0);
  await settle();
  assert.equal(server.calls.length, 8);
  server.calls[0].accept(); await settle();
  server.calls[0].end(); await settle();
  assert.equal(tasks[0].status, 'accepted-completed');
  assert.equal(server.calls.length, 9);
  assert.equal(server.calls[8].token, 'sk-key-8');
});
