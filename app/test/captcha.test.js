import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
process.env.DATA_DIR = mkdtempSync(path.join(tmpdir(), 'xxqg-captcha-'));
const { clearCaptcha, safeClick } = await import('../src/xxqg/browser.js');
test('captcha without an interactive job fails explicitly, without attempting a drag', async () => {
  let moves = 0;
  const page = {
    locator: () => ({ count: async () => 1, first() { return this; }, boundingBox: async () => ({ x: 0, y: 0, width: 100, height: 20 }) }),
    mouse: { move: async () => { moves++; }, click: async () => {}, down: async () => {}, up: async () => {} },
  };
  await assert.rejects(() => clearCaptcha(page), /人工验证/);
  assert.equal(moves, 0);
});
test('a blocked button is never clicked by forcing past page protections', async () => {
  let attempts = 0;
  const page = { locator: () => ({ count: async () => 0 }) };
  const locator = { click: async options => {
    attempts++;
    assert.notEqual(options.force, true);
    throw new Error('按钮不可操作');
  } };
  await assert.rejects(() => safeClick(page, locator), /按钮不可操作/);
  assert.equal(attempts, 1, 'without a verification dialog, stop after the original failure');
});
const db = await import('../src/db.js');
test.after(() => { db.db.close(); rmSync(process.env.DATA_DIR, { recursive: true, force: true }); });
