// 多进程并发领取：同一个 SQLite 文件被 4 个进程同时抢，不能出现重复领取
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { mkdtempSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';

const here = path.dirname(fileURLToPath(import.meta.url));
const appDir = path.join(here, '..');
const dataDir = mkdtempSync(path.join(tmpdir(), 'xxqg-race-'));
process.env.DATA_DIR = dataDir;
const db = await import('../src/db.js');
// Windows 下子进程 import 绝对路径必须用 file:// URL
const dbUrl = pathToFileURL(path.join(appDir, 'src/db.js')).href;

const N = 20;
const SEED = 'race-seed';
const SEED_UID = 'seed-uid';

const runChild = (name) =>
  new Promise((resolve, reject) => {
    const script = path.join(dataDir, `${name}.mjs`);
    writeFileSync(
      script,
      `import * as db from ${JSON.stringify(dbUrl)};\n` +
        `const got = [];\n` +
        `for (;;) {\n` +
        `  const job = db.claimJob('run', ${JSON.stringify(name)});\n` +
        `  if (!job) break;\n` +
        `  got.push(job.id);\n` +
        `}\n` +
        `console.log(JSON.stringify(got));\n`,
    );
    const child = spawn(process.execPath, [script], {
      env: { ...process.env, DATA_DIR: dataDir, APP_SECRET: 'test-secret-0123456789abcdef' },
      stdio: ['ignore', 'pipe', 'pipe'],
    });
    let out = '';
    let err = '';
    child.stdout.on('data', (d) => { out += d; });
    child.stderr.on('data', (d) => { err += d; });
    child.on('error', reject);
    child.on('close', (code) => {
      if (code !== 0) return reject(new Error(`${name} 退出码 ${code}: ${err.slice(0, 300)}`));
      try { resolve(JSON.parse(out.trim().split('\n').pop())); } catch (e) { reject(new Error(`解析输出失败: ${out.slice(0, 200)}`)); }
    });
  });

test('4 个进程并发领取 20 个任务：不重复、不遗漏', async () => {
  const created = [];
  for (let i = 0; i < N; i++) {
    // 每个访客上限 1 个账号，所以每个任务用独立访客
    const uid = `race-${i}`;
    const visitor = `v-race-${i}`;
    db.touchVisitor(visitor);
    db.upsertUser({ uid, visitorId: visitor, nick: uid, jar: JSON.stringify({ token: 't' }), expiresAt: 0 });
    created.push(db.enqueue({ kind: 'run', uid, visitorId: visitor, tasks: ['daily'] }));
  }
  assert.equal(new Set(created).size, N, '入队的 20 个任务 id 应互不相同');

  const results = await Promise.all(['w1', 'w2', 'w3', 'w4'].map(runChild));
  const all = results.flat();
  assert.equal(new Set(all).size, all.length, `出现重复领取：${all.length} 次领取只有 ${new Set(all).size} 个不同任务`);
  assert.deepEqual([...all].sort(), [...created].sort(), '每个任务应恰好被领取一次');

  const left = db.db.prepare("SELECT COUNT(*) n FROM jobs WHERE status = 'queued'").get().n;
  assert.equal(left, 0, `不应有任务留在队列里，实际 ${left}`);
  const running = db.db.prepare("SELECT COUNT(*) n FROM jobs WHERE status = 'running'").get().n;
  assert.equal(running, N);
});

test('并发领取记录的执行器名都是合法值', async () => {
  const rows = db.db.prepare("SELECT DISTINCT worker FROM jobs WHERE status = 'running'").all();
  const workers = rows.map((r) => r.worker).filter(Boolean);
  assert.ok(workers.length >= 1);
  for (const w of workers) assert.match(w, /^w[1-4]$/, `异常执行器名: ${w}`);
});
