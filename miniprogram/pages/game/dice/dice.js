/**
 * 摇骰子
 *
 * 三个"手感"细节，缺一个就不像真的：
 *
 *   ① **真的摇** —— 用 wx.onAccelerometerChange 监听加速度，
 *      不是点一下假装摇。摇动幅度够大才触发，手感差别很大。
 *   ② **骰子会翻滚** —— 摇的时候骰子快速变换点数 + 抖动，
 *      停下来时逐个"落定"（有先后，不是一起停），最后才揭晓结果。
 *   ③ **声音分层** —— 摇动是连续的哗啦声，落定是逐颗"嗒"，
 *      开盅是上扬的揭晓音。三层声音对应三个视觉阶段。
 *
 * 随机数用 Math.random —— 不做"服务端判定"。
 * 酒桌游戏当着你俩的面摇，作弊没有意义，联网反而增加延迟和失败点。
 */
const sfx = require('../../../utils/sfx.js')
const feedback = require('../../../utils/feedback.js')

/**
 * 生成一颗骰子。
 *
 * ★ 2.5.0 起骰子改成**离线渲染的图片**（scripts/render-dice.py 生成，
 *   miniprogram/images/dice/dice-1..6.png），所以这里只需要点数 v，
 *   模板直接用它拼图片路径。
 *
 *   原来这里要算 9 宫格点数矩阵（cells / topCells / rightCells）给 CSS 画，
 *   现在那些都不需要了 —— 图片本身就是照片级的真实骰子，
 *   三个面的点数关系由渲染时的立方体几何决定（对面和为 7，天然正确）。
 */
function makeDice(v) {
  return { v: v }
}

function rollOne() {
  return 1 + Math.floor(Math.random() * 6)
}

