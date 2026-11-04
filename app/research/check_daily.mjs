// 每日答题自检：登录态 → 无 CDP 通道跑一遍 → 分数是否真涨
// 用法：node research/check_daily.mjs [uid]
import { Jar, score, userInfo } from '../src/xxqg/client.js';
import * as plain from '../src/xxqg/plain.js';
import { DatabaseSync } from 'node:sqlite';
import { open as unseal } from '../src/crypto.js';

const uid = process.argv[2] || '151285666237.0';
const db = new DatabaseSync('data/app.db');
const raw = unseal(db.prepare('select sealed_cookie from users where uid=?').get(uid).sealed_cookie);
const jar = new Jar(raw);

const stamp = () => new Date().toISOString().slice(11, 19);
const log = (m) => console.log(stamp(), m);

const info = await userInfo(jar).catch((e) => ({ error: e.message }));
log('登录态：' + (info?.error ? '失效 ' + info.error : '有效 ' + (info.nick || info.uid || '')));

const before = await score(jar);
const t6 = before.tasks?.[6];
log(`开跑前 每日答题 ${t6?.done ?? '?'}/${t6?.max ?? '?'} 总分 ${before.total}`);

const out = await plain.runDaily(uid, jar, { maxQuestions: 24 });
log('通道结果 ' + JSON.stringify(out));

await new Promise((r) => setTimeout(r, 4000));
const after = await score(jar);
const a6 = after.tasks?.[6];
log(`跑完 每日答题 ${a6?.done ?? '?'}/${a6?.max ?? '?'} 总分 ${after.total}`);
log(a6 && a6.done > (t6?.done ?? 0) ? '✅ 加分成功' : '❌ 没加分');
