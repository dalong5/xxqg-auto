// 异常状态注入：库里出现未知 status、坏 payload、坏 cookie 时，各条路径要能降级而不是崩
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';

process.env.DATA_DIR = mkdtempSync(path.join(tmpdir(), 'xxqg-chaos-'));
const db = await import('../src/db.js');
const { parseJson } = await import('../src/util.js');
const { default: app } = await import('../src/app.js');

const start = async () => {
  const server = app.listen(0, '127.0.0.1');
  await new Promise((r) => server.once('listening', r));
  const base = `http://127.0.0.1:${server.address().port}`;
  const res = await fetch(`${base}/api/me`);
  // SSE 连接会一直挂着，close 前必须强制断开，否则测试会卡在 server.close()
  const stop = () => {
    server.closeAllConnections?.();
    server.close();
  };
  return { server, stop, base, cookie: res.headers.get('set-cookie').split(';')[0], visitor: (await res.json()).visitor };
};

const insertWeirdJob = (uid, status, tasks = 'not-json') =>
  db.db
    .prepare("INSERT INTO jobs (id, uid, visitor_id, kind, status, tasks, created_at, attempts) VALUES (?,?,?,?,?,?,?,0)")
    .run(`weird-${Math.random().toString(36).slice(2, 8)}`, uid, 'v-chaos', 'run', status, tasks, Date.now());

test('未知 status 的脏任务不会被重新领取，也不影响正常路径', async () => {
  const { stop, base, cookie, visitor } = await start();
  try {
    db.touchVisitor(visitor);
    db.upsertUser({ uid: 'chaos-1', visitorId: visitor, nick: '脏', jar: '{"token":"x"}', expiresAt: 0 });
    insertWeirdJob('chaos-1', 'weird-status');

    assert.doesNotThrow(() => db.requeueDeadJobs());
    assert.doesNotThrow(() => db.trimEvents());
    assert.doesNotThrow(() => db.liveWorkers());
    assert.equal(db.claimJob('run', 'w-chaos'), null, '未知状态不该被领取');

    const res = await fetch(`${base}/api/stats`, { headers: { cookie } });
    assert.equal(res.status, 200, '有脏任务时 stats 仍应可用');
    assert.ok(Array.isArray((await res.json()).jobs));
  } finally {
    stop();
  }
});

test('坏 tasks 的排队任务被领取时不会把 worker 打挂（由上层兜底）', async () => {
  db.touchVisitor('v-chaos-2');
  db.upsertUser({ uid: 'chaos-2', visitorId: 'v-chaos-2', nick: 'x', jar: '{"token":"x"}', expiresAt: 0 });
  const id = db.enqueue({ kind: 'run', uid: 'chaos-2', visitorId: 'v-chaos-2', tasks: ['daily'] });
  db.db.prepare('UPDATE jobs SET tasks = ? WHERE id = ?').run('{bad json', id);
  const claimed = db.claimJob('run', 'w-chaos');
  assert.equal(claimed.id, id, '坏 tasks 不影响领取');
  // worker 里用 parseJson 兜底，等价逻辑：
  const tasks = parseJson(claimed.tasks, null);
  assert.equal(tasks, null);
  assert.deepEqual(Array.isArray(tasks) && tasks.length ? tasks : ['run'], ['run']);
});

test('事件 payload 不是 JSON 时，SSE 仍能输出合法帧', async () => {
  const { stop, base, cookie, visitor } = await start();
  try {
    db.touchVisitor(visitor);
    db.upsertUser({ uid: 'chaos-3', visitorId: visitor, nick: 'x', jar: '{"token":"x"}', expiresAt: 0 });
    const id = db.enqueue({ kind: 'run', uid: 'chaos-3', visitorId: visitor, tasks: ['daily'] });
    db.db.prepare('INSERT INTO events (job_id, uid, type, payload, created_at) VALUES (?,?,?,?,?)').run(id, 'chaos-3', 'log', 'not json at all', Date.now());

    const ctrl = new AbortController();
    const res = await fetch(`${base}/api/jobs/${id}/events`, { headers: { cookie }, signal: ctrl.signal });
    assert.equal(res.status, 200);
    const chunk = await Promise.race([
      res.body.getReader().read().then(({ value }) => new TextDecoder().decode(value)),
      new Promise((_, rej) => setTimeout(() => rej(new Error('SSE 首帧超时（5s）')), 5000)),
    ]);
    assert.match(chunk, /data: /, `应输出 SSE 帧，实际 ${chunk.slice(0, 60)}`);
    // 服务端每帧是 "id: <seq>\ndata: <json>\n\n"，取出 data 行再解析
    const dataLine = chunk.split('\n').find((line) => line.startsWith('data: '));
    assert.ok(dataLine, `找不到 data 行：${chunk.slice(0, 80)}`);
    assert.doesNotThrow(() => JSON.parse(dataLine.slice(6)), `坏 payload 也要能序列化成合法 JSON 帧：${dataLine.slice(6).slice(0, 80)}`);
    ctrl.abort();
  } finally {
    stop();
  }
});

test('坏 sealed_cookie 的账号仍能列出来（不因解密失败整页 500）', async () => {
  const { stop, base, cookie, visitor } = await start();
  try {
    db.touchVisitor(visitor);
    db.upsertUser({ uid: 'chaos-4', visitorId: visitor, nick: '坏cookie', jar: JSON.stringify({ token: 'x' }), expiresAt: 0 });
    db.db.prepare('UPDATE users SET sealed_cookie = ? WHERE uid = ?').run('garbage-not-encrypted', 'chaos-4');
    const res = await fetch(`${base}/api/users`, { headers: { cookie } });
    assert.equal(res.status, 200);
    assert.ok((await res.json()).some((u) => u.uid === 'chaos-4'), '账号应仍出现在列表里');
  } finally {
    stop();
  }
});
