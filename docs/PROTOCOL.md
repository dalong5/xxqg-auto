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

## 5. 反检测要点

- 用真 Chrome（`channel: 'chrome'`），不要覆盖 UA（`sec-ch-ua` 会露馅）
- 抹 `navigator.webdriver`、补 `plugins` / `languages` / `chrome.runtime`、改 WebGL 厂商
- `locale=zh-CN`、`timezoneId=Asia/Shanghai`、`accept-language` 头
- 每个账号在 `data/profiles/<uid>.json` 存 `storageState`，看起来是同一台设备
- 停留秒数 ±8% 浮动，滚动带随机步长和 3% 回滚，每步移动鼠标
- 同账号串行（`activeJob` 检查），任务之间停 15~45 秒
