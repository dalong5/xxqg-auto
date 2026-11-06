import fs from 'node:fs';
import path from 'node:path';
import crypto from 'node:crypto';

const env = process.env;
const num = (v, d) => (v === undefined || v === '' ? d : Number(v));
const bool = (v, d = false) => (v === undefined || v === '' ? d : /^(1|true|yes|on)$/i.test(String(v)));

export const config = {
  env: env.NODE_ENV || 'development',
  isProd: env.NODE_ENV === 'production',
  port: num(env.PORT, 8090),
  publicBaseUrl: env.PUBLIC_BASE_URL || `http://127.0.0.1:${num(env.PORT, 8090)}`,
  logLevel: env.LOG_LEVEL || 'info',

  dataDir: path.resolve(env.DATA_DIR || 'data'),
  get dbFile() {
    return path.join(this.dataDir, 'platform.db');
  },

  // 安全
  secret: env.APP_SECRET || '',
  inviteCode: (env.INVITE_CODE || '').trim(),
  defaultMaxAccounts: num(env.DEFAULT_MAX_ACCOUNTS, 1),
  sessionCookie: 'xq_s',
  sessionTtlMs: num(env.SESSION_TTL_MS, 30 * 24 * 3600_000),
  loginTtlMs: num(env.LOGIN_TTL_MS, 3 * 60_000),

  // 队列
  workerName: env.WORKER_NAME || 'w',
  workerConcurrency: num(env.WORKER_CONCURRENCY, 1),
  jobTimeoutMs: num(env.JOB_TIMEOUT_MS, 30 * 60_000),
  schedulerTickMs: num(env.SCHEDULER_TICK_MS, 60_000),
  workerStaleMs: num(env.WORKER_STALE_MS, 90_000),

  // 领域
  domainDriver: (env.DOMAIN_DRIVER || 'mock').toLowerCase(),
  legacyDomainDir: path.resolve(env.LEGACY_DOMAIN_DIR || '../app/src/xxqg'),
  headed: bool(env.XXQG_HEADED, false),
};

/** 启动前自检：不满足就直接退出，别带病跑 */
export function assertConfig() {
  const problems = [];
  if (config.isProd && (!config.secret || config.secret.length < 24)) {
    problems.push('APP_SECRET 未设置或过短（生产环境至少 24 字符）');
  }
  if (!['mock', 'xxqg'].includes(config.domainDriver)) {
    problems.push(`DOMAIN_DRIVER=${config.domainDriver} 不支持（mock | xxqg）`);
  }
  if (config.domainDriver === 'xxqg' && !fs.existsSync(config.legacyDomainDir)) {
    problems.push(`DOMAIN_DRIVER=xxqg 但找不到领域目录 ${config.legacyDomainDir}`);
  }
  if (!fs.existsSync(config.dataDir)) fs.mkdirSync(config.dataDir, { recursive: true });
  if (problems.length) {
    throw new Error(`配置错误：\n - ${problems.join('\n - ')}`);
  }
}

/** 主密钥：优先 APP_SECRET，其次 data/secret.key（原子创建，绝不覆盖） */
export function masterKey() {
  if (config.secret) return crypto.createHash('sha256').update(config.secret).digest();
  const file = path.join(config.dataDir, 'secret.key');
  if (fs.existsSync(file)) {
    const hex = fs.readFileSync(file, 'utf8').trim();
    if (hex.length === 64) return Buffer.from(hex, 'hex');
    throw new Error('data/secret.key 损坏，删除会让已存 cookie 全部失效');
  }
  const hex = crypto.randomBytes(32).toString('hex');
  fs.writeFileSync(file, hex, { flag: 'wx', mode: 0o600 });
  return Buffer.from(hex, 'hex');
}
