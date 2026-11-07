// 扫码窗口与过期阈值必须一致：用户还在扫不能被判过期
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';

process.env.DATA_DIR = mkdtempSync(path.join(tmpdir(), 'xxqg-stale-'));
const db = await import('../src/db.js');
const { config } = await import('../src/config.js');

const ageRow = (sid, ms) => db.db.prepare('UPDATE logins SET created_at = ? WHERE sid = ?').run(Date.now() - ms, sid);

test('默认窗口 5 分钟，过期阈值比窗口长', () => {
  assert.equal(config.loginScanTotalMs, 300_000);
  assert.equal(config.loginScanPerCodeMs, 150_000);
});

test('刚生成的扫码会话不会被清成过期', () => {
  const row = db.createLogin('v-stale-1');
  db.updateLogin(row.sid, { status: 'waiting' });
  db.deleteStaleLogins();
  assert.equal(db.getLogin(row.sid).status, 'waiting', '新会话不应被判过期');
});

test('还在 5 分钟窗口内（例如第 4 分钟）也不判过期', () => {
  const row = db.createLogin('v-stale-2');
  db.updateLogin(row.sid, { status: 'waiting' });
  ageRow(row.sid, 4 * 60_000);
  db.deleteStaleLogins();
  assert.equal(db.getLogin(row.sid).status, 'waiting', `第 4 分钟不该过期（窗口 ${config.loginScanTotalMs / 1000}s）`);
});

test('超过窗口 + 缓冲后才判过期', () => {
  const row = db.createLogin('v-stale-3');
  db.updateLogin(row.sid, { status: 'waiting' });
  ageRow(row.sid, config.loginScanTotalMs + 120_000);
  db.deleteStaleLogins();
  const after = db.getLogin(row.sid);
  assert.equal(after.status, 'failed');
  assert.match(after.error, /过期/);
});
