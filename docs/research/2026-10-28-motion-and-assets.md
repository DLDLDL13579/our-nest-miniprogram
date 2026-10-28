# 小程序动效方案与可商用素材调研

> 目标读者：本项目的实现者（人 / agent）。
> 定位：回答「怎么让酒桌小程序的动效达到商业游戏水准」，并给出**可直接抄的代码和素材清单**。
>
> ⚠️ **快照声明**：所有 npm 元数据、包体积、Lottie 样本体积均为 **2026-10-28 16:14~16:25 实测**，
> 采集命令写在对应小节里，可复现。官方文档引用的版本号取自当次抓取的页面原文。
>
> **证据分级**（全文统一）：
> - **【文档】** = 微信官方文档原文 / npm registry 返回值，可直接查证
> - **【源码】** = 从 `lottie-miniprogram@1.0.12` 的实际 npm 包里读出来的代码
> - **【实测】** = 本次动手跑出来的数字
> - **【社区】** = 第三方博客 / issue，非官方，作佐证
> - **【未确认】** = 没查到可靠来源，**不编**

---

## 0. 一页速查

| 问题 | 答案 | 依据 |
|---|---|---|
| `lottie-miniprogram` 最新版 | **1.0.12**，发布于 **2021-08-09**，之后代码零更新 | 【文档】npm registry |
| 维护状态 | 代码冻结 5 年，但 **issue 仍有人回**（2026-05 有 collaborator 回复） | 【社区】issue #46 |
| 内嵌 lottie-web 版本 | **5.5.7**（2019 年），官方最新 5.13.0，落后 8 个 minor | 【源码】package.json |
| 包体积代价 | **约 205 KB**（`miniprogram_dist/index.js` 209,506 B，未压缩） | 【实测】 |
| 是否支持 Skyline | canvas 组件「完全支持」，但**开发者工具不能调试，只能真机** | 【文档】 |
| 同屏多个 Lottie | **不要赌**：`setup()` 是全局单例 + rAF 全局改写 | 【源码】 |
| 一个 5 秒纯矢量动效多大 | **11–25 KB**（3 个真实样本实测） | 【实测】 |
| 2MB 上限下值不值得上 | **不值得整包上；值得"单个关键动效"上**，见 §4 | 综合 |

---

## 1. Lottie 在小程序里的真实可行性

### 1.1 包的客观状态（全部可复现）

采集命令：

```bash
curl -s https://registry.npmjs.org/lottie-miniprogram | python3 -m json.tool | head -40
npm pack lottie-miniprogram   # 或 curl -O https://registry.npmjs.org/lottie-miniprogram/-/lottie-miniprogram-1.0.12.tgz
```

**【文档】npm registry 返回值（2026-10-28）**

| 字段 | 值 |
|---|---|
| `name` | `lottie-miniprogram` |
| `dist-tags.latest` | **1.0.12** |
| `time.created` | 2019-08-18 |
| `time['1.0.12']` | **2021-08-09T06:38:33Z** |
| `time.modified` | 2022-05-08（只是 registry 元数据变动，不是发版） |
| 版本总数 | 13 |
| `license` | MIT |
| `unpackedSize` | **227,256 B ≈ 222 KB** |
| 周下载 / 月下载 | **511 / 1,819**（npm downloads API，2026-10-20~26） |

**【实测】解包后的实际构成**

```
package/
├── miniprogram_dist/index.js        209,506 B   ← 真正进小程序的体积
├── miniprogram_dist/index.d.ts        1,628 B
├── src/adapter/index.js                          ← 小程序适配层（74 行）
└── src/index.js                                  ← 对 lottie-web 的薄包装
```

> **205 KB 是什么概念**：本项目当前 `miniprogram/` 下全部文件合计 **1,106 KB ≈ 1.1 MB**
> （实测：`find miniprogram -type f | stat` 求和；`du -sh` 报 1.3M 是文件系统块开销，口径不同），主包上限 2 MB。
> 这一个库就吃掉剩余空间的 **约 29%**，且是**纯代码、零视觉产出**。

**【源码】/ 【文档】它内嵌的是哪一版 lottie-web**

```json
// package.json devDependencies
"lottie-web": "5.5.7"     // 2019 年版本，webpack 打进 miniprogram_dist/index.js
```

| | 版本 | 发布 |
|---|---|---|
| `lottie-miniprogram` 内嵌 | lottie-web **5.5.7** | 2019 |
| lottie-web 当前最新 | **5.13.0** | 2025-05-21 |

说明：截至 2026-10，`lottie-miniprogram` 用的渲染核心落后 **6 年 / 8 个 minor**。
5.6+ 之后 lottie-web 修过一批 canvas renderer 的渐变、遮罩、性能问题，**这些修复它一个都没有**。
（想升级只能自己 fork + 改 devDependency 重新 webpack —— README 里就这么建议的：
"若原项目有新版本，可直接改变依赖的版本号"，但**没人做过就没人验证过**。）

### 1.2 维护状态：代码冻结 ≠ 项目死亡

**【社区】** GitHub issue 仍然是活的。issue #46（"不能正常渲染 lottie 动画中的渐变效果"）
在 **2026-05-05** 有 collaborator `seasonhuang` 回复并关闭，测试环境写着：

> `lottie-miniprogram@1.0.12`，Canvas 2D（`type="2d"`），基础库 **3.15.2**，
> 通过 `miniprogram-ci` 上传开发版后**真机验证**

结论：**有人在管，但只回 issue 不改代码**。
这带来一个具体风险 —— 遇到 bug 时你得到的是"这不是我们的问题"式答复（见 1.5 的渐变结论），
而不是一个 patch。**任何集成风险最终都要你自己吞。**

### 1.3 【源码】从包里读出来的已知坑（不是传闻）

以下全部来自 `node_modules/lottie-miniprogram/src/`，是**可核对的代码事实**：

#### 坑 1：`setup()` 是全局单例，多 canvas 会互相污染

```js
// src/adapter/index.js
export const setup = (canvas) => {
  const {window, document} = g
  g._requestAnimationFrame = window.requestAnimationFrame   // 只备份一份
  ...
  // lottie 对象是单例，内部状态（_stopped）在多页面下会混乱，保持 rAF 持续运行可规避
  window.requestAnimationFrame = function requestAnimationFrame(cb) { ... }
  window.cancelAnimationFrame = canvas.cancelAnimationFrame.bind(canvas)

  document.body = {}
  document.createElement = createElement.bind(canvas)   // ← 绑到这一个 canvas 上
  ...
}
```

- `g`（全局适配对象）只有**一份**，`_requestAnimationFrame` / `_body` / `_createElement` 各只备份一次。
- 第二次 `setup(canvasB)` 会**覆盖**第一次备份的"上一环境"。
- 所以 **A → B → A 这种来回切换会丢掉最原始的环境**，`restore()` 恢复的是错的。
- 官方注释自己承认："**lottie 对象是单例，内部状态（_stopped）在多页面下会混乱**"。

#### 坑 2：`destroy()` 不是普通销毁，里面藏了 `restore()`

```js
// src/index.js
const originalDestroy = _aniItem.destroy.bind(_aniItem)
_aniItem.destroy = function () {
  // 恢复到上一次 canvas 的环境，避免当前 canvas 被销毁后导致 lottie-web 内部死锁
  restore()
  if (_aniItem.renderer && !_aniItem.renderer.destroyed) {
    _aniItem.renderer.renderConfig.clearCanvas = false
  }
  originalDestroy()
}
```

含义：**一个实例 `destroy()` 会把全局环境回滚**，同页面另一个还在跑的实例会受影响。
"内部死锁"这个说法说明这不是理论风险，是踩过的坑。

#### 坑 3：`rAF` 是 `canvas.requestAnimationFrame` 与 `setTimeout(…,100)` **竞速**

```js
window.requestAnimationFrame = function requestAnimationFrame(cb) {
  let called = false
  setTimeout(() => {                                    // ← 100ms 兜底
    if (called) return
    called = true
    typeof cb === 'function' && cb(Date.now())
  }, 100)
  canvas.requestAnimationFrame((timeStamp) => {         // ← 正常路径
    if (called) return
    called = true
    typeof cb === 'function' && cb(timeStamp)
  })
}
```

**【社区】** 这个竞速就是 iOS "动画提前结束"的来源：
当逻辑层被阻塞、`setTimeout` 回调反而先到，动画时钟就被推进到 100ms 之后的位置，
看起来像"跳帧 / 提前播完"。作者给的修法是把 `setTimeout` 兜底删掉，用 `patch-package` 打补丁。

> 也就是说：**要稳定就得改 node_modules**。这是"未维护"的真实代价。

#### 坑 4：`path` 只接受 http(s)，本地 JSON 必须走 `animationData`

```js
if (typeof options.path === 'string' && !/^https?\:\/\//.test(options.path)) {
  throw new Error(`The 'path' is only support http protocol.`)
}
```

所以「把 JSON 放进包内用相对路径」**不行**，只有两条路：

1. `animationData: require('../../assets/xxx.json')` —— 打进包，占 2MB 额度
2. 放 CDN，用 `path: 'https://...'` —— 不占包体积，但要配 `downloadFile` 合法域名、且首帧有网络延迟

**没有第三条路。**

#### 坑 5：`wrapper` / `container` 参数会直接抛错，`context` 必填

```js
['wrapper', 'container'].forEach(key => {
  if (key in options) throw new Error(`Not support '${key}' parameter ...`)
})
if (!options.rendererSettings || !options.rendererSettings.context) {
  throw new Error(`Parameter 'rendererSettings.context' should be a CanvasRenderingContext2D.`)
}
options.renderer = 'canvas'    // 强制 canvas，不能选 svg
```

抄网上的 lottie-web 网页教程（`container: document.getElementById(...)`）**100% 报错**。

#### 坑 6：不支持 expression

README 原文：「由于小程序本身不支持动态执行脚本，因此 lottie 的 expression 功能也是不支持的。」
AE 里用表达式驱动的动画（数字滚动、随机、跟随）导出后在**小程序端是死的**（可能静止在某帧）。
导出前必须让设计师关掉 expression，或改用关键帧烘焙。

#### 坑 7：动效里的「效果」类滤镜会静默丢失

**【社区】** issue #46 的官方结论：

> "AE Gaussian Blur / SVG filter 类 effect 只在 **SVG renderer** 下支持，**Canvas renderer 不支持**；
> 而小程序环境只能使用 Canvas renderer。这应该不是 `lottie-miniprogram` 的普通渐变渲染 bug。
> 如果要在小程序里达到类似效果，可能需要从**素材侧规避**。"

也就是说：**发光、模糊、投影、玻璃拟态这类"高级感"效果，Lottie 路线在小程序里天然做不出来**。
这直接打在"摆脱粗糙感"的目标上 —— 它带来的恰恰是最容易出效果的那一类视觉，而这类视觉在 Lottie 路线上反而是黑的。

#### 坑 8：位图逻辑受限（只在含图片的动效上暴露）

