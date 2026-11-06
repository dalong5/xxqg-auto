import { test, mock } from 'node:test';
import assert from 'node:assert/strict';
import { EventEmitter } from 'node:events';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';

process.env.DATA_DIR = mkdtempSync(path.join(tmpdir(), 'xxqg-browser-'));
let launch;
let calls = 0;
mock.module('playwright', { exports: { chromium: { launch: () => { calls++; return launch(); } } } });
const { getBrowser, closeBrowser, newSession, clearCaptcha, sleep } = await import('../src/xxqg/browser.js');
const db = await import('../src/db.js');

function instance() {
  const browser = new EventEmitter();
  browser.connected = true;
  browser.closed = false;
  browser.isConnected = () => browser.connected;
  browser.close = async () => { browser.closed = true; browser.connected = false; browser.emit('disconnected'); };
  return browser;
}

test('concurrent first sessions share one browser launch', async () => {
  calls = 0;
  let release;
  const browser = instance();
  const pending = new Promise(resolve => { release = resolve; });
  launch = () => pending;
  const first = getBrowser();
  const second = getBrowser();
  try {
    assert.equal(calls, 1, 'parallel accounts must not start duplicate browser processes');
  } finally {
    release(browser);
    assert.equal(await first, await second);
    await closeBrowser();
  }
});

test('a failed launch can be retried without a stale rejected promise', async () => {
  calls = 0;
  launch = async () => { throw new Error('启动失败'); };
  await assert.rejects(getBrowser(), /启动失败/);
  const browser = instance();
  launch = async () => browser;
  try { assert.equal(await getBrowser(), browser); assert.equal(calls, 2); }
  finally { await closeBrowser(); }
});

test('shutdown waits for an in-flight browser launch and closes the result', async () => {
  let release;
  const browser = instance();
  launch = () => new Promise(resolve => { release = resolve; });
  const starting = getBrowser();
  const closing = closeBrowser();
  release(browser);
  await starting;
  await closing;
  try { assert.equal(browser.closed, true, 'a late browser must not survive shutdown'); }
  finally { await closeBrowser(); }
});

test('a stale disconnect cannot clear a replacement browser', async () => {
  calls = 0;
  const old = instance();
  launch = async () => old;
  await getBrowser();
  old.connected = false;
  const replacement = instance();
  launch = async () => replacement;
  await getBrowser();
  old.emit('disconnected');
  try { assert.equal(await getBrowser(), replacement); assert.equal(calls, 2); }
  finally { await old.close(); await closeBrowser(); }
});

test('shutdown also waits when a disconnected browser is being replaced', async () => {
  const old = instance();
  launch = async () => old;
  await getBrowser();
  old.connected = false;
  let release;
  const replacement = instance();
  launch = () => new Promise(resolve => { release = resolve; });
  const starting = getBrowser();
  const closing = closeBrowser();
  release(replacement);
  await starting;
  await closing;
  try { assert.equal(replacement.closed, true); }
  finally { await old.close(); await closeBrowser(); }
});

test('pause interrupts verification waiting and long delays without supplying verification input', async () => {
  const paused = Object.assign(new Error('任务已暂停'), { code: 'TASK_PAUSED' });
  const checkPause = () => { throw paused; };
  await assert.rejects(() => sleep(60_000, checkPause), error => error === paused);
  const browser = instance();
  let released = false;
  let mouseUps = 0;
  const page = {
    locator: () => ({ count: async () => 1 }),
    mouse: { up: async () => { mouseUps++; } },
    screenshot: async () => { throw new Error('pause must be checked before requesting another frame'); },
  };
  browser.newContext = async () => ({ addInitScript: async () => {}, newPage: async () => page, close: async () => { released = true; } });
  launch = async () => browser;
  const session = await newSession(null, { uid: null, jobId: 'pause-fixture', shouldStop: checkPause });
  try { await assert.rejects(() => clearCaptcha(page), error => error === paused); }
  finally { await session.close(); await closeBrowser(); }
  assert.equal(released, true);
  assert.equal(mouseUps, 1, 'only release a held pointer; never solve or submit verification');
  assert.equal(db.eventsAfter('pause-fixture').at(-1).type, 'verification-end');
});

test.after(() => { db.db.close(); rmSync(process.env.DATA_DIR, { recursive: true, force: true }); });
