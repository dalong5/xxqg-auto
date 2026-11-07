// 每日答题等待秒数：脏环境变量不能变成 NaN（NaN 会让 setTimeout 立即执行）
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';

process.env.DATA_DIR = mkdtempSync(path.join(tmpdir(), 'xxqg-wait-'));
const { dailyWaitSeconds } = await import('../src/xxqg/tasks.js');

test('默认范围 20–60 秒', () => {
  for (let i = 0; i < 200; i++) {
    const s = dailyWaitSeconds({});
    assert.ok(s >= 20 && s <= 60, `实际 ${s}`);
  }
});

test('改为 3–10 秒时严格落在这个区间', () => {
  const env = { DAILY_WAIT_MIN: '3', DAILY_WAIT_MAX: '10' };
  const seen = new Set();
  for (let i = 0; i < 500; i++) {
    const s = dailyWaitSeconds(env);
    assert.ok(s >= 3 && s <= 10, `实际 ${s}`);
    seen.add(s);
  }
  assert.ok(seen.size >= 6, `应覆盖大部分取值，实际只出现 ${[...seen].sort()}`);
});

test('环境变量写错时回落默认，绝不返回 NaN', () => {
  for (const env of [
    { DAILY_WAIT_MIN: 'abc', DAILY_WAIT_MAX: 'xyz' },
    { DAILY_WAIT_MIN: '', DAILY_WAIT_MAX: '' },
    { DAILY_WAIT_MIN: '-5', DAILY_WAIT_MAX: '0' },
  ]) {
    const s = dailyWaitSeconds(env);
    assert.ok(Number.isFinite(s), `不能是 NaN/Infinity，实际 ${s}`);
    assert.ok(s >= 20 && s <= 60, `应回落 20–60，实际 ${s}`);
  }
});

test('最大值小于最小值时按下限等待，不会算出负数或 0', () => {
  const s = dailyWaitSeconds({ DAILY_WAIT_MIN: '30', DAILY_WAIT_MAX: '10' });
  assert.equal(s, 30);
});

test('sleep(NaN) 的后果验证：NaN 会被当成 0 延迟', () => {
  // 说明为什么必须挡 NaN：setTimeout(fn, NaN) 立即执行
  assert.equal(Number.isNaN(NaN), true);
  const delays = [NaN, 0].map((v) => Number(v) || 0);
  assert.deepEqual(delays, [0, 0]);
});
