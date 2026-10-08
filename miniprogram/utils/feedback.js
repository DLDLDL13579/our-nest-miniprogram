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
const FEEDBACK = {
  /* ---------- 骰子逐颗落定 ---------- */
  diceSettle: {
    animMs: 420,
    impactAt: 60,
    sfx: 'diceSettle',
    sfxDelay: 90,
    haptic: 'light',
    hapticDelay: 110
  },

  /* ---------- 全部落定 / 开盅揭晓（重） ---------- */
  cupOpen: {
    animMs: 340,
    impactAt: 70,
    sfx: 'revealHit',
    sfxDelay: 110,
    haptic: 'heavy',
    hapticDelay: 130
  },

  /* ---------- 转盘停稳 ---------- */
  wheelStop: {
    animMs: 280,
    impactAt: 50,
    sfx: 'wheelStop',
    sfxDelay: 90,
    haptic: 'medium',
    hapticDelay: 110
  },

  /* ---------- 抽到「免罚一次」（惊喜，双震区分） ---------- */
  luckyHit: {
    animMs: 400,
    impactAt: 60,
    sfx: 'confetti',
    sfxDelay: 100,
    haptic: 'double',
    hapticDelay: 120
  },

  /* ---------- 输了 / 要喝酒 ---------- */
  penalized: {
    animMs: 360,
    impactAt: 60,
    sfx: 'failDrop',
    sfxDelay: 100,
    haptic: 'long',
    hapticDelay: 120
  },

  /* ---------- 开局倒计时读秒 ---------- */
  countdownTick: {
    animMs: 750,
    impactAt: 0,
    sfx: 'countdown',
    sfxDelay: 0,
    haptic: 'light',
    hapticDelay: 20
  },

  /* ---------- 「开始！」 ---------- */
  countdownGo: {
    animMs: 500,
    impactAt: 0,
    sfx: 'countdownGo',
    sfxDelay: 0,
    haptic: 'heavy',
    hapticDelay: 20
  },

  /* ---------- 摇骰过程（连续音，不震 —— 避免整局嗡嗡响） ---------- */
  tumble: {
    animMs: 1300,
    impactAt: 0,
    sfx: 'diceTumbleWood',
    sfxDelay: 0,
    haptic: null,
    hapticDelay: 0
  },

  /* ---------- 开局摇盅（金属） ---------- */
  shaker: {
    animMs: 900,
    impactAt: 0,
    sfx: 'shakerMetal',
    sfxDelay: 0,
    haptic: 'light',
    hapticDelay: 60
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
    /* 微信只提供「震一次」，双击靠排期 —— 120ms 间隔听感上是两次 */
    safeShort('light')
    setTimeout(() => {
      _lastHapticAt = 0        // 绕过节流，双击的第二次必须响
      safeShort('light')
    }, 120)
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
  const f = FEEDBACK[key]
  if (!f) {
    console.warn('[feedback] 没有这个动作:', key)
    return
  }
  opt = opt || {}

  /* 音效 */
  if (f.sfx) {
    const playIt = () => sfx.play(f.sfx, opt)
    if (opt.sfxDelay !== undefined ? opt.sfxDelay : f.sfxDelay) {
      _timers.push(setTimeout(playIt, opt.sfxDelay !== undefined ? opt.sfxDelay : f.sfxDelay))
    } else {
      playIt()
    }
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
  fire,
  clear,
  vibrate,
  isHapticOn,
  setHapticOn
}