```js
function notSupport() {
  console.error('小程序由于不支持动态创建 canvas 的能力，故 lottie 中有关图片处理的操作无法支持，' +
    '请保持图片的原始宽高与 JSON 描述的一致，避免需要对图片处理')
}
function createImg(canvas) {
  if (typeof canvas.createImage === 'undefined') {
    return {}     // ← 静默返回空对象，后续必然出错且难查
  }
  ...
}
```

动效里一旦嵌了图片（"assets" 里有 `p` 字段），**必须保证图片在 JSON 里的宽高与素材实际宽高完全一致**，
否则缩放/裁剪会失败。而且每个嵌图都按原尺寸计入包体积。

#### 坑 9：模块加载时就同步调 `wx.getSystemInfoSync()`

```js
const systemInfo = wx.getSystemInfoSync()   // 模块顶层，import 即执行
```

`getSystemInfoSync` 已被官方标记为**不推荐**（推荐 `wx.getWindowInfo` / `wx.getDeviceInfo` / `wx.getAppBaseInfo`），
新版基础库会打警告。不影响功能，但会污染日志。

#### 坑 10：显隐不能用 `display:none`

**【社区】** 在 canvas 标签上直接绑 `style="display:{{show?'block':'none'}}"` 偶现渲染层报错。
可靠做法是外层 `<view wx:if>` 包裹 canvas —— **节点直接销毁**，而不是 CSS 隐藏。

（这与本项目已知的一条教训同源：`overflow:hidden` 切边、`opacity` 淡出 vs 节点移除，
**小程序的原生组件对"CSS 藏起来"这件事一直不可靠**。）

### 1.4 Skyline vs WebView：能跑，但调试路径断了

**【文档】canvas 组件页**（`developers.weixin.qq.com/miniprogram/dev/component/canvas.html`）：

> 渲染框架支持情况：**Skyline（使用最新 Nightly 工具调试）、WebView**

**【文档】Skyline 基础组件支持表**（`.../skyline/component.html`）：

| 组件 | 支持情况 | 备注 |
|---|---|---|
| **canvas** | **完全支持** | **开发者工具暂未支持调试，请使用真机预览** |

**【文档】Skyline 迁移常见兼容问题**（`.../skyline/migration/compatibility.html`）：

> **切换 Skyline 后，为什么 map / canvas / video / camera 在微信开发者工具渲染失败？**
> 在 Skyline 模式下，微信开发者工具暂未支持调试原生组件，建议开发者使用真机预览完成调试。

**结论与代价：**

- 能力上：Skyline 下 canvas 是「完全支持」，Lottie 应能跑。
- 工程上：**开发者工具看不到画面**。改一行动画参数 → 上传 → 真机扫码 → 看 → 再改。
  这个反馈回路对"调动画"这件事是致命的 —— 动画本质就是反复看。
- 本项目当前是 **WebView**（`app.json` 无 `renderer` 字段，默认 webview）。
  **切 Skyline 不会让 Lottie 更好用，只会让调试更难。**

> ⚠️ 同一句备注也解释了为什么 `lottie-miniprogram` 至今"没人验证 Skyline"：
> 验证一张 canvas 动效图的成本 = 每次真机上传。没人会为别人的库付这个成本。

### 1.5 canvas 2d 与旧版 canvas：新接口是唯一选择

**【文档】canvas 组件页**：

> 2.9.0 起支持一套新 Canvas 2D 接口（需指定 `type` 属性），同时支持同层渲染，**原有接口不再维护**。

| | 旧版（`canvas-id` + `wx.createCanvasContext`） | 新版（`type="2d"` + `canvas.getContext('2d')`） |
|---|---|---|
| 状态 | **不再维护** | 官方推荐 |
| Lottie 能否用 | **不能** —— lottie-miniprogram 要 `canvas.requestAnimationFrame` / `canvas.createImage`，这些只在 canvas 2d 对象上 | 能 |
| 同层渲染 | 不支持 | 2.9.0 起支持 |
| 版本门槛 | — | **基础库 2.9.0**（依据：【文档】canvas 组件页「2.9.0 起支持一套新 Canvas 2D 接口」。`lottie` 的 README 写的是 2.8.0 —— 那是 canvas 2d 还是内部预览版时期的口径，**按 2.9.0 取严**） |

**【文档】** 三个必须知道的 canvas 2d 硬约束（同一页面 "Bug & Tip" 节）：

1. **「Canvas 2D（新接口）需要显式设置画布宽高，默认：`300*150`，最大：`1365*1365`」**
2. **「避免设置过大的宽高，在安卓下会有 crash 的问题」**
3. 「iOS 暂不支持 pointer-events」（canvas 上盖透明层做点击拦截在 iOS 会失效）

> **`1365×1365` 是本项目最容易踩的一条。**
> 常规写法 `canvas.width = rect.width * dpr` 在 dpr=3 的设备上：
> 375pt 宽 → 1125 ✓ ｜ 430pt 宽 → 1290 ✓ ｜ **500pt 见方 → 1500 ✗ 超限**。
> 也就是说：**全屏正方形的大动效（转盘、开盅、撒花）在 dpr=3 上必触顶**。
> 必须写 `Math.min(rect.width * dpr, 1365)`，代价是被迫牺牲清晰度。
> 这一条足以否掉"用 Lottie 做全屏转盘"的方案。

### 1.6 内存泄漏：三处必漏点

**【文档】内存优化页**（`.../performance/tips/runtime_memory.html`）：
页面 unload 后基础库会清理页面实例，但「如果开发者代码中持有的页面实例（`this`）未释放，
则会导致页面未被正常回收，引起内存泄露」。

**【文档】`wx.createInnerAudioContext` 注意事项**（同类问题的官方原文）：
「InnerAudioContext 音频资源**不会自动释放**……请及时调用 `destroy()` 释放资源，避免内存泄漏。」

**Lottie 在小程序里的三个漏点：**

| 漏点 | 为什么漏 | 修法 |
|---|---|---|
| ① 没调 `ani.destroy()` | 实例挂在 lottie 全局单例上，JS GC 收不到 | `onUnload` / `wx:if` 收起时**必须** `destroy()` |
| ② canvas 节点已销毁但实例还活着 | `wx:if` 移除节点 → canvas 已死 → `destroy()` 里 `restore()` 会操作已死的 canvas | **先 `destroy()` 再让节点消失**（顺序反了就报错/卡死） |
| ③ 计时器 / rAF 未取消 | 库的 `setTimeout(…,100)` 兜底不在 `cancelAnimationFrame` 管辖内 | `destroy()` 是唯一能停的入口，没有别的 |

> 本项目已有一条同源教训（AGENTS.md「定时器泄漏」节）：
> **所有定时器都要进清单，存活判据必须是 `onUnload` 里翻转的显式标志**。
> Lottie 的实例必须按同一标准管理，不能"用完就算了"。

### 1.7 性能边界：同屏多个 Lottie 到底行不行

#### 先说结论

**同屏 > 1 个 Lottie 实例，本项目不要做。** 理由按证据强度排序：

**【源码】三条硬证据**

1. `setup(canvas)` 是**全局单例**，`_requestAnimationFrame` / `createElement` 每类只备份一份。
   N 个 canvas = 反复覆盖 = 环境错乱（见 §1.3 坑 1）。
2. `destroy()` 内部调 `restore()`，**销毁任何一个实例都会回滚全局环境**（见 §1.3 坑 2）。
3. rAF 是「canvas.rAF 与 setTimeout(100) 竞速」。N 个实例 = N 套竞速，
   任何一个实例的 100ms 兜底触发，都会让该实例时钟跳帧；逻辑层越忙，跳得越多。

**【文档】一条结构约束**

每个 Lottie 实例必须独占一个 `<canvas type="2d">` 节点（小程序不能动态创建 canvas，
源码里 `createElement('canvas')` 会 `console.warn('小程序不支持动态创建组件')`）。
canvas 是**原生组件 + 同层渲染**，N 个 canvas = N 层原生视图参与合成。

**【社区】一条同向判断**

Galacean 引擎团队在 Lottie 3D 运行时实现博客里写：
「（lottie-web 局限）**Canvas 2D 模式下，多个 Lottie 很难在同一个画布上组合使用**」。
—— 这是连"同一张 canvas 组合"都难，更别说多张 canvas 各自渲染。

#### 【未确认】具体掉帧数字

**没有找到任何公开的小程序 Lottie 多实例 FPS 基准测试。** 网上所有"多实例会卡"的说法
都是定性描述，没有可复现的数字。**本报告不给 N 个实例的 FPS 数字，因为没测过就是没测过。**

如果一定要测，唯一的可信方法是：真机 + 开发者工具「FPS 面板」（**【文档】**
`.../performance/fps_panel.html` 有官方面板说明），逐个增加到掉帧为止。

#### 可行的替代结构

| 需求 | 做法 |
|---|---|
| 同屏多个"发光小球" | **1 个 canvas** 里用 Lottie 播一个"全部小球"的动效（把多个效果合到一个 JSON） |
| 多个独立小动效（按钮反馈、星星） | 不用 Lottie，用 **APNG/WebP 序列帧** 或 **CSS 动画 + 内联 SVG** |
| 需要一个"重头戏"动效（开盅 / 撒花） | 允许 **1 个** Lottie 实例，全屏独占，播完即销毁 |

### 1.8 动效文件从哪来：LottieFiles 的真实许可

#### 两种许可，别混为一谈

**【文档】Lottie Simple License**（`https://lottiefiles.com/page/license`，原文摘要）：

授权范围原文（英文原句，来自页面）：

> "Permission is hereby granted, free of charge, to any person obtaining a copy of the **public animation
> files available for download at the LottieFiles site** ("Files") to download, reproduce, modify, publish,
> distribute, publicly display, and publicly digitally perform such Files, **including for commercial purposes**,
> provided that any display, publication, performance, or distribution of Files must contain (and be subject to)
> the same terms and conditions of this license. **Modifications to Files are deemed derivative works and must
> also be expressly distributed under the same terms and conditions of this license.**"
>
> "**Use of Files without attributing the creator(s) of the Files is permitted** under this license,
> though attribution is strongly encouraged."
>
> "This license does not include the right to collect or compile Files from LottieFiles to replicate or
> develop a similar or competing service."

**翻译成人话 —— 能做什么、要注意什么：**

| 问题 | 答案 |
|---|---|
| 能商用吗 | **能**（"including for commercial purposes"） |
| 必须署名吗 | **不必**（"without attributing … is permitted"），但强烈建议 |
| 能改吗（改色/删层/换文案） | **能**（"modify"） |
| 改完有什么义务 | ⚠️ **衍生作品必须以同样条款分发**（"derivative works … must also be expressly distributed under the same terms"） |
| 许可有传染性吗 | ⚠️ **有，但只作用于"文件本身"**：你把改过的 JSON 当独立文件分发时受它约束；**它不约束你的整个小程序代码**（许可只覆盖 Files，不覆盖你的程序） |
| 不能做什么 | 不能把 LottieFiles 的动画聚合成库、去做一个竞品服务 |

