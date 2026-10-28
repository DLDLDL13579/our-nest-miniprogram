# 手游大厂级「手感」数值规范

> 目标读者：本项目的实现者（人 / agent）。
> 定位：**可直接抄的数值规范**，不是科普。
> 每个数值都标了来源；查不到可靠来源的标了 **`经验值`**。
> 标注 `本项目实测` 的数字来自本仓库代码与音频文件的实测（**2026-10-28 14:55 前后快照**），可复现。
>
> ⚠️ **快照声明**：文中所有"现状"数字（曲线条数、行号、响度、`FEEDBACK` 参数）
> 都是上述时刻的实测值。代码在持续改动，行号会漂移 ——
> 引用时以**选择器名 / 函数名**为准（文里都给了），行号只作线索。
>
> 适用范围：酒桌小程序（大话骰 / 比大小 / 谁是卧底 / 梦幻金花 / 命运转盘），
> 5 个玩法的全部反馈动作。

---

## 0. 一页速查

| 问题 | 答案 |
|---|---|
| 入场用什么曲线 | **ease-out**，`cubic-bezier(0, 0, 0.2, 1)`（Material Deceleration） |
| 退场用什么曲线 | **ease-in**，`cubic-bezier(0.4, 0, 1, 1)`（Material Acceleration） |
| 时长分几级 | **100 / 200 / 300 / 400ms** 四级，超过 400ms 就嫌慢 |
| 移动端默认总时长 | **300ms**（大厂规范原值，不是"感觉差不多"） |
| hitstop 多长 | **40–80ms**（网页/移动端）；格斗游戏 6–8 帧 = 100–133ms |
| 屏幕震动幅度 | 三档：轻 2 / 中 6 / 重 12 rpx，配 0 / 0.25° / 0.5° 旋转 |
| 震动衰减 | 180–260ms，8–12Hz，2–3 个循环 |
| 音效比动画晚多少 | **+30ms**（落在冲击帧之后） |
| 震动比音效晚多少 | **+20ms**（触觉最快，最后到） |
| 音效响度分几层 | 4 层：环境 −22 / 轻 −17 / 中 −14 / 重 −8 dBFS |
| 微信能不能做 hitstop | 能，但**不是暂停动画**，是"拆两段 + delay"（见 §4.5） |
| 微信能不能做 3D 翻牌 | **不能赌**，用交叉淡入替代（见 §9） |

---

## 1. 三个必须先站稳的概念

### 1.1 game feel 到底是什么

Steve Swink《Game Feel: A Game Designer's Guide to Virtual Sensation》(2008) 的定义被行业沿用至今：

