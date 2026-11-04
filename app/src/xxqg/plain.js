// 无 CDP 的普通 Chrome：用 DPAPI 解出的 key 直接把 cookie 写进 profile，
// 交卷 / 滑块交给真实鼠标（powershell SendInput），绕开 devtools 风控。
import fs from 'node:fs';
import path from 'node:path';
import crypto from 'node:crypto';
import { execFile, spawn } from 'node:child_process';
import { DatabaseSync } from 'node:sqlite';
import { config } from '../config.js';

const CHROME = process.env.XXQG_CHROME || 'C:\\Program Files\\Google\\Chrome\\Application\\chrome.exe';
const HOST = '.xuexi.cn';
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

function ps(args) {
  return new Promise((res, rej) => {
    execFile(
      'powershell.exe',
      ['-NoProfile', '-ExecutionPolicy', 'Bypass', '-File', 'scripts/native.ps1', ...args],
      { cwd: process.cwd(), timeout: 40000 },
      (e, out, err) => (e ? rej(new Error((err || e.message).trim())) : res(out.trim())),
    );
  });
}

export const title = () => ps(['-Action', 'title']);
export const closeAll = () => ps(['-Action', 'killplain']).catch(() => '');
export const clickAt = (x, y) => ps(['-Action', 'click', '-A1', String(Math.round(x)), '-A2', String(Math.round(y))]);
const drag = (x1, y1, x2, y2, steps = 26) =>
  ps([
    '-Action', 'drag',
    '-A1', String(Math.round(x1)), '-A2', String(Math.round(y1)),
    '-A3', String(Math.round(x2)), '-A4', String(Math.round(y2)),
    '-A5', String(steps),
  ]);

// 在地址栏里拼一个 javascript: URL（分三段粘贴，避开 Chrome 剥 scheme 与全角冒号），结果塞进 document.title
// 必须用 void() 包住：javascript: 的返回值是字符串时会把整页替换掉
export async function probe(code) {
  await ps(['-Action', 'paste', '-A1', `void(${code})`]);
  await sleep(900);
  return title();
}

export const dirOf = (uid) => path.join(config.dataDir, 'plain', String(uid));

export async function seedProfile(uid, jar) {
  await closeAll();
  await sleep(1200);
  const dir = dirOf(uid);
  for (let i = 0; i < 6; i++) {
    try {
      fs.rmSync(dir, { recursive: true, force: true });
      break;
    } catch {
      await closeAll();
      await sleep(1200);
    }
  }
  fs.mkdirSync(dir, { recursive: true });
  const child = spawn(
    CHROME,
    [`--user-data-dir=${dir}`, '--no-first-run', '--no-default-browser-check', 'about:blank'],
    { detached: true, stdio: 'ignore' },
  );
  child.unref();
  const cdb = path.join(dir, 'Default', 'Network', 'Cookies');
  for (let i = 0; i < 60 && !fs.existsSync(cdb); i++) await sleep(250);
  await sleep(1500);
  await closeAll();
  await sleep(2000);

  const key = Buffer.from(await ps(['-Action', 'key', '-A1', dir]), 'base64');
  const db = new DatabaseSync(cdb);
  const h = crypto.createHash('sha256').update(HOST).digest();
  const now = Math.round((Date.now() + 11644473600000) * 1000);
  const exp = now + 86400 * 30 * 1000000;
  const ins = db.prepare(
    'INSERT INTO cookies (creation_utc, host_key, top_frame_site_key, name, value, encrypted_value, path, expires_utc, is_secure, is_httponly, last_access_utc, has_expires, is_persistent, priority, samesite, source_scheme, source_port, last_update_utc, source_type, has_cross_site_ancestor) VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)',
  );
  const pairs = jar?.map instanceof Map ? [...jar.map] : jar instanceof Map ? [...jar] : Object.entries(jar || {});
  for (const [name, value] of pairs) {
    db.prepare('DELETE FROM cookies WHERE name = ? AND host_key = ?').run(name, HOST);
    const nonce = crypto.randomBytes(12);
    const c = crypto.createCipheriv('aes-256-gcm', key, nonce);
    const ct = Buffer.concat([c.update(Buffer.concat([h, Buffer.from(value, 'utf8')])), c.final()]);
    ins.run(now, HOST, '', name, '', Buffer.concat([Buffer.from('v10'), nonce, ct, c.getAuthTag()]), '/', exp, 1, 0, now, 1, 1, 1, -1, 2, 443, now, 0, 0);
  }
  db.close();
  return dir;
}

export async function open(uid, url) {
  const dir = dirOf(uid);
  const child = spawn(
    CHROME,
    [`--user-data-dir=${dir}`, '--no-first-run', '--no-default-browser-check', '--window-size=1400,900', '--window-position=0,0', url],
    { detached: true, stdio: 'ignore' },
  );
  child.unref();
  await sleep(6000);
  // MoveWindow 用的是物理像素，2x 屏下要给 2800x1700 才够大
  await ps(['-Action', 'move', '-A1', '0', '-A2', '0', '-A3', '2800', '-A4', '1700']).catch(() => '');
  await sleep(1200);
  return title();
}

