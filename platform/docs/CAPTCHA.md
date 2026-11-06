# 滑块验证码：自动解码（缺口求解）

> 目标：把「拖到轨道末端凭运气」换成「算出缺口真实位置再拖」。
> 实现在 `src/domain/captcha/`，产物被两条通道共用：CDP 通道（Playwright）与普通 Chrome 通道（SendInput）。

## 1. 原理

滑动验证的拼图块是**从背景图里原样抠出来的**。于是在正确偏移 `(dx, dy)` 处：

```
piece[y][x] ≈ background[dy+y][dx+x]
```

求解就退化成在 `[0, maxOffset] × [0, maxHeight]` 上最小化平均绝对差（MAD）：

```js
score(dx, dy) = mean(|bg[dy+y][dx+x] - piece[y][x]|)
best = argmin score
```

三个工程细节：

1. **只取不透明像素**：块图四周透明边不参与比较，先算 alpha 包围盒（`alphaBBox`），再向内缩 1px 丢掉抗锯齿。
2. **二维搜索**：不能只搜 x。块图常常是高 44px 的小图，y 也要定（真实缺口不会固定在某一高度）。
3. **采样**：最多取 256 个像素参与打分，全分辨率穷举 `300×100` 量级约 4M 次运算，几毫秒；最后再用全部像素在最优附近 ±2 复核一次。

## 2. 为什么不用 OpenCV / 不缺第三方图像库

- 像素运算只需要 `Uint8Array` + 一个 alpha 包围盒，**不需要** 边缘检测。
  拼图块与背景是同源同缩放，直接比 RGB 就足够可靠；边缘检测反而在低对比度背景上更脆。
- 接口只吃 RGBA，因此测试可以**纯合成图像**驱动，不需要真实验证码样本（见 `test/slider.test.mjs`）。

## 3. 两条集成通道

### 3.1 CDP 通道（Playwright）

`src/domain/captcha/aliyun.js`：

```
locateImages(page)   在 #JS_aliyun-captcha-dialog 里枚举 background-image / <img src>
        │            （按 class 关键词与面积区分「背景」和「拼图块」）
        ▼
toDataUrl(url)       Node 侧 fetch 图片字节 → data: URL
        │            跨域图片在页面里会 taint canvas，getImageData 会抛错，所以必须绕到 Node 下载
        ▼
page.evaluate(解码)   data: URL 画进 canvas → getImageData → base64 回传
        ▼
findGapOffset(...)   算出 (dx, dy)
        ▼
humanPath(distance)  ease-out 轨迹 + 微抖动 + 精确收尾，page.mouse 分段移动
```

调用点：`app/src/xxqg/browser.js` 的 `clearCaptcha()`，在最前面尝试 `solveAndDrag()`；
成功即返回，失败才落回旧的「拖到轨道末端」兜底。

### 3.2 普通 Chrome 通道（SendInput）

`app/src/xxqg/plain.js` 的 `solveSlider()`：

```
probe(LOCATE_CAPTCHA_JS)  地址栏注入 JS，只回传「两张图的 URL + 显示宽度」到 document.title
        ▼                  （不在页面里解码，避免跨域 taint；只传元数据，字符串很短）
Node fetch + pngjs 解码    PNG/JPEG 都在 Node 侧处理
        ▼
findGapOffset → toCssDistance(offset, 图像宽, 显示宽)
        ▼
native.ps1 drag           真实鼠标从手柄拖到 (手柄x + distance)
```

## 4. 校准点

| 参数 | 位置 | 说明 |
| --- | --- | --- |
| `MAX_SAMPLES` | `solver.js` 内 `stride` | 采样上限，默认 256；低配机器可降到 128 |
| `alphaThreshold` | `findGapOffset` opts | 默认 128；块图半透明边缘多时调到 200 |
| `toCssDistance` | `solver.js` | 图像宽度 ≠ 显示宽度时按比例换算，避免 Retina/缩放偏差 |
| `humanPath.overshoot` | 默认 1.004 | 过冲比例；判错说明过冲过大，可降到 1.0 |
| 拖动步数 | `aliyun.js` 26~34 / `ps1 drag` 34 | 步数越少越快，但轨迹越「机械」 |

## 5. 验证

```bash
cd platform
node --test "test/slider.test.mjs"        # 6 个：合成图求偏移、边界、非法输入、轨迹
node --test "test/captcha-e2e.test.mjs"    # 3 个：真实浏览器 + 模拟阿里云 DOM 全链路
```

端到端用例会在本地起一个 HTML：用 canvas 造背景、按已知 `GAP_X=118` 抠出拼图块、
渲染成与阿里云同构的 DOM，然后跑 `solveAndDrag()`，断言：

- 解出的 `offset` 与真实缺口误差 ≤ 2px；
- 页面记录的鼠标位移与真实缺口误差 ≤ 3px；
- 没有验证码元素时安全失败（不抛异常）。

实测输出：

```
✔ 能定位到背景图与拼图块
✔ 端到端：解出缺口并拖动到正确距离
✔ 没有验证码元素时安全失败，不抛异常
ℹ tests 30  ℹ pass 30  ℹ fail 0
```

## 6. 已知边界

| 情况 | 表现 | 处理 |
| --- | --- | --- |
| 图片是 WebP/AVIF（非 PNG） | `pngjs` 解码失败 | CDP 通道走浏览器 canvas 解码，不挑格式；普通通道目前只认 PNG，失败即回落兜底 |
| 背景是纯色/低对比 | 多个偏移分数接近 | 取最优 + ±2 全像素复核；仍不确定时分数偏高，可加阈值拒绝（`score > 25` 建议放弃） |
| 拼图块带位移阴影 | 最优偏移偏 1~2px | 已用「向内缩 1px」缓解；必要时对 piece 做一次 1px 腐蚀 |
| 缺口在极右端 | 越界被裁 | `maxDx = bgW - bbox.w - bbox.x`，按可见宽度算，已覆盖右边界 |
| 风控判定本身拒绝 | 拖对了仍不通过 | 这是风险分问题，不是解码问题；见 `docs/INCIDENT.md`，不要靠反复重试硬刷 |

## 7. 与风控的关系（务必知道）

解码只解决「拖到哪儿」，不解决「这次请求是否被判定为自动化」。历史实测：
同一账号连续失败十几次后，即使换成原生浏览器 + 真实鼠标也会被抽样拦一次。
所以**解码成功率高 ≠ 一定通过**；失败时应退避（当天不再重试），而不是刷次数——刷次数只会抬高账号风险分。
