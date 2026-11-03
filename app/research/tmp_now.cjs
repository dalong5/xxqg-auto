const { DatabaseSync } = require('node:sqlite');
const d = new DatabaseSync('data/app.db');
const u = d.prepare('select last_score, last_run_at from users').get();
const s = JSON.parse(u.last_score);
console.log('today', s.today, 'video', JSON.stringify(s.tasks['2']), 'duration', JSON.stringify(s.tasks['1003']));
const j = d.prepare("select id,status from jobs order by created_at desc limit 2").all();
console.log(j);