> **改色的法务姿势**：技术上改色 = 修改 JSON 里的 `"c": {"k": [r,g,b,a]}` 数组（0~1 浮点）。
> 许可上改色 = "modification" → 你的改动版 JSON 属于 derivative work，
> 应以 Lottie Simple License 分发。**实操**：在小程序「关于/致谢」页放一行
> "本小程序含来自 LottieFiles 的动画素材（Lottie Simple License）"，
> 既满足署名鼓励，也满足"same terms"的可视化要求。**成本几乎为零，别省。**
>
> 注意：以上是**对许可条款的直译，不是法律意见**。上线前若法务有要求，把
> `https://lottiefiles.com/page/license` 原文存档一份。

#### 另一件事：LottieFiles **服务**的商用限制（容易误伤）

**【文档】LottieFiles Commercial Use Policies**（`https://help.lottiefiles.com/commercial-use-guide`）：

| 计划 | 商业使用 |
|---|---|
| Free Plan | ❌ 禁止 |
| Individual Plan | ❌ 禁止 |
| Team Plan | ✅ 允许 |
| Enterprise Plan | ✅ 允许 |

该页同时写明："**Using public animations is excluded and falls under the Lottie Simple License**"。

**这两条的区别是本报告最容易被误读的地方：**

- **下载公开动画 → 用 Simple License → 可以商用。**（你要做的就是这个）
- **用 LottieFiles 的在线编辑器 / 工具去"创作/定制"商业作品 → 需要 Team/Enterprise。**
  （免费账号点进编辑器改一改再导出，严格说落在这条里）

> 实操建议：**只用「下载」不用「编辑器」**。改色在本地改 JSON（一个 20 行的脚本即可），
> 或在 AE + Bodymovin 里自己出。这样整条链路只受 Simple License 约束，无需付费订阅。

#### 其他可商用 Lottie 源

| 源 | 许可 | 说明 | 【未确认】 |
|---|---|---|---|
| LottieFiles 公共库 | Simple License | 最大库，可商用 | — |
| IconScout / Lottie 专区 | 免费区多为 CC-BY 或需署名 | **逐文件看** | 未逐个核验 |
| 自建（AE + Bodymovin） | 完全自有 | **最干净**，也最容易做到风格统一 | 需设计师 / AE 能力 |

### 1.9 最小集成代码（基于官方 README + canvas 官方文档，逐行有依据）

> 依据：`lottie-miniprogram` README（npm 包内）+ canvas 组件官方文档（`type="2d"` /
> `createSelectorQuery().fields({node:true,size:true})` / `canvas.requestAnimationFrame`）+
> `wx.loadFontFace` 的 `scopes: ['native']`（Canvas 2D 下用自定义字体）。
>
> **以下代码按此三份文档的接口签名写，未在真机跑过（本会话不开开发者工具，见纪律）。
> 每一行都能对到文档，但"能不能一次跑通"标注为【未确认】。**

#### ① `project.config.json` —— 唯一需要动的配置（不是 app.json）

```json
{
  "setting": {
    "packNpmManually": true,
    "packNpmRelationList": [
      {
        "packageJsonPath": "./package.json",
        "miniprogramNpmDistDir": "./miniprogram/"
      }
    ]
  }
}
```

> **重要纠正**：`app.json` **不需要**任何 lottie 相关配置 —— lottie 不是插件、不是组件。
> 网上很多文章让你往 `app.json` 塞东西是错的。
> 真正需要的是：项目根目录有 `package.json` 依赖，然后在开发者工具点「工具 → 构建 npm」，
> 产物落到 `miniprogram/miniprogram_npm/`。
> `packNpmManually` 只是把这个目录固定下来，便于版本管理。

`app.json` **保持不变**（本项目当前配置即可）：

```json
{
  "pages": ["pages/lobby/lobby", "pages/room/room", "pages/me/me"],
  "lazyCodeLoading": "requiredComponents"
}
```

> 如果**将来**要切 Skyline（本报告不建议，见 §1.4），才会加：
> `"renderer": "skyline"` + `"rendererOptions": { "skyline": { ... } }`。

#### ② `pages/demo/demo.wxml`

```xml
<!-- canvas 必须是 type="2d"；显隐用外层 view + wx:if，不要用 display:none（见坑 10） -->
<view class="lottie-wrap">
  <view wx:if="{{showFx}}">
    <canvas
      id="fx"
      type="2d"
      class="lottie-canvas"
      style="width:{{boxW}}px;height:{{boxH}}px;"
    ></canvas>
  </view>
</view>
```

```css
/* wxss：<image>/<canvas> 不给宽高会撑满容器（本项目已踩过），这里显式给 */
.lottie-wrap { display: flex; align-items: center; justify-content: center; }
.lottie-canvas { display: block; }
```

#### ③ `pages/demo/demo.js` —— 完整生命周期

```js
import lottie from 'lottie-miniprogram'

// 官方文档：Canvas 2D 最大 1365*1365，超过安卓有 crash 风险
const MAX_CANVAS_EDGE = 1365

Page({
  data: { showFx: false, boxW: 300, boxH: 300 },

  onUnload() {
    // 铁律：节点消失前必须先 destroy（见 §1.6 漏点 ②）
    this._destroyFx()
  },

  onHide() {
    // 页面被盖住时停播，省电也省内存；不销毁，回来还能续播
    if (this._ani) this._ani.pause()
  },

  onShow() {
    if (this._ani && this.data.showFx) this._ani.play()
  },

  // ---------- 播放一个动效 ----------
  async playFx() {
    // 同一时刻只允许一个实例（见 §1.7）
    this._destroyFx()
    this.setData({ showFx: true })

    // 等 wx:if 的节点真正渲染出来，否则 selectorQuery 选不到
    await new Promise(r => this.setData({}, r))

    const query = this.createSelectorQuery()
    query.select('#fx')
      .fields({ node: true, size: true })       // ← 必须 node:true，否则拿不到 canvas 对象
      .exec((res) => {
        if (!res || !res[0] || !res[0].node) {
          console.warn('[fx] canvas 节点没拿到，跳过动画')
          this.setData({ showFx: false })
          return
        }

        const canvas = res[0].node
        const rect   = res[0]
        const info   = wx.getWindowInfo()          // 官方 canvas 文档示例用的就是它
        const dpr    = Math.min(info.pixelRatio || 2, 3)

        // 关键：宿主的绘制缓冲不能超过 1365，否则安卓 crash（官方 tip）
        const scale = Math.min(dpr, MAX_CANVAS_EDGE / Math.max(rect.width, rect.height))

        canvas.width  = Math.floor(rect.width  * scale)
        canvas.height = Math.floor(rect.height * scale)

        const ctx = canvas.getContext('2d')
        ctx.scale(scale, scale)
        // ⚠️ 【未确认】lottie-web 的 canvas renderer 每帧可能重置 ctx 变换，
        //    外部这次 ctx.scale 未必留到渲染时。真机上若发现"越大越糊"或"画歪"，
        //    说明被重置了 —— 那时的正解是别用 ctx.scale，改在 rendererSettings 里
        //    用 preserveAspectRatio + 让 JSON 幅面本身匹配 canvas 物理尺寸。
        //    本报告不敢断言哪种一定对，因为没跑过。

        // 全局单例：任何 loadAnimation 之前必须 setup 一次
        lottie.setup(canvas)

        // 注意：path 只支持 http(s)；包内 JSON 必须用 animationData
        // ⚠️ 【未确认】小程序原生是否支持 require('*.json')：官方《模块化》文档只写了 js 文件，
        //    没提 JSON。社区普遍这么用且能跑，但**文档里没有依据**。
        //    稳妥替代（二选一）：
        //      a) 用构建产物：把 JSON 包成 .js —— module.exports = {...}，再 require 那个 js
        //      b) 运行时读文件：wx.getFileSystemManager().readFileSync('/assets/fx/x.json', 'utf8')
        //         再 JSON.parse —— 这条路 100% 有官方依据
        const ani = lottie.loadAnimation({
          loop: false,
          autoplay: true,
          animationData: require('../../assets/fx/dice_reveal.json'),
          rendererSettings: { context: ctx },       // ← 必填，缺了直接抛错
        })

        ani.addEventListener('complete', () => {
          // 播完自动收起：先 destroy 再让节点消失
          this._destroyFx()
          this.setData({ showFx: false })
        })

        this._ani = ani
      })
  },

  // ---------- 唯一的销毁出口 ----------
  _destroyFx() {
    if (!this._ani) return
    try {
      this._ani.destroy()      // 内部已含 restore()
    } catch (e) {
      console.warn('[fx] destroy 异常', e)
    }
    this._ani = null
  },
})
```

#### ④ 一个 20 行的「改色」脚本（把 Lottie 主色换成酒桌主题色）

Lottie JSON 里的颜色是 `[r, g, b, a]` 的 **0~1 浮点**数组，出现在 `"c": {"a": 0, "k": [...]}`
（填充/描边）和 `"sc"`（渐变 stop）里。改色不需要 AE：

```python
# scripts/tint-lottie.py
# 用法: python3 tint-lottie.py in.json out.json FF7A45
import json, sys

src, dst, hex_rgb = sys.argv[1], sys.argv[2], sys.argv[3]
target = [int(hex_rgb[i:i+2], 16) / 255 for i in (0, 2, 4)]

def walk(node):
    """递归替换所有静态颜色值；保留 a（是否动画）与关键帧数组不动。"""
    if isinstance(node, dict):
        for k, v in node.items():
            if k in ("c", "sc") and isinstance(v, dict) and v.get("a") == 0:
                arr = v.get("k")
                if isinstance(arr, list) and len(arr) == 4:
                    v["k"] = target + [arr[3]]
                elif isinstance(arr, list) and len(arr) == 3:
                    v["k"] = target
            else:
                walk(v)
    elif isinstance(node, list):
        for item in node:
            walk(item)

data = json.load(open(src, encoding="utf-8"))
walk(data)
json.dump(data, open(dst, "w", encoding="utf-8"), separators=(",", ":"))  # 去空格，省 15~25%
print("done:", dst)
```

> 注意：`"a": 1` 的是**带动画的关键帧颜色**，本脚本故意不动它（动了容易错帧）。
> 要改动画颜色，就得解 `"k": [{ "t": 0, "s": [...] }, ...]` 的结构，风险高、收益低 —— 不建议。

---

## 2. 小程序自带的动效 / 交互能力清单

### 2.1 三条动画路径的能力边界（三条互斥，选错就白干）

**【文档】动画页**（`.../framework/view/animation.html`）+ **【文档】** 各 API 页。

| 路线 | API | 最低版本 | 渲染引擎限制 | 适用 |
|---|---|---|---|---|
| **CSS** | `transition` / `@keyframes` | 1.0.0 | 都支持（Skyline 自 8.0.37/8.0.39） | 绝大多数场景 |
| **关键帧动画** | `this.animate(selector, keyframes, duration, cb)` | 2.9.0 | ⚠️ **仅 WebView** | 需要 JS 逐帧控制的多段动画 |
| **滚动驱动动画** | `this.animate(..., ScrollTimeline)` | 2.9.0 | ⚠️ **仅 WebView** | 滚动视差 |
| **Skyline worklet** | `applyAnimatedStyle` / `shared` / `timing` | 2.29.0 | ⚠️ **仅 Skyline** | 手势跟手动画 |
| **旧 API** | `wx.createAnimation` | 1.0.0 | 都支持 | ⚠️ **别用**，见下 |
| **WXS 响应事件** | `<wxs>` 里改 style | 1.0.0 | 都支持 | 跟手动画的旧方案 |
| **setData 逐帧** | — | — | 都支持 | ⚠️ **别用**，官方原文见下 |

