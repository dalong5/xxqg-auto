import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
process.env.DATA_DIR = mkdtempSync(path.join(tmpdir(), 'xxqg-captcha-'));
const { clearCaptcha } = await import('../src/xxqg/browser.js');
test('captcha without an interactive job fails explicitly, without attempting a drag', async () => {
  let moves = 0;
  const page = {
    locator: () => ({ count: async () => 1, first() { return this; }, boundingBox: async () => ({ x: 0, y: 0, width: 100, height: 20 }) }),
    mouse: { move: async () => { moves++; }, click: async () => {}, down: async () => {}, up: async () => {} },
  };
  await assert.rejects(() => clearCaptcha(page), /人工验证/);
  assert.equal(moves, 0);
});
const db = await import('../src/db.js');
test.after(() => { db.db.close(); rmSync(process.env.DATA_DIR, { recursive: true, force: true }); });
