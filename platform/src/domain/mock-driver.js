/**
 * mock 驱动：把「扫码 → 登录 → 做任务 → 分数上涨」整条链路用确定性规则模拟出来。
 * 目的：让产品在没有真实账号/网络的情况下也能完整演示、跑集成测试。
 */
import { randomId } from '../crypto.js';

const sleep = (ms, signal) =>
  new Promise((resolve, reject) => {
    if (signal?.aborted) return reject(Object.assign(new Error('aborted'), { code: 'ABORTED' }));
    const t = setTimeout(() => {
      signal?.removeEventListener?.('abort', onAbort);
      resolve();
    }, ms);
    function onAbort() {
      clearTimeout(t);
      reject(Object.assign(new Error('aborted'), { code: 'ABORTED' }));
    }
    signal?.addEventListener?.('abort', onAbort, { once: true });
  });

const BASE_TASKS = {
  9: { name: '每日登录', max: 1 },
  1: { name: '阅读文章', max: 12 },
  2: { name: '视听学习', max: 12 },
  6: { name: '每日答题', max: 5 },
  5: { name: '每周答题', max: 5 },
  4: { name: '专项答题', max: 8 },
  1002: { name: '文章时长', max: 12 },
  1003: { name: '视听时长', max: 12 },
};
const TASK_CODE = { login: 9, article: 1, video: 2, daily: 6, weekly: 5, special: 4 };

export function createDriver() {
  // ref -> { createdAt, scansAt, cookie }
  const qrs = new Map();
  // cookie -> { day, score, uid, nick }
  const states = new Map();

  const day = () => new Date().toISOString().slice(0, 10);
  const stateOf = (cookie) => {
    if (!states.has(cookie)) {
      const n = states.size + 1;
      states.set(cookie, { day: day(), score: {}, uid: `mock-${1000 + n}`, nick: `演示账号${n}` });
    }
    const s = states.get(cookie);
    if (s.day !== day()) {
      s.day = day();
      s.score = {};
    }
    return s;
  };

  function scoreView(cookie) {
    const s = stateOf(cookie);
    const tasks = {};
    let today = 0;
    for (const [code, def] of Object.entries(BASE_TASKS)) {
      const done = s.score[code] ?? 0;
      tasks[code] = { name: def.name, done, max: def.max };
      today += done;
    }
    return { day: s.day, total: 200 + today, today, tasks, uid: s.uid, nick: s.nick };
  }

  return {
    name: 'mock',

    async createQr() {
      const ref = randomId(9);
      qrs.set(ref, { createdAt: Date.now(), scansAt: Date.now() + 2500, cookie: randomId(18) });
      return { ref, qr: `mock://login/${ref}` };
    },

    async pollQr(ref) {
      const s = qrs.get(ref);
      if (!s) return { status: 'expired' };
      if (Date.now() > s.createdAt + 180_000) return { status: 'expired' };
      if (Date.now() < s.scansAt) return { status: 'waiting' };
      const st = stateOf(s.cookie);
      return { status: 'done', uid: st.uid, nick: st.nick, cookie: { mock: true, sid: s.cookie } };
    },

    async fetchScore(cookie) {
      await sleep(120);
      return scoreView(cookie);
    },

    async runTasks({ cookie, tasks = [], onEvent = () => {}, signal }) {
      const s = stateOf(cookie);
      const results = [];
      for (const kind of tasks) {
        if (signal?.aborted) throw Object.assign(new Error('aborted'), { code: 'ABORTED' });
        const code = TASK_CODE[kind];
        if (!code) continue;
        const def = BASE_TASKS[code];
        if ((s.score[code] ?? 0) >= def.max) {
          onEvent({ level: 'info', type: 'skip', message: `${def.name} 已满分，跳过` });
          results.push({ kind, status: 'skipped' });
          continue;
        }
        onEvent({ level: 'info', type: 'task_start', message: `开始 ${def.name}` });
        const steps = Math.min(3, Math.max(1, Math.ceil((def.max - (s.score[code] ?? 0)) / 4)));
        for (let i = 1; i <= steps; i++) {
          await sleep(350, signal);
          onEvent({ level: 'debug', type: 'task_progress', message: `${def.name} 进行中 ${i}/${steps}` });
        }
        s.score[code] = def.max;
        const view = scoreView(cookie);
        onEvent({
          level: 'info',
          type: 'task_done',
          message: `${def.name} 完成，今日 ${view.today} 分`,
          payload: { score: view },
        });
        results.push({ kind, status: 'done' });
      }
      return { ok: true, results, score: scoreView(cookie) };
    },
  };
}
