/**
 * feedback.js —— 统一的「反馈时间轴」
 *
 * ============ 为什么要有这个文件 ============
 *
 * 改造前的问题：动画时长写在 wxss、音效触发写在页面 js、
 * 震动（当时没有）本该写在哪都行 —— 三者各写各的，
 * 结果就是「音效和动画没匹配上」。
 *
 * 这个文件把三者收敛到**一张表**：每个动作定义一次冲击点，
 * 动画、音效、震动都从它取时间。调手感 = 改数字，不用翻三个文件。
 *
 * ============ 三个通道为什么要错开 ============
 *
 * 人脑处理三个通道的速度不一样（这是实测结论，不是感觉）：
 *
 *     触觉  >  听觉  >  视觉
 *
 * 具体地：听觉约 13ms、视觉约 50ms 就能形成知觉。
 * 所以如果三个通道**同时**触发，玩家实际感知到的是
 * 「先震 → 再响 → 最后看见」，反而显得震动和音效在抢拍。
 *
 * 补偿办法就是让它们**按感知速度倒序触发**：
 *
 *     视觉（动画）最先发生
 *       ↓ +30ms
 *     音效
 *       ↓ +20ms
 *     震动（最后到）
 *
 * 这样三者才在大脑里「同时到达」。
 *
 * ============ 震动为什么必须克制 ============
 *
 * Android 官方的触觉设计原则第一条就是「宁可丰富清晰，不要嗡嗡作响」，
 * 第三条是「注意使用频率」。
 * 具体到这个游戏：一局摇骰子会落定十几颗，如果每颗都 heavy 地震，
 * 用户第一反应是把震动关掉 —— 那还不如不做。
 * 所以分级严格按「重要性」分配，逐颗落定只能 light。
 */
const sfx = require('./sfx.js')
/*
 * ★ 震动/开关的**状态**从主包 utils/haptic.js 来（2026-10-28 拆分）。
 *   不能让这一份再自己读一遍 storage —— 两份状态各记各的，
 *   用户在大厅关掉震动、进房间又响了，这种 bug 最难查。
 *   时间轴（本文件）只负责"什么时候震/什么时候响"。
 */
const haptic = require('../utils/haptic.js')

/* ============================================================
   时间轴表
   ------------------------------------------------------------
   字段说明：
     animMs      动画总时长（与 wxss 里的 animation 时长必须一致）
     impactAt    冲击帧 —— 视觉上「砸住 / 停稳 / 揭晓」的那一刻
     sfx         音效键
     sfxDelay    音效相对**动画开始**的延迟（= impactAt + 补偿）
     haptic      震动强度：'light' | 'medium' | 'heavy' | 'long' | 'double'
     hapticDelay 震动相对动画开始的延迟（比音效再晚，因为触觉最快）
   ============================================================ */
/* ============================================================
   两档播放音量
   ------------------------------------------------------------
   2026-10-28 加。原来所有音效都是 volume=1，用户嫌吵只有一个全开/全关的开关 ——
   关掉之后连"该你了""开盅"都听不到，而那两声是**功能性**的
   （不知道就玩不下去），装饰音才是吵的来源。

   按"缺了它会不会玩不下去"分两档：
     · 关键（0.9）：开盅 / 扣盅 / 结算 / 该你了 / 读秒最后一拍
     · 装饰（0.45）：逐颗落定 / 摇盅过程 / 翻牌 / 投票落子
   装饰音一局出现十几次（骰子逐颗落定），关键音一次。
   ============================================================ */
/*
 * ★ 2026-11-02「线下面对面」：关键档从 0.9 提到 1.0。
 *
 * 酒桌上手机是**外放**的，环境噪音（聊天、碰杯）大约 60~70 dB，
 * 手机扬声器最大 80~90 dB —— 信噪比本来就只剩 10~20 dB。
 * 这 10% 的余量不是"保险"，是**能不能盖过一桌人说话**的差别。
 *
 * 文件本身的峰值已经钳在 0.96 以内（write_wav 里做的），
 * 所以 volume=1.0 不会削波 —— 它只是把已经调好的响度**完整放出来**。
 *
 * 装饰档保持 0.45：那些一局响十几次（逐颗落定、翻牌），
 * 满音量会变成噪音。
 */
const VOL_CRITICAL = 1.0
const VOL_DECOR = 0.45

