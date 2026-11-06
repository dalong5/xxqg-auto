// 端到端：注册 → 扫码(mock) → 绑定账号 → 入队 → worker 执行 → 分数落库
import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'xxqg-test-'));
process.env.DATA_DIR = tmp;
process.env.NODE_ENV = 'test';
process.env.APP_SECRET = 'test-secret-0123456789abcdef';
process.env.DOMAIN_DRIVER = 'mock';
process.env.INVITE_CODE = '';

let server;
let base;
const cookies = { jar: '' };

async function call(pathname, opts = {}) {
  const res = await fetch(base + pathname, {
    ...opts,
    headers: {
      'content-type': 'application/json',
      ...(cookies.jar ? { cookie: cookies.jar } : {}),
      ...(opts.headers || {}),
    },
  });
  const setCookie = res.headers.getSetCookie?.() || [];
  for (const c of setCookie) {
    const kv = c.split(';')[0];
    if (kv.startsWith('xq_s=')) cookies.jar = kv;
  }
  const text = await res.text();
  let body;
  try {
    body = JSON.parse(text);
  } catch {
    body = text;
  }
  return { status: res.status, body };
}

before(async () => {
  const { createApp } = await import('../src/http/app.js');
  const app = createApp();
  server = app.listen(0);
  await new Promise((r) => server.on('listening', r));
  base = `http://127.0.0.1:${server.address().port}`;
});

after(async () => {
  await new Promise((r) => server.close(r));
  // Windows 上 SQLite 文件句柄可能还没释放，删不掉就算了
  try {
    fs.rmSync(tmp, { recursive: true, force: true });
  } catch {
    /* ignore */
  }
});

test('healthz 可用', async () => {
  const r = await call('/healthz');
  assert.equal(r.status, 200);
  assert.equal(r.body.ok, true);
});

test('匿名 /me 返回 driver 与额度', async () => {
  const r = await call('/api/v1/me');
  assert.equal(r.status, 200);
  assert.equal(r.body.driver, 'mock');
  assert.deepEqual(r.body.quota, { used: 0, max: 1 });
});

test('扫码 → 绑定账号 → 跑任务 → 分数上涨', async () => {
  const start = await call('/api/v1/accounts/login', { method: 'POST', body: '{}' });
  assert.equal(start.status, 200, JSON.stringify(start.body));
  const { sid } = start.body;

  // mock 驱动 2.5s 后「扫码成功」
  let done = null;
  for (let i = 0; i < 20; i++) {
    const r = await call(`/api/v1/accounts/login/${sid}`);
    if (r.body.status === 'done') {
      done = r.body;
      break;
    }
    await new Promise((x) => setTimeout(x, 400));
  }
  assert.ok(done, '扫码应完成');

  const me = await call('/api/v1/me');
  assert.equal(me.body.accounts.length, 1);
  const account = me.body.accounts[0];
  assert.equal(account.scoreToday, 0);

  const run = await call(`/api/v1/accounts/${account.id}/run`, { method: 'POST', body: JSON.stringify({ tasks: ['login', 'article', 'video'] }) });
  assert.equal(run.status, 200);
  const jobId = run.body.jobId;

  // 直接调服务层执行（测试里不起独立 worker 进程）
  const { jobs } = await import('../src/store/repo.js');
  const { runJob } = await import('../src/services/jobs.js');
  const job = jobs.get(jobId);
  const emitted = [];
  const result = await runJob(job, { onEvent: (e) => emitted.push(e) });
  jobs.finish(jobId, { status: 'done', result });

  assert.ok(emitted.length >= 3, '应有事件流过');
  const score = result.score;
  assert.equal(score.tasks['1'].done, 12);
  assert.equal(score.tasks['2'].done, 12);

  const after = await call('/api/v1/me');
  const acc2 = after.body.accounts[0];
  assert.ok(acc2.scoreToday > 0, '分数应已落库');
  assert.equal(acc2.tasks['1'].done, 12);
});

test('额度用满后再扫码返回 400', async () => {
  const r = await call('/api/v1/accounts/login', { method: 'POST', body: '{}' });
  assert.equal(r.status, 400);
  assert.match(r.body.error.message, /最多绑定/);
});

test('不存在的作业返回 404 且带 requestId', async () => {
  const r = await call('/api/v1/jobs/nope');
  assert.equal(r.status, 404);
  assert.equal(r.body.error.code, 'not_found');
  assert.ok(r.body.error.requestId);
});

test('定时接口校验时间格式', async () => {
  const me = await call('/api/v1/me');
  const id = me.body.accounts[0].id;
  const bad = await call(`/api/v1/accounts/${id}/schedule`, { method: 'PUT', body: JSON.stringify({ at: '25:99' }) });
  assert.equal(bad.status, 400);
  const ok = await call(`/api/v1/accounts/${id}/schedule`, { method: 'PUT', body: JSON.stringify({ at: '07:30' }) });
  assert.equal(ok.status, 200);
  assert.equal(ok.body.schedule.at, '07:30');
});
