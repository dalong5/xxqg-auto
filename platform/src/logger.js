import { config } from './config.js';

const LEVELS = { debug: 10, info: 20, warn: 30, error: 40 };
const threshold = LEVELS[config.logLevel] ?? LEVELS.info;

function emit(level, msg, fields = {}) {
  if (LEVELS[level] < threshold) return;
  const line = {
    t: new Date().toISOString(),
    level,
    msg,
    ...fields,
  };
  const out = JSON.stringify(line);
  if (level === 'error' || level === 'warn') process.stderr.write(out + '\n');
  else process.stdout.write(out + '\n');
}

export const logger = {
  debug: (msg, f) => emit('debug', msg, f),
  info: (msg, f) => emit('info', msg, f),
  warn: (msg, f) => emit('warn', msg, f),
  error: (msg, f) => emit('error', msg, f),
  /** 子 logger：自动带上 jobId/accountId 之类的上下文 */
  child(bindings = {}) {
    return {
      debug: (m, f) => emit('debug', m, { ...bindings, ...f }),
      info: (m, f) => emit('info', m, { ...bindings, ...f }),
      warn: (m, f) => emit('warn', m, { ...bindings, ...f }),
      error: (m, f) => emit('error', m, { ...bindings, ...f }),
    };
  },
};