Page({
  data: {
    /* 阶段：idle（待摇）→ shaking（摇动中）→ settling（逐个落定）→ done（出结果） */
    phase: 'idle',
    count: 2,                    // 骰子颗数
    dice: [],                    // 每颗 { v, cells, settled }
    total: 0,
    /* 显示用的数字（滚动过程中的中间值）—— 它的存在让点数「滚」出来而不是跳出来 */
    displayTotal: 0,
    resultText: '',
    /* 摇一摇 */
    shakeEnabled: false,         // 加速度计是否已启动
    shakePower: 0,               // 当前摇动强度（0~100，用于显示力度条）
    muted: false,
    /* 输赢判定 */
    lastResult: '',
    round: 0,
    /* 屏幕震动开关：骰子落定时整块桌面抖一下。
       只有骰子动、背景不动是飘的 —— 打击感一半来自这个。 */
    impact: false
  },

  onLoad() {
    this.setData({
      muted: sfx.isMuted(),
      dice: this.buildDice(2)
    })
    this.preloadDice()
    this.checkShake()
  },

  /**
   * 预热 6 张骰子图。
   *
   * 为什么必须做：摇动时每 45~90ms 换一次图（这就是"在翻滚"的视觉信号）。
   * 第一次摇的时候若某张图还没下载完，`<image>` 会**短暂显示空白** ——
   * 表现成"骰子闪了一下不见了"，而控制台没有任何报错。
   *
   * wx.getImageInfo 会走同一个图片缓存，预热之后换 src 是立即出图的。
   * 失败不处理：最坏情况就是第一次摇动略有闪烁，不影响玩法。
   */
  preloadDice() {
    for (let v = 1; v <= 6; v++) {
      wx.getImageInfo({ src: '/images/dice/dice-' + v + '.png', fail: () => {} })
    }
  },

  onHide() {
    this.stopShake()
    if (this._rollTimer) { clearInterval(this._rollTimer); this._rollTimer = null }
    sfx.stopAll()
    /* 清掉 feedback 的排期定时器 —— 否则页面隐藏后
       延迟的震动/音效还会触发（用户已经离开这个页面了） */
    feedback.clear()
  },
  onUnload() {
    this.stopShake()
    if (this._rollTimer) { clearInterval(this._rollTimer); this._rollTimer = null }
    feedback.clear()
    /* 必须销毁：不销毁会泄漏音频实例，微信对实例数有限制 */
    sfx.destroy()
  },

  buildDice(n) {
    const out = []
    for (let i = 0; i < n; i++) {
      const d = makeDice(1)
      d.settled = false
      out.push(d)
    }
    return out
  },

  /* ---------------- 摇一摇 ---------------- */

  /**
   * 启动重力感应。
   * 失败不阻塞 —— 有些机型/模拟器没有加速度计，仍可以用点按摇。
   */
  checkShake() {
    if (!wx.onAccelerometerChange) {
      this.setData({ shakeEnabled: false })
      return
    }
    wx.startAccelerometer({ interval: 'game', fail: () => {
      this.setData({ shakeEnabled: false })
    }})
    this.setData({ shakeEnabled: true })
    this.startShake()
  },

  startShake() {
    if (this._acc) return
    this._acc = (res) => {
      /* 三轴合成后减去重力（1g）。阈值 1.3 是实测值：
         低于 1.0 走两步就误触发，高于 1.6 要甩得很用力。 */
      const power = Math.sqrt(res.x * res.x + res.y * res.y + res.z * res.z)
      const extra = Math.abs(power - 1)
      const pct = Math.min(100, Math.round(extra * 100))

      /* 节流：不要每帧都 setData，那会卡 */
      const now = Date.now()
      if (now - (this._lastPct || 0) > 80) {
        this._lastPct = now
        this.setData({ shakePower: pct })
      }

      if (extra > 0.65 && this.data.phase !== 'shaking') {
        this.doShake()
      }
    }
    wx.onAccelerometerChange(this._acc)
  },

  stopShake() {
    if (this._acc) {
      try { wx.offAccelerometerChange(this._acc) } catch (e) {}
      this._acc = null
    }
    try { wx.stopAccelerometer() } catch (e) {}
  },

  /* ---------------- 核心：摇 ---------------- */

  doShake() {
    if (this.data.phase === 'shaking') return
    this.setData({ phase: 'shaking', resultText: '', lastResult: '' })

    /* ① 声音：木质骰子翻滚（和"大话骰"的金属盅形成质感区分） */
    sfx.play('diceTumbleWood', { restart: true })

    /* ② 视觉：骰子快速变换点数。
       间隔带随机抖动 —— 固定 60ms 会显得机械，
       真实摇骰子的碰撞间隔本来就是不规则的。 */
    const n = this.data.count
    let ticks = 0
    const maxTicks = 16
    if (this._spin) clearTimeout(this._spin)
    const tick = () => {
      const dice = []
      for (let i = 0; i < n; i++) {
        const d = makeDice(rollOne())
        d.settled = false
        dice.push(d)
      }
      this.setData({ dice: dice })
      ticks++
      if (ticks >= maxTicks) {
        this._spin = null
        this.settle()
      } else {
        this._spin = setTimeout(tick, 45 + Math.random() * 45)
      }
    }
    tick()
  },

  /**
   * 逐个落定。
   * 刻意让每颗骰子错开停 —— 一起停像动画，
   * 有先后才像真的骰子撞在桌上依次停住。
   */
  settle() {
    this.setData({ phase: 'settling' })
    const n = this.data.count
    const final = []
    for (let i = 0; i < n; i++) final.push(rollOne())

    let i = 0
    const step = () => {
      if (i >= n) return this.reveal(final)
      const dice = this.data.dice.slice()
      dice[i] = makeDice(final[i])
      dice[i].settled = true
      this.setData({ dice: dice })

      /*
       * ★ 音画同步的关键改动。
       *
       * 原来：setData（动画开始）+ sfx.play（音效同时响）。
       * 问题：动画的「冲击帧」在 60ms 处（骰子真正砸到桌面），
       *       但音效在动画第一帧就响了 —— 听起来音效「抢拍」，
       *       而且人脑处理声音比视觉快（13ms vs 50ms），
       *       同时触发时声音在感知上更早，反差更明显。
       *
       * 现在：交给 feedback 统一排期 ——
       *       视觉先动 → 音效延迟 90ms（落在冲击帧）→ 震动再晚 20ms。
       */
      feedback.fire('diceSettle')
      /* 低频冲击层单独补（叠出"重量"，feedback 表里没这层） */
      setTimeout(() => sfx.play('impactLow', { volume: 0.45 }), 100)

      /* 屏幕震动跟着冲击帧走，不和动画同时起 */
      setTimeout(() => this.shakeScreen(), 60)
      i++
      setTimeout(step, 180)
    }
    step()
  },

  /**
   * 屏幕震动。
   * 商业游戏的"打击感"一半来自这个 —— 只有骰子动、背景不动是飘的。
   * 用 class 开关触发 CSS 动画，动画结束后移除 class 以便下次能再触发
   * （同一个 class 连续加是不会重放动画的）。
   */
  shakeScreen() {
    this.setData({ impact: true })
    if (this._shakeTimer) clearTimeout(this._shakeTimer)
    this._shakeTimer = setTimeout(() => {
      this.setData({ impact: false })
    }, 240)
  },

  /** 揭晓：算点数、播开盅音、判定输赢 */
  reveal(final) {
    const total = final.reduce((a, b) => a + b, 0)
    const n = final.length
    const max = n * 6
    const min = n

    /*
     * 结果文案。
     * ★ 不要重复数字：上面的大字已经显示「7 点」了，
     *   下面再写一遍「7 点」是冗余 —— 这里只给「评价」，
     *   数字交给大字。之前两处都带数字，看起来像出了两次结果。
     */
    let text = ''
    let lastResult = ''
    if (total === max) { text = '豹子！满点'; lastResult = 'max' }
    else if (total === min) { text = '全 1，最低'; lastResult = 'min' }
    else if (total >= max - n) { text = '大'; lastResult = 'big' }
    else if (total <= min + n - 1) { text = '小'; lastResult = 'small' }
    else { text = ''; lastResult = 'mid' }

    this.setData({
      phase: 'done',
      total: total,
      displayTotal: 0,
      resultText: text,
      lastResult: lastResult,
      round: this.data.round + 1
    })

    /*
     * 结果反馈按「情绪强度」分层，并且**全部走 feedback 的冲击帧对齐**。
     *
     * 为什么不再直接 sfx.play：结果标签的 CSS 是 .42s 过冲弹入，
     * 它的「落定」在约 180ms 处。音效必须等到那一刻，
     * 否则字还没弹出来声音就响了 —— 这才是"没匹配上"的真正含义。
     *
     * 四档强度：
     *   满点  → 撒花 + 重击 + 连击音（最爽，三层）
     *   最低  → 下坠（最惨，单层重）
     *   大/小 → 揭晓重击
     *   中间  → 普通开盅（轻）
     */
    const IMPACT_OF_LABEL = 180        // 结果标签过冲弹入的落定时刻

    if (lastResult === 'max') {
      feedback.fire('luckyHit', { sfxDelay: IMPACT_OF_LABEL })
      setTimeout(() => sfx.play('revealHit'), IMPACT_OF_LABEL + 60)
      /* 连击音固定音高（pitch:false）—— 音高是设计的一部分，
         抖了就听不出"第几连"了 */
      setTimeout(() => sfx.play('combo4', { pitch: false }), IMPACT_OF_LABEL + 320)
    } else if (lastResult === 'min') {
      feedback.fire('penalized', { sfxDelay: IMPACT_OF_LABEL })
    } else if (lastResult === 'big' || lastResult === 'small') {
      feedback.fire('cupOpen', { sfxDelay: IMPACT_OF_LABEL })
    } else {
      setTimeout(() => sfx.play('diceOpen'), IMPACT_OF_LABEL)
    }

    this.rollNumber(total)
    this.savePlayed()
  },

  /**
   * 数字滚动。
   *
   * 为什么要滚而不是直接显示：直接跳出「14 点」是「信息」，
   * 滚上去的过程才是「反馈」—— 玩家会不自觉地盯着数字往上爬，
   * 那两三秒的期待感就是它换来的。
   *
   * 节奏：先快后慢（easeOut），总共约 480ms，和结果标签的弹入同步收尾。
   */
  rollNumber(target) {
    if (this._rollTimer) clearInterval(this._rollTimer)
    if (!target) { this.setData({ displayTotal: 0 }); return }
    const dur = 480
    const t0 = Date.now()
    this._rollTimer = setInterval(() => {
      const p = Math.min(1, (Date.now() - t0) / dur)
      const eased = 1 - Math.pow(1 - p, 3)          // easeOutCubic
      const v = Math.round(target * eased)
      this.setData({ displayTotal: v })
      if (p >= 1) {
        clearInterval(this._rollTimer)
        this._rollTimer = null
        this.setData({ displayTotal: target })
      }
    }, 32)
  },

  /* ---------------- 交互 ---------------- */

  /** 点按也能摇（没有加速度计时的兜底，也方便模拟器测试） */
  tapShake() {
    sfx.play('tapSoft')
    this.doShake()
  },

  setCount(e) {
    const n = Number(e.currentTarget.dataset.n)
    if (n === this.data.count) return
    sfx.play('tap')
    this.setData({
      count: n,
      phase: 'idle',
      dice: this.buildDice(n),
      total: 0,
      resultText: '',
      lastResult: ''
    })
  },

  toggleMute() {
    const m = sfx.setMuted(!this.data.muted)
    this.setData({ muted: m })
  },

  /** 记一次"玩过"—— 只存本地，不做云端统计 */
  savePlayed() {
    try {
      const p = wx.getStorageSync('gamePlayed') || {}
      p.dice = (p.dice || 0) + 1
      wx.setStorageSync('gamePlayed', p)
    } catch (e) {}
  },

  goLobby() { wx.navigateBack() }
})
