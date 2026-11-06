import express from 'express';
import path from 'node:path';
import fs from 'node:fs';
import QRCode from 'qrcode';
import { config } from './config.js';
import * as db from './db.js';
import { ensureVisitor, rateLimit } from './auth.js';
import { qrContent } from './xxqg/client.js';

const app = express();
app.set('trust proxy', true);
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
const visitorInfo = (req) => {
  const v = db.getVisitor(req.visitor);
  return {
    approved: Boolean(v?.approved) || !config.inviteCode,
    quota: v?.max_accounts ?? 1,
    needInvite: Boolean(config.inviteCode),
  };
};

app.get('/api/me', (req, res) => {
  const info = visitorInfo(req);
  res.json({
    visitor: req.visitor,
    accounts: db.countUsers(req.visitor),
    maxAccounts: info.quota,
    approved: info.approved,
    needInvite: info.needInvite,
  });
});

// 邀请码放行（服务端没配 INVITE_CODE 就直接全放行）
app.post('/api/register', (req, res) => {
  if (!config.inviteCode) return res.json({ ok: true, approved: true });
  const code = String(req.body?.code || '').trim();
  if (code !== config.inviteCode) {
    if (!rateLimit(`invite:${req.ip}`, 10, 60_000)) return res.status(429).json({ error: '试太多次了，等一分钟' });
    return res.status(403).json({ error: '邀请码不对' });
  }
  db.approveVisitor(req.visitor, code);
  res.json({ ok: true, approved: true });
});

// 没放行的访客挡住要花算力的接口
const needApproved = (req, res, next) => {
  if (visitorInfo(req).approved) return next();
  res.status(403).json({ error: '需要邀请码', needInvite: true });
};

app.get('/healthz', (req, res) => {
  res.json({ ok: true, queued: db.queuedCount(), workers: db.liveWorkers(), at: Date.now() });
});

// ---------- 扫码登录 ----------
app.post('/api/login/start', needApproved, (req, res) => {
  const ip = req.ip || 'x';
  if (!rateLimit(`ip:${ip}`, 12, 60_000)) return res.status(429).json({ error: '扫码太频繁，缓一分钟' });
  const quota = db.getVisitor(req.visitor)?.max_accounts ?? 1;
  if (db.countUsers(req.visitor) >= quota) {
    return res.status(400).json({ error: `最多绑定 ${quota} 个账号` });
  }
  const row = db.createLogin(req.visitor);
  res.json({ sid: row.sid });
});

app.get('/api/login/:sid', async (req, res) => {
  const row = db.getLogin(req.params.sid);
  if (!row || row.visitor_id !== req.visitor) return res.status(404).json({ error: '会话不存在' });
  const body = { status: row.status, error: row.error, uid: row.uid };
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
      res.write(`data: ${JSON.stringify({ type: e.type, payload: e.payload ? JSON.parse(e.payload) : null })}\n\n`);
    }
  }, 1000);
  req.on('close', () => clearInterval(timer));
});

// ---------- 账号 ----------
app.get('/api/users', (req, res) => {
  res.json(db.listUsers(req.visitor).map((u) => ({ ...u, last_score: u.last_score ? JSON.parse(u.last_score) : null })));
});

app.delete('/api/users/:uid', (req, res) => {
  db.deleteUser(req.params.uid, req.visitor);
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
  const active = activeJob(user.uid);
  if (active) return res.json({ jobId: active.id, tasks, queued: db.queuedCount(), reused: true });
  const id = db.enqueue({ kind: 'run', uid: user.uid, visitorId: req.visitor, tasks });
  res.json({ jobId: id, tasks, queued: db.queuedCount() });
});

// 定时：每账号一个 HH:mm，到点自动跑全套
app.post('/api/users/:uid/schedule', (req, res) => {
  const user = ownUser(req, res);
  if (!user) return;
  const at = String(req.body?.at || '').trim();
  if (!at) {
    db.setUserSchedule(user.uid, null, 0);
    return res.json({ ok: true, at: null });
  }
  if (!/^([01]\d|2[0-3]):[0-5]\d$/.test(at)) return res.status(400).json({ error: '时间要 HH:mm' });
  const next = nextRunAt(at);
  db.setUserSchedule(user.uid, at, next);
  res.json({ ok: true, at, nextAt: next });
});

function nextRunAt(hhmm) {
  const [h, m] = hhmm.split(':').map(Number);
  const t = new Date();
  t.setHours(h, m, 0, 0);
  // 今天已过就排到明天，并加 0~20 分钟抖动，别所有人整点一起挤
  if (t.getTime() <= Date.now() + 60_000) t.setDate(t.getDate() + 1);
  t.setMinutes(t.getMinutes() + Math.floor(Math.random() * 20));
  return t.getTime();
}

// 调度器：每分钟看一次谁到点了
setInterval(() => {
  for (const { uid } of db.dueSchedules()) {
    const user = db.getUser(uid);
    if (!user) continue;
    db.setUserSchedule(uid, user.schedule, nextRunAt(user.schedule));
    if (activeJob(uid)) continue;
    db.enqueue({ kind: 'run', uid, visitorId: user.visitor_id, tasks: ['login', 'article', 'video', 'daily', 'weekly', 'special'] });
    db.addEvent(null, uid, 'schedule', { text: `⏰ 到点自动开跑 ${user.schedule}` });
  }
}, 60_000).unref?.();

// 调试桥：无 CDP 的普通 Chrome 由插件把页面几何报回来（仅本机用）
app.options('/api/dev/geom', (req, res) => {
  res.setHeader('access-control-allow-origin', '*');
  res.setHeader('access-control-allow-headers', 'content-type');
  res.end();
});
app.post('/api/dev/geom', (req, res) => {
  res.setHeader('access-control-allow-origin', '*');
  fs.writeFileSync(path.join(config.dataDir, 'geom.json'), JSON.stringify(req.body || {}));
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
  if (!job || (job.visitor_id && job.visitor_id !== req.visitor)) return res.status(404).end();
  res.writeHead(200, {
    'content-type': 'text/event-stream',
    'cache-control': 'no-cache',
    connection: 'keep-alive',
    'x-accel-buffering': 'no',
  });
  let after = Number(req.query.after || 0);
  let idle = 0;
  const timer = setInterval(() => {
    for (const e of db.eventsAfter(req.params.id, after)) {
      after = e.seq;
      idle = 0;
      res.write(`id: ${e.seq}\ndata: ${JSON.stringify({ type: e.type, payload: e.payload ? JSON.parse(e.payload) : null })}\n\n`);
    }
    if (++idle > 30) {
      res.write(': ping\n\n');
      idle = 0;
    }
    const now = db.getJob(req.params.id);
    if (now && (now.status === 'done' || now.status === 'failed')) {
      res.write(`event: end\ndata: ${JSON.stringify({ status: now.status, error: now.error })}\n\n`);
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

const server = app.listen(config.port, () => {
  console.log(`API 已启动 http://127.0.0.1:${config.port}（任务由 worker 执行）key=${config.keyFingerprint}`);
});

for (const sig of ['SIGINT', 'SIGTERM']) process.on(sig, () => server.close(() => process.exit(0)));
