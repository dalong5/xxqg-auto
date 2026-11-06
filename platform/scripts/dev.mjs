#!/usr/bin/env node
/** 本地开发：一个命令同时起 API 和 worker（生产用两个进程/容器） */
import { spawn } from 'node:child_process';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const root = path.dirname(path.dirname(fileURLToPath(import.meta.url)));
const procs = [];
let stopping = false;

function run(name, file) {
  const p = spawn(process.execPath, [path.join(root, file)], {
    cwd: root,
    env: process.env,
    stdio: ['ignore', 'pipe', 'pipe'],
  });
  const tag = `[${name}]`;
  p.stdout.on('data', (b) => process.stdout.write(b.toString().replace(/^/gm, `${tag} `)));
  p.stderr.on('data', (b) => process.stderr.write(b.toString().replace(/^/gm, `${tag} `)));
  p.on('exit', (code) => {
    if (!stopping) {
      console.error(`${tag} exited with ${code}, shutting down`);
      stop(code || 1);
    }
  });
  procs.push(p);
  return p;
}

function stop(code = 0) {
  if (stopping) return;
  stopping = true;
  for (const p of procs) p.kill('SIGTERM');
  setTimeout(() => process.exit(code), 1500);
}

process.on('SIGINT', () => stop(0));
process.on('SIGTERM', () => stop(0));

run('api', 'src/index.js');
run('worker', 'src/queue/worker.js');
