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
const VOL_CRITICAL = 0.9
const VOL_DECOR = 0.45

const FEEDBACK = {
  /* ---------- 骰子逐颗落定 ---------- */
  diceSettle: {
    animMs: 420,
    impactAt: 60,
    sfx: 'diceSettle',
    haptic: 'light',
    vol: VOL_DECOR
  },

  /* ---------- 全部落定 / 开盅揭晓（重） ---------- */
  cupOpen: {
    animMs: 340,
    impactAt: 70,
    sfx: 'revealHit',
    haptic: 'heavy'
  },

  /* ---------- 转盘停稳 ---------- */
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
  shaker: {
    animMs: 900,
    impactAt: 0,
    sfx: 'shakerMetal',
    haptic: 'light',
    hapticAt: 60,
    vol: VOL_DECOR
  },

  /* ============================================================
     v4 摇盅流程（按现实顺序，一声对一步）
     ------------------------------------------------------------
     真实现场：骰子入盅 → 摇盅 → **扣盅** → 揭盅 → 骰子在桌上滚两下才停。
     改造前只有"摇"这一声，扣盅那一下完全没有 ——
     而它恰恰是整条流程里最有仪式感的一下。
     ============================================================ */

  /* ① 骰子入盅（骰子掉进盅里弹几下） */
  diceIn: {
    animMs: 620,
    impactAt: 40,
    sfx: 'diceIntoCup',
    haptic: 'light',
    vol: VOL_DECOR
  },

  /* ② 摇盅（持续音，覆盖整个摇动过程）
     ★ 摇动本身**不震** —— 持续 1 秒的震动会让整局嗡嗡响，用户会直接关掉。
       这个决定有断言锁着（test-game.js ⑦）：摇盅的 haptic 必须是 null。
       手感靠声音和画面给，震动留给"扣盅"那个重音。 */
  cupShake: {
    animMs: 1050,
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
  diceTable: {
    animMs: 750,
    impactAt: 0,
    sfx: 'diceOnTable',
    haptic: 'light',
    hapticAt: 40,
    vol: VOL_DECOR
  },

  /* ================= 全场通用 ================= */

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
const HAPTIC_THROTTLE_MS = 60
let _lastHapticAt = 0
/* 用户总开关（和静音合并成一个「反馈」开关，但独立记忆） */
const HAPTIC_KEY = 'hapticOn'
let _hapticOn = null

function _initHaptic() {
  if (_hapticOn !== null) return
  try {
    const v = wx.getStorageSync(HAPTIC_KEY)
    /* 默认开 —— 大多数游戏默认开震动，且用户能关 */
    _hapticOn = v === '' || v === undefined || v === null ? true : !!v
  } catch (e) {
    _hapticOn = true
  }
}

/**
 * 触发震动。
 *
 * ★ 降级策略：`type` 参数（heavy/medium/light）需要 2.13.0+，
 *   且在部分平台被忽略。所以：
 *     · 先试带 type 的调用
 *     · 失败（或 type 不被支持）就退化成无参调用
 *   绝不能因为震动失败而抛错影响游戏流程。
 */
function vibrate(kind) {
  _initHaptic()
  if (!_hapticOn || !kind) return

  const now = Date.now()
  if (now - _lastHapticAt < HAPTIC_THROTTLE_MS) return
  _lastHapticAt = now

  const safeShort = (t) => {
    try {
      if (t) {
        wx.vibrateShort({ type: t, fail: () => { try { wx.vibrateShort({}) } catch (e) {} } })
      } else {
        wx.vibrateShort({ fail: () => {} })
      }
    } catch (e) { /* 完全不支持就算了，不能影响玩法 */ }
  }

  if (kind === 'long') {
    try { wx.vibrateLong({ fail: () => safeShort('heavy') }) }
    catch (e) { safeShort('heavy') }
    return
  }

  if (kind === 'double') {
    /*
     * 微信只提供「震一次」，双击靠排期 —— 120ms 间隔听感上是两次。
     *
     * ★ 这个定时器必须进 `_timers`（2026-10-09 修）：
     *   原来是裸 setTimeout，`clear()` 清不掉。触发 double 后 120ms 内
     *   离开页面/退到后台，第二次震动仍会响 —— 用户已经不在那个场景里了。
     *   后果轻（只多震一下，无 setData、无实例泄漏），
     *   但**凡是"延迟副作用"都该能被打断**，这是同一类问题。
     */
    safeShort('light')
    _timers.push(setTimeout(() => {
      _lastHapticAt = 0        // 绕过节流，双击的第二次必须响
      safeShort('light')
    }, 120))
    return
  }

  safeShort(kind)
}

function isHapticOn() {
  _initHaptic()
  return !!_hapticOn
}

function setHapticOn(v) {
  _hapticOn = !!v
  try { wx.setStorageSync(HAPTIC_KEY, _hapticOn) } catch (e) {}
  if (_hapticOn) vibrate('light')   // 给个反馈：能感觉到就是开了
  return _hapticOn
}

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
      _timers.push(setTimeout(playIt, opt.sfxDelay !== undefined ? opt.sfxDelay : f.sfxDelay))
    } else {
      playIt()
    }
  }

  /* 第二层音效（如"牌落桌 + 揭示重击"这种两层设计） */
  if (f.sfx2) {
    const d2 = opt.sfx2Delay !== undefined ? opt.sfx2Delay : f.sfx2Delay
    const play2 = () => sfx.play(f.sfx2, Object.assign({}, opt,
      { volume: typeof opt.volume === 'number' ? opt.volume : f.vol }))
    if (d2) _timers.push(setTimeout(play2, d2))
    else play2()
  }

  /* 震动 */
  if (f.haptic) {
    const kind = opt.haptic || f.haptic
    const d = opt.hapticDelay !== undefined ? opt.hapticDelay : f.hapticDelay
    if (d) {
      _timers.push(setTimeout(() => vibrate(kind), d))
    } else {
      vibrate(kind)
    }
  }

  /* 冲击帧回调：让页面把「视觉那一刻」要做的 setData 交给这张表统一排期 */
  if (opt.onImpact && f.impactAt) {
    _timers.push(setTimeout(opt.onImpact, f.impactAt))
  }
}

/** 清掉排期中的反馈（页面 onUnload 调用） */
function clear() {
  _timers.forEach((t) => clearTimeout(t))
  _timers.length = 0
}

module.exports = {
  FEEDBACK,
  timeline,
  fire,
  clear,
  vibrate,
  isHapticOn,
  setHapticOn
}