> "realtime control of virtual objects in a simulated space, with interactions emphasised by polish."
> —— [Wikipedia: Game feel](https://en.wikipedia.org/wiki/Game_feel)、[Liz England 书评](https://lizengland.com/blog/review-game-feel-by-steve-swink)

拆成三块，**顺序不能换**：实时控制 → 可预测的模拟空间 → polish（juice）。

这个顺序对项目的直接含义：

1. **点击必须先有响应，动画才有意义**。一个 300ms 的漂亮动效，如果排在 1.5 秒轮询之后，
   玩家感知到的是"卡了 1.8 秒然后闪了一下"。见 §8。
2. **juice 只能放大已经成立的东西**。骰盅流程（入盅→摇→扣→揭→滚）之所以对，
   是因为它复刻了现实里"看不见 → 揭晓"的因果；加再多粒子也替代不了。
3. polish 是**独立的、可独立调参的一层**。这个项目已经把它收敛进
   `miniprogram/utils/feedback.js` 的一张表 —— 这个做法本身就是大厂做法，本文沿用它。

### 1.2 juice 的两篇原始文献

| 文献 | 年份 | 提供了什么 | 链接 |
|---|---|---|---|
| **Juice it or lose it**（Martin Jonasson & Petri Purho） | 2012 | 一个灰块 Breakout，逐层加 squash / 粒子 / 拖尾 / 音效，直到"活了"。**"juice" 一词的行业源头** | [YouTube](https://www.youtube.com/watch?v=Fy0aCDmgnxg)、[源码](https://github.com/grapefrukt/juicy-breakout) |
| **The art of screenshake**（Jan Willem Nijman, Vlambeer） | 2013 | 约 30 条把 Nuclear Throne 变"暴力、即时"的技巧清单 | [YouTube](https://www.youtube.com/watch?v=AJdEqssNZ-U) |

关于 Vlambeer 那份"30 条清单"，**本文只引用可核实的条目**（演讲原文与他人的转述），
不凭印象补全 —— 补全会变成假的规范：

- **"More is more. If it looks good with a little screen shake, it'll probably look better with a lot."**
  —— 转引自 [Game feel on the web](https://valdemird.com/blog/game-feel-on-the-web)
- **震动分三个量级**（small / medium / large），**量级越大越会混进一点旋转**
  —— 同上。这条是"旋转"这件事唯一有据的来源："纯平移像 glitch，零点几度旋转才像受力"。
- **必须提供关闭选项**：演讲里明确说有人会晕，"don't put things in your game that hurt people"
  —— [演讲原文 32:21 起](https://www.youtube.com/watch?v=AJdEqssNZ-U)。
  这是本项目"我的 → 震动开关 / 静音开关"的产品依据，不是可选项。
- **别在刚做完时判断**：做完的人已经看不见问题（演讲 32:37 起）。→ 手感判据必须能自动化（§11）。

⚠️ **对"more is more"必须加一条本项目限定**：这句在**第一人称/横版动作**里成立，
因为镜头是"你"；在**酒桌游戏**里，镜头是"桌上的牌和盅"，抖屏幕＝抖整张桌子，
量级要整体降一档（见 §4.2 的三档数值，已经降过）。

### 1.3 打击感三要素

行业共识的三件套：**顿帧（hitstop） / 屏幕震动（screen shake） / 闪光或粒子**。
三者的分工不同，不能互相替代：

| 要素 | 传达的语义 | 缺了会怎样 | 时长量级 |
|---|---|---|---|
| hitstop | "这一下**撞上了**，而且很重" | 两个物体礼貌地互相穿过 | 40–133ms |
| screen shake | "力量**传到桌面/镜头**了" | 只有物体在动，世界没反应 | 180–300ms 衰减 |
| flash / 粒子 | "**能量散开了**" | 撞击是无声无光的，像贴图 | 80–200ms |

---

## 2. 缓动曲线规范

### 2.1 曲线的四个官方定义（直接抄）

Material Design 1 的《Duration & easing》给出的四条曲线，**同时给了 iOS / Android / CSS 三套控制点**，
是目前最可直接落地的一份对照表：

| 曲线 | 语义 | CSS | iOS `CAMediaTimingFunction` | Android |
|---|---|---|---|---|
| **Standard**（ease in out） | 屏内移动、尺寸/透明度变化 | `cubic-bezier(0.4, 0.0, 0.2, 1)` | `(0.4, 0.0, 0.2, 1.0)` | `FastOutSlowInInterpolator` |
| **Deceleration**（ease out） | **元素入场**：满速进入、慢慢停住 | `cubic-bezier(0.0, 0.0, 0.2, 1)` | `(0.0, 0.0, 0.2, 1.0)` | `LinearOutSlowInInterpolator` |
| **Acceleration**（ease in） | **元素退场**：起步慢、满速离开 | `cubic-bezier(0.4, 0, 1, 1)` | `(0.4, 0.0, 1.0, 1.0)` | `FastOutLinearInInterpolator` |
| **Sharp**（ease in out，对称） | 可能随时返回的退场 | `cubic-bezier(0.4, 0.0, 0.6, 1)` | — | — |

来源：[Material 1 · Duration & easing](https://m1.material.io/motion/duration-easing.html)（原文表格）

Material 3 换了更"现代"的一组，同样是官方值：

| Token | CSS | Android |
|---|---|---|
| `md.sys.motion.easing.standard` | `cubic-bezier(0.2, 0.0, 0, 1.0)` | `PathInterpolator(0.2f, 0f, 0f, 1f)` |
| `standard.decelerate` | `cubic-bezier(0, 0, 0, 1)` | `PathInterpolator(0f, 0f, 0f, 1f)` |
| `standard.accelerate` | `cubic-bezier(0.3, 0, 1, 1)` | `PathInterpolator(0.3f, 0f, 1f, 1f)` |

来源：[Material 3 · Easing and duration tokens](https://m3.material.io/styles/motion/easing-and-duration/tokens-specs)

**M1 和 M3 该用哪套？**
两套都"对"，但**不要混用**。本项目的建议：**用 M1 那套**，理由有三条：

1. M1 的 deceleration `(0,0,0.2,1)` 起步就是满速，入场冲击力更强 —— 酒桌游戏要的是"啪一下出现"；
2. M1 表格同时给了 iOS 控制点，将来要迁 iOS 原生或做 H5 不用重算；
3. 项目现状已经大量在用 `.22,1,.36,1`（近似 M1 deceleration 的更强版），改动面最小。

### 2.2 时长分级（这条最容易被做错）

**Material 1 移动端的具体数字**（原文）：

| 场景 | 时长 |
|---|---|
| 移动端过渡典型值 | **300ms** |
| 大型、复杂的全屏过渡 | **375ms** |
| **元素进入屏幕** | **225ms** |
| **元素离开屏幕** | **195ms** |
| 超过就不行的上限 | **> 400ms 会显得慢** |
| 平板 | 比手机 **+30%**（300ms → 390ms） |
| 可穿戴 | 比手机 **−30%**（300ms → 210ms） |
| 桌面 | **150–200ms** |

来源：[Material 1 · Duration & easing](https://m1.material.io/motion/duration-easing.html)

**Material 3 的 token 分级**（原文）：

| 分级 | Token | 值 |
|---|---|---|
| Short | `short1 / short2 / short3 / short4` | **50 / 100 / 150 / 200 ms** |
| Medium | `medium1 / medium2 / medium3 / medium4` | **250 / 300 / 350 / 400 ms** |

来源：[Material 3 · Easing and duration tokens](https://m3.material.io/styles/motion/easing-and-duration/tokens-specs)

→ **用户提到的"100 / 200 / 300ms 分级"，对应的正是 M3 的 short2 / short4 / medium2。**
本文的规范就锚在这三个值上，四是 400ms 封顶。

⚠️ **入场要比退场慢**（225 vs 195ms）。这条反直觉但重要：入场是"要看清是什么"，
退场是"已经知道了，快走"。本项目现状是**出入场同值**（大量 `.42s` / `.5s` 既是入也是出），
这是 §10 里建议修掉的一类。

### 2.3 iOS 的"damping / stiffness"

**没有官方的"iOS 系统动画数值表"** —— Apple 从未公布。可引用的是 API 默认值和官方示例：

| 来源 | 参数 | 值 |
|---|---|---|
| SwiftUI `.spring()` 默认值 | `response` / `dampingFraction` / `blendDuration` | **0.5 / 0.825 / 0** |
| SwiftUI `.interactiveSpring()` 默认值 | 同上 | **0.15 / 0.86 / 0.25** |
| 官方示例（`UIViewPropertyAnimator` + `UISpringTimingParameters`） | `damping` / `response` | **1 / 0.4**（无回弹的物件归位） |
| 官方示例（按钮按下回弹） | `damping` / `response` | **0.4 / 0.2**（有回弹） |
| 社区常用起点 | `stiffness` / `damping` | **170 / 15** |

来源：[Apple Developer · spring(response:dampingFraction:blendDuration:)](https://developer.apple.com/documentation/swiftui/animation/spring(response:dampingfraction:blendduration:))、
[WWDC18 Designing Fluid Interfaces](https://developer.apple.com/videos/play/wwdc2018/803)、
[nathangitter/fluid-interfaces](https://github.com/nathangitter/fluid-interfaces)、
[Spring 参数讲解](https://medium.com/@amosgyamfi/learning-swiftui-spring-animations-the-basics-and-beyond-4fb032212487)

Apple 在 WWDC18 里给的核心操作建议只有两句，比任何数值都重要：

> "Springs don't have to be springy. **Most animations should use a damping value of 1**（不回弹）."
> "Try to **avoid thinking about duration**."
> —— [nathangitter 对 WWDC18 的整理](https://medium.com/@nathangitter/building-fluid-interfaces-9732bb934bf5)

**这条对本项目的意义**：`damping = 1`（无回弹）是默认，**回弹是例外**。
现状里 7 处 `cubic-bezier(.2,.9,.3,1.18)` 和 5 处 `(.34,1.56,.64,1)` 都在回弹，
**回弹占比过高**（见 §3.4 的目标配额：回弹 ≤ 15%）。

#### Swift / CSS 换算（`经验值`，工程近似）

| Swift 意图 | 近似 CSS | 说明 |
|---|---|---|
| `damping = 1, response = 0.4` | `300ms cubic-bezier(0.22, 1, 0.36, 1)` | 无回弹、快进慢出 |
| `damping = 1, response = 0.2` | `180ms cubic-bezier(0.22, 1, 0.36, 1)` | 轻反馈 |
| `damping ≈ 0.8` | `300ms cubic-bezier(0.34, 1.2, 0.64, 1)` | 约 3% 回弹 |
| `damping ≈ 0.7` | `320ms cubic-bezier(0.34, 1.4, 0.64, 1)` | 约 6% 回弹 |
| `damping ≈ 0.5` | `340ms cubic-bezier(0.34, 1.56, 0.64, 1)` | 约 10% 回弹，明显弹 |

> 换算没有解析解（弹簧是微分方程，贝塞尔是多项式）。上表是**目视对齐**的经验映射，
> 不是数学等价。要真正的弹簧手感只能上 JS 物理，小程序里不划算。

### 2.4 曲线家族必须收敛（这条是"规范"和"没规范"的分界线）

**本项目现状实测**（`grep -rho "cubic-bezier([^)]*)" --include=*.wxss`）：

```
16 种互不相同的 cubic-bezier，共 42 处使用
  11 处  (.22,1,.36,1)       ← 事实上的主力，≈ ease-out-quint
   7 处  (.2,.9,.3,1.18)      ← 回弹
   5 处  (.34,1.56,.64,1)     ← 强回弹（≈ back-out(1.7)）
   3 处  (.22,1.3,.45,1)      ← 中回弹
   2 处  (.36,.07,.19,.97)    ← ≈ ease-in-out-expo，最"硬"
   2 处  (.22,1.45,.5,1)
   2 处  (.22,1.4,.5,1)
   2 处  (.2,.85,.3,1.05)
   1 处  × 8 种（.45,.05,.55,.95 / .3,1.5,.6,1 / .22,1.5,.5,1 /
                .22,1.2,.4,1 / .22,1.1,.4,1 / .18,.9,.3,1.16 /
                .16,1.3,.4,1 / .15,.62,.1,1）
另有 9 处裸 `ease`、9 处 `ease-out`、7 处 `ease-in`、7 处 `ease-in-out`、26 处 `linear`
```

**16 条曲线 = 没有手感规范。** 依据很直接：人眼对**同一动作族内部**的曲线差异不敏感，
但对**跨动作族的曲线不一致**极敏感（同一个"落下"在不同玩法里减速快慢不同，
玩家说不出哪里不对，只说"这个游戏有点廉价"）。

**过冲（回弹）统计**（解析每条的 `y1`/`y2` 控制点，可复现）：

| 分类 | 数量 | 占比 |
|---|---:|---:|
| 有过冲（`y1 > 1` 或 `y2 > 1`） | **27 / 42** | **64%** |
| 其中强过冲（`≥ 1.3`，明显"弹"） | **15 / 42** | **36%** |
| 无过冲（纯减速） | 15 / 42 | 36% |

另有：**10 处裸 `ease`**（`animation` 简写 5 处 + `transition` 5 处）、
**9 处 `ease-out`**、**7 处 `ease-in-out`**（`ease-in` 单独使用 **0** 处）、
`linear` 作为缓动只用在 **2 个**无限循环动画上（`rollingShake` / `suspenseTense`）。

→ **规范：全项目只允许 6 条曲线**，命名固定，不许新增：

```css
/* ========== 曲线家族（全项目只准用这 6 个，其它一律删） ========== */

/* C1 · 入场：满速冲进来，慢慢停住 —— 所有"出现/落定/揭晓" */
--ease-in-ui:   cubic-bezier(0, 0, 0.2, 1);

/* C2 · 退场：慢慢起步，冲出去 —— 所有"消失/收起/离开" */
--ease-out-ui:  cubic-bezier(0.4, 0, 1, 1);

/* C3 · 屏内移动：加速再减速，对称 —— 位置迁移、尺寸变化、进度条 */
--ease-std:     cubic-bezier(0.4, 0, 0.2, 1);

/* C4 · 撞击：起步几乎不动然后猛停 —— 扣盅、砸桌、重击的位移段 */
--ease-impact:  cubic-bezier(0.36, 0.07, 0.19, 0.97);

/* C5 · 轻回弹：约 3% 过冲 —— 抽到奖励、按钮弹起（每屏最多 1 处） */
--ease-bounce-s: cubic-bezier(0.34, 1.2, 0.64, 1);

/* C6 · 强回弹：约 10% 过冲 —— 只给"赢得整局"这一级别（一局最多 1 次） */
--ease-bounce-l: cubic-bezier(0.34, 1.56, 0.64, 1);

/* 线性：只给"匀速"语义（转盘转动、进度、循环呼吸） */
--ease-linear:  linear;
```

> ⚠️ **WXSS 是否支持 CSS 自定义属性 `--var`**：WebView 渲染引擎下可用（等同浏览器），
> 但 **Skyline 的支持面需要实测**。若官方支持表里没有，就把上面 6 个值写成注释常量，
> 在每个 `animation` 里字面量引用 —— **宁可重复字面量，不要赌渲染引擎**。
> 这条属于 `⚠️待实测`，落地前必须在真机 + `wx.getDeviceInfo()` 判定的渲染引擎上各跑一遍。

### 2.5 回弹配额（比曲线本身更重要）

| 级别 | 每屏允许回弹次数 | 用哪条 |
|---|---|---|
| 轻反馈 | **0** | C1 / C3 |
| 中反馈 | 0（可用 3% 的 C5，每屏累计 ≤ 2 次） | C1 / C5 |
| 重反馈 | ≤ 1 | C1 + C4，收尾可用 C6 |
| 整局结算 | ≤ 1 | C6 |

理由：回弹是"惊喜"的视觉语法。**惊喜不能每 300ms 发生一次**，
否则它就不再是惊喜，而是"这个 App 老是抖一下"。

---

## 3. ★ 可直接抄的 CSS 缓动曲线与时长表

> 这一节就是交付物本身。左侧是语义，右侧是可以直接粘进 wxss 的值。
> 所有时长按 Material 的 100 / 200 / 300 / 400 四档取，不发明第五档。

### 3.1 时长常量表

| 名称 | 值 | 用途 | 出处 |
|---|---|---|---|
| `T-INSTANT` | **0ms** | 按下态变色、点击态阴影（不给动画） | `经验值` |
| `T-TAP` | **100ms** | 按钮按压回弹、勾选、开关 | M3 `short2` |
| `T-MICRO` | **150ms** | 数字跳动、角标出现、轻提示 | M3 `short3` |
| `T-SMALL` | **200ms** | 单张牌翻面、单颗骰子落定、列表项入场 | M3 `short4` |
| `T-MED` | **300ms** | 面板弹出、卡组展开、视图切换（**移动端默认值**） | M1 移动端典型值 / M3 `medium2` |
| `T-LARGE` | **400ms** | 全屏结算、玩法切换（**上限**） | M1 ">400ms 嫌慢" / M3 `medium4` |
| `T-SCENE` | **600–750ms** | 只给"整段演出"：摇盅 1050ms、扣盅 380ms 等 | `经验值`，本项目既有节奏 |

**硬规则：单个元素的动画不超过 400ms。** 超过 400ms 的只能是"多段演出的总时长"，
且中间必须有反馈（音效 / 震动 / 中间帧），不能是一段连续等待。
出处：Material 1 原文 "Transitions that exceed 400ms may feel too slow."

### 3.2 入场 / 屏内 / 退场 三条主曲线（配时长）

```css
/* ---------- 入场（出现）：C1 + 200~300ms ---------- */
/* 为什么入场用 ease-out：元素"满速进入、慢慢停住"，才像被扔进来 */
.anim-enter {
  animation: enterUp 260ms cubic-bezier(0, 0, 0.2, 1) backwards;
}
@keyframes enterUp {
  from { opacity: 0; transform: translateY(12rpx) scale(0.96); }
  to   { opacity: 1; transform: translateY(0)     scale(1); }
}

/* ---------- 屏内移动 / 状态切换：C3 + 200~300ms ---------- */
.anim-move {
  transition: transform 240ms cubic-bezier(0.4, 0, 0.2, 1),
              opacity   200ms cubic-bezier(0.4, 0, 0.2, 1);
}

/* ---------- 退场（消失）：C2 + 150~200ms ---------- */
/* 退场比入场快 20~30ms：已经知道是什么了，别拖 */
.anim-exit {
  animation: exitDown 180ms cubic-bezier(0.4, 0, 1, 1) forwards;
}
@keyframes exitDown {
  from { opacity: 1; transform: translateY(0)     scale(1); }
  to   { opacity: 0; transform: translateY(-8rpx) scale(0.98); }
}
```

### 3.3 三档反馈的完整配方（缩放 / 位移 / 旋转 / 阴影）

```css
/* ============================================================
   轻反馈 · 点击 / 选择 / 逐颗落定
   语义：「收到了」。不打断，不改布局，不解释。
   ============================================================ */
.fx-light-down {                       /* 按下：立即，0ms */
  transform: scale(0.965);
  transition: transform 0ms;
}
.fx-light-up {                         /* 松开：100ms 回弹，无过冲 */
  transform: scale(1);
  transition: transform 100ms cubic-bezier(0, 0, 0.2, 1);
}
@keyframes lightSettle {               /* 骰子/筹码单颗落定 */
  0%   { transform: translateY(-10rpx) scale(1.04); }
  60%  { transform: translateY(0)      scale(0.985); }
  100% { transform: translateY(0)      scale(1); }
}
.fx-light-settle { animation: lightSettle 200ms cubic-bezier(0.4, 0, 0.2, 1) both; }

/* ============================================================
   中反馈 · 落定 / 切换 / 翻牌 / 投票结果
   语义：「这件事定了，看这里」。
   ============================================================ */
@keyframes medSettle {
  0%   { transform: scale(1.10) rotate(-1.5deg); opacity: 0; }
  55%  { transform: scale(0.99) rotate(0.4deg);  opacity: 1; }
  100% { transform: scale(1)    rotate(0deg);    opacity: 1; }
}
.fx-med { animation: medSettle 260ms cubic-bezier(0.22, 1, 0.36, 1) both; }

/* 卡牌翻开：不用 3D rotateY（见 §9 硬限制），用"交叉淡入 + 轻转" */
@keyframes cardReveal {
  0%   { transform: scale(0.92) rotate(-2.5deg); opacity: 0.4; }
  100% { transform: scale(1)    rotate(0deg);    opacity: 1; }
}
.fx-card-reveal { animation: cardReveal 220ms cubic-bezier(0.22, 1, 0.36, 1) both; }

/* ============================================================
   重反馈 · 开盅 / 结算 / 惩罚 / 摊牌
   语义：「发生了大事」。允许抢注意力。
   ============================================================ */
/* 冲击段：先"砸住"，停住（这就是 hitstop 的视觉替代，见 §4.5） */
@keyframes heavyImpact {
  0%   { transform: scale(1.28) translateY(-18rpx); opacity: 0; }
  38%  { transform: scale(1.06) translateY(0);      opacity: 1; }   /* ← 冲击帧 */
  100% { transform: scale(1)    translateY(0);      opacity: 1; }
}
.fx-heavy { animation: heavyImpact 380ms cubic-bezier(0.36, 0.07, 0.19, 0.97) both; }

/* 场景震动（抖"桌子"，不抖视口）—— 三档 */
@keyframes shakeS {
  0%,100% { transform: translate(0, 0)     rotate(0deg); }
  25%     { transform: translate(2rpx,-2rpx) rotate(0deg); }
  50%     { transform: translate(-2rpx,1rpx) rotate(0deg); }
  75%     { transform: translate(1rpx, 2rpx) rotate(0deg); }
}
@keyframes shakeM {
  0%,100% { transform: translate(0,0)       rotate(0deg); }
  20%     { transform: translate(6rpx,-5rpx) rotate(0.25deg); }
  40%     { transform: translate(-5rpx,4rpx) rotate(-0.2deg); }
  60%     { transform: translate(4rpx, 3rpx) rotate(0.15deg); }
  80%     { transform: translate(-2rpx,-2rpx) rotate(-0.1deg); }
}
@keyframes shakeL {
  0%,100% { transform: translate(0,0)        rotate(0deg); }
  15%     { transform: translate(12rpx,-10rpx) rotate(0.5deg); }
  30%     { transform: translate(-10rpx,8rpx)  rotate(-0.4deg); }
  45%     { transform: translate(8rpx, 6rpx)   rotate(0.3deg); }
  60%     { transform: translate(-6rpx,-5rpx)  rotate(-0.2deg); }
  80%     { transform: translate(3rpx, 2rpx)   rotate(0.1deg); }
}
.fx-shake-s { animation: shakeS 180ms cubic-bezier(0.36,0.07,0.19,0.97) both; }
.fx-shake-m { animation: shakeM 220ms cubic-bezier(0.36,0.07,0.19,0.97) both; }
.fx-shake-l { animation: shakeL 260ms cubic-bezier(0.36,0.07,0.19,0.97) both; }

/* 闪白（比粒子便宜 10 倍，小程序里首选） */
@keyframes flashWhite {
  0%   { opacity: 0; }
  12%  { opacity: 0.55; }
  100% { opacity: 0; }
}
.fx-flash { animation: flashWhite 140ms cubic-bezier(0.4,0,0.2,1) both;
            background: #fff; pointer-events: none; }
```

### 3.4 曲线配额检查（可以写成断言）

| 判据 | 阈值 | 现状 |
|---|---|---|
| `cubic-bezier` 去重后的种类数 | **≤ 6** | 16 ❌ |
| 裸 `ease` 使用次数 | **0**（必须显式） | 9 ❌ |
| 回弹曲线（过冲 > 0）占比 | **≤ 15%** | **64%（27/42）** ❌，其中强回弹 36% |
| 单个元素 `animation` 时长 | **≤ 400ms** | 有 `.5s` `.62s` `.82s` ⚠️（演出一类的可豁免，需逐个标注） |
| 入场时长 vs 退场时长 | 入场 > 退场 | 未区分 ❌ |

> 这几条都可以直接写成 `scripts/check.sh` 里的正则断言。
> 注意 AGENTS.md 记过的教训：**判据不能用"改名法"反向验证**，
> 要整条删除样式规则后确认断言真的报错。

---

## 4. 打击感三要素的具体数值

### 4.1 hitstop（顿帧）时长区间

**权威数据（格斗游戏，60fps 为基准）**：

| 来源 | 数值 | 换算 |
|---|---|---|
| Capcom 官方《SF Seminar》第 11 讲 | 示例用 **8 frames**；并说明"轻/中/重 8F/12F/16F"这种体系很常见 | 8F = **133ms**，12F = 200ms，16F = 267ms |
| 同上（多段攻击） | 多段命中会**缩短** hitstop，避免节奏碎掉 | — |
| [Shane Sicienski 逐帧分析 Capcom 横版](https://shane-sicienski.com/blog/blog-post-title-one-55pmn) | 攻击方 **6F**、受击方 **8F**；受击方晚 1–2 帧开始 | 6F = 100ms |
| 同上（Captain Commando） | 全局统一 **8F** | 133ms |
| [valdemird（网页实现）](https://valdemird.com/blog/game-feel-on-the-web) | "破坏性确认（删除、答错）**60–80ms** 足够" | 60–80ms |
| [egmatic（设计总结）](https://egmatic.com/blog/how-to-make-your-game-feel-good) | "**40–80ms** 比任何动画都更能卖出重量" | 40–80ms |

来源：[Capcom SF Seminar Hour 11](https://game.capcom.com/cfn/sfv/column/131545?lang=en)

**规范（本项目）**：

| 事件类型 | hitstop | 依据 |
|---|---|---|
| 逐颗骰子落定 | **0ms** | 一局十几颗，每颗都顿会让节奏卡成幻灯片 |
| 单张牌翻开 | **0ms** | 翻牌是"轻"，顿帧会显得像卡了 |
| 投票落定 / 叫骰确认 | **0ms** | 同上 |
| **摊牌 / 比牌结果** | **60ms** | valdemird 的 60–80 区间下沿 |
| **开盅揭晓** | **70ms** | 同上，略长因为信息量更大 |
| **惩罚（喝酒）落地** | **80ms** | 区间上沿，"重" |
| 整局结算 | **0ms** | 之后接撒花演出，顿帧会打断情绪 |

**不要用格斗游戏的 100–133ms**：那是 60fps 实时对战的节奏，玩家在等下一帧确认；
酒桌游戏是"看一眼然后抬头聊天"，顿 130ms 只会被感知成"卡了一下"。

### 4.2 screen shake：幅度 / 频率 / 衰减

**来源与数值**：

| 参数 | 值 | 出处 |
|---|---|---|
| 量级数量 | **3 档**（small / medium / large） | Vlambeer 演讲 |
| 旋转 | 中/大档**混入零点几度旋转**；纯平移像 glitch | [valdemird](https://valdemird.com/blog/game-feel-on-the-web) |
| 衰减时长（Unity Cinemachine 默认） | **0.7s**，其中 sustain 0.2s、attack 0 | [Cinemachine Impulse 文档](https://docs.unity3d.com/Packages/com.unity.cinemachine@2.2/manual/CinemachineImpulseSource.html) |
| 实战参数（从业者） | amplitude gain **0.2**、frequency gain **0.5** 已是上限 | [Cinemachine Impulse 实战讲解](https://www.youtube.com/watch?v=xldh2lS8atY) |
| trauma 模型 | 位移 = 噪声 × trauma²，trauma 每帧衰减 | [Godot game feel checklist](https://forum.godotengine.org/t/game-feel-checklist-for-godot-4-hit-stop-trauma-shake-coyote-time-and-more/145340) |
| 必须能关 | 有人会晕 | Vlambeer 演讲 |

**规范（本项目，已按"抖桌子不抖视口"降档）**：

| 档 | 位移峰值 | 旋转峰值 | 时长 | 频率 | 触发 |
|---|---|---|---|---|---|
| S | **2 rpx** | **0°** | 180ms | ~10Hz | 单颗骰子落定、筹码落下、卡牌拍桌 |
| M | **6 rpx** | **0.25°** | 220ms | ~9Hz | 扣盅、投票出局、比牌摊开 |
| L | **12 rpx** | **0.5°** | 260ms | ~8Hz | 开盅揭晓、惩罚、整局结算 |

**四条实现铁律**：

1. **抖容器，不抖 `page`**。给"牌桌场景"那个容器 `view` 加 class，不要给 `page` 或 `body`。
   ⚠️ **代价必须一起认**：带 `transform` 的元素会成为 `position: fixed` 子元素的**包含块** ——
   遮罩/弹层如果放在这个容器里面，就不再铺满视口，页面滚动时还会跟着滚。
   本项目已经踩过（`room.wxml` 顶部注释："loading 幕必须放在 `.gamepage` **外面**"）。
   → **规则：抖动容器内的 `fixed` 子元素一律移出容器。**
2. **不要用 `translate` 的随机值写 `innerHTML`**，用 `@keyframes` 固定 4–6 个关键帧。
   随机值每次都要 `setData`，而 `setData` 是跨线程拷贝（见 §9）。
3. **衰减靠关键帧的幅度递减，不靠 JS 计时器**。
4. **同一时刻只允许 1 个 shake 动画**。3 颗骰子连续落定时，第 2、3 颗**不再抖**，
   只出声 + 闪光。否则三档叠起来 = 持续抖动 = 晕。

**本项目现状（`本项目实测`）**：已经有**一档**打击震动，机制是"加 class → 320ms 后移除"：

```css
/* room.wxss:714-715 —— 抖动作用在 .gamepage 这个容器上，不是 page */
.gamepage.impact { animation: roomImpact .34s cubic-bezier(.36,.07,.19,.97); }
@keyframes roomImpact {
  0%,100% { transform: translate(0,0) }
  10%     { transform: translate(-9rpx, 6rpx) rotate(-.45deg) }
  26%     { transform: translate(8rpx,-6rpx) rotate(.45deg) }
  42%     { transform: translate(-6rpx,-4rpx) rotate(-.28deg) }
  60%     { transform: translate(4rpx, 5rpx) rotate(.22deg) }
  78%     { transform: translate(-2rpx, 3rpx) }
}
```

```js
// room.js:1761
bump() {                                   // 调用方：关键结果
  this.setData({ impact: true })
  if (this._bumpTimer) clearTimeout(this._bumpTimer)
  this._bumpTimer = setTimeout(() => this.setData({ impact: false }), 320)
}
```

对照本文规范，**幅度（±9rpx / 0.45° / 340ms）大概落在 M 与 L 之间，是对的**。
缺的是**三档分级**：现在"逐颗骰子落定"和"开盅揭晓"用的是同一个量级，
最重要的那一下和次要的那一下一样重 —— 这等于没有层次。

另外项目里还有**两个"连续晃动"**，它们和打击震动是**不同的东西**，不能混为一谈：

| class | 关键帧 | 参数 | 语义 | 判断 |
|---|---|---|---|---|
| `.gamepage.rolling` | `rollingShake` | ±4rpx / ±0.3° / **180ms 无限循环** | "盅在摇" | ✅ 正确：物体在动，所以画面在动 |
| `.gamepage.suspense` | `suspenseTense` | 100ms 无限循环 | "开骰前的紧张" | ⚠️ 见下 |

**规则：连续晃动只允许挂在"物体正在运动"的语义上（摇盅、转盘转动）。**
挂在"等待"语义上（`suspense` = 等结果）会让玩家觉得**手机在抖**而不是**事情在发生**，
而且 100ms 循环 = 10Hz，正好落在最容易让人不适的频段。
建议 `suspenseTense` 改成**低频呼吸**（`scale` 1↔1.01，2s `ease-in-out`），
不位移、不旋转 —— 呼吸是"还在进行"，抖动是"出故障"。

> ⚠️ 还有一个**隐式**规则需要显式化：`bump()` 是 `setData({impact:true})`。
> 如果 320ms 内被调用第二次，值**没变**（true → true）→ 视图层 diff 无变化 →
> **动画不会重播**。所以现在"连续落定只震一次"是**副作用**，不是设计。
> 建议保留这个行为（它符合铁律 4），但要写成显式判据，
> 否则下一个人为了"每颗骰子都震"改成 `true → false → true`，
> 就会立刻变成"整局持续抖动"。

> ⚠️ 关于 Vlambeer 的"more is more"：本项目**不采用**。理由见 §1.2 末。
> 这条明确写在规范里，是为了防止下一个实现者"照大厂做"反而做坏。

### 4.3 闪光 / 粒子

| 手法 | 成本 | 小程序可行性 | 建议 |
|---|---|---|---|
| **整层闪白**（`opacity` 0→0.55→0） | 极低（1 个元素） | ✅ 稳 | **首选**，140ms |
| 径向光晕图（PNG + `scale` + `opacity`） | 低 | ✅ 稳 | 次选，开盅用 |
| DOM/CSS 粒子（十几个 `view`） | 中 | ✅ 可行但要注意节点数 | 撒花 / 结算，≤ 20 个 |
| Canvas 粒子 | 中高 | ✅ 但要自己写循环 | 本项目**不需要** |
| 滤镜发光 `filter: drop-shadow` | — | ⚠️ Skyline 下"不支持 multi function / 部分表现不一致" | **不用** |

来源（Skyline 滤镜限制）：[Skyline WXSS 样式支持与差异](https://developers.weixin.qq.com/miniprogram/dev/framework/runtime/skyline/wxss.html)

**粒子实现要点**（来自 [valdemird](https://valdemird.com/blog/game-feel-on-the-web) 的实战经验，直接可用）：

- 角度**先均匀分布**（`2π · i / count`）**再加随机抖动**；
  纯 `Math.random()` 会"成团 + 留空"；
- 每个粒子的距离 `spread × (0.45 + rand × 0.55)`，寿命 `0.55 + rand × 0.4` s；
- 用 `animationend` 自我清理，不要留定时器（本项目已经栽过"裸 setTimeout 清不掉"）。

### 4.4 三要素的搭配矩阵（别乱加）

| 场景 | hitstop | shake | flash/粒子 | 说明 |
|---|---|---|---|---|
| 点击按钮 | ✗ | ✗ | ✗ | 只缩放 + 音效 |
| 单颗骰子落定 | ✗ | S | ✗ | 一局多次，最省 |
| 骰子全部落定 | ✗ | S | ✓ 小光晕 | |
| 扣盅 | ✗ | M | ✗ | 视觉是"砸住"，靠 `scale` 冲击帧 |
| **开盅揭晓** | **70ms** | **L** | **✓ 闪白 + 光晕** | 全场焦点 |
| 转盘停稳 | ✗ | M | ✓ 小光晕 | |
| 摊牌比牌 | **60ms** | M | ✓ 闪白 | |
| 惩罚（喝酒） | **80ms** | L | ✓ 下坠 + 暗红 | |
| 赢 / 撒花 | ✗ | L | ✓ 粒子 | 不顿帧，别打断情绪 |

### 4.5 ⚠️ 小程序里怎么做 hitstop（重要）

**CSS `animation` 在小程序里"暂停—恢复"不可靠**：
`animation-play-state` 在 WebView 下按浏览器行为可用，但 Skyline 支持面未确认，
且**在 `wx:for` 重建节点时整个动画会重播**（本项目实测过，见 §9）。

→ **不要写 `animation-play-state: paused` 再恢复。** 用"拆两段 + delay"：

```css
/* 把一次 380ms 的冲击拆成：前段 70ms 到冲击帧 → 静止 hold → 后段 剩余 */
@keyframes heavyImpactHold {
  0%   { transform: scale(1.28) translateY(-18rpx); opacity: 0; }
  18%  { transform: scale(1.06) translateY(0);      opacity: 1; }   /* 0-70ms：冲进来 */
  36%  { transform: scale(1.06) translateY(0);      opacity: 1; }   /* 70-140ms：hold = hitstop */
  100% { transform: scale(1)    translateY(0);      opacity: 1; }   /* 140-380ms：回位 */
}
.fx-heavy-hold { animation: heavyImpactHold 380ms linear both; }
```

**为什么这样等于 hitstop**：关键帧在 70–140ms 之间**数值完全不变**，
渲染结果就是一帧不动 —— 和"暂停动画"的视觉结果相同，但**只依赖最基础的关键帧能力**，
不存在引擎差异。代价是时长要预先算进总时长里（380 里含 70 的 hold）。

**另一个可用手法**：hitstop 期间叠一个 40ms 的**白闪**。
白闪会盖住"停住"这件事，让停帧读起来像"撞击的爆点"而不是"卡了"。
这是移动端比格斗游戏更需要的一招 —— 手机屏幕小，纯停帧容易被读成掉帧。

---

## 5. 三通道时序补偿（视觉 / 听觉 / 触觉）

### 5.1 为什么必须错开

三个通道的**感知延迟不同**，同时触发的结果是"先震、再响、最后看见"，
听感上像抢拍。可靠的数据：

| 通道 | 阈值 | 出处 |
|---|---|---|
| **触觉** | 延迟 **< 30–50ms** 会被感知为"瞬时"；**> 100ms 会降低任务表现**；**> 180–200ms 时手指已经离开屏幕**，反馈会落到错误的对象上 | [Immersion Corp《UX Impacts of Haptic Latency》](https://www.immersion.com/wp-content/uploads/2015/10/ux-impact_haptic-latency-in-auto_jul13v1.pdf) |
| 视觉 | 视知觉阈值约 **20–30ms** | [同类汇总](https://eureka.patsnap.com/article/haptic-feedback-latency-why-1ms-delay-is-required-for-realism) |
| 音画同步 | 唇音同步可察觉偏差 **20–40ms**；广播可接受范围 **−125ms ~ +45ms**（ITU-R BT.1359） | [TestDevLab](https://www.testdevlab.com/blog/how-to-test-audio-video-sync)、[arXiv 2212.01686](https://arxiv.org/html/2212.01686v1) |

> ⚠️ 本项目 `feedback.js` 注释里写的"听觉约 13ms、视觉约 50ms"，
> **在公开文献里没有直接对应的单一出处**（不同研究测的是不同任务：检测 vs 识别 vs 反应）。
> 但**结论方向是对的**（触觉最快、视觉最慢），且被 Immersion 的 30–50ms 触觉阈值支持。
> 建议在该注释里加一句"数量级为工程近似，非精确生理常数"，避免被当成硬数据引用。

### 5.2 补偿公式（唯一出口）

```
sfxDelay    = impactAt + 30      // 音效晚于冲击帧 30ms
hapticDelay = impactAt + 50      // 震动再晚 20ms（= sfxDelay + 20）
```

**为什么是 +30 / +20**：
- 视觉在冲击帧"到"了之后，声音晚 30ms 仍在"同一事件"的感知窗口内（< 100ms），
  但已经足够让大脑把它归因为"这次撞击发出的声音"，而不是"另一个事件"；
- 触觉再晚 20ms，是为了让震动的**起振**落在音效的**起振**之后 —— 触觉通道最快，
  如果同时发，触觉会先到（提前约 20–30ms），反而像"先震了一下，然后才有声音"。
- 总偏移 **+50ms 远低于 100ms 的可察觉不同步阈值**（Immersion 报告），所以安全。

⚠️ 这个公式是**本项目的工程结论**（`经验值` + 现有实现验证），
不是任何一篇论文的原值。它可被"三次盲测：同时触发 vs 错开触发，玩家选哪个"验证 ——
建议在真机上做一次，而不是永久相信。

### 5.3 现状校验（`本项目实测`）

从 `miniprogram/utils/feedback.js` 的 `FEEDBACK` 表逐条验算：

| key | impactAt | 期望 sfxDelay (+30) | 实际 | 期望 hapticDelay (+50) | 实际 | 结论 |
|---|---|---|---|---|---|---|
| diceSettle | 60 | 90 | **90** | 110 | **110** | ✅ |
| cupOpen | 70 | 100 | 110 | 120 | **130** | ⚠️ +10 偏差 |
| wheelStop | 50 | 80 | 90 | 100 | 110 | ⚠️ +10 |
| luckyHit | 60 | 90 | 100 | 110 | 120 | ⚠️ +10 |
| penalized | 60 | 90 | 100 | 110 | 120 | ⚠️ +10 |
| cupSlam | 70 | 100 | 110 | 120 | **130** | ⚠️ +10 |
| uwVote | 40 | 70 | **70** | 90 | **90** | ✅ |
| uwReveal | 120 | 150 | **150** | 170 | **170** | ✅ |
| pkFlip | 30 | 60 | **60** | 80 | **80** | ✅ |
| pkSpread | 80 | 110 | **110** | 130 | **130** | ✅ |
| diceIn | 40 | 70 | 40 | 90 | 70 | ❌ 未走公式（音效=冲击帧） |
| diceTable | 0 | 30 | 0 | 50 | 40 | ❌ 未走公式 |
| tumble / cupShake / shaker | 0 | 0 | 0 | — | 60 | 连续音，不适用（正确） |
| cupLift | 0 | 30 | 20 | — | null | 轻，可接受 |
| becomeHost / win / lose | 0 | 30 | 0 | 50 | 20 | ⚠️ `animMs: 0`，没有动画对齐点 |
| countdownTick / countdownGo | 0 | 30 | 0 | 50 | 20 | ⚠️ 每 750ms/500ms 一次，不震更好 |

**结论 1（可落地的改进）**：现在 `sfxDelay` / `hapticDelay` 是**手写常量**，
所以会漂移。逐条点数（`impactAt > 0` 的共 **11 条**）：

- **5 条**精确贴合 `impactAt + 30`：`diceSettle` `uwVote` `uwReveal` `pkFlip` `pkSpread`
- **5 条**偏 **+10ms**：`cupOpen` `wheelStop` `luckyHit` `penalized` `cupSlam`
- **1 条**偏移为 **0**（音效与冲击帧同时）：`diceIn`

另有一条 `impactAt = 0` 的 `diceTable` 给了 `sfxDelay 0 / hapticDelay 40` —— 也没走公式。

**改法：把它们改成派生字段** —— 表里只写 `impactAt`，`fire()` 里算
`impactAt + 30` / `impactAt + 50`。这样"公式"变成**一个出口**，人手改不出漂移。

> 这正是 AGENTS.md 反复记的那个病："派生字段有 N 个出口 → 迟早不同步"。
> `stage` 曾经手写死导致"转盘无法转"，`options` 曾经被 `setData` 抹掉导致"点击叫骰没反应"。
> 同一个病，换成延时数字，症状是"某几个动作听起来抢拍"。

**结论 2**：`win` / `lose` / `becomeHost` 的 `animMs: 0` ——
**没有视觉对齐点却有音效和震动**，等于"听见声音但没看见东西发生"。
这三个要么补上动画（推荐：`win` 用撒花 600ms、`lose` 用 360ms 下坠），
要么把 `impactAt` 显式设为 0 并在注释里写明"纯听觉提示"。

**结论 3**：`countdownTick` 750ms 一跳、`countdownGo` 一次 —— 读秒**不该震动**。
每 750ms 震一次的观感是"手机在报警"。建议 `countdownTick.haptic = null`，
只在 `countdownGo` 保留 `heavy`（现状已是 heavy，✓）。

---

## 6. ★ 音效分层响度表

### 6.1 行业基线

Audiokinetic（Wwise 官方）给的分轨电平基准（原文）：

| 分轨 | 目标 |
|---|---|
| Music | **−16 dB** |
| Ambience | **−16 dB** |
| Dialogue | **−12 dB** |
| In-game SFX | **−16 dB** |
| UI | **−16 dB** |
| **所有轨的峰值** | **< −3 dB** |

来源：[Audiokinetic · Loudness Processing Best Practice (Ch.3)](https://www.audiokinetic.com/en/community/blog/loudness-processing-best-practice-chapter-3-scalable-loudness-processing-for-games)

配套的测量标准：**EBU R128 / ITU-R BS.1770**（−23 LUFS 为广播基准，
电视/游戏的可接受响度范围 5–10 LU），见
[EBU R128 讨论](https://designingsound.org/2013/02/20/different-loudness-ranges-for-console-and-mobile-games)。

⚠️ **这组数字不能直接照抄到本项目**，原因有三：

1. 它们是**多轨同时播放**的混音基线。本项目绝大多数时刻**只有一个音在响**，
   没有"被别的轨盖住"的问题，绝对电平可以整体更接近满刻度。
2. 它们描述的是**长时间平均响度**（积分 LUFS）。而游戏音效大多是 100–500ms 的一次性事件，
   积分 LUFS 对它们没有定义（BS.1770 最短是 400ms 门控块）。
3. 手机外放 + 嘈杂酒桌，动态余量本来就不该留太多。

→ **本项目的做法**：保留"分层的相对关系"，不用它的绝对值。见 §6.3。

### 6.2 本项目 35 个音效的实测响度（`本项目实测`）

> 文件总数 **35**（`ls miniprogram/audio/*.wav | wc -l`），下表 **31 行**覆盖全部
> （`combo-1..4` 合一行、`toggle-on/off` 合一行）。
> 其中 **1 个是死文件**：`wheel-slow.wav` 不在 `sfx.js` 的 `FILES` 清单里
> （全仓代码无引用，只有 `gen-audio.py` 生成它、`.tooling/verify-game.js` 列出它）。
> 它 34 KB，占音频目录 672 KB 的 5% —— 建议删掉，顺手减包体积。

测量方法（可复现，见附录 A）：

- 指标 **ST100** = 滑动 100ms 窗口的**最大 RMS**，单位 dBFS。
  比全局 RMS 更接近"耳朵听到的响"（全局 RMS 会把"尖峰 + 长静音"判得很轻）；
- 指标 **RMS** = 全文件 RMS（dBFS）；**peak** = 样本峰值（dBFS）；
- **DC** = 直流偏置（应 ≈ 0，本项目已修到 ±1e-5）。

| 文件 | 时长 | ST100 | RMS | peak | 归层 |
|---|---:|---:|---:|---:|---|
| `wheel-start.wav` | 300ms | **−9.9** | −13.0 | −4.5 | 🔴 过响（中档应 −14） |
| `combo-1..4.wav` | 280ms | **−9.9** | −14.0 | −1.4 | 🔴 过响（连击属中档） |
| `fail-drop.wav` | 929ms | **−7.1** | −13.5 | −0.9 | 🟠 重档上沿（目标 −8） |
| `wheel-stop.wav` | 739ms | **−7.2** | −14.7 | −0.0 | 🟠 重档上沿，**峰值 0 dBFS 已顶格** |
| `confetti.wav` | 1200ms | −11.2 | −15.9 | −0.9 | 🟠 重档，可再降 2–3 |
| `countdown-go.wav` | 219ms | −12.8 | −16.1 | −4.5 | ✅ 重档偏轻，可接受 |
| `whoosh.wav` | 349ms | −13.1 | −16.1 | −5.1 | ✅ |
| `drink.wav` | 700ms | −14.0 | −18.8 | −8.5 | ✅（v5.2 已从 −5.5 修下来） |
| `gulp.wav` | 499ms | −13.0 | −15.3 | −1.2 | ✅ |
| `toggle-off/on.wav` | 120ms | −14.3 | −15.1 | −4.5 | ✅ 中档 |
| `countdown-urgent.wav` | 109ms | −15.5 | −15.9 | −2.3 | ✅ 中档 |
| `countdown.wav` | 89ms | −16.5 | −16.5 | −4.3 | ✅ 轻档 |
| `dice-tumble-wood.wav` | 1200ms | −16.7 | −20.6 | −0.2 | ✅ 环境/连续 |
| `impact-low.wav` | 240ms | −16.8 | −20.6 | −1.7 | ⚠️ "低频冲击层"却比摊牌还响，语义反了 |
| `tick.wav` | 17ms | −16.9 | −16.9 | −7.3 | ✅ 轻档 |
| `charge-up.wav` | 1200ms | −17.1 | −23.4 | −9.9 | ✅ 环境（v5.2 从 −9.2 修下来） |
| `tap.wav` | 44ms | −17.2 | −17.2 | −4.4 | ✅ 轻档基准 |
| `tap-soft.wav` | 34ms | −18.1 | −18.1 | −5.7 | ✅ |
| `cup-shake.wav` | 1249ms | −18.3 | −22.1 | −0.3 | ✅ 环境/连续 |
| `card-deal.wav` | 340ms | −18.4 | −23.3 | −0.3 | ✅ 轻档 |
| `chip-bet.wav` | 509ms | −18.4 | −21.7 | −5.7 | ✅ 轻档 |
| `dice-settle.wav` | 379ms | −18.7 | −24.5 | −2.4 | ✅ 轻档 |
| `card-flip.wav` | 234ms | −18.8 | −22.5 | −0.3 | ✅ 轻档 |
| `cup-slam.wav` | 809ms | **−19.3** | −28.4 | −0.3 | 🔴 **太轻**（重档应 −8，差 11dB！） |
| `cup-lift.wav` | 560ms | **−11.8** | −19.0 | −0.3 | 🟠 中等却比扣盅响 7.5dB，语义反了 |
| `reveal-hit.wav` | 949ms | **−20.5** | −29.3 | −0.3 | 🔴 **太轻**（全场焦点应 −8） |
| `wheel-slow.wav` | 1600ms | −20.1 | −25.0 | −7.5 | ✅ 环境（v5.2 从 −12.9 修下来） |
| `shaker-metal.wav` | 1560ms | −23.6 | −28.9 | −3.2 | ✅ 环境/连续 |
| `card-spread.wav` | 440ms | **−23.2** | −29.7 | −0.3 | ⚠️ 是组合音的**第一层**，由 `reveal-hit` 主导（见下） |
| `dice-on-table.wav` | 929ms | **−24.0** | −32.8 | −0.3 | 🔴 太轻 |
| `dice-into-cup.wav` | 780ms | **−26.2** | −34.6 | −0.3 | ⚠️ 组合音的**开场轻响**，设计如此 |

**⚠️ 关键洞察（这条比表格本身重要）：不能只看 ST100 排序。**

`gen-audio.py` 的注释里已经记过这个坑，本文必须在规范层面固定下来：

> "dice-into-cup 想要 +6 dB，实际变成 −26 dB"、"card-spread 单独看太轻，
> 但它紧跟 reveal-hit，整体由后者主导 —— 单独看响度低是**设计意图**，不是失衡"。

所以：

1. **组合音（一个动作两声）只按"主音"定层**，前奏层允许低 8–15dB；
2. **瞬态尖锐型 vs 宽频持续型，ST100 不可直接比** ——
   `tick`（17ms）和 `dice-settle`（379ms）ST100 接近，但后者听起来厚得多，
   因为它的能量在时间上铺开了；
3. 最终判据是**人耳 A/B**，公式只能把明显失衡的先抓出来。

### 6.3 四层响度阶梯（本项目规范）

| 层 | 语义 | 目标 ST100 | 允许带 | 现有成员 |
|---|---|---|---:|---|
| **L0 环境 / 连续** | 摇盅、转盘慢转、蓄力、木质翻滚 | **−22 ~ −18 dBFS** | ±3 | wheel-slow −20.1、cup-shake −18.3、shaker-metal −23.6、charge-up −17.1、dice-tumble −16.7 |
| **L1 轻反馈** | 点击、选择、单颗落定、发牌翻牌 | **−18 ~ −16 dBFS** | ±2 | tap −17.2、tap-soft −18.1、tick −16.9、dice-settle −18.7、card-flip −18.8、card-deal −18.4、chip-bet −18.4 |
| **L2 中反馈** | 落定、切换、投票结果、倒计时、连击 | **−14 ~ −12 dBFS** | ±2 | toggle −14.3、countdown-urgent −15.5、countdown −16.5（偏低）、countdown-go −12.8、whoosh −13.1、combo −9.9（偏高） |
| **L3 重反馈** | 开盅、扣盅、摊牌、惩罚、结算、撒花 | **−9 ~ −7 dBFS** | ±2 | wheel-stop −7.2、fail-drop −7.1、confetti −11.2、**cup-slam −19.3 ❌**、**reveal-hit −20.5 ❌**、**dice-on-table −24.0 ❌** |

**层间差距**：L1 → L2 ≈ **+4dB**，L2 → L3 ≈ **+5dB**。
选 4–5dB 而不是 10dB 的理由：**3dB 是可察觉的最小台阶，10dB 是"响一倍"**；
一次游戏里相邻两档差 4–5dB，玩家能感到"这个更重要"但不会被吓到。

**峰值上限：−1 dBFS（本项目 CLAUDE/AGENTS 里的 0.97 淡出到 0.94 也行，但不能到 0）。**
`wheel-stop.wav` 现在是 **−0.0 dBFS**（顶格），任何后级处理都会削波 —— 必须修。

### 6.4 偏差清单（按修复优先级）

| 优先级 | 音效 | 现状 | 目标 | 改法 |
|---|---|---|---|---|
| **P0** | `cup-slam` | −19.3 | **−8** | **只能向上调**：重做一个峰值更集中的版本（"砸住"那 40ms 要让峰值唱主角），或把整体 +11dB 后重新限峰 |
| **P0** | `reveal-hit` | −20.5 | **−8** | 同上 |
| **P1** | `dice-on-table` | −24.0 | **−12**（它是"骰子滚两下"的次要音，不必进 L3） | 向上重制 |
| **P1** | `wheel-stop` | peak −0.0 | ≤ **−1.0** | 峰值压 1dB（几乎听不出） |
| **P1** | `impact-low` | −16.8 | −12（低频垫层，跟随主音） | 略提，并**只在重反馈里叠用** |
| **P2** | `combo-1..4` | −9.9 | −13 | 降 3dB（连击是"节奏感"，不是"轰炸"） |
| **P2** | `wheel-start` | −9.9 | −13 | 降 4dB |
| **P2** | `cup-lift` | −11.8 | −16（它是"揭盅前的铺垫"） | 降 4dB —— 现在它比扣盅响 7.5dB，**因果反了** |
| **P3** | `countdown` | −16.5 | −14 | 略提（读秒要能被听见） |

**⚠️ "只能向上不能向下"这条规则要修正。**
`gen-audio.py` 里写的是"只做向下调"，理由是"向上调会被峰值保护吃掉"。
那个结论**只对"已 peak-normalize 到 0.97 的文件"成立**。
`cup-slam` / `reveal-hit` 恰好是**峰值已经顶格、但 ST100 很低**的类型 ——
它们的能量极度集中在几毫秒里，被 100ms 窗口平均掉了。
**这类音效靠调增益救不回来，只能重做包络**（缩短衰减、提高主体段占比）。

> 这条值得写进 AGENTS.md：**"测出来的响度"和"听到的响度"在瞬态音上会分叉，
> 遇到"峰值顶格但听着轻"不要调增益，要重做包络。**

### 6.5 并发与实例池（小程序硬限制）

微信官方（小游戏文档，`InnerAudioContext` 行为一致）：

> "由于系统限制，在 **Android 上最多同时播放 10 个音频**，超过的部分会做有损处理，
> 对开发者来说不感知，但开发者应尽量避免同时播放过多音频。"

来源：[微信小游戏 · 音频](https://developers.weixin.qq.com/minigame/dev/guide/base-ability/audio.html)

同页的两条最佳实践：**复用已有的音频实例**、**及时 `destroy()` 不再需要的实例**。

**本项目现状（`miniprogram/utils/sfx.js`）**：已经做了实例池，`POOL_SIZE` 里
`tick: 3 / tap: 2 / shakerMetal: 3 / chipBet: 3 / cupSlam: 2 / diceOnTable: 2` 等，
注释里明确写了"高频音效需要多个实例轮转，因为 stop()+play() 跨线程会互相打断"。

**规范补充**：

| 约束 | 值 | 依据 |
|---|---|---|
| 同时响的音效上限 | **≤ 4**（Android 硬上限 10 的一半，留余量） | 官方 10 + `经验值` |
| 单音效实例池上限 | **3** | 现状验证（34ms 一次用了 3 个刚好） |
| 总 `InnerAudioContext` 实例数 | **≤ 40**（现 34 个音效 × 平均 1.3 ≈ 45，已超） | `经验值`，需真机验证 |
| 首次播放前必须预加载 | 是 | `sfx.js` 注释："第一次播放有几十毫秒解码延迟，摇骰子时会慢半拍" |
| 短音效、高频音效 | 可用 `useWebAudioImplement: true` | 官方："WebAudio 播放性能好，建议短音频、播放频繁的音效使用" |

⚠️ `useWebAudioImplement` 的代价是**内存**（官方原话"占用内存较大"）。
不建议全局打开，只给 `tick` / `tap` / `shaker-metal` / `chip-bet` 这 4 个。

---

## 7. 移动端触感分级

### 7.1 三方能力对照

| 平台 | API | 分级 | 可控参数 | 出处 |
|---|---|---|---|---|
| **iOS** | `UIImpactFeedbackGenerator` | `.light` `.medium` `.heavy` `.soft` `.rigid` | 只有 5 个预设 | [文档](https://developer.apple.com/documentation/uikit/uiimpactfeedbackgenerator)、[Unity 插件文档](https://github.com/apple/unityplugins/blob/main/plug-ins/Apple.CoreHaptics/Apple.CoreHaptics_Unity/Assets/Apple.CoreHaptics/Documentation~/Apple.CoreHaptics.md) |
| iOS | `UISelectionFeedbackGenerator` | `selectionChanged()` | 只有"选择变化"一种 | 同上 |
| iOS | `UINotificationFeedbackGenerator` | `.success` `.warning` `.error` | 3 种 | 同上 |
| iOS | `CHHapticEngine`（13+） | `CHHapticEvent` 自定义 | **`hapticIntensity` 0..1、`hapticSharpness` 0..1**，可做连续/曲线/与音频同步 | [Core Haptics 指南](https://reintech.io/blog/building-ios-apps-with-core-haptics-and-taptic-feedback) |
| **Android** | `HapticFeedbackConstants` | `VIRTUAL_KEY`(1) `CLOCK_TICK`(4) `KEYBOARD_TAP` `LONG_PRESS` `CONFIRM` `REJECT` `GESTURE_START` `GESTURE_END` `SEGMENT_FREQUENT_TICK` … | 无强度参数（由系统/厂商映射） | [AOSP 常量表](https://source.android.com/docs/core/interaction/haptics/haptics-constants-primitives)、[API 参考](https://developer.android.com/reference/android/view/HapticFeedbackConstants) |
| Android | `Vibrator` / `VibrationEffect`（8+） | 自定义波形 | **amplitude 1..255**、时长、波形序列 | `经验值`（未在本次检索中取得官方页面） |
| **微信小程序** | `wx.vibrateShort({type})` | `heavy` / `medium` / `light` | **只有这 3 个**，时长固定 | [官方文档](https://developers.weixin.qq.com/miniprogram/dev/api/device/vibrate/wx.vibrateShort.html) |
| 微信小程序 | `wx.vibrateLong()` | 无分级 | **无强度参数** | [官方文档](https://developers.weixin.qq.com/miniprogram/dev/api/device/vibrate/wx.vibrateLong.html) |

### 7.2 微信的三条硬事实

来自官方 `wx.vibrateShort` 文档（检索快照）：

1. **固定 15ms**："使手机发生较短时间的振动（15 ms）。"
2. **强度参数需基础库 2.13.0+**："`type` string … 有效值为：heavy、medium、light … 2.13.0"。
3. **部分设备不支持，且会走 fail**：
   失败 `errMsg` 的合法值里有 **`style is not support`** —— "当前设备不支持设置震动等级"。
4. "仅在 iPhone **7 / 7 Plus 以上**及 Android 机型生效"。

`wx.vibrateLong` 文档：**400ms**，**无强度参数**。

→ **本项目已正确处理**（`feedback.js` 的 `vibrate()`）：先试带 `type` 的调用，
`fail` 里退化成无参调用；`'long'` 优先 `vibrateLong`，失败退化成 `safeShort('heavy')`。
**这个降级是必须的，不是可选优化。**

### 7.3 震动分级规范

| 档 | 微信 API | 对应 iOS | 对应 Android | 时长 | 用在哪 |
|---|---|---|---|---|---|
| **L1 轻** | `vibrateShort({type:'light'})` | `.light` | `CLOCK_TICK` / `KEYBOARD_TAP` | 15ms | 单颗骰子落定、按钮按下、翻牌 |
| **L2 中** | `vibrateShort({type:'medium'})` | `.medium` | `VIRTUAL_KEY` / `CONTEXT_CLICK` | 15ms | 扣盅、投票出局、比牌 |
| **L3 重** | `vibrateShort({type:'heavy'})` | `.heavy` | `LONG_PRESS` / `CONFIRM` | 15ms | 开盅揭晓、开始！ |
| **L4 长** | `vibrateLong()` | 连续 haptic（需 Core Haptics） | `VibrationEffect.createOneShot(400)` | ~400ms | 惩罚、整局结算 |
| **L5 双震** | `light` + 120ms + `light` | 两个 `CHHapticEvent` | 两个波形段 | 2×15ms | 抽到"免罚一次"这种惊喜 |
| **L0 不震** | — | — | — | — | **连续音（摇盅、转盘慢转、倒计时读秒）** |

**四条铁律**：

1. **连续动作绝不震**。摇盅 1 秒、转盘 1.6 秒、读秒 750ms 一跳 —— 这些震起来
   就是"手机在报警"，用户第一件事是去关震动，然后所有手感设计全部失效。
   本项目已有断言锁着（`test-game.js` ⑦：`cupShake.haptic` 必须为 `null`）。
2. **逐颗落定只给 light**。一局十几颗，heavy 会腻。
3. **同一时刻 60ms 内不重复震**（现状 `HAPTIC_THROTTLE_MS = 60`）—— 保留。
4. **震动开关和静音开关必须分开**（现状已分开：`hapticOn` / `gameMute`）。
   酒桌上"能听见但不想震"是很常见的需求。

**Android 的额外注意**：`HapticFeedbackConstants` 里相当一部分常量在较新 API 上被标为
`Obsolete`（`CLOCK_TICK` `CONTEXT_CLICK` `LONG_PRESS` `VIRTUAL_KEY` `CONFIRM` `REJECT` …），
见 [Microsoft Learn 镜像表](https://learn.microsoft.com/en-us/dotnet/api/android.views.hapticfeedbackconstants?view=net-android-37.0)。
这不影响小程序（走的是微信自己的桥），但如果将来做原生壳要注意。

---

## 8. 排队 / 等待感：1.5 秒轮询如何做出"实时感"

### 8.1 差距在哪

Nielsen 1993 年（*Usability Engineering*）确立的三条阈值，至今是行业标准：

| 阈值 | 用户感受 |
|---|---|
| **0.1s** | 瞬时，有"直接操控"感 |
| **1s** | 会察觉延迟，但思路不断 |
| **10s** | 注意力转移，开始干别的 |

来源：[Response Time Limits](https://uxuiprinciples.com/en/principles/response-time-limits)（在 [NN/g 的骨架屏文章](https://www.nngroup.com/articles/skeleton-screens) 语境下引用）

**1.5 秒轮询 = 最坏 1500ms 的可见延迟 = 超过 1s 阈值 1.5 倍。**
在这个延迟下，"点了按钮 → 界面动一下"这件事**必须不依赖网络**，否则永远像卡。

### 8.2 五层手段（按性价比排序）

| # | 手段 | 解决什么 | 成本 |
|---|---|---|---|
| 1 | **乐观更新** | 自己的一次操作立即生效，不等服务端 | 低（但要处理回滚） |
| 2 | **点击即时反馈**（0ms 缩放/音效/震动） | Nielsen 的 0.1s 层 | 极低 |
| 3 | **具体进度暗示**（"还差 2 人：老王、小李"） | 让等待变成可理解的 | 低 |
| 4 | **骨架屏** | 首屏/换玩法时的空白 | 低 |
| 5 | **双速轮询**（刚操作完 300ms 补一次） | 缩短自己的操作被"看见"的时间 | 中 |

### 8.3 乐观更新的正确写法（含回滚）

```js
/**
 * 乐观更新：先改本地，再发请求，失败回滚。
 *
 * ⚠️ 三条必须遵守：
 *   1. 只对"一定会成功"的操作乐观（叫骰、投票、换牌）；
 *      对"可能被服务端拒绝"的操作（开局、换玩法）不要乐观。
 *   2. 回滚必须回到**操作前快照**，不是"重新拉一次"——
 *      重新拉一次会闪一下旧状态，比不乐观还差。
 *   3. 乐观状态要带一个 `_optimistic: true` 标记，
 *      轮询回来的真实数据到达时，**同值覆盖不要触发动画**，
 *      否则会看到"动画播两遍"。
 */
async function optimistic(action, localPatch, rollbackPatch) {
  const snapshot = { ...this.data.room }          // ① 快照
  this.setData({ room: this.decorate({ ...this.data.room, ...localPatch, _optimistic: true }) })
  try {
    const r = await call('room', action)
    if (!r.ok) throw new Error(r.msg)
    // ② 用服务端真值覆盖，但**不打动画**（值相同 → decorate 会保留 _optimistic:false）
    this.setData({ room: this.decorate(r.room) })
  } catch (e) {
    this.setData({ room: this.decorate({ ...snapshot, ...rollbackPatch }) })  // ③ 回滚
    wx.showToast({ title: e.message || '没成功，再试一次', icon: 'none' })
  }
}
```

⚠️ **本项目已有基础设施**：`room.js` 的 `decorate(room)` 是"派生字段的唯一入口"，
`refresh()` 里的 `roomChanged()` 会跳过无变化的重绘。
乐观更新必须**同时**满足这两条：

- 乐观补丁走 `decorate()`（否则派生字段被抹成 `undefined` —— 这个 bug 已经踩过，
  症状是"点叫骰没反应"，见 AGENTS.md）；
- 乐观标记 `_optimistic` **不能**进入 `roomChanged()` 的比较字段集
  （否则每次轮询都判定"变了"，1.5 秒重绘一次，等于没优化）。
  `updatedAt` 已经明确排除，`_optimistic` 也必须排除。

### 8.4 进度暗示：不要用 spinner

| ❌ 别这样 | ✅ 这样 |
|---|---|
| 转圈 + "加载中" | "还差 **2** 人：老王、小李" |
| 空白等 1.5s | 骨架屏（当前布局的灰色占位） |
| "同步中…" 常驻 | 只在 **> 1s** 后才出现"网络有点慢" |
| 所有操作都等 | 自己的操作 0ms 生效，别人的操作显示"对方正在…" |

依据：Nielsen 的第一条启发式是 **Visibility of System Status**（系统状态可见），
NN/g 的骨架屏文章明确说"骨架屏减少**感知到的**加载时间，因为它显示了页面结构"，
来源：[Skeleton Screens 101 · NN/g](https://www.nngroup.com/articles/skeleton-screens)。

### 8.5 最短显示时长（防闪烁）

轮询回来的数据如果和本地几乎同时到达，会出现"出现 → 消失"的闪。
规范：

- 任何**加载占位**最短显示 **200ms**，最长 **1500ms**（超过就说明网络有问题，要换文案）；
- 任何**即时动画**最短 **100ms**（低于 100ms 会被读成"没动"）——
  这也解释了为什么 `T-TAP = 100ms` 是下限而不是 80ms。

---

## 9. ⚠️ 微信小程序硬限制与替代方案

> 这一节是**"哪些大厂手法在这里不能用"**的清单。
> 每条都给出替代方案；每条都基于官方文档或本项目实测，不基于推测。

### 9.1 CSS / 渲染引擎

| # | 限制 | 后果 | 替代方案 | 依据 |
|---|---|---|---|---|
| 1 | **CSS 3D `rotateY(180deg)` + `backface-visibility` 不可靠**：不同基础库/机型表现不一致（两面同时显示 / 都不显示），且**离线渲染验证不出来** | 翻牌变成"半透明叠影"或"牌消失" | **交叉淡入 + 缩放 0.9→1 + 轻转 2.5°**（本项目已用，见 `.fx-card-reveal`） | `本项目实测` |
| 2 | **CSS 做不出圆角立方体**（数学上无解：仿射变换不保持圆形，3D 面必为锐边） | 骰子像"贴纸" | **离线 SDF 渲染成 6 张 PNG**（本项目 `render-dice.py` 已做） | `本项目实测` |
| 3 | **CSS `animation` 在 `wx:for` 重建节点时会重播**。1.5s 轮询 → 列表重建 → 牌每 1.5s 飞进来一次，比不做还糟 | 动画变成"抽搐" | **改 class + `transition`**（值不变时不触发），或用 `wx:key` 保证节点复用 | `本项目实测` |
| 4 | **WXSS 不支持属性选择器 `[attr]`、不支持带参数的伪类/伪元素** | 样式静默不生效（不报错） | 只用 `class` | [WXSS 文档](https://developers.weixin.qq.com/miniprogram/dev/framework/view/wxss.html) |
| 5 | **Skyline 下 `filter` / `backdrop-filter` / `mask-image` 支持面窄**："不支持 multi function；不支持 drop-shadow；不支持 url；与 opacity 混合有问题；blur 某些情况表现不一致" | 光晕/毛玻璃做不出来或表现不一致 | 用**预渲染 PNG 光晕** + `opacity` 动画 | [Skyline WXSS 差异表](https://developers.weixin.qq.com/miniprogram/dev/framework/runtime/skyline/wxss.html) |
| 6 | **`animation-play-state` 支持面未确认**（Skyline） | hitstop 的"暂停—恢复"写法可能失效 | **拆两段关键帧 + 数值不变的 hold 段**（§4.5） | `⚠️待实测` |
| 7 | **`<image>` 不给 width/height 会按原始尺寸撑满容器**，`font-size` 完全无效 | 图标撑满半屏（本项目踩过两次） | 显式 `width` / `height`，并加断言 | `本项目实测` |
| 8 | **`rpx` 计算会取整**，小数值（如 0.5rpx）会丢 | 微小位移/缩放失真 | 小于 2rpx 的位移**用 `scale` 表达**，不要用 `translate` | [WXSS 文档](https://developers.weixin.qq.com/miniprogram/dev/framework/view/wxss.html)（"rpx 的计算规则有时会对转换后的数值进行取整"） |
| 9 | **WXSS 变量 `--var` 在 Skyline 下支持面待确认** | 规范表整体失效 | 字面量重复，或跑一次真机确认 | `⚠️待实测` |
| 10 | **`prefers-reduced-motion` 在 WXSS 里是否生效待确认** | 无障碍降级做不了 | **用 App 内设置项**（"减少动效"开关），JS 层切换 class | `⚠️待实测` |

### 9.2 交互 / 震动

| # | 限制 | 后果 | 替代方案 | 依据 |
|---|---|---|---|---|
| 11 | `wx.vibrateShort` **固定 15ms**，强度只有 `heavy/medium/light` | 做不出"渐强震动"、"连续震动" | 用**间隔**模拟：`light` + 120ms + `light`（本项目 `'double'` 已实现） | [官方文档](https://developers.weixin.qq.com/miniprogram/dev/api/device/vibrate/wx.vibrateShort.html) |
| 12 | `type` 参数**部分设备/平台被忽略**，fail 返回 `style is not support` | 不降级则完全不震 | **先试带 type，fail 退化成无参调用**（已实现） | 同上 |
| 13 | `wx.vibrateLong()` **约 400ms，无强度参数** | 无法做"短促重震" | 重震用 `vibrateShort({type:'heavy'})`；长震只给"整局结束" | [官方文档](https://developers.weixin.qq.com/miniprogram/dev/api/device/vibrate/wx.vibrateLong.html) |
| 14 | iOS 需系统设置里"响铃时震动/静音时震动"打开才生效 | 部分用户永远收不到震动 | **不能只靠震动传达信息**，必须有视觉兜底 | `经验值`（uni-app 文档明确提示） |
| 15 | 微信**没有** `wx.canIUse` 之外的震动能力探测 | 无法提前判断 | 靠 `fail` 回调，且**绝不能因震动失败影响玩法**（已实现） | `经验值` |

### 9.3 音频

| # | 限制 | 后果 | 替代方案 | 依据 |
|---|---|---|---|---|
| 16 | **Android 最多同时播 10 个音频**，超出"有损处理，对开发者不感知" | 密集音效静默丢失 | 同时 ≤ **4** 个；高频音效做实例池 | [小游戏音频文档](https://developers.weixin.qq.com/minigame/dev/guide/base-ability/audio.html) |
| 17 | `InnerAudioContext` 实例数有限 | 玩几局后报错 | **复用实例 + 及时 `destroy()`**（已实现） | 同上 + `sfx.js` 注释 |
| 18 | 首次 `play()` 有**几十毫秒解码延迟** | 摇骰子"哗啦"慢半拍 | **预加载**（已实现） | `本项目实测` |
| 19 | WebAudio 低延迟但**内存大** | 全开会导致内存压力 | 只对 `tick`/`tap`/`shaker-metal`/`chip-bet` 开 `useWebAudioImplement` | [小游戏音频文档](https://developers.weixin.qq.com/minigame/dev/guide/base-ability/audio.html) |
| 20 | **电话打断 / 后台切换**会停掉音频 | 回来之后没声音 | `wx.onAudioInterruptionEnd` 里恢复 | 同上 |
| 21 | 小程序**不能做 5.1 / 空间音频定位** | 做不出"声音从左边传来" | 用**音色 + 响度差**表达方位（左声道靠 pan，需 WebAudio） | `经验值` |

### 9.4 `setData` 与动画驱动

| # | 限制 | 后果 | 替代方案 | 依据 |
|---|---|---|---|---|
| 22 | **`setData` 是跨线程拷贝 + 视图 diff**，值相同也要走完整流程 | 高频 setData 动画会卡、掉帧 | 动画一律走 **CSS/WXSS**；只在"状态变化"时 setData | `本项目实测`（`roomChanged()` 的由来） |
| 23 | `setData` 连续调用会**互相覆盖** | 上一帧的样式丢失 | 合并成一次 `setData`，或用 `wx.nextTick` | `经验值` |
| 24 | `wx.createAnimation` 已过时；`this.animate`（关键帧，2.9.0+）**仅 WebView 渲染引擎支持** | Skyline 下不可用 | 只用 CSS `animation` / `transition` | [小程序动画文档](https://developers.weixin.qq.com/miniprogram/dev/framework/view/animation.html) |
| 25 | WXS 可以在视图层直接改样式（不过桥） | — | 极端性能场景（如跟随手指）才用 | 同上的动画文档 |

---

## 10. ★★ 数值表（动作类型 → 全部参数）

> 用法：加一个动作，先从这张表里选一行，照抄参数；表里没有就**先加一行再实现**。
> `hitstop` 列写"✓ 60ms"表示要做，写"—"表示不做。

### 10.1 通用档位表（按重要性分三档）

| 档 | 动作类型 | 动画时长 | 缓动曲线 | 缩放 | 位移 / 旋转 | 音效延迟 | 震动 | hitstop |
|---|---|---|---|---|---|---|---|---|
| **轻** | 按下态（不加动画） | **0ms** | — | 1 → **0.965** | 0 | 0 | 无 | — |
| 轻 | 松开回弹 | **100ms** | `cubic-bezier(0,0,.2,1)` | 0.965 → **1** | 0 | 0 | `light`（可选，仅重要按钮） | — |
| 轻 | 选项高亮 / 选中 | **100ms** | `cubic-bezier(.4,0,.2,1)` | 1 → **1.02** → 1 | 边框 2rpx | 0 | `light` | — |
| 轻 | 单颗骰子落定 | **200ms** | `cubic-bezier(.4,0,.2,1)` | **1.04 → 0.985 → 1** | Y **−10rpx → 0** | **+30** | `light` | — |
| 轻 | 筹码/代币落下 | **200ms** | 同上 | 1.04 → 1 | Y −8rpx → 0 | +30 | `light` | — |
| 轻 | 发牌（单张滑入） | **200ms** | `cubic-bezier(0,0,.2,1)` | **0.94 → 1** | X −40rpx → 0 | +30 | 无 | — |
| 轻 | 翻自己的牌（按住看） | **220ms** | `cubic-bezier(.22,1,.36,1)` | **0.90 → 1** | 转 **−2.5° → 0°** | +30 | `light` | — |
| 轻 | 角标 / 数字跳变 | **150ms** | `cubic-bezier(0,0,.2,1)` | 1.12 → 1 | Y −6rpx → 0 | 0 | 无 | — |
| **中** | 面板 / 抽屉弹出 | **300ms** | `cubic-bezier(0,0,.2,1)` | — | Y **+100% → 0** | +30 | `medium` | — |
| 中 | 面板收起 | **200ms** | `cubic-bezier(.4,0,1,1)` | — | Y 0 → +100% | 0 | 无 | — |
| 中 | 列表项批量入场 | **200ms** 起，**每项 +40ms**，最多错 5 项 | `cubic-bezier(0,0,.2,1)` | 0.96 → 1 | Y 12rpx → 0 | 首项 +30 | 首项 `light` | — |
| 中 | 视图 / 玩法切换 | **300ms** | `cubic-bezier(.4,0,.2,1)` | 0.98 → 1 | 交叉淡入 | +30 | 无 | — |
| 中 | 投票落定（出局） | **260ms** | `cubic-bezier(.22,1,.36,1)` | **1.10 → 0.99 → 1** | 转 −1.5° → 0.4° → 0° | +30 | `medium` | — |
| 中 | 比牌 / 摊开 | **420ms** | `cubic-bezier(.36,.07,.19,.97)` | 1.06 → 1 | Y 0；场景抖 **M** | +30，第二层 +190 | `medium` | **✓ 60ms** |
| 中 | 转盘停稳 | **280ms** | `cubic-bezier(.36,.07,.19,.97)` | 1.04 → 1 | 场景抖 **M** | +30 | `medium` | — |
| 中 | 扣盅（砸桌） | **380ms** | `cubic-bezier(.36,.07,.19,.97)` | **1.16 → 1.02 → 1** | Y −14rpx → 0；场景抖 **M** | +30 | `medium` | — （视觉已含 hold） |
| **重** | 开盅揭晓 | **400ms** | `cubic-bezier(.36,.07,.19,.97)` | **1.28 → 1.06 → 1** | 场景抖 **L** + 闪白 | +30，第二层 +150 | `heavy` | **✓ 70ms** |
| 重 | 惩罚（喝酒） | **360ms** | `cubic-bezier(.36,.07,.19,.97)` | 1.0 | Y **+24rpx → 0**（下坠），暗红 | +30 | `long` | **✓ 80ms** |
| 重 | 结算（输） | **400ms** | `cubic-bezier(.4,0,.2,1)` | 0.96 → 1 | 淡入 | +30 | `long` | — |
| 重 | 结算（赢 / 撒花） | **600ms** | `cubic-bezier(.34,1.56,.64,1)`（唯一 C6） | **0.88 → 1.04 → 1** | 粒子 12–20 个 | +30 | `long` | — |
| 重 | 倒计时"开始！" | **500ms** | `cubic-bezier(.16,1.3,.4,1)` | **1.6 → 1** | 场景抖 **M** | +30 | `heavy` | — |
| — | **连续音（不震）** | 见各动作 | `linear`（循环） | — | — | 0 | **`null`** | — |

### 10.2 逐玩法动作清单（对应本项目的 `FEEDBACK` 键）

| 玩法 | 动作 | FEEDBACK key | 档 | 建议时长 | 建议曲线 | 建议震动 | hitstop |
|---|---|---|---|---|---|---|---|
| 大话骰 | 骰子入盅 | `diceIn` | 轻 | 620ms（演出） | C4 | `light` | — |
| 大话骰 | 摇盅 | `cupShake` | 连续 | 1050ms | `ease-in-out` 循环 | **`null`** | — |
| 大话骰 | **扣盅** | `cupSlam` | 中 | 380ms | C4 | `medium` | 视觉 hold |
| 大话骰 | 揭盅 | `cupLift` | 轻 | 420ms | C1 | `null` | — |
| 大话骰 | 骰子上桌滚 | `diceTable` | 轻 | 750ms（演出） | C1 | `light` | — |
| 大话骰 | 逐颗落定 | `diceSettle` | 轻 | 420ms（演出，单颗 200） | C3 | `light` | — |
| 大话骰 | 开盅揭晓 | `cupOpen` | **重** | 400ms | C4 | `heavy` | **70ms** |
| 大话骰 | 叫骰落定 | （新增）`bidSettle` | 轻 | 150ms | C1 | `light` | — |
| 比大小 | 开牌 | （复用）`pkFlip` | 轻 | 220ms | C1 | `light` | — |
| 比大小 | 比牌结果 | （新增）`cmpResult` | **重** | 400ms | C4 | `heavy` | **70ms** |
| 卧底 | 投票落定 | `uwVote` | 中 | 260ms | C1 | `medium` | — |
| 卧底 | 出局揭晓 | `uwReveal` | 中→重 | 440ms | C4 | `heavy` | **60ms** |
| 卧底 | 按住看词 | （新增）`uwPeek` | 轻 | 120ms | C1 | `light` | — |
| 金花 | 翻自己的牌 | `pkFlip` | 轻 | 260ms | C1 | `light` | — |
| 金花 | 摊牌比牌 | `pkSpread` | **重** | 420ms | C4 | `heavy` | **60ms** |
| 金花 | 换牌（代价动作） | （新增）`pkSwap` | 中 | 260ms | C3 | `medium` | — |
| 转盘 | 转动 | —（CSS `rlTumble`，无 FEEDBACK 键） | 连续 | 1150ms 循环 | `linear` | **`null`** | — |
| 转盘 | 停稳 | `wheelStop` | 中 | 280ms | C4 | `medium` | — |
| 转盘 | 抽到免罚 | `luckyHit` | **重** | 400ms | **C5** | `double` | — |
| 通用 | 开始倒计时读秒 | `countdownTick` | 轻 | 750ms/次 | C3 | **`null`**（改） | — |
| 通用 | "开始！" | `countdownGo` | 重 | 500ms | C5（少量） | `heavy` | — |
| 通用 | 房主转移给我 | `becomeHost` | 轻 | **需补 200ms** | C1 | `light` | — |
| 通用 | 赢 | `win` | **重** | **需补 600ms** | **C6** | `long` | — |
| 通用 | 输 | `lose` | **重** | **需补 400ms** | C3 | `long` | — |

### 10.3 逐条差异（现状 → 规范）

| 项 | 现状（`本项目实测`） | 规范 | 理由 |
|---|---|---|---|
| `sfxDelay` | 手写常量；11 条里 5 条偏 +10ms、1 条偏移 0 | **派生** = `impactAt + 30` | §5.3 |
| `hapticDelay` | 手写常量；同上 | **派生** = `impactAt + 50` | §5.3 |
| `countdownTick.haptic` | `light`（每 750ms 震一次） | **`null`** | §7.3 铁律 1 |
| `win` / `lose` / `becomeHost` | `animMs: 0`（有音无画） | 补动画：600 / 400 / 200ms | §5.3 结论 2 |
| 曲线种类 | **16 种** | **6 种** | §2.4 |
| 裸 `ease` | 9 处 | 0 处 | §2.4 |
| 回弹占比 | **27/42 = 64%**（强回弹 36%） | ≤ 15% | §2.5 |
| 入/退场时长 | 同值 | 入场比退场慢 20–30ms | §2.2 |
| `cup-slam` 响度 | −19.3 dBFS | −8 | §6.4 P0 |
| `reveal-hit` 响度 | −20.5 dBFS | −8 | §6.4 P0 |
| `dice-on-table` 响度 | −24.0 dBFS | −12 | §6.4 P1 |
| `wheel-stop` 峰值 | −0.0 dBFS（顶格） | ≤ −1.0 | §6.3 |
| `cup-lift` 响度 | −11.8（比扣盅响 7.5dB） | −16 | §6.4 P2，因果反了 |
| shake | 已有**单档** `roomImpact`（±9rpx / 0.45° / 340ms，走 `bump()`） | **三档** S(2rpx/0°) M(6rpx/0.25°) L(12rpx/0.5°) | §4.2 |
| shake 的"只震一次" | 靠"值不变不重绘"的**副作用** | 显式规则 + 判据 | §4.2 |
| hitstop | 无 | 4 处（开盅/摊牌/比牌/惩罚） | §4.1 |

---

## 11. 验收清单（每一条都能写成断言）

> 依据 AGENTS.md 的教训：**判据必须能失败，且要用"整条删除"反向验证，不能用改名法。**

| # | 判据 | 阈值 | 怎么测 |
|---|---|---|---|
| 1 | `cubic-bezier` 去重种类 | ≤ 6 | 正则 + 去重计数 |
| 2 | 裸 `ease` / `ease-in` / `ease-out` 使用 | 0（`linear` 仅限循环动画） | 正则 |
| 3 | 回弹曲线（y2 > 1 或 y1 < 0）占比 | ≤ 15% | 解析贝塞尔控制点 |
| 4 | 单元素 `animation` 时长 | ≤ 400ms（"演出"白名单除外，需逐个登记） | 正则 + 白名单文件 |
| 5 | `FEEDBACK` 里 `sfxDelay === impactAt + 30` | 100%（连续音豁免） | 遍历表 |
| 6 | `FEEDBACK` 里 `hapticDelay === impactAt + 50` | 100%（连续音豁免） | 遍历表 |
| 7 | `haptic: null` 的动作不得有震动副作用 | 100% | 已有 `test-game.js` ⑦ |
| 8 | 每个 `FEEDBACK` 键的 `animMs > 0` | 100%（纯听觉提示需显式标注） | 遍历表 |
| 9 | 双音效动作的第二层延迟在 `[150, 300]` | 100% | 遍历表 |
| 10 | 每个音效的 ST100 落在其所属层的带内 | ±3dB | 音频测量脚本 + 清单 |
| 11 | 所有音效峰值 | ≤ −1.0 dBFS | 同上 |
| 12 | 所有音效 DC 偏置 | ≤ 0.01% 满量程 | 同上 |
| 13 | 同时播放的音效数 | ≤ 4 | 运行时计数（开发期断言） |
| 14 | `POOL_SIZE` 单键 | ≤ 3 | 静态扫描 |
| 15 | 每个 shake class 在 wxss 里真实存在 | 100% | 静态扫描（注意"同类锚点全替换会吞内容"的老坑） |
| 16 | 每处 `animation: xxx` 的 `@keyframes xxx` 存在 | 100% | 静态扫描 |
| 17 | `<image>` 的 class 在 wxss 有 width/height | 100% | 已有 `test-contract.js` ③e-3 |
| 18 | 列表项动画使用 `transition` 而非 `animation` | 100% | 静态扫描 `wx:for` 块 |

⚠️ **第 1–3 条特别容易被写成"假绿"**：如果判据是"出现过合法曲线就算通过"，
那么新加 10 条野生曲线照样过。必须判**去重后的总数**，并且反向验证时
**新增一条野生曲线**确认断言报错。

---

## 12. 参考来源汇总

### 手感理论
- Steve Swink《Game Feel》(2008) · [PubMed 无, 官方站](http://www.game-feel.com) · [Wikipedia](https://en.wikipedia.org/wiki/Game_feel) · [书评](https://lizengland.com/blog/review-game-feel-by-steve-swink)
- 「Juice it or lose it」2012 · https://www.youtube.com/watch?v=Fy0aCDmgnxg · [源码](https://github.com/grapefrukt/juicy-breakout)
- 「The art of screenshake」2013 · https://www.youtube.com/watch?v=AJdEqssNZ-U
- [Game feel on the web（含 hitstop/摇杆代码量级与 `offsetWidth` 强制重排技巧）](https://valdemird.com/blog/game-feel-on-the-web)
- [How to Make Your Game Feel Good](https://egmatic.com/blog/how-to-make-your-game-feel-good)
- [Disney 12 原则](https://en.wikipedia.org/wiki/Twelve_basic_principles_of_animation)

### 缓动与时长
- [Material 1 · Duration & easing](https://m1.material.io/motion/duration-easing.html)（300/375/225/195/400ms + 四条曲线的三平台控制点）
- [Material 3 · Easing and duration tokens](https://m3.material.io/styles/motion/easing-and-duration/tokens-specs)（50/100/150/200 + 250/300/350/400）
- [Apple · spring(response:dampingFraction:blendDuration:)](https://developer.apple.com/documentation/swiftui/animation/spring(response:dampingfraction:blendduration:))（默认 0.5 / 0.825 / 0）
- [WWDC18 · Designing Fluid Interfaces](https://developer.apple.com/videos/play/wwdc2018/803)
- [nathangitter/fluid-interfaces](https://github.com/nathangitter/fluid-interfaces) · [参数整理](https://medium.com/@nathangitter/building-fluid-interfaces-9732bb934bf5)
- [SwiftUI Spring 参数讲解（stiffness 170 / damping 15）](https://medium.com/@amosgyamfi/learning-swiftui-spring-animations-the-basics-and-beyond-4fb032212487)

### 打击感
- [Capcom SF Seminar · Hour 11（8F hitstop、轻中重 8/12/16F）](https://game.capcom.com/cfn/sfv/column/131545?lang=en)
- [Hitstop in Capcom Beat 'Em Ups（逐帧分析，攻 6F/受 8F）](https://shane-sicienski.com/blog/blog-post-title-one-55pmn)
- [Hitstop 术语与 SF2 的 2in1（hitstop 延长取消窗口）](https://critpoints.net/2017/05/17/hitstophitfreezehitlaghitpausehitshit)
- [Infil 格斗术语表](https://glossary.infil.net)
- [Godot game feel checklist（trauma² 模型、hitstop 0.06s）](https://forum.godotengine.org/t/game-feel-checklist-for-godot-4-hit-stop-trauma-shake-coyote-time-and-more/145340)
- [Cinemachine Impulse 参数（decay 0.7s / sustain 0.2s / amplitude gain 1）](https://docs.unity3d.com/Packages/com.unity.cinemachine@2.2/manual/CinemachineImpulseSource.html) · [实战 0.2 / 0.5](https://www.youtube.com/watch?v=xldh2lS8atY)

### 音频
- [Audiokinetic · Loudness Processing Best Practice Ch.3](https://www.audiokinetic.com/en/community/blog/loudness-processing-best-practice-chapter-3-scalable-loudness-processing-for-games)（−16/−12/−3 dB）
- [Different Loudness Ranges for Console and Mobile Games（EBU R128，5–10 LU）](https://designingsound.org/2013/02/20/different-loudness-ranges-for-console-and-mobile-games)
- [微信 · 小游戏音频（Android 最多 10 个并发、复用实例、WebAudio 建议）](https://developers.weixin.qq.com/minigame/dev/guide/base-ability/audio.html)
- [ITU-R BT.1359 音画同步容差（−125ms ~ +45ms）](https://arxiv.org/html/2212.01686v1) · [20–40ms 可察觉](https://www.testdevlab.com/blog/how-to-test-audio-video-sync)

### 触感
- [微信 · wx.vibrateShort（15ms、heavy/medium/light、2.13.0、`style is not support`）](https://developers.weixin.qq.com/miniprogram/dev/api/device/vibrate/wx.vibrateShort.html)
- [微信 · wx.vibrateLong（400ms、无强度参数）](https://developers.weixin.qq.com/miniprogram/dev/api/device/vibrate/wx.vibrateLong.html)
- [Android · HapticFeedbackConstants（AOSP 常量表）](https://source.android.com/docs/core/interaction/haptics/haptics-constants-primitives) · [API 参考](https://developer.android.com/reference/android/view/HapticFeedbackConstants) · [Obsolete 标注](https://learn.microsoft.com/en-us/dotnet/api/android.views.hapticfeedbackconstants?view=net-android-37.0)
- [Immersion · UX Impacts of Haptic Latency（<30–50ms 瞬时；>100ms 降性能；>180–200ms 手已离开）](https://www.immersion.com/wp-content/uploads/2015/10/ux-impact_haptic-latency-in-auto_jul13v1.pdf)
- [Core Haptics / UIImpactFeedbackGenerator 五种预设 + intensity/sharpness](https://reintech.io/blog/building-ios-apps-with-core-haptics-and-taptic-feedback) · [Apple Unity 插件文档](https://github.com/apple/unityplugins/blob/main/plug-ins/Apple.CoreHaptics/Apple.CoreHaptics_Unity/Assets/Apple.CoreHaptics/Documentation~/Apple.CoreHaptics.md)

### 等待感 / 响应时间
- [Nielsen 0.1 / 1 / 10s 阈值](https://uxuiprinciples.com/en/principles/response-time-limits)
- [NN/g · Skeleton Screens 101](https://www.nngroup.com/articles/skeleton-screens)
- [Doherty Threshold（<400ms 提升 25–30% 效率）](https://uxuiprinciples.com/en/principles/response-time-limits)

### 微信小程序能力边界
- [WXSS（属性选择器不生效、不支持带参数的伪类/伪元素、rpx 取整）](https://developers.weixin.qq.com/miniprogram/dev/framework/view/wxss.html)
- [Skyline · WXSS 样式支持与差异（filter/backdrop-filter/mask-image 限制）](https://developers.weixin.qq.com/miniprogram/dev/framework/runtime/skyline/wxss.html)
- [小程序动画（CSS animation / `this.animate` 仅 WebView / WXS）](https://developers.weixin.qq.com/miniprogram/dev/framework/view/animation.html)

### 本项目内部事实（可复现）
- `miniprogram/utils/feedback.js` —— `FEEDBACK` 时间轴表（本文 §5.3 / §10 的现状列）
- `miniprogram/utils/sfx.js` —— 实例池 `POOL_SIZE`、预加载、静音开关
- `scripts/gen-audio.py` —— 合成参数、`LOUDNESS_FIX`、`short_term_db()` 的定义
- `miniprogram/audio/*.wav`（32 个）—— 本文 §6.2 的实测数据
- `miniprogram/pages/room/room.wxss`、`pages/lobby/lobby.wxss` —— 本文 §2.4 的曲线统计

---

## 附录 A · 实测方法与复现

```python
# 测量每个 wav 的 ST100（100ms 窗口最大 RMS，dBFS）
# 注意：sr 必须取该文件自己的采样率（8000/11025/22050 三档），
#       用全局 SR 算窗口长度会算错 —— gen-audio.py 第一版就错在这。
import wave, array, math
w = wave.open(path); sr = w.getframerate(); raw = w.readframes(w.getnframes())
a = array.array('h'); a.frombytes(raw)
xs = [v / 32768.0 for v in a]
wlen, best = max(1, int(sr * 0.1)), 0.0
for i in range(0, max(1, len(xs) - wlen + 1), max(1, wlen // 4)):
    seg = xs[i:i + wlen]
    best = max(best, math.sqrt(sum(v * v for v in seg) / wlen))
st100_dbfs = 20 * math.log10(best)
```

```bash
# 曲线统计（本文 §2.4）
grep -rho "cubic-bezier([^)]*)" --include=*.wxss miniprogram/ | tr -d ' ' | sort | uniq -c | sort -rn
# 时长统计
grep -rhoE "animation: [a-zA-Z0-9]+ \.?[0-9]+(\.[0-9]+)?s" --include=*.wxss miniprogram/
```

---

## 附录 B · 一页纸实施顺序

如果只能改 5 件事，按这个顺序：

1. **把 `sfxDelay` / `hapticDelay` 改成派生字段**（`impactAt + 30` / `+ 50`）。
   —— 零风险，一次性消灭 9 条漂移。
2. **曲线收敛到 6 条**，删掉裸 `ease`。
   —— 视觉一致性收益最大的一步。
3. **修 3 个"因果反了"的响度**：`cup-slam`（+11dB）、`reveal-hit`（+12dB）、
   `cup-lift`（−4dB）。这三个不改，"扣盅"这个全流程最有仪式感的一下永远是轻的。
4. **加 hitstop（4 处）+ shake 三档**。
   —— 这是"大厂感"最明显的差异点，而且成本极低（纯 CSS）。
5. **`countdownTick` 去掉震动，补 `win` / `lose` / `becomeHost` 的动画**。
   —— 去掉一个"烦人"，补上三个"空"。

> ⚠️ 第 3 步的前提是 **"重做包络"而不是"调增益"** ——
> `cup-slam` / `reveal-hit` 峰值已经顶格（−0.3 dBFS），调增益只会被限峰吃掉。
> 详见 §6.4 末尾。
