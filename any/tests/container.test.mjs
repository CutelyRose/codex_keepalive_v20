// Runs only against the disposable Compose project created by GitHub Actions.
import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { setTimeout as delay } from 'node:timers/promises';

const origin = process.env.ANYROUTER_ORIGIN;
assert.equal(process.env.COMPOSE_PROJECT_NAME, 'anyrouter-ci');
assert.equal(origin, 'http://127.0.0.1:8787');
const authorization = 'Basic ' + Buffer.from('admin:' + process.env.ANYROUTER_PASSWORD).toString('base64');
async function request(path, body) {
  const response = await fetch(origin + path, {
    headers: { Authorization: authorization, 'Content-Type': 'application/json' },
    ...(body ? { method: 'POST', body: JSON.stringify(body) } : {}),
    signal: AbortSignal.timeout(5000),
  });
  assert.ok(response.ok, `${path}: HTTP ${response.status}`);
  return response.json();
}
assert.equal((await fetch(origin)).status, 401);
assert.equal((await request('/api/health')).python, true);
assert.equal(execFileSync('docker', ['compose', 'exec', '-T', 'anyrouter', 'id', '-u'], { encoding: 'utf8' }).trim(), '1000');
const task = await request('/api/python/tasks', {
  token: 'sk-container-test-only',
  config: { name: 'Container persistence check', channel: 'gpt', keyId: 'ci', baseUrl: 'http://127.0.0.1:1',
    model: 'gpt-ci', prompt: 'Reply OK', maxAttempts: 1, concurrency: 1, intervalSeconds: .5, timeoutSeconds: 30,
    keepalive: false, keepaliveMinSeconds: 60, keepaliveMaxSeconds: 90,
    telegramChatId: '', telegramBotToken: '', oneMillion: false },
});
await request(`/api/python/tasks/${task.id}/pause`, {});
const saved = (await request('/api/python/tasks')).find(row => row.id === task.id);
assert.ok(['paused', 'exhausted'].includes(saved.status));
assert.equal(JSON.stringify(saved).includes('sk-container-test-only'), false);
execFileSync('docker', ['compose', 'restart'], { stdio: 'inherit' });
let ready = false;
for (let attempt = 0; attempt < 60; attempt++) {
  try { ready = (await request('/api/health')).python; } catch { /* Container is starting. */ }
  if (ready) break;
  await delay(1000);
}
assert.equal(ready, true, 'Container did not recover after restart');
const restored = (await request('/api/python/tasks')).find(row => row.id === task.id);
assert.equal(restored.sessionId, saved.sessionId);
assert.equal(restored.status, saved.status);
console.log('Container checks passed: authentication, non-root user, SQLite persistence, restart.');
