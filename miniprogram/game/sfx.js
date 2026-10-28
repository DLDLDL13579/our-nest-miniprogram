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
  diceSettle: '/game/audio/dice-settle.wav',
  // 转盘
  tick: '/audio/tick.wav',
  wheelStart: '/game/audio/wheel-start.wav',
  wheelStop: '/game/audio/wheel-stop.wav',
  // 情绪
  drink: '/game/audio/drink.wav',
  whoosh: '/game/audio/whoosh.wav',
  // UI
  tap: '/game/audio/tap.wav',
  tapSoft: '/game/audio/tap-soft.wav',
  toggleOn: '/game/audio/toggle-on.wav',
  toggleOff: '/game/audio/toggle-off.wav',
  countdown: '/game/audio/countdown.wav',
  countdownGo: '/game/audio/countdown-go.wav',
  /* v3 补充：分层质感与情绪音（腾讯工作室级的那一层） */
  impactLow: '/game/audio/impact-low.wav',        // 低频冲击层，给"重"的动作垫底
  shakerMetal: '/game/audio/shaker-metal.wav',    // 金属骰盅（大话骰用）
  diceTumbleWood: '/game/audio/dice-tumble-wood.wav', // 木质骰子（摇骰子用）
  combo1: '/game/audio/combo-1.wav',              // 连击（音高逐级递增）
  combo2: '/game/audio/combo-2.wav',
  combo3: '/game/audio/combo-3.wav',
  combo4: '/game/audio/combo-4.wav',
  failDrop: '/game/audio/fail-drop.wav',          // 失败下坠（比 lose 更重）
  chargeUp: '/game/audio/charge-up.wav',          // 蓄力（揭晓前的紧张）
  revealHit: '/game/audio/reveal-hit.wav',        // 揭晓重击（明亮+冲击+金属尾音）
  countdownUrgent: '/game/audio/countdown-urgent.wav', // 最后三秒的急促
  chipBet: '/game/audio/chip-bet.wav',            // 筹码声（酒桌氛围）
  gulp: '/game/audio/gulp.wav',                   // 咽酒声
  /* ★ 碰杯（2026-10-28 新增）：35 个音效里原来**一个杯子都没有**，
     只有"咽酒"。而"碰一杯"才是酒桌上最有仪式感的那一下。
     素材来自 Kenney Impact Sounds（CC0），真实玻璃碰撞，起音 0ms。 */
  glassClink: '/game/audio/glass-clink.wav',      // 碰杯（罚酒/干杯那一刻）
  confetti: '/game/audio/confetti.wav',           // 撒花（赢了）
  /* v4 骰盅组：一个完整的摇盅流程，按现实顺序拆成五声。
     改造前只有"摇"这一声，且是一次性播放 —— 缺的正是扣盅那一下，
     而它恰恰是"真实现场"和"电子游戏"差别最大的地方。 */
  diceIntoCup: '/game/audio/dice-into-cup.wav',   // ① 骰子入盅（弹跳声，间隔递减）
  cupShake: '/game/audio/cup-shake.wav',          // ② 摇盅（带 3.5Hz 手摇起伏）
  cupSlam: '/game/audio/cup-slam.wav',            // ③ ★ 扣盅闷响（含盅内骰子被震跳）
  cupLift: '/game/audio/cup-lift.wav',            // ④ 揭盅（口沿离桌的摩擦）
  diceOnTable: '/game/audio/dice-on-table.wav',   // ⑤ 骰子在桌上滚两下才停

  /* ---------- 纸牌组（梦幻金花）----------
     和骰子音色完全不同：纸是薄片，几乎没有低频，
     拿骰子音效代替会"厚重得不像纸"。
     cardDeal 发牌 / cardFlip 翻牌 / cardSpread 摊牌比牌 */
  cardDeal: '/game/audio/card-deal.wav',
  cardFlip: '/game/audio/card-flip.wav',
  cardSpread: '/game/audio/card-spread.wav'
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
 * 高频音效需要多个实例轮转。
 *
 * 为什么：转盘的咔哒最快 34ms 一次，而 InnerAudioContext 的 stop() + play()
 * 要跨线程走一趟，实测在高频下会互相打断（听起来"卡壳"）。
 * 给它准备 3 个实例轮流用，前一个还在响就换下一个，声音就连续了。
 *
 * 只有这几个高频短音效需要 —— 其他音效（开盅、中奖）间隔都在百毫秒以上，
 * 单个实例足够。不做成"全部 3 个"是为了省实例：微信对同时存在的
 * InnerAudioContext 数量有限制。
 */
