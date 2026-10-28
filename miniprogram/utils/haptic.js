/**
 * haptic.js —— 震动开关与触发（主包）
 *
 * ★ 2026-10-28 从 feedback.js 抽出来的。
 *
 * 为什么要拆：`feedback.js` 要播所有音效，而音频（580KB）必须留在主包才能
 * 让大厅和「我的」用 —— 但主包越瘦首屏越快。所以把"震动"这件事单独拿出来：
 *   · 本文件（主包）：只管开关状态 + 触发震动，不碰音频
 *   · `game/feedback.js`（分包）：完整的时间轴，含音效排期
 *
 * 大厅和「我的」只用得到开关，require 这一份就够；
 * 房间页用分包那份（它内含时间轴）。
 */

/* 震动节流：60ms 内不重复震 —— 一局里连续落定十几下，不节流会震到手麻 */
const HAPTIC_THROTTLE_MS = 60
let _lastHapticAt = 0

/*
 * 延迟副作用（双击的第二下）要能被打断。
 * ⚠️ 这个数组原来叫 `_timers`、长在 feedback.js 里 —— 拆分时抽到这边，
 *    但调用处没改，于是测试报 `_timers is not defined`。
 *    凡是这种"延迟副作用"都必须有地方登记，否则离开页面还会响一下。
 */
const _timers = []

function clear() {
  _timers.forEach((t) => clearTimeout(t))
  _timers.length = 0
}

const HAPTIC_KEY = 'hapticOn'

/*
 * 「减少动效」开关（2026-10-28，调研第 12 条）。
 * Jackbox 有 Motion Sensitivity 开关 —— 晕动症、嫌花的人需要一个出路。
 * 和震动一样是"反馈偏好"，所以放在同一个模块里。
 *
 * 开启后：房间页根节点挂 `.reduce-motion`，CSS 把动画时长压到 1/3。
 * ⚠️ 只缩短、不删除：骰子落定/开盅这些**功能性**动画（告诉你发生了什么）
 *    不能没有，但可以快。
 */
const MOTION_KEY = 'reduceMotion'
let _reduceMotion = null
function _initMotion() {
  if (_reduceMotion !== null) return
  try { _reduceMotion = !!wx.getStorageSync(MOTION_KEY) } catch (e) { _reduceMotion = false }
}
function isReduceMotion() { _initMotion(); return !!_reduceMotion }
function setReduceMotion(v) {
  _reduceMotion = !!v
  try { wx.setStorageSync(MOTION_KEY, _reduceMotion) } catch (e) {}
  return _reduceMotion
}
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

module.exports = { vibrate, isHapticOn, setHapticOn, isReduceMotion, setReduceMotion, clear }
