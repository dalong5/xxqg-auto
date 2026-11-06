import { config, assertConfig } from './config.js';
import { logger } from './logger.js';
import { getDb } from './store/db.js';
import { createApp } from './http/app.js';
import { startScheduler } from './services/scheduler.js';
import { driverName } from './domain/index.js';

assertConfig();
getDb();

const app = createApp();
const server = app.listen(config.port, () => {
  logger.info('api listening', { port: config.port, env: config.env, driver: driverName() });
});

const stopScheduler = startScheduler();

let closing = false;
async function shutdown(signal) {
  if (closing) return;
  closing = true;
  logger.info('shutting down', { signal });
  stopScheduler();
  await new Promise((r) => server.close(r));
  // node:sqlite 无需显式关闭，进程退出即释放 WAL
  process.exit(0);
}

process.on('SIGINT', () => shutdown('SIGINT'));
process.on('SIGTERM', () => shutdown('SIGTERM'));
process.on('unhandledRejection', (e) => logger.error('unhandledRejection', { err: String(e?.message || e) }));
process.on('uncaughtException', (e) => logger.error('uncaughtException', { err: e.message, stack: e.stack?.split('\n')[2] }));
