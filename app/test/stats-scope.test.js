// /api/stats 只能看到自己的任务，不能泄露别人的队列
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';

process.env.DATA_DIR = mkdtempSync(path.join(tmpdir(), 'xxqg-stats-'));
const db = await import('../src/db.js');
const { default: app } = await import('../src/app.js');

const start = async () => {
  const server = app.listen(0, '127.0.0.1');
  await new Promise((r) => server.once('listening', r));
  return { server, base: `http://127.0.0.1:${server.address().port}` };
};

const visitorOf = async (base) => {
  const res = await fetch(`${base}/api/me`);
  const cookie = res.headers.get('set-cookie').split(';')[0];
  const { visitor } = await res.json();
  return { cookie, visitor };
};

test('别人有任务在排队时，我的 stats 里看不到', async () => {
  const { server, base } = await start();
  try {
    const me = await visitorOf(base);
    const other = await visitorOf(base);

    // 另一个访客挂一个账号 + 一个排队任务
    db.upsertUser({ uid: 'u-other', visitorId: other.visitor, nick: '别人', jar: JSON.stringify({ token: 't' }), expiresAt: 0 });
    db.enqueue({ kind: 'sync', uid: 'u-other', visitorId: other.visitor });

    const mine = await (await fetch(`${base}/api/stats`, { headers: { cookie: me.cookie } })).json();
    assert.equal(mine.queued, 0, `不应看到别人的队列，实际 ${mine.queued}`);
    const statuses = mine.jobs.map((j) => j.status);
    assert.ok(!statuses.length, `不该有任务统计，实际 ${JSON.stringify(mine.jobs)}`);

    const theirs = await (await fetch(`${base}/api/stats`, { headers: { cookie: other.cookie } })).json();
    assert.equal(theirs.queued, 1, '本人应看到自己的 1 个排队任务');
  } finally {
    server.close();
  }
});

test('自己的任务会正常统计', async () => {
  const { server, base } = await start();
  try {
    const me = await visitorOf(base);
    db.upsertUser({ uid: 'u-mine', visitorId: me.visitor, nick: '我', jar: JSON.stringify({ token: 't' }), expiresAt: 0 });
    db.enqueue({ kind: 'sync', uid: 'u-mine', visitorId: me.visitor });

    const mine = await (await fetch(`${base}/api/stats`, { headers: { cookie: me.cookie } })).json();
    assert.equal(mine.queued, 1);
    assert.equal(mine.accounts, 1);
    assert.ok(mine.jobs.some((j) => j.status === 'queued'));
  } finally {
    server.close();
  }
});
