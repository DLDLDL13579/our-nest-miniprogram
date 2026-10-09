/**
 * 多人游戏房间（大厅）
 *
 * ============ 只有联网版 ============
 * 2.6.0 起删掉了三个单机页（dice / liar / wheel）—— 用户明确说
 * 「除了多人联机，其他单机的几乎没用，删除都可以，全部都是在线多人玩的」。
 * 所有游戏都在这个页面里，靠房间码聚人、服务端同步状态。
 *
 * ============ 为什么用轮询而不是 watch ============
 * 云数据库的 watch 能实时推送，但要维持长连接、处理断线重连，
 * 而且 onError 之后必须自己重建监听，代码量和出错面都大得多。
 * 酒桌游戏的操作间隔是秒级，1.5 秒轮询的体感已经够了。
 *
 * 轮询还有一个隐性好处：**天然容错**。某次请求失败，下一次接着来就行；
 * 而 watch 断了如果不重建，就是"再也收不到更新"的静默故障。
 *
 * ============ 摇盅流程（2.6.0 重做）============
 * 用户反馈「动画和真实场景差很多」。对着现实拆解后补上了**盅**：
 *
 *     骰子入盅 → 摇盅 → 扣盅 → 揭盅 → 骰子在桌上滚两下才停
 *
 * 关键认识：现实里摇盅时**根本看不见骰子**（盅不透明），
 * 悬念恰恰来自"看不见"。改造前让骰子在空中翻，所以看着假。
 */
const app = getApp()
const { call } = require('../../../utils/cloud.js')
const sfx = require('../../../utils/sfx.js')
const feedback = require('../../../utils/feedback.js')

const POLL_MS = 1500

/* 游戏选项 */
const GAMES = [
  { k: 'liar', name: '大话骰', icon: 'target', desc: '轮流往上叫，不信就开' },
  { k: 'dice', name: '摇骰子比大小', icon: 'dice', desc: '一起摇，点数大的赢' },
  { k: 'wheel', name: '命运转盘', icon: 'wheel', desc: '房主转，结果全场同步' }
]

/* 转盘扇区。权重决定扇区角度 —— 概率和视觉必须一致，
   否则玩家会感觉"明明指着喝一杯却判成真心话"（这类 bug 最伤信任）。 */
const SECTORS = [
  { k: 'truth', t: '真心话', weight: 22, color: '#C4573A' },
  { k: 'dare',  t: '大冒险', weight: 20, color: '#5E7FA6' },
  { k: 'drink', t: '喝一杯', weight: 18, color: '#7A5CA8' },
  { k: 'you',   t: '你喝',   weight: 14, color: '#4E8C6A' },
  { k: 'me',    t: '我喝',   weight: 12, color: '#B8863C' },
  { k: 'both',  t: '一起喝', weight: 8,  color: '#A84E6B' },
  { k: 'pass',  t: '免罚一次', weight: 6, color: '#5A8CA8' }
]

/**
 * 算扇区角度，并生成 conic-gradient 色带 + 标签坐标。
 *
 * 抽成纯函数是为了能被断言直接测（见 scripts/test-wheel.js）——
 * 角度算错时转盘照样转，只是"指着的和判出来的不一样"，
 * 这类 bug 最伤信任（玩家不会觉得是 bug，会觉得游戏在骗人）。
 *
 * ★ 用**单条** conic-gradient 字符串（而不是每个扇区一个 view 各自画）：
 *   这是单机版验证过的写法，兼容性有保障；
 *   多元素 + CSS 变量在部分基础库上不生效（静默变成一个纯色圆盘）。
 */
function buildSectors() {
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
      k: s.k, t: s.t, color: s.color,
      a0: from, a1: to, mid: (from + to) / 2, span: deg, i: i
    })
    acc = to
  })
  const gradient = 'conic-gradient(from 0deg, ' + stops.join(', ') + ')'
  /* 标签位置：扇区中线、半径 33% 处（百分比，和单机版一致） */
  list.forEach(s => {
    const a = (s.mid - 90) * Math.PI / 180
    s.lx = 50 + Math.cos(a) * 33
    s.ly = 50 + Math.sin(a) * 33
  })
  return { list: list, gradient: gradient }
}

const icons = require('../../../utils/icons.js')
/*
 * 图标：内联 SVG 替代 emoji（跨机型渲染不一致，见 utils/icons.js）
 *
 * ★★ 这里漏注册过一次，代价是页面上直接显示英文 key。
 *
 * emoji→SVG 改造时，GAMES 里的 `icon` 从 '🎯' 改成了 'target'，
 * 但**只改了数据源、没改渲染方式**：
 *   · room.wxml 写的是 `{{item.icon}}` —— 它打印的是**字符串本身**，
 *     于是页面上出现「target 大话骰 / dice 摇骰子比大小」这种英文乱码；
 *   · 而且注册表里根本没有 'target'，就算改成 <image> 也是空白。
 *
 * 为什么断言没抓到：那条"模板里已无 emoji"只扫 **wxml**，
 * 而 `icon: 'target'` 这个值写在 **js** 里 ——
 * 它查的是"有没有 emoji 残留"，管不到"图标 key 被当成文字渲染"。
 * 现在 scripts/test-contract.js 的 ③e 补了这条检查。
 *
 * 未选中态**不用第二种颜色**（不在 SVG 里塞 rgba）——
 * 直接用 CSS opacity 压暗。少一条颜色编码路径就少一处渲染风险。
 */
