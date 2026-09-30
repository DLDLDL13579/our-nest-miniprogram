/**
 * 音效播放器
 *
 * 为什么要包一层，而不是每个页面各自 new InnerAudioContext：
 *   1. **复用实例**。InnerAudioContext 是有限资源，微信限制同时存在的实例数；
 *      每个音效各建一个、用完不销毁，玩几局就会报错。
 *   2. **预加载**。第一次播放某音效会有几十毫秒延迟（解码），
 *      摇骰子时这个延迟会让"哗啦声"慢半拍 —— 手感就毁了。
 *   3. **静音开关**。酒桌上可能不方便出声，要能一键关掉且记得住。
 *
 * 音效是代码合成的（scripts/gen-audio.py），全部打进主包 ——
 * 放云存储的话首次下载有网络延迟，"即点即响"就做不到了。
 */

const MUTE_KEY = 'gameMute'

/* 所有音效清单。集中在这里，避免各页面写错文件名。 */
const FILES = {
  // 骰子
  diceHit: 'audio/dice-hit.wav',
  diceShake: 'audio/dice-shake.wav',
  diceRoll: 'audio/dice-roll.wav',
  diceSettle: 'audio/dice-settle.wav',
  diceOpen: 'audio/dice-open.wav',
  diceFanfare: 'audio/dice-fanfare.wav',
  // 转盘
  tick: 'audio/tick.wav',
  wheelStart: 'audio/wheel-start.wav',
  wheelLoop: 'audio/wheel-loop.wav',
  wheelSlow: 'audio/wheel-slow.wav',
  wheelStop: 'audio/wheel-stop.wav',
  // 情绪
  win: 'audio/win.wav',
  lose: 'audio/lose.wav',
  drink: 'audio/drink.wav',
  clink: 'audio/clink.wav',
  pour: 'audio/pour.wav',
  suspense: 'audio/suspense.wav',
  reveal: 'audio/reveal.wav',
  whoosh: 'audio/whoosh.wav',
  // UI
  tap: 'audio/tap.wav',
  tapSoft: 'audio/tap-soft.wav',
  toggleOn: 'audio/toggle-on.wav',
  toggleOff: 'audio/toggle-off.wav',
  countdown: 'audio/countdown.wav',
  countdownGo: 'audio/countdown-go.wav'
}

/* 每个音效一个可复用实例 */
const pool = {}
/* 需要循环的（转盘嗡鸣），单独记录 */
const looping = {}

let muted = false
let inited = false

function init() {
  if (inited) return
  inited = true
  try { muted = !!wx.getStorageSync(MUTE_KEY) } catch (e) { muted = false }
}

/**
 * 播放。
 * @param {string} key   FILES 里的键
 * @param {object} opt   { loop: 循环, volume: 0~1, restart: 重头播 }
 */
function play(key, opt) {
  init()
  if (muted) return null

  const src = FILES[key]
  if (!src) {
    console.warn('[sfx] 没有这个音效:', key)
    return null
  }
  opt = opt || {}

  try {
    let a = pool[key]
    if (!a) {
      a = wx.createInnerAudioContext()
      a.src = src
      /* 音效不参与系统静音开关以外的音频焦点争夺：
         obeyMuteSwitch=false 让 iOS 静音键下仍能出声 —— 酒桌游戏需要这个，
         否则用户开了静音就完全没声音，会以为坏了。 */
      a.obeyMuteSwitch = false
      pool[key] = a
    }

    a.loop = !!opt.loop
    a.volume = typeof opt.volume === 'number' ? opt.volume : 1

    if (opt.loop) {
      looping[key] = a
      a.play()
    } else {
      /* restart：同一个音效连续触发时（比如快速点转盘），
         不 stop 会排队等前一次播完，听感上"慢半拍" */
      if (opt.restart !== false) {
        try { a.stop() } catch (e) {}
      }
      a.play()
    }
    return a
  } catch (e) {
    /* 播放失败不该影响游戏流程 */
    console.warn('[sfx] 播放失败', key, e.errMsg || e.message)
    return null
  }
}

/** 停掉某个循环音效 */
function stop(key) {
  const a = looping[key] || pool[key]
  if (!a) return
  try { a.stop() } catch (e) {}
  delete looping[key]
}

/** 停掉所有（页面 onHide 时调用，避免退到后台还在响） */
function stopAll() {
  Object.keys(pool).forEach((k) => {
    try { pool[k].stop() } catch (e) {}
  })
  Object.keys(looping).forEach((k) => delete looping[k])
}

/**
 * 销毁。页面 onUnload 时调用 —— 不销毁会泄漏音频实例，
 * 微信对同时存在的实例数有限制。
 */
function destroy() {
  stopAll()
  Object.keys(pool).forEach((k) => {
    try { pool[k].destroy() } catch (e) {}
    delete pool[k]
  })
}

function isMuted() { init(); return muted }

function setMuted(v) {
  init()
  muted = !!v
  try { wx.setStorageSync(MUTE_KEY, muted) } catch (e) {}
  if (muted) stopAll()
  /* 给一个反馈音：关掉时用 toggleOff，打开时用 toggleOn。
     注意这里要绕过 muted 判断 —— 否则"打开声音"那一下自己是哑的。 */
  const wasMuted = muted
  muted = false
  play(v ? 'toggleOn' : 'toggleOff')
  muted = wasMuted
  return muted
}

module.exports = { play, stop, stopAll, destroy, isMuted, setMuted, FILES }
