# 协议与选择器备忘（实测 2026-11）

> 这份文件里的每个接口/选择器都是真机跑出来的，改了页面结构要回来更新。

## 1. 扫码登录（纯 HTTP，不用浏览器）

| 步 | 请求 | 结果 |
| --- | --- | --- |
| 1 | `GET https://pc-api.xuexi.cn/open/api/sns/sign` | `{data:{sign}}`，作 OAuth state |
| 2 | `GET https://login.xuexi.cn/user/qrcode/generate` | `{result:"qr:UUID"}` |
| 3 | 渲染 `https://login.xuexi.cn/login/qrcommit?showmenu=false&code=<result>&appId=dingoankubyrfkttorhpou` | APP 扫的就是这个 |
| 4 | `POST https://login.xuexi.cn/login/login_with_qr`，form `qrCode / goto=https://oa.xuexi.cn / pdmToken` | `11021` 待扫，`11019` 过期，成功给 `loginTmpCode` |
| 5 | `GET https://pc-api.xuexi.cn/login/secure_check?code=<loginTmpCode>&state=<sign>` | Set-Cookie 下发登录态（含 `token`） |
| 6 | `GET https://pc-api.xuexi.cn/open/api/user/info` | `{uid, nick}` |

代码：`app/src/xxqg/client.js`、`app/src/loginflow.js`。

## 2. 积分

- `GET https://pc-proxy-api.xuexi.cn/delegate/score/get` 总分
- `GET https://pc-proxy-api.xuexi.cn/delegate/score/today/query` 今日
- `GET https://pc-proxy-api.xuexi.cn/delegate/score/days/listScoreProgress?sence=score&deviceType=2` 每项进度（`taskCode` / `currentScore` / `dayMaxScore`）

实测上限：`1` 阅读 12、`2` 视听 12、`1002` 文章时长 12、`1003` 视听时长 12、`9` 登录 1、`6` 每日答题 5、`5` 每周答题、`4` 专项答题。**以 `dayMaxScore` 为准。**

计分规律（实测）：

- 阅读/视听：每篇有效 1 分，同时按分钟累计时长分；停留 60s 以上才有效
- 答题：每组答对 1 题 1 分，**必须在交卷时才算**

## 3. 内容源

- 文章：`https://www.xuexi.cn/lgdata/35il6fpn0ohq.json` 等
- 视频：`https://www.xuexi.cn/lgdata/3j2u3cttsii9.json` 等
- 详情页：`https://www.xuexi.cn/lgpage/detail/index.html?id=<id>`（文章/视频同一个模板）

**视频页 `autoplay=false`**，`video.paused === true`，必须 `muted = true` 后 `play()`。没有 `video` 元素的条目是图文，别停 60 秒。

## 4. 答题页（`https://pc.xuexi.cn/points/exam-practice.html`）

| 元素 | 选择器 |
| --- | --- |
| 入口卡片 | `.my-points-card`（`hasText` 为「每日答题」/「每周答题」/「专项答题」） |
| 卡片按钮 | 卡片内 `text=去答题`（点标题没用） |
| 题型 | `.q-header`（单选 / 多选 / 填空 / 点选填空） |
| 题干 | `.q-body` |
| 选项 | `.q-answer.choosable` |
| 提示按钮 | `.tips` |
| 提示内容 | `.ant-popover .line-feed`，答案在 `<font color=red>` 里（多选会有多条） |
| 下一题 | `.action-row > button`，文案「确 定」，未作答时 disabled |
| 交卷 | 最后一题出现「交 卷」，可能弹 `.ant-modal` 二次确认 |

未完成：**点选填空**（选项不是 `input`，是词块，要靠点击顺序填）。当前代码会随机补选并可能答错。

### 交卷接口与滑块验证码（已逆向，2026-11-03）

交卷是纯 HTTP，但被阿里云滑块挡着：

| 项 | 值 |
| --- | --- |
| 每日答题 | `POST /api/exam/service/practice/quizSubmitV3` |
| 每周答题 | `POST /api/exam/service/practice/weekPracticeSubmitV3` |
| 专项答题 | `POST /api/exam/service/detail/submitV3` |
| 载荷 | `{uniqueId, questions:[{questionId, answers:[{answerId, value}], correct}], usedTime}` |
| 验证头 | `captchaVerifyParam`（阿里云 `success` 回调给的串） |

页面逻辑（`exam-practice.*.js`）：

```js
if (!Cookies.get('abnormal_exam')) { /* 直接 POST，不带验证头 */ }
else { const o = await aliyunCaptcha(); if (o.code === FAIL) return; /* 带 o 作 header POST */ }
```

- 服务端被风控后**只认**合法 `captchaVerifyParam`，不带就回 `{"code":403,"message":"slider verify failed"}`。
- 想抓载荷：把 `window.initAliyunCaptcha` 换成 `o => o.success('dummy')`，页面就会带着 dummy 头把真载荷发出去。
- `abnormal_exam` 是 cookie（js-cookie，`.xuexi.cn`），不是 sessionStorage；删了只会让客户端跳过滑块，服务端照样 403。

滑块链路（`SceneId: 4lku1m5p`，`mode: embed`，360×40）：

| 步 | 请求 |
| --- | --- |
| 1 | `InitCaptchaV3`（拿 `CertifyId`、`StaticPath`） |
| 2 | 拖动时 `Log3`（飞林指纹埋点，`Data` 加密，长度随轨迹点数增长 372→720 字节） |
| 3 | 松手 `VerifyCaptchaV3`，`CaptchaVerifyParam = {sceneId, certifyId, deviceToken, data}` |

返回 `{"Result":{"VerifyCode":"F001","VerifyResult":false}}`。阿里云错误码：`F001` 风控判定攻击、`F009` 检测到虚拟机、`F008` 重复提交、`T005/T006` 测试/白名单放行。

**已排除**：滑块没动（`style.left` 实测 0→320px、`SimulatedEvent` 全到齐）、轨迹没上报、页面无焦点、DPI 1 vs 2、去掉 `--enable-automation` + 抹 `webdriver`、原生 Chrome 走 CDP、`Asia/Singapore` 时区对齐出口 IP（134.195.100.26，SG）、等 `InitCaptchaV3` 回来再拖、各种拖动时长/步数/起止点。
**结论**：不是事件问题，是阿里云把本机（新加坡出口 IP）判成风险设备，`F001` 恒过不了；`abnormal_exam` 每次进答题页都被置 1。见 `docs/PROGRESS.md`。

## 5. 反检测要点

- 用真 Chrome（`channel: 'chrome'`），不要覆盖 UA（`sec-ch-ua` 会露馅）
- 抹 `navigator.webdriver`、补 `plugins` / `languages` / `chrome.runtime`、改 WebGL 厂商
- `locale=zh-CN`、`timezoneId=Asia/Shanghai`、`accept-language` 头
- 每个账号在 `data/profiles/<uid>.json` 存 `storageState`，看起来是同一台设备
- 停留秒数 ±8% 浮动，滚动带随机步长和 3% 回滚，每步移动鼠标
- 同账号串行（`activeJob` 检查），任务之间停 15~45 秒
