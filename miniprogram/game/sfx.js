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
  /* 三份不同录音 —— 一局要响十几次，变体比变调自然（见 play 里的说明） */
  diceSettle: [
    '/game/audio/dice-settle.wav',
    '/game/audio/dice-settle-2.wav',
    '/game/audio/dice-settle-3.wav'
  ],
  // 转盘
  /*
   * 转盘咔哒一局要响 40 次（转一圈八九下 × 四五圈）——
   * 同一个声音连听 40 次，再短也会被听成"打点机"。
   *
   * 三份**波形不同**的变体（不是调音高：方波 1400/1330/1470Hz，
   * 占空比 .50/.42/.58，指数尾巴 3.5/3.0/2.0ms）——
   * 三个维度都略不同，听感是"指针划过不同的格子"。
   * 三份的 RMS 已对齐到同一值（实测 -18.6dBFS），不会一下轻一下响。
   *
   * ⚠️ 2026-11-03：这句话曾经是**假的**。README 写着 -16.9dBFS，
   *    而实测三份是 -18.6 / -13.6 / -20.0 —— 最大差 6.4dB（约 2 倍响度）。
   *    转盘一圈响 40 次咔哒，其中 1/3 落在最响的那份上，
   *    听感是"每隔两三下突然变响一次"。
   *    根因是三个变体在 import-audio.py 里各自配了 fifty=-14/-14/-16：
   *    **"各自看起来合理的目标值"合起来就是不一致**。
   *    现在有 check-audio-variants.py 守着（同组 RMS 差 ≤1dB），
   *    改音频请跑 test-all.sh，别只信注释。
   * 转盘那边仍然 pitch:false —— 咔哒声变调会很怪。
   *
   * 注意 tick 是唯一留在主包（「我的」页试听用）的音效，
   * 所以第一项是主包路径、后两项在分包（分包可以引主包，反之不行）。
   */
  tick: [
    '/audio/tick.wav',
    '/game/audio/tick-2.wav',
    '/game/audio/tick-3.wav'
  ],
  /* 环境底噪（4 秒循环）—— 房间不该是绝对安静的 */
  ambientRoom: '/game/audio/ambient-room.wav',
  wheelStart: '/game/audio/wheel-start.wav',
  wheelStop: '/game/audio/wheel-stop.wav',
  // 情绪
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
  combo1: '/game/audio/combo-1.wav',              // 连击（音高逐级递增）
  combo2: '/game/audio/combo-2.wav',
  combo3: '/game/audio/combo-3.wav',
  combo4: '/game/audio/combo-4.wav',
  failDrop: '/game/audio/fail-drop.wav',          // 失败下坠（比 lose 更重）
  chargeUp: '/game/audio/charge-up.wav',          // 蓄力（揭晓前的紧张）
  revealHit: '/game/audio/reveal-hit.wav',        // 揭晓重击（明亮+冲击+金属尾音）
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
  /* v4：扣盅那一下要和盅内骰子的跳动叠在一起播，单实例会互相打断 */
  cupSlam: 2,
  diceOnTable: 2,
  /*
   * ★★★ 2026-11-02：`diceSettle` 漏了，而它是**最需要池**的一个。
   *
   *   逐颗落定的间隔是 **90ms**（`.cs-die` 的 animation-delay），
   *   而音效换成本地真实录音后长 **300ms** ——
   *   没有池的话，第 2 颗会打断第 1 颗，**「啪啪啪啪啪」实际只剩最后一声**。
   *
   *   5 颗 → 取 3 个实例够用（90ms 间隔、300ms 时长，最多同时 4 个在响，
   *   而第 4 颗起已经是尾音，打断也听不出来）。
   */
  diceSettle: 3
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

  /*
   * ★ 多采样变体（2026-10-30）。
   *
   * 骰子落定这类"一局响十几次"的音效，只靠 playbackRate ±4% 变调是
   * "同一个声音变声"——听久了能察觉。项目素材里本来就有 die-throw-1/2/3
   * 三份**不同录音**，把它们都排进 FILES 数组即可：play 时随机挑一个，
   * 每个变体各占一个池槽（切变体零成本，不用每次改 src 触发跨线程调用）。
   *
   * 兼容：FILES 的值是字符串时行为完全不变。
   */
  const srcOrList = FILES[key]
  if (!srcOrList) {
    console.warn('[sfx] 没有这个音效:', key)
    return null
  }
  const variants = Array.isArray(srcOrList) ? srcOrList : null
  opt = opt || {}

  try {
    const size = variants ? variants.length : (POOL_SIZE[key] || 1)
    let a

    if (size > 1) {
      /* 有变体时**随机**选一个（轮转会听出"一二三一二三"的规律）；
         没有变体时保持原来的轮转（那是为了不打断正在播的那一个）。 */
      const i = variants ? Math.floor(Math.random() * size) : ((poolIdx[key] || 0) % size)
      if (!variants) poolIdx[key] = i + 1
      const slot = key + '#' + i
      a = pool[slot]
      if (!a) {
        a = wx.createInnerAudioContext()
        watchAudioError(a, key)
        a.src = variants ? variants[i] : srcOrList
        a.obeyMuteSwitch = false
        pool[slot] = a
      }
    } else {
      a = pool[key]
      if (!a) {
        a = wx.createInnerAudioContext()
        watchAudioError(a, key)
        a.src = srcOrList
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
  /*
   * ★ 底噪也要一起停（2026-10-30 发现的真实缺口）。
   *
   * stopAll 原来只停 pool 里的音效，**不管 _ambient** ——
   * 于是在房间里点喇叭关声音（setMuted(true) → stopAll()）时，
   * 背景沙沙声还在响，用户会以为"这个开关坏了"；
   * 切后台（onHide → stopAll()）时同理，底噪还在后台占着音频实例。
   * 函数声明会 hoist，这里可以安全地调用 stopAmbient。
   */
  stopAmbient()
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
/*
 * 预加载哪些音效（2026-10-29）。
 * ⚠️ 原来列表里有 `diceTumbleWood` —— 而那个音频在 3.10.52 已经被删了，
 * 于是预加载时 FILES[key] 是 undefined、直接 return，**等于白占一个名额**。
 * 现在换成真正用得最多的几个。
 */
/*
 * 预加载哪些音效（2026-10-29 扩到 12 个）。
 *
 * 规则：**一局里第一次就要响、而且不能慢**的那几个。
 *   · 骰盅流程：shakerMetal（摇）、cupSlam（扣）、revealHit（揭）
 *   · 比大小：diceSettle（逐颗落定）、diceRollBig（整把落下）
 *   · 金花：cardDeal（发牌）、cardFlip（翻牌）、cardSpread（铺开）
 *   · 通用：tapSoft（轻触）、toggleOn（开关）、confetti（结算撒花）
 *   · 卧底：uwReveal（摊牌）
 *
 * 原来只有 6 个，而全站 34 个音效 —— 其余 28 个都是**首次播放时才加载**，
 * 那一段在真机上就是"声音比画面慢半拍"。用户反馈过"声音有延迟"。
 *
 * 为什么不是全部预加载：每个音效占一个 InnerAudioContext 实例，
 * 34 个在小程序里可能触发内存警告（我们已经在监听 onMemoryWarning）。
 * 12 个覆盖了"每局开头必响"的那些，长尾的（喝彩、惩罚音）首次略慢可以接受。
 */
/*
 * ★★★ 2026-11-02 性能分层：预加载分两批。
 *
 * 背景：`preload()` 一次创建 20+ 个 `wx.createInnerAudioContext()`，
 * 实测把房间页的首屏渲染堵了 **3.9 秒**（点玩法卡 → 页面出现）。
 *
 * 但不能简单地把整个预载延后 —— 那样首屏那几下点击会没声音，
 * 而"点了没声音"正是用户反复报的一类问题。
 *
 * 折中：**分两批**
 *   · 第一批（下面这个）：首屏 3 秒内可能听到的，立即载
 *   · 第二批（PRELOAD_LATER）：进游戏后才会用到的，延后 1.2 秒再载
 *
 * 判据是"用户在这条路径上最早多久会听到它"：
 *   点按钮 / 读秒 / 扣盅 / 摇盅 → 第一批
 *   牌、转盘、撒花、连击     → 第二批
 */
const PRELOAD_KEYS = [
  /* ── 第一批：首屏 3 秒内就会用到 ── */
  'tap', 'tapSoft',      /* 点击反馈（tapSoft 37 处、tap 7 处，最贴手） */
  'countdownGo',         /* 倒计时收尾 */
  'shakerMetal',         /* 摇盅 */
  'cupSlam',             /* 扣盅：全场最重的一下 */
  'toggleOn'
]

/*
 * 第二批：进游戏后才用得到。延后 1.2 秒载 —— 那时首屏早就画完了，
 * 而玩家还在等人齐 / 看规则，远没到用这些音效的时候。
 */
const PRELOAD_LATER = [
  'revealHit', 'diceOnTable', 'diceSettle',
  'cardDeal', 'cardFlip', 'cardSpread',
  'wheelStop', 'confetti', 'tick'
]

/**
 * 给音频实例挂错误监听（2026-10-29）。
 *
 * 之前**一处 onError 都没有** —— 音频加载失败（文件缺失、路径错、解码不了）
 * 是完全静默的：用户说"没声音"，而我这边日志里什么都没有。
 *
 * 记进和云函数错误同一份 `errLog`（「我的」页能直接看到），
 * 但**同类只记一次**（一个坏文件可能在每次播放时都报错，不能刷屏）。
 */
const _audioErrSeen = {}
function watchAudioError(a, key) {
  if (!a || typeof a.onError !== 'function') return a
  a.onError(function (e) {
    const msg = (e && (e.errMsg || e.errCode)) || 'unknown'
    if (_audioErrSeen[key] === msg) return          // 同类只记一次
    _audioErrSeen[key] = msg
    try {
      const log = wx.getStorageSync('errLog') || []
      log.push({
        t: Date.now(),
        fn: 'sfx',
        act: key,
        raw: '音频加载/播放失败：' + msg
      })
      if (log.length > 20) log.length = 20
      wx.setStorageSync('errLog', log)
    } catch (err) {}
  })
  return a
}

function preload(keys) {
  (keys || PRELOAD_KEYS).forEach((k) => {
    /* 变体数组时预加载第一个（主文件）—— 直接把数组赋给 a.src 会失效 */
    const srcOrList = FILES[k]
    if (!srcOrList) return
    const variants = Array.isArray(srcOrList) ? srcOrList : null
    const src = variants ? variants[0] : srcOrList
    const size = variants ? variants.length : (POOL_SIZE[k] || 1)

    /*
     * ★★★ 池化音效必须**每个 slot 都预加载**（2026-11-02 修）。
     *
     * 原来这里写的是：
     *     if (POOL_SIZE[k] > 1) return     ← 池化的直接跳过
     *
     * 而 PRELOAD_KEYS 里恰恰有 4 个池化的：
     *     shakerMetal(3) / cupSlam(2) / diceOnTable(2) / tapSoft(2)
     *
     * 后果：**摇盅、扣盅、骰子落桌、点击反馈，第一次播都要现场加载音频**。
     *   加载时长几十到几百毫秒不等，而这几个音全是**贴着动画冲击帧**播的 ——
     *   画面已经开始摇了，声音才追上来。
     *
     * 这正是用户说的「不仅是优化声音本体，还需要优化声音时机」的根因之一：
     * 音色再好，晚 80ms 到就不是"卡在点上"。
     *
     * slot 命名必须和 play() 里一致（`key + '#' + i`），否则会建出两份实例。
     */
    if (size > 1) {
      for (let i = 0; i < size; i++) {
        const slot = k + '#' + i
        if (pool[slot]) continue
        try {
          const a = wx.createInnerAudioContext()
          watchAudioError(a, k)
          a.src = variants ? variants[i] : srcOrList
          a.obeyMuteSwitch = false
          pool[slot] = a
        } catch (e) { /* 单个失败不影响其它 */ }
      }
      return
    }
    if (pool[k]) return
    try {
      const a = wx.createInnerAudioContext()
      watchAudioError(a, k)
      a.src = src
      a.obeyMuteSwitch = false
      pool[k] = a
    } catch (e) {
      /* 预加载失败不影响播放（只是第一下慢一点） */
    }
  })
}

/* ============================================================
   环境底噪（2026-10-28，调研第 10 条）
   ------------------------------------------------------------
   "房间里是绝对安静，只有操作时有声" —— 而真实的酒桌一直有背景噪音。

   不做 BGM（有旋律会和聊天抢），做一层极低的底噪：
   文件本身已经归一化到峰值的 8%，播放时再压到一半 —— 低到"关掉才知道刚才有"。

   独立一个实例：它要一直循环，不能跟着一次性的音效池走。
   ============================================================ */
let _ambient = null

function playAmbient() {
  if (isMuted()) return
  if (_ambient) return
  try {
    const a = wx.createInnerAudioContext()
    watchAudioError(a, 'ambient')
    a.src = FILES.ambientRoom
    a.loop = true
    a.obeyMuteSwitch = false
    a.volume = 0.5
    a.play()
    _ambient = a
  } catch (e) {
    /* 播不了就不播 —— 底噪是氛围，不是功能 */
  }
}

function stopAmbient() {
  if (!_ambient) return
  try { _ambient.stop(); _ambient.destroy() } catch (e) {}
  _ambient = null
}

/*
 * 第二批预载 —— 由房间页在首屏渲染后调（见 room.js 的 onLoad）。
 * 单独一个函数而不是"preload(keys)"，是为了让调用方一眼看出这是延后批。
 */
let _laterTimer = null
function preloadLater(delayMs) {
  if (_laterTimer) return
  _laterTimer = setTimeout(() => { _laterTimer = null; preload(PRELOAD_LATER) },
    typeof delayMs === 'number' ? delayMs : 1200)
}

module.exports = { play, stop, stopAll, destroy, isMuted, setMuted, preload, preloadLater,
  playAmbient, stopAmbient, FILES }
