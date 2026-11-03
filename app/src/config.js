import crypto from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';

if (fs.existsSync('.env')) process.loadEnvFile('.env');

const dataDir = path.resolve(process.env.DATA_DIR || 'data');
fs.mkdirSync(dataDir, { recursive: true });

function loadKey() {
  const p = path.join(dataDir, 'secret.key');
  if (process.env.APP_SECRET) return crypto.createHash('sha256').update(String(process.env.APP_SECRET)).digest();
  // 先完整写临时文件，再用硬链接原子发布，避免另一个进程读到空密钥。
  const temporary = `${p}.${process.pid}.${crypto.randomUUID()}.tmp`;
  const k = crypto.randomBytes(32);
  fs.writeFileSync(temporary, k.toString('hex'), { mode: 0o600, flag: 'wx' });
  try {
    fs.linkSync(temporary, p);
    return k;
  } catch (e) {
    if (e.code !== 'EEXIST') throw e;
    const hex = fs.readFileSync(p, 'utf8').trim();
    if (!/^[a-f0-9]{64}$/i.test(hex)) throw new Error('secret.key 损坏，请恢复密钥备份，不能覆盖现有密钥');
    return Buffer.from(hex, 'hex');
  } finally {
    fs.unlinkSync(temporary);
  }
}

const key = loadKey();
const keyFingerprint = crypto.createHash('sha256').update(key).digest('hex').slice(0, 8);

export const config = {
  host: process.env.HOST || '127.0.0.1',
  port: Number(process.env.PORT || 8099),
  dataDir,
  key,
  keyFingerprint,
  // 并发上限：每个账号一个浏览器上下文，1 个上下文约 150~300MB
  maxConcurrentTasks: Number(process.env.MAX_CONCURRENT || 2),
  // 单个 worker 进程的任务并发 / 扫码并发（扫码只走 HTTP，可以开很大）
  workerConcurrency: Number(process.env.WORKER_CONCURRENCY || 2),
  loginConcurrency: Number(process.env.LOGIN_CONCURRENCY || 30),
  // 每个访客最多挂几个账号（单机自用先给 1，开放注册时调大）
  maxAccounts: Number(process.env.MAX_ACCOUNTS || 1),
  // 单篇材料停留秒数（页面自己按停留时长上报，太短计不上分）
  dwellSeconds: Number(process.env.DWELL_SECONDS || 62),
  // 任务总时长上限，防止跑飞
  taskBudgetMs: Number(process.env.TASK_BUDGET_MS || 45 * 60 * 1000),
  // 学习强国 PC 端身份
  ua: 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/131.0.0.0 Safari/537.36',
  appId: 'dingoankubyrfkttorhpou',
  apiHost: 'https://pc-api.xuexi.cn',
  proxyHost: 'https://pc-proxy-api.xuexi.cn',
  loginHost: 'https://login.xuexi.cn',
  chromePath: process.env.CHROME_PATH || '',
};
