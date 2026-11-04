import { test } from 'node:test';
import assert from 'node:assert/strict';
import { logText, userError, taskName } from '../src/messages.js';

test('task names and historical task logs are Chinese', () => {
  assert.equal(taskName('daily'), '每日答题');
  assert.equal(logText('▶ 开始 daily'), '▶ 开始 每日答题');
  assert.equal(logText('✔ video：视听已确认达标'), '✔ 视听学习：视听已确认达标');
  assert.equal(logText('已入队：article / daily'), '已入队：阅读文章 / 每日答题');
});
test('debug markup and browser call stacks are not exposed', () => {
  assert.doesNotMatch(logText('[dbg] <div class="action-row"><button>确定</button></div> modal=0'), /[a-zA-Z<>]/);
  assert.match(logText('✘ daily 失败：locator.click: Timeout 6000ms exceeded\nCall log: <button>'), /每日答题.*超时/);
  assert.doesNotMatch(userError('locator.click: Timeout 6000ms exceeded\nCall log: <button>'), /[a-zA-Z<>]/);
  assert.doesNotMatch(userError('Error: private-token-value'), /private-token/);
});
test('account and platform risk messages ask the user to stop and check', () => {
  assert.match(userError('平台请求失败 HTTP 429'), /频繁.*停止/);
  assert.match(userError('登录失效或请求被拒绝 (403)'), /停止.*官方/);
  assert.match(userError('slider verify failed'), /验证.*停止/);
  assert.equal(userError('积分未达标，请查看官方结果'), '积分未达标，请查看官方结果');
});
test('legacy browser selftest metrics have readable Chinese labels', () => {
  const text = logText('HTTP 200 · iframe 5 · sso true · qr 1 · 15762ms');
  assert.match(text, /响应状态 200/);
  assert.match(text, /二维码已显示/);
  assert.doesNotMatch(text, /[a-zA-Z]/);
});
