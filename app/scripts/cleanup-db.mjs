#!/usr/bin/env node
/**
 * 数据库清理：验证码截图帧是最大的膨胀源（一次验证上百帧、每帧几十 KB）。
 *
 *   node scripts/cleanup-db.mjs           # 只看统计，不动数据
 *   node scripts/cleanup-db.mjs --apply   # 真删 + VACUUM
 *
 * 安全边界：只删「非 running 任务」的验证帧；正在人工验证的任务不受影响。
 */
import { db } from '../src/db.js';

// API 进程一直在写库（心跳/事件），VACUUM 需要独占锁。
// 不设 busy_timeout 的话，凌晨刚好有写入就会直接 SQLITE_BUSY 失败。
db.exec('PRAGMA busy_timeout = 30000');

const apply = process.argv.includes('--apply');
const pageSize = db.prepare('pragma page_size').get().page_size;
const pages = () => db.prepare('pragma page_count').get().page_count;
const free = () => db.prepare('pragma freelist_count').get().freelist_count;

const mb = (bytes) => (bytes / 1048576).toFixed(1);
const before = { size: (pages() * pageSize) / 1048576, free: (free() * pageSize) / 1048576 };

const byType = db
  .prepare('select type, count(*) n, coalesce(sum(length(payload)),0) bytes from events group by type order by bytes desc')
  .all();
console.log(`库大小 ${before.size.toFixed(1)} MB（空闲页 ${before.free.toFixed(1)} MB）`);
for (const r of byType) console.log(`  ${r.type.padEnd(14)} ${String(r.n).padStart(5)} 条  ${mb(r.bytes).padStart(7)} MB`);

const frames = db
  .prepare("select count(*) c, coalesce(sum(length(payload)),0) b from events where type in ('verification','verification-end') and job_id not in (select id from jobs where status = 'running')")
  .get();
const stale = db.prepare('select count(*) c from events where created_at < ?').get(Date.now() - 24 * 3600_000).c;
const heartbeats = db.prepare("select count(*) c from events where type = 'heartbeat'").get().c;
console.log(`\n可清理：验证帧 ${frames.c} 条（${mb(frames.b)} MB）、超 24h 事件 ${stale} 条、心跳 ${heartbeats} 条`);

if (!apply) {
  console.log('\n这是预览。加 --apply 才会删除并 VACUUM。');
  process.exit(0);
}

// node:sqlite 的 DatabaseSync 没有 .transaction()，用显式事务
db.exec('BEGIN');
let removed;
try {
  const a = db
    .prepare("delete from events where type in ('verification','verification-end') and job_id not in (select id from jobs where status = 'running')")
    .run();
  const b = db.prepare('delete from events where created_at < ?').run(Date.now() - 24 * 3600_000);
  // 心跳只留最近 200 条，够看在线状态就行
  const c = db
    .prepare("delete from events where type = 'heartbeat' and seq not in (select seq from events where type = 'heartbeat' order by seq desc limit 200)")
    .run();
  db.exec('COMMIT');
  removed = { a: a.changes, b: b.changes, c: c.changes };
} catch (e) {
  db.exec('ROLLBACK');
  throw e;
}
console.log(`\n已删除：验证帧 ${removed.a}、过期事件 ${removed.b}、旧心跳 ${removed.c}`);

// VACUUM 失败不该静默：定时任务里看不到缩容就等于白跑
try {
  db.exec('VACUUM');
} catch (e) {
  console.error(`VACUUM 失败（库被占用？）：${e.message}`);
  console.error('删除已完成，但文件没有收缩；下次清理会再试。');
  process.exit(1);
}
// WAL 模式下 VACUUM 先把页写进 -wal，必须 checkpoint 才能真正缩小主库文件
try {
  db.exec('PRAGMA wal_checkpoint(TRUNCATE)');
} catch (e) {
  console.warn(`wal_checkpoint 失败（可能有其它进程占用）：${e.message}`);
}
const after = { size: (pages() * pageSize) / 1048576, free: (free() * pageSize) / 1048576 };
console.log(`库大小 ${before.size.toFixed(1)} MB → ${after.size.toFixed(1)} MB（空闲页 ${after.free.toFixed(1)} MB）`);
// 顺带报告 WAL 大小：主库小了但 -wal 很大时磁盘占用其实没降
try {
  const { statSync } = await import('node:fs');
  const { dataDir } = await import('../src/config.js');
  const wal = statSync(`${dataDir}/app.db-wal`);
  console.log(`WAL ${(wal.size / 1048576).toFixed(1)} MB`);
} catch { /* 没有 wal 文件（已 checkpoint 或未启用 WAL）属正常 */ }
