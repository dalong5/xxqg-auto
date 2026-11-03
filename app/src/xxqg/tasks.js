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

export async function learn(kind, { jar, progress, shouldStop, uid }) {
  const isVideo = kind === 'video';
  const label = isVideo ? '视听' : '阅读';
  const cap = () => progress().tasks?.[isVideo ? 2 : 1];
  const timeCap = () => progress().tasks?.[isVideo ? 1003 : 1002];

  if (cap() && cap().done >= cap().max && timeCap() && timeCap().done >= timeCap().max) {
    return `${label}已满分，跳过`;
  }

  const items = await feed(kind);
  const { page, close } = await newSession(jar, { uid });
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
      if (progress.refresh) await progress.refresh();
      c = cap();
      t = timeCap();
      progress.note?.(`${label}进度 ${c ? c.done : '?'}/${c ? c.max : '?'} 项，${t ? t.done : '?'}/${t ? t.max : '?'} 分`);
      if (c && t && c.done >= c.max && t.done >= t.max) break;
    }
    return `${label}完成 ${count} 项`;
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
  await safeClick(page, tipBtn).catch(() => {});
  await page.waitForTimeout(600 + Math.floor(Math.random() * 500));
  const html = await page.locator('.ant-popover .line-feed').first().innerHTML().catch(() => '');
  const tips = [...html.matchAll(/<font[^>]*>([\s\S]*?)<\/font>/g)]
    .map((m) => m[1].replace(/<[^>]+>/g, '').replace(/\s+/g, ' ').trim())
    .filter(Boolean);
  await page.mouse.click(20, 20).catch(() => {});
  await page.waitForTimeout(300);
  return tips;
}

/**
 * 答题：题目页自带「查看提示」，提示里就是答案。
 * 这是官方答案源，比外部题库稳，不用维护答案表。
 */
export async function quiz(kind, { jar, progress, uid }) {
  const cfg = EXAM_ENTRY[kind];
  if (!cfg) throw new Error(`未知题型 ${kind}`);
  const task = progress().tasks?.[cfg.code];
  if (task && task.done >= task.max) return `${cfg.name}已满分，跳过`;

  const { page, close } = await newSession(jar, { uid });
  const log = progress.note || (() => {});
  try {
    await page.goto('https://pc.xuexi.cn/points/my-points.html', { waitUntil: 'domcontentloaded', timeout: 45000 });
    await page.waitForTimeout(3000);
    await clearCaptcha(page);

    // 入口是卡片里那个「去答题」，点标题没用
    const card = page.locator('.my-points-card', { hasText: cfg.name }).first();
    if (!(await card.count())) throw new Error(`页面上没有「${cfg.name}」入口`);
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

      const tips = await readTips(page);

      if (category.includes('点选')) {
        // 点选填空：.click-box 是空位，.fill-answer 是词块；先点空位再点词块
        const blanks = page.locator('.click-box');
        const total = await blanks.count();
        for (let i = 0; i < total; i++) {
          const word = tips[i] ?? tips[tips.length - 1];
          if (!word) break;
          await safeClick(page, blanks.nth(i)).catch(() => {});
          await page.waitForTimeout(200 + Math.floor(Math.random() * 250));
          const chip = page.locator('.fill-answer').filter({ hasText: new RegExp(`^\\s*${word.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}\\s*$`) }).first();
          if (!(await chip.count())) {
            log(`词块没找到：${word}`);
            continue;
          }
          await safeClick(page, chip).catch(() => {});
          await page.waitForTimeout(300 + Math.floor(Math.random() * 350));
        }
      } else if (category.includes('填空')) {
        const blanks = page.locator('.q-body input');
        const count = await blanks.count();
        const flat = tips.length === 1 && count > 1 ? tips[0].split(/[,、；;]/) : tips;
        for (let i = 0; i < count; i++) {
          if (flat[i]) await blanks.nth(i).fill(flat[i].trim()).catch(() => {});
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
              await safeClick(page, options.nth(i)).catch(() => {});
              await page.waitForTimeout(150 + Math.floor(Math.random() * 250));
            }
          }
        }
        if (!picked.size) {
          // 提示只给字母的题型
          const letters = 'ABCDEFGHIJKLMN'.split('');
          for (const t of (tips.join(' ').match(/\b[A-N]\b/g) || [])) {
            const i = letters.indexOf(t.trim());
            if (i >= 0 && i < count) await safeClick(page, options.nth(i)).catch(() => {});
          }
        }
      }

      await page.waitForTimeout(400 + Math.floor(Math.random() * 500));

      // 最后一题会出现「交 卷」
      const submit = page.locator('.action-row button:has-text("交")').first();
      if (await submit.count()) {
        await safeClick(page, submit).catch(() => {});
        await page.waitForTimeout(1200);
        const confirm = page.locator('.ant-modal button:has-text("确")').first();
        if (await confirm.count()) await safeClick(page, confirm).catch(() => {});
        log('已交卷');
        submitted = true;
        break;
      }

      const next = page.locator('.action-row > button').first();
      if (!(await next.count())) break;

      // 没提示 / 没匹配上时按钮是禁用的，先补选，别卡死
      for (let t = 0; t < 3; t++) {
        if (!(await next.isDisabled().catch(() => true))) break;
        if (t === 0) await clearCaptcha(page);
        const options = page.locator('.q-answer.choosable');
        const count = await options.count();
        if (category.includes('点选') || !count) {
          const blanks = page.locator('.click-box');
          const bn = await blanks.count();
          if (!bn) break;
          log('词块没点上，按 DOM 顺序把词块都点一遍');
          const chips = page.locator('.fill-answer');
          const cn = await chips.count();
          for (let k = 0; k < cn; k++) await safeClick(page, chips.nth(k)).catch(() => {});
          await safeClick(page, blanks.nth(Math.floor(Math.random() * bn))).catch(() => {});
        } else {
          log('没匹配到答案，随机选一个');
          await safeClick(page, options.nth(Math.floor(Math.random() * count))).catch(() => {});
        }
        await page.waitForTimeout(600);
      }
      if (await next.isDisabled().catch(() => true)) {
        log('确定按钮点不亮，跳过这题');
        break;
      }

      await safeClick(page, next).catch(() => {});
      answered++;
      // 等题干真的换掉，别用固定 sleep 误判成卡住
      const changed = await page
        .waitForFunction(
          (prev) => (document.querySelector('.q-body')?.innerText || '').replace(/\s+/g, ' ').slice(0, 50) !== prev,
          question,
          { timeout: 15000 },
        )
        .then(() => true)
        .catch(() => false);
      if (!changed) {
        const tail = page.locator('.action-row button:has-text("交")').first();
        if (!(await tail.count())) {
          log('题干一直没变，收工');
          break;
        }
      }
      await page.waitForTimeout(500 + Math.floor(Math.random() * 700));
    }

    // 兜底：还停在题目页就直接交卷，不然一分都不给
    if (!submitted) {
      const submit = page.locator('.action-row button:has-text("交")').first();
      if (await submit.count()) {
        await safeClick(page, submit).catch(() => {});
        await page.waitForTimeout(1200);
        const confirm = page.locator('.ant-modal button:has-text("确")').first();
        if (await confirm.count()) await safeClick(page, confirm).catch(() => {});
        log('兜底交卷');
      }
    }

    await page.waitForTimeout(3000);
    return `${cfg.name}作答 ${answered} 题`;
  } finally {
    await close();
  }
}
