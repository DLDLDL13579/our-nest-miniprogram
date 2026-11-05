# 酒桌 · 微信小程序：线下多人酒桌游戏的同屏分机实现

> 一个人开一桌拿到 3 位房间号，其他人输号进来，各自看自己的手机。5 个玩法：大话骰 / 比大小 / 谁是卧底 / 梦幻金花 / 命运转盘。

**一句话定位**：这是一个**线下聚会用的多人小游戏小程序**，不是商业产品，也没有正式上线运营。它解决的问题很具体——酒桌上每个人手里都有手机，但缺一个「大家各自操作、结果由服务端裁决」的轻量游戏载体。

- 本仓库：<https://github.com/DLDLDL13579/our-nest-miniprogram>
- 仓库元数据：公开仓库，默认分支 `main`，主语言 JavaScript，体积 107779 KB（约 105 MB），star / fork 为 0 / 0，创建于 2026-09-24，最后 push 2026-11-04。
- **根目录无 LICENSE 文件**，即未声明开源许可；如需复用代码请先联系作者。
- 相关仓库：<https://github.com/DLDLDL13579/douyin-fudai-agent>、<https://github.com/DLDLDL13579/av-anomaly-detection>。

> **本仓库经历过一次整站转向**：2026-10-27 之前它是情侣记录 App「我们的小窝」（随手记 / 编年史 / 时间胶囊 / 要记得的事），那天之后整站改为酒桌游戏，**情侣功能与它们的云函数全部删除**。历史文档留在 `docs/archive/`，**是历史，不是规格，不要试图恢复**。

---

## 目录

