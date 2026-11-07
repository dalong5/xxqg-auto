import { db, getLogin, updateLogin, upsertUser, setUserScore, addEvent } from './db.js';
import { Jar, getSign, newQrCode, pollQr, secureCheck, userInfo, score } from './xxqg/client.js';
import { retryTransient } from './util.js';

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

/**
 * 扫码截止时间：每张码给 perCode，但整场最多 total。
 * 换码时用同一个函数重算，避免「换个码就没时间扫了」，也避免「一直换码永不过期」。
 */
export function nextQrDeadline({ startedAt, now = Date.now(), perCode = 150_000, total = 300_000 }) {
  return Math.min(startedAt + total, now + perCode);
}

export async function driveLogin(sid) {
  const row = getLogin(sid);
  if (!row) return;

  const emit = (type, payload = null) => addEvent(sid, null, type, payload);
  const jar = new Jar();
  let rotations = 0;

  try {
    // 建码这几步同样只对网络抖动重试：一次失败就让用户重扫码太亏
    const retry = (fn) => retryTransient(fn, { tries: 3, delayMs: 900 });
    const state = await retry(() => getSign(jar));
    let code = await retry(() => newQrCode(jar));
    updateLogin(sid, { status: 'waiting', state, code, jar: JSON.stringify(jar.toJSON()) });
    emit('qr', { code });

    // 每张二维码给 150 秒，换码后重新计时；但整场扫码最多 5 分钟，
    // 避免用户离开页面后会话一直挂着占名额。
    const startedAt = Date.now();
    const PER_CODE_MS = 150_000;
    const TOTAL_MS = 300_000;
    let deadline = nextQrDeadline({ startedAt, perCode: PER_CODE_MS, total: TOTAL_MS });
    while (Date.now() < deadline) {
      const current = getLogin(sid);
      if (!current || current.status === 'failed') return;

      // 轮询遇到网络抖动就重试几次，不要直接判整个登录失败（用户又得重扫码）
      const r = await retry(() => pollQr(jar, current.code, state));
      if (r.status === 'expired') {
        rotations++;
        if (rotations > 4) {
          updateLogin(sid, { status: 'failed', error: '二维码反复过期' });
          emit('failed', { error: '二维码反复过期' });
          return;
        }
        code = await retry(() => newQrCode(jar));
        updateLogin(sid, { code });
        emit('qr', { code });
        // 换的是新码，给它完整的时间；总时长仍受 5 分钟上限约束
        deadline = nextQrDeadline({ startedAt, perCode: PER_CODE_MS, total: TOTAL_MS });
        continue;
      }

      if (r.status === 'scanned') {
        await retry(() => secureCheck(jar, r.tmpCode, state));
        const user = await retry(() => userInfo(jar));
        // 注意：查分失败必须让登录失败，不能吞掉。
        // 扫码后查分被拒通常意味着账号还在安全验证里，吞掉会把未验证的会话标成 ready。
        const progress = await score(jar);
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
