#!/usr/bin/env node
/** 独立迁移入口：npm run migrate（启动时也会自动执行一次） */
import { getDb } from './db.js';
import { config } from '../config.js';
import { logger } from '../logger.js';

const db = getDb();
const applied = db.prepare('SELECT name, applied_at FROM _migrations ORDER BY name').all();
logger.info('migrations up to date', { db: config.dbFile, applied: applied.map((r) => r.name) });
console.log(`OK  ${applied.length} migration(s) applied → ${config.dbFile}`);
