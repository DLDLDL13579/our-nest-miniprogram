# 同类优秀产品拆解：多人聚会 / 酒桌游戏做到什么程度

- 拆解日期：2026-10-28
- 拆解人：产品拆解员（子代理）
- 对照对象：本仓库「酒桌」小程序 v3.x（大厅 / 房间 / 我的，5 个玩法，云函数 `room`）
- 输出目的：产出一份**可直接照着补**的差距清单，而不是"体验很好"式的评语

> **证据纪律（读之前先看这条）**
> 1. 本文每一条具体结论后面都带来源。来源分三级：
>    - **一手**：官方文档 / 官方博客 / 官方帮助页 / 官方应用商店描述
>    - **二手**：科技媒体报道、评测文章、wiki
>    - **旁证**：同类产品的开源复刻或第三方分析文章 —— 只能说明"这个品类的通用构成"，**不能当成该产品的官方事实**
> 2. **凡公开资料里查不到的，一律写「未确认」，不写推测。** 尤其是：动画时长、缓动曲线的具体数值、音效的触发次数、结算页的控件排布 —— 这些只有拿到真机或安装包才能确认，本文不编。
> 3. 有一处需要特别提醒：**Houseparty 已于 2021 年 10 月关停**，App 已从商店下架，所以它的界面描述全部来自关停前的图文教程与评测；无法复现验证，可信度低于仍在运营的产品。

---

## 0. 先看这 6 条（最值得抄的）

