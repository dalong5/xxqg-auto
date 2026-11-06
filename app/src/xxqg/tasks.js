import { config } from '../config.js';
import { newSession, dwell, jitter, sleep, clearCaptcha, safeClick } from './browser.js';

const ARTICLE_FEEDS = [
  'https://www.xuexi.cn/lgdata/35il6fpn0ohq.json',
  'https://www.xuexi.cn/lgdata/45a3hac2bf1j.json',
  'https://www.xuexi.cn/lgdata/1ajhkle8l72.json',
  'https://www.xuexi.cn/lgdata/1ahjpjgb4n3.json',
];
const VIDEO_FEEDS = [
  'https://www.xuexi.cn/lgdata/3j2u3cttsii9.json',
  'https://www.xuexi.cn/lgdata/1novbsbi47k.json',
  'https://www.xuexi.cn/lgdata/31c9ca1tgfqb.json',
];

async function feed(kind) {
  const list = kind === 'video' ? VIDEO_FEEDS : ARTICLE_FEEDS;
  const url = list[Math.floor(Math.random() * list.length)];
  const res = await fetch(`${url}?_st=${Math.floor(Math.random() * 2e7)}`, {
    headers: { 'user-agent': config.ua },
  });
  const items = await res.json();
  return items
    .filter((i) => i?.url)
    .slice(0, 400)
    .map((i) => ({ url: i.url, title: i.title || '', type: i.type || '' }));
}

/**
 * 阅读/视听：靠真实页面停留计分，所以必须逐条打开 + 停留 + 滚动。
 * 每篇后回查分数，达到上限立即停，避免白跑。
 */
/** 视频页不会自动播，必须静音后手动 play，否则一秒都不算 */
async function playVideo(page) {
  return page
    .evaluate(() => {
      const v = document.querySelector('video');
      if (!v) return null;
      v.muted = true;
      if (v.paused) v.play().catch(() => {});
      return v.duration || 0;
    })
    .catch(() => null);
}

export async function learn(kind, { jar, progress, shouldStop, uid, jobId }) {
  const isVideo = kind === 'video';
  const label = isVideo ? '视听' : '阅读';
  const cap = () => progress().tasks?.[isVideo ? 2 : 1];
  const timeCap = () => progress().tasks?.[isVideo ? 1003 : 1002];

  if (cap() && cap().done >= cap().max && timeCap() && timeCap().done >= timeCap().max) {
    return `${label}已满分，跳过`;
  }

  const items = await feed(kind);
  const { page, close } = await newSession(jar, { uid, jobId, shouldStop });
  try {
    await page.goto('https://www.xuexi.cn/notFound.html', { waitUntil: 'domcontentloaded' });
    await clearCaptcha(page);
    let count = 0;
    for (let i = 0; i < 24 && count < 20; i++) {
      if (shouldStop?.()) break;
      let c = cap();
      let t = timeCap();
      if (c && t && c.done >= c.max && t.done >= t.max) break;

      const item = items[Math.floor(Math.random() * items.length)];
      await page.goto(item.url, { waitUntil: 'domcontentloaded', timeout: 45000 }).catch(() => {});
      count++;
      await clearCaptcha(page);

      // 视听：先把视频播起来，按视频长度决定停留（太短不计分，太长浪费时间）
      let seconds = config.dwellSeconds;
      let keepPlaying = null;
      if (isVideo) {
        await sleep(2500);
        const duration = await playVideo(page);
        if (!duration) {
          // 拿到的是图文/音频页，没有 video 元素，短停几秒就换下一个
          seconds = 8;
          progress.note?.('这条没有视频元素，跳过');
        } else {
          seconds = Math.min(180, Math.max(60, Math.ceil(duration) + 3));
          // 播放可能被风控/缓冲打断，5 秒检查一次
          keepPlaying = setInterval(() => playVideo(page).catch(() => {}), 5000);
          progress.note?.(`视频时长 ${Math.round(duration)}s，按长度停留`);
        }
      }

      // 停留时长上下浮动一点，别每篇都卡死同一个秒数
      seconds = Math.round(seconds * (0.92 + Math.random() * 0.16));

      let lastLog = 0;
      try {
        await dwell(page, seconds, (left) => {
          shouldStop?.();
          // 每秒回调太吵，6 秒一条就够看
          if (Date.now() - lastLog < 6000 && left > 1) return;
          lastLog = Date.now();
          c = cap();
          t = timeCap();
          progress.note?.(`${label}「${item.title.slice(0, 18)}」 剩 ${left}s / 还差 ${c ? c.max - c.done : '?'} 项 ${t ? t.max - t.done : '?'} 分`);
        });
      } finally {
        if (keepPlaying) clearInterval(keepPlaying);
      }
      await sleep(jitter(1500, 2500));
      // 每篇结束立刻回查，分数到顶就收工，别白跑
      await progress.refresh();
      c = cap();
      t = timeCap();
      progress.note?.(`${label}进度 ${c ? c.done : '?'}/${c ? c.max : '?'} 项，${t ? t.done : '?'}/${t ? t.max : '?'} 分`);
      if (c && t && c.done >= c.max && t.done >= t.max) break;
    }
    const c = cap();
    const t = timeCap();
    if (!c || !t || c.done < c.max || t.done < t.max) throw new Error(`${label}积分未达标，已停止，请检查页面或重新运行`);
    return `${label}已确认达标，浏览 ${count} 项`;
  } finally {
    await close();
  }
}

