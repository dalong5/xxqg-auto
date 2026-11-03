import fs from 'node:fs';
import path from 'node:path';
import { config } from './config.js';
import { seal, open, randomId } from './crypto.js';

const file = path.join(config.dataDir, 'db.json');

function load() {
  if (!fs.existsSync(file)) return { users: {}, logins: {} };
  return JSON.parse(fs.readFileSync(file, 'utf8'));
}

let db = load();

function flush() {
  const tmp = file + '.tmp';
  fs.writeFileSync(tmp, JSON.stringify(db, null, 2));
  fs.renameSync(tmp, file);
}

// ---- 登录会话（扫码用，短生命周期） ----
export function createLogin() {
  const sid = randomId();
  db.logins[sid] = { sid, createdAt: Date.now(), status: 'waiting', jar: null, qr: null, error: null };
  flush();
  return db.logins[sid];
}

export function getLogin(sid) {
  return db.logins[sid] || null;
}

export function patchLogin(sid, patch) {
  const it = db.logins[sid];
  if (!it) return null;
  Object.assign(it, patch);
  flush();
  return it;
}

export function dropLogin(sid) {
  delete db.logins[sid];
  flush();
}

// ---- 用户（长期，cookie 加密） ----
export function upsertUser({ uid, nick, jar, expiresAt }) {
  db.users[uid] = {
    uid,
    nick,
    sealedJar: seal(jar),
    expiresAt: expiresAt || 0,
    createdAt: db.users[uid]?.createdAt || Date.now(),
    lastRunAt: db.users[uid]?.lastRunAt || 0,
    lastScore: db.users[uid]?.lastScore || null,
  };
  flush();
  return db.users[uid];
}

export function getUser(uid) {
  return db.users[uid] || null;
}

export function cookieJarOf(user) {
  return user?.sealedJar ? open(user.sealedJar) : null;
}

export function listUsers() {
  return Object.values(db.users).map(({ sealedJar, ...rest }) => rest);
}

export function cleanLogins(ttlMs = 10 * 60 * 1000) {
  const now = Date.now();
  for (const [sid, it] of Object.entries(db.logins)) {
    if (now - it.createdAt > ttlMs) delete db.logins[sid];
  }
  flush();
}

setInterval(() => cleanLogins(), 60 * 1000).unref?.();
