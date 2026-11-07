// API 健壮性测试：自检令牌去重/限流、async 路由异常不拖垮进程
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';

process.env.DATA_DIR = mkdtempSync(path.join(tmpdir(), 'xxqg-api-'));
const db = await import('../src/db.js');
const { default: app } = await import('../src/app.js');

const start = async () => {
  const server = app.listen(0, '127.0.0.1');
  await new Promise((r) => server.once('listening', r));
  return { server, base: `http://127.0.0.1:${server.address().port}` };
};

const me = async (base) => {
  const res = await fetch(`${base}/api/me`);
  return { cookie: res.headers.get('set-cookie').split(';')[0] };
};

test('自检任务按访客去重：连续调用复用同一个任务，不会无限拉起浏览器', async () => {
  const { server, base } = await start();
  try {
    const { cookie } = await me(base);
    const first = await (await fetch(`${base}/api/selftest`, { method: 'POST', headers: { cookie } })).json();
    const second = await (await fetch(`${base}/api/selftest`, { method: 'POST', headers: { cookie } })).json();
    assert.equal(second.jobId, first.jobId, '第二次应复用未结束的自检任务');
    assert.equal(second.reused, true);
    const n = db.db.prepare("SELECT COUNT(*) n FROM jobs WHERE kind = 'selftest'").get().n;
    assert.equal(n, 1, `数据库中只应有 1 个自检任务，实际 ${n}`);
  } finally {
    server.close();
  }
});

test('自检存在限流：短时间内第 4 次请求被拒', async () => {
  const { server, base } = await start();
  try {
    const { cookie } = await me(base);
    const hits = [];
    for (let i = 0; i < 4; i++) {
      const res = await fetch(`${base}/api/selftest`, { method: 'POST', headers: { cookie } });
      hits.push(res.status);
    }
    assert.deepEqual(hits.slice(0, 3), [200, 200, 200], `前三次应放行，实际 ${hits}`);
    assert.equal(hits[3], 429, `第 4 次应限流，实际 ${hits[3]}`);
  } finally {
    server.close();
  }
});

test('不存在的登录会话返回 404 而不是抛异常', async () => {
  const { server, base } = await start();
  try {
    const { cookie } = await me(base);
    const res = await fetch(`${base}/api/login/nope`, { headers: { cookie } });
    assert.equal(res.status, 404);
    assert.equal((await res.json()).error, '会话不存在');
  } finally {
    server.close();
  }
});
