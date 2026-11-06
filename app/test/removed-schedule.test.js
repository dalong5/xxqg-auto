import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';

process.env.DATA_DIR = mkdtempSync(path.join(tmpdir(), 'xxqg-removed-schedule-'));
const db = await import('../src/db.js');

test('retired scheduled jobs cannot resume while their records and credentials remain intact', () => {
  const user = db.upsertUser({ uid: 'legacy', visitorId: 'owner', nick: '测试账号', jar: { token: 'fixture' }, expiresAt: 0 });
  const id = db.enqueue({ kind: 'run', uid: user.uid, visitorId: 'owner', tasks: ['daily'] });
  const day = new Date(Date.now() + 8 * 3600_000).toISOString().slice(0, 10);
  db.db.prepare('INSERT INTO scheduled_runs(uid, run_day, job_id) VALUES(?, ?, ?)').run(user.uid, day, id);
  assert.match(db.scheduledJobError(db.getJob(id)), /自动任务已移除/);
  assert.equal(typeof db.enqueueScheduledJobs, 'undefined');
  assert.equal(typeof db.saveSchedule, 'undefined');
  assert.equal(db.getUser(user.uid).sealed_cookie, user.sealed_cookie);
  assert.equal(db.db.prepare('SELECT count(*) AS n FROM scheduled_runs').get().n, 1);
});

test('manual jobs remain available after removing schedules', () => {
  const id = db.enqueue({ kind: 'selftest', visitorId: 'owner' });
  assert.equal(db.scheduledJobError(db.getJob(id)), null);
});

test.after(() => { db.db.close(); rmSync(process.env.DATA_DIR, { recursive: true, force: true }); });
