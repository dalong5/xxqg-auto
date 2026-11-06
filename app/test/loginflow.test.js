import { test, mock } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';

process.env.DATA_DIR = mkdtempSync(path.join(tmpdir(), 'xxqg-loginflow-'));
let scoreError;
let scoreCalls = 0;
const progress = { total: 1, today: 1, tasks: { 9: { done: 1, max: 1 } } };
mock.module('../src/xxqg/client.js', { exports: {
  Jar: class { toJSON() { return { token: 'new-fixture' }; } },
  getSign: async () => 'fixture-state',
  newQrCode: async () => 'fixture-qr',
  pollQr: async () => ({ status: 'scanned', tmpCode: 'fixture-code' }),
  secureCheck: async () => {},
  userInfo: async () => ({ uid: 'fixture-user', nick: '测试账号' }),
  score: async () => { scoreCalls++; if (scoreError) throw new Error(scoreError); return progress; },
} });
const db = await import('../src/db.js');
const { open } = await import('../src/crypto.js');
const { driveLogin } = await import('../src/loginflow.js');

function pausedAccount() {
  const user = db.upsertUser({ uid: 'fixture-user', visitorId: 'owner', nick: '测试账号', jar: { token: 'old-fixture' }, expiresAt: 0 });
  db.db.prepare('INSERT OR REPLACE INTO schedule_pauses(uid, reason) VALUES (?, ?)').run(user.uid, '需要人工验证');
  return user;
}

test('failed post-scan score checks preserve account credentials and verification pause', async t => {
  for (const message of ['HTTP 401', 'HTTP 403', 'HTTP 429 timeout', '需要人工验证', '积分接口未返回有效数据，请检查登录状态', 'fetch failed']) {
    await t.test(message, async () => {
      const previous = pausedAccount();
      const login = db.createLogin('owner');
      scoreError = message; scoreCalls = 0;
      await driveLogin(login.sid);
      assert.equal(db.getLogin(login.sid).status, 'failed', 'an unverified session must not be reported as ready');
      assert.equal(db.getUser(previous.uid).sealed_cookie, previous.sealed_cookie);
      assert.equal(db.getUser(previous.uid).login_generation, previous.login_generation);
      assert.equal(db.db.prepare('SELECT reason FROM schedule_pauses WHERE uid = ?').get(previous.uid).reason, '需要人工验证');
      assert.equal(scoreCalls, 1, 'a refusal must not cause automatic retries');
      assert.ok(!db.eventsAfter(login.sid).some(event => event.type === 'done'));
      assert.equal(db.eventsAfter(login.sid).at(-1).type, 'failed');
    });
  }
});

test('successful post-scan score checks still bind the session and clear the pause', async () => {
  const previous = pausedAccount();
  const login = db.createLogin('owner');
  scoreError = null; scoreCalls = 0;
  await driveLogin(login.sid);
  assert.equal(db.getLogin(login.sid).status, 'done');
  assert.deepEqual(open(db.getUser(previous.uid).sealed_cookie), { token: 'new-fixture' });
  assert.equal(db.getUser(previous.uid).login_generation, previous.login_generation + 1);
  assert.deepEqual(JSON.parse(db.getUser(previous.uid).last_score), progress);
  assert.equal(db.db.prepare('SELECT count(*) AS n FROM schedule_pauses').get().n, 0);
  assert.equal(scoreCalls, 1);
  assert.equal(db.eventsAfter(login.sid).at(-1).type, 'done');
});

test.after(() => { db.db.close(); rmSync(process.env.DATA_DIR, { recursive: true, force: true }); });