const _IC = {}
for (const _k of ['speakerOn', 'speakerOff', 'target', 'dice', 'wheel']) {
  _IC[_k] = icons.dataUri(_k, '#E8B33C')
}

/**
 * 服务端 phase → 页面 stage。
 *
 * ★★ 必须**只有这一处**做映射。之前踩过的坑：
 *   `doStart` 里写死 `stage:'playing'`，而服务端 start 返回的是
 *   `phase:'countdown'`（还有 3.2 秒倒计时）——
 *   于是房主本地 stage=playing、房间实际 phase=countdown：
 *     · 房主看到的是"游戏界面"，点转盘/摇盅 → 服务端回「这局还没开始」
 *     · 1.5 秒后轮询又把他拽回倒计时界面，界面**闪一下**
 *     · 非房主反而正常（他们全靠轮询，走的就是这个映射）
 *   这就是「转盘无法转」的根因 —— 不是转盘坏了，是房主压根没进 playing。
 *
 *   凡是"服务端状态 → 界面状态"的推导，都只能有一个出口，
 *   否则两处一旦不同步，就会出现"某台手机上能点、另一台不能"的怪现象。
 */
function stageOf(phase) {
  if (phase === 'lobby') return 'lobby'
  if (phase === 'countdown') return 'countdown'
  if (phase === 'playing') return 'playing'
  return 'over'
}