1. **Jackbox 把"网络延迟"当成设计对象，而不是当成 bug。** 它有一个叫 **count-in** 的机制：歌曲开始前让每个玩家在自己**听到**音乐的那一刻点一下屏幕，用这个点击对齐各自的时钟 —— 官方说这套机制"即使在 Twitch / YouTube / Discord 串流的极端延迟下也有效"。断网或有人暂停时，音乐暂停、**全员重新 count-in** 才继续。（[Jackbox 工程博客](https://www.jackboxgames.com/blog/behind-the-scenes-of-pp10-engineering)）
   → 我们现在的倒计时是"服务端给时间戳 + 1.5 秒轮询"，各台手机最多差 1.5 秒。这不是"不够准"，是**同一桌上两个人看到的秒数不一样**。这是最该抄的一条。
2. **Jackbox 有 `No Timer Mode`：不设倒计时，等所有玩家都提交才推进。** 官方原文是 "All players must submit answers and votes to move on"。（[Jackbox PP8 功能说明](https://www.jackboxgames.com/blog/streaming-moderation-accessibility-features-jackbox-party-pack-eight)）
   → 这条直接命中本项目的铁律①：酒桌上"大家聊完了没有"只有桌上知道，服务端不该抢着推进。
3. **腾讯系棋牌的音效是分层的，不是"一个动作一个音"。** 公开复刻项目把《欢乐斗地主》的音频拆成 6 类：**背景音乐、抢/叫地主提示音、发牌音、选牌音、牌型与点数提示音、剩牌数提示（只剩 1~2 张时）**。（[爱编程的大丙·斗地主项目大纲](https://subingwen.cn/project/landlord)，**旁证**：教学复刻，非腾讯官方文档）
   → 我们 35 个音效全是"动作音"，没有一个是"**状态音**"（还剩几张、轮次进度、危险临近）。这是廉价感的重要来源。
4. **所有成熟产品都有"降级开关"，而不是只有"更多特效"。** Jackbox 设置里同时提供 **Motion Sensitivity（动效敏感度）**、**Extended Timers（延长倒计时）**、**No Timers（无倒计时）**、**Subtitles（字幕）**，以及 Audio/Video 分区里的**多种音量**调节。（[Jackbox PP10 无障碍说明](https://www.jackboxgames.com/blog/accessibility-features-in-the-jackbox-party-pack-10)）
   → 我们只有"音效开关 + 震动开关"两个布尔值。**没有"减少动效"这一档**，而这个开关恰恰是酒桌场景最需要的（有人晕动、有人嫌花）。
5. **微信小程序有两条硬约束会直接决定同步方案，而现在都没被利用。** 官方文档写明：`wx.connectSocket` **最多 5 个并发**；小程序**进入后台 5 秒**内网络请求没结束就回调 `fail interrupted`，且**回到前台之前所有网络接口都调不了**。（[微信·网络](https://developers.weixin.qq.com/miniprogram/dev/framework/ability/network.html)、[wx.connectSocket](https://developers.weixin.qq.com/miniprogram/dev/api/network/websocket/wx.connectSocket.html)）
   → 酒桌场景就是不停锁屏 / 切微信回消息。**现在的代码没有 `onHide` 停轮询、`onShow` 立即补一次**，等于每次亮屏都要白等最多 1.5 秒才看到别人做了什么。
6. **Heads Up! 只用了一个传感器动作，却做成了千万级下载的产品。** 交互只有两条：**手机朝下倾斜 = 答对，朝上倾斜 = 跳过**；一局 **60 秒**，答对 1 分，倒计时结束结算。（[App Store 描述](https://apps.apple.com/us/app/heads-up/id623592465)、[wikiHow 规则](https://www.wikihow.com/Play-Heads-Up!)）
   → 但它的评论区有一条反复出现的抱怨：**"倾斜不灵敏 / 有 bug，希望能改成按钮"**（[Google Play 评论](https://play.google.com/store/apps/details?id=com.wb.headsup)）。**传感器交互的失败态必须手动兜底**，这条对我们做"按住才看""摇一摇"类交互是直接警告。

---

## 1. 逐个拆解

每个对象按同一套 7 个维度拆：**界面构成（前/中/后）、动效、音效、节奏、多人同步、失败态、付费与留存**。
凡表格里写「未确认」的，就是公开资料确实查不到，不要当成"他们没做"。

### 1.1 Plato（多人聚会游戏平台，含聊天）

来源主入口：[官网](https://platoapp.com)、[App Store](https://apps.apple.com/us/app/plato-fun-multiplayer-games/id1054747306)、[官方 games 目录](https://platoapp.com/en/games)、[Indian Express 评测](https://indianexpress.com/article/technology/tech-reviews/ie-app-reviews-plato-games-group-chats-7211004)、[CB Insights 产品描述](https://www.cbinsights.com/company/plato-team)、[官方 Facebook 关于 rooms 的说明](https://www.facebook.com/platochat/posts/if-you-head-over-to-the-rooms-tab-in-plato-youll-notice-that-more-rooms-based-ar/2639070676106903)

| 维度 | 他们做到的 | 证据强度 |
|---|---|---|
| **开局前** | 主界面：左上角是**个人资料按钮**，底部是**几个 tab** —— 官方评测的原话是"a quick button to your personal profile on the top left, and a few tabs on the bottom"。**没有"输入房间号"这个步骤**：建房后生成的是**可分享链接**，走 WhatsApp / Facebook / Snapchat / Instagram 快捷分享 | 二手（评测）+ 一手（官方贴） |
| **开局前（房间）** | 房间可以**上锁**防止陌生人闯入（官方原文："hosts can opt to lock rooms to new guests to prevent party crashers"）；有用户评论称**一个房间只能放 3 个游戏**（"Only 3 games are allowed in the rooms"） | 一手 + 二手（用户评论，未在官方文档确认） |
| **开局中** | 走子**实时更新**，同时**每一步也作为聊天消息发出去**（官方描述："All game moves are updated live, and also sent as chat messages for those that prefer asynchronous play"）。**支持旁观**（spectator），旁观者留在群里继续聊天 | 二手（CB Insights 转述公司资料） |
| **动效** | **未确认**。公开资料没有对 Plato 动画时长/曲线的任何描述 | — |
| **音效** | **未确认**。没有任何资料描述 Plato 的音效构成或是否有语音 | — |
| **节奏（几步到开局）** | 按官方教程视频：**选游戏 → 点 "create new game" → 选模式/人数/设置 → 分享链接**，即约 **3~4 次点击**后进入等待。等待时长取决于朋友点链接的速度，无固定值 | 二手（YouTube 教程 + 官方贴） |
| **多人同步** | 实时（"live"），具体是长连接还是轮询**未确认**。有一条重要设计：**动作同时进聊天流**，所以"别人做了什么"不是靠界面刷新发现的，而是靠**一条消息** | 二手 |
| **失败态** | 只有间接证据：App Store 评论里大量抱怨"**大房间游戏最难成局，因为 99% 的情况有人中途加入然后退出**"（原文："99% of the time there is a player that joins and then leaves right in the middle"）。官方**没有**公开的中途退出处理说明 → 处理方式**未确认** | 二手（用户评论） |
| **付费/留存** | 有 **Ad-Free / Premium 订阅**与**金币内购**（App Store 内购项含 1000 Coins）。留存靠**排位赛、玩家自办锦标赛、排行榜**（官方描述："competitive ranked games to player-run tournaments... Climb the leaderboards"）。⚠️ 检索到的 "$49/月" 疑似与运营商套餐页面串了，**该价格未确认** | 一手（商店）+ 二手 |

**可抄的一条**：**"动作 = 消息"**。把别人的操作变成聊天流里的一条，比让界面"悄悄变一下"强得多 —— 因为桌上的人本来就在说话，他们需要的是"谁干了什么"的一句话，而不是一个被重新渲染的棋盘。

---

### 1.2 Houseparty（已关停，资料充足）

> ⚠️ 已于 2021-09-09 宣布关停、10 月下线并从商店下架（[Wikipedia](https://en.wikipedia.org/wiki/Houseparty_(app))、[华盛顿邮报](https://www.washingtonpost.com/video-games/2021/09/09/houseparty-shut-down-epic-games-metaverse)、[TechCrunch 转述](https://www.failory.com/cemetery/houseparty)）。以下全部来自关停前的教程与评测，**无法真机复现**。

来源主入口：[Business Insider 使用指南](http://www.businessinsider.com/how-to-use-the-houseparty-app-2016-12)、[Business Insider 产品说明](https://www.businessinsider.com/guides/tech/what-is-houseparty-app)、[AgeSpace 图文教程](https://www.agespace.org/tech/how-to-use-houseparty)、[Time Out 游戏清单](https://www.timeout.com/newyork/news/the-six-best-houseparty-games-to-play-with-friends-050420)

| 维度 | 他们做到的 | 证据强度 |
|---|---|---|
| **开局前** | 主界面是**好友在线列表**，"在屋里"的人名字旁边有**加入图标**，点一下就进去。**没有房间号**——进房靠"看到谁在线 → 点加入"。房间**上限 8 人** | 二手（两家媒体一致） |
| **开局前（房间内）** | 底部一排控制：**锁房（挂锁图标）**、静音、关摄像头、分享屏幕。锁房点一下上锁、再点解锁，锁定后会有**底部弹条提示**"去哪里解锁" | 二手 |
| **开局中（游戏入口）** | **右上角一个骰子图标** → 弹出 4 个游戏：**Heads Up、Trivia、Chips and Guac、Quick Draw**。游戏是**在视频通话之上叠一层**，不是切走页面 | 二手（两家一致） |
| **游戏内界面** | 画面**按人数分屏**，**自己的画面永远是最大的那块**；人数为奇数时也保持自己最大。Chips and Guac 的玩法是"一人出描述卡，其余人出自己认为匹配的卡"（官方版 Cards Against Humanity 式） | 二手 |
| **动效** | **未确认** | — |
| **音效** | **未确认**具体音效；但有一手线索：**"有人在屋里"会即时提醒**（原文："those who are 'in the house' can be instantly alerted as others join"）——**提醒的形式是音效还是横幅，未确认** | 二手 |
| **节奏** | 打开 App → 看到在线好友 → 点加入（**1 次点击**）→ 进房。游戏入口是骰子图标（**+1 次**）→ 选游戏（**+1 次**）。**这是本文所有对象里"到第一局"点击次数最少的：约 3 次** | 二手 |
| **多人同步** | 视频是实时流（WebRTC 类），具体的信令方案**未确认** | — |
| **失败态** | 有一手设计证据：**一局结束后游戏自动关闭**（原文："Games will automatically close after you have finished a round"），要提前退就点右上角 **X**。也就是说**"结束"不需要玩家去点"返回"** —— 失败/结束态由系统自动收尾。掉线处理**未确认** | 二手 |
| **付费/留存** | 有内购（"in-app purchase options for those who want more than the basic features"），具体卖什么**未确认**。留存主要靠**社交关系本身**（在线状态、"schedule a party"预约、Facemail 离线视频留言） | 二手 |

**可抄的两条**：
- **"自己的画面最大"**：映射到我们就是**"我的牌/我的骰子永远是视觉主体"**，别人的信息只占边角。现在的房间页在多人时会平均分配注意力，这是反直觉的。
- **"一局结束自动关闭，不需要点返回"**：和本项目的"服务端自动推进"是同一个思路，方向是对的，应该继续加固（见差距清单第 17 行）。

---

### 1.3 Jackbox Party Pack 系列（本文证据最扎实的对象）

来源主入口（全部一手）：
[官方 How to Play](https://www.jackboxgames.com/how-to-play)、[工程幕后（含 count-in）](https://www.jackboxgames.com/blog/behind-the-scenes-of-pp10-engineering)、[音频幕后](https://www.jackboxgames.com/blog/behind-the-scenes-of-pp10-audio)、[PP10 无障碍说明](https://www.jackboxgames.com/blog/accessibility-features-in-the-jackbox-party-pack-10)、[PP8 串流/审核/无障碍说明](https://www.jackboxgames.com/blog/streaming-moderation-accessibility-features-jackbox-party-pack-eight)、[Wikipedia 系列条目](https://en.wikipedia.org/wiki/The_Jackbox_Party_Pack)

| 维度 | 他们做到的 | 证据强度 |
|---|---|---|
| **开局前（房间码）** | 主持端选游戏按 start → 屏幕上出现**四字母房间码** → 玩家在**自己手机浏览器**打开 `jackbox.tv` → **输 4 位码 + 输名字 + 点 play**。**玩家不需要买游戏**（一份买断、多人参与） | 一手（官方 How to Play + 官方教程视频） |
| **开局前（大厅）** | 有一个明确的 **lobby room**（"This room is where you and your players gather before hitting start"）。第一个进房的人被称为 **VIP**，**VIP 可以跳过 intro / 教程**（"the first player in (VIP) can still skip the intro/tutorials in the moment"） | 一手 |
| **开局中** | 控制器（手机）**只显示"这一下要做什么"**，大屏负责演出。手机端有独立的"controller mix"（音频混音），与游戏主混音**分开** | 一手（音频幕后原文提到 "the regular game mix and the controller mix as well"） |
| **人数与观众** | 多数游戏 **2~8 人**；**Audience（观众）可加入并影响结果**，官方量级说法是"up to 10,000"，但 Jackbox Wiki 另有一处写"Audience caps at 200 players" —— **两个数字冲突，具体上限未确认** | 一手 + 二手（冲突已标注） |
| **动效** | 有一手证据说明**动效是专门设计的资产**：博客里出现 "Final Round bumper"（终局转场）与 "final score screen"（结算页）的**概念设计稿**，作者署名到具体美术。此外提供 **Motion Sensitivity** 开关 —— **能关，说明有**。**具体时长与曲线未确认** | 一手 |
| **音效** | **每个游戏有专属 Audio Lead**，一人同时负责音乐与音效；**Picker 和 Loader（开机/选游戏）也有专门音乐**；大厅（lobby）有独立曲目（原声带里 "Lobby" 单曲 **2:02**）；**教程（Tutorial）有独立曲目**；**片尾有带人声的 credits song**；甚至有**只有约 30% 概率播放的隐藏曲目**（音频 Lead 原话："set to play only about 30% of the time"） | 一手（音频幕后 + 原声带条目） |
| **音效（设置层）** | Audio/Video 设置区里可以"**调整多种音量**"（"Adjust various volume settings"）；另有 **Subtitles（字幕）**开关 —— **说明有语音/人声播报，且做了字幕** | 一手 |
| **节奏** | 官方 4 步：买装 → 选游戏按 play（**开出大厅**）→ 玩家输码进大厅 → 主持端按 start。**玩家侧只有"输码+输名+play"三步**，而且是**浏览器**，不用装 App | 一手 |
| **多人同步（最有价值）** | ① **count-in 延迟补偿**：每个玩家在自己听到音乐起拍时点一下，用来对齐设备与游戏之间的延迟；官方称**串流到 Twitch/YouTube/Discord 的极端延迟下也有效**。② 断网或有人暂停 → **音乐暂停，全员重新 count-in** 才恢复。③ 曲终后**要额外等待**，因为延迟导致玩家还没弹完 | 一手 |
| **失败态** | 由上面三条直接构成：**暂停/断网 = 回到一个可恢复的同步点**（重新 count-in），而不是"报错退出"。另外**No Timer Mode**（等所有人提交）本身就是"有人慢半拍"的制度化解法 | 一手 |
| **付费/留存** | **一次性买断 + 每年一个新 Pack**（2014 起近乎年度，PP11 于 2025-10-23 发售），每 Pack 5 个游戏；另有合集打包折扣。留存靠**"每年一次的新内容 + 朋友聚会这个固定场景"**，不靠日常打卡 | 一手（Wikipedia + Steam 商店页） |
| **运营层（可抄）** | 游戏**每次启动下载一个 config 文件**，用来远程调参。举例：判定"完美"的容差是**多少毫秒**、每个难度给多少分、存活需要多少准确率。他们**把容忍度调了 5%**，玩家存活率就上升了 | 一手 |

**可抄的三条**：
1. **count-in 的对齐思想**（不必是音乐，任何"同时开始"都能用）。
2. **把"完美判定"做成可远程调的毫秒数**：我们现在把 420ms / 340ms / 280ms 写死在 `feedback.js`，改一次要发版。应该抽成云端可下发的配置（默认值兜底）。
3. **隐藏内容**（30% 概率）—— 极低成本的复玩理由。

---

### 1.4 腾讯《欢乐斗地主》/ 微乐游戏（视角：手机端棋牌的手感）

> **证据说明（重要）**：腾讯从未公开《欢乐斗地主》的交互/音频设计文档。本节关于"手感构成"的拆解，主要依据两份**旁证**：
> - [爱编程的大丙·斗地主项目大纲](https://subingwen.cn/project/landlord)：一个公开的、照《欢乐斗地主》做的教学复刻项目，把窗口/音频/动画**按类拆开列了清单**。它能说明"这个品类的标准构成"，但**不能证明腾讯线上版本就是这样**。
> - [2011 年腾讯无线设计师 echo 的《QQ 欢乐斗地主游戏 UI 设计经验分享》](http://www.missyuan.net/web/201109/5518.html)：一篇腾讯设计师的公开分享（转载页编码为 GBK，正文可读性差，本文只取其中能确认的表述）。
>
> 微乐部分依据官方商店页与用户评论。

| 维度 | 他们做到的 | 证据强度 |
|---|---|---|
| **开局前** | 主界面是"玩法入口集合"，顶部有**玩家信息/货币**，中间是玩法卡（斗地主、掼蛋、跑得快、够级…），底部是活动/商城。**微乐的商店描述明确列了"几十种热门玩法一键解锁"** —— 品类做宽是它的核心策略 | 一手（微乐 App Store 页）+ 旁证 |
| **开局中（手牌区）** | **每一张牌都是一个独立对象**，有自己的"选中/未选中"状态与正面/背面 —— 这是"能框选、能拖动"的前提。**分数面板在右上角**，常驻显示三家的得分 | 旁证（复刻项目按类拆解） |
| **开局中（倒计时）** | **出牌倒计时 20 秒**，超时**系统默认不出、直接跳过**，不是报错也不是卡住 | 旁证（复刻项目参数） |
| **开局中（特效）** | 有一个专门的**"特效动画窗口"**，只为**特殊牌型**服务：**王炸、炸弹、飞机、顺子、连对**。也就是说：**普通出牌没有全屏特效，只有"大牌"才有** | 旁证 |
| **音效（最值得抄的一层）** | 音频被拆成 **6 类，按"事件类型"而不是按"界面"分**：<br>① 背景音乐<br>② 抢地主 / 叫地主 提示音乐<br>③ **发牌**音乐<br>④ **选牌**音乐（点牌的反馈）<br>⑤ **牌型、点数提示**音乐（这一手是什么牌）<br>⑥ **剩余牌量提示**（只剩一张或两张时） | 旁证 |
| **音效（设置）** | 有独立的 BGM 控制类，说明**音乐与音效是两套可控通道** | 旁证 |
| **动效** | 除了特殊牌型特效，**未见**对普通出牌动画的公开描述 → 具体时长/曲线 **未确认** | — |
| **节奏** | 大厅 → 选玩法 → 匹配/建房 → 发牌。发牌本身是**有节奏的动画**（对应 ③ 发牌音） | 旁证 |
| **多人同步** | 回合制，**由服务端判定轮次与超时**（20 秒到了服务端替玩家 pass）。客户端只负责表现 | 旁证 |
| **失败态（真实痛点）** | 微乐/同类产品的用户评论反复出现同一类问题：**队友挂机导致 2 打 1，本局还不能解散**（原文："我方队友在经典过A比赛中突然挂机了…当对手不同意解散牌局，我方只能是我一个人和对方2人打到底，这就很不公平和浪费时间"）。另有大量"**全是机器人**"的质疑（关于发牌算法） | 二手（App Store 真实评论） |
| **付费/留存（微乐）** | 高频**赛季制**（S12→S15）、**限定皮肤/牌桌特效**、**角色系统**、**IP 联动**（大话西游、乡村爱情、马保国）、**七日签到**、**福利赛**。货币至少三档（微乐币 / 钻石 / 璀璨币）。另有一条合规设计：**"游戏时长 3 小时后收益减半"**（[人民网 2019 报道](http://jinbao.people.cn/n1/2019/1015/c428398-31401860.html)） | 一手（商店页）+ 二手（媒体） |
| **付费/留存（欢乐斗地主）** | 欢乐豆经济 + 每日任务 + 段位。具体机制细节**未确认** | — |

**可抄的两条**：
1. **"只有大牌才给特效"**：把视觉预算集中到少数高光时刻。我们现在是"每颗骰子落定都有动画"，反而把重音稀释了。
2. **第 ⑥ 类音效（剩牌提示）**：这是"**状态音**"——它不是回应某个动作，而是**在危险临近时提醒**。酒桌上等价物是"只剩 1 个人没投""轮到你""还有人没摇"。

---

### 1.5 微信小程序里的酒桌 / 聚会游戏（同类现状）

这一节的对象就是"和我们一样的东西"，所以我尽量找**有公开界面描述**的，避免空谈。

来源主入口：
[爱范儿·聚会神器评测](https://www.ifanr.com/minapp/1236504)、[知乎·KTV 喝酒摇骰子小程序](https://zhuanlan.zhihu.com/p/137753522)、[GitHub·酒桌 Gameing（taro-weapp）](https://github.com/YTU94/taro-weapp)、[CSDN·喝酒神器摇骰子小程序源码](https://blog.csdn.net/tui_guige/article/details/124522700)

| 维度 | 同类做到的程度 | 证据强度 |
|---|---|---|
| **开局前（导航）** | 「聚会神器」把玩法分成**四个板块**："玩心跳 / 比技术 / 秀神器 / 更多"，一屏看到全部入口。**没有搜索、没有分类筛选** | 二手（爱范儿评测，实机截图） |
| **开局前（建房）** | 有的产品**根本不联网**：所有玩家共用一个手机（"指尖模式"：几个人把手指按在同一块屏上）。需要多机的（"快闪模式"）才**创建房间 + 邀请朋友加入** | 二手 |
| **开局中（人数）** | 「指尖模式」**3~6 人**、「快闪模式」**十几人**、「骰子模式」**5~8 人** —— 人数上限是按玩法定死的，不是统一的 | 二手 |
| **结算/惩罚（这是它们真正的差异点）** | 每一局结束后，"幸运"玩家**进入一个独立的"惩罚模式"界面**，在里面四选一：**发红包 / 喝酒 / 真心话 / 大冒险**。轮盘模式的项目**可以现场编辑**（"可以根据朋友们的奇特脑洞，快速 DIY"） | 二手 |
| **动效** | 有"盖牌节奏动画"这类描述（[taro-weapp 功能说明](https://github.com/YTU94/taro-weapp)："抽牌有盖牌节奏动画"），但**没有任何时长/曲线公开** → 具体**未确认** | 二手 |
| **音效** | KTV 摇骰子类小程序**有"音效设置"**这一项（[知乎](https://zhuanlan.zhihu.com/p/137753522) 列的设置项之一）。**是否有 BGM、是否有语音播报：未确认** | 二手 |
| **界面构成（设置项清单，很能说明"做到什么程度"）** | 某 KTV 喝酒摇骰子小程序的设置项：**骰盅 4 款 / 背景环境 6 款 / 围骰概率 1%~10% / 骰子个数 1~6 个 / 透视眼模式 / 音效设置 / 摇骰记录与统计 / 叠骰功能** | 二手（作者自述） |
| **节奏** | **不联网的产品是 1~2 次点击开局**（选玩法 → 开始）。联网产品多一步"建房 + 等朋友"，等待时长**未确认** | 二手 |
| **多人同步** | 检索到的公开实现里，**绝大多数是"单机同屏"**（一台手机传着玩）；联网的只做到"创建房间 + 邀请"，同步方式**未确认**。⭐ 这一点值得注意：**同类里真正做到多机实时同步的很少，这本身是我们的护城河** | 二手 |
| **失败态** | **未确认**。没有任何公开资料描述这类小程序的断网/掉线处理 | — |
| **付费/留存** | ① **广告变现**是主流：源码站明确写"**每日超出次数，还支持激励视频解锁游戏**"（[CSDN](https://blog.csdn.net/tui_guige/article/details/124522700)）；[爱范儿·小程序广告形态](https://www.ifanr.com/minapp/1251354) 说明 Banner / 插屏 / 激励视频三种形态，结算页是常见广告位。<br>② **合规约束**：多个产品刻意**规避酒杯、酒瓶等酒精意象**（连 logo 都避开），首页固定挂"理性饮酒 · 未成年人禁止饮酒 · 酒后不驾车" | 二手 |
| **内容层** | taro-weapp 备了 **190 条惩罚题库**（温和 75 / 标准 70 / 劲爆 45，各含真心话·大冒险·惩罚动作），但**当前未接入任何页面** —— 这是"内容做了、体验没接上"的典型 | 二手 |

**结论（对我们最重要的一条）**：
同类产品的"体验深度"集中在 **内容与惩罚的花样**（题库、惩罚四选一、可 DIY 轮盘），而**极少有人做多人同步的手感**。所以我们的竞品不是这些小程序，而是**"桌上那部手机到底值不值得拿出来"**这个问题本身。

---

### 1.6 Heads Up!（物理传感器交互的样板）

来源主入口：[App Store 描述](https://apps.apple.com/us/app/heads-up/id623592465)、[Google Play 页与评论](https://play.google.com/store/apps/details?id=com.wb.headsup)、[wikiHow 规则](https://www.wikihow.com/Play-Heads-Up!)、[ABC News 实机演示](https://www.youtube.com/watch?v=t0E6d7TTpoE)

| 维度 | 他们做到的 | 证据强度 |
|---|---|---|
| **开局前** | **选一个牌组**（100+ 主题，内置若干 + 大量 IAP 解锁）→ 把手机举到额头、**屏幕朝外** | 一手（商店描述） |
| **开局中（界面构成）** | 屏幕上**只有一个词**，朝外给对面的人看；举手机的人**看不到屏幕**（这是核心：信息方向被倒转）。开始前有 **3、2、1 倒计时**（实机演示里能听到 "three two one"） | 一手（演示视频）+ 二手 |
| **交互（只有两条）** | **手机朝下倾斜（tilt down）= 答对**；**朝上倾斜（tilt up）= 跳过**。答对 **1 分**，跳过**不计分也不扣分** | 一手（商店描述）+ 二手（wikiHow） |
| **动效** | **未确认**具体动画 | — |
| **音效** | 有一手线索：Google Play 描述写 "Got an answer right? **Ding!**" —— **答对有一声提示音**。是否有 BGM / 语音播报：**未确认** | 一手（商店文案） |
| **节奏** | 一局 **60 秒**定时（也有产品做 60 或 90 秒两档）；时间到**自动结算并计分**；轮次**可以一直打下去**，直到大家不想打 | 二手（wikiHow） |
| **多人同步** | **不联网**。所有玩家在同一间屋子里，手机是共用道具。**这正是"手机当道具"的极致形态：它连网络都不需要** | 一手 |
| **失败态（最重要的教训）** | 传感器的误判是它的主要差评来源。Google Play 长评原文："**when someone gets the answer correct, they could just press a button... instead of requiring so much movement from the phone. Which appears glitchy at any age**"（希望能改成按钮，因为倾斜识别看起来经常出错）。**传感器交互必须有手动兜底** | 二手（真实评论） |
| **付费/留存** | **IAP 卖牌组**（"Several categories are included, with many more available as In-App Purchases"）。留存靠**录制并分享视频**（"record and share videos"）—— 玩完会产生一条可传播的内容 | 一手 |

**可抄的两条**：
1. **"信息方向倒转"是最强的现场价值**：举手机的人看不见，全场看得见。我们做"贴额头猜词"时必须严格照这个来（本项目已有类似判据）。
2. **传感器必须有按钮兜底**：我们的"摇一摇""按住看牌"都要有等价的手动路径，且**手动路径不能藏起来**。

---

## 2. 横向对照：开局前 / 中 / 后各有什么元素

legend：✅ = 有明确证据；⚠️ = 有证据但细节未确认；❌ = 明确没有；— = 未确认

| 界面元素 | Plato | Houseparty | Jackbox | 斗地主/微乐 | 微信酒桌小程序 | Heads Up! | **我们（现状）** |
|---|---|---|---|---|---|---|---|
| 房间码 | ❌（用分享链接） | ❌（靠在线列表） | ✅ 4 字母 | ✅ 匹配/房号 | ⚠️ 部分有 | ❌ | ✅ 3 位数字，输满自动进 |
| 等待大厅 | ✅ | ✅（就是通话本身） | ✅ 明确有 lobby | ✅ | ⚠️ | ❌ | ✅ lobby 阶段 |
| 玩家头像/座位 | ✅ | ✅（分屏格） | ✅ | ✅（三家位） | ⚠️ | ❌ | ✅ players 列表 |
| "谁是房主"的可见标识 | ⚠️ | ⚠️ | ✅ VIP 概念 | ✅ | — | ❌ | ✅ host 字段 |
| 回合提示 | ⚠️ | — | ✅ | ✅ | — | ❌（无回合） | ✅ turn / turnName |
| 进度（第几轮/共几轮） | — | — | ✅ | ✅ | — | ⚠️（只有 60s） | ✅ round 字段 |
| 倒计时 | — | — | ✅ 可关/可延长 | ✅ 出牌 20s | — | ✅ 60s | ✅ countdown（3 秒开局） |
| 结算页 | ⚠️ | ✅ 自动关闭游戏 | ✅ 有专门 score screen | ✅ EndingPanel | ✅ **惩罚四选一** | ✅ 计分 | ✅ over 阶段 |
| 别人的动作可见 | ✅ **变成聊天消息** | — | ✅ | ✅ | ❌（单机） | ❌ | ⚠️ 只靠界面重绘 |
| 掉线/缺席标记 | — | — | ⚠️（重 count-in） | ❌（真实差评源） | — | ❌ | ❌ |
| 中途加入 | ✅（可锁房） | ✅（锁房） | ✅（观众） | — | — | ❌ | ⚠️ 能进，但无提示 |
| 音效开关 | — | — | ✅ 多通道音量 | ✅ BGM 独立 | ✅ | — | ✅ 音效/震动两个布尔 |
| 减少动效 | — | — | ✅ Motion Sensitivity | — | — | — | ❌ |
| 无倒计时模式 | — | — | ✅ No Timer Mode | ❌ | — | ❌ | ❌ |

---

## 3. ★ 差距清单（核心产出）

**"现状"一列的基准**（按本项目实际代码，不是假设）：
- 动画 = 手写 WXSS `keyframes` / `transition`，无 Lottie，无第三方动效库
- 音效 = 35 个本地合成 `.wav`，`wx.createInnerAudioContext` 逐个播放，**无 BGM、无语音播报**
- 同步 = `POLL_MS = 1500` 的 `setInterval` 轮询，全量 `room` 快照 + `roomChanged()` 去重
- 反馈时间轴 = `utils/feedback.js` 一张表（如 `diceSettle: animMs 420 / impactAt 60`）
- 包体积 1356 KB，音频 35 个
- **没有**：`onHide`/`onShow` 的同步处理、掉线标记、减少动效开关、状态音、动作流

> 表格里的 `[J]` `[P]` `[H]` `[T]` `[W]` `[U]` 是来源锚点，对应第 5 节的索引。每行都尽量给到**能直接改的数值**。

| 他们做到的 | 一个只用 WXSS 手写动画 + 合成音效的微信小程序现状 | 补上的具体做法（可执行） |
|---|---|---|
| **1. Jackbox 用 count-in 让每台设备在"自己听到的那一刻"对齐，官方称串流极端延迟下也有效** `[J2]` | 倒计时用服务端 `startAt` 时间戳 + 1.5s 轮询。两台手机最多差 1.5 秒 —— **同一桌上两个人看到的秒数不一样**，读秒音效也不同步 | 把 `countdown` 改成**本地自起表**：收到 `start` 响应时 `this._t0 = Date.now()`，读秒用 `3000 - (Date.now()-this._t0)` 计算；服务端只下发"开始"这个事件，不下发绝对时间。若响应里带 `serverStartAt`，只用于**校正**：`offset = clamp(serverStartAt - clientNow, -400, +400)`，把 offset 加到 `_t0`。**永不直接用绝对时间戳渲染秒数** |
| **2. Jackbox 有 No Timer Mode：等所有人都提交才推进** `[J3]` | 服务端自动推进回合（正确方向），但**投票类没有"还差谁"这一层**，桌上只能干等，没有催的手段 | 投票阶段显示 **"还差 N 人"**（读 `players` 里 `voted !== true` 的个数），并把名字列出来（最多 2 个 + "等 N 人"）。**超过 20 秒**才出现「催一下」按钮（仅房主可见），点击写 `room.nudgeAt = Date.now()`，其他人下一次轮询看到 `nudgeAt` 变化就播一次 `tap-soft.wav` + 顶部 toast「房主在催了」。**不做倒计时强制推进**（守住铁律①） |
| **3. 斗地主的出牌倒计时到点由服务端替玩家 pass，不卡死** `[T1]` | 无回合超时。有人锁屏/接电话，全桌停在"等某某"（AGENTS.md 记过"永远没人轮到"的卡死） | 服务端在 `status`/`poll` 时检查：`turn` 对应的玩家 `heartbeatAt` 超过 **45 秒**且 `phase==='playing'` → 自动执行一次"跳过该玩家"（大话骰=视为不叫、开骰；卧底=视为弃票）。同时 `turn` 按 `clamp` 重算，**不越界**。前端显示一行灰字「XX 已掉线，已跳过」 |
| **4. Houseparty：有人在屋里会即时提醒** `[H3]` | 新玩家加入时，1.5s 后座位格**静默多一个**。桌上没人知道有人进来了 | 在 `roomChanged()` 里比对 `players.length` 与 `this._lastCount`。新增时：① 座位格 keyframes `scale(0.6)→scale(1.15)→scale(1)`，**240ms / cubic-bezier(.2,1.6,.4,1)**；② 播 `tap-soft.wav`（音量 0.5）；③ 顶部 toast「XX 进来了」，`translateY(-40rpx)→0` + `opacity 0→1`，**220ms ease-out**，停 1.2s 后 `opacity→0`（180ms） |
| **5. Plato 把每一步动作同时发成聊天消息** `[P2]` | 别人叫骰后，界面数字**悄悄变了**。桌上没人知道"刚才谁叫了什么" | 房间页底部加**事件流 3 行**（只在 `playing` 阶段显示）。每次 `pollTick` 比对 `bid`/`turn`/`lastResult` 生成一行（如「3 号叫了 4 个 5」），保留最近 3 条，第 4 条挤掉最旧的。新条目入场：`translateX(-12rpx)→0` + `opacity 0→1`，**200ms ease-out**，**stagger 40ms**。**事件流只读，不承载任何点击** |
| **6. Jackbox 曲终后要额外等待延迟时间，让玩家"播完"** `[J2]` | 揭晓瞬间直接切结算，**最激动的那 1 秒没有停留** | 揭晓 → 结算之间插 **hitstop**：揭晓动画到 `impactAt` 时给容器加 `transform: scale(1.02)` 并**冻住 300ms**（用 `transition: none` + 一个 300ms 的 `setTimeout` 解开），期间**不播任何音效**（静音比加音更有效）。300ms 后再进结算页 |
| **7. Jackbox 为结算页做了专门的设计稿（final score screen）+ 终局转场 bumper** `[J1]` | `stage==='over'` 时**一次性渲染**全部结果，排名同时出现 | 结算分 3 段：① 先只显示「本局结束」+ 一个 400ms 的 `scale(0.9)→1` 淡入；② **排名逐条落位**，`stagger 120ms`，每条 `translateY(24rpx)→0` + `opacity 0→1`（220ms ease-out）；③ 最后 200ms 才显示「再来一局」按钮。**按钮必须最后出现**，否则人会立刻点走，看不到结果 |
| **8. 斗地主：只有"王炸/炸弹/飞机"这类大牌才给全屏特效** `[T1]` | 每颗骰子落定都有动画（`diceSettle` 420ms），**重音被稀释**，一局摇 5 颗 = 5 次同强度冲击 | 分两档：**普通落定**只做 `translateY` + `opacity`，**时长压到 220ms**，音效音量 0.45；**最后一颗 / 开盅 / 出现豹子**才走现有的 420ms + `heavy` 震动 + 全屏轻微 `shake`。判据写进代码：`isBigMoment = 最后一颗 \|\| 豹子 \|\| 开盅` |
| **9. 斗地主有"剩牌数提示音"这类状态音（只剩 1~2 张时）** `[T1]` | 35 个音效**基本都是动作音**（摇/落/翻/扣）。唯一沾"状态"性质的是 `countdownUrgent`，但它**只服务开局那 3 秒读秒**（`room.js` 里就一处）。**游戏进程中的"危险临近"没有任何声音提示**，只能靠看 | 加 3 个状态音（复用现有 wav + `playbackRate` 变调，不新增文件）：① 轮到我 → `tap.wav` @1.12；② 只剩 1 人没投 → `charge-up.wav` @1.0（音量 0.5）**不要用 `countdownUrgent`** —— 那会跟开局读秒撞音色，玩家分不清是"要开始了"还是"催投票"；③ 有人掉线 → `toggle-off.wav` @0.85。**状态音每局最多响 3 次**（加计数器，超了不响），否则变噪音 |
| **10. Jackbox 给每个游戏配专属 Audio Lead，大厅/教程/片尾各有独立曲目，甚至有 30% 概率的隐藏曲** `[J4]` | **完全没有 BGM**（包体积 1356KB，也塞不进完整曲目）；房间里是**绝对安静**，只有操作时有声 | 不做 BGM，做**环境底噪**：合成一条 **4 秒**可循环的木桌/房间底噪（`gen-audio.py` 生成，归一化到 RMS 峰值的 **8%**，约 40KB），进入 `playing` 播、`over` 停。**接缝处理**：用两段 2 秒交叉淡入淡出，或首尾各 200ms 线性淡入淡出后循环。开关挂在现有「音效」开关下，不新增开关 |
| **11. Jackbox 音效音量可分区调节（Audio/Video 区"多种音量"）** `[J5]` | 只有一个布尔「音效」开关，**全开或全关**。有人嫌吵只能全关，连"该你了"也听不到 | 把 `utils/sfx.js` 的音量改成**两档常量**：`VOL_CRITICAL = 0.9`（该你了/开盅/结算）、`VOL_DECOR = 0.45`（逐颗落定/翻牌/环境音）。「我的」里保持一个开关，但**关掉时 `VOL_CRITICAL` 仍走 0.35**（关键提示留一条缝），并在开关说明里写清这两个字 |
| **12. Jackbox 有 Motion Sensitivity 开关，动效可降级** `[J5]` | 只有「音效」「震动」两个开关，**没有动效降级**。晕动/嫌花的人没有出路 | 「我的」加第三档「减少动效」。开启后 `app.globalData.reduceMotion = true`，所有动画类统一走一个 `motionMs(base)`：`reduceMotion ? base*0.6 : base`；且**位移类关键帧换成纯 `opacity`**（`shake` 类直接不加 class）。判据要覆盖：`feedback.js` 里每个 `animMs` 都经 `motionMs()` 出口，不许裸写 |
| **13. 微信官方：进后台 5 秒后网络请求 `fail interrupted`，回前台之前调不了网络** `[W1]` | 没有 `onHide` / `onShow` 处理。锁屏再亮屏，要么等下一个 1.5s tick，要么拿到一串失败 | `onHide`：`clearInterval(this._poll)`，记 `wx.setStorageSync('room.lastSeenAt', Date.now())`。`onShow`：立即 `pollTick()` 一次（不等 1.5s），并比对 `Date.now() - lastSeenAt`：**>60 秒**则显示一次「离开期间房间有变化」的提示条（只在 `stage` 或 `round` 真的变了时才显示）。**不要在 `onShow` 里重建 `setInterval`，必须复用同一个 timer 变量**，否则会叠加出双倍轮询 |
| **14. 微信官方：`wx.connectSocket` 最多 5 并发；`watch` 的 `limit` 上限 200、`orderBy` 最多 5 字段** `[W2][W3]` | 纯轮询，可用但每次都是全量 `room` 快照（`shape()` 全字段） | 先**不动架构**（轮询的容错优势是真实的，见 AGENTS.md），但做两件低成本的事：① `poll` 只带 `since`（上次 `updatedAt`），服务端**若无变化就返回 `{ok:true, unchanged:true}`**（几十字节），前端直接 `return`，不走 `roomChanged`；② 若某天要上 `watch`：`limit(1)` + `where({_id})`，别订阅整个集合（`limit` 200 上限、`orderBy` 5 字段的约束摆在那） |
| **15. 微乐/斗地主：队友挂机导致 2 打 1 且无法解散，是被反复投诉的真实缺陷** `[T2]` | 没有"掉线"这个概念。某人锁屏后，界面上他和"在思考"**完全一样** | 服务端在每次 `poll`/`status` 里更新 `players[i].lastSeenAt`。前端把 `Date.now()-lastSeenAt > 15000` 的玩家标 `offline`：头像 `opacity .4` + 右上角一个 **8rpx 红点**（`border-radius:50%`），名字后缀「掉线」。**不要用灰掉整行**（会导致玩家列表跳高） |
| **16. Houseparty：一局结束游戏自动关闭，玩家不需要点"返回"** `[H2]` | 已有服务端自动推进（方向正确），但 `over` 阶段仍需房主点「再来一局」才回 lobby | 结算页给**两个入口但主次分明**：主按钮「再来一局」（房主）/「等房主开下一局」（非房主，**disabled 样式**），次入口是一行小字「换个玩法」。**非房主的那颗按钮要能被点但只播一次提示音**（不能是 `disabled` 属性 —— 那样点了毫无反馈，会被当成卡住） |
| **17. Houseparty：自己的画面永远最大，多人时不平均分配注意力** `[H1]` | 房间页在多人时把每个玩家的信息**等权重排布**，自己的手牌/骰子没有视觉优先 | 手牌区高度固定为 `min(当时可用高度的 34%, 420rpx)`，其余玩家人信息压到**顶部一行 56rpx 的头像条**（横向滚动，不换行）。判据：**手牌区宽度必须是容器宽度的 100%，头像条高度必须 ≤ 64rpx**（写进 `test-room-ui.js`） |
| **18. 腾讯系棋牌的音频按"事件类型"分 6 类，其中"选牌"有独立音** `[T1]` | 点选项/叫骰时**只有一次 `tap.wav`**，且读秒与点击音**音色接近**，听起来像同一个动作 | 给"点选"和"确认"分别定音色：点选 = `tap.wav` @1.0（短、干、音量 0.5）；确认 = `chip-bet.wav` @1.0 + `haptic medium`。**两者间隔必须 ≥ 120ms**（若玩家快速连点，第二次点选音要 `playbackRate` 升到 1.06，给"连击感"） |
| **19. Heads Up!：答对有明确的 "Ding!"，且分数累计即时** `[U3]` | 得分/记杯变化**没有音高递进**，每次都是同一个音 | 连击变调：第 1 次 `playbackRate 1.0`、第 2 次 `1.122`、第 3 次 `1.26`、第 4 次起保持 `1.26`（大三和弦三音）。**MVP 实现**：`rate = [1, 1.122, 1.26][Math.min(n,2)]`，用 `InnerAudioContext.playbackRate`（需基础库 2.11.0+，**降级策略：`setProperty` 失败就 ignore，仍播原音**） |
| **20. Heads Up! 的传感器交互有大量"不灵敏"差评，玩家想要一个按钮** `[U2]` | 「按住才看牌」「摇一摇」**只有传感器/触摸一种路径**，识别失败时用户会以为界面坏了 | 每条传感器路径配一个**可见的**手动等价物：按住看牌 → 牌面下方常驻一行「按住看 · 或点这里翻 3 秒」（点击路径 = `setData` 一个 `peekUntil`，3 秒后自动藏）；摇一摇 → 按钮「摇」（**不做成隐藏入口**）。判据：**任何 `bindtap` 之外的手势/传感器方法，wxml 里必须有对应的可见按钮** |
| **21. 斗地主/微乐的留存靠赛季、皮肤、角色 IP，但没有一处是"日常必须来"** `[T2]` | 无任何留存机制。玩完即走，第二天不会想起 | **不做货币、不做签到**（酒桌场景不成立）。做两件与场景强绑定的：① **「今晚战况」本地持久化**：`wx.setStorageSync('session.v1', {date, drinks: {openid: n}})`，同一晚再来自动累加，隔天自动清零（按日期 key 判断）；② **分享即复玩**：结算页「发到群里再来一局」用 `onShareAppMessage` 带上房间号，**被分享者点开直接进同一房间**（`path: '/pages/room/room?code=xxx'`） |
| **22. Heads Up! 靠 IAP 卖 100+ 牌组，且"玩完能录视频分享"** `[U1]` | 题库固定（`decks.js` 160 条）。没有"更多内容"这条路，因为小程序不能卖虚拟内容 | 解锁改用**分享**而非付费（审核友好）：牌组页显示「分享给朋友，解锁这个场合」→ `onShareAppMessage` 成功后 `wx.setStorageSync('decks.unlocked', [...])`。**只加 1 个"新场合"牌组就够**（40 条），别一次做 4 个 |
| **23. Jackbox 每次启动下载 config 调参（"完美"容差是多少毫秒、调 5% 就见效）** `[J2]` | 所有手感参数**写死在 `feedback.js`**，改一个数字就要发版过审 | 把 `FEEDBACK` 表**抽成可下发配置**：`room` 云函数加一个 `getTuning` action 返回 JSON；前端 `Object.assign(FEEDBACK_DEFAULT, remote)`，**逐字段做 `Number.isFinite` 校验后才合并**（防止云端错误值把动画时长搞成 0 或 NaN）。缓存 24 小时，失败就用默认表 |
| **24. Jackbox 的隐藏内容（30% 概率播放的隐藏曲目）** `[J4]` | 所有内容**100% 每次都会出现**，玩 3 次就全见过了 | 低成本彩蛋：转盘/题卡里做 **1/8 概率**的"稀有结果"（如「你今晚运气爆棚，这杯免了」），`if (Math.random() < 0.125)`。**必须在服务端抽**（前端抽会被重摇）。稀有结果的视觉：现有 `confetti.wav` + 文字 `scale(0.8)→1.06→1`（360ms） |
| **25. Plato/Houseparty 用"锁房"控制谁能进，且在界面底部常驻开关** `[P1][H1]` | 房间号是 3 位数字，**任何人知道号就能进**，且**没有锁** | 房主可「锁房」：服务端 `room.locked = true` 后 `join` 直接返回 `{ok:false, msg:'房主已锁房'}`。前端把锁做成 `lobby` 阶段的一个 24rpx 图标（**不是按钮**，点击才切换），锁定状态**在座位区顶部显示一行 40rpx 的小字「已锁房」** —— 不锁时的默认状态**不要有任何提示**，否则每次开局都在讲一件不需要讲的事 |
| **26. 所有产品都有"断网/有人掉线时我这边看到什么"的明确设计** `[J2][T2]` | 轮询失败**完全静默**（`.catch(() => null)` 这类写法在项目里出现过，见 AGENTS.md 的「静默 return」教训） | 连续失败计数 `this._fail`：**3 次（4.5s）** → 顶部黄条「网络不稳，正在重试」（`#B8860B` 背景、24rpx 高、`opacity 0→0.9` 200ms）；**5 次（7.5s）** → 变红条 + 出现「重新进房」文字按钮。**恢复后自动消失（180ms 淡出），不弹窗、不阻断操作** |

---

## 4. 未确认清单（不要当成"他们没做"）

| 项 | 状态 | 为什么查不到 |
|---|---|---|
| Plato 的动画时长、曲线、任何动效细节 | **未确认** | 无官方设计文档、无技术拆解文章、无 GDC 演讲 |
| Plato 的音效构成（是否有 BGM / 语音） | **未确认** | 同上 |
| Plato 的同步实现（长连接 or 轮询） | **未确认** | 未公开 |
| Plato 房间"只能放 3 个游戏"的规则 | **仅用户评论** | 只在 App Store 评论里出现，官方文档未确认 |
| Plato Premium 的具体定价 | **未确认** | 检索到的 `$49/月` 疑似与运营商套餐页混淆，不可采信 |
| Houseparty 的动效与音效细节 | **未确认** | App 已下架，无法复现；现有教程只讲操作 |
| Houseparty 掉线处理 | **未确认** | 无资料 |
| Jackbox 各动画的具体毫秒数与缓动曲线 | **未确认** | 官方博客只给"有专门设计稿"，不给参数 |
| Jackbox 观众上限（10,000 还是 200） | **冲突** | 官方说"up to 10,000"，Jackbox Wiki 写"Audience caps at 200"，两者都有出处 |
| Jackbox 单局写作/投票倒计时的具体秒数 | **未确认** | 检索到的资料只提"有限时"，不给数字 |
| 欢乐斗地主线上版本的 UI/音频实现细节 | **未确认** | 腾讯未公开；本文用的是**教学复刻项目的旁证** |
| 微乐的具体赛季周期与付费档位 | **未确认** | 商店页只列货币种类，不列价格 |
| 微信酒桌小程序的音效/BGM/同步方式 | **未确认** | 这类产品基本无技术公开 |
| 所有产品在"多人同时掉线""房间满员时有人抢进"等边缘场景的行为 | **未确认** | 无资料 |

---

## 5. 来源索引

**`[P]` Plato**
- `[P1]` 官方 Facebook 关于 rooms 的说明（锁房、分享链接）— https://www.facebook.com/platochat/posts/if-you-head-over-to-the-rooms-tab-in-plato-youll-notice-that-more-rooms-based-ar/2639070676106903
- `[P2]` CB Insights 公司/产品描述（实时走子 + 同步进聊天 + 旁观）— https://www.cbinsights.com/company/plato-team
- `[P3]` App Store 页（游戏目录、Ad-Free、内购、用户评论"房间只能 3 个游戏"）— https://apps.apple.com/us/app/plato-fun-multiplayer-games/id1054747306
- `[P4]` Indian Express 评测（左上资料按钮、底部 tab、分享快捷方式）— https://indianexpress.com/article/technology/tech-reviews/ie-app-reviews-plato-games-group-chats-7211004
- `[P5]` 官方 games 目录 — https://platoapp.com/en/games
- `[P6]` 建房流程教程视频 — https://www.youtube.com/watch?v=b8M3pGbvB_w

**`[H]` Houseparty**
- `[H1]` Business Insider 使用指南（8 人上限、分屏、自己最大、锁房）— http://www.businessinsider.com/how-to-use-the-houseparty-app-2016-12
- `[H2]` AgeSpace 图文教程（骰子图标、4 个游戏、一局结束自动关闭、X 关闭）— https://www.agespace.org/tech/how-to-use-houseparty
- `[H3]` Business Insider 产品说明（在线提醒、Facemail、预约 party、内购）— https://www.businessinsider.com/guides/tech/what-is-houseparty-app
- `[H4]` Wikipedia（2021-09-09 宣布、10 月关停、Epic 2019 收购）— https://en.wikipedia.org/wiki/Houseparty_(app)
- `[H5]` 华盛顿邮报（关停报道）— https://www.washingtonpost.com/video-games/2021/09/09/houseparty-shut-down-epic-games-metaverse
- `[H6]` Time Out 游戏清单（Chips and Guac / Quick Draw 玩法）— https://www.timeout.com/newyork/news/the-six-best-houseparty-games-to-play-with-friends-050420

**`[J]` Jackbox**
- `[J1]` 官方 How to Play（4 步、lobby room、jackbox.tv）— https://www.jackboxgames.com/how-to-play
- `[J2]` 工程幕后（count-in、断网重 count-in、曲终等待、启动下载 config、调 5% 见效、Final Round bumper / final score screen 设计稿）— https://www.jackboxgames.com/blog/behind-the-scenes-of-pp10-engineering
- `[J3]` PP8 功能说明（No Timer Mode = 等所有玩家提交、Extended Timers、Skip Tutorial、VIP、Audience）— https://www.jackboxgames.com/blog/streaming-moderation-accessibility-features-jackbox-party-pack-eight
- `[J4]` 音频幕后（每游戏专属 Audio Lead、Picker/Loader 音乐、30% 概率隐藏曲、controller mix）— https://www.jackboxgames.com/blog/behind-the-scenes-of-pp10-audio
- `[J5]` PP10 无障碍说明（Audio/Video 多种音量、Subtitles、Motion Sensitivity、Extended/No Timers）— https://www.jackboxgames.com/blog/accessibility-features-in-the-jackbox-party-pack-10
- `[J6]` Wikipedia 系列条目（年度发售、PP11 于 2025-10-23、每 Pack 5 个游戏）— https://en.wikipedia.org/wiki/The_Jackbox_Party_Pack
- `[J7]` GDC 演讲（Dodo Re Mi 音画同步架构的来源）— https://www.gdcvault.com/play/1029186/Independent-Games-Summit-Hitting-the

**`[T]` 腾讯欢乐斗地主 / 微乐**
- `[T1]` 爱编程的大丙·斗地主项目大纲（**旁证/教学复刻**：窗口类清单、20 秒出牌倒计时、AnimationWindow 特殊牌型特效、BGMControl 六类音频）— https://subingwen.cn/project/landlord
- `[T2]` 微乐斗地主 App Store 页（赛季、皮肤、角色、IP 联动、货币、用户评论"队友挂机 2v1"）— https://apps.apple.com/cn/app/%E5%BE%AE%E4%B9%90%E6%96%97%E5%9C%B0%E4%B8%BB%E7%A7%BB%E5%8A%A8%E7%89%88-v1-0-0-%E6%98%A5%E5%A4%A9%E7%89%88/id1591571941
- `[T3]` 微乐官方站 — https://mobile.weile.com/main
- `[T4]` 人民网·微乐斗地主适龄提示（"游戏时长 3 小时后收益减半"）— http://jinbao.people.cn/n1/2019/1015/c428398-31401860.html
- `[T5]` 2011 腾讯无线设计师 UI 分享（**转载页 GBK 编码，正文可读性差，仅取可确认表述**）— http://www.missyuan.net/web/201109/5518.html

**`[W]` 微信小程序 / 微信平台**
- `[W1]` 微信·网络（进后台 5s 后 `fail interrupted`、`wx.request` 10 并发、`wx.connectSocket` 5 并发）— https://developers.weixin.qq.com/miniprogram/dev/framework/ability/network.html
- `[W2]` 微信·wx.connectSocket（1.7.0+ 最多 5 个并发）— https://developers.weixin.qq.com/miniprogram/dev/api/network/websocket/wx.connectSocket.html
- `[W3]` 微信·云开发实时数据推送（watch 支持 where/orderBy/limit；limit 上限 200、orderBy 最多 5 字段）— https://developers.weixin.qq.com/minigame/dev/wxcloud/guide/database/realtime.html
- `[W4]` 微信·体验评分/性能（首屏 ≤5s、渲染 ≤500ms、setData ≤20 次/秒、setData ≤256KB、节点 <1000）— https://developers.weixin.qq.com/miniprogram/dev/framework/audits/performance.html
- `[W5]` 爱范儿·聚会神器评测（四板块、惩罚四选一、快闪模式建房、轮盘可编辑）— https://www.ifanr.com/minapp/1236504
- `[W6]` 知乎·KTV 喝酒摇骰子小程序（骰盅 4 款、背景 6 款、围骰概率、骰子个数、透视眼、音效设置、记录统计、叠骰）— https://zhuanlan.zhihu.com/p/137753522
- `[W7]` GitHub·酒桌 Gameing（5 玩法 + 今晚战况 2~12 人 + 本地存储 + 纯 CSS 图标 + 规避酒精意象 + 190 条题库未接入 + 盖牌节奏动画）— https://github.com/YTU94/taro-weapp
- `[W8]` CSDN·喝酒神器源码（每日次数限制 + 激励视频解锁）— https://blog.csdn.net/tui_guige/article/details/124522700
- `[W9]` 爱范儿·小程序广告形态（Banner / 插屏 / 激励视频；结算页是常见广告位）— https://www.ifanr.com/minapp/1251354

**`[U]` Heads Up!**
- `[U1]` App Store 描述（贴额头、100+ 牌组、IAP、录制分享、tilt down/up）— https://apps.apple.com/us/app/heads-up/id623592465
- `[U2]` Google Play 页与评论（"Ding!"、倾斜不灵敏希望改按钮）— https://play.google.com/store/apps/details?id=com.wb.headsup
- `[U3]` wikiHow 规则（60 秒、答对 1 分、可打任意多轮）— https://www.wikihow.com/Play-Heads-Up!
- `[U4]` ABC News 实机演示（3-2-1 倒计时、tilt 操作实录）— https://www.youtube.com/watch?v=t0E6d7TTpoE

**`[G]` 通用设计规范（**用于给"补上"提供数值依据，不是这些产品的官方参数**）**
- `[G1]` 游戏 UI 动效的响应时间阈值（直接操作 ≤100ms；间接反馈 ~1s，超 2s 视为失控；引用 Robert B. Miller 与 Jakob Nielsen 的经典阈值）— https://www.lemooui.com/article/show/id/37
- `[G2]` 游戏界面动效的 7 种主动反馈形式（抖 / 炸 / 摔 / 碎 / 光 / 拆 / 闪）与"控制时长与频率"原则 — https://m.zcool.com.cn/article/ZMTI2OTQ2NA==.html
- `[G3]` 腾讯游戏学堂·UI/UX 分析（指出"粒子不受输入驱动 = 像看电影而非玩游戏"；交互方式单一）— http://gameinstitute.qq.com/article/10027

---

## 附：本文与项目既有文档的分工

| 文档 | 覆盖什么 | 本文的关系 |
|---|---|---|
| [2026-10-28-party-games-survey.md](2026-10-28-party-games-survey.md) | **玩法规则**的主流版本差异（劈/反劈、平票规则、比大小 6 种比法） | 本文不重复规则，只拆**界面/动效/音效/同步/失败态/留存** |
| [2026-10-28-game-feel-spec.md](2026-10-28-game-feel-spec.md) | 我们自己的手感规范 | 本文第 3 节的做法若与之冲突，**以手感规范为准**，本文只提供"别人做到哪一步"的坐标 |
| 本文 | 同类产品的**实现程度** + **差距清单** | 第 3 节 26 行是可排期的具体改动 |
