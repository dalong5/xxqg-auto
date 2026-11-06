// 打开页面后：读取同目录 cookies.json → 写 cookie → 重载；再把页面几何信息 POST 回本机
async function seed() {
  const url = chrome.runtime.getURL('cookies.json');
  let list = [];
  try {
    list = await (await fetch(url)).json();
  } catch {
    return;
  }
  for (const c of list) {
    await chrome.cookies
      .set({
        url: 'https://' + (c.domain || '.xuexi.cn').replace(/^\./, '') + c.path,
        name: c.name,
        value: c.value,
        domain: c.domain || '.xuexi.cn',
        path: c.path || '/',
        secure: true,
        httpOnly: false,
        expirationDate: Math.floor(Date.now() / 1000) + 86400,
      })
      .catch(() => {});
  }
  const [tab] = await chrome.tabs.query({ url: 'https://pc.xuexi.cn/*' });
  if (tab) await chrome.tabs.reload(tab.id);
}

chrome.runtime.onStartup.addListener(seed);
chrome.runtime.onInstalled.addListener(seed);
seed();