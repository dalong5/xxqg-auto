# 故障复盘：每日答题自动化全链路（2026-11-06）

对象：`app/src/xxqg/{plain,tasks,browser}.js` + `app/scripts/native.ps1`
现象汇总：每日答题长期 0/5，交卷一律 `{"code":403,"message":"slider verify failed"}`；无 CDP 通道上线后能答题但推不动、跑一半浏览器消失。

下面按「现象 → 证据 → 失效原理 → 边界 → 修复」逐条拆。所有结论都来自本机实测日志，不是推测。

---

## 1. 滑块必挂：判据不是「有没有 devtools」，而是「浏览器是不是被自动化框架驱动」

**现象**
- CDP（Playwright + Chrome）拖滑块：`sliderX 452 -> 452`，每次都弹回原位，交卷返回 F001/`slider verify failed`。
- 连续失败 3 次后换 certifyId 重试、关掉弹窗再点、换重进卷子再交，全部失败。

**证据（对照实验，同一账号、同一网络、同一台机器）**

| 组合 | 结果 |
| --- | --- |
| Playwright + Chrome（CDP） | 全败 |
| Playwright + Firefox（Juggler，**完全没有 CDP**） | 全败 |
| 普通 Chrome（无任何调试端口）+ 预置 cookie + **OS 鼠标** | **通过**，2/5 → 5/5，总分 27 → 32 |
| CDP 窗口 + OS 鼠标（SendInput） | 失败，滑块 x 不动 |

**失效原理**
阿里云滑块的风险分不是看「端口开没开」，而是综合：`navigator.webdriver`、驱动注入痕迹（CDP 的 `Runtime.enable` 副作用、Firefox 的 marionette 端口）、输入事件的来源与轨迹、以及该账号/IP 的历史失败惩罚。
Playwright 两种引擎都算「被驱动」，所以 CDP 与 Firefox 表现一致；只有「原生启动 + 操作系统输入栈的鼠标」这一组合没有驱动痕迹，且 `mouse_event` 产生的 `isTrusted` 为真、带真实 `sourceCapabilities`。

**边界**
- 已排除（实测无效）：换出口 IP、UA/DPR 一致性、轨迹形状抖动、`abnormal_exam` 开关、headless/headed 切换、关闭弹窗重试、换 certifyId 重交、在 CDP 浏览器里用 OS 鼠标。 
- 账号维度会累积：同一天连续失败十几次后，即使换成可用组合，首次也可能被抽样拦一次。

**修复**
整卷必须在「原生启动的 Chrome」里完成（`plain.runDaily`），并且**所有交互走 SendInput**。

---

## 2. 卷子是「页面级状态」：跨浏览器交接必然失败

**现象**
CDP 里答完 5 题、停在「完 成」按钮前不动，关掉浏览器换普通 Chrome 去交卷 → 打开是 **1/5 的全新卷子**，`submitOnly()` 报「没有完成按钮」，分数不动。

**失效原理**
未交卷的作答只存在页面内存/sessionStorage 里，服务端只记「今日是否已得分」。一旦换页面（或同账号多端），旧卷即作废，服务端会返回「不支持多端同时作答」。

**边界**
即使把上一个浏览器 `browser.close()` 完全关掉再开，也救不回来——这不是时序问题，是模型问题。

**修复**
删掉「CDP 答题 + 普通 Chrome 交卷」的交接路径（`tasks.js` 里 `PLAIN_SUBMIT` 恒为 `false`），只保留两条互斥通道：
- 全 Playwright（答题顺，滑块必挂）→ 默认不用于每日答题；
- 全普通 Chrome（`XXQG_PLAIN_ONLY=1` → `plain.runDaily`）。

---

## 3. `tipRect()` 永远返回 null：一个 `JSON.parse` 把整条链路静默打死

**现象**
每道题 `hint=` 都是空，于是只能盲点第 0 个选项；多选题 `确定` 一直是 `disabled`，同一题被反复重试，14 轮耗尽后报「没有完成按钮」。

**失效原理**
`probe()` 读的是**窗口标题**，Chrome 会给标题加后缀：

```
TIP:[1899,943] - Google Chrome
```

原代码 `JSON.parse(raw.slice(4))` 实际解析的是 `"[1899,943] - Google Chrome"` → 抛异常 → 被 `catch` 吞成 `null` → 「查看提示」从来没被点过。整条答题链断在这里，但日志上只表现为「提示为空」。

**边界**
所有「把 JSON 塞进 `document.title` 再整体 parse」的代码都会中招；标题后缀永远存在，且不同页面（PDF、搜索结果）后缀不同。

**修复**

```js
const m = raw.match(/\[[^\]]*\]/);   // 只取第一段数组
if (!m) return null;
return JSON.parse(m[0]);
```

---

## 4. 地址栏 `javascript:` 注入的四个脆弱点

