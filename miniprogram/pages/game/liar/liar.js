/**
 * 大话骰（吹牛）
 *
 * 酒桌经典：每人 5 颗骰子藏在盅里，只能看自己的，
 * 轮流往上叫「N 个 X」，谁不信就喊「开」——叫的数量不够则叫的人喝。
 *
 * 核心规则（查证过，不是自己编的）：
 *   · 1 点是万能牌，可以当任何点数 —— 这是最反直觉也最好玩的地方
 *   · 只能往上叫：数量变大，或数量相同但点数变大
 *   · 叫「斋」之后 1 点不再万能，只算 1 点
 *   · 总骰子数 = 人数 × 5，两人局就是 10 颗
 *
 * 针对「两人传一部手机」的设计（这是和真实酒桌最大的不同）：
 *   真酒桌每人一个盅、同时摇、同时看。传手机做不到"同时"，
 *   所以这里用**交接屏**解决：一个人看完自己的骰子后点「我记住了」，
 *   屏幕盖住，再递给对方 —— 保证对方看不到你的点数。
 *   这个交接动作不做，游戏就废了（等于把牌摊在桌上）。
 */
const sfx = require('../../../utils/sfx.js')

const DICE_PER_PLAYER = 5

function rollDice(n) {
  const out = []
  for (let i = 0; i < n; i++) out.push(1 + Math.floor(Math.random() * 6))
  return out
}

/** 统计全部骰子里某点数的个数（1 是否万能由 zhai 决定）
    注意：骰子存成 { v, cells } 对象（cells 给模板画点阵用），所以取 .v */
function countFace(all, face, zhai) {
  let n = 0
  all.forEach((d) => {
    const v = d && typeof d === 'object' ? d.v : d
    if (v === face) n++
    else if (v === 1 && !zhai && face !== 1) n++
  })
  return n
}

/** 叫骰是否合法：必须比上一个大 */
function isHigher(a, b) {
  if (!b) return true
  if (a.n > b.n) return true
  if (a.n === b.n && a.face > b.face) return true
  return false
}

const PIPS = {
  1: [4], 2: [0, 8], 3: [0, 4, 8],
  4: [0, 2, 6, 8], 5: [0, 2, 4, 6, 8], 6: [0, 2, 3, 5, 6, 8]
}
function cells(v) {
  const p = PIPS[v] || PIPS[1]
  const out = []
  for (let i = 0; i < 9; i++) out.push(p.indexOf(i) >= 0)
  return out
}

