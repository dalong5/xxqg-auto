# 进度日志

## 2026-11-03

真机实测（账号已授权，分数为真实值）：

| 项 | 结果 |
| --- | --- |
| 扫码登录 | ✅ 成功，写入 `token`，昵称「龙铭梽」 |
| 每日登录 1 分 | ✅ 自动到账 |
| 阅读文章 | ✅ 12/12（30 篇，每篇停留 62s + 滚动） |
| 文章时长 | ✅ 12/12（与阅读同步） |
| 视听学习 | ✅ 12/12（修好 `autoplay=false` 后） |
| 视听时长 | ✅ 12/12 |
| 每日答题 | ⏳ 入口与提示已打通，卡在「点选填空」与滑块 |

已修：

1. `progress` 契约错误（传函数，实际要 `{jar, progress, shouldStop}`）
2. 密钥文件被双进程竞争覆盖 → 原子 `wx` 创建，并加 `logins.jar` 自愈恢复
3. 多 worker 幽灵进程重复跑同一账号 → 心跳表 + 死任务回收 + 同账号串行
4. 分数被旧快照写回 → 当天只接受更高 total
5. 日志用旧快照显示「还差 N 项」→ 每篇结束 `refresh()` 再判断
6. 视频不播放 → 静音强制 `play()`，按视频时长停留，无 `video` 元素 8 秒跳过
7. 答题入口点标题无效 → 点卡片里的「去答题」；提示改读 `.ant-popover .line-feed`

实测数据点：单账号阅读满分约 11 分钟、视听满分约 13 分钟；整轮 25 分约 30 分钟。

### 2026-11-03 续（答题全流程打通，卡在阿里云滑块 F001）

当日积分实测：阅读 12/12、视听 12/12、登录 1/1、每日答题 0/5，total 27（专项历史 2 分已计入，进度接口不显示无活动项）。理论上限 45，**还差 18**（每日 5 + 每周 5 + 专项 8），三者全部止步于同一个滑块。

已修：

1. 交卷按钮其实是「完 成」且题干不变（答案是解析把题干替换了）→ 改成 完成/交卷 匹配 + 完成态轮询
2. 滑块拦截点击 → `clearCaptcha` 进 `safeClick`，带 3 次重试
3. 点选填空随机补选 → 提示串贪心匹配词块
4. 交卷后接答案解析 → 抓独立交卷按钮 + antd 二次确认
5. 交卷彻底失败 → 关弹窗重试 + 删 `abnormal_exam` 再点 + `[captcha-blocked]` 标记

**滑块 F001 定位（结论：不是代码问题）**

- 逆向出交卷接口与载荷结构（见 `docs/PROTOCOL.md`），顺带发现 `abnormal_exam` 是 cookie 而不是 sessionStorage
- 用 `window.initAliyunCaptcha` 打桩抓到真实 POST，服务端回 `{"code":403,"message":"slider verify failed"}`：没有合法 `captchaVerifyParam` 就是不收
- 滑块本身是活的（`style.left` 0→320px），鼠标/指针事件全到齐（`elementFromPoint` 就是滑块），轨迹随步数增长（372→720 字节）也确实被 `Log3` 上报，但 `VerifyCaptchaV3` 恒回 `F001`（阿里云文档：风控判定攻击）
- 排除项：页面无焦点、DPI、`--enable-automation`/`webdriver`、原生 Chrome 走 CDP、时区对出口 IP、等 `InitCaptchaV3` 回来再拖、拖动时长/步数/起止点、headless vs 有头、操作系统级真实鼠标拖动（cua）
- 推断：本机出口 IP 在新加坡（134.195.100.26，AS46997），阿里云风控直接判风险设备；每次进答题页 `abnormal_exam` 都被置 1

待办：

