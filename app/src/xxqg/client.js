import { config } from '../config.js';

// 极简 cookie jar：学习强国的登录态就是一串 cookie，存在 jar 里即可复用
export class Jar {
  constructor(obj = {}) {
    this.map = new Map(Object.entries(obj));
  }
  static fromSetCookie(list = []) {
    const j = new Jar();
    for (const line of list) {
      const [kv] = line.split(';');
      const i = kv.indexOf('=');
      if (i > 0) j.map.set(kv.slice(0, i).trim(), kv.slice(i + 1).trim());
    }
    return j;
  }
  absorb(res) {
    for (const line of res.headers.getSetCookie?.() || []) {
      const [kv] = line.split(';');
      const i = kv.indexOf('=');
      if (i > 0) this.map.set(kv.slice(0, i).trim(), kv.slice(i + 1).trim());
    }
  }
  header() {
    return [...this.map].map(([k, v]) => `${k}=${v}`).join('; ');
  }
  toJSON() {
    return Object.fromEntries(this.map);
  }
  get(name) {
    return this.map.get(name);
  }
  /** 供 Playwright addCookies 使用 */
  toPlaywrightCookies(domain = '.xuexi.cn') {
    return [...this.map].map(([name, value]) => ({ name, value, domain, path: '/' }));
  }
}

export function isLoggedIn(jar) {
  return Boolean(jar?.get('uuid') || jar?.get('token'));
}

async function request(jar, url, { method = 'GET', form, json } = {}) {
  const headers = {
    'user-agent': config.ua,
    accept: 'application/json, text/plain, */*',
    referer: 'https://pc.xuexi.cn/points/login.html',
    cookie: jar.header(),
  };
  let body;
  if (form) {
    headers['content-type'] = 'application/x-www-form-urlencoded;charset=UTF-8';
    body = new URLSearchParams(form).toString();
  } else if (json) {
    headers['content-type'] = 'application/json;charset=UTF-8';
    body = JSON.stringify(json);
  }
  const res = await fetch(url, { method, headers, body, credentials: 'include' });
  jar.absorb(res);
  const text = await res.text();
  let data = null;
  try {
    data = text ? JSON.parse(text) : null;
  } catch {
    data = { raw: text };
  }
  return { res, data };
}

/** 取扫码签名 state */
export async function getSign(jar) {
  const { data } = await request(jar, `${config.apiHost}/open/api/sns/sign`);
  const sign = data?.data?.sign;
  if (!sign) throw new Error('sns/sign 未返回 sign');
  return sign;
}

/** 申请二维码内容（code 形如 qr:UUID） */
export async function newQrCode(jar) {
  const { data } = await request(jar, `${config.loginHost}/user/qrcode/generate`);
  if (!data?.success || !data.result) throw new Error(`二维码生成失败: ${JSON.stringify(data)}`);
  return data.result;
}

export function qrContent(code) {
  return `${config.loginHost}/login/qrcommit?showmenu=false&code=${encodeURIComponent(code)}&appId=${config.appId}`;
}

/**
 * 轮询扫码结果
 * 11021 未扫码 / 11019 已过期 / success 返回带 loginTmpCode 的跳转链接
 */
export async function pollQr(jar, code, state) {
  const { data } = await request(jar, `${config.loginHost}/login/login_with_qr`, {
    method: 'POST',
    form: { qrCode: code, goto: 'https://oa.xuexi.cn', pdmToken: '' },
  });
  if (data?.success && data.data) {
    const url = new URL(data.data);
    return { status: 'scanned', tmpCode: url.searchParams.get('loginTmpCode'), state };
  }
  if (data?.code === '11019') return { status: 'expired' };
  return { status: 'waiting' };
}

/** 用 loginTmpCode 换正式登录态 */
export async function secureCheck(jar, tmpCode, state) {
  const { data } = await request(
    jar,
    `${config.apiHost}/login/secure_check?code=${encodeURIComponent(tmpCode)}&state=${encodeURIComponent(state)}`,
  );
  if (!isLoggedIn(jar)) throw new Error(`secure_check 未写入登录态: ${JSON.stringify(data).slice(0, 200)}`);
  return data;
}

export async function userInfo(jar) {
  const { data } = await request(jar, `${config.apiHost}/open/api/user/info`);
  if (!data?.data?.uid) throw new Error(`获取用户信息失败: ${JSON.stringify(data).slice(0, 200)}`);
  return { uid: data.data.uid, nick: data.data.nick };
}

/** 任务码: 1阅读文章 2视听学习 9每日登录 1002文章时长 1003视听时长 6每日答题 5每周答题 4专项答题 */
export const TASK_CODES = {
  1: '阅读文章',
  2: '视听学习',
  9: '每日登录',
  1002: '文章时长',
  1003: '视听时长',
  6: '每日答题',
  5: '每周答题',
  4: '专项答题',
};

export async function score(jar) {
  const total = (await request(jar, `${config.proxyHost}/delegate/score/get`)).data?.data?.score ?? 0;
  const today = (await request(jar, `${config.proxyHost}/delegate/score/today/query`)).data?.data?.score ?? 0;
  const progress =
    (await request(jar, `${config.proxyHost}/delegate/score/days/listScoreProgress?sence=score&deviceType=2`)).data?.data
      ?.taskProgress ?? [];
  const tasks = {};
  for (const p of progress) {
    for (const code of p.taskCode || []) {
      if (TASK_CODES[code]) tasks[code] = { name: TASK_CODES[code], done: +p.currentScore, max: +p.dayMaxScore };
    }
  }
  return { total: +total, today: +today, tasks };
}

/** 今天还没做完的任务，用来决定跑什么 */
export function pendingTasks(progress) {
  return Object.entries(progress.tasks)
    .filter(([, t]) => t.max > 0 && t.done < t.max)
    .map(([code, t]) => ({ code: +code, ...t }));
}
