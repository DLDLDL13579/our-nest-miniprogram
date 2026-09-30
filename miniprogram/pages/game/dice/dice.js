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
const sfx = require('../../utils/sfx.js')

/* 骰子点数用点阵画，不用字体符号 —— 字体符号在不同机型上大小/样式不一 */
const PIPS = {
  1: [4],
  2: [0, 8],
  3: [0, 4, 8],
  4: [0, 2, 6, 8],
  5: [0, 2, 4, 6, 8],
  6: [0, 2, 3, 5, 6, 8]
}

function makeDice(v) {
  const pips = PIPS[v] || PIPS[1]
  const cells = []
  for (let i = 0; i < 9; i++) cells.push(pips.indexOf(i) >= 0)
  return { v: v, cells: cells }
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
    resultText: '',
    /* 摇一摇 */
    shakeEnabled: false,         // 加速度计是否已启动
    shakePower: 0,               // 当前摇动强度（0~100，用于显示力度条）
    muted: false,
    /* 输赢判定 */
    lastResult: '',
    round: 0
  },

  onLoad() {
    this.setData({
      muted: sfx.isMuted(),
      dice: this.buildDice(2)
    })
    this.checkShake()
  },

  onHide() { this.stopShake(); sfx.stopAll() },
  onUnload() {
    this.stopShake()
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

    /* ① 声音：连续的哗啦声 */
    sfx.play('diceShake', { restart: true })

    /* ② 视觉：骰子快速变换点数（每 60ms 换一次） */
    const n = this.data.count
    let ticks = 0
    const maxTicks = 14
    if (this._spin) clearInterval(this._spin)
    this._spin = setInterval(() => {
      const dice = []
      for (let i = 0; i < n; i++) {
        const d = makeDice(rollOne())
        d.settled = false
        dice.push(d)
      }
      this.setData({ dice: dice })
      ticks++
      if (ticks >= maxTicks) {
        clearInterval(this._spin)
        this._spin = null
        this.settle()
      }
    }, 60)
  },

  /**
   * 逐个落定。
   * 刻意让每颗骰子错开 180ms 停 —— 一起停像动画，
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
      sfx.play('diceSettle')
      i++
      setTimeout(step, 180)
    }
    step()
  },

  /** 揭晓：算点数、播开盅音、判定输赢 */
  reveal(final) {
    const total = final.reduce((a, b) => a + b, 0)
    const n = final.length
    const max = n * 6
    const min = n

    let text = ''
    let lastResult = ''
    if (total === max) { text = '豹子！满点 ' + total; lastResult = 'max' }
    else if (total === min) { text = '全 1，最低点 ' + total; lastResult = 'min' }
    else if (total >= max - n) { text = '大 ' + total; lastResult = 'big' }
    else if (total <= min + n - 1) { text = '小 ' + total; lastResult = 'small' }
    else { text = total + ' 点'; lastResult = 'mid' }

    this.setData({
      phase: 'done',
      total: total,
      resultText: text,
      lastResult: lastResult,
      round: this.data.round + 1
    })

    /* 满点/最低点用不同的音 —— 情绪反馈 */
    if (lastResult === 'max') sfx.play('win')
    else if (lastResult === 'min') sfx.play('lose')
    else sfx.play('diceOpen')

    this.savePlayed()
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