// 控件矩形，换算成屏幕物理像素（可直接交给 SendInput）
export const RECTS_JS =
  "(function(){var d=devicePixelRatio;var f=document.querySelector('.action-row button:last-child');if(f)f.scrollIntoView({block:'center'});var oy=screenY*2+outerHeight*2-innerHeight*d;var ox=screenX*2+(outerWidth*2-innerWidth*d)/2;var o=function(e){var r=e.getBoundingClientRect();return [Math.round(ox+(r.x+r.width/2)*d),Math.round(oy+(r.y+r.height/2)*d)]};var tip=document.querySelector('.q-footer-answer-tip-wrap .tips')||document.querySelector('.q-footer-answer-tip-wrap')||document.querySelector('span.tips');document.title=JSON.stringify({opts:[].map.call(document.querySelectorAll('.q-answer'),function(e){return {t:e.innerText.trim(),c:o(e)}}),inputs:[].map.call(document.querySelectorAll('input.blank'),o),blanks:[].map.call(document.querySelectorAll('.click-box'),o),tiles:[].map.call(document.querySelectorAll('.fill-answer'),function(e){return {t:e.innerText.trim(),c:o(e)}}),btns:[].map.call(document.querySelectorAll('.action-row button'),function(e){return {t:e.innerText.trim(),d:e.disabled,c:o(e)}}),tip:tip?o(tip):null,slider:(function(){var s=document.querySelector('#aliyunCaptcha-sliding-slider');return s?o(s):null})(),track:(function(){var b=document.querySelector('#aliyunCaptcha-sliding-body');if(!b)return null;var r=b.getBoundingClientRect();return [Math.round(ox+(r.x+r.width)*d),Math.round(oy+(r.y+r.height/2)*d)]})(),q:(document.querySelector('.q-body')||{}).innerText})})()";

export async function rects() {
  const raw = await probe(RECTS_JS);
  const m = raw.match(/\{.*\}/);
  if (!m) return { raw };
  try {
    return JSON.parse(m[0]);
  } catch {
    return { raw };
  }
}

// 读提示气泡：提示里就是正确答案
export const HINT_JS =
  "(function(){var s=document.querySelector('.answer');document.title='AN:'+(s?s.innerText.replace(/\\s+/g,' '):'NO')})()";

export async function hintText() {
  const raw = await probe(HINT_JS);
  if (!raw.startsWith('AN:')) return '';
  const t = raw.slice(3).trim();
  return t === 'NO' ? '' : t;
}

const clean = (s) => s.replace(/^[A-Za-z][.、]\s*/, '').replace(/\s+/g, '');

// 用真实鼠标作答当前题并点确定：先点「查看提示」拿官方答案（.answer 里就是「正确答案：B」），再照着选 / 填
export const TIP_JS =
  "(function(){var e=document.querySelector('.q-footer-answer-tip-wrap .tips')||document.querySelector('.q-footer-answer-tip-wrap');if(!e){document.title='TIPNO';return}var d=devicePixelRatio;var oy=screenY*2+outerHeight*2-innerHeight*d;var ox=screenX*2+(outerWidth*2-innerWidth*d)/2;e.scrollIntoView({block:'center'});var r=e.getBoundingClientRect();document.title='TIP:'+JSON.stringify([Math.round(ox+(r.x+r.width/2)*d),Math.round(oy+(r.y+r.height/2)*d)])})()";

// 「查看提示」按钮的屏幕坐标：先把它滚进视野再取矩形
export async function tipRect() {
  const raw = await probe(TIP_JS);
  if (!raw.startsWith('TIP:')) return null;
  try {
    return JSON.parse(raw.slice(4));
  } catch {
    return null;
  }
}

