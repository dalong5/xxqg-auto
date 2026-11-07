// 瞬时错误重试：只重试网络类抖动，业务错误立即抛出
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';

process.env.DATA_DIR = mkdtempSync(path.join(tmpdir(), 'xxqg-retry-'));
const { retryTransient } = await import('../src/util.js');

const noSleep = { sleep: async () => {} };

test('网络抖动会重试，最终成功', async () => {
  let n = 0;
  const result = await retryTransient(
    async () => {
      n++;
      if (n < 3) throw new Error('fetch failed');
      return 'ok';
    },
    { tries: 3, ...noSleep },
  );
  assert.equal(result, 'ok');
  assert.equal(n, 3, '应重试到第 3 次');
});

test('业务错误不重试（避免无意义地打接口）', async () => {
  let n = 0;
  await assert.rejects(
    retryTransient(
      async () => {
        n++;
        throw new Error('HTTP 401 unauthorized');
      },
      { tries: 3, ...noSleep },
    ),
    /401/,
  );
  assert.equal(n, 1, '业务错误只应尝试一次');
});

test('重试用尽后抛出最后一次的错误', async () => {
  let n = 0;
  await assert.rejects(
    retryTransient(
      async () => {
        n++;
        throw new Error('ETIMEDOUT');
      },
      { tries: 2, ...noSleep },
    ),
    /ETIMEDOUT/,
  );
  assert.equal(n, 2);
});

test('第一次就成功时不会重复调用', async () => {
  let n = 0;
  const v = await retryTransient(
    async () => {
      n++;
      return 42;
    },
    { tries: 3, ...noSleep },
  );
  assert.equal(v, 42);
  assert.equal(n, 1);
});

test('超时/连接类错误都算瞬时错误', async () => {
  for (const msg of ['ECONNRESET', 'socket hang up', 'network error', 'timeout of 30000ms exceeded']) {
    let n = 0;
    await retryTransient(
      async () => {
        n++;
        if (n === 1) throw new Error(msg);
        return 'ok';
      },
      { tries: 2, ...noSleep },
    );
    assert.equal(n, 2, `${msg} 应该被重试`);
  }
});
