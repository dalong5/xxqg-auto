// 「跑任务」在有其它任务进行中时不能假装已入队
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';

process.env.DATA_DIR = mkdtempSync(path.join(tmpdir(), 'xxqg-run-'));
const db = await import('../src/db.js');
const { default: app } = await import('../src/app.js');

const setup = async () => {
  const server = app.listen(0, '127.0.0.1');
  await new Promise((r) => server.once('listening', r));
  const base = `http://127.0.0.1:${server.address().port}`;
  // 必须只用一次 /api/me：不带 cookie 的两次请求会各自创建新访客，导致归属对不上
  const res = await fetch(`${base}/api/me`);
  const cookie = res.headers.get('set-cookie').split(';')[0];
  const { visitor } = await res.json();
  return { server, base, visitor, cookie };
};

const addUser = (visitor, uid) => {
  db.upsertUser({ uid, visitorId: visitor, nick: '测试', jar: JSON.stringify({ token: 't' }), expiresAt: 0 });
};

test('有同步任务在跑时，启动跑任务返回 409 并说明原因', async () => {
  const { server, base, visitor, cookie } = await setup();
  try {
    addUser(visitor, 'u-run-1');
    // 造一个正在跑的 sync
    db.enqueue({ kind: 'sync', uid: 'u-run-1', visitorId: visitor });
    const jobId = db.db.prepare("SELECT id FROM jobs WHERE uid='u-run-1' AND status='queued'").get().id;
    db.db.prepare("UPDATE jobs SET status='running' WHERE id=?").run(jobId);

    const res = await fetch(`${base}/api/users/u-run-1/run`, {
      method: 'POST',
      headers: { cookie, 'content-type': 'application/json' },
      body: JSON.stringify({ tasks: ['daily'] }),
    });
    assert.equal(res.status, 409, '应返回 409 而不是假装入队');
    const body = await res.json();
    assert.match(body.error, /正在执行/);
    assert.equal(body.jobId, jobId);
  } finally {
    server.close();
  }
});

test('已有同账号跑任务时复用，并返回真实的 tasks', async () => {
  const { server, base, visitor, cookie } = await setup();
  try {
    addUser(visitor, 'u-run-2');
    db.enqueue({ kind: 'run', uid: 'u-run-2', visitorId: visitor, tasks: ['article'] });
    const jobId = db.db.prepare("SELECT id FROM jobs WHERE uid='u-run-2' AND status='queued'").get().id;

    const res = await fetch(`${base}/api/users/u-run-2/run`, {
      method: 'POST',
      headers: { cookie, 'content-type': 'application/json' },
      body: JSON.stringify({ tasks: ['video'] }),
    });
    assert.equal(res.status, 200);
    const body = await res.json();
    assert.equal(body.jobId, jobId);
    assert.equal(body.reused, true);
    assert.deepEqual(body.tasks, ['article'], '应返回实际在跑的任务而不是本次请求的');
  } finally {
    server.close();
  }
});