const POOL_SIZE = {
  tick: 3,
  tap: 2,
  tapSoft: 2,
  /* v3：金属盅碰撞极密（22ms 一次），必须多实例 */
  shakerMetal: 3,
  chipBet: 3,
  countdownUrgent: 2,
  /* v4：扣盅那一下要和盅内骰子的跳动叠在一起播，单实例会互相打断 */
  cupSlam: 2,
  diceOnTable: 2
}
const poolIdx = {}

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
    const size = POOL_SIZE[key] || 1
    let a

    if (size > 1) {
      /* 轮转：每次取下一个实例，避免打断正在播的那个 */
      const i = (poolIdx[key] || 0) % size
      poolIdx[key] = i + 1
      const slot = key + '#' + i
      a = pool[slot]
      if (!a) {
        a = wx.createInnerAudioContext()
        a.src = src
        a.obeyMuteSwitch = false
        pool[slot] = a
      }
    } else {
      a = pool[key]
      if (!a) {
        a = wx.createInnerAudioContext()
        a.src = src
        /* 音效不参与系统静音开关以外的音频焦点争夺：
           obeyMuteSwitch=false 让 iOS 静音键下仍能出声 —— 酒桌游戏需要这个，
           否则用户开了静音就完全没声音，会以为坏了。 */
        a.obeyMuteSwitch = false
        pool[key] = a
      }
    }

    a.loop = !!opt.loop
    a.volume = typeof opt.volume === 'number' ? opt.volume : 1

    /* ★ 音高随机化 —— 商业游戏音效的标配细节。
       同一个音效连续播多次（比如骰子连撞 10 下、转盘咔哒 40 次），
       如果每次都一模一样，耳朵立刻会听出"这是循环播放的采样"。
       每次给 ±4% 的播放速率抖动，听感上就是"每次都不一样"。
       幅度不能大：超过 8% 会明显变调，像坏了。 */
    const jitter = opt.pitch === false ? 1 : (1 + (Math.random() - 0.5) * 0.08)
    try {
      if (typeof a.playbackRate === 'number' || a.playbackRate === undefined) {
        a.playbackRate = jitter
      }
    } catch (e) { /* 个别机型不支持，忽略 */ }

    if (opt.loop) {
      looping[key] = a
      a.play()
    } else {
      /* restart：同一个音效连续触发时（比如快速点转盘），
         不 stop 会排队等前一次播完，听感上"慢半拍"。
         多实例轮转的情况下不需要 stop（换了个实例），省一次跨线程调用。 */
      if (size === 1 && opt.restart !== false) {
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

/**
 * 预加载几个"第一下不能慢"的音效。
 *
 * ★★ 2026-10-28 补。之前 room.js 里写着 `sfx.init && sfx.init()` ——
 *   而 sfx **从来没导出过 init**，那行是死代码，音效一次都没预加载过。
 *   而文件开头的注释明明写着"预加载是手感的一部分"：
 *   第一次播放某音效有几十毫秒解码延迟，摇骰子时这个延迟会让哗啦声慢半拍。
 *
 * 为什么只预加载几个：微信对同时存在的 InnerAudioContext 数量有限制
 * （十几个），35 个全建会撞上限。这五个是"每个动作的第一下"，
 * 它们慢了最明显。
 */
const PRELOAD_KEYS = ['shakerMetal', 'diceTumbleWood', 'cupSlam', 'cardFlip', 'tapSoft']

function preload() {
  PRELOAD_KEYS.forEach((k) => {
    const src = FILES[k]
    if (!src) return
    /* 池化的音效（POOL_SIZE > 1）跳过：它们的实例是按 slot 名建的，
       预加载塞进 pool[k] 会和真正的播放逻辑打架 */
    if (POOL_SIZE[k] > 1) return
    if (pool[k]) return
    try {
      const a = wx.createInnerAudioContext()
      a.src = src
      a.obeyMuteSwitch = false
      pool[k] = a
    } catch (e) {
      /* 预加载失败不影响播放（只是第一下慢一点） */
    }
  })
}

module.exports = { play, stop, stopAll, destroy, isMuted, setMuted, preload, FILES }
