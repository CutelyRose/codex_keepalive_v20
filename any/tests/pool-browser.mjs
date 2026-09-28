// Optional real-Chrome check: CHROME_PATH must point to a local Chrome executable.
import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { mkdtemp, mkdir, readFile, rm, writeFile } from 'node:fs/promises';
import { dirname, basename, join, resolve } from 'node:path';
import { tmpdir } from 'node:os';
import { setTimeout as delay } from 'node:timers/promises';
import { poolFixture } from './pool-fixture.mjs';

assert.ok(process.env.CHROME_PATH, 'Set CHROME_PATH to your Chrome executable');
const profile = await mkdtemp(join(tmpdir(), 'pool-chrome-'));
const fixture = await poolFixture();
const browser = spawn(process.env.CHROME_PATH, ['--headless=new', '--no-first-run', '--no-default-browser-check',
  '--remote-debugging-port=0', `--user-data-dir=${profile}`, 'about:blank'], { windowsHide: true, stdio: 'ignore' });
const exited = new Promise(done => browser.once('exit', done));
let ws;
const pending = new Map(), errors = [];
let sequence = 0;
async function until(check, message, timeout = 8000) {
  const deadline = Date.now() + timeout;
  while (Date.now() < deadline) {
    const value = await check();
    if (value) return value;
    await delay(60);
  }
  assert.fail(message);
}
function send(method, params = {}) {
  return new Promise((resolve, reject) => {
    const id = ++sequence;
    pending.set(id, { resolve, reject });
    ws.send(JSON.stringify({ id, method, params }));
  });
}
async function evaluate(expression) {
  const response = await send('Runtime.evaluate', { expression, awaitPromise: true, returnByValue: true });
  assert.equal(response.exceptionDetails, undefined, JSON.stringify(response.exceptionDetails));
  return response.result.value;
}
try {
  const port = await until(async () => {
    try { return (await readFile(join(profile, 'DevToolsActivePort'), 'utf8')).split('\n')[0]; }
    catch (error) { if (error.code !== 'ENOENT') throw error; }
  }, 'Chrome did not start');
  const pages = await (await fetch(`http://127.0.0.1:${port}/json/list`)).json();
  ws = new WebSocket(pages.find(page => page.type === 'page').webSocketDebuggerUrl);
  await new Promise((done, fail) => { ws.onopen = done; ws.onerror = fail; });
  ws.onmessage = ({ data }) => {
    const message = JSON.parse(data);
    if (message.method === 'Runtime.exceptionThrown') errors.push(message.params.exceptionDetails);
    const callback = pending.get(message.id);
    if (callback) {
      pending.delete(message.id);
      if (message.error) callback.reject(new Error(JSON.stringify(message.error)));
      else callback.resolve(message.result);
    }
  };
  await send('Runtime.enable');
  await send('Page.enable');
  await send('Emulation.setDeviceMetricsOverride', { width: 1440, height: 1050, deviceScaleFactor: 1, mobile: false });
  await send('Page.navigate', { url: fixture.url + '/#create' });
  await until(() => evaluate("Boolean(document.querySelector('[name=taskKind]'))"), 'task form did not load');
  await evaluate("document.querySelector('[name=taskKind]').value='pool'; document.querySelector('[name=taskKind]').dispatchEvent(new Event('change',{bubbles:true})); true");
  assert.equal(await evaluate("document.querySelectorAll('[name=poolKeyIds]').length"), 12);
  assert.equal(await evaluate("Boolean(document.querySelector('[name=maxAttempts]'))"), false);
  assert.equal(await evaluate("document.querySelector('[name=scheduler]').value"), 'python');
  await evaluate("document.querySelector('[name=poolKeyIds]').click(); document.querySelectorAll('[name=poolKeyIds]')[1].click(); true");
  assert.equal(await evaluate("document.querySelectorAll('[name=poolKeyIds]:checked').length"), 2);
  await evaluate("const search=document.querySelector('[name=keyQuery]');search.value='Pool Key 1';search.dispatchEvent(new Event('input',{bubbles:true}));true");
  assert.equal(await evaluate("document.querySelectorAll('[data-pool-key-search]:not([hidden])').length"), 4);
  await evaluate("document.querySelector('[name=keyQuery]').value='';document.querySelector('[name=keyQuery]').dispatchEvent(new Event('input',{bubbles:true}));true");
  await evaluate("for(const [name,value] of [['concurrency','2'],['keepaliveMinSeconds','0.5'],['keepaliveMaxSeconds','0.5'],['intervalSeconds','0.5']]){const el=document.querySelector(`[name=${name}]`);el.value=value;el.dispatchEvent(new Event('input',{bubbles:true}));} true");
  assert.match(await evaluate("document.querySelector('[data-summary-field=concurrency]').textContent"), /2 × 2 = 4/);
  await mkdir(resolve('../artifacts'), { recursive: true });
  await writeFile(resolve('../artifacts/pool-form-desktop.png'), Buffer.from((await send('Page.captureScreenshot')).data, 'base64'));
  await evaluate("document.querySelector('#task-form').requestSubmit();true");
  await until(() => evaluate("document.querySelectorAll('.task-card').length===1 && document.body.innerText.includes('单号保活')"), 'pool did not start from the form');
  const task = (await fixture.request('/api/python/tasks'))[0];
  assert.equal(task.pool.members.length, 2);
  assert.equal(task.config.concurrency, 2);
  await evaluate("document.querySelector('.task-card [data-action=open-task]').click();true");
  await until(() => evaluate("document.querySelectorAll('.pool-member').length===2"), 'member details did not open');
  fixture.state.mode = 'busy';
  await until(() => evaluate("document.querySelector('.task-drawer').innerText.includes('单号恢复')"), 'recovery was not shown');
  const recovering = (await fixture.request('/api/python/tasks'))[0];
  await send('Page.reload');
  await until(() => evaluate("Boolean(document.querySelector('.task-card'))"), 'task did not return after reload');
  assert.equal((await fixture.request('/api/python/tasks'))[0].pool.recoveryDeadline, recovering.pool.recoveryDeadline);
  // Exercise the real 30-second deadline as well as the controlled-clock unit tests.
  const raced = await until(async () => {
    const current = (await fixture.request('/api/python/tasks'))[0];
    return current.pool.races === 2 && current;
  }, 'real 30-second deadline did not reopen the pool', 35000);
  assert.equal(raced.pool.phase, 'racing');
  assert.ok(Date.now() >= recovering.pool.recoveryDeadline);
  assert.ok(Date.now() - recovering.pool.recoveryDeadline < 1500, 'deadline was blocked by request cleanup');
  fixture.state.mode = 'stable';
  await until(async () => (await fixture.request('/api/python/tasks'))[0].pool.phase === 'keeping', 'pool did not select another winner');
  await until(() => evaluate("document.body.innerText.includes('单号保活')"), 'page did not display the recovered pool');
  await send('Emulation.setDeviceMetricsOverride', { width: 390, height: 844, deviceScaleFactor: 1, mobile: true });
  assert.equal(await evaluate('document.documentElement.scrollWidth <= window.innerWidth'), true, 'mobile page overflows horizontally');
  assert.ok(await evaluate("document.querySelector('.task-card-main').getBoundingClientRect().width >= 220"), 'mobile task title is squeezed');
  assert.ok(await evaluate("document.querySelector('.task-progress-cell').getBoundingClientRect().width >= 220"), 'mobile counters are squeezed');
  await writeFile(resolve('../artifacts/pool-task-mobile.png'), Buffer.from((await send('Page.captureScreenshot')).data, 'base64'));
  assert.deepEqual(errors, [], 'browser raised an uncaught exception');
  const count = fixture.state.requests.length;
  await send('Browser.close');
  await exited;
  await until(() => fixture.state.requests.length > count, 'closing the browser stopped Python keepalive');
  console.log('Browser passed: multiselect, search, pool creation, member details, reload, real 30-second failover, mobile layout, background keepalive.');
} finally {
  ws?.close();
  if (browser.exitCode === null) { browser.kill(); await exited; }
  await fixture.close();
  assert.equal(dirname(resolve(profile)), resolve(tmpdir()));
  assert.ok(basename(profile).startsWith('pool-chrome-'));
  await rm(profile, { recursive: true, force: true, maxRetries: 5, retryDelay: 100 });
}
