// 扫码截止时间：换码给新码完整时间，但整场不超过总上限
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';

process.env.DATA_DIR = mkdtempSync(path.join(tmpdir(), 'xxqg-qr-'));
const { nextQrDeadline } = await import('../src/loginflow.js');

const PER = 150_000;
const TOTAL = 300_000;

test('首码给满 150 秒', () => {
  assert.equal(nextQrDeadline({ startedAt: 0, now: 0, perCode: PER, total: TOTAL }), PER);
});

test('换码时重新计时（旧实现会把剩余时间越用越少）', () => {
  // 第 140 秒换码：旧实现只剩 10 秒，新实现重新给 150 秒
  const d = nextQrDeadline({ startedAt: 0, now: 140_000, perCode: PER, total: TOTAL });
  assert.equal(d, 290_000, `换码后应到 290s，实际 ${d / 1000}s`);
});

test('总时长封顶 5 分钟，不会一直续', () => {
  const d = nextQrDeadline({ startedAt: 0, now: 280_000, perCode: PER, total: TOTAL });
  assert.equal(d, TOTAL, `应封顶 300s，实际 ${d / 1000}s`);
});

test('截止时间永远不超过 startedAt+total', () => {
  for (const now of [0, 30_000, 149_999, 150_000, 299_999, 600_000]) {
    const d = nextQrDeadline({ startedAt: 1_000, now, perCode: PER, total: TOTAL });
    assert.ok(d <= 1_000 + TOTAL, `now=${now} 时越界：${d}`);
  }
});

test('超出总上限后截止时间落在过去，循环会退出（不会无限挂）', () => {
  const d = nextQrDeadline({ startedAt: 0, now: 600_000, perCode: PER, total: TOTAL });
  assert.ok(d <= 600_000, `应已过期，实际 ${d}`);
});
