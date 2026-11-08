// 登录失效后自动退出：清 cookie、标记重扫码、拒绝再跑；重新扫码后可恢复
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';

process.env.DATA_DIR = mkdtempSync(path.join(tmpdir(), 'xxqg-logout-'));
const db = await import('../src/db.js');
const { default: app } = await import('../src/app.js');

const start = async () => {
  const server = app.listen(0, '127.0.0.1');
  await new Promise((r) => server.once('listening', r));
  const base = `http://127.0.0.1:${server.address().port}`;
  const res = await fetch(`${base}/api/me`);
  return { server, base, cookie: res.headers.get('set-cookie').split(';')[0], visitor: (await res.json()).visitor };
};

const bind = (visitor, uid = 'u-logout') =>
  db.upsertUser({ uid, visitorId: visitor, nick: '测', jar: JSON.stringify({ token: 'live' }), expiresAt: Date.now() + 86400_000 });

test('登录失效后自动退出：cookie 清空、标记重扫码、代次+1', () => {
  db.touchVisitor('v-lo-1');
  bind('v-lo-1');
  const before = db.getUser('u-logout');
  assert.ok(before.sealed_cookie, '初始应有 cookie');
  assert.equal(Number(before.needs_rescan), 0);

  db.logoutUser('u-logout');
  const after = db.getUser('u-logout');
  assert.equal(after.sealed_cookie, '', 'cookie 必须清空，不能继续拿旧凭证撞接口');
  assert.equal(Number(after.needs_rescan), 1, '应标记需要重新扫码');
  assert.ok(after.login_generation > before.login_generation, '代次应+1，让在途任务失效');
  assert.equal(db.isLoggedOut(after), true);
});

test('已退出的账号不能再启动任务，提示重新扫码', async () => {
  const { server, base, cookie, visitor } = await start();
  try {
    db.touchVisitor(visitor);
    bind(visitor, 'u-lo-run');
    db.logoutUser('u-lo-run');
    const res = await fetch(`${base}/api/users/u-lo-run/run`, {
      method: 'POST',
      headers: { cookie, 'content-type': 'application/json' },
      body: JSON.stringify({ tasks: ['daily'] }),
    });
    assert.equal(res.status, 409);
    assert.match((await res.json()).error, /登录已失效.*重新扫码/);
    // 不应留下任何任务
    assert.equal(db.db.prepare("SELECT COUNT(*) n FROM jobs WHERE uid = 'u-lo-run'").get().n, 0);
  } finally {
    server.close();
  }
});

test('已退出的账号也不能查分', async () => {
  const { server, base, cookie, visitor } = await start();
  try {
    db.touchVisitor(visitor);
    bind(visitor, 'u-lo-sync');
    db.logoutUser('u-lo-sync');
    const res = await fetch(`${base}/api/users/u-lo-sync/sync`, { method: 'POST', headers: { cookie } });
    assert.equal(res.status, 409);
    assert.match((await res.json()).error, /重新扫码/);
  } finally {
    server.close();
  }
});

test('重新扫码后自动恢复：标记清零、可以再跑任务', async () => {
  const { server, base, cookie, visitor } = await start();
  try {
    db.touchVisitor(visitor);
    bind(visitor, 'u-lo-back');
    db.logoutUser('u-lo-back');
    // 模拟重新扫码成功
    db.upsertUser({ uid: 'u-lo-back', visitorId: visitor, nick: '测', jar: JSON.stringify({ token: 'fresh' }), expiresAt: Date.now() + 86400_000 });
    const back = db.getUser('u-lo-back');
    assert.equal(Number(back.needs_rescan), 0, '重新扫码应清零标记');
    assert.ok(back.sealed_cookie, '应重新保存 cookie');
    assert.equal(db.isLoggedOut(back), false);

    const res = await fetch(`${base}/api/users/u-lo-back/run`, {
      method: 'POST',
      headers: { cookie, 'content-type': 'application/json' },
      body: JSON.stringify({ tasks: ['daily'] }),
    });
    assert.equal(res.status, 200, `重新登录后应允许启动任务，实际 ${res.status}`);
  } finally {
    server.close();
  }
});

test('启动时会把「已标记失效但还留着 cookie」的历史账号补做退出登录（幂等）', async () => {
  const fresh = await import('../src/db.js');
  fresh.touchVisitor('v-legacy');
  fresh.upsertUser({ uid: 'legacy-bad', visitorId: 'v-legacy', nick: '旧', jar: JSON.stringify({ token: 'x' }), expiresAt: 0 });
  fresh.markNeedsRescan('legacy-bad');
  assert.ok(fresh.getUser('legacy-bad').sealed_cookie, '前置：还留有 cookie');

  const changed = fresh.logoutInvalidUsers();
  assert.ok(changed >= 1, `应至少清理 1 个账号，实际 ${changed}`);
  assert.equal(fresh.getUser('legacy-bad').sealed_cookie, '');
  assert.equal(fresh.logoutInvalidUsers(), 0, '再次执行应为空操作（幂等）');
});
