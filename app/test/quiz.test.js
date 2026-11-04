import { test, mock } from 'node:test';
import assert from 'node:assert/strict';
import { chromium } from 'playwright';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';

process.env.DATA_DIR = mkdtempSync(path.join(tmpdir(), 'xxqg-quiz-'));
let page;
const questionDelays = [];
mock.module('../src/xxqg/browser.js', { exports: {
  newSession: async () => ({ page, close: async () => {} }),
  dwell() {}, jitter() {}, sleep: async ms => { questionDelays.push(ms); }, clearCaptcha: async () => true,
  safeClick: async (_page, locator) => locator.click(),
} });
const { quiz } = await import('../src/xxqg/tasks.js');

test('an incorrect answer can advance through its explanation to the next question', async () => {
  const browser = await chromium.launch({ channel: process.env.CHROME_CHANNEL || 'chrome', executablePath: process.env.CHROME_PATH || undefined, headless: true });
  try {
    page = await browser.newPage();
    await page.setContent(`<div class="my-points-card">每日答题 <button>去答题</button></div>
      <main></main><script>
      document.querySelector('.my-points-card button').onclick = () => {
        document.querySelector('main').innerHTML = '<div class="q-header">填空题</div><div class="q-body">第一题<input></div><div class="action-row"><button>确 定</button></div>';
        document.querySelector('.action-row button').onclick = function () {
          if (this.textContent !== '下一题') { this.textContent = '下一题'; return; }
          document.querySelector('main').innerHTML = '<div class="q-header">单选题</div><div class="q-body">第二题<div class="q-answer choosable">正确选项</div></div><button class="tips">查看提示</button><div class="ant-popover"><div class="line-feed"><font>正确选项</font></div></div><div class="action-row"><button disabled>完 成</button></div>';
          document.querySelector('.q-answer').onclick = () => { document.querySelector('.action-row button').disabled = false; };
          document.querySelector('.action-row button').onclick = () => { document.body.dataset.submitted = 'yes'; document.querySelector('main').innerHTML = '交卷完成'; };
        };
      };
      </script>`);
    page.goto = async () => {};
    page.waitForTimeout = async () => {};
    questionDelays.length = 0;
    const progress = Object.assign(() => ({ tasks: { 6: { done: 0, max: 5 } } }), {
      refresh: async () => ({ tasks: { 6: { done: await page.locator('body').getAttribute('data-submitted') === 'yes' ? 5 : 0, max: 5 } } }),
    });
    assert.match(await quiz('daily', { progress }), /已确认计分 5\/5/);
    assert.equal(questionDelays.length, 2, 'both questions, including the final one, must have a reading delay');
    assert.ok(questionDelays.every(ms => ms >= 20_000 && ms <= 60_000), 'each question waits 20–60 seconds');
  } finally { await browser.close(); }
});
test.after(() => rmSync(process.env.DATA_DIR, { recursive: true, force: true }));

test('daily entry waits for asynchronously rendered points cards', async () => {
  const browser = await chromium.launch({ channel: process.env.CHROME_CHANNEL || 'chrome', executablePath: process.env.CHROME_PATH || undefined, headless: true });
  try {
    page = await browser.newPage();
    await page.setContent('<main>积分加载中</main><script>setTimeout(() => { document.querySelector("main").innerHTML = `<div class="my-points-card">每日答题<button onclick="document.body.dataset.entered = \'yes\'">去答题</button></div>`; }, 500);</script>');
    page.goto = async () => {};
    page.waitForTimeout = async () => {};
    const progress = Object.assign(() => ({ tasks: { 6: { done: 0, max: 5 } } }), {
      refresh: async () => ({ tasks: { 6: { done: await page.locator('body').getAttribute('data-entered') === 'yes' ? 5 : 0, max: 5 } } }),
    });
    assert.match(await quiz('daily', { progress }), /已确认计分 5\/5/);
    assert.equal(await page.locator('body').getAttribute('data-entered'), 'yes');
  } finally { await browser.close(); }
});

test('a completed result page does not wait for the removed next button', async () => {
  const browser = await chromium.launch({ channel: process.env.CHROME_CHANNEL || 'chrome', executablePath: process.env.CHROME_PATH || undefined, headless: true });
  let timer;
  try {
    page = await browser.newPage();
    await page.setContent('<div class="my-points-card">每日答题<button>去答题</button></div><div class="q-header">单选题</div><div class="q-body">最后一题</div><div class="action-row"><button onclick="document.body.innerHTML = \'答题结果\'">确定</button></div>');
    page.goto = async () => {};
    page.waitForTimeout = async () => {};
    const progress = Object.assign(() => ({ tasks: { 6: { done: 0, max: 5 } } }), {
      refresh: async () => ({ tasks: { 6: { done: (await page.locator('body').innerText()).includes('答题结果') ? 5 : 0, max: 5 } } }),
    });
    const deadline = new Promise((_, reject) => { timer = setTimeout(() => reject(new Error('仍在等待已被移除的答题按钮')), 1500); });
    assert.match(await Promise.race([quiz('daily', { progress }), deadline]), /已确认计分 5\/5/);
  } finally { clearTimeout(timer); await browser.close(); }
});
