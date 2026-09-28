import assert from 'node:assert/strict';
import { createServer } from 'node:http';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { basename, dirname, join, resolve } from 'node:path';
import { pathToFileURL } from 'node:url';
import { startServer } from '../server.mjs';

export async function poolFixture(barrierCount = 0) {
  const directory = await mkdtemp(join(tmpdir(), 'anyrouter-pool-'));
  const state = { mode: 'stable', counts: new Map(), requests: [], waiting: [], closed: 0, failRemaining: 0 };
  function accept(res, channel) {
    const type = channel === 'claude' ? 'message_start' : 'response.created';
    res.write(`event: ${type}\ndata: ${JSON.stringify({ type })}\n\n`);
    res.end('data: [DONE]\n\n');
  }
  const upstream = createServer(async (req, res) => {
    if (req.url === '/v1/models') {
      res.setHeader('Access-Control-Allow-Origin', '*');
      res.end(JSON.stringify({ data: [{ id: 'gpt-pool' }, { id: 'claude-pool' }] })); return;
    }
    if (req.method === 'OPTIONS') {
      res.writeHead(204, { 'Access-Control-Allow-Origin': '*', 'Access-Control-Allow-Headers': '*' }); res.end(); return;
    }
    const chunks = [];
    for await (const chunk of req) chunks.push(chunk);
    const body = JSON.parse(Buffer.concat(chunks));
    if (req.url === '/control') { state.mode = body.mode; res.end('{}'); return; }
    const token = req.headers.authorization;
    state.counts.set(token, (state.counts.get(token) ?? 0) + 1);
    state.requests.push({ token, headers: req.headers, body });
    if (state.mode === 'busy' || state.failRemaining > 0) {
      state.failRemaining = Math.max(0, state.failRemaining - 1);
      res.writeHead(503); res.end(JSON.stringify({ error: `busy ${token}` })); return;
    }
    res.writeHead(200, { 'Content-Type': 'text/event-stream' });
    const channel = body.model.startsWith('claude') ? 'claude' : 'gpt';
    if (state.mode === 'interrupt') {
      state.mode = 'stable';
      res.write(`event: ${channel === 'gpt' ? 'response.created' : 'message_start'}\ndata: {}\n\n`);
      setTimeout(() => res.destroy(), 30); return;
    }
    if (barrierCount && state.requests.length <= barrierCount) {
      res.write('event: ping\ndata: {}\n\n');
      res.on('close', () => { state.closed++; });
      state.waiting.push({ res, channel });
      if (state.waiting.length === barrierCount) {
        // Two successes arrive together; every other connection remains open until cancelled.
        accept(state.waiting[0].res, state.waiting[0].channel);
        accept(state.waiting.at(-1).res, state.waiting.at(-1).channel);
      }
      return;
    }
    accept(res, channel);
  });
  await new Promise(done => upstream.listen(0, '127.0.0.1', done));
  const baseUrl = `http://127.0.0.1:${upstream.address().port}`;
  const options = { port: 0, dbPath: join(directory, 'notifications.sqlite') };
  let app = await startServer(options);
  async function request(path, method = 'GET', body, status = 200) {
    const response = await fetch(app.url + path, { method,
      ...(body ? { headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body) } : {}) });
    const value = await response.json();
    assert.equal(response.status, status, JSON.stringify(value));
    return value;
  }
  const keys = [];
  for (let index = 0; index < 12; index++) keys.push(await request('/api/keys', 'POST', {
    id: `pool-key-${index}`, alias: `Pool Key ${index + 1}`, value: `sk-pool-test-${index.toString().padStart(4, '0')}`,
    baseUrl, authStatus: 'ready', models: ['gpt-pool', 'claude-pool'],
  }, 201));
  const config = { name: 'Key pool integration', keyIds: keys.map(key => key.id), channel: 'gpt', model: 'gpt-pool',
    prompt: 'Reply OK', concurrency: 2, intervalSeconds: .5, timeoutSeconds: 120, keepalive: true,
    keepaliveMinSeconds: .5, keepaliveMaxSeconds: .5, telegramChatId: '', telegramBotToken: '', oneMillion: false };
  return { get url() { return app.url; }, baseUrl, state, keys, config, request,
    async restart() { await app.close(); app = await startServer(options); },
    async close() {
      await app.close(); upstream.closeAllConnections();
      await new Promise(done => upstream.close(done));
      assert.equal(dirname(resolve(directory)), resolve(tmpdir()));
      assert.ok(basename(directory).startsWith('anyrouter-pool-'));
      await rm(directory, { recursive: true, force: true });
    },
  };
}

if (process.argv[1] && import.meta.url === pathToFileURL(resolve(process.argv[1])).href) {
  const fixture = await poolFixture();
  console.log(JSON.stringify({ url: fixture.url, upstream: fixture.baseUrl }));
  process.stdin.resume();
  process.stdin.once('data', async () => { await fixture.close(); process.exit(0); });
}
