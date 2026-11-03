const { DatabaseSync } = require('node:sqlite');
const d = new DatabaseSync('data/app.db');
const j = d.prepare("select id from jobs where kind='run' and status='done' order by created_at desc limit 1").get();
console.log('job', j?.id);
console.log(d.prepare("select type,payload from events where job_id=? and type in ('step','bad','score','done')").all(j.id).map(e => e.type + ' ' + (e.payload||'').slice(0,150)));
