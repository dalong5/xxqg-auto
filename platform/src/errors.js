/** 统一错误：HTTP 层据此映射状态码，避免到处 if/else 猜 */
export class AppError extends Error {
  constructor(code, message, status = 400, details = null) {
    super(message);
    this.name = 'AppError';
    this.code = code;
    this.status = status;
    this.details = details;
  }
}

export const badRequest = (msg, details) => new AppError('bad_request', msg, 400, details);
export const unauthorized = (msg = '未登录') => new AppError('unauthorized', msg, 401);
export const forbidden = (msg = '无权访问') => new AppError('forbidden', msg, 403);
export const notFound = (msg = '资源不存在') => new AppError('not_found', msg, 404);
export const conflict = (msg) => new AppError('conflict', msg, 409);
export const tooMany = (msg, retryAfter) => new AppError('rate_limited', msg, 429, { retryAfter });
export const upstream = (msg, details) => new AppError('upstream_error', msg, 502, details);
