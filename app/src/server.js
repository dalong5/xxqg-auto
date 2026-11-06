import { config } from './config.js';
import app from './app.js';

const server = app.listen(config.port, config.host, () => {
  console.log(`API 已启动 http://127.0.0.1:${config.port}（任务由 worker 执行）key=${config.keyFingerprint}`);
});

for (const sig of ['SIGINT', 'SIGTERM']) process.on(sig, () => server.close(() => process.exit(0)));
