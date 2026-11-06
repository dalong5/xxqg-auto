import express from 'express';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { config } from '../config.js';
import { attachVisitor } from '../services/session.js';
import { requestId, accessLog, notFound, errorHandler } from './middleware.js';
import { authRouter } from './routes/auth.js';
import { accountsRouter } from './routes/accounts.js';
import { jobsRouter } from './routes/jobs.js';
import { adminRouter } from './routes/admin.js';
import { healthRouter } from './routes/health.js';

const here = path.dirname(fileURLToPath(import.meta.url));
const WEB_DIR = path.join(here, '..', '..', 'web');

export function createApp() {
  const app = express();
  app.set('trust proxy', 1);
  app.disable('x-powered-by');
  app.use(express.json({ limit: '256kb' }));
  app.use(requestId);
  app.use(accessLog);

  // 探针不要求身份
  app.use('/', healthRouter);

  app.use(attachVisitor);

  app.use('/api/v1', authRouter);
  app.use('/api/v1/accounts', accountsRouter);
  app.use('/api/v1/jobs', jobsRouter);
  app.use('/api/v1/admin', adminRouter);

  // 静态前端（无构建）
  app.use(express.static(WEB_DIR, { extensions: ['html'], maxAge: config.isProd ? '1h' : 0 }));
  app.get('/', (_req, res) => res.sendFile(path.join(WEB_DIR, 'index.html')));

  app.use(notFound);
  app.use(errorHandler);
  return app;
}
