// 配置解析与限流内存边界测试
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';

process.env.DATA_DIR = mkdtempSync(path.join(tmpdir(), 'xxqg-conf-'));
const { positiveInt } = await import('../src/config.js');
const { rateLimit, rateLimitSize } = await import('../src/auth.js');

test('环境变量写错时回落到默认值，不会变成 NaN', () => {
  assert.equal(positiveInt('abc', 20), 20, '非数字应回落默认');
  assert.equal(positiveInt('', 20), 20, '空串应回落默认');
  assert.equal(positiveInt(undefined, 20), 20, '未设置应回落默认');
  assert.equal(positiveInt('-5', 20), 20, '负数应回落默认');
  assert.equal(positiveInt('0', 20), 20, '0 小于下限应回落默认');
  assert.equal(positiveInt('50', 20), 50, '合法值应生效');
  assert.equal(positiveInt('50.9', 20), 50, '小数应取整');
});

test('限流表不会无限增长：过期 key 会被清理', () => {
  const before = rateLimitSize();
  // 造 3000 个只请求一次的 key（窗口 1ms，很快就会全部过期）
  for (let i = 0; i < 3000; i++) rateLimit(`k-${i}`, 5, 1);
  assert.ok(rateLimitSize() < 3000, `限流表应有上限，实际 ${rateLimitSize()}`);
  assert.ok(rateLimitSize() <= 2000 + 1, '不应超过 MAX_KEYS');
});

test('限流本身仍然有效：超过阈值返回 false', () => {
  const key = 'limit-check';
  for (let i = 0; i < 3; i++) assert.equal(rateLimit(key, 3, 60_000), true);
  assert.equal(rateLimit(key, 3, 60_000), false);
});