/*
 * 摇盅流程总时长（盅一直在晃的这一段）。
 *
 * ★ 这个数字原来有**三个副本**（2026-11-03 收成一个）：
 *   ① feedback.js 的 `cupShake.animMs: 1050`
 *   ② room.js `autoShake()` 里裸写的 `setTimeout(..., 1050)`（摇完扣盅）
 *   ③ docs/音效时长对照.md 里那句「= cup-shake 时长」
 *
 * 它们恰好相等，所以从来没出过事 —— 而**"恰好相等"就是最危险的耦合**：
 * 谁改了其中一个，另外两个会静默地用旧时长，症状是「盅已经扣下了，声音还在摇」
 * 或者「摇完了但盅还悬着」。这类"看起来像业务常量"的定时器，
 * AGENTS.md 里记过整整一类（1080 / 1750 那两个就是这么来的）。
 *
 * ⚠️ 它**不等于** wxss 里 `@keyframes cupShake` 的 340ms ——
 *    那个是一次晃动的周期（infinite 循环），两者是不同的量。
 */
const CUP_SHAKE_MS = 1050

const FEEDBACK = {
  /* ---------- 骰子逐颗落定 ---------- */
  /*
   * ★★ 2026-10-28 分两档（调研结论第 8 条）：
   *   "每颗骰子落定都有动画、同样强度 —— 一局摇 5 颗 = 5 次同强度冲击，
   *    重音被稀释了。"（斗地主只有王炸/炸弹才给全屏特效）
   *
   *   普通落定压到 220ms + 低音量 + 轻震；**最后一颗**才走重音 + 重震。
   *   五颗里只有一颗"响"，那一下才有分量。
   */
  diceSettle: {
    animMs: 220,
    impactAt: 50,
    sfx: 'diceSettle',
    haptic: 'light',
    vol: VOL_DECOR
  },

  /* 最后一颗落定：整轮唯一的重音 */
  diceSettleLast: {
    animMs: 420,
    impactAt: 60,
    sfx: 'diceOnTable',
    sfx2: 'impactLow',
    haptic: 'medium',
    vol: VOL_CRITICAL
  },

  /* ---------- 全部落定 / 开盅揭晓（重） ---------- */
  cupOpen: {
    animMs: 340,
    impactAt: 70,
    sfx: 'revealHit',
    haptic: 'heavy'
  },

  /* ---------- 转盘停稳 ---------- */
  /*
   * ★ 2026-11-03：`wheelStart` 原来**不在表里** —— 它走的是裸的
   *   `sfx.play('wheelStart')`，于是它没有任何震动、也不受"减少动效"开关管。
   *
   *   把它纳入表里之后，「转盘开始转」和「摇盅」用同一套规则：
   *   **连续动作（转动 2.4 秒）全程不震**，只出声。
   *
   *   ⚠️ 连续音不震是刻意的：一局要转好几次，每次都震会让人关掉震动。
   */
  wheelStart: {
    animMs: 2400,
    impactAt: 0,
    sfx: 'wheelStart',
    haptic: '',           /* 连续动作不震 */
    vol: VOL_DECOR
  },

  wheelStop: {
    animMs: 280,
    impactAt: 50,
    sfx: 'wheelStop',
    haptic: 'medium'
  },

  /* ---------- 抽到「免罚一次」（惊喜，双震区分） ---------- */
  luckyHit: {
    animMs: 400,
    impactAt: 60,
    sfx: 'confetti',
    haptic: 'double'
  },

  /* ---------- 输了 / 要喝酒 ---------- */
  /*
   * 输了 / 要喝酒。
   * ★ 2026-10-28 加了第二层音效：下坠之后 260ms 一声**碰杯**。
   *   原来"输了"只有一声下坠 —— 那是游戏音，不是酒桌音。
   *   真实的酒桌上，输了这个动作的落点是"碰一杯"，那才是这声的语义。
   */
  penalized: {
    animMs: 360,
    impactAt: 60,
    sfx: 'failDrop',
    sfx2: 'glassClink',
    /* 第二层的间隔是设计出来的（"下坠"落定之后才碰杯），不是通道补偿 */
    sfx2Delay: 260,
    haptic: 'long',
    vol: VOL_CRITICAL
  },

  /* ---------- 开局倒计时读秒 ----------
     ★ 读秒**不震**（2026-10-28 按手感规范改）。
       开局倒计时每 750ms 一下，3 秒就是 4 次震动 ——
       手机在桌上一连串"嗡"，同桌的人都听得见，而且这 4 下没有任何信息量
       （数到几是靠听的、靠看的，不是靠摸的）。
       震动要留给**动作落定**，不是留给"时间在流逝"。 */
  countdownTick: {
    animMs: 750,
    impactAt: 0,
    sfx: 'countdown',
    haptic: null
  },

  /* ---------- 「开始！」 ---------- */
  countdownGo: {
    animMs: 500,
    impactAt: 0,
    sfx: 'countdownGo',
    haptic: 'heavy',
    hapticAt: 20
  },


  /* ---------- 开局摇盅（金属） ---------- */
  /*
   * ★ 2026-11-03：`haptic` 从 'light' 改成 **null**。
   *
   *   它是开局起摇，**900ms 的持续音**，而 impactAt=0（没有明确冲击帧）。
   *   给持续音配震动 = 整段摇盅期间手机一直在嗡，和 `cupShake` 那条
   *   「摇盅不震，否则整局嗡嗡响」是**同一个决定**，只是当初只改了 cupShake。
   *
   *   这就是项目里记过多次的「修一类只改被点名的那一处」：
   *   规则写在注释里、断言只锁了一个样本，同类就漏了。
   *   现在有覆盖性断言：animMs≥600 且 impactAt=0 的动作一律不许震。
   */
  shaker: {
    animMs: 900,
    impactAt: 0,
    sfx: 'shakerMetal',
    haptic: null,
    vol: VOL_DECOR
  },

  /* ============================================================
     v4 摇盅流程（按现实顺序，一声对一步）
     ------------------------------------------------------------
     真实现场：骰子入盅 → 摇盅 → **扣盅** → 揭盅 → 骰子在桌上滚两下才停。
     改造前只有"摇"这一声，扣盅那一下完全没有 ——
     而它恰恰是整条流程里最有仪式感的一下。
     ============================================================ */

  /*
   * ① 骰子入盅（骰子掉进盅里弹几下）
   *
   * ★ 2026-11-03：`animMs` 从 **620 → 420**。
   *   620 是个**孤立数字** —— 全仓只在那一行出现过，和任何动画时长都对不上。
   *   而真实视觉是 `.cs-cup.into { animation: cupInto .42s }`，也就是 420ms。
   *
   *   症状：入盅的动画 420ms 就结束了，而时间轴以为还要再持续 200ms ——
   *   于是排在它后面的调度（摇盅、扣盅）整体晚了 200ms，
   *   **画面已经停下了，音效和震动的节拍还按旧的走**。
   *   这类错位不报错、静态读代码也看不出，只能靠"animMs 必须在 wxss 里存在"这条断言。
   */
  diceIn: {
    animMs: 420,
    impactAt: 40,
    sfx: 'diceIntoCup',
    haptic: 'light',
    vol: VOL_DECOR
  },

  /* ② 摇盅（持续音，覆盖整个摇动过程）
     ★ 摇动本身**不震** —— 持续 1 秒的震动会让整局嗡嗡响，用户会直接关掉。
       这个决定有断言锁着（test-game.js ⑦）：摇盅的 haptic 必须是 null。
       手感靠声音和画面给，震动留给"扣盅"那个重音。

     ⚠️ animMs 的语义（2026-11-03 修）：
       这里是**摇盅流程的总时长**（盅一直在晃的这 1050ms），
       不是 wxss 里 `@keyframes cupShake` 的时长 —— 那个是 **340ms**，
       它是**一次晃动的周期**，用 `infinite` 循环铺满整个流程。

       两者本来不是同一个量，所以不该被"时长必须相等"的断言去判等。
       但 `autoShake()` 里曾经**裸写 1050** 来做"摇完扣盅"的定时器 ——
       那是这个数字的第三个副本。现在统一读 `CUP_SHAKE_MS`，
       改时长只改一处。 */
  cupShake: {
    animMs: CUP_SHAKE_MS,
    impactAt: 0,
    sfx: 'cupShake',
    haptic: null,
    vol: VOL_DECOR
  },

  /* ③ ★ 扣盅 —— 整个流程的重音。
     视觉是盅砸到桌面（impactAt 70ms 是砸住的那一刻），
     音效 +40ms 落在冲击帧上，震动再 +20ms（触觉最快，要最后到）。
     震动给 medium 而不是 heavy：一局要扣好几次，heavy 会腻。 */
  cupSlam: {
    animMs: 380,
    impactAt: 70,
    sfx: 'cupSlam',
    haptic: 'medium'
  },

  /* ④ 揭盅（盅提起，骰子露出来）—— 轻，主角是骰子 */
  cupLift: {
    animMs: 420,
    impactAt: 0,
    sfx: 'cupLift',
    haptic: null,
    vol: VOL_DECOR
  },

  /* ⑤ 骰子在桌上滚两下才停（揭盅之后） */
  /*
   * ★ 2026-11-03：`haptic` 从 'light' 改成 **null**。
   *
   *   两重理由，任何一条都单独成立：
   *     ① 它是 750ms 的过程型动作（impactAt=0），同 `shaker` / `cupShake`；
   *     ② 它在这段代码里是**循环触发**的（五颗骰子各落一次，间隔 90ms），
   *        一局十几次 —— 项目铁律「逐颗落定只 light，重震会被用户关掉」，
   *        而这里每次 light 叠在一起就是十几下连续震。
   *
   *   逐颗落定的手感由**声音**（`diceSettle` 的逐颗音）和视觉（90ms 错位）
   *   负责，震动留给"扣盅"那个真正的重音。
   */
  diceTable: {
    animMs: 750,
    impactAt: 0,
    sfx: 'diceOnTable',
    haptic: null,
    vol: VOL_DECOR
  },

  /* ================= 全场通用 ================= */

  /* ============ 「该你了」 ============
   * 2026-10-28 加。酒桌上手机经常是扣着放、或者人正在夹菜 ——
   * 轮到自己了却不知道，全桌都在等一个人。这是**功能性**的声音，
   * 和"开盅""结算"同档（缺了它，游戏就卡在那里）。
   *
   * 用 toggleOn（一声干脆的"嗒"）而不是 combo（那是连击奖励音，语义不符），
   * 震动用 medium：比逐颗落定的 light 重一档，但不到扣盅的 heavy ——
   * 它的意思是"轮到你了"，不是"出事了"。
   */
  /*
   * ★★★ 2026-10-30 改成单音效（用户报「声音混乱，没卡在点上」）。
   *
   * 原来这里是**双音效**：`toggleOn` + 150ms 后的 `tapSoft`，还带 medium 震动。
   * 单听挺好（像叫人名字），但它在**每一个回合**都会响 ——
   * 一局 3 人大话骰约 6 个回合，就是 6 次双音效 + 6 次叫骰音，
   * 平均每 3~5 秒一组。**问题不是单个音效难听，是密度太高、耳朵分不清哪下是什么。**
   *
   * 改成单音效 + 更轻的震动（light）：它是"提示"，不是"事件"，
   * 不需要占据听觉焦点。**重要的声音应该留给真正的动作**（摇盅/开盅/结算）。
   */
  yourTurn: {
    animMs: 320,
    impactAt: 60,
    sfx: 'toggleOn',
    haptic: 'light',
    /*
     * ★★ 音量从 VOL_CRITICAL(0.9) 降到 0.62（2026-10-30）。
     *
     * 实测源文件前 50ms：toggle-on **-11.7 dBFS**，而开盅的 reveal-hit 是 **-12.1**——
     * **提示音比开盅还响**。而它每回合都响一次，一局 6 次，
     * 等于整局都在用"最重要"的音量说"到你了"。
     * 真正该抢耳的只有三个：摇盅、开盅、结算。
     *
     * 降完之后：提示音约 -16 dBFS（比开盅低 4dB），能听见但不压主角。
     */
    vol: 0.62
  },

  /* 房主转移到我头上：不是"好消息"，是一声"该你了"，语气别太跳 */
  becomeHost: {
    animMs: 0,
    impactAt: 0,
    sfx: 'toggleOn',
    haptic: 'light',
    hapticAt: 20
  },

  /* 赢：撒花 + 长震（长震是"这局结束了"的体感信号） */
  win: {
    animMs: 0,
    impactAt: 0,
    sfx: 'confetti',
    haptic: 'long',
    hapticAt: 20
  },


  /* ================= 谁是卧底 ================= */

  /* 投票落定：轻，落一颗子 */
  uwVote: {
    animMs: 220,
    impactAt: 40,
    sfx: 'chipBet',
    haptic: 'light',
    vol: VOL_DECOR
  },

  /* 出局揭晓：全场焦点，重一些（配 slamIn 的 .44s 入场） */
  uwReveal: {
    animMs: 440,
    impactAt: 120,
    sfx: 'revealHit',
    haptic: 'medium'
  },

  /* ================= 梦幻金花 ================= */

  /* 翻开自己的牌：最轻，像用指头拨一下 */
  pkFlip: {
    animMs: 260,
    impactAt: 30,
    sfx: 'cardFlip',
    haptic: 'light',
    vol: VOL_DECOR
  },

  /*
   * 摊牌比牌：全场焦点。
   * ★ 这里是**两层音**：牌拍在桌上（cardSpread）+ 160ms 后一下揭示重击
   *   （revealHit）。表里为此加了 sfx2 字段 —— 之前只能放一个音效，
   *   于是第二层靠调用处手写 setTimeout，补偿就成了各写各的。
   */
  pkSpread: {
    animMs: 420,
    impactAt: 80,
    sfx: 'cardSpread',
    sfx2: 'revealHit',
    sfx2Delay: 270,
    haptic: 'medium'
  },

}