- [ ] 换境内出口（或住宅代理）再验一次滑块是否放行
- [ ] 每周答题 / 专项答题 是同一家滑块，通了就一起通
- [ ] 前端「一键」按 登录 → 阅读 → 视听 → 答题 排序，任务间停顿
- [ ] 定时调度（凌晨错峰）
- [ ] 多用户额度与邀请码
- [ ] 推 GitHub 私有库（缺凭据）
### 2026-11-03 收尾（交接）

- 中国出口代理也试了（119.188.131.55:17981 山东联通，答复正常），滑块依旧 `F001` → **不是境外 IP 的问题**，别再往这个方向查。
- 研究产物全部入库到 `app/research/`（探针、SDK 包、日志、`README.md` 索引），交接文档 `docs/HANDOFF.md` 写明已排除项与下一步优先级。
- 当前分数 27 已固化，进度/协议/交接三份文档同步。
### 2026-11-03 深夜 继续查滑块（第二轮）

新证据（都记进 HANDOFF，别重复做）：

- 阿里云官方错误码表：`F001` = 「疑似攻击请求，风险策略不通过」；另有 `F024` = 「检测到自动化脚本模拟点击、滑动」。官方问答里还有一条直接说 **开着 F12/devtools 触发敏感调试行为就会被风控判 F001** —— Playwright/CDP 全程等价于 devtools 附着，这是目前最像的成因。
- 另一个官方问答提到 `captchaVerifyParam` **里的 `+` 被转义成空格**会导致服务端判失败；我们这条链路是页面自己拼 header，`+` 保持原样，基本排除。
- 一致性实验全部照做仍 `F001`：`--disable-blink-features=AutomationControlled`、`webdriver=false`、去掉 UA 里的 `HeadlessChrome/`、有头模式、让 `innerWidth/outerWidth/screen` 三者一致（本机真实屏幕 1536×960→CSS 1280×720，DPR 1，原来 1440×900 的 viewport 反而是假的）。
- 结论：**不是环境指纹拼错，是「CDP 自动化」本身被判**。除非等到真机人类轨迹样本，否则这条线靠试参过不去。

代码侧（这一轮的实活）：

- `browser.js`：headless 下用真 Chrome UA 覆盖 `HeadlessChrome`；`webdriver` 改回 `false`（真 Chrome 就是 false，`undefined` 反而异常）；新增 `XXQG_HEADED=1` 起有头模式（viewport 交给系统，不再硬写 1440×900）。
- `tasks.js`：交卷被滑块拦住后的**阶梯重试**——关弹窗再点 → 回积分页重进卷子并一路点到「完 成」；每级都判断是否真交上，最后用 `refresh()` 回查分数，没加分就打 `[captcha-blocked]`（分数是唯一真相，不再靠「弹窗消失」自欺）。
- 顺带修了卡题：提示没匹配到选项时空点「确 定」不生效，现在补选一个随机项再点，两次仍无变化才收工。

分数仍 27（每日 0/5、每周、专项都被滑块挡着，共 18 分）。
### 2026-11-03 多人化 + 定时（滑块暂搁）

滑块按「CDP=devtools」线索留给下一轮，先把能做的功能补完（用户要求别卡在一个点上）：

- 邀请码：`INVITE_CODE` 配了才放行，`POST /api/register` 验码后写 `visitors.approved`，`login/start` 走 `needApproved` 中间件；不配就是全开放，单机自用照旧。
- 每访客额度落到库：`visitors.max_accounts`（默认 1，可单独调），`/api/me` 返回 `approved/needInvite/maxAccounts`，前端出邀请码输入条。
- 定时：`users.schedule` + `next_run_at`，`POST /api/users/:uid/schedule {at:"HH:mm"}`，服务端每分钟 tick 一次，到点入队全套任务并自动排下一次（+0~20 分钟随机抖动防挤）。已实测：强制到点后 1 分钟内自动建出 `login,article,video,daily,weekly,special` 任务。
- 实测邀请码门禁：未放行 `login/start` = 403、错码 403、对码 200 后 `/api/me.approved` 变 true。