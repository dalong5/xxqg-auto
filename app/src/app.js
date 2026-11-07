import express from 'express';
import path from 'node:path';
import QRCode from 'qrcode';
import { config } from './config.js';
import * as db from './db.js';
import { ensureVisitor, rateLimit } from './auth.js';
import { qrContent } from './xxqg/client.js';
import { TASK_NAMES, logText, userError } from './messages.js';
import { parseJson } from './util.js';

function eventMessage(event) {
  const payload = event.payload ? parseJson(event.payload, null) : null;
  if (typeof payload?.text === 'string') payload.text = logText(payload.text);
  if (typeof payload?.error === 'string') payload.error = userError(payload.error);
  return { type: event.type, payload };
}

const app = express();
app.set('trust proxy', 'loopback');

/**
 * Express 4 不会捕获 async 处理器抛出的异常，未处理的 Promise rejection 在 Node 24
 * 默认会让进程退出。统一包一层，把错误交给错误中间件，避免一个坏二维码打挂整个 API。
 */
const asyncRoute = (fn) => (req, res, next) => Promise.resolve(fn(req, res, next)).catch(next);
app.use(express.json());
app.use(express.static(path.join(process.cwd(), 'public')));
app.get('/favicon.ico', (req, res) => res.status(204).end());

// 每个请求绑定访客会话，多人同时访问各自独立
app.use((req, res, next) => {
  const { id, fresh } = ensureVisitor(req, res);
  req.visitor = id;
  if (fresh) db.touchVisitor(id);
  next();
});

// ---------- 会话 ----------
app.get('/api/me', (req, res) => {
  res.json({ visitor: req.visitor, accounts: db.countUsers(req.visitor), maxAccounts: config.maxAccounts, taskNames: TASK_NAMES });
});

app.get('/healthz', (req, res) => {
  res.json({ ok: true, queued: db.queuedCount(), workers: db.liveWorkers(), at: Date.now() });
});

// ---------- 扫码登录 ----------
app.post('/api/login/start', (req, res) => {
  const ip = req.ip || 'x';
  if (!rateLimit(`ip:${ip}`, 12, 60_000)) return res.status(429).json({ error: '扫码太频繁，缓一分钟' });
  const row = db.createLogin(req.visitor);
  res.json({ sid: row.sid });
});

app.get('/api/login/:sid', asyncRoute(async (req, res) => {
  const row = db.getLogin(req.params.sid);
  if (!row || row.visitor_id !== req.visitor) return res.status(404).json({ error: '会话不存在' });
  const body = { status: row.status, error: row.error ? userError(row.error) : null, uid: row.uid };
  if (row.status === 'waiting' && row.code) {
    body.qr = await QRCode.toDataURL(qrContent(row.code), { width: 220, margin: 1 });
  }
  res.json(body);
}));

// 登录事件流（SSE）：二维码轮换、成功、失败
app.get('/api/login/:sid/events', (req, res) => {
  const row = db.getLogin(req.params.sid);
  if (!row || row.visitor_id !== req.visitor) return res.status(404).end();
  res.writeHead(200, { 'content-type': 'text/event-stream', 'cache-control': 'no-cache', connection: 'keep-alive' });
  let after = 0;
  const timer = setInterval(() => {
    for (const e of db.eventsAfter(req.params.sid, after)) {
      after = e.seq;
      res.write(`data: ${JSON.stringify(eventMessage(e))}\n\n`);
    }
  }, 1000);
  req.on('close', () => clearInterval(timer));
});

// ---------- 账号 ----------
app.get('/api/users', (req, res) => {
  res.json(db.listUsers(req.visitor).map((u) => ({ ...u, last_score: parseJson(u.last_score, null) })));
});

app.delete('/api/users/:uid', (req, res) => {
  if (!ownUser(req, res)) return;
  if (!db.deleteUser(req.params.uid, req.visitor).changes) return res.status(409).json({ error: '账号有未结束的任务，请先继续并等待结束后再解绑' });
  res.json({ ok: true });
});

function ownUser(req, res) {
  const user = db.getUser(req.params.uid);
  if (!user || user.visitor_id !== req.visitor) {
    res.status(404).json({ error: '账号不存在' });
    return null;
  }
  return user;
}

function ownsJob(job, visitor) {
  return job && (job.uid ? db.getUser(job.uid)?.visitor_id === visitor : job.visitor_id === visitor);
}

// 同一账号同时只允许一个任务在跑/排队，避免自己踩自己
function activeJob(uid) {
  return (
    db.db
      .prepare("SELECT id, status FROM jobs WHERE uid = ? AND status IN ('queued','running','pausing','paused') ORDER BY created_at DESC LIMIT 1")
      .get(uid) || null
  );
}

// 只查分（走 worker 的 sync 任务，不启浏览器）
app.post('/api/users/:uid/sync', (req, res) => {
  const user = ownUser(req, res);
  if (!user) return;
  const active = activeJob(user.uid);
  if (active) return res.json({ jobId: active.id, status: active.status, reused: true });
  const id = db.enqueue({ kind: 'sync', uid: user.uid, visitorId: req.visitor });
  res.json({ jobId: id });
});

// 跑任务
app.post('/api/users/:uid/run', (req, res) => {
  const user = ownUser(req, res);
  if (!user) return;
  const asked = Array.isArray(req.body?.tasks) && req.body.tasks.length ? req.body.tasks : ['login', 'article', 'video', 'daily'];
  const tasks = asked.filter((t) => ['login', 'article', 'video', 'daily', 'weekly', 'special'].includes(t));
  if (!tasks.length || tasks.length !== asked.length) return res.status(400).json({ error: '任务类型无效' });
  const active = activeJob(user.uid);
  if (active) return res.json({ jobId: active.id, status: active.status, tasks, queued: db.queuedCount(), reused: true });
  const id = db.enqueue({ kind: 'run', uid: user.uid, visitorId: req.visitor, tasks });
  res.json({ jobId: id, tasks, queued: db.queuedCount() });
});