Page({
  data: {
    ic: _IC,
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
    /* 动效状态 */
    rolling: false,      // 摇盅中
    suspense: false,     // 开骰蓄力
    impact: false,       // 屏幕震动
    cdText: '',          // 倒计时显示

    /* ---------- 骰盅 ---------- */
    cupSrc: 'cup-down',  // 当前显示的盅图（cup-down / cup-shake / cup-up）
    cupCls: '',          // 附加动画类（shaking / slam / lift）
    cupHint: '',         // 盅下方提示语
    myDice: [],          // 我的骰子点数（揭盅/偷看时显示）
    diceShown: false,    // 骰子是否可见
    myRolled: false,     // 我这轮是否已经摇过
    liarReady: false,    // 大话骰：是否已经扣盅（扣了才能叫）

    /* ---------- 转盘 ---------- */
    wheelSectors: [],
    wheelGradient: '',
    wheelDeg: 0,
    wheelDur: 2700,
    wheelCls: '',
    wheelText: '',
    wheelSpinning: false
  },

  onLoad() {
    sfx.init && sfx.init()
    /* ★ 必须先初始化定时器数组：摇盅流程里有十几处 _cupTimers.push，
       不初始化的话第一次 push 就是 undefined.push → 页面直接崩。
       这类错误 check.sh 的语法检查发现不了（语法是对的）。 */
    this._cupTimers = []
    const w = buildSectors()
    this.setData({
      muted: sfx.isMuted(),
      wheelSectors: w.list,
      wheelGradient: w.gradient
    })
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
    feedback.clear()
    this.clearCupTimers()
  },

  /** 清掉倒计时定时器（页面卸载时不能留） */
  clearCountdown() {
    if (this._cdTimers) { this._cdTimers.forEach(t => clearTimeout(t)); this._cdTimers = [] }
  },

  /** 清掉骰盅动画的定时器 */
  clearCupTimers() {
    if (this._cupTimers) { this._cupTimers.forEach(t => clearTimeout(t)); this._cupTimers = [] }
    if (this._wheelTimer) { clearInterval(this._wheelTimer); this._wheelTimer = null }
  },

  onUnload() {
    this.stopPoll()
    this.clearCountdown()
    this.clearCupTimers()
    feedback.clear()
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

  /**
   * 判断「这次轮询拿到的房间状态，和上次相比有没有实质变化」。
   *
   * ★ 为什么必须有这个判断（性能第一原则）：
   *   小程序的 `setData` 不是"赋值"，它是**跨线程的数据拷贝 + 视图 diff**。
   *   即使值完全相同，setData 也要序列化、拷贝、走一遍 setData 回调。
   *   房间页每 1.5 秒轮询一次，一场游戏十几分钟 → 上百次 setData，
   *   而其中**绝大多数是"什么都没变"**（等别人的时候尤其明显）。
   *   不做这个判断就是纯浪费 —— 用户看到的是掉帧、耗电、发热。
   *
   * 只比"会影响画面"的字段：phase / 人数 / 每人状态 / 叫骰 / 结果 / 转盘结果。
   * updatedAt 每轮都在变，不能参与比较。
   */
  roomChanged(prev, room) {
    if (!prev) return true
    if (prev.phase !== room.phase) return true
    if (prev.count !== room.count) return true
    if (prev.turn !== room.turn) return true
    if (prev.round !== room.round) return true
    if (prev.game !== room.game) return true
    if (prev.host !== room.host) return true
    if (prev.countdownMs !== room.countdownMs) return true

    /* 叫骰：整体比（at 是服务端时间戳，只有真的有人叫才会变） */
    const a = prev.bid, b = room.bid
    if (!!a !== !!b) return true
    if (a && b && (a.n !== b.n || a.face !== b.face || a.zhai !== b.zhai || a.at !== b.at)) return true

    /* 结算结果 */
    const ra = prev.lastResult, rb = room.lastResult
    if (!!ra !== !!rb) return true
    if (ra && rb && JSON.stringify(ra) !== JSON.stringify(rb)) return true

    /* 转盘这一转 */
    const sa = prev.spin, sb = room.spin
    if (!!sa !== !!sb) return true
    if (sa && sb && sa.at !== sb.at) return true

    /* 每个人的状态：在线状态、已摇、骰子（自己的） */
    const pa = prev.players || [], pb = room.players || []
    if (pa.length !== pb.length) return true
    for (let i = 0; i < pa.length; i++) {
      const x = pa[i], y = pb[i]
      if (x.online !== y.online) return true
      if (x.isHost !== y.isHost) return true
      if (x.isMe !== y.isMe) return true
      if ((x.diceCount || 0) !== (y.diceCount || 0)) return true
      if (x.name !== y.name) return true
      /* 自己的骰子在大话骰里是"隐藏"的，dice 字段才是关键 */
      if (JSON.stringify(x.dice || null) !== JSON.stringify(y.dice || null)) return true
    }

    /* 叫骰选项（前端算的）可能随 bid 变化 */
    if (JSON.stringify(prev.options || null) !== JSON.stringify(room.options || null)) return true

    /* ★ 轮次提示：轮到谁变了必须刷新 ——
       漏了这条，"该你了"的提示会停在上一轮，比不做还糟
       （玩家以为轮到自己了，点了却被拒）。 */
    if (prev.myTurn !== room.myTurn) return true
    if (prev.turnName !== room.turnName) return true
    /* "还在等谁"同理：别人摇完了要立刻反映出来 */
    if (prev.waitingCount !== room.waitingCount) return true
    if (prev.waitingNames !== room.waitingNames) return true

    return false
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
    /* ★★ 派生字段走唯一入口 decorate()。
       原来是内联在这里算的，只有 refresh 这一条路会算 ——
       而另外 7 处 `setData({ room: r.room })` 整体替换时不会算，
       于是 options/myTurn 被抹成 undefined（详见 decorate 的注释）。 */
    const room = this.decorate(res.room)

    /* 阶段变化时给声音反馈 —— 让"别人做了操作"这件事被听见。
       多人游戏的音效有个特殊职责：**提示"不在这部手机上的事发生了"**。 */
    if (prev && prev.phase !== room.phase) {
      if (room.phase === 'countdown') {
        /* ★ 新一局：所有本地局内状态在这里统一清掉。
           不能靠"某个字段恰好变了"来重置 —— 漏一处就是"新一局还是旧骰子"，
           而且不报错。 */
        this.resetRound()
        /* 开局倒计时开始：读秒声（最后一声更急促） */
        this.startCountdown(room.countdownMs)
      } else if (room.phase === 'playing') {
        /* 开局：倒计时结束 → 骰子入盅。
           ★ 按现实顺序：先把骰子放进盅（入盅声），再开始摇。
           改造前是直接"摇"，没有入盅这一步，所以听起来像凭空开始的。 */
        feedback.fire('countdownGo')
        this._cupTimers.push(setTimeout(() => {
          feedback.fire('diceIn')
          this.setData({ cupSrc: 'cup-down', cupCls: 'into', cupHint: '骰子进盅了' })
        }, 260))
        /* 入盅之后自动起摇 —— 现实里没人会放好骰子再等半天 */
        this._cupTimers.push(setTimeout(() => this.autoShake(), 1000))
      } else if (room.phase === 'over') {
        feedback.fire('cupOpen')
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

    /* 同步骰盅状态（我这边的骰子点数、是否已扣盅） */
    this.syncCup(room, prev)

    /* 转盘：别人转的时候，我这边也要看到转 —— 靠轮询发现 spin.at 变了。
       ★ 这是"多人游戏"必须做对的地方：不在这部手机上发生的动作，
         也必须被看到/听到，否则其他人会觉得"卡住了"。 */
    if (room.game === 'wheel' && room.spin) {
      const prevAt = (prev && prev.spin && prev.spin.at) || 0
      if (room.spin.at !== prevAt) {
        this.playWheel(room.spin)
      }
    }

    /* ──────────────────────────────────────────────
       ★ 性能关键：什么都没变就**不要** setData
       ──────────────────────────────────────────────
       上面这些副作用（阶段音效、人数增减、叫骰、转盘）已经处理完了。
       如果这一轮状态和上次**实质相同**，就不该再 setData：

       setData 不是赋值，它是「序列化 → 跨线程拷贝 → 视图层 diff」。
       即使值一模一样也要走完这一整套。一场游戏十几分钟、
       每 1.5 秒一轮 → 上百次 setData，而等别人的时候**绝大多数都没变化**。
       不做这个判断就是纯浪费：掉帧、耗电、发热。

       提前 return 之前已经把 netTip 清掉了 —— 那是有意义的 UI 变化，
       必须照常渲染。 */
    if (!this.roomChanged(prev, room) && !this.data.netTip) return

    this.setData({
      room: room,
      /* ★ 走统一映射，别在这里手写三元表达式 ——
         之前 doStart 里写死 'playing' 就是这类"两处各写一份"出的错 */
      stage: stageOf(room.phase),
      result: room.lastResult || null,
      netTip: ''
    })
  },

  /**
   * 把服务端状态同步到骰盅的显示上。
   *
   * ★ 这里有个容易做错的点：**不能每次轮询都重置盅的状态**。
   * 轮询 1.5 秒一次，如果每次都按服务端状态覆盖，
   * 玩家正在摇盅（本地动画进行中）就会被硬拽回"扣着"的状态 —— 表现为动画抽一下。
   * 所以只在**状态真的变了**的时候才动。
   */
  syncCup(room, prev) {
    if (!room) return
    const mine = (room.players || []).filter(p => p.isMe)[0] || {}
    const myDice = (mine.dice || [])

    /* ---------- 摇骰子比大小 ---------- */
    if (room.game === 'dice') {
      const rolled = myDice.length > 0
      /*
       * ★★ 这里原来是 `rolled && !myRolled → 已扣盅，等其他人`，
       *    而云端**开局就把骰子发给所有人**，于是：
       *      一进 playing 就 myRolled=true → 摇盅按钮永远点不动（doRoll 直接 return）
       *      → 游戏彻底卡死。用户说的「双人交互不智能」就是这个。
       *    现在云端改成"谁摇谁生成"（dice 房开局不发骰子），
       *    所以 rolled 只在**自己真的摇过**之后才为真，这条判断才成立。
       *
       *    另外：这里只在"我"的骰子出现时扣盅，**不再**用 round 变化去猜新一局 ——
       *    新一局的重置改在 phase 进入 countdown 时统一做（见 resetRound），
       *    判据唯一，不会因为轮询时机不同而漏掉。
       */
      if (rolled && !this.data.myRolled) {
        this.setData({
          myRolled: true, myDice: myDice,
          cupSrc: 'cup-down', cupCls: '',
          cupHint: '已扣盅，等其他人摇完',
          diceShown: false
        })
      }
      /* 还没摇的人：给一句明确的"该你了"，而不是一片空白 */
      if (!rolled && room.phase === 'playing' && !this.data.rolling && !this.data.myRolled) {
        if (this.data.cupHint !== '该你了，摇盅！') {
          this.setData({ cupHint: '该你了，摇盅！' })
        }
      }
    }

    /* ---------- 大话骰 ---------- */
    if (room.game === 'liar') {
      /* 骰子到手 → 记下来（偷看时要显示）。
         ★ 原来写成 `if (!liarReady) setData({myDice})` ——
           liarReady 一旦为 true 就再也不会更新 myDice，
           新一局骰子变了、界面还显示上一局的点数。
           现在无条件同步，liarReady 只表示"这一局偷看过没有"。 */
      if (myDice.length && JSON.stringify(myDice) !== JSON.stringify(this.data.myDice)) {
        this.setData({ myDice: myDice })
      }
      /* 还没偷看 → 明确引导；看过了 → 提示可以再看 */
      if (myDice.length && !this.data.diceShown) {
        const want = this.data.liarReady ? '按住盅可以再看' : '按住盅偷看自己的骰子'
        if (this.data.cupHint !== want) this.setData({ cupHint: want })
      }
    }
  },

  /**
   * 新一局开始时把"这一局的本地状态"清干净。
   *
   * ★ 为什么必须集中做：这些字段（骰子、是否摇过、是否偷看过、盅的样子）
   *   散在十几个 setData 里，靠"某个条件恰好成立"来重置 ——
   *   只要有一处漏了，就会出现"新一局还是上一局的骰子""按钮点不动"这类怪事，
   *   而且**不报错**。统一在一个入口重置，才不会有漏网的。
   */
  resetRound() {
    this.clearCupTimers()
    this.setData({
      myDice: [], myRolled: false, liarReady: false, diceShown: false,
      rolling: false, suspense: false,
      cupSrc: 'cup-down', cupCls: '', cupHint: '',
      result: null
    })
  },

  /**
   * 自动摇盅（开局后）。
   *
   * 现实里骰子入盅之后，大家会一起哗啦哗啦摇几秒再扣下 ——
   * 这个动作不需要玩家操作，是**场面音**。所以自动播一遍，
   * 让所有人（包括还没摇的人）都听到"有人在摇"。
   */
  autoShake() {
    if (this.data.stage !== 'playing') return
    feedback.fire('cupShake')
    this.setData({ cupSrc: 'cup-shake', cupCls: 'shaking', cupHint: '摇盅中…' })
    this._cupTimers.push(setTimeout(() => {
      if (this.data.stage !== 'playing') return
      /* 摇完自然扣下 —— 但玩家的骰子还没摇，所以扣的是"空盅" */
      this.setData({ cupSrc: 'cup-down', cupCls: '', cupHint: '该你了，摇盅' })
    }, 1050))
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

  /**
   * ★★ 给服务端返回的 room 补上「前端算出来的字段」——**唯一入口**。
   *
   * ============ 为什么必须抽成一个函数（真实事故） ============
   *
   * 服务端 `shape()` 只返回它自己知道的东西：phase / players / turn / bid …
   * 而下面这 5 个字段是**前端算的**，服务端**根本不返回**：
   *
   *     options / myTurn / turnName / waitingCount / waitingNames
   *
   * 问题在于 `room.js` 里有 7 处 `this.setData({ room: r.room })`，
   * 而 setData 对 `room` 是**整体替换**（不是合并子字段）——
   * 每调用一次，这 5 个字段就被抹成 `undefined`。
   *
   * 于是出现了 2026-10-09 用户实测报的现象：
   *
   *     点一下「2个3」→ 云端成功 → options 被抹成 undefined
   *                  → 逻辑层立刻变，但**视图层还没重绘**（按钮还在屏幕上）
   *                  → 再点 → label 取不到 → 正则不匹配 → return
   *                  → **完全没反应**，连请求都不发、一句提示都没有
   *
   * 这和之前「转盘无法转」是**同一类错误**：
   *   `stage` 曾经在 doStart 里被手写死 → 抽出 `stageOf()` 才修好；
   *   现在 `options` 等派生字段有 7 个出口 → 同样必须收敛成 1 个。
   *
   * ⚠️ 只算前端字段，**不要动服务端字段** —— 这里不是"状态机"，
   *    是纯粹的"给响应补上派生视图字段"。
   *
   * @param {object} room 服务端返回的房间对象（会被就地补全并返回）
   */
  decorate(room) {
    if (!room) return room

    /* 叫骰选项：随人数和上家叫法变化，前端算（服务端只判合法性）。
       真点下去服务端还会再校验一次，所以前端算错也骗不过去。 */
    room.options = this.buildOptions(room)

    /* 轮次提示：服务端已给 turn（座位号）和 me.seat，比一下就有 */
    const mySeat = (room.me && room.me.seat) || 0
    room.myTurn = !!room.turn && room.turn === mySeat
    room.turnName = ((room.players || []).filter(p => p.seat === room.turn)[0] || {}).name || ''

    /* "还在等谁"：摇骰子比大小里，扣盅后唯一能做的事就是等。
       只说"等其他人"等于没说 —— 不知道等几个、等谁。 */
    const waiting = (room.players || []).filter(p => !(p.diceCount > 0))
    room.waitingCount = waiting.length
    room.waitingNames = waiting.map(p => p.name).join('、')

    return room
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
      /* ★ 即便"建房后必然是 lobby"，也从服务端返回的 phase 推导 ——
         手写常量等于在第二个地方重复描述"服务端是什么状态"，
         将来服务端一改（比如建房直接进倒计时），这里就悄悄错了。 */
      this.setData({ room: this.decorate(r.room), stage: stageOf(r.room.phase) })
      this.startPoll()
    }
  },

  /* ================= 加入 ================= */

  onCode(e) {
    /*
     * 房间号改 3 位纯数字后，这里**只留数字**：
     * 用户可能手滑打进空格、字母、或者用输入法带出全角字符，
     * 直接滤掉比"输错了再报错"体验好得多。
     */
    this.setData({ joinCode: String(e.detail.value || '').replace(/\D/g, '').slice(0, 3) })
  },

  async doJoin() {
    const code = (this.data.joinCode || '').trim()
    if (code.length !== 3) {
      return this.setData({ err: '房间号是 3 位数字' })
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
      this.setData({ room: this.decorate(r.room), stage: stageOf(r.room.phase), joinCode: '' })
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
      /* ★ stage 必须跟随服务端返回的 phase（start 之后是 countdown，不是 playing）。
         写死 'playing' 会让房主跳过倒计时、直接对着还没开始的游戏界面操作 ——
         「转盘无法转」「摇盅没反应」都是这么来的。 */
      this.setData({ room: this.decorate(r.room), stage: stageOf(r.room.phase) })
      /* 房主自己也要走倒计时读秒 —— 否则只有非房主听到读秒声 */
      if (r.room.phase === 'countdown') this.startCountdown(r.room.countdownMs)
    } else if (r && !r.ok) {
      wx.showToast({ title: r.msg || '开不了', icon: 'none', duration: 2500 })
    }
  },

  async doAgain() {
    /* ★ 同 doBid：call() 失败会 throw，`.catch(() => null)` 会吞掉原因 → 点了没反应 */
    const r = await call('room', { action: 'again', id: this.data.room.id }, { loading: '重开' })
      .catch((e) => {
        wx.showToast({
          title: (e && (e.friendly || e.message)) || '开不了新一局',
          icon: 'none', duration: 2200
        })
        return null
      })
    if (r && r.ok) {
      sfx.play('tap')
      /* 再来一局 → 服务端回到 lobby；同样从 phase 推导，不写死 */
      this.setData({ room: this.decorate(r.room), stage: stageOf(r.room.phase), result: null })
      this.resetRound()
    } else if (r && !r.ok) {
      wx.showToast({ title: r.msg || '只有房主能开新局', icon: 'none', duration: 2500 })
    }
  },

  /* ================= 摇骰子（比大小） =================
     全流程照现实走：摇盅 → 扣盅 → 揭盅 → 骰子在桌上滚两下才停。
     每一步都有对应的声音和动画，不是"点一下出结果"。
     ================= */

  async doRoll() {
    if (this.data.rolling || this.data.myRolled) return
    this.clearCupTimers()
    this.setData({ rolling: true })

    /* ① 摇盅：持续音 + 盅体晃动。
       现实里摇盅是 1~2 秒的事，太快没有"摇"的感觉，
       太慢会让人等得不耐烦 —— 实测 1.05 秒最像。 */
    feedback.fire('cupShake')
    this.setData({
      cupSrc: 'cup-shake', cupCls: 'shaking',
      cupHint: '摇盅中…', diceShown: false
    })

    /* 请求和摇动动画并行 —— 网络快时动画还没演完就拿到结果了，
       所以下面的扣盅要等动画走完（否则"摇"到一半突然扣下，很突兀）。 */
    const req = call('room', { action: 'roll', id: this.data.room.id }, { silent: true })
      .catch((e) => {
        /* ★ 摇失败必须说 —— 原来吞成 null，动画照演一遍却什么都没发生 */
        wx.showToast({
          title: (e && (e.friendly || e.message)) || '摇不了，再试一次',
          icon: 'none', duration: 2200
        })
        return null
      })

    await this.wait(1050)

    /* ② 扣盅 —— 整个流程的重音。
       盅砸在桌上，整屏震一下，骰子在盅里被震得跳一下（音效里带了）。 */
    this.setData({ cupSrc: 'cup-down', cupCls: 'slam', cupHint: '扣盅…' })
    feedback.fire('cupSlam')
    this._cupTimers.push(setTimeout(() => this.bump(), 70))
    this._cupTimers.push(setTimeout(() => {
      this.setData({ cupCls: '' })
    }, 400))

    const r = await req
    this.setData({ rolling: false })

    if (!r || !r.ok) {
      this.setData({ cupHint: '没摇成功，再试一次' })
      if (r && !r.ok) wx.showToast({ title: r.msg || '摇不了', icon: 'none' })
      return
    }

    /* ③ 揭盅：盅提起来，我的骰子露出来 */
    this.setData({ room: this.decorate(r.room), myDice: (r.room.me && r.room.me.dice) || [] })
    this._cupTimers.push(setTimeout(() => this.revealCup(), 260))

    if (r.result) {
      /* 全员摇完 → 出结果 */
      this._cupTimers.push(setTimeout(() => this.showFinalResult(r), 1300))
    } else {
      /* 还没轮完 → 扣回盅，等别人 */
      this._cupTimers.push(setTimeout(() => {
        this.setData({
          myRolled: true,
          cupSrc: 'cup-down', cupCls: '', diceShown: false,
          cupHint: '已扣盅，等其他人摇完'
        })
      }, 1150))
    }
  },

  /**
   * 揭盅：提起盅，露出骰子，骰子在桌上再滚两下才停。
   *
   * ★ 为什么要有"再滚两下"：揭盅之后骰子立刻定住是"贴图切换"，
   *   现实里骰子会再滚一小段才停 —— 缺这一下就没有物理感。
   *   视觉上靠骰子的逐个落位动画表现，声音靠 diceOnTable。
   */
  revealCup() {
    feedback.fire('cupLift')
    this.setData({
      cupSrc: 'cup-up', cupCls: 'lift',
      diceShown: true, cupHint: '开了！'
    })
    /* 骰子落在桌上滚两下 */
    this._cupTimers.push(setTimeout(() => {
      feedback.fire('diceTable')
      this.bump()
    }, 180))
    /* 盅提走之后留在画面外 */
    this._cupTimers.push(setTimeout(() => {
      this.setData({ cupCls: 'gone' })
    }, 520))
  },

  /** 全员摇完的结果演出 */
  showFinalResult(r) {
    /* 先揭自己的盅，再亮全场 */
    this.revealCup()
    this._cupTimers.push(setTimeout(() => {
      sfx.play('impactLow', { volume: 0.5 })
      this.bump()
    }, 60))
    this._cupTimers.push(setTimeout(() => sfx.play('revealHit'), 260))

    const mySeat = (r.room.me || {}).seat
    const iWon = (r.result.winnerSeats || []).indexOf(mySeat) >= 0
    this._cupTimers.push(setTimeout(() => sfx.play(iWon ? 'confetti' : 'failDrop'), 620))

    /* ★ 连庄音：连赢的音高逐级升高（combo-1 → combo-4）。
       这是"连庄"这件事的声音表达 —— 连赢两把和赢一把听感不同，
       而且越连越高会形成"还想再来一把"的拉力。 */
    const myStreak = (r.result.streaks || {})[mySeat] || 0
    if (myStreak >= 1) {
      const comboKey = 'combo' + Math.min(4, myStreak)
      this._cupTimers.push(setTimeout(() => sfx.play(comboKey, { pitch: false }), 880))
    }

    this._cupTimers.push(setTimeout(() => {
      this.setData({ result: r.result, stage: 'over' })
    }, 1500))
  },

  /** 等一段时间（Promise 版 setTimeout，让流程能写成顺序的） */
  wait(ms) {
    return new Promise(resolve => {
      this._cupTimers.push(setTimeout(resolve, ms))
    })
  },

  /** 屏幕震一下（关键结果时的打击感） */
  bump() {
    this.setData({ impact: true })
    if (this._bumpTimer) clearTimeout(this._bumpTimer)
    this._bumpTimer = setTimeout(() => this.setData({ impact: false }), 320)
  },

  /* ================= 大话骰：扣盅与偷看 ================= */

  /**
   * 按住盅 → 抬起来偷看自己的骰子。
   *
   * ★ 这是大话骰的核心仪式感，也是用户明确要求的：
   *   「扣盅后才能看自己的骰子」。
   *   真实玩法里必须先扣稳盅、再抬一条缝瞄一眼 —— 否则骰子会被别人看到。
   *   所以这里做成**按住才看**（松手立刻扣回），而不是点一下切换：
   *   按住的交互本身就复刻了"偷偷看一眼"的动作。
   */
  onCupPress() {
    if (this.data.stage !== 'playing') return
    if (this.data.room && this.data.room.game !== 'liar') return
    if (!this.data.myDice.length) return
    feedback.vibrate('light')
    sfx.play('cupLift', { volume: 0.5 })
    this.setData({
      cupSrc: 'cup-up', cupCls: 'peek',
      diceShown: true, cupHint: '松手扣回去',
      liarReady: true          // 看过骰子之后才允许叫
    })
  },

  onCupRelease() {
    if (this.data.stage !== 'playing') return
    if (this.data.room && this.data.room.game !== 'liar') return
    if (!this.data.diceShown) return
    sfx.play('cupSlam', { volume: 0.55 })
    this.setData({
      cupSrc: 'cup-down', cupCls: '',
      diceShown: false,
      cupHint: this.data.liarReady ? '按住盅可以再看' : ''
    })
  },

  /* ================= 大话骰 ================= */

  async doBid(e) {
    const ds = e.currentTarget.dataset
    const i = Number(ds.i)
    /*
     * ★ 优先用按钮**自带**的文本（模板里的 data-l）。
     *
     * 这是"根本解"：点击的正确含义由**用户实际看到的那个按钮**决定，
     * 而不是由逻辑层的派生数组决定 —— 后者会被 setData 抹掉、
     * 也可能比视图层新一拍（详见模板里 data-l 的注释）。
     * data-l 只有在极老的模板编译结果里才会缺，所以保留下面的回退。
     */
    const opts = (this.data.room && this.data.room.options) || []
    const label = ds.l || opts[i] || ''
    /* 选项是 "3个4" 这种字符串，解析回 n / face */
    const m = /^(\d+)个(\d)$/.exec(label)

    /*
     * ★★ 拿不到选项时**不能说走就走**（2026-10-09 用户实测报「点击 2个3 没反应」）。
     *
     * 原来这里是裸的 `if (!m) return` —— 一句提示都没有，用户只看到"点了没反应"。
     * 而它真的会发生：视图层重绘比逻辑层慢，按钮还画在屏幕上，
     * 但 `room.options` 已经被上一次 setData 抹成 undefined 了
     * （原因见 decorate() 的注释）。
     *
     * 现在的做法：**先自愈，再说话**。
     *   · 自愈：派生字段能重算就重算，把这次点击救回来（绝大多数情况能救）
     *   · 兜底：实在算不出来，也要给一句人话，不能让点击石沉大海
     */
    if (!m) {
      /* 自愈：options 是纯前端派生字段，能重算 */
      const room = this.data.room
      if (room && room.game === 'liar' && !this._bidHealing) {
        this._bidHealing = true          // 防止自愈失败时无限递归
        try {
          this.decorate(room)
          const retry = (room.options || [])[i] || ''
          if (/^(\d+)个(\d)$/.test(retry)) return this.doBid(e)   // 重算成功 → 正常走
        } finally {
          this._bidHealing = false
        }
      }
      sfx.play('tapSoft')
      wx.showToast({
        title: '这一下没点上，再点一次',
        icon: 'none', duration: 1800
      })
      return
    }
    const n = Number(m[1])
    const face = Number(m[2])

    /*
     * 点不动的时候，**必须说清"为什么"和"接下来做什么"**。
     *
     * 第一版是直接 return（点了完全没反应），用户以为界面坏了；
     * 第二版统一回一句"先按住盅偷看"，可如果其实是"没轮到你"，
     * 这句话就是错的 —— 玩家照做还是点不了，反而更困惑。
     * 所以按状态给不同的话。
     */
    if (!this.data.liarReady) {
      sfx.play('tapSoft')
      wx.showToast({ title: '先按住盅偷看自己的骰子', icon: 'none', duration: 1800 })
      return
    }
    if (!this.data.room.myTurn) {
      sfx.play('tapSoft')
      wx.showToast({
        title: '还没轮到你，等 ' + (this.data.room.turnName || '对方') + ' 叫',
        icon: 'none', duration: 1800
      })
      return
    }

    sfx.play('tap')
    /*
     * ★★ `call()` 在**业务失败时会 throw**（见 utils/cloud.js：`ok !== true` 就 throw），
     *    而不是返回 `{ ok:false }`。所以 `.catch(() => null)` 会把
     *    「只能往上叫」这类真实原因**吞成 null**，
     *    后面两个分支（`r.ok` / `r && !r.ok`）**一个都进不去** ——
     *    用户看到的就是「点了完全没反应」。
     *
     *    这是 2026-10-09 用户实测报「点击叫骰没有反应」的根因。
     *    正确做法：catch 里把 `e.friendly`（cloud.js 已经整理好的人话）提示出来。
     */
    const r = await call('room', {
      action: 'bid', id: this.data.room.id, n: n, face: face, zhai: false
    }, { silent: true }).catch((e) => {
      wx.showToast({
        title: (e && (e.friendly || e.message)) || '这一叫不行，换一个',
        icon: 'none', duration: 2200
      })
      return null
    })
    if (r && r.ok) {
      this.setData({ room: this.decorate(r.room) })
    }
  },

  async doOpen() {
    /* 开骰只有轮到自己才有意义 —— 先拦，别让玩家白等一次网络往返 */
    if (!this.data.room.myTurn) {
      sfx.play('tapSoft')
      wx.showToast({
        title: '还没轮到你，等 ' + (this.data.room.turnName || '对方') + ' 叫完',
        icon: 'none', duration: 1800
      })
      return
    }
    /* 开骰是全场最紧张的一刻 —— 三段式：
         蓄力（自己手机上）→ 开盅重击（全场都会轮询到）→ 结果音 */
    sfx.play('chargeUp', { volume: 0.6 })
    this.setData({ suspense: true })
    const r = await call('room', { action: 'open', id: this.data.room.id }, { silent: true })
      .catch((e) => {
        /* 同 doBid：吞掉错误 = 点了没反应。把真实原因说出来 */
        wx.showToast({
          title: (e && (e.friendly || e.message)) || '开不了，再试一次',
          icon: 'none', duration: 2200
        })
        return null
      })
    this.setData({ suspense: false })
    if (r && r.ok) {
      this.setData({ room: this.decorate(r.room), result: r.result, stage: 'over' })
      sfx.play('revealHit')
      this.bump()
      feedback.vibrate('heavy')
      setTimeout(() => {
        const mySeat = (r.room.me || {}).seat
        const iLost = r.result.loserSeat === mySeat
        sfx.play(iLost ? 'failDrop' : 'confetti')
        feedback.vibrate(iLost ? 'long' : 'double')
      }, 340)
      setTimeout(() => sfx.play('gulp'), 900)
    } else if (r && !r.ok) {
      wx.showToast({ title: r.msg, icon: 'none', duration: 2200 })
    }
  },

  /* ================= 命运转盘（联机） =================
     房主点"转"，服务端抽结果，全场同步看到同一个扇区。

     ★ 结果必须服务端定，不能让房主前端定 —— 否则房主可以改结果。
       这是"联网游戏"和"一部手机传着玩"的根本区别：
       单机版可以本地随机（大家都在看同一块屏幕），联机版不行。
     ================= */

  async doSpin() {
    if (this.data.wheelSpinning) return
    if (!this.data.room || !this.data.room.host) return

    /*
     * ★ 和 doBid 同样的坑：`call()` 业务失败时 throw，
     *   `.catch(() => null)` 把「这局还没开始」吞掉 → 点转盘**毫无反应**。
     *   必须把 e.friendly 显示出来。
     */
    const r = await call('room', { action: 'spin', id: this.data.room.id }, { silent: true })
      .catch((e) => {
        wx.showToast({
          title: (e && (e.friendly || e.message)) || '转不了，再试一次',
          icon: 'none', duration: 2200
        })
        return null
      })
    if (!r || !r.ok) return
    this.playWheel(r.spin)
  },

  /**
   * 转盘动画。
   *
   * ★ 关键：**指针判定和动画必须用同一个角度**。
   *   第一版动画从 0 开始转，判定用绝对角度 —— 于是"指着喝一杯"却判成真心话。
   *   这类 bug 最伤信任（玩家不会觉得是 bug，会觉得游戏在骗人），
   *   所以角度计算抽成了纯函数，由 scripts/test-wheel.js 直接断言。
   *
   * @param {object} spin 服务端给的 { index, k, t, turns, jitter }
   */
  playWheel(spin) {
    if (!spin) return
    const w = buildSectors()
    const sec = w.list[spin.index] || w.list[0]

    /* 目标角度：让该扇区的**中心**停在指针处（指针在正上方，即 -90°）。
       加一点随机偏移，免得每次都停在同一度上 —— 但偏移必须**限制在扇区内**，
       否则指针会指到隔壁扇区，又变成"指的和判的不一样"。 */
    const safeJitter = Math.max(-sec.span / 2 + 2, Math.min(sec.span / 2 - 2, spin.jitter || 0))
    const targetMid = sec.mid + safeJitter
    /* 指针在顶部：扇区中心转到 -90° 位置 */
    const finalDeg = 360 * (spin.turns || 4) - targetMid - 90

    this.setData({
      wheelSpinning: true,
      wheelText: '转起来了…',
      wheelDeg: finalDeg
    })
    sfx.play('wheelStart')
    /* 持续咔哒：用 tick 按递减频率排期，模拟"越转越慢" */
    this.scheduleTicks(2600)

    this._wheelTimer = setTimeout(() => {
      this.setData({ wheelSpinning: false })
      feedback.fire('wheelStop')
      this.setData({ wheelText: spin.t })
      /* 抽到"免罚一次"给惊喜反馈，其他给普通确认 */
      if (spin.k === 'pass') {
        this._cupTimers.push(setTimeout(() => feedback.fire('luckyHit'), 160))
      }
    }, 2700)
  },

  /** 转盘咔哒：间隔按比例拉长，听感上"越来越慢" */
  scheduleTicks(durationMs) {
    let t = 0
    let gap = 34
    const timers = []
    while (t < durationMs) {
      timers.push(t)
      t += gap
      gap *= 1.075
    }
    timers.forEach((at, i) => {
      if (i > 60) return          // 上限保护：别排太多定时器
      this._cupTimers.push(setTimeout(() => sfx.play('tick', { pitch: false }), at))
    })
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
        /*
         * ★ 离开失败也要说 —— 原来 `.catch(() => {})` 静默吞掉，
         *   后果是"你的座位还占着、别人那边看到幽灵玩家"，而你毫不知情。
         *   成功时不会有任何提示（这是正常流程，不该打扰）。
         */
        await call('room', { action: 'leave', id: this.data.room.id }, { silent: true })
          .catch((e) => {
            wx.showToast({
              title: (e && (e.friendly || e.message)) || '退出没同步上，位置可能还占着',
              icon: 'none', duration: 2600
            })
          })
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
