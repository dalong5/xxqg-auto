const { DatabaseSync } = require('node:sqlite');
const d = new DatabaseSync('data/app.db');
console.log('cleared', d.prepare("update jobs set status='failed', error='重启清理' where status in ('running','queued')").run().changes);