// 暂停必须等原执行器关闭会话后才允许继续，避免同账号并行。
for (const action of ['pause', 'resume']) app.post(`/api/jobs/:id/${action}`, (req, res) => {
  const job = db.getJob(req.params.id);
  if (!ownsJob(job, req.visitor) || job.visitor_id !== req.visitor) return res.status(404).json({ error: '任务不存在' });
  const result = action === 'pause' ? db.requestJobPause(job.id, req.visitor) : db.resumeJob(job.id, req.visitor);
  if (!result) return res.status(409).json({ error: action === 'pause' ? '当前任务不能暂停' : '任务尚未暂停或已经结束，请刷新状态后重试' });
  if (result.status !== job.status) db.addEvent(job.id, job.uid, 'log', { text: action === 'resume' ? '任务已继续，等待执行器回查官方进度' : result.status === 'paused' ? '任务已暂停，可点击继续任务' : '收到暂停请求，等待当前页面操作结束' });
  res.json({ jobId: job.id, status: result.status });
});

// 人工验证只转发当前任务所属访客的鼠标输入。
app.post('/api/jobs/:id/verification', (req, res) => {
  const job = db.getJob(req.params.id);
  if (!ownsJob(job, req.visitor)) return res.status(404).json({ error: '任务不存在' });
  const frame = db.db.prepare("SELECT type, payload FROM events WHERE job_id = ? AND type IN ('verification','verification-end') ORDER BY seq DESC LIMIT 1").get(job.id);
  if (job.status !== 'running' || frame?.type !== 'verification') return res.status(409).json({ error: '当前没有待处理的验证' });
  const { kind, x, y } = req.body || {};
  const { width, height } = parseJson(frame.payload, {});
  if (!['move', 'down', 'up'].includes(kind) || !Number.isFinite(x) || !Number.isFinite(y) || x < 0 || y < 0 || x > width || y > height) {
    return res.status(400).json({ error: '鼠标坐标无效' });
  }
  if (!rateLimit(`verification:${job.id}`, 120, 1000)) return res.status(429).json({ error: '操作过于频繁' });
  db.db.prepare('INSERT INTO verification_actions (job_id, kind, x, y) VALUES (?, ?, ?, ?)').run(job.id, kind, x, y);
  res.json({ ok: true });
});

// 没有账号也能跑的自检任务
// 注意：自检没有 uid，enqueue 的去重逻辑不生效，必须在这里按访客去重 + 限流，
// 否则一个访客可以无限入队，每次都拉起一个浏览器，直接把机器内存打满。
app.post('/api/selftest', (req, res) => {
  if (!rateLimit(`selftest:${req.visitor}`, 3, 300_000)) {
    return res.status(429).json({ error: '自检太频繁，请 5 分钟后再试' });
  }
  const active = db.findActiveJob(req.visitor, 'selftest');
  if (active) return res.json({ jobId: active.id, status: active.status, reused: true });
  const id = db.enqueue({ kind: 'selftest', visitorId: req.visitor });
  res.json({ jobId: id });
});

// ---------- 任务事件（SSE，带重连续传） ----------
app.get('/api/jobs/:id/events', (req, res) => {
  const job = db.getJob(req.params.id);
  if (!ownsJob(job, req.visitor)) return res.status(404).end();
  res.writeHead(200, {
    'content-type': 'text/event-stream',
    'cache-control': 'no-cache',
    connection: 'keep-alive',
    'x-accel-buffering': 'no',
  });
  let after = Number(req.headers['last-event-id'] || req.query.after || 0);
  if (!Number.isSafeInteger(after) || after < 0) after = 0;
  let idle = 0;
  const timer = setInterval(() => {
    if (!ownsJob(db.getJob(job.id), req.visitor)) {
      clearInterval(timer);
      res.end();
      return;
    }
    let batch;
    do {
      batch = db.eventsAfter(req.params.id, after);
      for (const e of batch) {
        after = e.seq;
        idle = 0;
        res.write(`id: ${e.seq}\ndata: ${JSON.stringify(eventMessage(e))}\n\n`);
      }
    } while (batch.length === 200);
    if (++idle > 30) {
      res.write(': ping\n\n');
      idle = 0;
    }
    const now = db.getJob(req.params.id);
    if (now && (now.status === 'done' || now.status === 'failed' || now.status === 'paused')) {
      res.write(`event: end\ndata: ${JSON.stringify({ status: now.status, error: now.error ? userError(now.error) : null })}\n\n`);
      clearInterval(timer);
      res.end();
    }
  }, 800);
  req.on('close', () => clearInterval(timer));
});

app.get('/api/stats', (req, res) => {
  const jobs = db.db.prepare('SELECT status, COUNT(*) n FROM jobs GROUP BY status').all();
  res.json({ queued: db.queuedCount(), jobs, accounts: db.countUsers(req.visitor) });
});

// 兜底错误中间件：任何路由抛错都转成 JSON 500，而不是让进程挂掉
app.use((err, req, res, next) => {  // eslint-disable-line no-unused-vars
  console.error('[api] %s %s 出错：%s', req.method, req.originalUrl, err?.stack || err);
  if (res.headersSent) return;
  res.status(500).json({ error: '服务内部错误，请稍后重试' });
});

export default app;
