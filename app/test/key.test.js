import { test } from 'node:test';
import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';

test('simultaneous API and worker startups never read a partly written key', async () => {
  const dir = mkdtempSync(path.join(tmpdir(), 'xxqg-key-'));
  const source = `
    import fs from 'node:fs';
    const write = fs.writeFileSync;
    fs.writeFileSync = (file, data, options) => {
      if (String(file).endsWith('secret.key') && options?.flag === 'wx') {
        const fd = fs.openSync(file, 'wx', options.mode);
        Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, 300);
        write(fd, data);
        fs.closeSync(fd);
      } else write(file, data, options);
    };
    const { config } = await import('./src/config.js');
    process.stdout.write(config.keyFingerprint);
  `;
  try {
    const results = await Promise.all(Array.from({ length: 4 }, () => new Promise(resolve => {
      const child = spawn(process.execPath, ['--input-type=module', '-e', source], { env: { ...process.env, APP_SECRET: '', DATA_DIR: dir } });
      let out = '', error = '';
      child.stdout.on('data', data => { out += data; });
      child.stderr.on('data', data => { error += data; });
      child.on('exit', code => resolve({ code, out, error }));
    })));
    assert.ok(results.every(result => result.code === 0), JSON.stringify(results));
    assert.equal(new Set(results.map(result => result.out)).size, 1);
    assert.match(readFileSync(path.join(dir, 'secret.key'), 'utf8'), /^[a-f0-9]{64}$/);
  } finally { rmSync(dir, { recursive: true, force: true }); }
});