const EXAM_ENTRY = {
  daily: { name: '每日答题', code: 6 },
  weekly: { name: '每周答题', code: 5 },
  special: { name: '专项答题', code: 4 },
};

/** 从「查看提示」的弹层里取答案：官方答案就包在 <font> 里 */
async function readTips(page) {
  let tipBtn = page.locator('.tips').first();
  if (!(await tipBtn.count())) tipBtn = page.locator('text=查看提示').first();
  if (!(await tipBtn.count())) return [];
  await safeClick(page, tipBtn);
  await page.waitForTimeout(600 + Math.floor(Math.random() * 500));
  const html = await page.locator('.ant-popover .line-feed').first().innerHTML().catch(() => '');
  const tips = [...html.matchAll(/<font[^>]*>([\s\S]*?)<\/font>/g)]
    .map((m) => m[1].replace(/<[^>]+>/g, '').replace(/\s+/g, ' ').trim())
    .filter(Boolean);
  // 弹层会盖住下面的选项，必须关掉，否则后面的点击全被吞掉
  await page.keyboard.press('Escape').catch(() => {});
  await page.locator('.q-header').first().click({ timeout: 1500 }).catch(() => {});
  await page.waitForTimeout(250);
  return tips;
}

/** 把还空着的空位随便用剩余词块填满，不然交不上去 */
async function fillEmptyBlanks(page) {
  for (let round = 0; round < 12; round++) {
    const empty = await page
      .evaluate(() => {
        const boxes = [...document.querySelectorAll('.click-box')].filter((e) => !e.innerText.trim());
        if (!boxes.length) return 0;
        boxes[0].click();
        return boxes.length;
      })
      .catch(() => 0);
    if (!empty) return true;
    await page.waitForTimeout(250);
    const chips = page.locator('.fill-answer');
    const n = await chips.count();
    if (!n) return false;
    await safeClick(page, chips.nth(Math.floor(Math.random() * n)));
    await page.waitForTimeout(250);
  }
  return false;
}

/**
 * 答题：题目页自带「查看提示」，提示里就是答案。
 * 这是官方答案源，比外部题库稳，不用维护答案表。
 */
