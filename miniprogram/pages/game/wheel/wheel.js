/**
 * 命运转盘
 *
 * 视觉最丰富的一个：真实的扇区绘制 + 匀速旋转 + 缓动减速 + 指针判定。
 *
 * 三个技术点：
 *   ① **扇区用 conic-gradient 画**，不用 canvas ——
 *      canvas 要处理 DPR、重绘、层级，代码多且容易在低端机上花屏。
 *      conic-gradient 是纯 CSS，微信基础库 2.x 支持良好。
 *   ② **旋转用 CSS transition + cubic-bezier**，
 *      不是自己用 setInterval 逐帧算 —— 交给渲染层做，60fps 且不卡 JS 线程。
 *   ③ **减速时的咔哒声**用 setTimeout 按缓动曲线排期，
 *      间隔越来越长 —— 这个"声音跟着慢下来"是转盘最爽的部分。
 *
 * 内容偏向酒桌：真心话 / 大冒险 / 喝一杯 / 指定人喝 / 免罚。
 * 概率可以调 —— 免罚很少见，这样转到的时候才够爽。
 */
const sfx = require('../../utils/sfx.js')

/* 扇区定义：weight 是权重（不是等分），颜色按酒桌氛围配 */
const SECTORS = [
  { k: 'truth',  t: '真心话',   icon: '💬', weight: 22, color: '#5E7FA6' },
  { k: 'dare',   t: '大冒险',   icon: '🎯', weight: 20, color: '#E0714F' },
  { k: 'drink',  t: '喝一杯',   icon: '🍺', weight: 18, color: '#D9A441' },
  { k: 'you',    t: '你喝',     icon: '👉', weight: 14, color: '#C4573A' },
  { k: 'me',     t: '我喝',     icon: '👈', weight: 12, color: '#8E6BA8' },
  { k: 'both',   t: '一起喝',   icon: '🍻', weight: 8,  color: '#6D9E6A' },
  { k: 'pass',   t: '免罚一次', icon: '✨', weight: 6,  color: '#E8B33C' }
]

/* 题库：每次转到随机取一条，不重复上一题 */
const TRUTHS = [
  '你手机里有没有不能给我看的东西？',
  '我们在一起之后，你有没有偷偷比较过我和别人？',
  '你第一次见我爸妈，心里在想什么？',
  '我做过哪件事让你偷偷难受过，但你没说？',
  '你最喜欢我身上哪个地方？说三个。',
  '如果我们吵架，你最怕我说哪句话？',
  '你有没有后悔过和我在一起？哪怕一瞬间。',
  '你梦到过我吗？梦到什么了？',
  '你最想我改掉的一个毛病是什么？',
  '我什么时候最让你心动？'
]

const DARES = [
  '给对方发一条语音，说一句最肉麻的话。',
  '让对方翻你手机相册，随便点一张看。',
  '模仿对方一个习惯动作，要像。',
  '给对方捏肩一分钟。',
  '说出对方三个优点，不能重复。',
  '给对方唱两句歌。',
  '抱对方十秒，不许说话。',
  '让对方在你脸上画一笔。',
  '学对方生气时的样子。',
  '亲对方一下，位置由对方定。'
]

function pickOne(arr, last) {
  if (arr.length <= 1) return arr[0]
  let v = arr[Math.floor(Math.random() * arr.length)]
  let guard = 0
  while (v === last && guard++ < 20) v = arr[Math.floor(Math.random() * arr.length)]
  return v
}

