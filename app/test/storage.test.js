import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { spawn } from 'node:child_process';

process.env.DATA_DIR = mkdtempSync(path.join(tmpdir(), 'xxqg-storage-'));
process.env.MAX_ACCOUNTS = '1';
const db = await import('../src/db.js');
const { open } = await import('../src/crypto.js');

test('account cookies are encrypted at the storage boundary', () => {
  db.upsertUser({ uid: '1', visitorId: 'v', nick: 'test', jar: JSON.stringify({ token: 'secret-token' }), expiresAt: 0 });
  const stored = db.getUser('1').sealed_cookie;
  assert.ok(!stored.includes('secret-token'));
  assert.deepEqual(open(stored), { token: 'secret-token' });
});

test('one account cannot have two active jobs', () => {
  const a = db.enqueue({ kind: 'run', uid: '1', visitorId: 'v', tasks: ['article'] });
  const b = db.enqueue({ kind: 'run', uid: '1', visitorId: 'v', tasks: ['video'] });
  assert.equal(a, b);
});

test('daily score rollover uses the learning platform timezone', (t) => {
  t.mock.method(Date, 'now', () => Date.parse('2026-11-03T16:01:00Z'));
  db.setUserScore('1', { total: 1, today: 1, tasks: {} });
  assert.equal(db.getUser('1').score_day, '2026-11-04');
});

test('yesterday scores are not presented as todays cached progress', (t) => {
  t.mock.method(Date, 'now', () => Date.parse('2026-11-04T16:01:00Z'));
  assert.equal(db.listUsers('v')[0].last_score, null);
});

test('interrupted pending logins expire and emit a failure event', () => {
  const row = db.createLogin('v');
  db.updateLogin(row.sid, { status: 'waiting', created_at: Date.now() - 181000 });
  db.deleteStaleLogins();
  assert.equal(db.getLogin(row.sid).status, 'failed');
  assert.equal(db.eventsAfter(row.sid).at(-1).type, 'failed');
});

test('account limits allow refreshing the same account but reject a second account', () => {
  db.upsertUser({ uid: '1', visitorId: 'v', nick: 'updated', jar: '{}', expiresAt: 0 });
  assert.equal(db.getUser('1').nick, 'updated');
  assert.throws(() => db.upsertUser({ uid: '2', visitorId: 'v', nick: 'second', jar: '{}', expiresAt: 0 }), /最多绑定/);
});

test('a concurrent startup waits for an existing database writer', async () => {
  db.db.exec('PRAGMA journal_mode=DELETE; BEGIN EXCLUSIVE');
  const child = spawn(process.execPath, ['--input-type=module', '-e', "await import('./src/db.js')"], { env: process.env });
  let errors = '';
  child.stderr.on('data', chunk => { errors += chunk; });
  const release = setTimeout(() => db.db.exec('COMMIT'), 500);
  const code = await new Promise(resolve => child.on('exit', resolve));
  clearTimeout(release);
  if (db.db.isTransaction) db.db.exec('ROLLBACK');
  assert.equal(code, 0, errors);
});

test('unbind rejects queued and running tasks without losing account credentials', () => {
  db.upsertUser({ uid: 'unbind', visitorId: 'guard', nick: 'guard', jar: { token: 'keep' }, expiresAt: 0 });
  const id = db.enqueue({ kind: 'unbind-fixture', uid: 'unbind', visitorId: 'guard' });
  assert.equal(db.deleteUser('unbind', 'guard').changes, 0);
  db.claimJob('unbind-fixture', 'fixture');
  assert.equal(db.deleteUser('unbind', 'guard').changes, 0);
  assert.ok(db.getUser('unbind'));
  db.finishJob(id);
  assert.equal(db.deleteUser('unbind', 'other').changes, 0);
  assert.equal(db.deleteUser('unbind', 'guard').changes, 1);
});

test.after(() => { db.db.close(); rmSync(process.env.DATA_DIR, { recursive: true, force: true }); });
