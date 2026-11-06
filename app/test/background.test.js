import { test } from 'node:test';
import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { mkdtempSync, mkdirSync, copyFileSync, writeFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';

test('Windows background launcher reuses its processes and stops only its own fixture', { skip: process.platform !== 'win32' }, () => {
  const root = mkdtempSync(path.join(tmpdir(), 'xxqg-background-'));
  mkdirSync(path.join(root, 'src'));
  mkdirSync(path.join(root, 'scripts'));
  const script = path.join(root, 'scripts', 'start-background.ps1');
  copyFileSync('scripts/start-background.ps1', script);
  for (const entry of ['server.js', 'worker.js']) writeFileSync(path.join(root, 'src', entry), 'setInterval(() => {}, 1000);');
  const run = (stop = false) => JSON.parse(execFileSync('powershell.exe', ['-NoProfile', '-NonInteractive', '-Command', `& '${script.replaceAll("'", "''")}' ${stop ? '-Stop' : ''} | ConvertTo-Json -Compress`], { encoding: 'utf8' }));
  try {
    const started = run();
    assert.equal(started.length, 2);
    assert.ok(started.every(process => process.Status === 'started'));
    const reused = run();
    assert.deepEqual(reused.map(process => process.Id), started.map(process => process.Id));
    assert.ok(reused.every(process => process.Status === 'already-running'));
    assert.equal(run(true).length, 2);
  } finally {
    try { run(true); } catch {}
    assert.ok(root.startsWith(path.resolve(tmpdir()) + path.sep));
    rmSync(root, { recursive: true, force: true });
  }
});