Page({
  data: {
    /* 阶段：ready → peek（看自己的骰子）→ handoff（交接）
       → bid（叫骰）→ over
       handoff 有两种用途，靠 handoffTo 区分：
         'peek' = 开局交接去看骰；'bid' = 叫完骰交接去叫骰 */
    phase: 'ready',
    handoffTo: 'peek',
    showMine: false,
    /* 两个玩家：me（当前持机者）与 other */
    p1: [], p2: [],
    /* 当前轮到谁看/叫 */
    turn: 1,
    /* 当前叫骰 { n, face, zhai, by } */
    bid: null,
    /* 可选叫骰列表（自动算出所有合法选项） */
    options: [],
    /* 结算 */
    reveal: null,
    loser: '',
    resultText: '',
    round: 0,
    muted: false,
    /* 历史叫骰（展示用） */
    trail: []
  },

  onLoad() {
    this.setData({ muted: sfx.isMuted() })
  },
  onHide() { sfx.stopAll() },
  onUnload() { sfx.destroy() },

  /* ---------------- 开局：摇骰 ---------------- */

  newRound() {
    sfx.play('diceShake')
    /* 存成对象数组（带点阵），模板直接用 —— 不用在 wxml 里做转换 */
    const wrap = (arr) => arr.map((v) => ({ v: v, cells: cells(v) }))
    const p1 = wrap(rollDice(DICE_PER_PLAYER))
    const p2 = wrap(rollDice(DICE_PER_PLAYER))

    /* 用动画遮一下，避免"瞬间出现"的生硬感 */
    this.setData({
      phase: 'ready',
      p1: p1, p2: p2,
      turn: 1,
      bid: null,
      options: [],
      reveal: null,
      loser: '',
      resultText: '',
      trail: [],
      round: this.data.round + 1
    })

    setTimeout(() => {
      /* 开局：先交接给玩家1 看骰 */
      this.setData({ phase: 'handoff', handoffTo: 'peek', turn: 1 })
      sfx.play('diceSettle')
    }, 500)
  },

  /* ---------------- 交接与看骰 ---------------- */

  /** 交接屏 → 看自己的骰子（仅开局） */
  peek() {
    sfx.play('tap')
    this.setData({ phase: 'peek' })
  },

  /** 叫骰回合的交接屏 → 直接进叫骰（骰子整局都记得，不用重看） */
  toBid() {
    sfx.play('tap')
    this.setData({ phase: 'bid', showMine: false })
    this.buildOptions()
  },

  /** 叫骰阶段随时看一眼自己的骰子 */
  toggleMine() {
    sfx.play('tapSoft')
    this.setData({ showMine: !this.data.showMine })
  },

  /**
   * 看完了 → 盖住并交接。
   * 开局阶段：玩家1 看完 → 玩家2 看；玩家2 看完 → 开始叫骰。
   */
  cover() {
    sfx.play('tapSoft')
    const t = this.data.turn
    if (t === 1) {
      this.setData({ phase: 'handoff', handoffTo: 'peek', turn: 2 })
    } else {
      /* 两人都看完了 → 玩家1 先叫 */
      this.setData({ phase: 'handoff', handoffTo: 'bid', turn: 1, bid: null, trail: [], showMine: false })
      sfx.play('whoosh')
    }
  },

  /* ---------------- 叫骰 ---------------- */

  /**
   * 算出所有合法叫法。
   * 不做自由输入 —— 酒桌上喊错要重来，做成按钮列表更顺，
   * 也避免输入框在小屏上被键盘顶飞。
   */
  buildOptions() {
    const total = DICE_PER_PLAYER * 2
    const cur = this.data.bid
    const opts = []

    if (!cur) {
      /* 开局：从 1 个往上，点数 1~6 都可以（实战一般从 2 个起，
         但两人局 10 颗骰子，从 1 个起更容易上手） */
      for (let n = 1; n <= total; n++) {
        for (let f = 1; f <= 6; f++) {
          opts.push({ n: n, face: f, zhai: false, label: n + ' 个 ' + f })
        }
      }
    } else {
      for (let n = 1; n <= total; n++) {
        for (let f = 1; f <= 6; f++) {
          const cand = { n: n, face: f, zhai: cur.zhai }
          if (isHigher(cand, cur)) {
            opts.push({ n: n, face: f, zhai: cur.zhai, label: n + ' 个 ' + f + (cur.zhai ? ' 斋' : '') })
          }
          /* 斋 → 非斋（飞斋）：数量要加 2 以上 */
          if (cur.zhai) {
            const fly = { n: n, face: f, zhai: false }
            if (fly.n >= cur.n + 2 && isHigher(fly, { n: cur.n, face: cur.face })) {
              opts.push({ n: n, face: f, zhai: false, label: n + ' 个 ' + f + ' 飞' })
            }
          }
        }
      }
    }

    /* 只显示最接近上家的 24 个选项，全列会有 60 个按钮、翻半天 */
    const start = cur ? 0 : 0
    this.setData({ options: opts.slice(start, start + 24) })
  },

  /** 更多选项（分页） */
  moreOptions() {
    sfx.play('tapSoft')
    const total = DICE_PER_PLAYER * 2
    const cur = this.data.bid
    const all = []
    if (!cur) {
      for (let n = 1; n <= total; n++) for (let f = 1; f <= 6; f++) all.push({ n: n, face: f, zhai: false, label: n + ' 个 ' + f })
    } else {
      for (let n = 1; n <= total; n++) {
        for (let f = 1; f <= 6; f++) {
          const c = { n: n, face: f, zhai: cur.zhai }
          if (isHigher(c, cur)) all.push({ n: n, face: f, zhai: cur.zhai, label: n + ' 个 ' + f + (cur.zhai ? ' 斋' : '') })
          if (cur.zhai) {
            const fly = { n: n, face: f, zhai: false }
            if (fly.n >= cur.n + 2 && isHigher(fly, { n: cur.n, face: cur.face })) {
              all.push({ n: n, face: f, zhai: false, label: n + ' 个 ' + f + ' 飞' })
            }
          }
        }
      }
    }
    /* 往后翻一页 */
    const shown = this.data.options.length
    const next = all.slice(shown, shown + 24)
    if (!next.length) return wx.showToast({ title: '已经到最后了', icon: 'none' })
    this.setData({ options: next })
  },

  makeBid(e) {
    const i = Number(e.currentTarget.dataset.i)
    const o = this.data.options[i]
    if (!o) return
    sfx.play('tap')

    const trail = this.data.trail.slice()
    trail.unshift({ by: this.data.turn, label: o.label })
    if (trail.length > 6) trail.pop()

    /* 叫完之后换手：对方要接手，所以走一次交接屏。
       注意不是回"看骰"那一步 —— 骰子整局都记得，重看是多余的。 */
    this.setData({
      bid: { n: o.n, face: o.face, zhai: o.zhai, by: this.data.turn },
      turn: this.data.turn === 1 ? 2 : 1,
      phase: 'handoff',
      handoffTo: 'bid',
      showMine: false,
      trail: trail
    })
    this.buildOptions()
  },

  /* ---------------- 开骰 ---------------- */

  open() {
    const bid = this.data.bid
    if (!bid) return
    sfx.play('suspense')

    setTimeout(() => {
      const all = this.data.p1.concat(this.data.p2)
      const actual = countFace(all, bid.face, bid.zhai)

      /* 叫的数量 <= 实际 → 叫的人没吹牛，开的人输；否则叫的人输 */
      const bidderWins = actual >= bid.n
      const loser = bidderWins ? (bid.by === 1 ? 2 : 1) : bid.by

      const text = actual >= bid.n
        ? ('真的有 ' + actual + ' 个 ' + bid.face + '，叫骰成立')
        : ('只有 ' + actual + ' 个 ' + bid.face + '，' + bid.n + ' 个是吹的')

      this.setData({
        phase: 'over',
        reveal: { actual: actual, need: bid.n, face: bid.face, zhai: bid.zhai, ok: bidderWins },
        loser: loser === 1 ? '玩家1' : '玩家2',
        resultText: text
      })

      sfx.play(bidderWins ? 'reveal' : 'lose')
      setTimeout(() => sfx.play('drink'), 700)

      this.savePlayed()
    }, 900)
  },

  savePlayed() {
    try {
      const p = wx.getStorageSync('gamePlayed') || {}
      p.liar = (p.liar || 0) + 1
      wx.setStorageSync('gamePlayed', p)
    } catch (e) {}
  },

  toggleMute() {
    const m = sfx.setMuted(!this.data.muted)
    this.setData({ muted: m })
  },

  goLobby() { wx.navigateBack() }
})