/* ============================================================
   派生：音效 / 震动相对于冲击帧的时刻
   ------------------------------------------------------------
   原来每个动作都手写 `sfxDelay` + `hapticDelay` 两个数字，
   规则是「视觉最先 → 音效 +30ms → 震动再 +20ms」。
   手写的后果是**漂移**：2026-10-28 逐条核算 11 个撞击类动作，
   6 条精确（+30 / +50）、4 条偏 +10ms、1 条只 +40ms ——
   同一条规律被写成三套数字，而且没有任何地方会报错。

   这和 AGENTS.md 记的「派生字段有 7 个出口」是同一个病：
   规律只该有一个出口，就是下面这两个常量。

   ★ 为什么 impactAt === 0 的条目还留一个手写的 `hapticAt`：
     那是起手音/持续音（摇盅 1 秒、揭盅、读秒），声音本来就在动作第一帧响，
     "动作开始后多久震"是另一个语义（比如摇盅要等手真的动起来 60ms 才震），
     塞进 impactAt 的公式里反而会算错。
   ============================================================ */
const SFX_LAG_MS = 30      // 音效：冲击帧之后 30ms
const HAPTIC_LAG_MS = 50   // 震动：冲击帧之后 50ms（= 音效 + 20）


/**
 * 取一个动作的完整时间线（含派生出的延迟）。
 * 表里只描述"意图"（哪个冲击帧、哪个音效、多重的震动），时刻全部由这里算。
 *
 * @param {string} key FEEDBACK 的键
 * @returns {object|null}
 */
