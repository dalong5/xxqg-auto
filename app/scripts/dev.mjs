// 本地一键起 API + worker（容器里则由 docker-compose 分开跑）
import { spawn } from 'node:child_process';

const procs = ['src/server.js', 'src/worker.js'].map((file) =>
  spawn(process.execPath, [file], { stdio: 'inherit', env: process.env }),
);

const stop = () => procs.forEach((p) => p.kill('SIGTERM'));
process.on('SIGINT', stop);
process.on('SIGTERM', stop);
procs.forEach((p) => p.on('exit', (code) => code && console.error(`${p.spawnargs[1]} 退出码 ${code}`)));