Page({
  data: {
    /* 转盘几何 */
    sectors: [],
    /* 旋转角度（度）。累加，不重置 —— 重置会让视觉倒着转回去 */
    rotation: 0,
    spinning: false,
    duration: 0,           // 本次旋转时长（ms），给 CSS transition 用

    /* 结果 */
    result: null,
    resultText: '',
    showResult: false,

    muted: false,
    round: 0,
    /* 历史（本地，只给本次会话看） */
    history: []
  },

  onLoad() {
    this.setData({ muted: sfx.isMuted() })
    this.buildSectors()
  },

  onHide() { sfx.stopAll() },
  onUnload() { sfx.destroy() },

  /**
   * 把权重转成角度，并生成 conic-gradient 的色带。
   * 权重不等分是刻意的 —— 等分的话"免罚"也会常出现，就不稀罕了。
   */
  buildSectors() {
    const total = SECTORS.reduce((a, s) => a + s.weight, 0)
    let acc = 0
    const stops = []
    const list = []
    SECTORS.forEach((s, i) => {
      const deg = s.weight / total * 360
      const from = acc
      const to = acc + deg
      stops.push(`${s.color} ${from.toFixed(2)}deg ${to.toFixed(2)}deg`)
      list.push({
        k: s.k, t: s.t, icon: s.icon, color: s.color,
        from: from, to: to, mid: (from + to) / 2, i: i
      })
      acc = to
    })
    this.gradient = 'conic-gradient(from 0deg, ' + stops.join(', ') + ')'
    /* 标签位置：放在扇区中线，半径 62% 处 */
    list.forEach((s) => {
      /* -90 是因为 CSS 的 0deg 在正上方，而我们要从 12 点开始算 */
      const a = (s.mid - 90) * Math.PI / 180
      s.lx = 50 + Math.cos(a) * 33   // 百分比
      s.ly = 50 + Math.sin(a) * 33
    })
    this.setData({ sectors: list, gradient: this.gradient })
  },

  /* ---------------- 转 ---------------- */

  spin() {
    if (this.data.spinning) return
    sfx.play('tap')

    /* ① 先转几圈 + 随机落点。
       圈数固定 5 圈：太少显得敷衍，太多等到不耐烦。
       落点均匀随机 —— 概率由扇区大小决定，不由落点做手脚。 */
    const turns = 5
    const land = Math.random() * 360
    const from = this.data.rotation
    /* 让最终角度对 360 取模后正好落在 land */
    const target = from + turns * 360 + ((land - (from % 360)) + 360) % 360

    /* ② 时长：和"爽感"直接相关。2.8s 是试出来的 ——
       短了不够期待，长了会盯着发呆。 */
    const duration = 2800 + Math.random() * 600

    this.setData({
      spinning: true,
      showResult: false,
      rotation: target,
      duration: duration
    })

    /* ③ 声音分三段：启动嗡 → 持续咔哒（跟着减速）→ 停稳叮 */
    sfx.play('wheelStart')
    this.scheduleTicks(duration)

    /* ④ 结束 */
    if (this._endTimer) clearTimeout(this._endTimer)
    this._endTimer = setTimeout(() => {
      this.finish(land)
    }, duration + 60)
  },

  /**
   * 按缓动曲线排期咔哒声。
   * 关键：间隔越来越长 —— 声音和视觉一起"慢下来"，
   * 这是转盘最爽的部分，少了它就像在等一个进度条。
   */
  scheduleTicks(duration) {
    if (this._tickTimers) this._tickTimers.forEach(t => clearTimeout(t))
    this._tickTimers = []

    /* 缓动：cubic-bezier(.15,.85,.2,1) 近似为 easeOutQuart */
    const easeOut = (t) => 1 - Math.pow(1 - t, 4)

    let elapsed = 0
    let gap = 34                      // 起始间隔 34ms（快）
    let count = 0
    while (elapsed < duration - 120 && count < 120) {
      const t = elapsed / duration
      /* 间隔随进度拉长：开始时 34ms，结束时约 300ms */
      gap = 34 + easeOut(t) * 266
      const at = elapsed
      this._tickTimers.push(setTimeout(() => {
        if (!this.data.spinning) return
        sfx.play('tick', { restart: true })
      }, at))
      elapsed += gap
      count++
    }
  },

  /** 停稳：判定落在哪个扇区 */
  finish(land) {
    /* 指针在正上方（12 点）。转盘顺时针转 rotation 度后，
       指针位置对应的原始角度 = (360 - land % 360) % 360 */
    const angle = ((360 - (land % 360)) % 360 + 360) % 360

    let hit = null
    for (const s of this.data.sectors) {
      if (angle >= s.from && angle < s.to) { hit = s; break }
    }
    if (!hit) hit = this.data.sectors[0]

    /* 按结果类型给不同的音 —— 免罚是惊喜，喝酒是"认命" */
    if (hit.k === 'pass') sfx.play('win')
    else if (hit.k === 'truth' || hit.k === 'dare') sfx.play('reveal')
    else sfx.play('drink')

    /* 取题目/任务 */
    let detail = ''
    if (hit.k === 'truth') { detail = pickOne(TRUTHS, this._lastTruth); this._lastTruth = detail }
    else if (hit.k === 'dare') { detail = pickOne(DARES, this._lastDare); this._lastDare = detail }

    const history = this.data.history.slice()
    history.unshift({ t: hit.t, icon: hit.icon, color: hit.color, detail: detail })
    if (history.length > 8) history.pop()

    this.setData({
      spinning: false,
      result: hit,
      resultText: hit.t,
      showResult: true,
      round: this.data.round + 1,
      history: history
    })

    this.savePlayed()
  },

  closeResult() { this.setData({ showResult: false }) },

  toggleMute() {
    const m = sfx.setMuted(!this.data.muted)
    this.setData({ muted: m })
  },

  savePlayed() {
    try {
      const p = wx.getStorageSync('gamePlayed') || {}
      p.wheel = (p.wheel || 0) + 1
      wx.setStorageSync('gamePlayed', p)
    } catch (e) {}
  },

  goLobby() { wx.navigateBack() }
})
