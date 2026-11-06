/**
 * xxqg 驱动：把 legacy 工程（`../app/src/xxqg`）里已验证的实现接进来。
 * 说明：
 *  - 登录与分数是纯 HTTP，稳定，直接复用 client.js；
 *  - 阅读/视听/答题必须真实浏览器（分数由页面内 SDK 上报），复用 tasks.js；
 *  - 每日答题要走「原生 Chrome + OS 鼠标」通道，见 plain.js 与 docs/POSTMORTEM.md。
 */
import path from 'node:path';
import { pathToFileURL } from 'node:url';
import { config } from '../config.js';
import { logger } from '../logger.js';

const dir = config.legacyDomainDir;
const load = async (name) => import(pathToFileURL(path.join(dir, name)).href);

export async function createDriver() {
  const client = await load('client.js');
  const tasks = await load('tasks.js').catch(() => null);
  const log = logger.child({ driver: 'xxqg' });

  // 二维码会话：ref 就是平台侧的 sid，cookie jar 存在内存（3 分钟寿命，够用）
  const pending = new Map();

  return {
    name: 'xxqg',

    async createQr() {
      const jar = new client.Jar({});
      const qr = await client.newQrCode(jar);
      const ref = qr.code || qr.id || JSON.stringify(qr).slice(0, 24);
      pending.set(ref, { jar, code: qr.code, state: qr.state ?? null, at: Date.now() });
      return { ref, qr: client.qrContent(qr.code) };
    },

    async pollQr(ref) {
      const s = pending.get(ref);
      if (!s) return { status: 'expired' };
      if (Date.now() - s.at > 180_000) {
        pending.delete(ref);
        return { status: 'expired' };
      }
      try {
        const r = await client.pollQr(s.jar, s.code, s.state);
        if (r?.state === 'scanned' || r?.status === 'scanned') return { status: 'scanned' };
        if (!(r?.success || r?.done || r?.code === 200)) return { status: 'waiting' };
        const secured = await client.secureCheck(s.jar, r.tmpCode || r.code, s.state);
        const info = await client.userInfo(s.jar);
        pending.delete(ref);
        const cookie = Object.fromEntries(s.jar.map);
        return { status: 'done', uid: String(info?.uid ?? secured?.uid), nick: info?.nick || '', cookie };
      } catch (e) {
        log.warn('pollQr failed', { err: e.message });
        return { status: 'waiting', error: e.message };
      }
    },

    async fetchScore(cookie) {
      const jar = new client.Jar(cookie);
      const s = await client.score(jar);
      return { day: null, total: s?.total ?? 0, today: s?.today ?? 0, tasks: s?.tasks ?? {} };
    },

    async runTasks({ cookie, tasks: kinds = [], onEvent = () => {}, uid, signal }) {
      const jar = new client.Jar(cookie);
      const emit = (e) => onEvent(typeof e === 'string' ? { level: 'info', type: 'log', message: e } : e);
      const progress = () => ({ tasks: {} });
      progress.note = (m) => emit({ level: 'info', type: 'log', message: m });

      const results = [];
      for (const kind of kinds) {
        // 浏览器任务无法中途取消，但至少保证「取消后不再开下一项」
        if (signal?.aborted) throw Object.assign(new Error('aborted'), { code: 'ABORTED' });
        if (kind === 'login') {
          // 登录分是打卡动作，fetchScore 时服务端自然结算；这里只回报
          emit({ level: 'info', type: 'log', message: '每日登录：登录态有效即自动计分' });
          results.push({ kind, status: 'done' });
          continue;
        }
        if (!tasks) {
          results.push({ kind, status: 'failed', error: 'legacy tasks.js 不可用' });
          continue;
        }
        try {
          if (kind === 'article' || kind === 'video') {
            await tasks.learn(kind, { jar, progress, uid: String(uid) });
          } else {
            await tasks.quiz(kind, { jar, progress, uid: String(uid), refresh: async () => this.fetchScore(cookie) });
          }
          results.push({ kind, status: 'done' });
        } catch (e) {
          emit({ level: 'error', type: 'task_failed', message: `${kind} 失败：${e.message}` });
          results.push({ kind, status: 'failed', error: e.message });
        }
      }
      const score = await this.fetchScore(cookie);
      return { ok: results.every((r) => r.status !== 'failed'), results, score };
    },
  };
}
