import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
process.env.DATA_DIR = mkdtempSync(path.join(tmpdir(), 'xxqg-client-'));
const { score, Jar } = await import('../src/xxqg/client.js');

test('unauthorized score response is rejected instead of shown as zero', async (t) => {
  t.mock.method(globalThis, 'fetch', async () => new Response(JSON.stringify({ code: 401 }), { status: 401 }));
  await assert.rejects(() => score(new Jar()), /401|登录/);
});

test('score preserves the server supplied task caps', async (t) => {
  t.mock.method(globalThis, 'fetch', async (url) => new Response(JSON.stringify({ data: url.includes('listScoreProgress')
    ? { taskProgress: [{ taskCode: [1], currentScore: 2, dayMaxScore: 7 }] } : { score: 12 } })));
  assert.deepEqual((await score(new Jar())).tasks[1], { name: '阅读文章', done: 2, max: 7 });
});

test('score includes app-only fun quiz progress from the mobile task list', async (t) => {
  const urls = [];
  t.mock.method(globalThis, 'fetch', async url => {
    urls.push(url);
    return new Response(JSON.stringify({ data: url.includes('listScoreProgress')
      ? { taskProgress: [{ taskCode: ['12'], title: '趣味答题', currentScore: 0, dayMaxScore: 10 }] }
      : { score: 32 } }));
  });
  assert.deepEqual((await score(new Jar())).tasks[12], { name: '趣味答题', done: 0, max: 10 });
  assert.ok(urls.some(url => url.includes('deviceType=1')));
});
test.after(() => rmSync(process.env.DATA_DIR, { recursive: true, force: true }));
