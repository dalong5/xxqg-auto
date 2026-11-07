// 脏数据鲁棒性：库里半截 JSON 不能把接口/定时器打挂
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';

process.env.DATA_DIR = mkdtempSync(path.join(tmpdir(), 'xxqg-util-'));
const { parseJson } = await import('../src/util.js');
const db = await import('../src/db.js');
const { default: app } = await import('../src/app.js');

test('parseJson 对脏数据返回兜底值而不是抛错', () => {
  assert.deepEqual(parseJson('{"a":1}', null), { a: 1 });
  assert.equal(parseJson('{bad json', null), null);
  assert.equal(parseJson('', 'x'), 'x');
  assert.deepEqual(parseJson(undefined, []), []);
  assert.equal(parseJson(null, 0), 0);
  // 已经是对象时原样返回，避免二次解析（用 === 判断引用相同）
  const obj = { a: 1 };
  assert.ok(parseJson(obj, null) === obj, '对象应原样返回，不复制');
});

test('账号快照损坏时 /api/users 仍然 200，不返回 500', async () => {
  // 造一个 last_score 是半截 JSON 的账号
  db.upsertUser({ uid: 'bad-1', visitorId: 'v-bad', nick: '坏数据', jar: JSON.stringify({ token: 't' }), expiresAt: 0 });
  db.db.prepare('UPDATE users SET last_score = ? WHERE uid = ?').run('{"total":12', 'bad-1');

  const server = app.listen(0, '127.0.0.1');
  await new Promise((r) => server.once('listening', r));
  const base = `http://127.0.0.1:${server.address().port}`;
  try {
    const me = await fetch(`${base}/api/me`);
    const cookie = me.headers.get('set-cookie').split(';')[0];
    // 让账号归属到当前访客
    db.db.prepare('UPDATE users SET visitor_id = ? WHERE uid = ?').run((await me.json()).visitor, 'bad-1');
    const res = await fetch(`${base}/api/users`, { headers: { cookie } });
    assert.equal(res.status, 200, '脏快照不应导致接口 500');
    const list = await res.json();
    const target = list.find((u) => u.uid === 'bad-1');
    assert.ok(target, '账号仍应出现在列表里');
    assert.equal(target.last_score, null, '解析失败的快照应降级为 null');
  } finally {
    server.close();
  }
});

test('任务列表脏数据时退回单任务，不抛异常', async () => {
  const { parseJson: pj } = await import('../src/util.js');
  // 模拟 worker 里的兜底逻辑
  const pick = (raw, kind) => {
    const parsed = pj(raw, null);
    return Array.isArray(parsed) && parsed.length ? parsed : [kind];
  };
  assert.deepEqual(pick('["daily"]', 'run'), ['daily']);
  assert.deepEqual(pick('{bad', 'run'), ['run']);
  assert.deepEqual(pick(null, 'sync'), ['sync']);
  assert.deepEqual(pick('[]', 'run'), ['run']);
});