function timeline(key) {
  const f = FEEDBACK[key]
  if (!f) return null
  const impact = f.impactAt || 0
  return {
    animMs: f.animMs,
    impactAt: impact,
    sfx: f.sfx || null,
    sfxDelay: impact > 0 ? impact + SFX_LAG_MS : 0,
    sfx2: f.sfx2 || null,
    /* 第二层音效的间隔是**设计出来的**（"牌落桌 + 190ms 后揭示重击"），
       不是通道补偿，所以保持手写，不参与派生 */
    sfx2Delay: f.sfx2 ? (f.sfx2Delay || 0) : 0,
    haptic: f.haptic || null,
    hapticDelay: impact > 0 ? impact + HAPTIC_LAG_MS : (f.hapticAt || 0),
    /* 没写 vol 的就是关键档 —— 默认取高，漏写宁可响一点也不要听不见 */
    vol: typeof f.vol === 'number' ? f.vol : VOL_CRITICAL
  }
}

/* ============================================================
   震动
   ============================================================ */

/* 节流：同一动作在这么短时间内不重复震。
   骰子密集落定时几次调用会挤在一起，不节流会变成连续嗡嗡。 */
/*
 * 震动 = **薄包装**，真正的状态在 utils/haptic.js（主包）。
 *
 * ★ 2026-10-28 拆分时的重要决定：这里**不重新实现**，只转发。
 *   否则会出现"大厅关掉震动、进房间又响了"——两份 storage 各记各的，
 *   而这类 bug 在真机上极难查（用户只会说"震动有时灵有时不灵"）。
 */