#### `wx.createAnimation`（旧 API）的真实定位

**【文档】`wx.createAnimation`**：
「创建一个动画实例 `animation`……最后通过动画实例的 `export` 方法导出动画数据传递给组件的 `animation` 属性。」

**【文档】动画页**对它的定性：
> 「小程序基础库支持一种更友好的动画创建方式，**用于代替旧的 `wx.createAnimation`**。它具有更好的性能和更可控的接口。」

| 维度 | 结论 |
|---|---|
| 是否已废弃 | **官方未标废弃**，Windows/Mac/鸿蒙都"支持" |
| 是否推荐 | **否**。官方说 `this.animate` 是来"代替"它的 |
| 是否受渲染引擎限制 | 都支持（`animation` 属性是 WXML 数据驱动） |
| 已知缺陷 | 动画数据经 `setData` → `animation` 属性，**每帧走跨线程拷贝**；`export()` 返回的是 JSON 数据不是句柄，**中途改不了、停不了**（只能靠新的 export 覆盖） |

> **本项目实践建议**：`wx.createAnimation` 一律不用。
> 本项目 `feedback.js` 的时间轴 + CSS class 切换已经比它清晰得多，
> 而且 `transition` 在值不变时不触发（AGENTS.md 里"发牌动画"那条教训）。
> 需要"多段 + 中途取消"时，用 `this.animate`（WebView 下可用）+ `clearAnimation`。

#### 【文档】官方对 setData 逐帧动画的警告（原文照抄）

> 「连续使用 setData 来改变界面的方法也可以达到动画的效果。这样可以任意地改变界面，
> **但通常会产生较大的延迟或卡顿，甚至导致小程序僵死**。此时可以通过将页面的 setData
> 改为自定义组件中的 setData 来提升性能。」

「甚至导致小程序僵死」—— 这是官方文档里少见的强警告。
本项目 room 页 **1.5 秒轮询 + setData** 已经踩过这条的边（`roomChanged()` 去重就是为此），
**绝不要再往上叠逐帧 setData**。

#### `wx.createSelectorQuery` 的能力边界

**【文档】动画页**：`selector` 参数「同 `SelectorQuery.select` 的选择器格式」。
**【文档】获取节点信息页**（`.../framework/view/selector.html`）+ canvas 文档示例都要求
`.fields({ node: true, size: true })` 才能拿到 `node`（canvas 对象本体）。

| 能做 | 不能做 |
|---|---|
| 按 id / class 选节点，拿 `size` / `boundingClientRect` / `node` | 拿不到 `node`（若没传 `node: true`） |
| Skyline 下用 `.in(componentInstance)` 限定范围 | **`<image>` / `<canvas>` 这类原生组件在部分渲染模式下尺寸依赖渲染时机**，榜单未加载时 `boundingClientRect` 会返回 0 |
| 一次 `exec` 批量查询 | 查询是**异步**的，`exec` 之前节点必须已渲染（`wx:if` 刚为 true 时要等一拍） |

> 本项目已有一条相关坑（AGENTS.md）：Skyline 下 scroll-view 直接子节点**按需渲染**、
> 不在屏时 `boundingClientRect` 拿不到尺寸。**WebView 下同理存在"节点未渲染就拿不到"的时序问题。**

### 2.2 Skyline 相对 WebView 的额外能力

**【文档】`.../skyline/worklet.html`**

| 能力 | 接口 | 最低版本 | 说明 |
|---|---|---|---|
| worklet 函数 | `'worklet'` 指令 | — | 可跑在 UI 线程 |
| 共享变量 | `wx.worklet.shared()` | — | 跨线程同步，`.value` 读写 |
| 样式绑定动画 | `this.applyAnimatedStyle(selector, updater, opts, cb)` | **2.29.0** | updater 依赖 sharedValue 变化即重跑 |
| 清除绑定 | `this.clearAnimatedStyle(selector, styleIds, cb)` | **2.30.1** | |
| 动画类型 | `timing` / `spring` / `decay` | — | 类 Reanimated |
| 组合动画 | `sequence` / `repeat` / `delay` | — | |
| 缓动 | `Easing` | — | |
| 手势系统 | `pan-gesture-handler` / `tap` / `double-tap` / `long-press` / `scale` / `horizontal-drag` / `vertical-drag` / `force-press` | 见组件页 | 回调在 **UI 线程** |
| 共享元素动画 | `<share-element key="...">` | **2.29.2** | `shuttle-on-push/pop`、`rect-tween-type` 需 2.30.2 |

**【文档】worklet 的两条使用前提**：
1. 开发者工具「详情 → 本地设置 → 将 JS 编译成 ES5」必须勾选（代码包体积会少量增加）
2. **仅 Skyline 渲染模式可用**

**【文档】worklet 现存的坑**（原文"注意事项"）：
- worklet 内访问 `wx` 接口必须 `runOnJS`
- **不要解构 `this.data`**（会 `Object.freeze` 整个 `this.data`，导致后续 `setData` 失效）
- Page 方法必须 `this.methodName.bind(this)` 访问

**【文档】Skyline 更新日志里与 worklet 稳定性相关的真实条目**：

| 版本 | 条目 |
|---|---|
| 1.4.22 (2026-08-26) | 修复 worklet 内存泄露问题 |
| 较早 | 修复 worklet 在某些条件下出现死锁问题 |
| 较早 | 修复 worklet 模块存在 UAF 问题 |
| 较早 | 修复 worklet animatedStyle 优先级应比 WXSS 高 |

> 判读：worklet 在 2026 年仍在修 **内存泄露 / 死锁 / UAF（use-after-free）** 这类底层问题。
> 这是"引擎级增强特性"，能力天花板高，但**当前不建议作为动效主力**。

#### 共享元素转场：值不值得为它切 Skyline

**【文档】`.../skyline/share-element.html`**：
「在连续的 Skyline 页跳转时，页面间 `key` 相同的 `share-element` 节点将产生飞跃特效」
—— 这是原生 App 那种"图片从列表飞到详情"的效果。

| 代价 | 内容 |
|---|---|
| 必须全站 Skyline | `app.json` 加 `renderer`，且 **canvas / video / map / camera 在工具里都不能调试** |
| 必须自定义导航栏 | 【文档】组件支持表：「navigation-bar ｜ 不考虑 ｜ **Skyline 只能用自定义导航**」 |
| 布局要重写 | Skyline **不支持 inline 布局**（"开发中"），本项目大量文字排版依赖 inline |
| 调试成本 | 每次真机上传 |

> 本项目现状：3 个页面（大厅 / 房间 / 我的），**没有"列表 → 详情"这种需要在页面间飞图片的场景**。
> 共享元素动画**用不上**。为它切 Skyline = 纯亏损。

### 2.3 CSS 特性边界：逐项结论

#### 先说读法（这条比任何单项结论都重要）

微信官方**只给 Skyline 的逐项支持表**，**不给 WebView 的** —— 因为 WebView 就是系统内核，
支持度取决于 iOS 的 WKWebView / Android 的 XWeb 版本，官方不做逐项承诺。

所以本节的判据是：

| 表 | 可信度 | 怎么用 |
|---|---|---|
| **Skyline 支持表** | 【文档】逐项明确 | 当作**保守下限**：Skyline 说支持的，WebView 一定支持（因为 WebView 是完整浏览器内核） |
| **WebView 实际支持** | 【未确认】官方无表 | 只能真机验证；**不能拿 Chrome 的支持度套**（微信内核版本滞后） |

> ⚠️ 本项目当前用 **WebView**。下表里标 "Skyline ✗" 的特性（如 `clip-path`），
> **在 WebView 下大概率是好的**，但官方不给保证 —— 属于"能跑，但哪天升级内核变了不赔"。
> 结论列里我按"**保守可用 / 有条件可用 / 不要依赖**"给建议。

#### 逐项结论

| 特性 | Skyline【文档】 | 关键限制（原文） | 本项目建议 |
|---|---|---|---|
| **`filter`** | ✅ 支持 | 「不支持 multi function；**不支持 drop-shadow**；不支持 url」 | **有条件可用**：单独一个函数 OK（如 `blur(4px)`、`saturate(1.2)`），**不能串联**，**没有投影** |
| **`backdrop-filter`** | ✅ 支持 | 同 filter，且「**与 opacity 混合有问题**；**blur 某些情况表现不一致**」 | **不要依赖**做玻璃拟态。这是"两个已知不确定"叠加的特性 |
| **`clip-path`** | ❌ **不支持** | 属性表里**没有这一项**；特性状态页写「**支持 css clip-path ｜ 规划中**」（页脚"最后编辑于 2026-06-16"） | **WebView 下可用**（浏览器内核），但**Skyline 下必坏**。若只在 WebView 跑，可作装饰；**不能做功能性的图形遮罩** |
| **`conic-gradient()`** | ✅ 支持 | 列在 `<gradient>` 类型表里，`✓` | **可用**。这是转盘扇区的正解（本项目 render 脚本之外的唯一 CSS 方案） |
| **CSS 变量** | ✅ 支持 | 模块表「CSS Variable（CSS 变量）｜✓｜**安卓 8.0.35，iOS 8.0.38**」 | **可用**，有明确版本门槛 |
| **`@property`** | ❌ 未出现 | 属性支持表、类型支持表、更新日志 **三处都没有 `@property`** | **不要用**。这是 CSS Houdini 的注册自定义属性（做"可插值的角度变量"必需）。官方既没写支持也没写不支持 → **【未确认】，但按"未列入=不支持"处理** |
| **`will-change`** | ⚠️ **只支持 `auto` / `contents`** | 属性表原文：「will-change ｜ 支持格式：**auto / contents** ｜ 说明：**声明绘制边界，优化渲染性能**」 | **`will-change: transform` 在 Skyline 无效**（`transform` 不是合法值）。语义被重新定义了：它在这里是"声明绘制边界"的开关，不是浏览器那个提升图层的提示。**WebView 下按常规语义用**（浏览器支持） |
| **`box-shadow`** | ✅ 但受限 | 「**不支持多个叠加**」 | 多层阴影（`0 2px 4px, 0 8px 16px`）在 Skyline 只剩一层。本项目圆角卡片普遍用了多层阴影 → **切 Skyline 会掉质感** |
| **inline 布局** | ❌ | 模块表「Inline 布局 ｜ × ｜ 开发中」「Inline-Block 布局 ｜ × ｜ 仅支持在 text 组件里的嵌套结构使用」 | **切 Skyline 的最大障碍**：文字混排（图标 + 文字 + 空格）全部要改成 `text` + `span` |
| **通配选择器 `*`** | ❌ | 选择器表「通配选择器 ｜ × 」 | 不用 |
| **属性选择器 `[attr]`** | ❌ | 选择器表「属性选择器 ｜ × 」 | 不用 |
| **`em` 单位** | ❌ | 类型表「em ｜ × 」 | **用 `rpx` / `rem`**（`rem`/`rpx`/`vw`/`vh`/`vmin`/`vmax` 都 ✓） |
| **`currentColor`** | ❌ | 类型表「currentColor ｜ × ｜ 考虑支持」 | 颜色必须写死或用 CSS 变量 |
| **兄弟选择器 `~` `+`** | ✅ 8.0.49 起 | 属性/选择器表备注 | 老版本微信不支持 |
| **`:nth-child`** | ✅ 微信 8.0.50 / Skyline 1.3.3 | 伪类备注 | 有明确门槛 |
| **`::before` / `::after`** | ✅ | 「只支持 ::before 和 ::after」 | 可用 |
| **Media queries** | ⚠️ 只支持 DarkMode | 「只支持 DarkMode」 | 不能用来做尺寸适配（用 `match-media` 组件） |
| **本地 `@font-face`** | ✅ **只支持 ttf** | 模块表「Font-face ｜ ✓ ｜ **只支持 ttf 格式**」；特性状态页另有「Font-face 支持 woff 格式 ｜ 待发布」 | 走 `wx.loadFontFace`（支持 ttf/woff，见 §3.2）而非 WXSS 的 `@font-face` |
| **CSS Animation** | ✅ 安卓 8.0.37 / iOS 8.0.39 | — | 可用 |
| **CSS Transition** | ✅ | — | 可用 |
| **`position: fixed`** | ✅ 微信 8.0.43 起 | 「只支持相对于窗口 viewport 定位，不支持 top/left/… 默认值 auto 解析」 | 有版本门槛 |
| **`z-index`** | ⚠️ **语义缩水** | 「**不支持层叠上下文，只对兄弟节点生效**」；「不支持在 scroll-view 下的直接子节点上应用」 | **这是 Skyline 最隐蔽的坑**：本项目弹层/浮层依赖 `z-index` 跨层级覆盖，Skyline 下会失效 |

