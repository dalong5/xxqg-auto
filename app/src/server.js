import express from 'express';
import path from 'node:path';
import QRCode from 'qrcode';
import { config } from './config.js';
import * as db from './db.js';
import { ensureVisitor, rateLimit } from './auth.js';
import { qrContent } from './xxqg/client.js';
import { TASK_NAMES, logText, userError } from './messages.js';

function eventMessage(event) {
  const payload = event.payload ? JSON.parse(event.payload) : null;
  if (typeof payload?.text === 'string') payload.text = logText(payload.text);
  if (typeof payload?.error === 'string') payload.error = userError(payload.error);
  return { type: event.type, payload };
}

const app = express();
app.set('trust proxy', 'loopback');
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

app.get('/api/login/:sid', async (req, res) => {
  const row = db.getLogin(req.params.sid);
  if (!row || row.visitor_id !== req.visitor) return res.status(404).json({ error: '会话不存在' });
  const body = { status: row.status, error: row.error ? userError(row.error) : null, uid: row.uid };
  if (row.status === 'waiting' && row.code) {
    body.qr = await QRCode.toDataURL(qrContent(row.code), { width: 220, margin: 1 });
  }
  res.json(body);
});

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
  res.json(db.listUsers(req.visitor).map((u) => ({ ...u, last_score: u.last_score ? JSON.parse(u.last_score) : null })));
});

app.delete('/api/users/:uid', (req, res) => {
  if (!ownUser(req, res)) return;
  if (!db.deleteUser(req.params.uid, req.visitor).changes) return res.status(409).json({ error: '账号有排队或运行中的任务，请等待任务结束后再解绑' });
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
      .prepare("SELECT id FROM jobs WHERE uid = ? AND status IN ('queued','running') ORDER BY created_at DESC LIMIT 1")
      .get(uid) || null
  );
}

// 只查分（走 worker 的 sync 任务，不启浏览器）
app.post('/api/users/:uid/sync', (req, res) => {
  const user = ownUser(req, res);
  if (!user) return;
  const active = activeJob(user.uid);
  if (active) return res.json({ jobId: active.id, reused: true });
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
  if (active) return res.json({ jobId: active.id, tasks, queued: db.queuedCount(), reused: true });
  const id = db.enqueue({ kind: 'run', uid: user.uid, visitorId: req.visitor, tasks });
  res.json({ jobId: id, tasks, queued: db.queuedCount() });
});

// 人工验证只转发当前任务所属访客的鼠标输入。
app.post('/api/jobs/:id/verification', (req, res) => {
  const job = db.getJob(req.params.id);
  if (!ownsJob(job, req.visitor)) return res.status(404).json({ error: '任务不存在' });
  const frame = db.db.prepare("SELECT type, payload FROM events WHERE job_id = ? AND type IN ('verification','verification-end') ORDER BY seq DESC LIMIT 1").get(job.id);
  if (job.status !== 'running' || frame?.type !== 'verification') return res.status(409).json({ error: '当前没有待处理的验证' });
  const { kind, x, y } = req.body || {};
  const { width, height } = JSON.parse(frame.payload);
  if (!['move', 'down', 'up'].includes(kind) || !Number.isFinite(x) || !Number.isFinite(y) || x < 0 || y < 0 || x > width || y > height) {
    return res.status(400).json({ error: '鼠标坐标无效' });
  }
  if (!rateLimit(`verification:${job.id}`, 120, 1000)) return res.status(429).json({ error: '操作过于频繁' });
  db.db.prepare('INSERT INTO verification_actions (job_id, kind, x, y) VALUES (?, ?, ?, ?)').run(job.id, kind, x, y);
  res.json({ ok: true });
});

// 没有账号也能跑的自检任务
app.post('/api/selftest', (req, res) => {
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
    if (now && (now.status === 'done' || now.status === 'failed')) {
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

const server = app.listen(config.port, config.host, () => {
  console.log(`API 已启动 http://127.0.0.1:${config.port}（任务由 worker 执行）key=${config.keyFingerprint}`);
});

for (const sig of ['SIGINT', 'SIGTERM']) process.on(sig, () => server.close(() => process.exit(0)));
