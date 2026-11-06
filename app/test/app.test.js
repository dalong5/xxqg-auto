import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';

process.env.DATA_DIR = mkdtempSync(path.join(tmpdir(), 'xxqg-app-'));
const db = await import('../src/db.js');

test('HTTP application can be imported and served without process lifecycle side effects', async () => {
  const before = ['SIGINT', 'SIGTERM'].map(signal => process.listenerCount(signal));
  const { default: app } = await import('../src/app.js');
  assert.deepEqual(['SIGINT', 'SIGTERM'].map(signal => process.listenerCount(signal)), before);
  const server = app.listen(0, '127.0.0.1');
  try {
    await new Promise(resolve => server.once('listening', resolve));
    const base = `http://127.0.0.1:${server.address().port}`;
    const health = await (await fetch(`${base}/healthz`)).json();
    assert.equal(health.ok, true);
    assert.equal(health.workers, 0);
    const response = await fetch(`${base}/api/me`);
    assert.match(response.headers.get('set-cookie'), /HttpOnly/);
    const cookie = response.headers.get('set-cookie').split(';')[0];
    const me = await response.json();
    assert.equal(me.taskNames.daily, '每日答题');
    assert.deepEqual(await (await fetch(`${base}/api/users`, { headers: { cookie } })).json(), []);
    assert.equal((await fetch(`${base}/api/users/other/run`, { method: 'POST', headers: { cookie } })).status, 404);
    const page = await fetch(`${base}/`);
    assert.equal(page.status, 200);
    assert.doesNotMatch(await page.text(), /每周自动任务|\/api\/schedule|scheduleFields/);
    assert.equal((await fetch(`${base}/api/schedule`, { headers: { cookie } })).status, 404);
    assert.equal((await fetch(`${base}/api/schedule`, { method: 'PUT', headers: { cookie, 'content-type': 'application/json' }, body: JSON.stringify({ enabled: true, times: [] }) })).status, 404);
  } finally { await new Promise(resolve => server.close(resolve)); }
});

test.after(() => { db.db.close(); rmSync(process.env.DATA_DIR, { recursive: true, force: true }); });