#### 「手写 keyframes 粗糙」的真正原因

排完这张表会发现：**CSS 能力本身不是瓶颈**。转盘（`conic-gradient` ✓）、
开盅（`transform` + `transition` ✓）、撒花（多元素 `@keyframes` ✓）、发光（`filter` 单函数 ✓）
全都在射程内。粗糙感来自三件事，都不是 Lottie 能救的：

1. **曲线**：`ease` 是默认值，`cubic-bezier(0,0,.2,1)` 才像样（本项目 `game-feel-spec` 已定）
2. **时间轴**：三通道（画/音/振）错开 30/20ms（本项目 `feedback.js` 已做）
3. **材质**：离线渲染的骰子（`render-dice.py`）比任何 CSS 立方体都强 —— **本项目已经做对了**

> 所以 §4 的结论从这张表就已经能推出来了。

### 2.4 音频：`InnerAudioContext` vs `WebAudioContext`

> 📎 **分工说明**：**"音效素材从哪来、怎么转码"不在本文范围** —— 见同批调研
> [`2026-10-28-audio-assets.md`](./2026-10-28-audio-assets.md)（Kenney Casino Audio、OGG→AAC 转码等）。
> **本文只回答一件事：播放链路该用哪个 API。**
>
> ⚠️ 本节引用的"35 个 wav / 530 KB"是 **2026-10-28 16:2x 快照** —— 同期音频正在被替换成真实录音，
> 这个数字会变。**"体积占包一半"的结构性结论比具体数字更重要**。

#### 格式支持（**【文档】InnerAudioContext** 原文表格）

| 格式 | iOS | Android |
|---|---|---|
| **wav** | ✅ | ✅ |
| **mp3** | ✅ | ✅ |
| **m4a** | ✅ | ✅ |
| **aac** | ✅ | ✅ |
| ogg | ❌ | ✅ |
| flac / ape / amr / wma / mp4 | ❌ | ✅ |
| aiff / caf | ✅ | ❌ |

> **只有 4 种双端通吃：wav / mp3 / m4a / aac。**
> 本项目音效是 wav（实测 **35 个文件 / 542,556 B ≈ 530 KB**）—— 双端安全，但**体积是最大的一项**
> （占 miniprogram 总量的**近一半**）。
> 若将来要压体积，**m4a（AAC）是唯一安全的替代**；ogg 只在 Android 能放，不能当主力。

#### 并发上限

**【文档】小游戏音频指南**（`.../minigame/dev/guide/base-ability/audio.html`，页脚"最后编辑于 2026-07-04"）原文：

> 「#### 同时播放的音频数量限制
> 由于系统限制，**在 Android 上最多同时播放 10 个音频**，超过的部分会做**有损处理**，
> **对开发者来说不感知**，但开发者应尽量避免同时播放过多音频。」

> ⚠️ **【未确认】** 这句话只在小游戏文档里出现。**小程序侧的 `InnerAudioContext` 文档没有同样的表述。**
> 两者底层很可能是同一套实现（API 签名完全一致），但**官方没有为小程序许诺过 10 这个数**。
> 工程上按 10 当上限做预算，是安全的；**但它不是小程序侧的官方承诺。**

> 「**对开发者来说不感知**」这句话才是真正危险的：超限不会报错，**只是悄悄不响**。
> 本项目 35 个音效如果同时触发（比如撒花 + 骰子落定 + 震动同时来），
> 在 Android 上就是**随机丢声**，且无法复现、无法排查。

#### 两者的本质差别

**【文档】`wx.createInnerAudioContext`**：
- 基础库 **1.6.0** 起
- 参数 `useWebAudioImplement`（**2.19.0** 起）：「是否使用 WebAudio 作为底层音频驱动，默认关闭。
  **对于短音频、播放频繁的音频建议开启此选项**，开启后将获得更优的性能表现。
  由于开启此选项后也会带来一定的内存增长，因此对于长音频建议关闭此选项。」
- 注意事项：「InnerAudioContext 音频资源**不会自动释放**……请及时调用 `destroy()`」

**【文档】`wx.createWebAudioContext`**：
- 基础库 **2.19.0** 起
- **小程序插件：不支持**（InnerAudioContext 是支持的）
- 标准 Web Audio API：`createGain` / `createBufferSource` / `createBiquadFilter` /
  `createConvolver`(via `createBuffer`+`WaveShaper`) / `createAnalyser` / `createDelay` /
  `createDynamicsCompressor` / `decodeAudioData` / `sampleRate` / `state` / `close` / `resume` / `suspend`

**【文档】小游戏音频指南**对两者的定性：

> 「**InnerAudio** 播放音频的方式简便快捷，且支持流式播放，**但性能低于使用 WebAudio 的播放方式**，
> 适用于播放**较大音频文件**，比如背景音乐。」
>
> 「**WebAudio** 播放性能好，能力丰富，**但占用内存较大**，
> **建议短音频、播放频繁的音效使用**。」

**【文档】`wx.setInnerAudioOption` 注意事项**（这条会影响选型）：
> 「目前 `wx.setInnerAudioOption` 接口**不兼容** `wx.createWebAudioContext` 接口，
> 也不兼容 `wx.createInnerAudioContext` 开启 `useWebAudioImplement` 的情况，将在后续版本中支持。」

#### 结论：游戏音效用哪个

| 用途 | 选型 | 理由 |
|---|---|---|
| **短音效（< 1s，频繁触发）** | **`wx.createWebAudioContext()` + `createBufferSource`** | 官方原话"短音频、播放频繁的音效"用它；`AudioBuffer` 解码一次可无限复用，**不受 InnerAudioContext 的实例生命周期困扰** |
| **长音频 / 背景音乐** | `wx.createInnerAudioContext()` | 流式播放，内存友好；`loop` 天然支持 |
| **不想引入 WebAudio 复杂度，只要音效** | `wx.createInnerAudioContext({ useWebAudioImplement: true })` | 一行开关换 WebAudio 驱动，改动最小 |
| **要切扬声器/听筒、混音控制** | 必须 `InnerAudioContext`（+ `setInnerAudioOption`） | WebAudio 路线**不兼容**该接口 |

**WebAudio 路线的正确姿势（预解码 + 复用，不每次 new）：**

```js
// utils/sfx.js —— 一次解码，多次播放
const ctx = wx.createWebAudioContext()
const buffers = {}          // name -> AudioBuffer

function preload(name, path) {
  return new Promise((resolve, reject) => {
    wx.request({
      url: path,                       // 支持本地代码包路径 & https
      responseType: 'arraybuffer',
      success: res => ctx.decodeAudioData(res.data,
        buf => { buffers[name] = buf; resolve(buf) },
        err => reject(err)),
      fail: reject,
    })
  })
}

function play(name, gain = 1) {
  const buf = buffers[name]
  if (!buf) return false
  const src = ctx.createBufferSource()
  src.buffer = buf
  const g = ctx.createGain()
  g.gain.value = gain
  src.connect(g); g.connect(ctx.destination)
  src.onended = () => { src.disconnect(); g.disconnect() }   // 不 disconnect 就是内存泄漏
  src.start()
  return true
}

module.exports = { preload, play }
```

> **两条必须遵守**：`decodeAudioData` 只做一次（每次解码都要 10~100ms，叠在动画上就是"音画不同步"）；
> 播完必须 `disconnect()`（`AudioBufferSourceNode` 是**一次性**的，不 disconnect 会累积图节点）。

> ⚠️ **【未确认】** `wx.request` 能否直接读代码包内路径（`/audio/dice.wav`）作为 `arraybuffer`。
> 本项目现有音效是用 `innerAudioContext.src = '/audio/xxx.wav'` 的相对路径方式（代码包路径），
> 这条已验证可用；**但 `wx.request` 读代码包路径未在本项目验证过**。
> 若走 WebAudio 路线，稳妥做法是把音效放 CDN，或先用 `wx.getFileSystemManager().readFileSync`
> 读本地文件拿到 `ArrayBuffer` 再 `decodeAudioData`。

---

## 3. 可商用素材清单

> **本节的判据**：只收录**许可页明确写了可商用**的源，每条都给许可原文/官方页 URL。
> 许可会变 —— **下载前请重新打开许可页确认一次**（多为用户自动记忆"CC0 永远安全"，其实站点可以换条款）。

### 3.1 骰子 / 骰盅 / 扑克牌 / 筹码 / 木桌纹理

