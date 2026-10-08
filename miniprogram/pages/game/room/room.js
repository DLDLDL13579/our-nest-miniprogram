/**
 * 多人游戏房间（大厅）
 *
 * ============ 和单机版的关系 ============
 * 单机版（pages/game/dice 等）是"一部手机传着玩"，不需要网络。
 * 这个页面是**联网版**：每个人用自己的微信进同一个房间，
 * 靠 6 位房间码聚到一起，服务端同步状态。
 *
 * 两者都保留 —— 面对面时传手机更顺，异地或各自有手机时用联网版。
 *
 * ============ 为什么用轮询而不是 watch ============
 * 云数据库的 watch 能实时推送，但要维持长连接、处理断线重连，
 * 而且 onError 之后必须自己重建监听，代码量和出错面都大得多。
 * 酒桌游戏的操作间隔是秒级，1.5 秒轮询的体感已经够了。
 *
 * 轮询还有一个隐性好处：**天然容错**。某次请求失败，下一次接着来就行；
 * 而 watch 断了如果不重建，就是"再也收不到更新"的静默故障。
 */
const app = getApp()
const { call } = require('../../../utils/cloud.js')
const sfx = require('../../../utils/sfx.js')

const POLL_MS = 1500

/* 游戏选项 */
const GAMES = [
  { k: 'liar', name: '大话骰', icon: '🎯', desc: '轮流往上叫，不信就开' },
  { k: 'dice', name: '摇骰子比大小', icon: '🎲', desc: '一起摇，点数大的赢' },
  { k: 'wheel', name: '命运转盘', icon: '🎡', desc: '房主转，结果全场同步' }
]