export async function quiz(kind, { jar, progress, uid, jobId, shouldStop }) {
  const cfg = EXAM_ENTRY[kind];
  if (!cfg) throw new Error(`未知题型 ${kind}`);
  const task = progress().tasks?.[cfg.code];
  if (!task) return `${cfg.name}当前未开放，跳过`;
  if (task.done >= task.max) return `${cfg.name}已满分，跳过`;

  const { page, close } = await newSession(jar, { uid, jobId, shouldStop });
  const log = progress.note || (() => {});
  try {
    await page.goto('https://pc.xuexi.cn/points/my-points.html', { waitUntil: 'domcontentloaded', timeout: 45000 });
    await page.waitForTimeout(3000);
    await clearCaptcha(page);

    // 入口是卡片里那个「去答题」，点标题没用
    const card = page.locator('.my-points-card', { hasText: cfg.name }).first();
    log(`等待「${cfg.name}」入口加载…`);
    try {
      await card.waitFor({ state: 'visible', timeout: 45000 });
    } catch (error) {
      if (error.name !== 'TimeoutError') throw error;
      throw new Error(`等待「${cfg.name}」入口加载超时，请检查网络或重新扫码登录`);
    }
    await safeClick(page, card.locator('text=去答题').first(), { timeout: 15000 });
    await page.waitForTimeout(3000 + Math.floor(Math.random() * 1500));
    await clearCaptcha(page);

    // 周答/专项要先挑一套没作答的卷子
    if (kind !== 'daily') {
      const paper = page.locator('button:has-text("开始答题"), button:has-text("未作答")').first();
      if (await paper.count()) {
        await paper.click({ timeout: 15000 }).catch(() => {});
        await page.waitForTimeout(3000);
      }
    }

    let answered = 0;
    let submitted = false;
    let lastQuestion = '';
    for (let n = 1; n <= 35; n++) {
      const body = page.locator('.q-body').first();
      if (!(await body.count())) break;
      const category = await page.locator('.q-header').first().innerText().catch(() => '');
      const question = (await body.innerText().catch(() => '')).replace(/\s+/g, ' ').slice(0, 50);
      if (question === lastQuestion && n > 1) break; // 卡住同一题，别死循环
      lastQuestion = question;
      log(`第 ${n} 题 [${category.replace(/\s+/g, '')}] ${question}`);

      if (shouldStop?.()) throw new Error('任务执行时间已到，停止答题');
      if (kind === 'daily') {
        const seconds = 20 + Math.floor(Math.random() * 41);
        log(`阅读本题，等待 ${seconds} 秒后作答`);
        await sleep(seconds * 1000, shouldStop);
        if (shouldStop?.()) throw new Error('任务执行时间已到，停止答题');
        await clearCaptcha(page);
      }

      const tips = await readTips(page);

      if (category.includes('点选')) {
        // 点选填空：.click-box 是空位，.fill-answer 是词块。
        // 提示可能是一整段（"根据事实"），要按剩余字符串贪心匹配词块。
        const blanks = page.locator('.click-box');
        const total = await blanks.count();
        const chips = page.locator('.fill-answer');
        const chipTexts = (await chips.allInnerTexts().catch(() => [])).map((s) => s.trim());
        let rest = tips.join('').trim();
        const used = new Set();
        for (let i = 0; i < total; i++) {
          await safeClick(page, blanks.nth(i));
          await page.waitForTimeout(180 + Math.floor(Math.random() * 220));
          if (!rest) continue;
          let pick = -1;
          let best = 0;
          chipTexts.forEach((text, idx) => {
            if (!text || used.has(idx) || text.length <= best) return;
            if (rest.startsWith(text)) {
              pick = idx;
              best = text.length;
            }
          });
          if (pick < 0) {
            chipTexts.forEach((text, idx) => {
              if (!text || used.has(idx) || pick >= 0) return;
              if (rest.includes(text)) pick = idx;
            });
          }
          if (pick < 0) {
            log(`词块没匹配上：${rest.slice(0, 8)}`);
            continue;
          }
          used.add(pick);
          await safeClick(page, chips.nth(pick));
          rest = rest.slice(chipTexts[pick].length);
          await page.waitForTimeout(280 + Math.floor(Math.random() * 320));
        }
      } else if (category.includes('填空')) {
        const blanks = page.locator('.q-body input');
        const count = await blanks.count();
        const flat = tips.length === 1 && count > 1 ? tips[0].split(/[,、；;]/) : tips;
        for (let i = 0; i < count; i++) {
          const value = flat[i] || flat[flat.length - 1] || '无';
          await blanks.nth(i).fill(value.trim()).catch(() => {});
        }
      } else if (tips.length) {
        const options = page.locator('.q-answer.choosable');
        const count = await options.count();
        const picked = new Set();
        for (const tip of tips) {
          for (let i = 0; i < count; i++) {
            const text = (await options.nth(i).innerText().catch(() => '')).trim();
            const norm = text.replace(/^[A-Z][.、]\s*/, '').replace(/\s+/g, '');
            const key = tip.replace(/\s+/g, '');
            if (!picked.has(i) && key && (key.includes(norm) || norm.includes(key))) {
              picked.add(i);
              await safeClick(page, options.nth(i));
              await page.waitForTimeout(150 + Math.floor(Math.random() * 250));
            }
          }
        }
        if (!picked.size) {
          // 提示只给字母的题型
          const letters = 'ABCDEFGHIJKLMN'.split('');
          for (const t of (tips.join(' ').match(/\b[A-N]\b/g) || [])) {
            const i = letters.indexOf(t.trim());
            if (i >= 0 && i < count) await safeClick(page, options.nth(i));
          }
        }
      }

      await page.waitForTimeout(400 + Math.floor(Math.random() * 500));

      // 最后一题的按钮是「完 成」（有的卷子是「交 卷」），点了就结束
      const submit = page.locator('.action-row button:has-text("交"), .action-row button:has-text("完")').first();
      if (await submit.count()) {
        await safeClick(page, submit);
        await page.waitForTimeout(1500);
        const confirm = page.locator('.ant-modal button:has-text("确")').first();
        if (await confirm.count()) await safeClick(page, confirm);
        await page.waitForTimeout(1200);
        // 出现解析说明这题已提交；再确认一次有没有独立交卷按钮
        const final = page.locator('button:has-text("交卷"), button:has-text("交 卷"), button:has-text("提交")').first();
        if (await final.count()) {
          await safeClick(page, final);
          await page.waitForTimeout(1000);
          const c2 = page.locator('.ant-modal button:has-text("确")').first();
          if (await c2.count()) await safeClick(page, c2);
        }
        log('已点击提交，正在核对实际积分');
        submitted = true;
        break;
      }

      const next = page.locator('.action-row > button').first();
      if (!(await next.count())) break;

      // 没提示 / 没匹配上时按钮是禁用的，先补选，别卡死
      for (let t = 0; t < 6; t++) {
        if (!(await body.count())) break;
        if (!(await next.isDisabled().catch(() => true))) break;
        await clearCaptcha(page);
        if (!(await body.count())) break;
        const capOn = await page.locator('#JS_aliyun-captcha-dialog.show').count();
        const options = page.locator('.q-answer.choosable');
        const count = await options.count();
        const chosen = await page.locator('.q-answer.chosen').count();
        log(`[补选${t + 1}] 选项${count} 已选${chosen} 验证码${capOn ? '有' : '无'}`);
        if (category.includes('点选') || !count) {
          const blanks = page.locator('.click-box');
          const bn = await blanks.count();
          if (!bn) break;
          const chips = page.locator('.fill-answer');
          const cn = await chips.count();
          if (!cn) break;
          // 空位挨个试词块，按钮点亮的瞬间就停
          let lit = false;
          for (let b = 0; b < bn && !lit; b++) {
            const filled = (await blanks.nth(b).innerText().catch(() => '')).trim();
            if (filled) continue;
            for (let k = 0; k < cn && !lit; k++) {
              await safeClick(page, blanks.nth(b));
              await safeClick(page, chips.nth(k));
              await page.waitForTimeout(320);
              if (!(await next.isDisabled().catch(() => true))) lit = true;
              else {
                const now = (await blanks.nth(b).innerText().catch(() => '')).trim();
                if (now) {
                  await safeClick(page, blanks.nth(b));
                  await page.waitForTimeout(160);
                }
              }
            }
          }
        } else if (chosen === 0) {
          // 只在没选中时补点，避免把已选的又点掉
          await safeClick(page, options.nth(t % count));
        }
        await page.waitForTimeout(700);
      }
      if (!(await body.count())) {
        submitted = true;
        log('已离开答题页，正在核对实际积分');
        break;
      }
      if (await next.isDisabled().catch(() => true)) {
        log('确定按钮点不亮，跳过这题');
        break;
      }

      if (await next.isDisabled().catch(() => true)) await fillEmptyBlanks(page);
      await safeClick(page, next);
      answered++;
      await page.waitForTimeout(400);
      // 弹确认框（最后一题常见）就直接确认
      const confirmBox = page.locator('.ant-modal button:has-text("确")').first();
      if (await confirmBox.count()) {
        await safeClick(page, confirmBox);
        log('已点击提交，正在核对实际积分');
        submitted = true;
        break;
      }
      // 等换题；最后一题答完按钮会变「完 成」，或页面直接离开答题区
      let changed = false;
      let finished = false;
      for (let k = 0; k < 24 && !changed; k++) {
        if (!(await body.count())) {
          finished = true;
          break;
        }
        const label = (await next.innerText().catch(() => '')).replace(/\s+/g, '');
        // 答错后先显示解析，需要再点一次「下一题」才会换题。
        if (label === '下一题') {
          await safeClick(page, next);
          await page.waitForTimeout(500);
        }
        if (label.includes('完')) {
          finished = true;
          break;
        }
        if (!(await body.count())) {
          finished = true;
          break;
        }
        const now = (await body.innerText().catch(() => '')).replace(/\s+/g, ' ').slice(0, 50);
        if (now !== question) changed = true;
        else await page.waitForTimeout(500);
      }
      if (finished) {
        // 最后一题点完会再弹一次滑块，不处理「完成」点不动
        const finish = page.locator('.action-row button:has-text("完"), button:has-text("交卷")').first();
        for (let t = 0; t < 3; t++) {
          await clearCaptcha(page);
          if (!(await finish.count())) break;
          await safeClick(page, finish);
          await page.waitForTimeout(1500);
          const confirm3 = page.locator('.ant-modal button:has-text("确")').first();
          if (await confirm3.count()) {
            await safeClick(page, confirm3);
            await page.waitForTimeout(1200);
          }
          const label = (await finish.innerText().catch(() => '')).replace(/\s+/g, '');
          if (!label.includes('完')) break;
        }
        await clearCaptcha(page);
        log('已点击提交，正在核对实际积分');
        submitted = true;
        break;
      }
      if (!changed) {
        const tail = page.locator('.action-row button:has-text("交")').first();
        if (await tail.count()) continue;
        // 点选填空有空位没填满时，确定会点了不生效，先补满
        await fillEmptyBlanks(page);
        log('题干一直没变，补填空位后再点一次确定');
        await safeClick(page, next);
        const confirm2 = page.locator('.ant-modal button:has-text("确")').first();
        if (await confirm2.count()) {
          await safeClick(page, confirm2);
          submitted = true;
          log('已点击提交，正在核对实际积分');
          break;
        }
        const tail2 = page.locator('.action-row button:has-text("交")').first();
        if (!(await tail2.count())) {
          log('还是没反应，收工');
          break;
        }
      }
      await page.waitForTimeout(500 + Math.floor(Math.random() * 700));
    }

    // 兜底：没交上卷就再来一遍，不然一分都不给
    if (!submitted) {
      for (let attempt = 0; attempt < 3 && !submitted; attempt++) {
        const submit = page.locator('.action-row button:has-text("交")').first();
        if (await submit.count()) {
          await safeClick(page, submit);
        } else {
          const any = page.locator('.action-row button:not([disabled])').first();
          if (!(await any.count())) break;
          await safeClick(page, any);
        }
        await page.waitForTimeout(1500);
        const confirm = page.locator('.ant-modal button:has-text("确")').first();
        if (await confirm.count()) {
          await safeClick(page, confirm);
          log('兜底交卷');
          submitted = true;
          break;
        }
        if (!(await page.locator('.q-body').count())) {
          log('已离开答题页，视为交卷');
          submitted = true;
        }
      }
    }

    await page.waitForTimeout(3000);
    await clearCaptcha(page);
    const latest = await progress.refresh();
    const actual = latest.tasks?.[cfg.code];
    if (!actual || actual.done < actual.max) throw new Error(`${cfg.name}积分未达标，请查看官方答题结果`);
    return `${cfg.name}已确认计分 ${actual.done}/${actual.max}`;
  } finally {
    await close();
  }
}
