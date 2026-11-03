import crypto from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';

const dataDir = path.resolve(process.env.DATA_DIR || 'data');
fs.mkdirSync(dataDir, { recursive: true });

function loadKey() {
  const p = path.join(dataDir, 'secret.key');
  if (process.env.APP_SECRET) return crypto.createHash('sha256').update(String(process.env.APP_SECRET)).digest();
  // 多个进程同时启动会抢着创建，用 wx 独占写：谁先建成谁生效，其余回读同一个文件
  try {
    const k = crypto.randomBytes(32);
    fs.writeFileSync(p, k.toString('hex'), { mode: 0o600, flag: 'wx' });
    return k;
  } catch (e) {
    if (e.code !== 'EEXIST') throw e;
    const hex = fs.readFileSync(p, 'utf8').trim();
    if (hex.length !== 64) throw new Error(`secret.key 损坏（长度 ${hex.length}），删掉它会让已存 cookie 全部失效`);
    return Buffer.from(hex, 'hex');
  }
}

const key = loadKey();
const keyFingerprint = crypto.createHash('sha256').update(key).digest('hex').slice(0, 8);

export const config = {
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
  // 邀请码：不配就谁都能用；配了就得先输对码才放行
  inviteCode: process.env.INVITE_CODE || '',
};
