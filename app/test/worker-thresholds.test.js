// 执行器三个阈值必须走 positiveInt：NaN 会让看门狗静默失效、空闲关浏览器变成每次轮询都关
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

process.env.DATA_DIR = mkdtempSync(path.join(tmpdir(), 'xxqg-cfg2-'));
const { config } = await import('../src/config.js');

const here = path.dirname(fileURLToPath(import.meta.url));
const appDir = path.join(here, '..');

/** 在干净进程里用指定环境变量读 config，验证回落逻辑 */
const readConfig = (env) => {
  const code = `import('./src/config.js').then(m => console.log(JSON.stringify({
    idle: m.config.browserIdleCloseMs,
    dog: m.config.watchdogSilenceMs,
    mem: m.config.workerMinFreeMb,
  })))`;
  const out = execFileSync(process.execPath, ['-e', code], {
    cwd: appDir,
    env: { ...process.env, ...env, DATA_DIR: mkdtempSync(path.join(tmpdir(), 'xxqg-cfg2-child-')) },
    encoding: 'utf8',
  });
  return JSON.parse(out.trim().split('\n').pop());
};

test('默认值符合预期', () => {
  assert.equal(config.browserIdleCloseMs, 120_000);
  assert.equal(config.watchdogSilenceMs, 600_000);
  assert.equal(config.workerMinFreeMb, 200);
});

test('环境变量写错时回落到默认，不会变成 NaN', () => {
  const c = readConfig({ BROWSER_IDLE_CLOSE_MS: 'abc', WATCHDOG_SILENCE_MS: 'oops', WORKER_MIN_FREE_MB: '' });
  assert.equal(c.idle, 120_000);
  assert.equal(c.dog, 600_000);
  assert.equal(c.mem, 200);
  for (const v of Object.values(c)) assert.ok(Number.isFinite(v), `不能是 NaN，实际 ${v}`);
});

test('合法值会被采纳', () => {
  const c = readConfig({ BROWSER_IDLE_CLOSE_MS: '30000', WATCHDOG_SILENCE_MS: '120000', WORKER_MIN_FREE_MB: '64' });
  assert.deepEqual(c, { idle: 30_000, dog: 120_000, mem: 64 });
});

test('负数/0 视为非法', () => {
  const c = readConfig({ BROWSER_IDLE_CLOSE_MS: '-1', WATCHDOG_SILENCE_MS: '0', WORKER_MIN_FREE_MB: '-99' });
  assert.deepEqual(c, { idle: 120_000, dog: 600_000, mem: 200 });
});
