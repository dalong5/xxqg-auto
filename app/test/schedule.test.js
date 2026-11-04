import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { spawn } from 'node:child_process';

const dataDir = mkdtempSync(path.join(tmpdir(), 'xxqg-schedule-'));
process.env.DATA_DIR = dataDir;
process.env.MAX_ACCOUNTS = '10';
const db = await import('../src/db.js');
const times = ['09:00', '10:00', '11:00', '14:00', '15:00', '16:00', '17:00'];
const before = Date.parse('2026-11-04T02:00:00Z');
const due = Date.parse('2026-11-04T03:00:00Z');

function account(uid, visitorId = 'owner', expiresAt = 0) {
  db.upsertUser({ uid, visitorId, nick: uid, jar: { token: 'fixture' }, expiresAt });
}

test('schedule validates input and defaults to disabled for each visitor', () => {
  assert.equal(db.getSchedule('owner', before).enabled, false);
  assert.throws(() => db.saveSchedule('owner', { enabled: 'true', times }, before), /启用/);
  for (const invalid of [[], ['24:00', ...times.slice(1)], ['9:00', ...times.slice(1)], [...times, '12:00']]) {
    assert.throws(() => db.saveSchedule('owner', { enabled: true, times: invalid }, before), /时间/);
  }
  db.saveSchedule('owner', { enabled: true, times }, before);
  assert.equal(db.getSchedule('owner', before).nextAt, due);
  assert.equal(db.getSchedule('stranger', before).enabled, false);
});

test('two accounts are queued once at Beijing time, including across another process', async () => {
  account('first'); account('second'); account('outsider', 'stranger');
  assert.equal(db.enqueueScheduledJobs(due - 1), 0);
  assert.equal(db.enqueueScheduledJobs(due), 2);
  assert.equal(db.enqueueScheduledJobs(due + 60_000), 0);
  const jobs = db.db.prepare('SELECT * FROM jobs ORDER BY uid').all();
  assert.deepEqual(jobs.map(j => j.uid), ['first', 'second']);
  assert.deepEqual(JSON.parse(jobs[0].tasks), ['login', 'article', 'video', 'daily']);
  const child = spawn(process.execPath, ['--input-type=module', '-e', `import * as db from './src/db.js'; console.log(db.enqueueScheduledJobs(${due})); db.db.close();`], { env: process.env, stdio: ['ignore', 'pipe', 'pipe'] });
  let output = ''; let errors = '';
  child.stdout.on('data', b => { output += b; });
  child.stderr.on('data', b => { errors += b; });
  assert.equal(await new Promise(resolve => child.on('exit', resolve)), 0, errors);
  assert.equal(output.trim(), '0');
  for (const j of jobs) db.finishJob(j.id);
});

test('busy accounts wait; disabled and newly enabled schedules never backfill earlier days', () => {
  account('busy', 'busy-owner');
  db.saveSchedule('busy-owner', { enabled: true, times }, before);
  const manual = db.enqueue({ kind: 'run', uid: 'busy', visitorId: 'busy-owner', tasks: ['daily'] });
  assert.equal(db.enqueueScheduledJobs(due), 0);
  db.finishJob(manual);
  assert.equal(db.enqueueScheduledJobs(due + 60_000), 1);
  const scheduled = db.db.prepare("SELECT id FROM jobs WHERE uid='busy' AND status='queued'").get();
  db.finishJob(scheduled.id);
  db.saveSchedule('busy-owner', { enabled: false, times }, due + 120_000);
  account('late', 'late-owner');
  db.saveSchedule('late-owner', { enabled: true, times }, due + 120_000);
  assert.equal(db.enqueueScheduledJobs(due + 180_000), 0);
  const thursday = Date.parse('2026-11-05T06:00:00Z');
  assert.equal(db.enqueueScheduledJobs(thursday), 3);
  assert.equal(db.db.prepare("SELECT count(*) AS n FROM jobs WHERE uid='busy'").get().n, 2);
});

test('expired sessions and failed scheduled jobs pause only their account until login', () => {
  for (const j of db.db.prepare("SELECT id FROM jobs WHERE status='queued'").all()) db.finishJob(j.id);
  account('expired', 'expiry-owner', due - 1);
  db.saveSchedule('expiry-owner', { enabled: true, times }, before);
  assert.equal(db.enqueueScheduledJobs(due), 0);
  assert.match(db.getSchedule('expiry-owner', due).pausedAccounts[0].reason, /登录/);
  const run = db.db.prepare("SELECT * FROM jobs WHERE uid='first' ORDER BY created_at DESC LIMIT 1").get();
  db.pauseScheduleForJob(run, '需要人工验证', false);
  assert.equal(db.getSchedule('owner', due).pausedAccounts[0].uid, 'first');
  const friday = Date.parse('2026-11-06T07:00:00Z');
  assert.equal(db.enqueueScheduledJobs(friday), 2, 'second and late run, first remains paused');
  account('first');
  assert.deepEqual(db.getSchedule('owner', friday).pausedAccounts, []);
  assert.equal(db.enqueueScheduledJobs(friday), 1);
  db.pauseScheduleForJob({ id: 'manual-risk', uid: 'second' }, 'HTTP 429', true);
  assert.equal(db.getSchedule('stranger', friday).pausedAccounts.length, 0);
  assert.equal(db.getSchedule('owner', friday).pausedAccounts[0].uid, 'second');
});

