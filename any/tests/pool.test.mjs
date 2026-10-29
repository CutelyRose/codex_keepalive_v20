import test from 'node:test';
import assert from 'node:assert/strict';
import { setTimeout as delay } from 'node:timers/promises';
import { poolFixture } from './pool-fixture.mjs';
import { validatePoolTaskConfig } from '../dist/server-core.mjs';

async function until(check, message) {
  const deadline = Date.now() + 6000;
  while (Date.now() < deadline) {
    const value = await check();
    if (value) return value;
    await delay(20);
  }
  assert.fail(message);
}

test('server pool fans out across 12 keys, keeps one winner and survives stream faults and restart', async t => {
  const fixture = await poolFixture(24);
  t.after(() => fixture.close());
  const { config, keys, state, request } = fixture;
  assert.equal(validatePoolTaskConfig(config).keyIds.length, 12);
  for (const invalid of [{ ...config, keyIds: [keys[0].id] }, { ...config, keyIds: [keys[0].id, keys[0].id] },
    { ...config, maxAttempts: 2 }, { ...config, keepalive: false }]) {
    assert.throws(() => validatePoolTaskConfig(invalid));
    await request('/api/tasks', 'POST', { config: invalid }, 400);
  }
  const task = await request('/api/tasks', 'POST', { config }, 201);
  const read = async () => (await request('/api/tasks')).find(item => item.id === task.id);
  const won = await until(async () => { const task = await read(); return task.pool.phase === 'keeping' && task; }, 'pool did not select a winner');
  assert.equal(won.attemptsMade, 24);
  assert.equal(won.successes, 1);
  await until(() => state.closed === 24, 'losing connections remained open');
  const leader = keys.find(key => key.id === won.pool.activeKeyId);
  const tokens = new Set(keys.map(key => 'Bearer ' + key.value));
  assert.equal(new Set(state.requests.slice(0, 24).map(item => item.token)).size, 12);
  const standbyCounts = new Map([...state.counts].filter(([token]) => token !== 'Bearer ' + leader.value));
  await until(async () => (await read()).successes >= 3, 'winner did not keep alive');
  for (const [token, count] of standbyCounts) assert.equal(state.counts.get(token), count, 'standby key sent another request');
  state.failRemaining = 2;
  const recovering = await until(async () => { const task = await read(); return task.pool.phase === 'recovering' && task; }, 'failure did not start recovery');
  assert.ok(recovering.pool.recoveryDeadline > Date.now() + 28000);
  const deadline = recovering.pool.recoveryDeadline;
  await until(async () => (await read()).pool.phase === 'keeping', 'leader did not recover alone');
  for (const [token, count] of standbyCounts) assert.equal(state.counts.get(token), count);
  state.mode = 'interrupt';
  await until(async () => (await read()).pool.phase === 'recovering', 'accepted stream interruption did not trigger recovery');
  await until(async () => (await read()).pool.phase === 'keeping', 'interrupted stream did not recover');
  state.mode = 'busy';
  const beforeRestart = await until(async () => { const task = await read(); return task.pool.phase === 'recovering' && task; }, 'busy mode did not start recovery');
  assert.ok(beforeRestart.pool.recoveryDeadline >= deadline);
  await fixture.restart();
  const restored = await read();
  assert.equal(restored.pool.recoveryDeadline, beforeRestart.pool.recoveryDeadline, 'restart reset the recovery deadline');
  assert.equal(restored.pool.activeKeyId, leader.id);
  assert.deepEqual(restored.pool.members.map(member => member.sessionId), won.pool.members.map(member => member.sessionId));
  assert.equal(JSON.stringify(restored).includes('Authorization'), false);
  for (const token of tokens) assert.equal(JSON.stringify(restored).includes(token.slice(7)), false, 'task view exposed credentials');
  state.mode = 'stable';
  await until(async () => (await read()).pool.phase === 'keeping', 'restored leader did not recover');
  await request(`/api/tasks/${task.id}/pause`, 'POST', {});
  const pausedCount = state.requests.length;
  await delay(650);
  assert.equal(state.requests.length, pausedCount);
  assert.equal((await read()).status, 'paused');
  await request(`/api/tasks/${task.id}/resume`, 'POST', {});
  await until(async () => (await read()).pool.phase === 'keeping', 'resume did not restore leader');
  for (const key of keys) {
    const sessions = new Set(state.requests.filter(item => item.token === 'Bearer ' + key.value).map(item => item.headers['session-id']));
    assert.equal(sessions.size, 1, 'member session changed');
  }
  const restarted = await request(`/api/tasks/${task.id}/restart`, 'POST', {}, 201);
  assert.equal(restarted.pool.members.length, 12);
  assert.notEqual(restarted.pool.members[0].sessionId, won.pool.members[0].sessionId);
  await request(`/api/keys/${keys[0].id}`, 'DELETE');
  assert.equal((await read()).status, 'cancelled');
  assert.equal((await request('/api/tasks')).find(item => item.id === restarted.id).status, 'cancelled');
  await request(`/api/tasks/${task.id}/restart`, 'POST', {}, 404);
  await request(`/api/tasks/${restarted.id}`, 'DELETE');
  await request(`/api/tasks/${task.id}`, 'DELETE');
  assert.equal((await request('/api/tasks')).length, 0);
});

test('pool validates credentials and supports Claude success signals', async t => {
  const fixture = await poolFixture();
  t.after(() => fixture.close());
  const { config, keys, request } = fixture;
  const duplicate = await request('/api/keys', 'POST', { alias: 'Duplicate', value: keys[0].value,
    baseUrl: fixture.baseUrl, authStatus: 'ready', models: ['gpt-pool'] }, 201);
  await request('/api/tasks', 'POST', { config: { ...config, keyIds: [keys[0].id, duplicate.id] } }, 400);
  const task = await request('/api/tasks', 'POST', { config: { ...config, keyIds: keys.slice(0, 2).map(key => key.id),
    channel: 'claude', model: 'claude-pool', concurrency: 1 } }, 201);
  await until(async () => (await request('/api/tasks')).some(item => item.id === task.id && item.successes >= 2), 'Claude pool did not keep alive');
  await request(`/api/tasks/${task.id}/cancel`, 'POST', {});
});
