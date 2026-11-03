const { DatabaseSync } = require('node:sqlite');
const d = new DatabaseSync('data/app.db');
for (const j of d.prepare("select id,kind,status,attempts,created_at,finished_at,error from jobs order by created_at desc limit 8").all()) {
  console.log(new Date(j.created_at).toLocaleTimeString('zh-CN'), j.kind, j.status, 'att', j.attempts, (j.error||'').slice(0,60), j.id.slice(0,8));
}