- [一、它是什么](#一它是什么)
- [二、现状 / 状态表](#二现状--状态表)
- [三、目录结构](#三目录结构)
- [四、关键实现](#四关键实现)
- [五、玩法与参数表](#五玩法与参数表)
- [六、快速开始](#六快速开始)
- [七、测试体系](#七测试体系)
- [八、真机验证](#八真机验证)
- [九、已知问题与限制](#九已知问题与限制)
- [十、该看哪些文档](#十该看哪些文档)
- [十一、归属与许可证](#十一归属与许可证)

---

## 一、它是什么

线下酒桌用的多人小游戏。一个人开一桌拿到 **3 位房间号**，其他人输号进来，各自看自己的手机；所有牌面、骰子、身份、转盘结果由**云函数裁决**，客户端只负责渲染与操作。

5 个玩法：

| 玩法 | 类型 | 客户端模块 | 规则模块 |
|:---|:---|:---|:---|
| 大话骰 | 吹牛 / 叫点 | `miniprogram/utils/liarRules.js`、`liarCount.js` | `cloudfunctions/room/liarRules.js`、`liarCount.js` |
| 比大小 | 骰子比点 | `miniprogram/utils/dicerank.js` | `cloudfunctions/room/dicerank.js` |
| 谁是卧底 | 身份 / 投票 | `miniprogram/utils/words.js` | `cloudfunctions/room/words.js` |
| 梦幻金花 | 扑克比牌 | `miniprogram/utils/poker.js`、`decks.js` | `cloudfunctions/room/poker.js`、`decks.js` |
| 命运转盘 | 随机惩罚 | `miniprogram/utils/games.js` | `cloudfunctions/room/games.js`、`loser.js` |

`cloudfunctions/room/` 下另有 `betweenRules.js`、`consensusRules.js`、`sieveRules.js` 三组规则模块，在 `miniprogram/utils/` 里有同名副本——**前后端共享同一套纯函数**，这是本项目避免「前端算一套、后端算一套」的核心设计。

> 玩法中文名与「3 位房间号」见上一版 README；模块与文件的对应关系见仓库文件树。具体每个模块服务哪个玩法，以 `miniprogram/utils/games.js` 这份「玩法注册表唯一事实源」为准。

---

## 二、现状 / 状态表

| 项 | 状态 | 依据 |
|:---|:---|:---|
| 当前形态 | 酒桌多人小游戏，5 个玩法 | 上一版 README、`docs/current` 系列文档 |
| 转向日期 | 2026-10-27 从情侣记录 App 整站转向 | 上一版 README、`docs/archive/README-情侣版-v2.md` |
| 页面数 | 3 个页面：大厅、我的、房间 | `miniprogram/app.json` 路由 + 上一版 README |
| 分包 | `game/room/room` 在分包，主包约 770KB、分包 660KB | 上一版 README |
| 云函数 | 3 个：`room`（全部游戏逻辑）、`initdb`、`bootstrap` | 仓库文件树 |
| 云环境 | `cloudbase-d4goh1zdtc8eb9708` | 上一版 README 快速开始 |
| 测试 | 15 组 / 380 项，全部离线 | 上一版 README；`scripts/test-all.sh` 真实存在 |
| 真机验证 | 2026-10-30 跑过 5 个用例，全部通过 | `.tooling/cases/README.md` 逐字记录 |
| 正式上线 | **未上线**。`config.js` 的 `soloTest: true` 仍是测试开关 | 上一版 README 已知限制 |
| 最后 push | **2026-11-04** | 仓库元数据 |
| 仓库体积 | 107779 KB（约 105 MB） | 仓库元数据 |

**给第一次打开这个仓库的人**：这是一个**练手 / 自用性质**的完整工程，工程化程度（测试 380 项、文档 55 份、素材许可清单）明显高于「课程作业」，但**没有经过线上流量验证**，也没有上架记录。请按这个前提阅读下面的内容。

---

## 三、目录结构

仓库文件树记录共 **395 个文件**，一级分布：`miniprogram:145`、`.tooling:80`、`scripts:78`、`docs:55`、`cloudfunctions:20`、`prototype:8`、`根文件:6`、`.workbuddy:2`、`assets-staging:1`。

```text
.
├── miniprogram/                 小程序主体（145 个文件）
│   ├── app.js / app.json / app.wxss   入口、路由、全局变量
│   ├── config.js                云环境 ID + 云函数名 + 版本号 + 测试开关
│   ├── sitemap.json
│   ├── pages/                   主包页面
│   │   ├── lobby/               大厅：输房间号进房 + 玩法卡（点一张就一步建好房）
│   │   └── me/                  我的：昵称、音效/震动开关、关于
│   ├── game/                    **分包**：房间页 + 它的美术资源
│   │   ├── room/                房间页（wxml / wxss / js，phase→stage 状态机）
│   │   ├── bidOptions.js        叫法选项生成
│   │   ├── feedback.js          音效 / 动画 / 震动统一时间轴
│   │   ├── settle.js            结算
│   │   └── sfx.js               音效播放（分包侧）
│   └── utils/                   前后端共享的纯函数与工具
│       ├── games.js             **玩法注册表的唯一事实源**（id / 人数 / 规则文案 / 图标 / 配色）
│       ├── poker.js dicerank.js 牌型 / 点数排名
│       ├── liarRules.js liarCount.js betweenRules.js consensusRules.js sieveRules.js
│       ├── decks.js words.js    牌堆 / 词库
│       ├── cloud.js             云函数调用封装
│       ├── feedback.js sfx.js haptic.js   反馈与音效、震动
│       ├── fonts.js icons.js iconSet.js   字体与图标
│       └── trace.js             埋点 / 追踪
├── cloudfunctions/              3 个云函数（20 个文件）
│   ├── room/                    **全部游戏逻辑**，14 个 js 文件
│   │   ├── index.js             单入口，按 action 分发
│   │   ├── games.js decks.js poker.js dicerank.js
│   │   ├── liarRules.js liarCount.js words.js loser.js
│   │   └── betweenRules.js consensusRules.js sieveRules.js
│   ├── initdb/                  建库（`security.msgSecCheck` 权限）
│   └── bootstrap/               初始化（无 openapi 权限）
├── scripts/                     测试、素材渲染、离线截图、部署（78 个文件）
├── docs/                        调研、验收清单、素材来源（55 个文件）
│   ├── archive/                 已删除功能的历史文档（**不是规格**）
│   └── research/                玩法与视觉调研（8 份 2026-10-28 前后）
├── .tooling/                    真机自动化（miniprogram-automator）
│   └── cases/                   5 个真机验证用例
├── prototype/                   早期 HTML 线框与流程图（8 个文件）
├── assets-staging/              暂存资源区（**不打进包**）
├── AGENTS.md                    开工前必读：工作方式、判据、踩过的坑
└── project.config.json          开发者工具工程配置
```

**`assets-staging/` 为什么单独存在**：它在 `README` 里写得很清楚——项目有一条断言「包里任何图片都必须被引用，否则就是白占体积」，所以「素材已备好、玩法还没接完」的东西不能留在 `miniprogram/` 下。当前内容只有 `dice-red/`（6 张红色骰子图，49.6 KB），规则与测试已完成、玩法接入未做。

---

## 四、关键实现

### 4.1 前后端共享纯函数，云端是唯一裁决方

同一套规则文件在 `miniprogram/utils/` 与 `cloudfunctions/room/` 各有一份：`poker.js`、`dicerank.js`、`liarRules.js`、`liarCount.js`、`words.js`、`decks.js`、`betweenRules.js`、`consensusRules.js`、`sieveRules.js`、`games.js`。

**为什么这么设计**：牌型与点数排名是纯函数，客户端需要它做即时反馈（比如高亮「顺子」），云端需要它做最终裁决。若两边各写一份，任何规则微调都会出现「客户端显示赢、云端判输」——这类 bug 在多人游戏里最难复现。共享同一份实现后，**同一输入必然同一输出**。

代价是云函数与小程序**不能直接 `require` 对方的文件**，只能各存一份副本。仓库用 `scripts/check-sync.js` 做一致性检查，`scripts/sync-derive.sh` 做派生同步，避免两份文件漂移。

### 4.2 状态机只有一个出口：phase → stage

房间页的真实流程是 `entry → lobby → countdown → playing → over`（上一版 README「它长什么样」表格）。页面不直接改 `stage`，而是由 `phase` 派生——**唯一出口是 `room.js` 里的 `decorate`**。

上一版 README 对这条规则的原话是：「派生字段的唯一出口 —— 别在别处手写 `setData({room})`」。测试第 5 组专门验「phase→stage 唯一出口」，说明这条约束是**被测出来的**，不是文档口号。

**为什么值得单列**：多人游戏里「谁在等、谁在玩、谁在看」是三种不同视图，靠散落的 `if` 判断迟早出现某个人卡在错误界面。把派生收敛到一个函数后，新增状态只需改一处。

### 4.3 反馈时间轴：每个动作只定义一次

`miniprogram/utils/feedback.js` 把「音效 + 动画 + 震动」绑成一条时间轴，每个动作定义一次。测试第 6 组验「反馈时间轴 + 错误反馈（音画同步、不许静默吞错）」，第 8 组专门验「音效响度层级（扣盅必须压过铺垫）」。

**为什么这么设计**：骰盅类玩法的爽感高度依赖「摇 → 停 → 开」的节奏，如果动画和音效各自计时，会出现「声音到了画面没到」。把三者写进同一张表，才能保证扩展新玩法时不破坏手感。

### 4.4 房间生命周期要处理「人」的异常，不只是「牌」

上一版 README 第 9 组测试列的 11 个真实场景，全部是**人造成的状态异常**：

> 五个玩法各跑一局 · 连玩三局（跨局残留）· 换玩法再玩 · 有人退出又回来（座位空洞）
> · 有人来晚了（观战者的空骰子会让这局**永远结束不了**）· 房主走了（观战者接任会卡死）
> · 都走了（号码回收）· 房间满了（不留痕）· 换牌代价（博弈核心的数字）×12 人 / 8 人上限

文档里有一句判断很准确：「**这些场景第一次、一个人、按顺序玩都不会出现** —— 而这恰好是最容易只测到的那种用法。」

### 4.5 单云函数承载全部游戏逻辑

`cloudfunctions/room/` 用**一个云函数 + 14 个模块**承载 5 个玩法，而不是每个玩法一个云函数。

**取舍**：单函数的好处是冷启动只发生一次、共享房间状态与玩家表、部署只需一条命令；坏处是 `index.js` 会变成巨大的 `switch`，且**云函数包体积与依赖被所有玩法共同承担**。当前选择前者，因为玩家人数少、房间状态需要跨玩法保留（换玩法不换房）。

---

## 五、玩法与参数表

### 5.1 云函数配置（源文件）

`cloudfunctions/room/config.json`：

```json
{
  "timeout": 20,
  "permissions": { "openapi": [ "security.msgSecCheck" ] }
}
```

`cloudfunctions/initdb/config.json`：

```json
{ "permissions": { "openapi": [ "security.msgSecCheck" ] } }
```

`cloudfunctions/bootstrap/config.json`：

```json
{ "permissions": { "openapi": [] } }
```

`cloudfunctions/*/package.json` 的依赖统一为 `wx-server-sdk: ~2.6.3`。

> **关键事实**：`room/config.json` 里写 `timeout: 20`，但上一版 README 明确记录「`config.json` 里写 `timeout: 20` 云端不认（实测部署后还是 3）。只能去云开发控制台改」。也就是说这份配置里的 `timeout` **是死配置**，实际生效的是控制台里的 3 秒——详见「九、已知问题」。

### 5.2 小程序侧关键参数

| 参数 | 值 | 出处 | 说明 |
|:---|:---|:---|:---|
| 云环境 ID | `cloudbase-d4goh1zdtc8eb9708` | 上一版 README 快速开始 | 部署命令的 `--env` 参数 |
| 云函数名 | `room` | `cloudfunctions/room/` | 部署命令的 `--names` 参数 |
| 部署方式 | `--remote-npm-install true` | 上一版 README | 云端装依赖，本地 `node_modules` 已 gitignore |
| 房间号长度 | 3 位 | 上一版 README 首段 | 输号进房 |
| 主包体积 | 约 770 KB | 上一版 README | 含 580 KB 音频 |
| 分包体积 | 约 660 KB | 上一版 README | 房间页 + 卡片/骰子/骰盅图 |
| 音效数量 | 35 个 | 上一版 README 目录说明 | 自合成 + Kenney CC0 |
| 音频体积 | 580 KB | 上一版 README 已知限制 | 不能进分包 |
| 调试工具 | `miniprogram-automator: ^0.12.1` | `.tooling/package.json` | 真机/模拟器自动化 |
| 自动化端口 | `9420` | `.tooling/cases/README.md` | `cli auto --project <p> --auto-port 9420` |
| `soloTest` | `true` | 上一版 README 已知限制 | **正式上线前必须改 false** |

### 5.3 人数上限（来自测试场景，非配置项）

上一版 README 第 9 组测试场景里出现「12 人卧底、8 人比大小」「×12 人 / 8 人上限」，说明两个玩法的人数上限分别是 **12** 与 **8**。这两个数字来自测试判据，**未在配置文件中出现**，如要改动请以 `miniprogram/utils/games.js` 的注册表为准。

---

## 六、快速开始

### 前置条件

| 项 | 要求 |
|:---|:---|
| 开发者工具 | 微信开发者工具（macOS 路径示例：`/Applications/wechatwebdevtools.app/Contents/MacOS/cli`） |
| 云开发 | 已开通，环境 ID 与 `miniprogram/config.js` 一致 |
| Node.js | 跑 `scripts/*.js` 测试与渲染需要；`.tooling` 需要 `npm install` |
| Python 3 | 跑 `scripts/*.py`（音频生成、几何检查、截图联系表） |
| AppID | 在 `project.config.json` 中 |

### 1. 打开工程

```bash
# 用微信开发者工具打开本目录（AppID 在 project.config.json）
# 云开发环境：cloudbase-d4goh1zdtc8eb9708
```

### 2. 部署云函数

改了 `cloudfunctions/` 就要做一次：

```bash
CLI="/Applications/wechatwebdevtools.app/Contents/MacOS/cli"
$CLI cloud functions deploy --project "$(pwd)" --env cloudbase-d4goh1zdtc8eb9708 \
  --names room --paths "$(pwd)/cloudfunctions/room" --remote-npm-install true
```

### 3. 改完代码先跑测试，再部署

```bash
bash scripts/test-all.sh    # 15 组 / 380 项，全部离线（不启动 GUI）
bash scripts/check.sh       # 前后端一致 + 部署前检查
```

`check.sh` 每次都会提醒 `soloTest` 是否仍为 `true`。

### 4. 装真机自动化依赖（可选）

```bash
cd .tooling && npm install     # 只装 miniprogram-automator，约 27MB
```

`.tooling/node_modules/` 已在 `.gitignore` 中；`package-lock.json` 保留，用于锁住版本复现同一套工具链。

---

## 七、测试体系

**全部离线**，不需要打开开发者工具：

```bash
bash scripts/test-all.sh
```

| 组 | 覆盖 |
|:---|:---|
| 1 | 牌型算法（穷举 22100 手，对组合数学） |
| 2 | 游戏逻辑（转盘前后端一致、摇盅五步） |
| 3 | 多人房间（房间码 / 骰子隔离 / 房主转移 / 单人路径 / 幂等） |
| 4 | 骰盅几何（偷看时骰子真的露得出来） |
| 5 | 房间页状态机（phase→stage 唯一出口） |
| 6 | 反馈时间轴 + 错误反馈（音画同步、不许静默吞错） |
| 7 | 字段契约（图标尺寸 / 死绑定 / 幽灵字段 / 死功能 / 对比度 / 文案数字与代码一致） |
| 8 | 音效响度层级（扣盅必须压过铺垫） |
| 9 | **11 个真实场景**：五个玩法各一局，外加连玩三局、换玩法、中途退出又回来、来晚了观战、房主走了、人都走了、房间满了、换牌代价、12 人卧底、8 人比大小 |

`scripts/` 下与测试相关的脚本（均存在于仓库中）：

| 脚本 | 验证对象 |
|:---|:---|
| `test-all.sh` | 总入口 |
| `test-poker.js` / `test-dicerank.js` / `test-liarcount.js` / `test-loser.js` / `test-between.js` / `test-consensus.js` | 各规则模块 |
| `test-game.js` / `test-flows.js` / `test-mock.js` / `test-race.js` / `test-recent.js` / `test-pool.js` | 房间生命周期与并发 |
| `test-bidoptions.js` / `test-firsthint.js` / `test-feedback.js` / `test-error-feedback.js` / `test-errlog.js` | 交互与反馈 |
| `test-assets.js` / `test-cup-geometry.js` / `test-page-coverage.js` / `test-contract.js` / `test-docs.js` | 资源、几何、页面覆盖、字段契约、文档同步 |
| `check-sync.js` / `check-actions.js` / `check-css-applied.js` / `check-claims.js` / `check-branch-owner.js` / `check-docs-sync.py` | 前后端一致、样式生效、文档与代码一致 |
| `check-audio-overlap.py` / `check-audio-tail.py` / `check-audio-variants.py` / `check-audio-levels.py` | 音频重叠、尾巴、变体、响度 |
| `check-text-overflow.js` / `check-lobby-fit.py` / `check-wheel-pixel.py` | 文本溢出、大厅适配、转盘像素级对位 |

> 上面「测试 15 组 / 380 项」这个数字来自上一版 README；`scripts/test-all.sh` 的分组实现以源码为准，**项数请以实际运行结果为准**。

**第 9 组最值得看**：它的判据不是「某个函数对不对」，而是「真实的一桌人会怎么用它」。上一版 README 特别强调：这些场景第一次、一个人、按顺序玩都不会出现，而这恰好是最容易只测到的那种用法。

---

## 八、真机验证

`.tooling/cases/README.md` 记录了 5 个真机用例，用 `node .tooling/probe.js --file .tooling/cases/<名字>.js` 跑，需要开发者工具的自动化端口：

```bash
cli auto --project <路径> --auto-port 9420
```

| 文件 | 验什么 | 期望 |
|:---|:---|:---|
| `liar-full.js` | 大话骰：偷看 → 点叫法 | `liarReady=true`、24 个叫法、点「3个1」后 bid 精确是 `{n:3,face:1}` |
| `dice-streak.js` | 比大小连玩 3 局 | 每局都 `phase=over`，骰子各不同 |
| `poker-streak.js` | 金花连玩 2 局 | 换牌有效；第二局喝量从 0.5 重新开始 |
| `offline-lobby.js` | 上线态（`soloTest:false`）五玩法 | 四个显示「叫 N 个人来」，转盘显示「开始（1 人）」 |
| `wheel-full.js` | 转盘完整流程 | 主按钮「开始（1 人）」→ 开局 → 转出真实结果 |

**2026-10-30 的实测结果**（逐字摘自 `.tooling/cases/README.md`）：

```text
liar-full      stage=playing 骰子=0 → 偷看 liarReady=true → 24 个叫法
               → 点「3个1」bid={n:3,face:1}   ✓
dice-streak    [5,5,4,6,3] / [6,2,6,6,1] / [1,1,6,5,3]   ✓
poker-streak   ♥J→♣K 喝0.5 / ♥3→♦10 喝0.5（第二局重置）✓
offline-lobby  liar/dice/poker 叫1人 · undercover 叫2人 · wheel「开始（1人）」✓
wheel-full     wheelText="你喝"，像素验证距指针 4.1°       ✓
```

**踩过的坑**（`.tooling/cases/README.md` 逐字「共同约束」）：

- **一次 evaluate 只做一件事**。跑 5 局要塞进一次 evaluate → `timeout waiting for automator response`。实测 8 秒的 evaluate 没问题，60 秒的不行。
- **tabBar 页用 `switchTab`**，`navigateTo` 会静默失败（`currentPage().path` 还是上一页）。
- **选择器必须 grep 真实类名**，写错只会返回 0 个元素，和「产品真没有」一模一样。
- **固定 `sleep` 要换成轮询到条件成立**（`e2e-ui.js` 就因为赌 `sleep(3200)` 而偶发失败）。

---

## 九、已知问题与限制

| # | 问题 | 现状 / 影响 | 依据 |
|:---|:---|:---|:---|
| 1 | **GitHub 描述仍是旧项目** | 仓库描述写「我们的小窝 · 只属于两个人的微信小程序（随手记 / 编年史 / 时间胶囊 / 要记得的事）」，与 2026-10-27 后的酒桌游戏完全不符，需要改仓库描述 | 仓库元数据 vs 仓库内转向说明 |
| 2 | **`project.config.json` 的 description 仍是旧项目** | 工程配置里的描述没有随转向更新，开发者工具里看到的项目名还是情侣 App | 仓库工程配置 + 仓库内转向说明 |
| 3 | **云函数超时 3 秒，配置里的 20 不生效** | `cloudfunctions/room/config.json` 写 `timeout: 20`，实测部署后云端仍是 3 秒，**只能去云开发控制台改**。现在靠「启动 + 进大厅 + 进房间都发一次 ping」顶住冷启动 | `cloudfunctions/room/config.json` + 上一版 README 已知限制 |
| 4 | **音频不能进分包** | `sfx.js` 被大厅和「我的」直接使用且真的播放（进房 whoosh、开关试听 tick），而微信规则是「分包可引用主包、主包不能引用分包」，所以 580 KB 音频只能留主包 | 上一版 README 已知限制 |
| 5 | **`gap` 需要 iOS 14.5+** | 更老的系统上间距会消失 | 上一版 README 已知限制 |
| 6 | **单人开局是测试开关** | `config.js` 的 `soloTest: true`。**正式上线前改成 false**，否则用户可以单人开始任何玩法；`check.sh` 每次会提醒 | 上一版 README 已知限制 |
| 7 | **云函数仍带旧项目命名** | `cloudfunctions/bootstrap/package.json` 与 `cloudfunctions/initdb/package.json` 的 `description` 仍是「我们的小窝 · bootstrap」「我们的小窝 · initdb」，属转向遗留 | 两个 `package.json` |
| 8 | **旧版文档仍在仓库里** | `docs/archive/README-情侣版-v2.md`、`docs/archive/v2-情绪冷静期.md` 是已删功能的历史文档。它们**不是规格**，但容易被新接手者误读为待实现需求 | 仓库文件树 + 仓库文档说明 |
| 9 | **仓库体积 105 MB，远超源码体积** | 仓库体积 107779 KB。`.gitignore` 已排除 `outputs/`（167 个 PNG 共 32MB）与 `.tooling/node_modules/`（27MB），但历史提交里仍留着大体积产物，克隆会慢 | 仓库元数据 + `.gitignore` |
| 10 | **未声明许可证** | 根目录无 LICENSE 文件，也未在文档中声明许可。公开仓库不等于可自由复用，二次使用前需联系作者 | 仓库元数据 |
| 11 | **测试项数请以运行结果为准** | 「15 组 / 380 项」来自上一版 README，`test-all.sh` 的分组请以源码与运行结果为准 | 以运行结果为准 |
| 12 | **人数上限只有测试口径** | 「12 人卧底 / 8 人比大小」出现在测试场景描述里，未在配置文件中出现；真实上限以 `miniprogram/utils/games.js` 注册表为准 | 以注册表为准 |
| 13 | **云函数单点** | 5 个玩法共用 `cloudfunctions/room/` 一个函数，任何玩法改动都要整包重新部署，且冷启动成本由所有玩法共同承担 | 仓库文件树 + 目录说明 |
| 14 | **前后端规则双副本靠脚本保同步** | `poker.js` 等 10 个规则文件在 `miniprogram/utils/` 与 `cloudfunctions/room/` 各一份，靠 `check-sync.js` / `sync-derive.sh` 保证一致；漏跑检查就会漂移 | 仓库文件树 + `scripts/` 脚本清单 |

---

## 十、该看哪些文档

`docs/` 下有 **55 个文件**，别试图一次读完。按需查：

| 文件 | 什么时候看 |
|:---|:---|
| `AGENTS.md` | **开工前必读** —— 工作方式、判据、踩过的坑（有预算上限，别乱追加） |
| `docs/真机验收清单.md` | 上真机验收时按这个走 |
| `docs/素材来源与许可.md` | 上线合规 / 换素材前 |
| `docs/大话骰规则.md`、`docs/规则依据.md` | 改玩法规则前 |
| `docs/玩法调研与取舍.md`、`docs/玩法决策密度.md`、`docs/玩法调研-第4~8轮.md` | 想加新玩法时看前人的取舍记录 |
| `docs/research/` | 玩法手感、动效、音频、竞品拆解（8 份，2026-10-28 前后） |
| `docs/发布检查清单.md`、`docs/上线操作卡.md`、`docs/待部署清单.md` | 真要上线时按顺序走 |
| `docs/云端action权限表.md` | 改云函数 `action` 分发时对照 |
| `docs/排查-开不了房间.md` | 房间创建失败时先看这份 |
| `docs/archive/` | **历史，不是规格** |
| `assets-staging/README.md` | 素材已备好但玩法未接入时，看这里的放置规则 |

---

## 十一、归属与许可证

- **归属**：本仓库为作者邓林的个人项目，原创代码，**非第三方副本**。
- **许可证**：**根目录无 LICENSE 文件**。未声明任何开源许可，默认保留所有权利；引用、分发或商用前请先联系作者。
- **第三方素材**：上一版 README 记音效为「自合成 + Kenney CC0」，图片为项目内渲染生成（`scripts/render-*.py` 系列）。Kenney 素材的具体条目与许可文本见 `docs/素材来源与许可.md`——**该文件是上线合规的唯一依据**，换素材前必须重读。
- **运行依赖**：微信小程序框架、微信云开发（`wx-server-sdk ~2.6.3`）、`miniprogram-automator ^0.12.1`（仅调试用）。这些依赖的权利归各自原作者，不在本仓库范围内。
- **数据**：云开发环境 `cloudbase-d4goh1zdtc8eb9708` 中的房间与玩家数据不属于源码仓库内容。
