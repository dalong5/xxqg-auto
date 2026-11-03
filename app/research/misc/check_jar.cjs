const { DatabaseSync } = require('node:sqlite');
const d = new DatabaseSync('data/app.db');
const rows = d.prepare("select sid, status, jar from logins where status='done' order by created_at desc limit 2").all();
for (const r of rows) {
  const j = JSON.parse(r.jar || '{}');
  console.log(r.sid, 'keys=', Object.keys(j), 'uuid=', j.uuid ? j.uuid.slice(0, 10) : null, 'token=', j.token ? 'yes' : null);
}
