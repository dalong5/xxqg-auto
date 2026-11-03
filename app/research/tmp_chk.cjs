const { DatabaseSync } = require('node:sqlite');
const d = new DatabaseSync('data/app.db');
const j = d.prepare("select id,status,created_at from jobs where kind='run' order by created_at desc limit 1").get();
console.log('job', j.id, j.status);
const ev = d.prepare("select type,payload from events where job_id=? and type='score'").all(j.id);
console.log('score events:', ev.length);
console.log(ev.at(-1)?.payload);
const u = d.prepare("select last_score from users").get();
console.log('user last_score:', u.last_score);
