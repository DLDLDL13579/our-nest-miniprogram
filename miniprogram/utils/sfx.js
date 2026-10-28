/**
 * sfx.js（主包精简版）—— 只留一个音效给「我的」页试听用
 *
 * ★ 2026-10-28 拆分。
 *
 * 为什么要拆：音频（580KB）是主包的绝对大头，而**主包越小首屏越快**。
 * 但音效不能全进分包 —— 微信的规则是"分包可以引用主包资源，
 * 主包不能引用分包资源"，而大厅和「我的」都要出声：
 *   · 大厅：进房时的 whoosh（拆完后不再播，见 lobby.js）
 *   · 我的：开音效开关时试听一声，**这个必须留** ——
 *     不然用户没法确认开关到底生效没有
 *
 * 所以主包只留 `tick.wav`（1.5KB），其余 34 个音效和时间轴都在分包
 * `game/sfx.js` 与 `game/feedback.js` 里。
 */

const MUTE_KEY = 'gameMute'
let _muted = null

function _init() {
  if (_muted !== null) return
  try { _muted = !!wx.getStorageSync(MUTE_KEY) } catch (e) { _muted = false }
}

function isMuted() { _init(); return !!_muted }

function setMuted(v) {
  _muted = !!v
  try { wx.setStorageSync(MUTE_KEY, _muted) } catch (e) {}
  return _muted
}

/** 只支持 tick（试听音） */
function play(key) {
  _init()
  if (_muted) return
  if (key !== 'tick') return   // 主包只有这一个；其余走分包 game/sfx.js
  try {
    const a = wx.createInnerAudioContext()
    a.src = '/audio/tick.wav'
    a.volume = 0.9
    a.onEnded(() => { try { a.destroy() } catch (e) {} })
    a.onError(() => { try { a.destroy() } catch (e) {} })
    a.play()
  } catch (e) {}
}

module.exports = { isMuted, setMuted, play, stopAll() {} }