| 素材 | 来源 | 许可 | URL | 备注 |
|---|---|---|---|---|
| **骰子 + 筹码 + 扑克 + 棋子（2D，含 SVG 源）** | **Kenney — Board Game Pack** | **CC0** | https://kenney.nl/assets/boardgame-pack | 【文档】页面标注「License: Creative Commons CC0」，**490 个文件**（`Files 490×`），2014 年发布。**这是本清单第一优先**。⚠️"内含十来个配套音效"一说来自第三方目录（【社区】https://tmhsdigital.github.io/Free-Game-Dev-Assets/entry/kenney-boardgame-pack），Kenney 本站页面上**没写**，缓存前请自行确认 |
| **扑克牌（像素风，270+ PNG）** | Kenney — Playing Cards Pack | CC0 | https://kenney.nl/assets/playing-cards-pack | 三种尺寸 + tilesheet + 矢量源。OpenGameArt 同名页写「Credit "Kenney.nl" … **this is not mandatory**」 |
| **扑克牌（矢量 + PNG）** | OpenGameArt — Byron Knoll | CC0 | https://opengameart.org/content/playing-cards-vector-png | ⚠️ 该页评论区有质疑（"K/Q/J 像是从扫描图自动描的"）。**若要商用，用 Kenney 那套更稳** |
| **木桌 / 木纹 PBR 无缝贴图** | **ambientCG** | **CC0 1.0** | https://ambientcg.com/licenses | 【文档】原文：「All ambientCG assets are provided under the **Creative Commons CC0 1.0 Universal License**……You can include the raw files in your project, for example a video game」。搜 `Wood` 系列（Wood043 之类） |
| **木桌 3D 模型 / 高清木纹** | **Poly Haven** | **CC0** | https://polyhaven.com/license | 【文档】原文：「Our assets are all licensed as **CC0**……You can use our assets for **any purpose, including commercial work**. You do **not need to give credit**」 |
| **各类 2D 素材（混合许可）** | OpenGameArt | **逐文件不同** | https://opengameart.org | ⚠️ 同一站里 CC0 / CC-BY（须署名）/ CC-BY-SA（须署名 + **衍生作品同许可**）混在一起。**CC-BY-SA 对商业闭源产品是硬伤**，一定要看单个提交页的 License 栏 |

#### 关于「骰盅」的特别说明

**没有找到现成的 CC0 骰盅素材。** Kenney 的 board game pack 有骰子和棋子，**没有骰盅（cup）**。

本项目已经解决了这件事，而且是**更优解**：`scripts/render-dice.py` + `scripts/render-cup.py`
用 SDF + 光线步进离线渲染出自己的骰子与骰盅 PNG（同一套光照，明暗天然一致）。

> AGENTS.md 记的这条判断在这里得到再次确认：
> 「**CSS 做不出圆角立方体，数学上无解**」+「盅必须和骰子同一套光照，否则叠一起一眼假」。
> **现成素材反而解决不了这个问题** —— 买来的骰盅和买来的骰子光照对不上。
> 所以：骰盅/骰子这条线**继续走自渲染**，不要去素材站找。素材站的价值在
> **扑克牌、筹码、桌纹、音效**。

#### 音效（本项目已自建，但仍列出可商用源以备扩充）

| 来源 | 许可 | 备注 |
|---|---|---|
| Kenney — 各 pack 附带的音效 | CC0 | 与素材同包，最省事 |
| Freesound | **逐文件** CC0 / CC-BY / CC-BY-NC | ⚠️ **CC-BY-NC 禁商用**，本项目不能用；筛选时务必按 CC0 过滤 |
| 本项目 `scripts/gen-audio.py` | 自有 | **已是主路线**（35 个音效、去直流、加早期反射，见 AGENTS.md） |

### 3.2 小程序可商用中文字体

#### 三条硬约束（先看这个，再看字体表）

**【文档】`wx.loadFontFace` Tips 原文**：
1. 「字体链接需要是**下载类型**」
2. 「字体链接**必须是 https**（iOS 不支持 http）」
3. 「建议格式为 **TTF 和 WOFF**，**WOFF2 在低版本的 iOS 上会不兼容**」
4. 「字体链接必须是**同源**下的，或开启了 **cors** 支持，小程序的域名是 `servicewechat.com`」
5. 「`2.10.0` 以前仅在调用页面生效。**`2.10.0` 起支持全局生效，需在 `app.js` 中调用**」
6. 「`3.7.9` 开始 `source` 支持传入 **Data URL**」

**【文档】`scopes` 参数**（这条决定 Canvas 里能不能用）：
> 「字体作用范围，可选值为 `webview` / `native` / `skyline`，默认全选，
> **设置 `native` 可在 Canvas 2D 下使用**」

> ⚠️ **`3.7.9` 之前 `scopes` 默认是 `webview`** —— 老基础库上 Canvas 里画中文会变豆腐块，
> 必须显式传 `scopes: ['webview', 'native']`。

**【文档】Skyline 的 `@font-face` 只支持 ttf** —— 若走 WXSS 的 `@font-face`（本地文件），
**必须 ttf**；走 `wx.loadFontFace`（网络加载）则可 ttf/woff。

#### 字体清单

| 字体 | 许可 | 可商用 | 可嵌入小程序 | 来源 |
|---|---|---|---|---|
| **思源黑体 / Source Han Sans**（Adobe） | **SIL OFL 1.1** | ✅ 明确可商用 | ✅ OFL 允许 embed/bundle（"can be bundled, embedded, redistributed"） | https://github.com/adobe-fonts/source-han-sans |
| **思源宋体 / Source Han Serif** | SIL OFL 1.1 | ✅ | ✅ | https://github.com/adobe-fonts/source-han-serif |
| **Noto Sans SC / Noto Serif SC**（Google，思源同源） | SIL OFL 1.1 | ✅ | ✅ | https://fonts.google.com/noto |
| **阿里巴巴普惠体 3.0** | 阿里官方「永久免费商用」声明 | ✅ | ✅（但需自备许可页存档） | https://www.alibabafonts.com/ |
| **HarmonyOS Sans**（华为/汉仪） | 免费商用，**需保留版权声明** | ✅ | ✅ | https://developer.harmonyos.com/ |
| **MiSans**（小米） | 免费商用 | ✅ | ✅ | https://hyperos.mi.com/font/ |
| **OPPO Sans** | 免费商用 | ✅ | ✅ | https://www.coloros.com/ |

> OFL 的唯一硬禁止：**不得单独出售字体文件本身**（"Neither the Font Software … may be sold by itself"）。
> 把字体嵌进小程序**不属于**单独出售 → 合规。
> 另外 OFL 要求「每份副本须包含版权声明和本许可证」→ **实操：在小程序「关于」页放字体致谢**。

#### ⚠️ 真正的障碍不是许可，是体积

| 事实 | 数值 |
|---|---|
| 思源黑体 CN Regular 全量 TTF | **十几 MB 量级**（远大于 2 MB 主包上限） |
| 本项目主包剩余空间 | 约 **890 KB**（1,106 KB 已用 / 2048 KB 上限） |
| 结论 | **全量中文字体绝无可能打进包** |

**三条可行路线（按推荐度排序）：**

1. **只做标题字，且子集化**（推荐）
   选 1 个字重、只保留实际用到的字符（本项目全是游戏名/按钮/短句，**常用字 + 专有名词
   大概 300~800 字**），子集化后 TTF 通常 **30~80 KB**。
   工具：`fonttools`（`pyftsubset`）、`fontmin`。
   > 【未确认】具体到本项目的字数与子集体积 —— **没有实做，不给假数字**。

2. **放 CDN + `wx.loadFontFace`**
   字体文件放自己域名（要配 `downloadFile` 合法域名 + CORS），`app.js` 里
   `global: true` 加载一次。**不占包体积**，代价是首屏要等字体下载（1~3 MB 在弱网下几百 ms 到几秒）。
   必须做：**先渲染系统字体，字体到了再 `setData` 切**，避免 FOIT（白字）。

3. **不用自定义字体，靠系统字体 + 字距/字色/大小做质感**
   本项目已在这条路上（`game-feel-spec` 的排版规格）。
   **这是零风险、零体积的方案**，对"摆脱粗糙感"的贡献其实不小。

> **本报告建议**：标题用 route 1（子集化思源黑体 Bold，≤80 KB），正文继续系统字体。
> 中文字体的质感提升远不如"曲线 + 时间轴 + 材质"三项，**投入产出比最低**。

### 3.3 现成的「酒桌 / 聚会」主题 UI kit

#### 结论：**没有找到**

检索过 Figma Community UI Kits 目录（https://www.figma.com/community/ui-kits，官方页，
标注 **4,770+ 免费 UI kits**）、以及 Envato / 各设计资源站的分类页。

- **"酒桌 / 喝酒 / 派对游戏"这个细分品类，Figma 社区没有专门的免费 kit。**
- 棋牌 / 扑克类 kit **基本都是付费的**（Envato Elements 里能看到
  「Poker Game App UI Kit」「Online Poker Game & Casino Black App & Ui Kit」等，均需订阅）。

**【未确认】** 这是一个"没搜到"的结论，不是"不存在"的证明。
Figma 社区搜索是动态的，可能有新发布的、或名字不含关键词的。**不要把它当免责依据。**

#### 能用的替代参考（免费）

| 资源 | 类型 | 链接 | 用途 |
|---|---|---|---|
| **Figma Community — UI Kits 总目录** | 免费 kits 索引（官方页称 4,770+） | https://www.figma.com/community/ui-kits | 从这里按 "game / card / casino" 二次筛 |
| **2D Game UI Kit**（Figma 社区，免费） | 游戏 UI 组件（按钮/弹窗/设置页） | https://www.figma.com/community/file/1685997922603354206/2d-game-ui-kit-free-game-ui-components-game-ui-design | 可改色改形状，适合抄"游戏感"的结构 |
| **Mobile Game UI kit**（Figma 社区，免费） | 移动游戏 UI（设置/暂停/按钮） | https://www.figma.com/community/file/1670405619288902462/mobile-game-ui-kit-assets-and-ui-elements | 同上 |
| **100 card design templates UI kit** | 卡片版式 | 见 Figma Community UI Kits 目录 | 纸牌正反面版式参考 |

> **本项目的现实**：现有视觉方向（暖米色 `#F5F0EA` / 珊瑚橙 `#E0714F` / 木质牌桌）
> 是"线下酒桌"调性，**与上述 kit 的电竞/暗黑风完全不符**。
> 抄它们只会把风格搞乱。**这三条链接的价值在"结构参考"（弹层、按钮状态、数值呈现），
> 不在"视觉照搬"。**

---

## 4. 实测判断：2MB 上限下，Lottie 值不值得上？

### 4.1 先算体积账（【实测】，可复现）

#### Lottie 样本实测（真实文件，不是估算）

采集方式：从 npm 的 `lottie-web@5.12.2` 包里取出官方测试动画，用 Python 解析
`fr`（帧率）/ `op`（总帧数）算时长、量字节数。

```bash
for n in lights starfish ripple bacon adrock banner dalek; do
  curl -sLO "https://cdn.jsdelivr.net/npm/lottie-web@5.12.2/test/animations/$n.json"
done
```

