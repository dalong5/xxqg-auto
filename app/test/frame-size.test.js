// 人工验证帧尺寸：有头模式下 viewportSize() 为 null，必须用页面实际尺寸
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { chromium } from 'playwright';

process.env.DATA_DIR = mkdtempSync(path.join(tmpdir(), 'xxqg-frame-'));
const { frameSize } = await import('../src/xxqg/browser.js');

const launch = () =>
  chromium.launch({ channel: process.env.CHROME_CHANNEL || 'chrome', executablePath: process.env.CHROME_PATH || undefined, headless: true });

test('常规 viewport 下返回真实尺寸', async () => {
  const browser = await launch();
  try {
    const page = await browser.newPage({ viewport: { width: 1024, height: 700 } });
    await page.setContent('<body>hi</body>');
    const size = await frameSize(page);
    assert.equal(size.width, 1024);
    assert.equal(size.height, 700);
  } finally {
    await browser.close();
  }
});

test('viewport 为 null（模拟有头模式）时仍返回页面尺寸，不会给前端 undefined', async () => {
  const browser = await launch();
  try {
    const ctx = await browser.newContext({ viewport: null });
    const page = await ctx.newPage();
    await page.setContent('<body>hi</body>');
    // 前提确认：这正是导致线上人工验证失效的原因
    assert.equal(page.viewportSize(), null);
    const size = await frameSize(page);
    assert.ok(size.width > 0, `width 应大于 0，实际 ${size.width}`);
    assert.ok(size.height > 0, `height 应大于 0，实际 ${size.height}`);
    await ctx.close();
  } finally {
    await browser.close();
  }
});

test('页面已关闭时安全降级为 0，不抛异常', async () => {
  const browser = await launch();
  try {
    const page = await browser.newPage({ viewport: { width: 800, height: 600 } });
    await page.close();
    const size = await frameSize(page);
    assert.equal(size.width, 800, '关闭后应回落到最后一次已知 viewport');
    assert.equal(size.height, 600);
  } finally {
    await browser.close();
  }
});