Page({
  data: {
    loading: true,
    /* 阶段：entry（选建/加入）→ lobby（等人齐）→ playing → over */
    stage: 'entry',
    room: null,
    games: GAMES,
    /* 建房表单 */
    myName: '',
    pickGame: 'liar',
    /* 加入表单 */
    joinCode: '',
    joining: false,
    creating: false,
    err: '',
    muted: false,
    /* 结算 */
    result: null,
    /* 网络状态提示 */
    netTip: '',
    /* v3 动效状态 */
    rolling: false,      // 摇骰中
    suspense: false,     // 开骰蓄力（全场最紧张的一刻）
    impact: false,       // 屏幕震动
    cdText: ''           // 倒计时显示（3 / 2 / 1 / 开始）
  },

  onLoad() {
    sfx.init && sfx.init()
    this.setData({ muted: sfx.isMuted() })
    /* 默认名字取设置页里填的称呼 */
    const pair = app.globalData && app.globalData.pair
    const name = (pair && pair.myName) || ''
    this.setData({ myName: name && name !== '我' ? name : '' })
  },

  onShow() {
    /* 从房间进来时恢复轮询 */
    if (this.data.room) this.startPoll()
  },

  onHide() {
    this.stopPoll()
    sfx.stopAll()
  },

  /** 清掉倒计时定时器（页面卸载时不能留） */
  clearCountdown() {
    if (this._cdTimers) { this._cdTimers.forEach(t => clearTimeout(t)); this._cdTimers = [] }
  },

  onUnload() {
    this.stopPoll()
    this.clearCountdown()
    sfx.destroy()
    /* 主动离开房间 —— 不然会一直占着座位，
       而且别人会看到"永远在线"的幽灵玩家 */
    const r = this.data.room
    if (r) {
      call('room', { action: 'leave', id: r.id }, { silent: true }).catch(() => {})
    }
  },

  onPullDownRefresh() {
    this.refresh().then(() => wx.stopPullDownRefresh())
  },

  /* ================= 轮询 ================= */

  startPoll() {
    this.stopPoll()
    this._poll = setInterval(() => this.refresh(), POLL_MS)
  },

  stopPoll() {
    if (this._poll) { clearInterval(this._poll); this._poll = null }
  },

  /** 拉一次房间状态 */
  async refresh() {
    const r = this.data.room
    if (!r) return
    const res = await call('room', { action: 'status', id: r.id }, { silent: true }).catch(() => null)

    if (!res) {
      /* 网络失败：不打断游戏，只提示一下。下一次轮询会自动重试 */
      this.setData({ netTip: '网络不太好，正在重试…' })
      return
    }
    if (!res.ok) {
      /* 房间没了（被解散或过期）→ 回入口 */
      this.stopPoll()
      this.setData({
        room: null, stage: 'entry', result: null,
        err: res.msg || '房间已结束'
      })
      return
    }

    const prev = this.data.room
    const room = res.room

    /* 叫骰选项在前端算（服务端只判合法性）。
       放前端算的原因：选项随人数和上家叫法变化，列表可能几十个，
       每次都从服务端传一遍没必要；而且它只是"给人点的按钮"，
       真点下去服务端还会再校验一次，前端算错也骗不过去。 */
    room.options = this.buildOptions(room)

    /* 阶段变化时给声音反馈 —— 让"别人做了操作"这件事被听见。
       多人游戏的音效有个特殊职责：**提示"不在这部手机上的事发生了"**。
       单机版不需要，因为一切都是自己点的。 */
    if (prev && prev.phase !== room.phase) {
      if (room.phase === 'countdown') {
        /* 开局倒计时开始：读秒声（最后一声更急促） */
        this.startCountdown(room.countdownMs)
      } else if (room.phase === 'playing') {
        sfx.play('countdownGo')
        setTimeout(() => sfx.play('shakerMetal'), 180)
      } else if (room.phase === 'over') {
        sfx.play('revealHit')
      }
    }
    /* 人数变化：有人进来/走了。
       进来的音更"亮"（用 combo 上行），走的音更"闷" */
    if (prev && prev.count !== room.count) {
      const joined = room.count > prev.count
      sfx.play(joined ? 'combo1' : 'toggleOff')
    }
    /* 有人叫骰了 —— 用筹码声，像"下注" */
    if (prev && room.bid && (!prev.bid || prev.bid.at !== room.bid.at)) {
      sfx.play('chipBet')
      /* 不是自己叫的 → 额外提示一下（多人游戏的"轮到你了"感） */
      const mineCalled = prev.turn === (room.players.filter(p => p.isMe)[0] || {}).seat
      if (!mineCalled && room.turn) {
        setTimeout(() => sfx.play('tapSoft'), 260)
      }
    }

    this.setData({
      room: room,
      stage: room.phase === 'lobby' ? 'lobby'
        : (room.phase === 'countdown' ? 'countdown'
        : (room.phase === 'playing' ? 'playing' : 'over')),
      result: room.lastResult || null,
      netTip: ''
    })
  },

  /**
   * 开局倒计时读秒。
   *
   * 为什么要它：骰子在服务端已经生成好了，但玩家还在看别人的名字、
   * 还没把手机放好。直接开局 = 有人错过第一轮叫骰。
   * 3 秒倒计时给所有人一个"要开始了"的缓冲 —— 这是商业多人游戏的标配。
   *
   * 声音设计：前两声是普通读秒，最后一声换更急促的音（制造紧迫）。
   */
  startCountdown(remainMs) {
    const total = Math.max(0, Number(remainMs) || 0)
    if (!total) return
    if (this._cdTimers) this._cdTimers.forEach(t => clearTimeout(t))
    this._cdTimers = []

    /* 每 1 秒一声，最后一声用 countdownUrgent */
    let left = total
    const tick = () => {
      if (!this.data.room || this.data.room.phase !== 'countdown') return
      const sec = Math.max(1, Math.ceil(left / 1000))
      const isLast = left <= 1000
      sfx.play(isLast ? 'countdownUrgent' : 'countdown')
      this.setData({ cdText: isLast ? '开始！' : String(sec) })
      left -= 1000
      if (left > -200) {
        this._cdTimers.push(setTimeout(tick, 1000))
      }
    }
    tick()
  },

  /**
   * 算出所有合法叫法。
   * 规则：数量变大，或数量相同但点数变大。
   * 只给最接近上家的 24 个 —— 全列会有 40 个按钮，翻半天。
   */
  buildOptions(room) {
    const total = (room.count || 2) * 5
    const cur = room.bid
    const out = []
    for (let n = 1; n <= total; n++) {
      for (let f = 1; f <= 6; f++) {
        if (!cur) {
          out.push(n + '个' + f)
        } else {
          const higher = n > cur.n || (n === cur.n && f > cur.face)
          if (higher) out.push(n + '个' + f)
        }
      }
    }
    /* 我的回合才需要显示；不是我的回合显示前几个当预览 */
    return out.slice(0, 24)
  },

  /* ================= 建房 ================= */

  onName(e) { this.setData({ myName: e.detail.value }) },
  pickGame(e) { this.setData({ pickGame: e.currentTarget.dataset.k }); sfx.play('tapSoft') },

  async doCreate() {
    if (this.data.creating) return
    this.setData({ creating: true, err: '' })
    const r = await call('room', {
      action: 'create',
      name: this.data.myName || '房主',
      game: this.data.pickGame
    }, { loading: '开房间' })
      .catch((e) => { this.setData({ err: (e && e.friendly) || '开房间失败' }); return null })

    this.setData({ creating: false })
    if (r && r.ok) {
      sfx.play('confetti')
      this.setData({ room: r.room, stage: 'lobby' })
      this.startPoll()
    }
  },

  /* ================= 加入 ================= */

  onCode(e) {
    /* 房间码统一大写，避免用户输入小写后对不上 */
    this.setData({ joinCode: String(e.detail.value || '').toUpperCase() })
  },

  async doJoin() {
    const code = (this.data.joinCode || '').trim()
    if (code.length !== 6) {
      return this.setData({ err: '房间号是 6 位' })
    }
    if (this.data.joining) return
    this.setData({ joining: true, err: '' })

    const r = await call('room', {
      action: 'join', code: code, name: this.data.myName || '玩家'
    }, { loading: '进房间' })
      .catch((e) => { this.setData({ err: (e && e.friendly) || '进不去' }); return null })

    this.setData({ joining: false })
    if (r && r.ok) {
      sfx.play('confetti')
      this.setData({ room: r.room, stage: 'lobby', joinCode: '' })
      this.startPoll()
    } else if (r && !r.ok) {
      this.setData({ err: r.msg || '进不去这个房间' })
    }
  },

  /** 复制房间码 —— 要发给别人 */
  copyCode() {
    const c = this.data.room && this.data.room.code
    if (!c) return
    wx.setClipboardData({
      data: c,
      success: () => wx.showToast({ title: '房间号复制了', icon: 'none' })
    })
  },

  /* ================= 开局 / 再来 ================= */

  async doStart() {
    const r = await call('room', { action: 'start', id: this.data.room.id }, { loading: '开始' })
      .catch((e) => { wx.showToast({ title: (e && e.friendly) || '开不了', icon: 'none' }); return null })
    if (r && r.ok) {
      sfx.play('shakerMetal')
      this.setData({ room: r.room, stage: 'playing' })
    } else if (r && !r.ok) {
      wx.showToast({ title: r.msg || '开不了', icon: 'none', duration: 2500 })
    }
  },

  async doAgain() {
    const r = await call('room', { action: 'again', id: this.data.room.id }, { loading: '重开' })
      .catch(() => null)
    if (r && r.ok) {
      sfx.play('tap')
      this.setData({ room: r.room, stage: 'lobby', result: null })
    } else if (r && !r.ok) {
      wx.showToast({ title: r.msg || '只有房主能开新局', icon: 'none', duration: 2500 })
    }
  },

  /* ================= 摇骰子（比大小） ================= */

  async doRoll() {
    sfx.play('diceTumbleWood', { restart: true })
    this.setData({ rolling: true })
    const r = await call('room', { action: 'roll', id: this.data.room.id }, { silent: true })
      .catch(() => null)
    this.setData({ rolling: false })
    if (r && r.ok) {
      this.setData({ room: r.room })
      if (r.result) {
        /* 全员摇完 → 出结果。
           分层：停稳 → 揭晓重击 → 撒花（自己赢）/ 下坠（没赢） */
        sfx.play('diceSettle')
        sfx.play('impactLow', { volume: 0.5 })
        this.bump()
        setTimeout(() => sfx.play('revealHit'), 200)
        const mySeat = (r.room.me || {}).seat
        const iWon = (r.result.winnerSeats || []).indexOf(mySeat) >= 0
        setTimeout(() => sfx.play(iWon ? 'confetti' : 'failDrop'), 520)
        /* ★ 连庄音：连赢的音高逐级升高（combo-1 → combo-4）。
           这是"连庄"这件事的声音表达 —— 连赢两把和赢一把听感不同，
           而且越连越高会形成"还想再来一把"的拉力。 */
        const myStreak = (r.result.streaks || {})[mySeat] || 0
        if (myStreak >= 1) {
          const comboKey = 'combo' + Math.min(4, myStreak)
          setTimeout(() => sfx.play(comboKey, { pitch: false }), 780)
        }
        this.setData({ result: r.result, stage: 'over' })
      } else {
        sfx.play('diceSettle')
      }
    }
  },

  /** 屏幕震一下（关键结果时的打击感） */
  bump() {
    this.setData({ impact: true })
    if (this._bumpTimer) clearTimeout(this._bumpTimer)
    this._bumpTimer = setTimeout(() => this.setData({ impact: false }), 320)
  },

  /* ================= 大话骰 ================= */

  async doBid(e) {
    const i = Number(e.currentTarget.dataset.i)
    const label = (this.data.room && this.data.room.options && this.data.room.options[i]) || ''
    /* 选项是 "3个4" 这种字符串，解析回 n / face */
    const m = /^(\d+)个(\d)$/.exec(label)
    if (!m) return
    const n = Number(m[1])
    const face = Number(m[2])

    sfx.play('tap')
    const r = await call('room', {
      action: 'bid', id: this.data.room.id, n: n, face: face, zhai: false
    }, { silent: true }).catch(() => null)
    if (r && r.ok) {
      this.setData({ room: r.room })
    } else if (r && !r.ok) {
      wx.showToast({ title: r.msg, icon: 'none', duration: 2200 })
    }
  },

  async doOpen() {
    /* 开骰是全场最紧张的一刻 —— 三段式：
         蓄力（自己手机上）→ 开盅重击（全场都会轮询到）→ 结果音 */
    sfx.play('chargeUp', { volume: 0.6 })
    this.setData({ suspense: true })
    const r = await call('room', { action: 'open', id: this.data.room.id }, { silent: true })
      .catch(() => null)
    this.setData({ suspense: false })
    if (r && r.ok) {
      this.setData({ room: r.room, result: r.result, stage: 'over' })
      sfx.play('revealHit')
      this.bump()
      setTimeout(() => {
        const mySeat = (r.room.me || {}).seat
        const iLost = r.result.loserSeat === mySeat
        sfx.play(iLost ? 'failDrop' : 'confetti')
      }, 340)
      setTimeout(() => sfx.play('gulp'), 900)
    } else if (r && !r.ok) {
      wx.showToast({ title: r.msg, icon: 'none', duration: 2200 })
    }
  },

  /* ================= 离开 ================= */

  leave() {
    wx.showModal({
      title: '离开房间？',
      content: '你走了之后位置会空出来。房主走了会自动转给下一个人。',
      confirmText: '离开',
      success: async (m) => {
        if (!m.confirm) return
        this.stopPoll()
        await call('room', { action: 'leave', id: this.data.room.id }, { silent: true }).catch(() => {})
        sfx.play('toggleOff')
        this.setData({ room: null, stage: 'entry', result: null, err: '' })
      }
    })
  },

  toggleMute() {
    const m = sfx.setMuted(!this.data.muted)
    this.setData({ muted: m })
  },

  goBack() { wx.navigateBack() }
})