| # | 现象 | 原理 | 修复 |
| --- | --- | --- | --- |
| 1 | 整页被换成 Google 搜索 | 粘贴时 Chrome 会剥掉 `javascript:` 前缀，剩下的当搜索词 | 分三段粘贴：正文 → `:` → `javascript` |
| 2 | 提示「搜不到」或 URL 不执行 | 中文输入法下 `Shift+;` 出全角 `：` | 不再用 SendKeys 打冒号，改用剪贴板粘 `:` |
| 3 | 偶发 `Set-Clipboard ... ExternalException` | 剪贴板被其它进程占用 | 重试 8 次，失败再退到 `Clipboard::SetText` |
| 4 | 整页白屏 / 首屏内容被替换 | `javascript:` 的返回值是字符串时，Chrome 用返回值替换文档 | 一律 `void(...)` 包裹，并先写哨兵标题判断是否执行成功 |

另外还有第 5 个：**地址栏抢焦点竞态**——`Ctrl+L` 后立刻 `Ctrl+V` 会丢字。用哨兵值（先置 `QQP`，跑完标题仍是 `QQP` 就重试）判定，比「标题有没有变化」可靠。

---

## 5. 跑到一半浏览器消失：多实例、句柄缓存、渲染进程崩溃

**现象**
第 7~8 个页面动作后：`no chrome window` / `bad window handle`；profile 里出现 `Crashpad/` 目录；有时同时存在两个普通 Chrome 窗口。

**失效原理（三层）**
1. **并发**：多个进程共用同一 profile 路径，后启动的实例触发 Chrome 的 profile 锁，窗口直接不出现；两个任务还会互相 `killplain`。
2. **句柄缓存**：`Get-Process` 拿到的 `Process` 对象被存下来，窗口一关，`MainWindowHandle` 变成 0，后续 `ShowWindow` 抛「无法转换 IntPtr」。
3. **渲染进程崩溃**：虚拟化环境 + GPU/沙箱 + 高频页面内脚本执行，Crashpad 有记录。

**修复**
- 单实例互斥：`seedProfile()` 先 `killplain`，失败则重试删目录；`runDaily` 结束必关浏览器。
- 每次动作前**重新解析 HWND** 并 `IsWindow()` 校验（`Resolve-Hwnd`），不缓存。
- 启动参数加 `--no-sandbox --disable-gpu --disable-software-rasterizer --disable-dev-shm-usage --disable-features=CalculateNativeWinOcclusion`。
- 崩溃后重启续做：卷子是页面级状态 → 只能整卷重来，因此用「已答题数」记录进度，避免重复提交。

---

## 6. 翻页语义：`确定` 之后还有一个 `下一题`

**现象**
答完一题后下一轮读到**同一道题**，判定「没动」，进入补选死循环。

**原理**
点 `确定` 后页面切到解析态，按钮文字变成 `下一题`，必须再点一次才翻页。

**修复**

```js
await clickAt(fin.c[0], fin.c[1]);
if (!/完/.test(fin.t)) {
  const after = await rects();
  const next = (after.btns || []).find((b) => /下一题/.test(b.t) && !b.d);
  if (next) await clickAt(next.c[0], next.c[1]);
}
```

---

## 7. 修复后的代码（当前仓库状态）

| 文件 | 关键改动 |
| --- | --- |
| `app/src/xxqg/plain.js` | `probe()` 哨兵重试；`tipRect()` 正则取数组；`advance()` 支持多选按提示对齐 + 兜底全点 + 翻页；`submitOnly()` 只做交卷；`open()` 加稳定性参数并等 `ready`；`runDaily()` 整卷流程 + finally 关浏览器 |
| `app/scripts/native.ps1` | `Set-Clip` 剪贴板重试；`Resolve-Hwnd` 每次重解析 + `IsWindow`；`paste` 三段粘贴；`nav` 直接粘 URL |
| `app/src/xxqg/tasks.js` | 移除跨浏览器交接（`PLAIN_SUBMIT=false`）；`XXQG_PLAIN_ONLY=1` 走整卷普通 Chrome 通道 |
| `app/src/xxqg/browser.js` | `setCaptchaSolverEnabled()`；`clearCaptcha` 里先试 OS 鼠标拖拽 |

---

## 8. 剩余风险与下一步（按收益排序）

1. **彻底去掉地址栏注入**：把「页面内 agent」做成 bookmarklet 预置进 profile 收藏夹栏，用**固定坐标单击一次**启动；agent 只做两件事——把可点击元素矩形写进 `document.title`，以及读取提示文本。之后 Node 只读标题 + SendInput 点击，`javascript:`/剪贴板/输入法三类故障一次性消失。
   - 待验证：`Bookmarks` + `Preferences.bookmark_bar.show_on_all_tabs` 是否被本机 Chrome 156 接受（本轮实验未点中，坐标换算仍按 UI 2x 需要重测）。
2. 卷子级幂等：每答一题把 `(uid, day, 题号, 选项)` 落到 `events`，崩溃重来时能判断「这题已经答过」，避免重复扣分/重复提交。
3. 滑块失败分级：连续 N 次 F001 后当天不再重试，避免把账号风控分越刷越高。
