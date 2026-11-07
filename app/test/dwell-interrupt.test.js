// dwell 要能中途被 shouldStop 打断（否则暂停要等整段停留走完，最长 180s）
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';

process.env.DATA_DIR = mkdtempSync(path.join(tmpdir(), 'xxqg-dwell-'));
const { dwell } = await import('../src/xxqg/browser.js');

/** 最小 page 替身：humanScroll 只用到 evaluate 和 mouse.move */
const fakePage = () => {
  let scrolled = 0;
  return {
    get scrolled() { return scrolled; },
    evaluate: async () => { scrolled++; return 1000; },
    mouse: { move: async () => {} },
  };
};

test('正常停留会走完，返回 false', async () => {
  const page = fakePage();
  const result = await dwell(page, 2, null, null);
  assert.equal(result, false, '没有 shouldStop 时应正常结束');
  assert.ok(page.scrolled >= 2, '期间应该有滚动动作');
});

test('shouldStop 立即为真时立刻退出，返回 true', async () => {
  const page = fakePage();
  const started = Date.now();
  const result = await dwell(page, 60, null, () => true);
  const cost = Date.now() - started;
  assert.equal(result, true, '应报告被提前打断');
  assert.ok(cost < 2000, `不该真的等 60 秒，实际 ${cost}ms`);
});

test('中途变真也能打断（模拟暂停）', async () => {
  const page = fakePage();
  let calls = 0;
  const result = await dwell(page, 60, null, () => ++calls > 1);
  assert.equal(result, true);
});

test('shouldStop 抛 TASK_PAUSED 时异常向外传，调用方能按暂停收尾', async () => {
  const page = fakePage();
  const paused = () => {
    const e = new Error('任务已暂停');
    e.code = 'TASK_PAUSED';
    throw e;
  };
  await assert.rejects(dwell(page, 60, null, paused), (e) => e.code === 'TASK_PAUSED');
});

test('onTick 仍会回调（进度日志依赖它）', async () => {
  const page = fakePage();
  const ticks = [];
  await dwell(page, 2, (left) => ticks.push(left), null);
  assert.ok(ticks.length > 0, '应有进度回调');
});
