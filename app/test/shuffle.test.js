// 阅读/视听取文章：洗牌后顺序取，避免随机重复抽到同一篇
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';

process.env.DATA_DIR = mkdtempSync(path.join(tmpdir(), 'xxqg-shuffle-'));
const { shuffle } = await import('../src/xxqg/tasks.js');

test('shuffle 不改原数组，长度与元素集合不变', () => {
  const src = [1, 2, 3, 4, 5];
  const out = shuffle(src);
  assert.deepEqual(src, [1, 2, 3, 4, 5], '原数组不能被修改');
  assert.equal(out.length, src.length);
  assert.deepEqual([...out].sort((a, b) => a - b), [1, 2, 3, 4, 5]);
});

test('顺序取队列时不会重复（对比随机取样的重复率）', () => {
  const items = Array.from({ length: 20 }, (_, i) => `item-${i}`);
  const queue = shuffle(items);
  const picked = [];
  for (let i = 0; i < 10; i++) picked.push(queue.shift());
  assert.equal(new Set(picked).size, 10, '顺序取 10 个应当全不重复');
});

test('队列取空后回退到随机，不会拿到 undefined', () => {
  const items = ['a', 'b'];
  const queue = shuffle(items);
  queue.shift();
  queue.shift();
  const fallback = queue.shift() || items[Math.floor(Math.random() * items.length)];
  assert.ok(typeof fallback === 'string' && fallback.length > 0);
});

test('注入固定随机源时结果可复现', () => {
  // 每次都要新建随机源，否则第二次调用会接着上一次的序列往下走
  const make = () => {
    const seq = [0.1, 0.9, 0.5, 0.3];
    let i = 0;
    return () => seq[i++ % seq.length];
  };
  assert.deepEqual(shuffle([1, 2, 3, 4], make()), shuffle([1, 2, 3, 4], make()));
});