function vibrate(kind) { return haptic.vibrate(kind) }

function isHapticOn() { return haptic.isHapticOn() }

function setHapticOn(v) { return haptic.setHapticOn(v) }

/* ============================================================
   统一触发
   ============================================================ */

/**
 * 按时间轴表触发一个动作的反馈。
 *
 * @param {string} key     FEEDBACK 里的键
 * @param {object} opt     { volume, pitch, onImpact } 覆盖项
 * @returns {number} 最长的定时器 id（页面可留着清理）
 *
 * 用法（页面里）：
 *     feedback.fire('diceSettle')
 * 而不是原来的：
 *     sfx.play('diceSettle'); wx.vibrateShort(...)   // 各处自己算时间
 */
const _timers = []

/*
 * ★★ 2026-11-03：统一排期入口 —— **执行完就把自己从数组里摘掉**。
 *
 *   原来每处都直接 `_timers.push(setTimeout(...))`，而唯一的清理是 `clear()`
 *   （只在页面卸载时调）。一局几十次 fire、逐颗落定又各排一次，
 *   数组会堆到几百个**早就执行完**的句柄 —— 引用不放，JS 堆就不回收。
 *
 *   实测：连续 fire 200 次 diceSettle，数组峰值 400、执行完仍是 **400**。
 *   这属于"玩久了开始卡"那类问题，不报错、不做长局压力测试根本发现不了。
 *
 *   判据：**排期对象必须自己负责注销自己。** 谁 push 谁负责、而且是在回调里负责，
 *   不能指望"某个时刻会有别人来统一清"。
 */
