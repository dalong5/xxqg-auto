// 前端：无框架、无构建。状态极简：me + accounts + 一个 SSE。
const $ = (s) => document.querySelector(s);
const api = async (path, opts = {}) => {
  const res = await fetch(`/api/v1${path}`, {
    headers: { 'content-type': 'application/json' },
    credentials: 'same-origin',
    ...opts,
  });
  const data = await res.json().catch(() => ({}));
  if (!res.ok) throw new Error(data?.error?.message || `请求失败 ${res.status}`);
  return data;
};

const state = { me: null, sse: null, loginSse: null };

const TASK_LABEL = {
  login: '登录',
  article: '阅读',
  video: '视听',
  daily: '每日答题',
  weekly: '每周答题',
  special: '专项答题',
};
const CODE_OF = { login: 9, article: 1, video: 2, daily: 6, weekly: 5, special: 4 };

function fmtTime(ts) {
  if (!ts) return '-';
  const d = new Date(ts);
  return `${String(d.getHours()).padStart(2, '0')}:${String(d.getMinutes()).padStart(2, '0')}`;
}

function render() {
  const { me } = state;
  $('#driver').textContent = `driver: ${me.driver}`;
  $('#quota').textContent = `${me.quota.used}/${me.quota.max} 账号`;
  $('#gate').classList.toggle('hidden', !me.needInvite);

  const list = me.accounts || [];
  $('#empty').classList.toggle('hidden', list.length > 0 || me.needInvite);
  const root = $('#accounts');

  // 定点更新：账号集合没变就不重建 DOM（20s 轮询会把按钮状态/滚动位置冲掉）
  const sig = JSON.stringify(list);
  if (sig === state.renderSig && root.children.length === list.length) {
    list.forEach((a) => patchCard(root.children[list.indexOf(a)], a));
    return;
  }
  state.renderSig = sig;
  root.innerHTML = '';
  for (const a of list) root.appendChild(card(a));
}

/** 只更新会变的数字，不碰按钮和事件监听 */
function patchCard(el, a) {
  if (!el) return;
  const today = a.scoreToday || 0;
  const ring = el.querySelector('.ring');
  if (ring) {
    ring.style.setProperty('--p', Math.min(100, Math.round((today / 45) * 100)));
    ring.firstElementChild.textContent = today;
  }
  const meta = el.querySelector('.score-meta');
  if (meta) {
    meta.children[0].innerHTML = `今日 <b>${today}</b> 分`;
    meta.children[1].textContent = `总分 ${a.scoreTotal || 0} · 上次同步 ${fmtTime(a.lastSyncAt)}`;
    meta.children[2].textContent = `定时：${a.schedule ? `${a.schedule.at}（下一次 ${fmtTime(a.schedule.nextRunAt)}）` : '未设置'}`;
  }
  const chips = el.querySelector('.chips');
  if (chips) {
    chips.innerHTML = Object.values(a.tasks || {})
      .map((t) => `<span class="chip ${t.done >= t.max ? 'done' : ''}">${t.name} ${t.done}/${t.max}</span>`)
      .join('');
  }
}

function card(a) {
  const el = document.createElement('article');
  el.className = 'card';
  const today = a.scoreToday || 0;
  // 今日上限按现有任务算，最多 45
  const max = 45;
  const pct = Math.min(100, Math.round((today / max) * 100));
  const chips = Object.entries(a.tasks || {})
    .map(([code, t]) => {
      const done = t.done >= t.max;
      return `<span class="chip ${done ? 'done' : ''}">${t.name} ${t.done}/${t.max}</span>`;
    })
    .join('');
  const sched = a.schedule ? `${a.schedule.at}（下一次 ${fmtTime(a.schedule.nextRunAt)}）` : '未设置';
  el.innerHTML = `
    <div class="acct-head">
      <div>
        <div class="acct-name">${a.nick || '未命名账号'}</div>
        <div class="acct-uid">uid ${a.uid}</div>
      </div>
      <span class="status ${a.status}">${a.status === 'active' ? '正常' : '需重新登录'}</span>
    </div>
    <div class="score-row">
      <div class="ring" style="--p:${pct}"><span>${today}</span></div>
      <div class="score-meta">
        <div>今日 <b>${today}</b> 分</div>
        <div>总分 ${a.scoreTotal || 0} · 上次同步 ${fmtTime(a.lastSyncAt)}</div>
        <div>定时：${sched}</div>
      </div>
    </div>
    <div class="chips">${chips || '<span class="chip">还没有分数数据</span>'}</div>
    <div class="actions">
      <button class="primary" data-act="run">开始任务</button>
      <button data-act="sync">同步分数</button>
      <button data-act="schedule">设定时</button>
      <button class="ghost" data-act="events">看日志</button>
      <button class="ghost" data-act="remove">删除</button>
    </div>`;

  el.querySelector('[data-act="run"]').onclick = async (e) => {
    e.target.disabled = true;
    try {
      const { jobId, reused } = await api(`/accounts/${a.id}/run`, { method: 'POST', body: '{}' });
      openLog(jobId, `${a.nick || a.uid} 的任务${reused ? '（复用进行中的）' : ''}`);
    } catch (err) {
      alert(err.message);
    } finally {
      e.target.disabled = false;
    }
  };
  el.querySelector('[data-act="sync"]').onclick = async () => {
    try {
      const { jobId } = await api(`/accounts/${a.id}/sync`, { method: 'POST', body: '{}' });
      openLog(jobId, `${a.nick || a.uid} 分数同步`);
    } catch (err) {
      alert(err.message);
    }
  };
  el.querySelector('[data-act="schedule"]').onclick = async () => {
    const at = prompt('每天几点自动跑？（HH:MM，留空=取消定时）', a.schedule?.at || '07:30');
    if (at === null) return;
    try {
      await api(`/accounts/${a.id}/schedule`, { method: 'PUT', body: JSON.stringify({ at: at.trim(), enabled: !!at.trim() }) });
      await refresh();
    } catch (err) {
      alert(err.message);
    }
  };
  el.querySelector('[data-act="events"]').onclick = async () => {
    const { events } = await api(`/accounts/${a.id}/events?limit=80`);
    const box = $('#log');
    box.innerHTML = events.map((e) => line(e)).join('');
    $('#log-title').textContent = `${a.nick || a.uid} 最近日志`;
    $('#logcard').classList.remove('hidden');
    $('#logcard').scrollIntoView({ behavior: 'smooth' });
  };
  el.querySelector('[data-act="remove"]').onclick = async () => {
    if (!confirm(`删除账号 ${a.nick || a.uid}？`)) return;
    await api(`/accounts/${a.id}`, { method: 'DELETE' });
    await refresh();
  };
  return el;
}

