const { DatabaseSync } = require('node:sqlite');
const d = new DatabaseSync('data/app.db');
const j = d.prepare("select id,status,attempts,error from jobs where kind='run' order by created_at desc limit 1").get();
console.log('job', JSON.stringify(j));
for (const e of d.prepare("select type,payload from events where job_id=? and type in ('step','bad','error','start','done','score')").all(j.id)) {
  console.log(e.type, (e.payload || '').slice(0, 120));
}
