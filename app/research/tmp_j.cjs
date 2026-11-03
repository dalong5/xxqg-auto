const { DatabaseSync } = require('node:sqlite');
const d = new DatabaseSync('data/app.db');
console.log(d.prepare("select id,kind,status,attempts,error,created_at,finished_at from jobs order by created_at desc limit 3").all());
console.log(d.prepare("select job_id,type,payload from events order by seq desc limit 8").all());