test('scheduled jobs expire at Beijing midnight and the seven weekly times repeat', () => {
  const run = db.db.prepare("SELECT job_id FROM scheduled_runs WHERE uid='first' AND run_day='2026-11-04'").get();
  assert.equal(db.scheduledJobError(db.getJob(run.job_id), Date.parse('2026-11-04T15:59:59Z')), null);
  assert.match(db.scheduledJobError(db.getJob(run.job_id), Date.parse('2026-11-04T16:00:00Z')), /往日/);
  assert.equal(db.scheduledJobError({ id: 'manual-job' }, due), null);
  for (const [at, next] of [
    ['2026-11-08T10:00:00Z', '2026-11-09T01:00:00Z'],
    ['2026-11-09T02:00:00Z', '2026-11-10T02:00:00Z'],
    ['2026-11-10T03:00:00Z', '2026-11-11T03:00:00Z'],
    ['2026-11-11T04:00:00Z', '2026-11-12T06:00:00Z'],
    ['2026-11-12T07:00:00Z', '2026-11-13T07:00:00Z'],
    ['2026-11-13T08:00:00Z', '2026-11-14T08:00:00Z'],
    ['2026-11-14T09:00:00Z', '2026-11-15T09:00:00Z'],
  ]) assert.equal(db.getSchedule('owner', Date.parse(at)).nextAt, Date.parse(next));
});

test('simultaneous schedulers atomically create one job per account', async () => {
  account('race-a', 'race'); account('race-b', 'race');
  const saturday = Date.parse('2026-11-07T08:00:00Z');
  db.saveSchedule('race', { enabled: true, times }, saturday - 3600_000);
  const counts = await Promise.all(Array.from({ length: 3 }, () => new Promise((resolve, reject) => {
    const child = spawn(process.execPath, ['--input-type=module', '-e', `import * as db from './src/db.js'; console.log(db.enqueueScheduledJobs(${saturday})); db.db.close();`], { env: process.env, stdio: ['ignore', 'pipe', 'pipe'] });
    let output = ''; let errors = '';
    child.stdout.on('data', b => { output += b; }); child.stderr.on('data', b => { errors += b; });
    child.on('error', reject);
    child.on('exit', code => code === 0 ? resolve(Number(output.trim())) : reject(new Error(errors)));
  })));
  assert.equal(counts.reduce((a, b) => a + b, 0), 2);
  assert.equal(db.db.prepare("SELECT count(*) AS n FROM scheduled_runs WHERE uid IN ('race-a','race-b')").get().n, 2);
  assert.equal(db.db.prepare("SELECT count(*) AS n FROM jobs WHERE uid IN ('race-a','race-b')").get().n, 2);
});

test('account transfer invalidates queued scheduled work and old failures cannot pause a fresh login', () => {
  const at = Date.parse('2026-11-08T09:00:00Z');
  account('transfer', 'old-owner');
  db.saveSchedule('old-owner', { enabled: true, times }, at - 3600_000);
  db.enqueueScheduledJobs(at);
  const job = db.db.prepare("SELECT * FROM jobs WHERE uid='transfer'").get();
  job.loginGeneration = db.getUser('transfer').login_generation ?? 0;
  account('transfer', 'new-owner');
  db.pauseScheduleForJob(job, 'HTTP 403 from previous session', true);
  assert.deepEqual(db.getSchedule('new-owner', at).pausedAccounts, []);
  assert.match(db.scheduledJobError(job, at), /绑定|归属/);
  const sameOwner = { id: 'older-login', uid: 'transfer', visitor_id: 'new-owner', loginGeneration: db.getUser('transfer').login_generation };
  account('transfer', 'new-owner');
  db.pauseScheduleForJob(sameOwner, 'HTTP 403 from previous login', true);
  assert.deepEqual(db.getSchedule('new-owner', at).pausedAccounts, []);
});

test.after(() => { db.db.close(); assert.equal(path.dirname(dataDir), tmpdir()); rmSync(dataDir, { recursive: true, force: true }); });
