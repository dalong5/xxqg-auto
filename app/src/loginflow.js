import { db, getLogin, updateLogin, upsertUser, setUserScore, addEvent } from './db.js';
import { Jar, getSign, newQrCode, pollQr, secureCheck, userInfo, score } from './xxqg/client.js';

/**
 * 从队列领取一个待登录会话并跑到结束。
 * 登录只要 HTTP，200 个并发扫码也扛得住，所以独立于浏览器任务池。
 */
export function claimLogin() {
  return (
    db
      .prepare(
        `UPDATE logins SET status = 'init' WHERE sid = (
           SELECT sid FROM logins WHERE status = 'starting' ORDER BY created_at LIMIT 1
         ) AND status = 'starting' RETURNING *`,
      )
      .get() || null
  );
}

export async function driveLogin(sid) {
  const row = getLogin(sid);
  if (!row) return;

  const emit = (type, payload = null) => addEvent(sid, null, type, payload);
  const jar = new Jar();
  let rotations = 0;

  try {
    const state = await getSign(jar);
    let code = await newQrCode(jar);
    updateLogin(sid, { status: 'waiting', state, code, jar: JSON.stringify(jar.toJSON()) });
    emit('qr', { code });

    const deadline = Date.now() + 150_000;
    while (Date.now() < deadline) {
      const current = getLogin(sid);
      if (!current || current.status === 'failed') return;

      const r = await pollQr(jar, current.code, state);
      if (r.status === 'expired') {
        rotations++;
        if (rotations > 4) {
          updateLogin(sid, { status: 'failed', error: '二维码反复过期' });
          emit('failed', { error: '二维码反复过期' });
          return;
        }
        code = await newQrCode(jar);
        updateLogin(sid, { code });
        emit('qr', { code });
        continue;
      }

      if (r.status === 'scanned') {
        await secureCheck(jar, r.tmpCode, state);
        const user = await userInfo(jar);
        const progress = await score(jar).catch(() => null);
        upsertUser({
          uid: user.uid,
          visitorId: row.visitor_id,
          nick: user.nick,
          jar: JSON.stringify(jar.toJSON()),
          expiresAt: Date.now() + 20 * 24 * 3600 * 1000,
        });
        if (progress) setUserScore(user.uid, progress);
        updateLogin(sid, { status: 'done', uid: user.uid, jar: JSON.stringify(jar.toJSON()) });
        emit('done', { uid: user.uid, nick: user.nick, score: progress });
        return;
      }
      await new Promise((res) => setTimeout(res, 2000));
    }

    updateLogin(sid, { status: 'failed', error: '扫码超时' });
    emit('failed', { error: '扫码超时' });
  } catch (e) {
    updateLogin(sid, { status: 'failed', error: String(e.message || e) });
    emit('failed', { error: String(e.message || e) });
  }
}
