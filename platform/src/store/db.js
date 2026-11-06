import fs from 'node:fs';
import path from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import { fileURLToPath } from 'node:url';
import { config } from '../config.js';
import { logger } from '../logger.js';

const here = path.dirname(fileURLToPath(import.meta.url));
const MIGRATIONS_DIR = path.join(here, 'migrations');

let db = null;

export function getDb() {
  if (db) return db;
  fs.mkdirSync(config.dataDir, { recursive: true });
  db = new DatabaseSync(config.dbFile);
  db.exec('PRAGMA journal_mode = WAL;');
  db.exec('PRAGMA foreign_keys = ON;');
  db.exec('PRAGMA busy_timeout = 5000;');
  migrate(db);
  return db;
}

/** 幂等迁移：migrations/*.sql 按文件名顺序执行，已执行的记在 _migrations */
export function migrate(database = getDb()) {
  database.exec('CREATE TABLE IF NOT EXISTS _migrations (name TEXT PRIMARY KEY, applied_at INTEGER NOT NULL)');
  const done = new Set(database.prepare('SELECT name FROM _migrations').all().map((r) => r.name));
  const files = fs.readdirSync(MIGRATIONS_DIR).filter((f) => f.endsWith('.sql')).sort();
  for (const file of files) {
    if (done.has(file)) continue;
    const sql = fs.readFileSync(path.join(MIGRATIONS_DIR, file), 'utf8');
    const tx = database.prepare('SELECT 1');
    tx.get();
    database.exec('BEGIN');
    try {
      database.exec(sql);
      database.prepare('INSERT INTO _migrations (name, applied_at) VALUES (?, ?)').run(file, Date.now());
      database.exec('COMMIT');
      logger.info('migration applied', { file });
    } catch (e) {
      database.exec('ROLLBACK');
      throw new Error(`迁移 ${file} 失败：${e.message}`);
    }
  }
}

export const now = () => Date.now();

/** 事务包装：抛错自动回滚 */
export function tx(fn) {
  const d = getDb();
  d.exec('BEGIN IMMEDIATE');
  try {
    const r = fn(d);
    d.exec('COMMIT');
    return r;
  } catch (e) {
    try {
      d.exec('ROLLBACK');
    } catch {}
    throw e;
  }
}