| 样本 | 时长 | 体积 | 顶层图层 | 总图层（含 precomp 内层） | 每秒体积 |
|---|---|---|---|---|---|
| `lights.json` | **5.00 s** | **21.5 KB** | 14 | 14（无 precomp） | **4.3 KB/s** |
| `starfish.json` | **5.02 s** | **24.2 KB** | 15 | 16 | **4.8 KB/s** |
| `ripple.json` | 6.02 s | 11.2 KB | 2 | **29** | 1.9 KB/s |
| `banner.json` | 24.12 s | 191.3 KB | 7 | **32** | 7.9 KB/s |
| `dalek.json` | 9.67 s | 86.6 KB | **46** | 49 | 9.0 KB/s |
| `bacon.json` | 4.67 s | **388.0 KB** | 5 | **54**（1 个 precomp 内就 39 层） | **83.1 KB/s** |
| `adrock.json` | 0.67 s | 123.9 KB | 29 | **59** | **185.9 KB/s** |

**结论（这是本报告最硬的一组数）：**

1. **典型的 5 秒纯矢量 UI 动效 = 11~25 KB。** 三个 5~6 秒样本全部落在这个区间。
2. **体积由「图层数 × 每层关键帧密度」决定，与时长基本无关。**
   反例正好对照出来（这是实测跑出来的，不是推测）：

   | 样本 | 总图层 | 时长 | 体积 | 说明 |
   |---|---|---|---|---|
   | `ripple` | **29** | 6.02 s | **11.2 KB** | 层多但**层是静态的**（关键帧少）→ 体积很小 |
   | `bacon` | 54 | 4.67 s | **388 KB** | 层数相近，但**每层关键帧极密** → 体积 35 倍 |
   | `adrock` | 59 | **0.67 s** | **124 KB** | 只有 0.67 秒，照样 124 KB —— **时长不是因素** |

   **两条判据**：① 别用"时长"估体积；② 数"关键帧总数"（`k` 数组里 `t` 的个数），
   比数图层更准。**"5 秒"这个条件本身不决定大小** —— 5 秒可以 11 KB，也可以 388 KB。
3. **所以「一个 5 秒动效多大」这个问题的正确答法是**：
   **简单动效 20 KB 上下，复杂动效 100~400 KB。** 决定因素是图层复杂度，不是时长。

> 交叉印证（第三方博客数据，与上面的实测一致）：
> 「typical Lottie animation is 5–20KB」；「Aim for under **50KB for UI animations**;
> under **200KB for more complex illustrations**」
> —— https://www.linearity.io/blog/lottie-animation-guide
>
> 另一个真实案例：35 秒动画导出 JSON **1.2 MB**，gzip 后 **120 KB**
> （lottie-web 作者 bodymovin 本人在 issue 里确认）
> —— https://github.com/airbnb/lottie-web/issues/2100

#### 把 Lottie 装进本项目的体积账

| 项 | 体积 | 说明 |
|---|---|---|
| `lottie-miniprogram` 库 | **≈ 205 KB** | 一次性的固定成本 |
| 1 个简单 5 秒动效 | ≈ 20 KB | 图层少 |
| 1 个"重头戏"动效 | ≈ 100~200 KB | 多层，开盅 / 撒花级别 |
| **合计（库 + 3 个动效）** | **≈ 300~400 KB** | |
| 本项目主包剩余 | ≈ **890 KB** | 1,106 KB 已用 / 2 MB 上限 |

也就是说：**装了 Lottie，剩余约 890 KB 空间会被吃掉约 45%**，而这只换来 3 个动效。

> **【文档】一条雪上加霜的事实**（`.../performance/tips/start_optimizeA.html`）：
> 「小程序代码包在**下载时**会使用 **ZSTD 算法进行压缩**，图片、音频、视频、字体等资源文件会占用较多
> 代码包体积，并且**通常难以进一步被压缩**，对于下载耗时的影响比代码文件大得多。」
>
> 判读：**2 MB 上限是按打包后（未压缩）的文件体积算的**，ZSTD 只影响下载时长，**不影响额度**。
> 而且 JSON 虽然压缩率高（1.2 MB → 120 KB），**额度上仍按 1.2 MB 计**。
> 想绕开 2 MB 只有一条路：**放 CDN 走 `path`**（但那样首帧依赖网络，且要配合法域名）。

### 4.2 再算能力账

| 需求 | Lottie 能给 | 本项目已有方案能不能给 |
|---|---|---|
| 开盅时的颗粒飞溅 + 光晕 | ✅ 能做（但要 AE） | ⚠️ 光晕（`filter: blur` 单函数）可以，飞溅要序列帧 |
| 撒花 / 金币爆炸 | ✅ 强项 | ⚠️ 多元素 CSS `@keyframes` 能做 80%，质感差在随机性 |
| **模糊 / 发光 / 投影** | ❌ **做不了**（Canvas renderer 无 SVG filter，见 §1.3 坑 7） | ✅ CSS `filter: blur()` 可用（单函数） |
| 转盘旋转 | ⚠️ 能做但**全屏必触 1365 上限**（§1.5） | ✅ `transform: rotate` + `cubic-bezier` 完全够 |
| 骰子翻滚 | ❌ 做不了真实 3D | ✅ **已自渲染 PNG + 逐帧**（`render-dice.py`） |
| 牌面翻开 | ⚠️ 能做，但本项目**已明确不用 3D `rotateY`**（兼容性） | ✅ 交叉淡入 + 缩放 + 2.5°（已实现、已验证） |
| 手势跟手的弹性 | ❌ | ✅ Skyline worklet（不用切）；WebView 用 `transition` 近似 |
| 需要表达式（数字滚动等） | ❌ 不支持（§1.3 坑 6） | ✅ JS + setData（少量） |

**这张表最扎眼的一行是第一行**：Lottie 在小程序里**恰恰做不了**最容易出"高级感"的
模糊/发光/投影。而这正是"摆脱粗糙感"最直觉的手段 —— 而它在 CSS 里**是能用的**。

### 4.3 结论与替代方案排序

#### 明确回答

> **对一个主包上限 2 MB 的微信小程序（本项目已用 1,106 KB ≈ 54%），
> `lottie-miniprogram` 整包方案 —— 不值得上。**
>
> **但"用 Lottie 做 1~2 个招牌动效"是值得考虑的**，
> 前提是：只上 1 个实例、只做"矢量图形 + 变换"、不指望模糊发光、接受不能多实例。

理由汇总（按权重）：

| # | 理由 | 权重 |
|---|---|---|
| 1 | **库吃掉 205 KB（≈ 剩余 890 KB 的 23%），换来 3 个动效**（3 个是假设值，见 §4.1 账面） | 高 |
| 2 | **内嵌 lottie-web 5.5.7（2019），落后官方 8 个 minor，且 5 年无发版** | 高 |
| 3 | **做不了模糊/发光/投影** —— 而这是"高级感"的主要来源，CSS 反而能做 | 高 |
| 4 | **多实例不可行**（全局单例 + rAF 竞速 + destroy 回滚全局） | 高 |
| 5 | **全屏动效触 1365 上限**，转盘/开盅这类最需要它的场景恰好受限 | 中 |
| 6 | **Skyline 下工具不能调试 canvas**，切引擎只会让调试更难 | 中 |
| 7 | 要稳定就得 `patch-package` 改 node_modules（rAF 竞速） | 中 |
| 8 | 本项目的瓶颈**不在动效引擎**（见 §2.3 末段：曲线/时间轴/材质已解决或已有方案） | 高 |

#### 替代方案排序（本项目该怎么补动效）

| 排序 | 方案 | 体积 | 质量上限 | 风险 | 落地动作 |
|---|---|---|---|---|---|
| **①（首选）** | **强化现有 CSS 路线**：统一用 `cubic-bezier(0,0,.2,1)` / `(.4,0,1,1)`、把 `feedback.js` 时间轴**扩到全部交互**、`transform` + `opacity` 只用这两个属性（GPU 友好） | **0 KB** | 高（配合好曲线+错峰时间轴，"廉价感"主要来自这里） | 无 | 不改架构，只补细节 |
| **②** | **序列帧 PNG/WebP**（离线渲染 → 逐帧 `<image>` 或 canvas 播） | 每个动效 30~150 KB | **最高**（能做出 Lottie 做不了的发光/粒子/体积感） | 中：帧数多、要管内存 | 复用 `render-dice.py` 的渲染管线 |
| **③** | **内联 SVG + CSS `@keyframes`**（本项目 42 个图标已是内联 SVG） | 每个 ~1~3 KB | 中高 | 低 | 撒花/星光这类纯几何动效 |
| **④** | **CDN 上的 mp4/WebM 短片**（`<video>` 播一次） | 包内 0 KB | 高 | 中：`<video>` 是原生组件，层级/同层问题 | 只用于"开场动画"这类独占全屏的一次性内容 |
| **⑤** | **Lottie（单实例、单动效）** | 205 KB + 20~200 KB | 中高（受 §4.2 限制） | 高（见上 8 条） | **只在 ①②③④ 都做不出目标效果时才考虑** |
| — | ❌ 不用：`wx.createAnimation`（旧）、逐帧 `setData`（官方警告"僵死"） | — | — | — | — |

#### 如果将来真要用 Lottie，这份清单是前提

1. 只在 **WebView** 下用（不要为它切 Skyline）
2. 全局**同屏只 1 个实例**，播完 `destroy()`
3. 动效文件**纯矢量、无表达式、无 Gaussian Blur、无嵌入图片**
4. `animationData` 走**包内 require**（20 KB 级别可以承受）或 CDN（大于 50 KB 时）
5. 写 `patch-package` 补丁去掉 rAF 的 `setTimeout` 兜底
6. `canvas.width/height` 一律 `Math.min(w*dpr, 1365)`
7. `onUnload` 里 `destroy()`，且**先 destroy 再让节点消失**
8. 在「关于」页加一行 LottieFiles 素材致谢

---

## 5. 未确认清单（明确不编）