function line(e) {
  const t = new Date(Number(e.created_at) || Date.now());
  const hh = `${String(t.getHours()).padStart(2, '0')}:${String(t.getMinutes()).padStart(2, '0')}:${String(t.getSeconds()).padStart(2, '0')}`;
  const msg = e.message || e.type;
  return `<span class="line ${e.level || 'info'}">${hh}  ${escapeHtml(msg)}</span>`;
}

const escapeHtml = (s) =>
  String(s).replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));

/** 订作业日志 SSE：先清屏，增量追加 */
function openLog(jobId, title) {
  if (state.sse) state.sse.close();
  const box = $('#log');
  box.innerHTML = '';
  $('#log-title').textContent = title;
  $('#logcard').classList.remove('hidden');
  $('#logcard').scrollIntoView({ behavior: 'smooth' });
  const es = new EventSource(`/api/v1/jobs/${jobId}/events`);
  state.sse = es;
  es.addEventListener('log', (ev) => {
    box.insertAdjacentHTML('beforeend', line(JSON.parse(ev.data)));
    box.scrollTop = box.scrollHeight;
  });
  es.addEventListener('done', async (ev) => {
    const d = JSON.parse(ev.data);
    box.insertAdjacentHTML('beforeend', `<span class="line ${d.status === 'done' ? 'info' : 'error'}">—— 结束：${d.status} ${d.error || ''}</span>`);
    es.close();
    state.sse = null;
    await refresh();
  });
  es.onerror = () => {
    es.close();
    state.sse = null;
  };
}

async function refresh() {
  state.me = await api('/me');
  render();
}

// ---------- 扫码 ----------
async function startLogin() {
  const { sid, qr } = await api('/accounts/login', { method: 'POST', body: '{}' });
  $('#modal').classList.remove('hidden');
  $('#qr').innerHTML = renderQr(qr);
  $('#qr-state').textContent = '请用学习强国 App 扫描';
  const es = new EventSource(`/api/v1/accounts/login/${sid}/events`);
  state.loginSse = es;
  es.addEventListener('status', async (ev) => {
    const s = JSON.parse(ev.data);
    if (s.status === 'scanned') $('#qr-state').textContent = '已扫码，请在手机上确认';
    if (s.status === 'done') {
      es.close();
      state.loginSse = null;
      $('#modal').classList.add('hidden');
      await refresh();
    }
    if (s.status === 'expired') {
      es.close();
      $('#qr-state').textContent = '二维码已过期，请重新打开';
    }
  });
  es.onerror = () => es.close();
}

/** mock 驱动给的是 mock:// 字样，真实驱动给的是 https 链接；两者都用 qrserver 兜底渲染 */
function renderQr(payload) {
  const text = String(payload || '');
  if (/^https?:\/\//.test(text)) {
    return `<img alt="二维码" src="https://api.qrserver.com/v1/create-qr-code/?size=200x200&data=${encodeURIComponent(text)}" />`;
  }
  return `<span>${escapeHtml(text)}</span>`;
}

function closeModal() {
  $('#modal').classList.add('hidden');
  if (state.loginSse) state.loginSse.close();
  state.loginSse = null;
}

// ---------- 事件绑定 ----------
$('#add').onclick = startLogin;
$('#add-first').onclick = startLogin;
$('#qr-cancel').onclick = closeModal;
$('#log-close').onclick = () => $('#logcard').classList.add('hidden');

$('#gate-form').onsubmit = async (e) => {
  e.preventDefault();
  const code = $('#invite').value.trim();
  try {
    await api('/register', { method: 'POST', body: JSON.stringify({ invite: code }) });
    await refresh();
    $('#gate-msg').textContent = '';
  } catch (err) {
    $('#gate-msg').textContent = err.message;
  }
};

// 每 20s 静默刷新一次分数（SSE 只覆盖当前作业）
setInterval(() => refresh().catch(() => {}), 20_000);

refresh().catch((e) => {
  document.body.insertAdjacentHTML('afterbegin', `<pre style="color:#e05b5b;padding:12px">${escapeHtml(e.message)}</pre>`);
});