export async function advance() {
  let r = await rects();
  let hint = '';
  const tip = await tipRect();
  if (tip) {
    await clickAt(tip[0], tip[1]);
    for (let i = 0; i < 6 && !hint; i++) {
      await sleep(500);
      hint = await hintText();
    }
    if (process.env.XXQG_DEBUG) console.log('[plain] hint=', hint.slice(0, 70));
    // 点提示可能引起重排/滚动，坐标必须重取
    r = await rects();
  }
  const rawAns = (hint.split(/正确答案[:：]/)[1] || '').trim();
  const letters = (rawAns.match(/^[A-N][A-N\s、,，]*/) || [''])[0].replace(/[^A-N]/g, '');
  const picks = [...letters].map((c) => c.charCodeAt(0) - 65);
  const ansText = rawAns.replace(/^[A-N][A-N\s、,，]*/, '').trim();
  let decided = 'none';
  if (r.opts?.length) {
    const idx = picks.length ? picks : [0];
    for (const i of idx) {
      if (!r.opts[i]) continue;
      await clickAt(r.opts[i].c[0], r.opts[i].c[1]);
      await sleep(300);
    }
    decided = picks.length ? `opts:${letters}` : 'opts:first';
  } else if (r.blanks?.length) {
    // 点选填空：按答案文字逐个空位点开，再点对得上的词块
    const h = clean(ansText);
    let i = 0;
    for (const b of r.blanks) {
      await clickAt(b[0], b[1]);
      await sleep(260);
      const ch = h[i++];
      const t = (r.tiles || []).find((t2) => t2.t && ch && t2.t.includes(ch));
      if (t) {
        await clickAt(t.c[0], t.c[1]);
        await sleep(320);
      }
    }
    decided = 'blanks';
  } else if (r.inputs?.length) {
    await clickAt(r.inputs[0][0], r.inputs[0][1]);
    await sleep(250);
    await ps(['-Action', 'type', '-A1', (clean(ansText) || '测试').slice(0, 20)]);
    await sleep(200);
    decided = 'input';
  }
  // 按钮没点亮就把没用上的选项/空位都补上，不然永远推不动
  for (let t = 0; t < 4; t++) {
    const rr = await rects();
    const btn = (rr.btns || []).find((b) => /确|下一题|完/.test(b.t));
    if (!btn || !btn.d) break;
    if (rr.opts?.length) {
      for (const o of rr.opts) {
        await clickAt(o.c[0], o.c[1]);
        await sleep(220);
      }
    } else if (rr.blanks?.length && rr.tiles?.length) {
      for (const b of rr.blanks) {
        await clickAt(b[0], b[1]);
        await sleep(200);
        const tile = rr.tiles[Math.floor(Math.random() * rr.tiles.length)];
        await clickAt(tile.c[0], tile.c[1]);
        await sleep(220);
      }
    } else break;
    await sleep(400);
  }
  const fin = (r.btns || []).find((b) => /确|下一题|完/.test(b.t));
  if (!fin) return { ...r, decided, hint };
  await clickAt(fin.c[0], fin.c[1]);
  await sleep(1400);
  return { ...r, decided, hint };
}

// 交卷 + 滑块
export async function submit() {
  const r = await rects();
  const fin = (r.btns || []).find((b) => b.t.includes('完'));
  if (!fin) return { ok: false, why: '没有「完成」按钮', btns: (r.btns || []).map((b) => b.t) };
  await clickAt(fin.c[0], fin.c[1]);
  await sleep(2500);
  const s = await rects();
  if (!s.slider || !s.track) return { ok: false, why: '没有出现滑块', state: s };
  await drag(s.slider[0], s.slider[1], s.track[0], s.track[1], 34);
  await sleep(4000);
  return { ok: true };
}

/**
 * 每日答题全流程（无 CDP 版）：预置 cookie → 开卷 → 逐题看提示作答 → 完成 → 拖滑块。
 * 返回 { ok, answered, submitted, why }
 */
export async function runDaily(uid, jar, { maxQuestions = 24 } = {}) {
  await seedProfile(uid, jar);
  await open(uid, 'https://pc.xuexi.cn/points/exam-practice.html');
  const log = (m) => console.log('[plain-daily]', m);
  let answered = 0;
  let lastQ = '';
  let stalls = 0;
  for (let n = 1; n <= maxQuestions; n++) {
    const r = await rects();
    if (r.raw) {
      await sleep(2000);
      if (n > 2) return { ok: false, why: '页面读不出来', raw: r.raw };
      continue;
    }
    if (r.btns?.some((b) => /完/.test(b.t))) break;
    if (!r.opts?.length && !r.blanks?.length && !r.inputs?.length) {
      // 可能是还没开始
      const start = (r.btns || []).find((b) => /开始/.test(b.t));
      if (start) {
        await clickAt(start.c[0], start.c[1]);
        await sleep(2500);
        continue;
      }
      return { ok: false, why: '没有可作答的题', btns: (r.btns || []).map((b) => b.t) };
    }
    const q = (r.q || '').replace(/\s+/g, '').slice(0, 24);
    if (q && q === lastQ) stalls += 1;
    else {
      stalls = 0;
      lastQ = q;
    }
    if (stalls >= 4) {
      log(`同一题卡了 4 次，放弃本轮：${q.slice(0, 16)}`);
      return { ok: false, why: '题目推不动', answered, q };
    }
    const out = await advance();
    answered += 1;
    log(`第 ${answered} 题 ${out.decided} ${(out.hint || '').slice(0, 30)}`);
    await sleep(900 + Math.floor(Math.random() * 600));
  }
  const sub = await submit();
  if (!sub.ok) return { ok: false, why: sub.why, answered };
  return { ok: true, answered, submitted: true };
}

export { drag };