| # | 未确认项 | 为什么没确认 | 怎么确认 |
|---|---|---|---|
| 1 | **同屏 N 个 Lottie 的具体 FPS** | 无公开基准；真机测需开开发者工具（本会话纪律禁止） | 真机 + 「FPS 面板」（官方面板文档 `.../performance/fps_panel.html`） |
| 2 | **`lottie-miniprogram` 的 GitHub star / open issue 数** | GitHub API 对本机 IP 限流（`API rate limit exceeded`），网页抓取也超时 | 换网络 / 用 token 调 API |
| 3 | **`@property` 在小程序的支持** | Skyline 属性表、类型表、更新日志**三处都没有**；WebView 官方无表 | 真机 CSS 试写 + `getComputedStyle` 探测 |
| 4 | **WebView 渲染下 CSS 特性的逐项支持** | 官方只给 Skyline 表；WebView 取决于系统内核版本，官方不承诺 | 真机验证；或看 `.../skyline/wxss.html` 作下限参考 |
| 5 | **`clip-path` 在 WebView 下的实际表现** | Skyline 明确"规划中"（不支持）；WebView 无官方结论 | 真机试；**不要用于功能性遮罩** |
| 6 | **小程序（非小游戏）是否有"Android 最多 10 路音频"的官方明文** | 只有小游戏文档写了这句 | 向官方提 issue；工程上按 10 做预算 |
| 7 | **`wx.request` 能否直接读代码包内路径的音频** | 本项目未验证 | 真机试 `wx.request({url:'/audio/x.wav', responseType:'arraybuffer'})` |
| 8 | **思源黑体子集化后本项目的实际体积** | 没实做字体子集 | 跑 `pyftsubset` 量一次 |
| 9 | **Figma 社区是否存在"酒桌/聚会"主题免费 kit** | 搜不到 ≠ 不存在；Figma 社区动态更新 | 在 Figma 社区内按 `drinking game` / `party game` / `cards` 再筛 |
| 10 | **`lottie-miniprogram` 升级 lottie-web 到 5.13 的可行性** | README 说"改依赖版本号即可"，但无人验证；5.6+ 的 canvas renderer 有内部 API 变动 | fork + 重新 webpack + 真机回归 |
| 11 | **本报告 §1.9 的最小集成代码能否一次跑通** | 依据官方文档写，**未在真机执行** | 按 §1.9 逐步跑，重点验：`fields({node:true})` 拿 node、`require` 的 JSON 路径、`destroy` 时序 |
| 12 | **Lottie Simple License 的"derivative works 同许可"对闭源小程序的实际约束力** | 这是法律解释问题，不是技术问题 | 需要法务意见；工程上按"加致谢"处理 |
| 13 | **小程序原生是否支持 `require('*.json')`** | 官方《模块化》文档只描述 js 模块，**通篇没提 JSON**。社区普遍这么用且能跑，但**文档里找不到依据** | 真机试 `require('./x.json')`；或改用官方的 `wx.getFileSystemManager().readFileSync` + `JSON.parse`（这条路有官方文档依据） |
| 14 | **外部 `ctx.scale(dpr,dpr)` 在 lottie 渲染时是否保留** | lottie-web 的 canvas renderer 内部会改 `ctx` 变换，外部 scale 可能被重置。**没跑过就不能断言** | 真机看边缘是否发虚/幅面是否偏移；若异常，改走 `preserveAspectRatio` + 让 JSON 幅面匹配 canvas 物理尺寸 |
| 15 | **`wx.getWindowInfo` 的最低基础库版本** | 官方 canvas 文档示例直接用了它，但该 API 页未在本轮抓取范围内 | 查 `.../api/base/system/wx.getWindowInfo.html`；低版本降级到 `wx.getSystemInfoSync().pixelRatio` |

---

## 6. 依据 URL 汇总

### 微信官方文档（全部为 `developers.weixin.qq.com`）

| 主题 | URL |
|---|---|
| canvas 组件（Skyline 支持 / 1365 上限 / bug&tip） | https://developers.weixin.qq.com/miniprogram/dev/component/canvas.html |
| Canvas 画布指南（canvas 2d 初始化 / 帧动画 / createImage） | https://developers.weixin.qq.com/miniprogram/dev/framework/ability/canvas.html |
| Canvas 对象（getContext / createImage / requestAnimationFrame） | https://developers.weixin.qq.com/miniprogram/dev/api/canvas/Canvas.html |
| Skyline 概览 | https://developers.weixin.qq.com/miniprogram/dev/framework/runtime/skyline/introduction.html |
| **Skyline 基础组件支持表** | https://developers.weixin.qq.com/miniprogram/dev/framework/runtime/skyline/component.html |
| **Skyline WXSS 支持表**（filter / backdrop-filter / conic-gradient / will-change / em） | https://developers.weixin.qq.com/miniprogram/dev/framework/runtime/skyline/wxss.html |
| **Skyline 特性状态**（clip-path 规划中 / font-face woff 待发布） | https://developers.weixin.qq.com/miniprogram/dev/framework/runtime/skyline/status.html |
| Skyline worklet 动画 | https://developers.weixin.qq.com/miniprogram/dev/framework/runtime/skyline/worklet.html |
| Skyline 共享元素动画 | https://developers.weixin.qq.com/miniprogram/dev/framework/runtime/skyline/share-element.html |
| Skyline 迁移常见兼容问题（canvas 工具不能调试） | https://developers.weixin.qq.com/miniprogram/dev/framework/runtime/skyline/migration/compatibility.html |
| Skyline 更新日志（worklet 内存泄露/UAF 修复） | https://developers.weixin.qq.com/miniprogram/dev/framework/runtime/skyline/changelog.html |
| 动画（this.animate 仅 WebView / 动画事件） | https://developers.weixin.qq.com/miniprogram/dev/framework/view/animation.html |
| 获取界面上的节点信息 | https://developers.weixin.qq.com/miniprogram/dev/framework/view/selector.html |
| `wx.createAnimation` | https://developers.weixin.qq.com/miniprogram/dev/api/ui/animation/wx.createAnimation.html |
| `InnerAudioContext`（格式表 / 资源不自动释放） | https://developers.weixin.qq.com/miniprogram/dev/api/media/audio/InnerAudioContext.html |
| `wx.createInnerAudioContext`（useWebAudioImplement 2.19.0） | https://developers.weixin.qq.com/miniprogram/dev/api/media/audio/wx.createInnerAudioContext.html |
| `wx.createWebAudioContext`（2.19.0 / 插件不支持） | https://developers.weixin.qq.com/miniprogram/dev/api/media/audio/wx.createWebAudioContext.html |
| `wx.setInnerAudioOption`（不兼容 WebAudio） | https://developers.weixin.qq.com/miniprogram/dev/api/media/audio/wx.setInnerAudioOption.html |
| **音频指南（Android 最多 10 路，小游戏侧）** | https://developers.weixin.qq.com/minigame/dev/guide/base-ability/audio.html |
| `wx.loadFontFace`（scopes native / TTF-WOFF / 全局生效） | https://developers.weixin.qq.com/miniprogram/dev/api/ui/font/wx.loadFontFace.html |
| **分包（主包/单包 ≤ 2M，总 ≤ 30M）** | https://developers.weixin.qq.com/miniprogram/dev/framework/subpackages.html |
| **代码包体积优化（ZSTD 压缩 / 图片音频字体难压缩）** | https://developers.weixin.qq.com/miniprogram/dev/framework/performance/tips/start_optimizeA.html |
| 内存优化（unload 释放 / onMemoryWarning） | https://developers.weixin.qq.com/miniprogram/dev/framework/performance/tips/runtime_memory.html |
| FPS 面板 | https://developers.weixin.qq.com/miniprogram/dev/framework/performance/fps_panel.html |

### npm / 代码

| 主题 | URL |
|---|---|
| `lottie-miniprogram` npm | https://www.npmjs.com/package/lottie-miniprogram |
| `lottie-miniprogram` GitHub | https://github.com/wechat-miniprogram/lottie-miniprogram |
| **issue #46（渐变/滤镜结论 + 2026-05 回复）** | https://github.com/wechat-miniprogram/lottie-miniprogram/issues/46 |
| `lottie-web` GitHub | https://github.com/airbnb/lottie-web |
| **issue #2100（1.2MB → gzip 120KB）** | https://github.com/airbnb/lottie-web/issues/2100 |
| Lottie 官方体验代码片段（README 指向） | https://developers.weixin.qq.com/s/2TYvm9mJ75bF |

### 许可

| 主题 | URL |
|---|---|
| **Lottie Simple License 全文** | https://lottiefiles.com/page/license |
| **LottieFiles 商用政策（Free/Individual 禁止商用服务）** | https://help.lottiefiles.com/commercial-use-guide |
| Kenney Board Game Pack（CC0） | https://kenney.nl/assets/boardgame-pack |
| Kenney Playing Cards Pack（CC0） | https://kenney.nl/assets/playing-cards-pack |
| ambientCG 许可（CC0 1.0） | https://ambientcg.com/licenses |
| Poly Haven 许可（CC0） | https://polyhaven.com/license |
| OpenGameArt（混合许可） | https://opengameart.org/content/playing-cards-pack |
| 思源黑体（SIL OFL 1.1） | https://github.com/adobe-fonts/source-han-sans |
| SIL OFL 中文页 | https://software.sil.org/zh-CN/ofl/ |
| 阿里巴巴普惠体 | https://www.alibabafonts.com/ |

### 第三方（【社区】证据，非官方）

| 主题 | URL |
|---|---|
| **小程序用 lottie 的踩坑详解（rAF 竞速 / display 报错 / iOS 闪退）** | https://sugarat.top/technology/learn/mini-lottie.html |
| 同上（博客园镜像） | https://www.cnblogs.com/roseAT/p/18166286 |
| Lottie 体积与优化建议（5–20KB 典型 / UI <50KB） | https://www.linearity.io/blog/lottie-animation-guide |
| Galacean：lottie-web 在 Canvas 2D 下多实例难组合 | https://galacean.antgroup.com/engine/blog/lottie_runtime_implementation |
| 小程序 Lottie 实战（dpr 模糊 / CSS 改位置无效） | https://juejin.cn/post/7471463449458507826 |
| Figma Community UI Kits | https://www.figma.com/community/ui-kits |

---

## 附：本报告用到的可复现命令

```bash
# 1) lottie-miniprogram 包的客观状态
curl -s https://registry.npmjs.org/lottie-miniprogram \
  | python3 -c "import json,sys;d=json.load(sys.stdin);t=d['time'];print(d['dist-tags'], t['1.0.12'], t['modified'])"

# 2) 下载并看源码（§1.3 全部结论的来源）
curl -sLO https://registry.npmjs.org/lottie-miniprogram/-/lottie-miniprogram-1.0.12.tgz
tar xzf lottie-miniprogram-1.0.12.tgz && \
  cat package/src/adapter/index.js package/src/index.js package/README.md

# 3) 包内体积
ls -l package/miniprogram_dist/index.js

# 4) Lottie 样本体积与时长（§4.1 那张表）
mkdir -p /tmp/ls && cd /tmp/ls
for n in lights starfish ripple bacon adrock banner dalek; do
  curl -sLO "https://cdn.jsdelivr.net/npm/lottie-web@5.12.2/test/animations/$n.json"
done
python3 - <<'PY'
import json, glob, os

def total_layers(d):
    """顶层图层 + 每个 precomp 内部图层（这才是体积的真实驱动因素）"""
    n = len(d.get('layers') or [])
    for a in (d.get('assets') or []):
        if 'layers' in a:
            n += len(a['layers'])
    return n

for f in sorted(glob.glob('*.json')):
    d = json.load(open(f))
    fr, op = d['fr'], d['op']
    sec = (op - d.get('ip', 0)) / fr
    kb  = os.path.getsize(f) / 1024
    print(f"{f:14} {kb:8.1f}KB  {sec:6.2f}s  顶层{len(d.get('layers') or []):>3}  总{total_layers(d):>3}  {kb/sec:6.1f}KB/s")
PY

# 5) 本项目现状
du -sh miniprogram && du -sh miniprogram/images miniprogram/audio
```

---

> **最后一句**：这份报告里最"反常识"的一条是 ——
> **Lottie 在小程序里做不了模糊/发光/投影**（Canvas renderer 无 SVG filter），
> 而这恰恰是"看起来高级"最便宜的来源；同一个效果用 CSS `filter: blur()` 反而能做（单函数）。
> 所以在动手接 Lottie 之前，先把 §2.3 那张表读完 —— 它可能让整个方案不必要。
