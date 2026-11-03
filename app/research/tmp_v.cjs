const uid = process.argv[2];
const base = 'http://127.0.0.1:8099';
// 用已有访客的 cookie？简化：直接改库把 visitor 指到一个固定值
const { DatabaseSync } = require('node:sqlite');
const d = new DatabaseSync('data/app.db');
const v = d.prepare('select visitor_id from users where uid=?').get(uid);
console.log('visitor', v.visitor_id);
