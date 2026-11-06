import { randomUUID } from 'node:crypto';
import { logger } from '../logger.js';
import { AppError } from '../errors.js';

export function requestId(req, res, next) {
  req.id = req.headers['x-request-id'] || randomUUID().slice(0, 8);
  res.setHeader('x-request-id', req.id);
  next();
}

export function accessLog(req, res, next) {
  // 静态资源不打日志：一次页面加载要刷 3 条，把业务日志冲没了
  if (req.path.startsWith('/api/') || req.path === '/' || req.path.endsWith('.html')) {
    const t0 = process.hrtime.bigint();
    res.on('finish', () => {
      const ms = Number(process.hrtime.bigint() - t0) / 1e6;
      logger.info('http', {
        rid: req.id,
        m: req.method,
        p: req.path,
        s: res.statusCode,
        ms: Math.round(ms),
        v: req.visitor?.id,
      });
    });
  }
  next();
}

/** 包一层 async 路由，异常统一交给 errorHandler */
export const h = (fn) => (req, res, next) => Promise.resolve(fn(req, res, next)).catch(next);

export function notFound(req, _res, next) {
  next(new AppError('not_found', `没有这个接口：${req.method} ${req.path}`, 404));
}

// eslint-disable-next-line no-unused-vars
export function errorHandler(err, req, res, _next) {
  const status = err instanceof AppError ? err.status : 500;
  const code = err instanceof AppError ? err.code : 'internal_error';
  if (status >= 500) logger.error('unhandled', { rid: req.id, err: err.message, stack: err.stack?.split('\n').slice(0, 4) });
  else logger.warn('request failed', { rid: req.id, code, msg: err.message });
  if (res.headersSent) return;
  res.status(status).json({
    error: { code, message: err.message || '内部错误', details: err.details ?? undefined, requestId: req.id },
  });
}