function _schedule(fn, delay) {
  const id = setTimeout(function () {
    /*
     * 先摘掉自己再执行 —— 即使 fn 里抛错，也不会留下僵尸引用。
     * （用 indexOf 而不是假设"一定在末尾"：多个定时器的执行顺序不保证。）
     */
    const i = _timers.indexOf(id)
    if (i >= 0) _timers.splice(i, 1)
    fn()
  }, delay)
  _timers.push(id)
  return id
}
function fire(key, opt) {
  const f = timeline(key)
  if (!f) {
    console.warn('[feedback] 没有这个动作:', key)
    return
  }
  opt = opt || {}

  /*
   * 音效。
   * ★ 音量按档位走（关键 0.9 / 装饰 0.45），调用方显式传的 volume 优先 ——
   *   页面偶尔需要"这一次更轻"（比如连击叠加时）。
   */
  if (f.sfx) {
    const vol = typeof opt.volume === 'number' ? opt.volume : f.vol
    const playIt = () => sfx.play(f.sfx, Object.assign({}, opt, { volume: vol }))
    if (opt.sfxDelay !== undefined ? opt.sfxDelay : f.sfxDelay) {
      _schedule(playIt, opt.sfxDelay !== undefined ? opt.sfxDelay : f.sfxDelay)
    } else {
      playIt()
    }
  }

  /* 第二层音效（如"牌落桌 + 揭示重击"这种两层设计） */
  if (f.sfx2) {
    const d2 = opt.sfx2Delay !== undefined ? opt.sfx2Delay : f.sfx2Delay
    const play2 = () => sfx.play(f.sfx2, Object.assign({}, opt,
      { volume: typeof opt.volume === 'number' ? opt.volume : f.vol }))
    if (d2) _schedule(play2, d2)
    else play2()
  }

  /* 震动 */
  if (f.haptic) {
    const kind = opt.haptic || f.haptic
    const d = opt.hapticDelay !== undefined ? opt.hapticDelay : f.hapticDelay
    if (d) {
      _schedule(() => vibrate(kind), d)
    } else {
      vibrate(kind)
    }
  }

  /* 冲击帧回调：让页面把「视觉那一刻」要做的 setData 交给这张表统一排期 */
  if (opt.onImpact && f.impactAt) {
    _schedule(opt.onImpact, f.impactAt)
  }
}

/** 清掉排期中的反馈（页面 onUnload 调用） */
function clear() {
  _timers.forEach((t) => clearTimeout(t))
  _timers.length = 0
}

module.exports = {
  FEEDBACK,
  /*
   * ★ 2026-11-03：把排期数组暴露出来**只为可测**。
   *   它必须能被断言观测到"执行完有没有回落"，否则"内存泄漏"这类问题
   *   只能靠玩久了变卡来发现 —— 而那已经太晚了。
   */
  _timers,
  /* 摇盅流程时长：房间页要拿它做"摇完扣盅"的定时器，不能再裸写数字 */
  CUP_SHAKE_MS,
  timeline,
  fire,
  clear,
  vibrate,
  isHapticOn,
  setHapticOn
}
