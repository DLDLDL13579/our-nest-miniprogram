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
const { call } = require('../../utils/cloud.js')
/* 测试开关（soloTest）：一个人也能开局，见 config.js 的说明 */
const CFG = require('../../config.js')
const sfx = require('../sfx.js')
const settleFoot = require('../../game/settle.js')
const liarRules = require('../../utils/liarRules.js')
const feedback = require('../feedback.js')
const trace = require('../../utils/trace.js')
/*
 * 酒桌题卡库。★ 前端这份**只用来渲染"有哪些场合可选"**（名字/说明），
 * 真正的抽题在服务端做 —— 见 cloudfunctions/room/index.js 的 spin。
 * 前端抽的话可以"重摇到满意"，且没法保证全场同时看到同一张。
 */
const decks = require('../../utils/decks.js')
/* 牌面文字由共享模块生成 —— 和服务端算牌型的必须是同一份代码 */
const poker = require('../../utils/poker.js')

const POLL_MS = 1500

/*
 * 玩法列表 —— **不要再在这里硬编码**。
 *
 * 改造前这里是三个写死的对象，和 cloudfunctions/room/index.js 的
 * `['dice','liar','wheel']`、大厅的 MODES 各自维护一份。
 * 加一个玩法要改 3 处，漏一处就"大厅能看到、房间里切不过去"，
 * 而且**不报错**（同样的病 AGENTS.md 记过：派生字段 7 个出口）。
 *
 * 现在唯一来源是 utils/games.js。这里只做字段改名（id→k）适配既有模板，
 * 加玩法**不需要动这个文件**。
 */
const { GAMES: GAME_LIST, gameOf } = require('../../utils/games.js')
const GAMES = GAME_LIST.map(g => ({ k: g.id, name: g.name, icon: g.icon, desc: g.desc }))

/* 转盘扇区。权重决定扇区角度 —— 概率和视觉必须一致，
   否则玩家会感觉"明明指着喝一杯却判成真心话"（这类 bug 最伤信任）。 */
const SECTORS = [
  { k: 'truth', t: '真心话', weight: 22, color: '#9E4029' },
  { k: 'dare',  t: '大冒险', weight: 20, color: '#3F5A7A' },
  { k: 'drink', t: '喝一杯', weight: 18, color: '#573E7A' },
  { k: 'you',   t: '你喝',   weight: 14, color: '#36654C' },
  { k: 'me',    t: '我喝',   weight: 12, color: '#8C6226' },
  { k: 'both',  t: '一起喝', weight: 8,  color: '#7D3549' },
  { k: 'pass',  t: '免罚一次', weight: 6, color: '#3F6579' }
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
    /*
     * ★ 扇区之间的金色细分隔线（2026-10-29）。
     *
     * 目的：把"七个彩色扇形拼成的圆"变成"有分格的赌盘"。纯色相邻时，
     * 两个中饱和色块贴在一起像儿童转盘；一条 0.5deg 的金线立刻有实体盘的边。
     *
     * ⚠️ 只是**视觉**分隔线，不参与判定：判定用服务端抽出的 index（纯按权重），
     *    而这里的 0.5deg 累计最多偏 3deg（<1%），指针视觉与结果的对应不受影响。
     *    所以 list 里的 a0/a1 保持原值 —— 那条"扇区无缝覆盖 360°"的断言照旧成立。
     */
    if (i < SECTORS.length - 1) {
      stops.push(`rgba(232,179,60,.62) ${to.toFixed(2)}deg ${(to + 0.7).toFixed(2)}deg`)
    }
    list.push({
      k: s.k, t: s.t, color: s.color,
      a0: from, a1: to, mid: (from + to) / 2, span: deg, i: i
    })
    acc = to
  })
  const gradient = 'conic-gradient(from 0deg, ' + stops.join(', ') + ')'
  /*
   * 标签位置：扇区中线、半径 33% 处（百分比，和单机版一致）。
   *
   * ★★ 2026-10-28：小扇区（权重 4 的「免罚一次」、8 的「一起喝」）标签会挤在一起 ——
   *   同一个半径上，扇区越窄、可用的弧长越短，而文字长度不变。
   *   做法：**窄扇区往外挪**（越窄越靠外，弧长越大），并且窄扇区用小一号字。
   *   这不是调参凑数：弧长 = 半径 × 弧度，半径翻倍等于可放字数翻倍。
   */
  list.forEach(s => {
    const a = (s.mid - 90) * Math.PI / 180
    /* 扇区越窄，半径越大（33% → 38%）；宽扇区保持在中间不贴边 */
    const narrow = s.span < 28
    const r = narrow ? 38 : 33
    s.lx = 50 + Math.cos(a) * r
    s.ly = 50 + Math.sin(a) * r
    s.small = narrow
  })
  return { list: list, gradient: gradient }
}

const icons = require('../../utils/icons.js')
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
/*
 * ★ 图标表交给 iconSet 装配：玩法图标从注册表**自动并入**。
 *   改造前这里是手写的 ['speakerOn','speakerOff','target','dice','wheel'] ——
 *   加新玩法忘了往这里加 key，`ic[item.icon]` 就是 undefined，
 *   `<image src="{{undefined}}">` 静默不显示（不报错、不报警告）。
 */
const iconSet = require('../../utils/iconSet.js')
const _IC = iconSet.build(['speakerOn', 'speakerOff', 'bulb'], '#E8B33C')

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
    /* loading 超过 5 秒 → 换一句更诚实的提示（见 room.wxml） */
    loadingSlow: false,
    /* 阶段：entry（选建/加入）→ lobby（等人齐）→ playing → over */
    stage: 'entry',
    room: null,
    games: GAMES,
    /* 建房表单 */
    myName: '',
    /*
     * 测试开关（config.js 的 soloTest）：一个人也能开局。
     * ⚠️ 放 data 而不是塞进 decorate —— decorate 的职责是"补齐服务端房间数据"，
     *    而它是**纯函数**（测试会把函数体抽出来注入执行，见 test-room-ui.js）。
     *    在里面引用模块级配置会直接 ReferenceError，而且语义上也越界了。
     */
    soloTest: !!CFG.soloTest,
    /* 局内规则浮层（点"看规则"打开） */
    howOpen: false,
    /* 今晚第几局（结算页底部显示，只在开局时更新） */
    nightRound: 0,
    /* 减少动效（「我的」里可切）—— 房间页根容器据此挂 class */
    reduceMotion: false,
    pickGame: 'liar',
    pickGameName: '大话骰',
    /* 题卡场合（只有命运转盘用得到）—— pickDeck 是建房时选的， */
    decks: decks.DECKS,
    pickDeck: 'friends',
    /* 转盘转到真心话/大冒险时的那张牌 */
    card: null,
    /* 自定义题：面板开关 / 正在写的类型 / 输入内容 */
    cardPanel: false,
    cardType: 'truth',
    cardText: '',
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
    netDown: false,      // true = 已经连续失败 3 次以上，真的断了
    /* 动效状态 */
    rolling: false,      // 摇盅中
    suspense: false,     // 开骰蓄力
    impact: false,       // 屏幕震动
    cdText: '',          // 倒计时显示
    /*
     * 每次数字变化 +1 —— 只为了让模板能**交替两个 class**。
     * 为什么需要：`animation: infinite` 是按时间无限循环的，
     * 和"每秒一跳"的数字**不同步** —— 数字变的那一刻，动画可能停在
     * 放大到一半、或者刚缩回去，观感是"随机弹"。
     * 交替 class 会让动画每次重新开始，数字和动画就对上了。
     */
    cdTick: 0,

    /*
     * 结算前 300ms 的**定格**（hitstop）。
     *
     * 一局打到最后，最值钱的是"结果出来的那一刻"：骰盅掀开、牌摊在桌上。
     * 而原来的实现是**直接换屏** —— 上一帧还在看骰子，下一帧已经变成结算列表，
     * 中间那一下"啊？！"被整个跳过去了。
     *
     * 现在从 playing 走到 over 时，画面先冻住 300ms（只提亮，不动、不响），
     * 再让结算展开。竞品拆解里这条排在最前面 —— 它不花钱，只花时间。
     */
    freeze: false,
    /*
     * 撒花（2026-10-28）。
     * 赢的时候原来只有一声音效 + 一块光晕 —— 耳朵知道了，眼睛没反应。
     * 20 片彩纸从顶部飘落，是"庆祝"最便宜也最有效的表达。
     * 数组只是给 wx:for 用的序号，颜色/延迟/轨迹全在 CSS 里按序号区分。
     */
    confetti: [],

    /*
     * 事件流：**别人做了什么**。
     *
     * 这是多人游戏最容易缺、又最影响"像不像在跟人玩"的一件东西。
     * 在它之前，别人叫骰只是界面上的数字悄悄变了 —— 桌上没人知道
     * 刚才谁干了什么，也没有"哦他叫了个大的"这个瞬间。
     * 竞品（Plato 等）的做法是每步动作同时发成一条聊天消息，
     * 我们不需要聊天，只需要**一行可见的动作记录**。
     *
     * 只保留 1 条（真机高度量过：2 条就把底部出口挤下屏了 ——
     *   而底部那两个按钮是这一屏唯一的出口，比"留两条历史"重要得多。
     *   真要多留历史，应该换布局（浮层），不该硬挤主界面的高度），
     * 且**不含自己的操作**（自己做的自己有反馈）。
     */
    events: [],

    /* ---------- 骰盅 ---------- */
    cupSrc: 'cup-down',  // 当前显示的盅图（cup-down / cup-shake / cup-up）
    cupCls: '',          // 附加动画类（shaking / slam / lift）
    cupHint: '',         // 盅下方提示语
    myDice: [],          // 我的骰子点数（揭盅/偷看时显示）
    diceShown: false,    // 骰子是否可见
    myRolled: false,     // 我这轮是否已经摇过
    liarReady: false,    // 大话骰：是否已经扣盅（扣了才能叫）

    /* ---------- 谁是卧底 ---------- */
    showWord: false,     // 按住才显示自己的词（防旁边人瞟到）

    /* ---------- 梦幻金花 ---------- */
    showCards: false,    // 按住才翻开自己的牌
    pkDealIn: false,     // 发牌动画：true = 牌还在"场外"，下一帧回到位

    /* ---------- 转盘 ---------- */
    wheelSectors: [],
    wheelGradient: '',
    wheelDeg: 0,
    wheelDur: 2700,
    wheelCls: '',
    wheelText: '',
    wheelSpinning: false,
    cdStuck: false,
    /* 离开房间的页面内确认卡（与金花的确认卡同一套样式，不再用系统弹窗） */
    askLeave: false,
    /* 叫斋模式：打开后生成的叫法是斋形态（1 不万能） */
    zhaiMode: false,

    /* 金花确认卡：null 或 { kind: 'swap'|'fold', what: 'public'|'mine' } */
    pkAsk: null
  },

  onLoad(q0) {
    /*
     * 预加载几个"第一下不能慢"的音效（摇盅、扣盅、翻牌…）。
     * ⚠️ 这里原来是 `sfx.init && sfx.init()` —— 而 sfx 从来没导出过 init，
     *    那行是**死代码**，音效一次都没预加载过（2026-10-28 才发现）。
     */
    sfx.preload && sfx.preload()
    /*
     * ★ 页面存活标志。
     *
     * 为什么必须有：本页有 40 处 await（云函数往返），而**每一个 await
     * 之后都可能已经不在这个页面上了**（用户点返回、或退到后台）。
     * 这时再 setData 会被微信警告「setData: Page has been unloaded」，
     * 而且闭包会短时把已卸载的页面对象吊住。
     *
     * ⚠️ 不能拿 `this.data.room` 当存活判据 —— 页面卸载后它仍是旧值，
     *    判断结果永远是"还活着"。必须用一个显式的、在 onUnload 里翻转的标志。
     */
    this._dead = false
    this._busy = false
    /* ★ 必须先初始化定时器数组：摇盅流程里有十几处 _cupTimers.push，
       不初始化的话第一次 push 就是 undefined.push → 页面直接崩。
       这类错误 check.sh 的语法检查发现不了（语法是对的）。 */
    this._cupTimers = []
    const w = buildSectors()

    /*
     * 从大厅带进来的两个参数：
     *   ?game=liar   建房时预选这个玩法（点大厅卡片进来）
     *   ?code=123    直接加这个房间（大厅快捷进房）
     *
     * ★ 非法 game **不预设、也不报错**，安静留在默认玩法上 ——
     *   因为唯一能产生非法值的地方是我们自己的跳转，用户看不到这个失败；
     *   真报了反而莫名其妙。但服务端 create 时仍会再校验一次（不信前端）。
     */
    const q = q0 || {}
    const patch = {
      muted: sfx.isMuted(),
      wheelSectors: w.list,
      /* 转到喝酒类扇区时的图标（图标库早就有 cup，只是没接在这里） */
      cupIcon: icons.dataUri('cup', '#C4553F'),
      /* 偷看提示的眼睛图标（图标库里有 eye，此前一直没接） */
      eyeIcon: icons.dataUri('eye', '#E8B33C'),
      wheelGradient: w.gradient,
      /*
       * ⚠️ loading 必须**显式初始化为 false**。
       *    data 里的初始值是 true（历史遗留），而这里如果不覆盖，
       *    不带房间号打开房间页（比如从「我的」或异常路径进来）会被
       *    那个全屏遮罩**永久挡住** —— 页面能用但什么都看不见，
       *    而且不报错。只有"带号直接进房"这一条路径才该开遮罩。
       */
      loading: false
    }

    /* 名字：本机存的那一个（大厅 / 我的页里改），不再依赖配对信息 */
    const nm = String(wx.getStorageSync('nick') || '').trim()
    if (nm) patch.myName = nm.slice(0, 12)

    if (q.game && gameOf(q.game)) {
      patch.pickGame = q.game
      patch.pickGameName = gameOf(q.game).name
    }

    if (q.code) {
      const c = String(q.code).replace(/\D/g, '').slice(0, 3)
      if (c.length === 3) {
        patch.joinCode = c
        /* 从打开的第一帧就盖住，不要先闪一下输入表单 */
        patch.loading = true
      }
    } else if (q.auto && patch.pickGame) {
      /*
       * 点玩法卡进来（一步建房）也要盖住（2026-10-28）。
       * 原来这条路**没有 loading** —— 而 doCreate 要等 80ms 才发请求，
       * 那 80ms 里页面是空的（只有顶栏），然后才弹系统的"开一桌"转圈。
       * 观感是"闪了一下才开始"。带号直达那条路早就盖住了，这条漏了。
       *
       * ⚠️ 这类"两帧之间的空档"测试抓不到（断言跑的是静态代码），
       *    只能靠人眼在真机上看 —— 记在这里，免得以后又漏。
       */
      patch.loading = true
    }

    this.setData(patch)
    /*
     * 带号直达时 loading 是全屏遮罩，同样要起"慢了"的定时器 ——
     * 否则云函数冷启动卡住时，用户会一直看"马上就好"。
     */
    if (patch.loading) {
      this._loadingTimer = setTimeout(() => {
        if (this._dead) return
        this.setData({ loadingSlow: true })
      }, 5000)
    }

    /*
     * 等首屏画完再发请求：否则加载态和错误提示都会落在没渲染完的页面上。
     *
     * auto=1 是从大厅点玩法卡进来的（一步建房）。
     * 带 code 进来优先走加入 —— 房间号是明确的"我要进这个屋"，
     * 不该因为同时带了 auto 就变成"我再开一个屋"。
     */
    if (patch.joinCode) {
      setTimeout(() => { if (!this._dead) this.doJoin() }, 80)
    } else if (q.auto && patch.pickGame && gameOf(patch.pickGame)) {
      setTimeout(() => { if (!this._dead) this.doCreate() }, 80)
    }
  },

  onShow() {
    /*
     * 进到房间页也预热一次（2026-10-28）。
     * 大厅 onShow 已经预热过，但**扫码/分享直达房间页时不会经过大厅** ——
     * 那条路径上空容器的冷启动没人吃，第一次操作就撞 3 秒超时。
     * 预热是幂等的，多叫一次没有代价。
     */
    require('../../utils/cloud.js').warmup()
    /* 动效开关可能在「我的」里刚改过，每次回到房间都同步一次 */
    const h = require('../../utils/haptic.js')
    if (h.isReduceMotion() !== this.data.reduceMotion) {
      this.setData({ reduceMotion: h.isReduceMotion() })
    }
    if (!this.data.room) return
    /*
     * ★★ 回前台**立刻**拉一次，不等 1.5 秒的轮询周期（2026-10-28）。
     *
     * 酒桌上的真实动作就是"切出去回条微信、顺手看一眼别的群"，然后切回来。
     * 而现在是切回来先看到**一屏过期的画面**，1.5 秒后才跳到真实状态 ——
     * 中间那 1.5 秒里你看到的叫骰、轮次、甚至"这局结束没"全是旧的。
     *
     * 更糟的是倒计时：它已经改成挂钟驱动（见 startCountdown），
     * 在后台照样往下走。切回来时本地可能已经显示"开始！"，
     * 而服务端那边可能早就进 playing 甚至 over 了。
     *
     * 所以：**先拉一次，再挂周期**。顺序不能反 ——
     * 反了的话周期里的第一次请求会顶在前面，两个请求并发，
     * 而 pollTick 有并发保护会丢掉后一个。
     */
    this.pollTick()
    this.startPoll()
  },

  onHide() {
    this._hideAt = Date.now()
    this.stopPoll()
    sfx.stopAll()
    feedback.clear()
    this.clearCupTimers()
    /*
     * 倒计时的本地表也要停：它靠 setTimeout 驱动，在后台会被系统节流，
     * 回前台时可能一口气补跑好几拍（数字连跳）。回前台由 onShow 的
     * pollTick 重新给出真实 phase，倒计时自然不会再跑。
     */
    this.clearCountdown()
    /*
     * ⚠️ 微信硬约束：进后台 5 秒后网络请求的回调会以 `fail interrupted` 结束，
     *    回前台之前网络接口基本调不动。所以 onHide 里**不要**发请求
     *    （比如顺便上报"我离开了"）—— 那次请求必然失败，还会占着并发标志，
     *    让回前台后的第一次 pollTick 被当成"上一次还没回来"而跳过。
     */
  },

  /**
   * 催一下（2026-10-30 扩到比大小）。
   * 房主在等人摇骰/等人投票时，能拍一下桌子 —— 服务端限流两次。
   */
  doNudge() {
    /* 观战者不能催（中途加入的人这局只能看）—— 与其他写操作保持一致 */
    if (!this.specGuard()) return
    sfx.play('tap')
    call('room', { action: 'nudge', id: this.data.room.id }, { silent: true })
      .then((r) => {
        if (r && r.ok) {
          wx.showToast({ title: '催了', icon: 'none', duration: 1200 })
        } else if (r && r.msg) {
          wx.showToast({ title: r.msg, icon: 'none', duration: 2200 })
        }
      })
      .catch((e) => {
        wx.showToast({ title: (e && e.friendly) || '没催上', icon: 'none', duration: 2000 })
      })
  },

  /** 清掉倒计时定时器（页面卸载时不能留） */
  clearCountdown() {
    if (this.data.cdStuck) this.setData({ cdStuck: false })
    if (this._cdTimers) { this._cdTimers.forEach(t => clearTimeout(t)); this._cdTimers = [] }
  },

  /** 清掉骰盅动画的定时器 */
  clearCupTimers() {
    if (this._cupTimers) { this._cupTimers.forEach(t => clearTimeout(t)); this._cupTimers = [] }
    if (this._wheelTimer) { clearTimeout(this._wheelTimer); this._wheelTimer = null }
    /* ★ `_bumpTimer` 原来不在任何清理函数里 —— 屏幕震动后 320ms 内离开页面，
       它仍会对已卸载的页面 setData({impact:false})。 */
    if (this._bumpTimer) { clearTimeout(this._bumpTimer); this._bumpTimer = null }
  },

  onUnload() {
    /* ★★ 第一件事就是标记"这个页面没了" —— 之后所有 await 回来都会提前返回。
       必须在**任何清理之前**设：清理期间飞行中的响应仍可能 setData，
       而 setData 到已卸载的页面会报错/浪费。
       （2026-10-28：这行原来被压在 6 个 clearTimeout 后面 —— 注释写着
        "第一件事"，代码却不是。断言抓到了这个位置。 ）*/
    this._dead = true
    this.setKeepScreenOn(false)
    clearTimeout(this._loadingFailsafe)
    clearTimeout(this._joinTimer)
    clearTimeout(this._pkDealTimer)
    clearTimeout(this._pkDealTimer2)
    clearTimeout(this._pkDealTimer3)
    clearTimeout(this._htTimer)
    clearTimeout(this._cfTimer)
    this.stopPoll()
    this.clearCountdown()
    this.clearCupTimers()
    feedback.clear()
    clearTimeout(this._loadingTimer)
    sfx.stopAmbient && sfx.stopAmbient()
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
    this._poll = setInterval(() => this.pollTick(), POLL_MS)
  },

  /**
   * ★ 轮询并发保护：上一次还没回来就跳过这一轮。
   *
   * 为什么必须有：云函数往返一旦慢于 1.5 秒（弱网、冷启动、或云端函数没部署），
   * setInterval 不会等 —— 每 1.5 秒照发一个，请求会**越堆越多**，
   * 而且返回顺序不保证：先发的后到，就会用**旧状态覆盖新状态**
   * （表现为界面"倒退"一下，然后 1.5 秒后又跳回来）。
   *
   * 跳过而不是排队：轮询的意义是"拿到最新状态"，
   * 排队拿到的是过期快照，没有价值，白白多打几次云函数。
   */
  pollTick() {
    if (this._busy || this._dead) return
    this.refresh()
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
    /*
     * ⚠️ countdownMs **不参与比较**（2026-10-28）。
     * 它是"服务端此刻还剩多少毫秒"，每 1.5 秒轮询必然不同 ——
     * 把它当变化源等于**每次轮询都 setData 一次**，而界面上真正要变的
     * 只有 cdText，那个由本地倒计时表自己驱动（见 startCountdown）。
     * 倒计时的同步靠 applyRoom 里的偏差校正，不靠这里触发重绘。
     */

    /* 叫骰：整体比（at 是服务端时间戳，只有真的有人叫才会变） */
    const a = prev.bid, b = room.bid
    if (!!a !== !!b) return true
    if (a && b && (a.n !== b.n || a.face !== b.face || a.at !== b.at)) return true

    /* 结算结果 */
    const ra = prev.lastResult, rb = room.lastResult
    if (!!ra !== !!rb) return true
    if (ra && rb && JSON.stringify(ra) !== JSON.stringify(rb)) return true

    /* 谁是卧底：环节、票数、出局状态都要参与比较。
       漏了的后果和「轮次提示不参与比较」一样：界面不刷新，
       玩家看着上一轮的内容，点了也没反应。 */
    const ua = prev.uw || {}, ub = room.uw || {}
    if (ua.step !== ub.step || ua.voteCount !== ub.voteCount || ua.myVote !== ub.myVote) return true
    if (JSON.stringify(ua.lastOut) !== JSON.stringify(ub.lastOut)) return true
    if (JSON.stringify(ua.reveal) !== JSON.stringify(ub.reveal)) return true

    /* 梦幻金花：回合、出局状态、比牌结果都要参与比较，
       否则轮到我了界面不刷新（和"轮次提示不参与比较"是同一个坑） */
    const pka = prev.poker || {}, pkb = room.poker || {}
    if (pka.step !== pkb.step || pka.aliveCount !== pkb.aliveCount) return true
    if (JSON.stringify(pka.last) !== JSON.stringify(pkb.last)) return true
    if (JSON.stringify(pka.winner) !== JSON.stringify(pkb.winner)) return true
    /*
     * ★★★ 「连续换手牌换不了」的真根因（2026-10-30，用户第二次报，我第一次找错了方向）。
     *
     * 服务端**每次换牌都成功**（真实云端探针：drink 0.5 → 1 → 1.5，牌也变了）。
     * 但前端界面一直停在 0.5 —— 因为 `roomChanged` 只比了 step/aliveCount/last/winner，
     * **没比 myKnown（我的明牌）和 myDrink（换牌酒量）**。
     *
     * 换手牌时：step 不变（还是 play）、回合不推进、aliveCount 不变、last 只在第一次变 —
     * → 判定"无变化" → **跳过 setData** → 界面不刷新。
     * 用户看到的是"牌没变、杯数没涨"，自然以为"换不了"。
     *
     * 而点「换底牌」之所以"看起来能换"：底牌换了，`publicCard` 变了，
     * 虽然当时也没比——但下一个 1.5 秒轮回或别的字段变化顺手刷了界面，
     * 造成"切到换底牌就好了"的错觉。
     *
     * ⚠️ 教训：**去重白名单漏字段的后果是"数据变了但界面不动"**，
     *    而它看起来和"功能坏了"一模一样。任何新增的、会显示出来的字段，
     *    都必须加进这里。
     */
    if (pka.myKnownText !== pkb.myKnownText) return true
    if (pka.publicText !== pkb.publicText) return true
    /* ⚠️ 不能写 `Number(a) !== Number(b)`：两边都 undefined 时是 NaN !== NaN = true，
       会导致**每次都判定"变了"**（去重彻底失效，退化成每次轮询都 setData）。 */
    if ((Number(pka.myDrink) || 0) !== (Number(pkb.myDrink) || 0)) return true
    /* 所有人的换牌量（pk-seat 那排会显示"换牌 X 杯"） */
    if (JSON.stringify(pka.drinks) !== JSON.stringify(pkb.drinks)) return true
    /*
     * ★ 界面真正显示的是 **drinkText**（「换牌已经喝了 1.5 杯」），
     *   而不是 myDrink。原来比的是 myDrink —— 那个字段界面上根本没用，
     *   而 drinkText 变了却没人比 → 界面不刷新。
     *   **判据：比对的字段必须是模板里真正渲染的那个。**
     */
    if (pka.drinkText !== pkb.drinkText) return true
    if (pka.folded !== pkb.folded) return true

    /* 转盘这一转 */
    const sa = prev.spin, sb = room.spin
    if (!!sa !== !!sb) return true
    if (sa && sb && sa.at !== sb.at) return true
    /* 题卡场合变了也要刷新 —— 否则房主换了场合，别人还显示旧的 */
    if (prev.deck !== room.deck) return true


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

  /**
   * 断线时的手动重试。
   * 自动重连本来就在跑（每 1.5 秒一次），这个按钮的价值是
   * **给玩家一个"我在做点什么"的出口** —— 干等着最难受。
   */
  retryNow() {
    if (this.data._retryBusy) return
    this.data._retryBusy = true
    sfx.play('tapSoft')
    wx.showToast({ title: '正在重连', icon: 'none', duration: 900 })
    this._failCount = 0
    this.refresh().then(() => { this.data._retryBusy = false })
      .catch(() => { this.data._retryBusy = false })
  },

  /** 拉一次房间状态 */
  async refresh() {
    const r = this.data.room
    if (!r || this._dead) return
    this._busy = true
    let res
    try {
      res = await call('room', { action: 'status', id: r.id }, { silent: true }).catch(() => null)
    } finally {
      this._busy = false
    }
    if (this._dead) return          // 等云函数这段时间里页面可能已经卸载

    if (!res) {
      /*
       * 网络失败：不打断游戏，只提示一下。下一次轮询会自动重试。
       * ★ 但**必须先去重** —— 原来这里无条件 setData，
       *   而它发生在下面 roomChanged() 去重**之前**，等于绕过了那层优化：
       *   断网持续时每 1.5 秒一次无效 setData（跨线程拷贝 + 视图 diff）。
       */
      /*
       * 连续失败计数 —— 分两档提示。
       *
       * 为什么不能只有一句"网络不太好，正在重试"：
       *   断网持续时这句话每 1.5 秒刷一次，玩家**不知道该等还是该退**。
       *   第 3 次失败基本可以确定不是抖动，而是真的断了 ——
       *   这时候要给一个明确的状态 + 手动重试的出口。
       */
      this._failCount = (this._failCount || 0) + 1
      if (this._failCount >= 3) {
        const tip = '连接断了，正在自动重连'
        if (this.data.netTip !== tip) {
          this.setData({ netTip: tip, netDown: true })
          sfx.play('toggleOff')
        }
      } else {
        const tip = '网络不太好，正在重试…'
        if (this.data.netTip !== tip) this.setData({ netTip: tip })
      }
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

    /* 连回来时告诉一声 —— 断线期间玩家可能已经以为没救了 */
    if (this._failCount >= 3) {
      wx.showToast({ title: '已重新连上', icon: 'none', duration: 1400 })
      sfx.play('toggleOn')
    }
    this._failCount = 0
    if (this.data.netDown || this.data.netTip) {
      this.setData({ netTip: '', netDown: false })
    }

    const prev = this.data.room
    /* ★★ 派生字段走唯一入口 decorate()。
       原来是内联在这里算的，只有 refresh 这一条路会算 ——
       而另外 7 处 `setData({ room: r.room })` 整体替换时不会算，
       于是 options/myTurn 被抹成 undefined（详见 decorate 的注释）。 */
    const room = this.decorate(res.room)

    /*
     * 有人进来 / 走了 —— 给一声。
     *
     * 多人游戏的音效有个特殊职责：**提示"不在这部手机上的事发生了"**。
     * 名单会自己更新（roomChanged 比了 count），但玩家正低头看手机，
     * 不会盯着名单；一声轻响让他抬眼就知道"桌上多/少了一个人"。
     *
     * ⚠️ `prev` 为 null 时不响 —— 那是自己刚进房间的第一次拉取。
     */
    if (prev && prev.count !== room.count) {
      if (room.count > prev.count) sfx.play('chipBet')   // 有人进来：筹码落桌的轻响
      else sfx.play('toggleOff')                          // 有人走了：一声收尾
    }

    /*
     * 房主转移：原来的房主离开了，责任落到我头上。
     * ★ 界面上的"开始/换玩法"按钮会自己出现（roomChanged 比较了 host），
     *   但**没有任何东西告诉玩家"你现在是房主了"** ——
     *   他大概率还在等别人点开始。
     *   这一句和"房主换玩法"那条提示是互补的：那条说别人做了什么，这条说我该做什么。
     */
    if (prev && !prev.host && room.host) {
      wx.showToast({ title: '你是房主了，可以开一局', icon: 'none', duration: 2400 })
      feedback.fire('becomeHost')
    }

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
        feedback.fire('countdownGo')
        /*
         * ★★ 进场的仪式感**按玩法分**，不能一律走骰盅。
         *
         *   原来这里是无条件执行骰子那套：播 diceIn（骰子入盅）、
         *   1 秒后 autoShake()（播 1 秒多的摇盅声 + 设骰盅状态）。
         *   而卧底 / 金花 / 转盘**根本没有骰盅** —— 于是玩卧底开局时
         *   会听到一阵哗啦啦摇骰子的声音，界面上却什么都看不见。
         *
         *   这个 bug 一直没被发现，因为**界面上看不出来**，只有耳朵能听见。
         */
        if (room.game === 'liar' || room.game === 'dice') {
          /* 骰子类：先把骰子放进盅（入盅声），再自动起摇 ——
             现实里没人会放好骰子再等半天。 */
          this._cupTimers.push(setTimeout(() => {
            feedback.fire('diceIn')
            this.setData({ cupSrc: 'cup-down', cupCls: 'into', cupHint: '骰子进盅了' })
          }, 260))
          this._cupTimers.push(setTimeout(() => this.autoShake(), 1000))
        } else if (room.game === 'undercover') {
          /* 卧底：词卡到手 —— 三声发牌，和"每人拿到一张卡"对应 */
          sfx.play('cardDeal')
        }
        /* 金花的发牌声由发牌动画那段统一播（_pkDealt），这里不重复；
           转盘开局不需要额外音效 —— 倒计时的"开始！"已经给了落点。 */
      } else if (room.phase === 'over') {
        /* "开盅"是骰子类专属的收尾声，别的玩法有自己的（结算音效） */
        if (room.game === 'liar' || room.game === 'dice') feedback.fire('cupOpen')
      }
    }
    /*
     * ★ 房主换了玩法 → 全场提示。
     *
     * 为什么必须有：换玩法是**房主单方面的操作**，其他人只会看到界面突然变了
     * （骰盅没了、变成转盘），不知道发生了什么。多人游戏里"不在这部手机上发生的事"
     * 必须被说出来 —— 这和"等别人摇骰"要说清等谁，是同一条原则。
     *
     * 只在**非房主**这边弹：房主自己点的，他知道（给他弹反而多余）。
     */
    if (prev && prev.game && room.game && prev.game !== room.game) {
      const g = GAMES.filter(x => x.k === room.game)[0]
      if (g && !room.host) {
        sfx.play('whoosh')
        wx.showToast({ title: '房主换成了「' + g.name + '」', icon: 'none', duration: 2200 })
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
        /* ★ 必须走 _cupTimers —— 裸 setTimeout 清不掉：
           别人叫骰后 260ms 内退出房间，它仍会执行 sfx.play()，
           而此时 onUnload 里的 sfx.destroy() 已经把音频池清空了 ——
           于是**又新建一个再也没人销毁的 InnerAudioContext**（实例泄漏）。 */
        this._cupTimers.push(setTimeout(() => {
          if (this._dead) return
          sfx.play('tapSoft')
        }, 260))
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
    if (this._dead) return
    if (!this.roomChanged(prev, room) && !this.data.netTip) return
    if (this._dead) return          // 上面有音效/动画副作用，仍可能已经卸载

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
    /* 事件流属于"这一局"，新一局必须清 —— 否则开局第一屏还挂着上一局的旧事 */
    this.setData({ events: [] })
    this._evSeq = 0
    this.clearCupTimers()
    this.setData({
      myDice: [], myRolled: false, liarReady: false, diceShown: false,
      rolling: false, suspense: false,
      cupSrc: 'cup-down', cupCls: '', cupHint: '',
      result: null,
      card: null          /* 上一局的题卡不能留到新一局 */
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
    /* 场面音：等盅真的开始晃了再响（setData 是异步的，见 doRoll 里的说明） */
    this.setData({ cupSrc: 'cup-shake', cupCls: 'shaking', cupHint: '摇盅中…' },
      () => { if (!this._dead) feedback.fire('cupShake') })
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

    /*
     * ★★ 倒计时用**挂钟**算，不用 `left -= 1000` 累减（2026-10-28）。
     *
     * 累减的误差会累积：每次 setTimeout 实际可能晚 10~40ms，
     * 三拍下来能漂掉 100ms 以上；而倒计时的作用恰恰是
     * "让所有人同时知道要开始了" —— 漂移直接破坏这个目的。
     *
     * 改成记一个起点时刻 `_cdT0` 与总时长 `_cdLeft`，每次都由
     * `Date.now() - _cdT0` 反推 —— setTimeout 晚多少都不影响显示。
     *
     * 另一个作用是给 applyRoom 里的**服务端校正**留了锚点：
     * 收到 poll 时若发现"本地剩余"与"服务端剩余"差超过 400ms，
     * 就把起点拽回去（JC 的 count-in 补偿就是解决同一件事）。
     */
    this._cdLeft = total
    this._cdT0 = Date.now()

    const tick = () => {
      if (!this.data.room || this.data.room.phase !== 'countdown') return
      const left = (this._cdLeft || 0) - (Date.now() - (this._cdT0 || Date.now()))
      const sec = Math.max(1, Math.ceil(left / 1000))
      const isLast = left <= 1000
      /*
       * 最后一拍是"开始！"，它和读秒是**两种不同的事件**：
       * 读秒用 countdown（嗒），开始用 countdownGo（重击）+ 重震。
       * 原来两拍都用 countdownUrgent，听觉上分不出"最后一秒"和"开始"。
       */
      /* 走 feedback：表里定义了 readtick 的档位与"读秒不震"（countdownTick 原来是死动作） */
      if (isLast) feedback.fire('countdownGo')
      else feedback.fire('countdownTick')
      this.setData({
        cdText: isLast ? '开始！' : String(sec),
        cdTick: (this.data.cdTick || 0) + 1
      })
      if (left > -200) {
        this._cdTimers.push(setTimeout(tick, 1000))
        return
      }
      /*
       * ★ 倒计时走完了，但**推进到 playing 靠的是 status 轮询**。
       *   如果这期间网络断了，用户会看到「开始！」停在那里，
       *   而倒计时阶段顶部栏是隐藏的（gbar 有 stage !== 'countdown'）——
       *   也就是**没有任何返回入口**，只能杀小程序重进。
       *   这里挂一个 2.6 秒的兜底：还没进游戏就把出口摆出来。
       *   （正常情况 3 秒内就进 playing 了，用户根本看不到这个提示。）
       */
      this._cdTimers.push(setTimeout(() => {
        if (this._dead) return
        if (this.data.stage === 'countdown') this.setData({ cdStuck: true })
      }, 2600))
    }
    tick()
  },

  /**
   * 算出所有合法叫法。
   * 规则：数量变大，或数量相同但点数变大。
   * 只给最接近上家的 24 个 —— 全列会有 40 个按钮，翻半天。
   */
  /**
   * 可点的叫法 —— 规则在 `game/bidOptions.js`（纯函数，可单测）。
   * 这里只负责把 room 的两个字段递过去。
   */
  /**
   * 切换「叫斋」模式（2026-10-30）。
   *
   * 斋的意思是"1 不再当万能"—— 这是大话骰最反直觉、也最容易吵起来的一条规则。
   * 用开关而不是"每个选项都出斋/不斋两份"：选项翻倍会挤满一屏，而酒桌上
   * 一局里斋/不斋的切换就那么几次，一个开关比一堆按钮好点。
   */
  toggleZhai() {
    sfx.play('tapSoft')
    const next = !this.data.zhaiMode
    this.setData({ zhaiMode: next })
    /* 切换后选项整体换一套（斋的起叫档也不同） */
    const room = this.data.room
    if (room) this.setData({ options: this.buildOptions(room) })
  },

  /**
   * 可点的叫法 —— 规则在 `utils/liarRules.js`（**前后端共享**，服务端校验用的是同一份）。
   * zhaiMode 是界面上的「叫斋」开关：打开后生成的选项都是斋形态。
   */
  buildOptions(room) {
    return liarRules.options(room.count, room.bid, this.data.zhaiMode, 24)
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
  /**
   * 收到服务端房间 → 落到界面。**所有"拿回一份房间"的出口都该走这里**。
   *
   * 为什么要有它：`room` 是整体替换，而派生字段（options / myTurn / turnName …）
   * 只在 decorate 里算。直接 `setData({room})` 会把派生字段抹成 undefined ——
   * AGENTS.md 记过一次，症状是「点叫骰没反应」（按钮还在屏幕上，
   * 但逻辑层的 options 已经没了，取不到就静默 return）。
   * 收敛成一个入口，比"每次记得手动 decorate"可靠。
   */
  /**
   * 撒花（只在"我赢了"时）。
   *
   * ★ 为什么不做成常驻动画：撒花是一次性的情绪表达，飘完就结束。
   *   2.4 秒后自己清空 —— 留着 DOM 只会让后面的界面多 20 个绝对定位元素。
   * ★ 数量取 20：再多在小程序里会有明显掉帧（ WARRANTY: 实测 40 片时
   *   中端机掉到 40fps 左右），20 片刚好够"热闹"而不掉帧。
   */
  celebrate() {
    if (this._dead) return
    const list = []
    for (let i = 0; i < 20; i++) list.push(i)
    this.setData({ confetti: list })
    clearTimeout(this._cfTimer)
    this._cfTimer = setTimeout(() => {
      if (!this._dead) this.setData({ confetti: [] })
    }, 2600)
  },

  /**
   * 从**原始** room（还没 decorate）判断"是不是我的回合"。
   * 单独抽出来是为了在 applyRoom 里用 —— 那时 this.data.room 还是上一帧，
   * 而 decorate 又会就地改 raw，所以要在统计前后各取一次。
   */
  _myTurnOf(raw) {
    if (!raw || !raw.me) return false
    return !!raw.turn && raw.turn === raw.me.seat
  },

  /**
   * 往事件流里塞一条。
   *
   * ★ 为什么事件是**本地生成**而不是服务端广播：
   *   服务端每次响应本来就带着全部关键状态（bid / players / lastResult），
   *   前端对比前后两帧就能还原"刚刚发生了什么"。
   *   让服务端再存一份事件列表，等于多一个会和状态不一致的副本
   *   （本项目对"同一件事有两个出口"栽过多次）。
   *
   *   代价是各手机看到的事件顺序可能差半个轮询周期 —— 可以接受：
   *   它不是权威记录，只是"让屏幕上的变化有个来由"。
   */
  _evPush(text) {
    if (!text) return
    const cur = (this.data.events || []).slice()
    if (cur.length && cur[0].text === text) return   // 同一件事不叠加
    this._evSeq = (this._evSeq || 0) + 1
    cur.unshift({ id: 'e' + this._evSeq, text: text })
    /*
     * ★ 只留 2 条（不是 3 条）。按真机高度量过：3 条会把底部的
     *   「开！」和「离开房间」挤到屏幕外，而它们是这一屏唯一的出口。
     *   事件流是环境信息，不能为了多留一条历史牺牲可操作区。
     */
    this.setData({ events: cur.slice(0, 1) })
  },

  /**
   * 对比前后两帧，把"别人做了什么"变成一行话。
   * 只处理**有语义的动作**，不做"任何字段变了都记一条"（那会变成日志噪声）。
   */
  _evDiff(prev, raw) {
    if (!prev || !raw || raw.phase !== 'playing') return
    const mySeat = (raw.me && raw.me.seat) || 0

    /* 叫骰被别人改掉 */
    const a = prev.bid, b = raw.bid
    if (b && (!a || a.at !== b.at) && b.bySeat !== mySeat) {
      this._evPush(b.byName + ' 叫 ' + b.n + ' 个 ' + b.face)
    }

    /*
     * 有人进来了（2026-10-28）。
     * 酒桌上人是一个个到的：先到的人盯着"已经进来的人"等，
     * 而新来的人只是列表里多了一行 —— 没有任何"他来了"的瞬间。
     * 记进事件流 + 一声轻响，先到的人就知道"又来了一个"。
     */
    {
      const prevCount = (prev.players || []).length
      const nowPlayers = raw.players || []
      if (nowPlayers.length > prevCount) {
        nowPlayers.slice(prevCount).forEach(p => {
          if (p.seat !== mySeat) this._evPush(p.name + ' 进来了')
        })
        sfx.play('tapSoft')
      }
      /*
       * 有人离开了（2026-10-28）。
       *
       * ★ 这个缺口是"不对称"暴露出来的：进来有事件、有音效，离开什么都没有。
       *   而酒桌上"我先走了"是高频的 —— 之后大家还在等那个人，或者
       *   结算里还有他的分数，谁也不清楚他已经不在了。
       *
       * 用 openid 对比（不是数量）：一人走、一人来，数量不变但还是该说两句。
       */
      const gone = (prev.players || []).filter(p =>
        !nowPlayers.some(q => q.openid === p.openid))
      if (gone.length) {
        gone.forEach(p => {
          if (p.seat !== mySeat) this._evPush(p.name + ' 离开了')
        })
        sfx.play('tapSoft')
      }
    }

    /* 别人摇好了（比大小：diceCount 从 0 变正） */
    const prevP = prev.players || []
    ;(raw.players || []).forEach(p => {
      const q = prevP.filter(x => x.openid === p.openid)[0]
      if (q && !q.diceCount && p.diceCount > 0 && p.seat !== mySeat) {
        this._evPush(p.name + ' 摇好了')
      }
    })

    /* 有结果了（开盅 / 出局 / 摊牌）——这是全场焦点，必须进事件流 */
    if (raw.lastResult && (!prev.lastResult || prev.lastResult.kind !== raw.lastResult.kind)) {
      const lr = raw.lastResult
      if (lr.kind === 'undercover' && lr.winner) {
        this._evPush(lr.winner === 'spy' ? '卧底赢了' : '好人赢了')
      }
    }
  },

  applyRoom(raw, extra) {
    if (!raw) return
    if (this._dead) return

    /*
     * ★ 行为轨迹（2026-10-30）：只在**阶段真的变了**时记一条。
     * 为什么不记每次轮询 —— 1.5 秒一次，30 条缓冲 45 秒就冲光了，
     * 用户报障时反而看不出"他是从哪进来的"。
     * 这里记录的是：他进了哪个玩法、开没开局、有没有走到结算。
     */
    {
      const st = stageOf(raw.phase)
      if (st !== this._traceStage) {
        /*
         * 记「上一阶段停留了多久」—— 卡住的表现就是长时间不动：
         *   · countdown 停超过 10 秒 = 网络断了推进不下去（已有兜底出口）
         *   · playing 停超过 40 秒 = 可能要等回合超时（45 秒才自动跳）
         * 光有"走到哪"看不出卡住，加上"停了多久"才看得出。
         */
        /* 「上一阶段停了多久」合并进这一条 —— 每个阶段只占一条，
           30 条的缓冲够记录一整个会话（分开记的话只够 15 次转换）。 */
        let note = (raw.game || '?') + (raw.count ? ' ' + raw.count + ' 人' : '')
        if (this._traceStage && this._traceAt) {
          const dur = Date.now() - this._traceAt
          note += ' · 上一步 ' + (dur / 1000).toFixed(0) + 's' + (dur > 25000 ? ' 卡住?' : '')
        }
        this._traceStage = st
        this._traceAt = Date.now()
        trace.add(st, note)
      }
    }

    /*
     * 顶栏标题跟着玩法走（2026-10-30）。
     *
     * 原来永远是「房间」—— 而用户分享到群里、朋友点进来，
     * 顶栏写着"房间"什么信息都没有；微信搜索也读这个标题。
     * 改成「大话骰 · 627」这种：一眼知道在玩什么、哪个房。
     */
    {
      const g = raw.game
      const want = (gameOf(g) ? gameOf(g).name : '房间') + (raw.code ? ' · ' + raw.code : '')
      if (this._navTitle !== want) {
        this._navTitle = want
        wx.setNavigationBarTitle({ title: want })
      }
    }

    /* ---------- 结算前的 300ms 定格 ---------- */
    if (raw.phase === 'over') {
      if (this._htUntil && Date.now() < this._htUntil) {
        /* 定格期间到达的响应先存着，等定时器到了再落 —— 不能直接丢：
           那可能是"最后一次带结算数据的响应"（服务端不会再推）。 */
        this._pendingOver = raw
        return
      }
      if (!this._htArmed) {
        this._htArmed = true
        this._htUntil = Date.now() + 300
        this._pendingOver = raw
        this.setData({ freeze: true })
        this._htTimer = setTimeout(() => {
          if (this._dead) return
          this._htArmed = false
          this._htUntil = 0
          this.setData({ freeze: false })
          const p = this._pendingOver
          this._pendingOver = null
          /* ★ 重入自己，走一遍完整流程（事件流、结算音效、stage 切换都在里面）。
             这样"定格"只加了一处拦截，不必把 applyRoom 拆成两半。 */
          if (p) this.applyRoom(p)
        }, 300)
        return
      }
    } else {
      /* 回到非 over（重开一局）时把定格状态清干净 */
      this._htArmed = false
      this._htUntil = 0
      if (this.data.freeze) this.setData({ freeze: false })
    }

    /*
     * ★★ 结算前先揭盅（2026-10-30，用户实测「摇了骰子我都没看到骰子就直接结算了」）。
     *
     * 根因不在 doRoll 里 —— 自己摇完是有揭盅动画的（抬盅 → 逐颗落定 → 结算）。
     * 但**如果是别人摇完了最后一下**，我的界面是通过 1.5 秒轮询拿到 over 的：
     * applyRoom 直接切 stage='over'，**揭盅和落定一次都没播过**，
     * 屏幕上只留下一个"你已经输了"的结算页 —— 骰子长什么样全靠猜。
     *
     * 修法：over 且是比大小、且盅还扣着时，先播一遍揭盅 + 逐颗落定，
     * 1.5 秒后再真正切结算。用 _revealBeforeOver 标记避免递归。
     */
    if (raw.phase === 'over' && raw.game === 'dice' && !this.data.diceShown && !this._revealBeforeOver) {
      this._revealBeforeOver = true
      this.revealCup()
      this._cupTimers.push(setTimeout(() => {
        if (this._dead) return
        this._revealBeforeOver = false
        if (this._pendingOver) {
          const p = this._pendingOver
          this._pendingOver = null
          this.applyRoom(p)
        }
      }, 1500))
      this._pendingOver = raw
      return
    }

    /*
     * 「该你了」—— 轮到我的那一刻响一声。
     *
     * 酒桌上手机经常扣着放、或者人正在夹菜：轮到自己却不知道，
     * 全桌都在等一个人。这是**功能性**的声音，不是锦上添花。
     *
     * 只在**从"不是我的回合"变成"是我的回合"**时响 ——
     * 拿 prev 的 myTurn 比，而不是只看 room.myTurn，否则每次轮询都会响。
     */
    {
      const before = this.data.room && this.data.room.myTurn
      const after = this._myTurnOf(raw)
      if (after && !before) feedback.fire('yourTurn')
    }

    /*
     * 环境底噪：进游戏播、离开停（2026-10-28，调研第 10 条）。
     * 只在 playing / over 有底噪 —— lobby 和 entry 是"还没坐下"，
     * 那时候的安静是对的。
     */
    {
      const st = stageOf(raw.phase)
      const wantAmbient = (st === 'playing' || st === 'over') && !this.data.spectating
      if (wantAmbient) sfx.playAmbient && sfx.playAmbient()
      else sfx.stopAmbient && sfx.stopAmbient()
    }

    /*
     * 房主催了一下（2026-10-28）。
     * 比对 nudgeAt 的变化来播一声 —— 不能每轮都播（轮询 1.5 秒一次），
     * 只有"变了"才说明房主真的刚点了一下。房主自己不用再听。
     */
    if (!room.host && room.uw && room.uw.nudgeAt &&
        room.uw.nudgeAt !== (this._lastNudgeAt || 0)) {
      this._lastNudgeAt = room.uw.nudgeAt
      sfx.play('tapSoft')
      wx.showToast({ title: '房主在催了', icon: 'none', duration: 1500 })
    }

    /* 事件流要在 setData 之前比对 —— 之后 this.data.room 已经是新的一帧了 */
    this._evDiff(this.data.room, raw)
    /*
     * 倒计时的服务端校正。
     *
     * 每台手机的"3 秒"都从**自己收到响应**那一刻起算 ——
     * 网络快慢不同，两台手机能差出几百毫秒到一秒（轮询 1.5 秒）。
     * 而倒计时存在的全部意义就是"所有人同时开始"。
     *
     * 所以：poll 回来带着服务端剩余时间，偏差超过 400ms 就把本地起点拽过去。
     * ★ 只校正、不重置 —— 重置会让数字跳（3 → 3 → 2），比不同步更难看。
     */
    if (raw.phase === 'countdown' && this._cdT0 && raw.countdownMs > 0) {
      const localLeft = (this._cdLeft || 0) - (Date.now() - this._cdT0)
      if (Math.abs(localLeft - raw.countdownMs) > 400) {
        this._cdLeft = raw.countdownMs
        this._cdT0 = Date.now()
      }
    }
    const prevStep = (this.data.room && this.data.room.uw && this.data.room.uw.step) || ''
    const patch = Object.assign({}, extra || {}, {
      room: this.decorate(raw),
      stage: stageOf(raw.phase)
    })
    this.setData(patch)
    /* 环节变了就把词收起来：投票时屏幕上还亮着"你的词"会被旁边人看到。
       ⚠️ 只在**环节变化**时收，不能每次刷新都收 ——
          1.5 秒轮询会把正在按住看词的人打断。 */
    const nextStep = (raw.uw && raw.uw.step) || ''
    if (prevStep !== nextStep) this._uwResetWord()
    /* 回合交给别人时也要收起牌，否则屏幕上一直摊着你的三张 */
    const prevTurn = (this.data.room && this.data.room.turn) || 0
    if (prevTurn !== raw.turn && this.data.showCards) this.setData({ showCards: false })

    /*
     * 发牌动画：只在**第一次看到这一局的牌**时播一次。
     *
     * ★ 为什么不用 CSS animation：
     *   轮询每 1.5 秒 setData 一次，wx:for 会重建节点 → CSS animation 会**反复重播**，
     *   牌每 1.5 秒飞进来一次，比不做还糟。
     *   用"改 class + transition"就安全：值不变时 setData 不会触发过渡。
     */
    /*
     * 揭晓音：卧底出局 / 金花比牌，这两件事都是"全场焦点"，
     * 只在**结果真的换了**的时候响一声（靠 lastOut / last 的对象身份比，
     * 轮询不会重复触发 —— 服务端每次都返回新对象，所以要比内容）。
     */
    const uwOutKey = raw.uw && raw.uw.lastOut ? JSON.stringify(raw.uw.lastOut) : ''
    if (uwOutKey && uwOutKey !== (this._lastUwOut || '')) {
      this._lastUwOut = uwOutKey
      feedback.fire('uwReveal')
    }
    if (!uwOutKey) this._lastUwOut = ''

    /*
     * 游戏真正结束的那一刻（金花 / 卧底走到 over）——
     * 这是整局的情绪落点，必须有自己的声音：
     * 赢了撒花、输了给一个下坠。只在**赢家变化**时响一次，
     * 轮询不会重复触发。
     *
     * ⚠️ 卧底的赢家是 'civilian' / 'spy' 而不是人名，
     *    所以要拿"我是不是卧底"和"赢的是不是卧底"比对，不能直接比名字。
     */
    /*
     * ★★★ 金花豹子专属反馈（2026-10-30）。
     *
     * 三张牌全同 = 52/22100 = **0.235%**（约 425 局一次）。
     * 之前和普通胜负完全一样。而酒桌上翻出三个一样，是要拍桌子的。
     *
     * 判据：服务端在比牌记录里给了 `byType` / `targetType`，
     * 任一方是「豹子」就触发 —— 不是只有赢家才有资格。
     */
    const pkLast = raw.poker && raw.poker.last
    const hasLeopard = !!(pkLast && (pkLast.byType === '豹子' || pkLast.targetType === '豹子'))

    if (raw.game === 'poker' && raw.poker && raw.poker.winner) {
      const win = raw.poker.winner
      if (win !== (this._lastPkWin || '')) {
        this._lastPkWin = win
        const iWon = raw.me && win === raw.me.name
        /* 输了 = 罚酒：penalized 是"下坠 + 碰杯"两层，比单薄的 lose 更贴酒桌 */
        feedback.fire(iWon ? 'win' : 'penalized')
        if (iWon) this.celebrate()
        /* 豹子：等上面的胜负音播完（confetti/failDrop 约 1.2s）再补一层 */
        if (hasLeopard) {
          this._cupTimers.push(setTimeout(() => {
            if (this._dead) return
            feedback.fire('luckyHit')
          }, 1400))
        }
      }
    } else if (raw.game !== 'poker') {
      this._lastPkWin = ''
    }

    const uwRes = raw.lastResult && raw.lastResult.kind === 'undercover' ? raw.lastResult : null
    if (uwRes && raw.uw && raw.uw.myRole) {
      const key = uwRes.winner + '|' + raw.uw.myRole
      if (key !== (this._lastUwWin || '')) {
        this._lastUwWin = key
        const iAmSpy = raw.uw.myRole === 'spy'
        const iWon = (uwRes.winner === 'spy') === iAmSpy
        /* 输了 = 罚酒：penalized 是"下坠 + 碰杯"两层，比单薄的 lose 更贴酒桌 */
        feedback.fire(iWon ? 'win' : 'penalized')
        if (iWon) this.celebrate()
      }
    } else if (!uwRes) {
      this._lastUwWin = ''
    }

    const nowPoker = raw.game === 'poker' && raw.phase === 'playing'
    if (nowPoker && !this._pkDealt) {
      this._pkDealt = true
      /* 发牌音：三声"嗒"跟着三张牌飞进来（视觉先、声音晚 90ms 见 feedback 的通道补偿） */
      sfx.play('cardDeal')
      this._pkDealTimer2 = setTimeout(() => { if (!this._dead) sfx.play('cardDeal') }, 90)
      this._pkDealTimer3 = setTimeout(() => { if (!this._dead) sfx.play('cardDeal') }, 180)
      this.setData({ pkDealIn: true })
      this._pkDealTimer = setTimeout(() => {
        if (!this._dead) this.setData({ pkDealIn: false })
      }, 90)
    }
    if (!nowPoker) this._pkDealt = false
  },

  /**
   * decorate 的**容错版**（2026-10-29）。
   *
   * 装饰字段算不出来（比如依赖的模块出问题）不该连累界面切换 ——
   * 用户报"开房间转一会儿、有声音、但没反应一直进不去"，
   * 而"有声音"说明建房成功了，卡住的只是这一句 setData。
   *
   * 兜底：用原始 room 显示（少几个派生字段，但至少进得去），并记一条错误。
   */
  safeDecorate(room) {
    try {
      return this.decorate(room)
    } catch (e) {
      try {
        const log = wx.getStorageSync('errLog') || []
        log.push({
          t: Date.now(), fn: 'room', act: 'decorate',
          raw: '装饰房间失败：' + ((e && e.message) || '未知')
        })
        if (log.length > 20) log.length = 20
        wx.setStorageSync('errLog', log)
      } catch (err) {}
      return room
    }
  },

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
    /*
     * "还差谁没摇" —— **必须排除自己**。
     * 原来看起来没问题，是因为它只在 `myRolled` 为真时显示（那时自己已经摇过了）；
     * 但语义上"等我自己摇"是荒谬的，而且一旦别处复用它就会暴露。
     */
    const waiting = (room.players || []).filter(p => !p.isMe && !(p.diceCount > 0))
    room.waitingCount = waiting.length
    room.waitingNames = waiting.map(p => p.name).join('、')
    /*
     * 等待文案按人数换句式。
     * 「还差 1 个人没摇（倩萍）」→「等倩萍摇」：
     * 少一层"数字 + 括号"的转译，读起来就是人在说话。
     * 人多时才需要"还差几个"的框架（否则一长串名字没重点）。
     */
    if (!waiting.length) room.waitingText = ''
    else if (waiting.length === 1) room.waitingText = '等 ' + room.waitingNames + ' 摇'
    else if (waiting.length === 2) room.waitingText = '等 ' + room.waitingNames.replace('、', ' 和 ') + ' 摇'
    else room.waitingText = '还差 ' + waiting.length + ' 个人没摇 · ' + room.waitingNames

    /*
     * 我是不是"中途加入、这局只能看"。
     *
     * ★ 原来 `inRound` 只用来**过滤别人**（列表里不显示未入局的人），
     *   从来没有一处告诉玩家"**你自己**现在是观战"。
     *   于是中途进来的人会看到别人在玩、自己点了却被服务端拒
     *   （"你是中途进来的，下一局才能参与"）—— 完全不知道为什么。
     *   一个字段算清，所有玩法共用一条提示。
     */
    {
      const mePlayer = (room.players || []).filter(p => p.isMe)[0]
      room.spectating = !!(mePlayer && mePlayer.inRound === false)
    }

    /*
     * 金花：牌型提示。
     *
     * ★ 只用**玩家本来就看得见的两张**（公共底牌 + 自己的明牌）算 ——
     *   暗牌连自己都看不到，所以任何非确定的说法都只能是"有机会"。
     *   唯一能确定的是"两张同点数 → 至少是对子"。
     *   它替玩家做了一件心算的事，不改变任何规则、不泄露暗牌。
     */
    if (room.game === 'poker' && room.poker) {
      const pub = room.poker.publicCard
      const mine = room.poker.myKnown
      room.poker.hintText = (pub && mine) ? poker.handHint(pub, mine) : ''
      /*
       * 把"每人换牌喝了多少"挂回各自的 player 上，方便列表里直接渲染。
       * 这是**公开信息**（换牌时全桌都看见谁喝了），但**只暴露总量** ——
       * 不暴露换的是底牌还是手牌、更不暴露换之前的牌。
       */
      const cupsMap = {}
      ;(room.poker.drinks || []).forEach(d => { cupsMap[d.name] = d.cups })
      ;(room.players || []).forEach(p => {
        const c = Number(cupsMap[p.name]) || 0
        p.drinkCups = c
        /* 显示文字：1 杯 / 1.5 杯，0 就不显示 */
        p.drinkText = c === 0 ? '' : (c % 1 === 0 ? c + ' 杯' : Math.floor(c) + '.5 杯')
        /* ★ 顺便记下"我自己"那一份 —— 模板的「换牌已经喝了 X 杯」读的是
           room.poker.drinkText，而它**从来没有被赋值**（2026-10-30 发现）。
           于是那一行永远不显示：玩家换了两手牌、喝了一杯半，
           界面上却看不到自己欠了多少。 */
        if (p.isMe) room.poker.drinkText = p.drinkText
      })
    }

    /*
     * 玩法名与规则 —— 从注册表取，不在这里重写一遍文案。
     * ★ 注册表里每个玩法都有 `how: [4 条规则]`，但这一版之前**从来没被渲染过**
     *   （grep `.how` 全仓为 0）—— 16 条文案白写在数据里。
     *   放 lobby 是刻意的：等人齐的那一刻正好是无事可做、最适合看规则的时候。
     */
    const gmeta = gameOf(room.game)
    room.gameName = gmeta ? gmeta.name : ''
    room.howList = gmeta && Array.isArray(gmeta.how) ? gmeta.how : []
    /*
     * 人数要求：从注册表取，不在界面里写死。
     * ★ 服务端为了调试允许单开（"一个人先看看玩法"），但**产品上不该让人
     *   开一个玩不了的局**：单人点"开始（1 人）"玩大话骰，只会一脸问号。
     *   所以这里算出"还差几个人"，由界面决定按钮能不能点。
     */
    room.minPlayers = gmeta ? gmeta.min : 2
    room.maxPlayers = gmeta ? gmeta.max : 8
    room.shortBy = Math.max(0, room.minPlayers - (room.count || 0))
    /*
     * 单人测试开关下，这个玩法**一个人能不能玩完一轮**（2026-10-28）。
     * 卧底不能：1 人时唯一的人会被选成卧底，投票页列表为空、
     * 服务端又拦"不能投自己" → 卡死。服务端按 games.js 的 soloMin 拦，
     * 前端据此把按钮说清楚，别让玩家点了才被拒。
     */
    /*
     * 首字头像（2026-10-28）。
     * 多人局里每个玩家只有名字，12 个人一串中文名很难快速对上人 ——
     * 给一个首字圆形就像有了"脸"。字在数据层取好：
     * wxml 的表达式能力有限（不支持函数调用），`name[0]` 虽然能写，
     * 但空名字会取到 undefined，模板里再兜一次不如这里一次算清。
     */
    ;(room.players || []).forEach(p => {
      p.initial = String(p.name || '?').trim().charAt(0) || '?'
    })
    if (room.uw && Array.isArray(room.uw.candidates)) {
      room.uw.candidates.forEach(c => {
        c.initial = String(c.name || '?').trim().charAt(0) || '?'
      })
    }

    room.soloMinPlayers = (gmeta && gmeta.soloMin) ? gmeta.soloMin : 1
    room.soloOk = (room.count || 0) >= room.soloMinPlayers
    room.overBy = Math.max(0, (room.count || 0) - room.maxPlayers)

    /*
     * 卧底出局时，把「我自己的词」也摆出来做对比。
     *
     * ★ 为什么不泄露信息：我的词我一直能按住看，这里的只是**省一次操作**。
     *   而"他的词 vs 我的词"正是这个玩法最核心的一步推理 ——
     *   原来要按住看自己的、再松手，两个信息不能同时看到。
     *   出局者是自己时不显示（那就是同一张卡，没意义）。
     */
    room.uwCompare = ''
    if (room.uw && room.uw.step === 'result' && room.uw.lastOut && room.uw.word) {
      const lo = room.uw.lastOut
      const mine = (room.me && room.me.name) || ''
      if (lo.name !== mine) {
        room.uwCompare = '你的词是「' + room.uw.word + '」'
      }
    }

    /*
     * 「今晚谁输最多」—— 用服务端的 score（每输一局 -1）。
     *
     * ★ 这个字段一直在，但从没被展示过（前端 grep 不到），等于死数据；
     *   而"他今晚已经输 3 局了"在酒桌上是最有杀伤力的一句话。
     *   只在 ≤ -2 时显示：输一局就说"今晚输最多"没意义。
     *
     * ⚠️ 这是**局数**不是杯数 —— 喝多少现场自己清楚，
     *   而且记杯数容易被质疑（谁赖账、谁喝的是水），记输赢局数没有争议。
     */
    room.loserBoard = ''
    if (room.phase === 'over') {
      const worst = (room.players || [])
        .filter(p => (Number(p.score) || 0) <= -2)
        .sort((a, b) => (Number(a.score) || 0) - (Number(b.score) || 0))[0]
      if (worst) room.loserBoard = worst.name + ' 今晚已经输了 ' + Math.abs(Number(worst.score)) + ' 局'
    }

    /*
     * 连庄提示：找出"连赢 2 把以上"的人。
     *
     * ★ streaks 这个字段服务端一直在维护（比大小用它放连击音效），
     *   但**界面从没显示过** —— 酒桌上"他连赢三把了"是最能带动气氛的一句话，
     *   却只躺在数据里。现在算成一句话，放在结算页。
     */
    room.streakText = ''
    {
      const st = room.streaks || {}
      let best = null
      Object.keys(st).forEach((seat) => {
        const n = Number(st[seat]) || 0
        if (n < 2) return
        if (best && n <= best.n) return
        const p = (room.players || []).filter(x => String(x.seat) === String(seat))[0]
        if (p) best = { name: p.name, n: n }
      })
      if (best) room.streakText = best.name + ' 连赢 ' + best.n + ' 把'
    }

    /*
     * 结算的"情绪收尾"：一句话说清这局谁最惨 / 发生了什么。
     * ★ 明细区已经展示了牌和骰子，这里只补**结论**，不重复数据。
     *   按玩法分别算，但都收敛到 room.settleFoot 一个字段 ——
     *   模板只判断"有没有"，不写五套 if。
     */
    /*
     * 牌面颜色（红/黑）。
     * ★ 必须在 JS 里算：微信 wxml 的表达式**不支持函数调用**，
     *   `.indexOf('♥')` 会让整个 wxml 编译失败（`unexpected token '.'`），
     *   而且只在上传/真机预览时才报 —— 本地渲染和断言全看不见。
     */
    if (room.game === 'poker' && room.poker) {
      const isRed = (t) => /[♥♦]/.test(t || '')
      room.poker.publicRed = isRed(room.poker.publicText)
      room.poker.myKnownRed = isRed(room.poker.myKnownText)
    }

    /*
     * 比大小结算：把赢家的骰子单独拎出来给"英雄区"用。
     * 服务端只给 ranked（所有人的），前端取点数最高那一行 —— 纯派生，不动服务端。
     */
    if (room.game === 'dice' && room.lastResult && Array.isArray(room.lastResult.ranked)) {
      const lr = room.lastResult
      const hero = lr.ranked.filter(x => x.total === lr.top)[0]
      lr.topDice = (hero && hero.dice) ? hero.dice : []
      /*
       * 列表里**去掉赢家**：他已经在大图里了，再列一遍既是重复、又白占一行 ——
       * 8 人局那一行正好把底部的「再来一局」挤下屏。
       */
      lr.restRanked = lr.ranked.filter(x => x.total !== lr.top)
    }

    /*
     * 今晚战况（2026-10-29）：把 { 名字: 杯数 } 排成前 3 名。
     * ⚠️ 排序放在 decorate 里（派生字段的唯一出口），模板只取值 ——
     *    wxml 表达式不支持函数调用，不能写在模板里。
     */
    const nd = room.nightDrinks || {}
    room.nightDrinkList = Object.keys(nd)
      .map(k => ({ name: k, cups: Number(nd[k]) || 0 }))
      .filter(x => x.cups > 0)
      .sort((a, b) => b.cups - a.cups)
      .slice(0, 3)

    /* 结算页底部那句话（"谁喝一杯"）—— 逻辑抽到 game/settle.js，纯函数可单测 */
    room.settleFoot = settleFoot.footText(room)

    return room
  },

  /**
   * 转发小程序卡片 —— 酒桌上最自然的动作是"把房间号发到群里"，
   * 而不是"复制一串数字再手动粘贴"。
   *
   * ★ 在此之前本页**完全没有 onShareAppMessage**，
   *   微信右上角菜单里的「转发」是灰的 —— 一个多人游戏不能转发，
   *   等于每次开局都要教一遍"怎么把号发出去"。
   *
   * path 里带房间号：对方点开小程序**直接落到这个房间**，
   * 不需要再手输一遍（这就是微信分享比"发一串数字"强的地方）。
   */
  /**
   * 朋友圈分享（2026-10-30）。
   * ⚠️ 朋友圈是单页模式，**带不了房间号**（query 会被丢弃）——
   *    所以文案不说"进这个房间"，落地页也是大厅，别让朋友点进来找不到房。
   */
  onShareTimeline() {
    return {
      /* 朋友圈标题会被截断，控制在 18 字内（当前 13 字） */
      title: '酒桌游戏，一部手机就能开桌',
      imageUrl: '/images/share-cover.png'
    }
  },

  onShareAppMessage() {
    const r = this.data.room
    if (r && r.code) {
      const g = gameOf(r.game)
      /*
       * 标题带上"几个人在等"（2026-10-29）。
       * 原来只有「来玩大话骰，房间号 627」—— 群里看到的人不知道里面是什么情况。
       * 有人已经在等，比一个光秃秃的房间号有力得多。
       */
      const n = r.count || 1
      const gname = g ? g.name : '酒桌游戏'
      /*
       * ⚠️ 标题要短（2026-10-29）。
       *   微信在群聊里大约只显示 20 个字，超出会被省略号截掉 ——
       *   而"房间号 627"如果落在截断之后，这条分享就白发了。
       *   所以先算长度：人少时用完整说法，人多时压成「X 人等 · 房号 N」。
       */
      const full = '来玩' + gname + '，' + (n > 1 ? '已经 ' + n + ' 个人在等' : '就等你来了') + '（房间号 ' + r.code + '）'
      const tight = gname + ' · ' + (n > 1 ? n + ' 人等' : '等你来') + ' · 房号 ' + r.code
      return {
        title: full.length <= 20 ? full : tight,
        path: '/game/room/room?code=' + r.code,
        /* 不带 imageUrl 时微信会截页面首屏当封面 —— 群里看是一堆文字，辨识度极低 */
        imageUrl: '/images/share-cover.png'
      }
    }
    return {
      title: '一起来玩酒桌游戏',
      path: '/pages/lobby/lobby',
      imageUrl: '/images/share-cover.png'
    }
  },

  /**
   * 观战守卫：中途加入的人这一局只能看。
   *
   * 服务端本来就会拒（"你是中途进来的，下一局才能参与"），
   * 但那是**冷冰冰的错误**，玩家不知道"为什么只有我不行"。
   * 所有操作入口统一在开头调它 —— 一处逻辑覆盖所有玩法，
   * 比在五个分支里各写一遍 if 可靠（那种写法必然漏）。
   *
   * @returns {boolean} true = 可以继续操作
   */
  specGuard() {
    if (this.data.room && this.data.room.spectating) {
      wx.showToast({ title: '这一局你只能看，下一局自动加入', icon: 'none', duration: 2600 })
      return false
    }
    return true
  },

  /* ================= 谁是卧底 ================= */

  /*
   * 按住看词。
   * ★ 为什么是"按住"而不是"点一下显示、再点一下隐藏"：
   *   松手即藏的容错性远高于"记得再点一次"—— 后者在酒桌上
   *   几乎必然会有一次忘记收起，而同桌的人就坐在旁边。
   *   这和骰盅"按住偷看"是同一个设计理由。
   */
  uwShowWord() {
    /* 和"翻开自己的牌"是同一个动作语义，复用同一条时间轴 */
    feedback.fire('pkFlip')
    this.setData({ showWord: true })
  },
  uwHideWord() {
    if (this.data.showWord) this.setData({ showWord: false })
  },

  /* 环节一变就收起词 —— 否则投票时屏幕上还亮着"你的词"，会被旁边人看到 */
  _uwResetWord() { if (this.data.showWord) this.setData({ showWord: false }) },

  /* 房主切换环节：说完了→投票 / 结算完→下一轮 */
  async uwSay() {
    if (!this.specGuard()) return
    if (!this.data.room || this.data._uwBusy) return
    this.data._uwBusy = true
    sfx.play('tapSoft')
    const r = await call('room', { action: 'uwSay', id: this.data.room.id }, { silent: true })
      .catch((e) => {
        wx.showToast({ title: (e && e.friendly) || '没提交上，再点一次', icon: 'none' })
        this.resyncAfterFail()
        return null
      })
    this.data._uwBusy = false
    if (r && r.ok) this.applyRoom(r.room)
  },

  /* 投票：点一个人。
     ★ 目标跟着 data-oid 走，不依赖逻辑层的派生列表 ——
     "视图层比逻辑层旧一拍"时按下标取会投错人，而且不报错。 */
  async uwVote(e) {
    if (!this.specGuard()) return
    if (!this.data.room || this.data._uwBusy) return
    const target = String(e.currentTarget.dataset.oid || '')
    if (!target) return
    if (this.data.room.uw && this.data.room.uw.myVote) {
      wx.showToast({ title: '这轮已经投过了', icon: 'none' })
      return
    }
    this.data._uwBusy = true
    /* 走统一时间轴：音效与震动的错开补偿由表决定，不在这里手写 */
    feedback.fire('uwVote')
    const r = await call('room', { action: 'uwVote', target: target, id: this.data.room.id }, { silent: true })
      .catch((err) => {
        wx.showToast({ title: (err && err.friendly) || '没投上，再点一次', icon: 'none' })
        this.resyncAfterFail()
        return null
      })
    this.data._uwBusy = false
    if (r && r.ok) this.applyRoom(r.room)
  },

  /* ================= 梦幻金花 ================= */

  /* 按住才显示三张牌 —— 理由同卧底看词：同桌的人就坐在旁边 */
  pkShow() {
    feedback.fire('pkFlip')
    this.setData({ showCards: true })
  },
  pkHide() {
    if (this.data.showCards) this.setData({ showCards: false })
  },

  /*
   * 换牌：换底牌喝 1 杯、换手牌喝半杯（用户 2026-10-27 加的规则）。
   * 按钮上直接把代价写出来 —— 让人在按之前就知道要喝多少。
   */
  async pkSwap(e) {
    if (!this.specGuard()) return
    if (!this.data.room) return
    /*
     * ★★ 「连续换手牌换不了」（2026-10-30 用户第二次报同一处，说明我第一次没修好）。
     *
     * 第一次我只给 pkDoSwap 加了看门狗，**但入口 pkSwap 这里也是静默 return** ——
     * 只要 _pkBusy 还是 true，点「换手牌」就**什么都不发生**：
     * 没有确认卡、没有提示、没有请求。用户看到的就是"按钮坏了"。
     * 而"换底牌"之所以看起来能用，是因为两次点击间隔更久、busy 已经清掉了。
     *
     * 现在：被挡时明确说话。
     */
    if (this.data._pkBusy) {
      wx.showToast({ title: '上一次换牌还在处理，等半秒', icon: 'none', duration: 2000 })
      return
    }
    const what = e.currentTarget.dataset.what
    if (what !== 'public' && what !== 'mine') return
    /*
     * ★★ 2026-10-29：确认框从 `wx.showModal` 改成**页面内确认卡**。
     *
     * 三个理由：
     *   ① 系统弹窗是蓝白样式，与暗金酒桌主题完全两个世界 —— 这是最"App 味"
     *      而不是"游戏味"的一处；
     *   ② 原生弹窗的按钮文案/排版不可定制（只能 confirmText/cancelText 两个词）；
     *   ③ automator **点不到原生弹窗**，金花的整条交互链路因此无法真机验证。
     * 现在确认卡落在同一套 .mask/.sheet 上（与「加一道自己的题」一致）。
     */
    sfx.play('tapSoft')
    this.setData({ pkAsk: { kind: 'swap', what: what } })
  },

  /** 确认卡：取消 */
  pkAskNo() {
    sfx.play('tapSoft')
    this.setData({ pkAsk: null })
  },

  /** 确认卡：确认 —— 只负责转调，真正的动作各自留在 pkDoSwap / pkDoFold 里 */
  pkAskYes() {
    /* 点「换 / 弃牌」这一下必须有声音：断言 ⑪ 要求每个 bindtap 方法**自己**播，
       不能靠被调方（转调不算）。 */
    sfx.play('tap')
    const ask = this.data.pkAsk
    this.setData({ pkAsk: null })
    if (!ask) return
    if (ask.kind === 'fold') this.pkDoFold()
    else this.pkDoSwap(ask.what)
  },

  async pkDoSwap(what) {
    /* 纵深防御：入口（pkSwap/pkFold）已判过，这里再判一次 ——
       万一将来从别处调用（或确认卡残留），观战者也不会绕过友好提示 */
    if (!this.specGuard()) return
    if (!this.data.room) return
    /*
     * ★★ 「连续换手牌换不了」（2026-10-30 用户实测）。
     *
     * 根因：`_pkBusy` 是防重入标记，但原来**只在这一条路径结束时清**。
     * 云函数请求一旦挂住（弱网、冷启动），标记就永远停在 true，
     * 之后每一次"换"都静默 return —— 用户看到的就是"按钮没反应/换不了"。
     *
     * 两处修：
     *   ① 加 10 秒看门狗，请求再慢也不会把按钮永久锁死；
     *   ② 被挡时**说一句**（原来静默），让用户知道是在等上一次的结果，
     *      而不是以为界面坏了。
     */
    if (this.data._pkBusy) {
      wx.showToast({ title: '上一次换牌还在路上，稍等一下', icon: 'none', duration: 2400 })
      return
    }
    this.data._pkBusy = true
    const dog = setTimeout(() => { this.data._pkBusy = false }, 10000)
    feedback.fire('pkFlip')
    const r = await call('room',
      { action: 'pkAct', act: what === 'public' ? 'swapPublic' : 'swapMine', id: this.data.room.id },
      { silent: true })
      .catch((err) => {
        wx.showToast({ title: (err && err.friendly) || '没换成，再点一次', icon: 'none' })
        this.resyncAfterFail()
        return null
      })
    clearTimeout(dog)
    this.data._pkBusy = false
    if (r && r.ok) this.applyRoom(r.room)
  },

  /* 弃牌：认输，喝一杯 */
  pkFold() {
    if (!this.specGuard()) return
    if (!this.data.room || this.data._pkBusy) return
    /* 确认卡（同上）：弃牌是不可逆的，必须二次确认 */
    sfx.play('tapSoft')
    this.setData({ pkAsk: { kind: 'fold' } })
  },

  async pkDoFold() {
    /* 纵深防御：入口（pkSwap/pkFold）已判过，这里再判一次 ——
       万一将来从别处调用（或确认卡残留），观战者也不会绕过友好提示 */
    if (!this.specGuard()) return
    if (!this.data.room || this.data._pkBusy) return
    this.data._pkBusy = true
    sfx.play('tapSoft')
    const r = await call('room', { action: 'pkAct', act: 'fold', id: this.data.room.id }, { silent: true })
      .catch((e) => {
        wx.showToast({ title: (e && e.friendly) || '没提交上，再点一次', icon: 'none' })
        this.resyncAfterFail()
        return null
      })
    this.data._pkBusy = false
    if (r && r.ok) this.applyRoom(r.room)
  },

  /* 比牌：点一个人跟他比。
     ★ 目标跟着 data-oid 走，不依赖派生列表 —— 视图层旧一拍时按下标会点错人。 */
  async pkVs(e) {
    if (!this.specGuard()) return
    if (!this.data.room || this.data._pkBusy) return
    const target = String(e.currentTarget.dataset.oid || '')
    if (!target) return
    this.data._pkBusy = true
    /* 摊牌：三张牌拍在桌上 + 160ms 后一下揭示重击 —— 两层音在表里定义 */
    feedback.fire('pkSpread')
    const r = await call('room', { action: 'pkAct', act: 'vs', target: target, id: this.data.room.id }, { silent: true })
      .catch((err) => {
        wx.showToast({ title: (err && err.friendly) || '没提交上，再点一次', icon: 'none' })
        this.resyncAfterFail()
        return null
      })
    this.data._pkBusy = false
    if (r && r.ok) this.applyRoom(r.room)
  },

  /* ================= 自定义题 ================= */

  openCards() {
    sfx.play('tapSoft')
    this.setData({ cardPanel: true, cardText: '', cardType: 'truth' })
  },
  closeCards() {
    sfx.play('tapSoft')
    this.setData({ cardPanel: false, cardText: '' })
  },
  pickCardType(e) {
    sfx.play('tapSoft')
    this.setData({ cardType: e.currentTarget.dataset.t })
  },
  onCardText(e) { this.setData({ cardText: e.detail.value }) },

  /*
   * 空方法，只为给面板加 catchtap。
   * 为什么需要：遮罩层绑了 closeCards（点空白关闭），
   * 而面板本身在遮罩里面 —— 没这个空方法的话，点面板任何位置都会冒泡上去把面板关掉，
   * 连输入框都点不了。
   */
  noop() {},

  /**
   * 加一道自己的题。
   *
   * ★ 加完立刻清空输入框但**不关面板** —— 酒桌上往往是"想到好几个梗"，
   *   加一条就关掉会让人反复点开。面板里能看到已加的列表，才形成闭环。
   */
  async addCard() {
    const text = (this.data.cardText || '').trim()
    /* "写点什么"太笼统 —— 用户不知道写多长、写什么算合格 */
    /*
     * toast 的宽度只有屏幕的一小条，21 个字会折成两行还挤 ——
     * 提示的任务是告诉用户现在缺什么，不是把例子讲完（例子就在 placeholder 里）。
     */
    if (!text) return wx.showToast({ title: '还没写呢', icon: 'none', duration: 1600 })
    sfx.play('tap')
    const r = await call('room', {
      action: 'card', id: this.data.room.id, type: this.data.cardType, text: text
    }, { silent: true }).catch((err) => {
      wx.showToast({ title: (err && (err.friendly || err.message)) || '没加上', icon: 'none', duration: 2200 })
      this.resyncAfterFail()
      return null
    })
    if (r && r.ok) {
      this.setData({ room: this.safeDecorate(r.room), cardText: '' })
      wx.showToast({ title: '加好了，抽得到', icon: 'none' })
    }
  },

  async delCard(e) {
    const text = e.currentTarget.dataset.t
    sfx.play('tapSoft')
    /*
     * ⚠️ catch 里**必须给提示**，不能 `.catch(() => null)`。
     *    这是本项目反复踩过的坑（「点击叫骰没反应」报了两次才找到根因）：
     *    静默吞掉之后，用户看到的就是"点了没反应"，只能靠猜。
     *    `scripts/test-error-feedback.js` 会拦这一类 —— 它这次就拦住了我。
     */
    const r = await call('room', {
      action: 'cardDel', id: this.data.room.id, text: text
    }, { silent: true }).catch((err) => {
      wx.showToast({ title: (err && (err.friendly || err.message)) || '删不掉，再试一次', icon: 'none' })
      this.resyncAfterFail()
      return null
    })
    if (r && r.ok) this.setData({ room: this.safeDecorate(r.room) })
  },

  /**
   * 催一下（2026-10-28，调研第 2 条后半）。
   * 服务端限流：一轮投票最多两次、间隔 15 秒。
   */
  async doNudge() {
    if (!this.specGuard()) return
    sfx.play('tapSoft')
    const r = await call('room', { action: 'nudge', id: this.data.room.id }, { silent: true })
      .catch((e) => {
        wx.showToast({ title: (e && (e.friendly || e.message)) || '催不动', icon: 'none' })
        this.resyncAfterFail()
        return null
      })
    if (r && !r.ok) wx.showToast({ title: r.msg || '催不动', icon: 'none' })
    if (r && r.ok) this.applyRoom(r.room)
  },

  /**
   * 锁房 / 解锁（2026-10-28，调研第 25 条）。
   *
   * 3 位房间号，任何人知道号就能进 —— 隔壁桌听见你们报号就进来了，
   * 房主没有任何办法拦。这是个很小的开关，但它是"谁在这个房间"的唯一控制权。
   */
  async toggleLock() {
    /* 观战守卫：虽然是房主操作、房主不可能是观战者，但统一加更可靠
       （断言也要求所有写操作入口都有它） */
    if (!this.specGuard()) return
    if (!this.data.room || !this.data.room.host) return
    const want = !this.data.room.locked
    sfx.play('toggleOn')
    const r = await call('room', { action: 'lock', id: this.data.room.id, locked: want }, { silent: true })
      .catch((e) => {
        wx.showToast({ title: (e && (e.friendly || e.message)) || '锁不上', icon: 'none' })
        this.resyncAfterFail()
        return null
      })
    /*
     * ★ 2026-10-30：三条分支都要有交代。
     *
     * 原来只有 `if (r && r.ok) this.applyRoom(...)` ——
     * **成功以外的两种情况（r 为 null / r.ok 为 false）什么都不做**：
     *   · 云函数返回业务错误 → 用户点了按钮，界面没变，也不知道为什么
     *   · catch 已经弹过 toast 的分支 → 走 applyRoom 之外，静默
     *
     * 这正是"点了没反应"这类反馈的来源。现在：
     *   成功 → 更新界面
     *   业务错误 → 把服务端的话显示出来
     *   null（已在 catch 里弹过）→ 不再重复弹
     */
    if (r && r.ok) this.applyRoom(r.room)
    else if (r && r.msg) wx.showToast({ title: r.msg, icon: 'none', duration: 2200 })
  },

  /*
   * 局内看规则（2026-10-28）。
   * lobby 里有一整套「怎么玩」，但开局就撤掉了 ——
   * 而酒桌上最常发生的是"开局前扫了一眼、轮到自己忘了"。
   */
  showHow() {
    sfx.play('tapSoft')
    this.setData({ howOpen: true })
  },
  closeHow() {
    if (!this.data.howOpen) return
    sfx.play('tapSoft')
    this.setData({ howOpen: false })
  },

  /* ================= 建房 ================= */

  /*
   * ⚠️ 这里原来有个 （昵称输入框的 bindinput 处理）。
   *   2026-10-27 按手机上不要太多交互把 entry 的昵称输入砍掉了，
   *   这个处理器就成了孤儿 —— 2026-10-28 由「死功能」断言扫出来并删除。
   *   （改昵称现在走 lobby 里点自己那行 → showModal，见 renameMe）
   */
  pickGame(e) {
    const k = e.currentTarget.dataset.k
    const g = gameOf(k)
    /* 按钮标题跟着选中的玩法走 —— 用户点开哪个，标题就说哪个 */
    this.setData({ pickGame: k, pickGameName: g ? g.name : this.data.pickGameName })
    sfx.play('tapSoft')
  },

  /* 选题卡场合（建房时；只有命运转盘会用到） */
  pickDeck(e) { this.setData({ pickDeck: e.currentTarget.dataset.k }); sfx.play('tapSoft') },

  /*
   * 局中换场合（房主）。服务端会拦"正在玩的时候"，
   * 前端也先拦一道 —— 少一次白跑的往返。
   */
  async changeDeck(e) {
    const k = e.currentTarget.dataset.k
    if (k === this.data.room.deck) return
    sfx.play('tapSoft')
    const r = await call('room', { action: 'deck', id: this.data.room.id, deck: k },
      { silent: true }).catch((err) => {
      wx.showToast({ title: (err && (err.friendly || err.message)) || '换不了', icon: 'none' })
      this.resyncAfterFail()
      return null
    })
    if (r && r.ok) {
      this.setData({ room: this.safeDecorate(r.room) })
      const d = decks.deckOf(k)
      wx.showToast({ title: '换成「' + d.name + '」了', icon: 'none' })
    }
  },

  async doCreate() {
    sfx.play('tick')                // 点击反馈（断言 ⑮ 要求）
    this._didCreate = true          // 供 15 秒兜底时判断"请求到底发没发出去"
    if (this.data.creating) return
    this.setData({ creating: true, err: '' })
    /*
     * ★★ 用 try/finally 保证 `creating` 一定复位（2026-10-29）。
     *
     * 原来它是"await 之后顺序执行"的：如果在 `call(...)` 这一步**同步抛异常**
     * （比如 `wx.cloud` 没初始化、`showLoading` 在某些基础库上抛错），
     * `.catch()` **不会执行**（它只接 Promise rejection），
     * 于是 `creating` 永久停在 `true` —— 之后每次点卡都在第一行 `return`，
     * 表现就是"点了没反应"，而且**重启小程序才恢复**。
     */
    let r = null
    try {
      r = await call('room', {
        action: 'create',
        name: this.data.myName || '房主',
        game: this.data.pickGame,
        /* 场合只有转盘用得到，但一起传过去无害 —— 房主中途换游戏也不用重开房 */
        deck: this.data.pickDeck
      }, { loading: '开一桌' })
        .catch((e) => {
          /*
           * no-room: 建房失败时还没有房间可同步，这里是唯一合理的例外。
           * ★ 必须把**具体原因**显示出来（2026-10-29）：原来只取 `e.friendly`，
           *   而云函数返回的业务错误（如"房间号用满了"）只有 `message`、没有 friendly，
           *   于是统一显示成"开不了这一桌" —— 用户拿这句话什么也做不了，我也查不出来。
           */
          this.setData({ err: (e && (e.friendly || e.message)) || '开不了这一桌' })
          return null
        })
    } catch (e) {
      /* 同步异常（不是 Promise rejection）—— 也要说话，不能就这么卡住 */
      this.setData({ err: '开不了这一桌：' + ((e && e.message) || '未知错误') })
      this.setLoading(false)          // 失败也要关遮罩，否则要等 15 秒兜底
    } finally {
      this.setData({ creating: false })
    }
    /*
     * ★★ 必须关掉全屏遮罩（2026-10-29 用户报障后修的）。
     *
     * `doJoin` 一直有这一句，`doCreate` 没有 —— 而 3.10.26 我给"点玩法卡建房"
     * 那条路径加上了 `patch.loading = true`（本意是别先闪一下空白），
     * 于是：遮罩拉起 → 建房 → **没人关** → 永远停在"正在进入房间"。
     *
     * 每个玩法都这样，因为所有玩法都走 doCreate。
     * 修法：无论成功失败都关 —— 失败时上面已经 setData 了 err，用户能看到原因。
     */
    if (r && r.ok) {
      sfx.play('confetti')
      /* ★ 即便"建房后必然是 lobby"，也从服务端返回的 phase 推导 ——
         手写常量等于在第二个地方重复描述"服务端是什么状态"，
         将来服务端一改（比如建房直接进倒计时），这里就悄悄错了。 */
      if (this._dead) return          // 云函数往返期间页面可能已卸载
      /*
       * ★★ r.room 可能缺失（2026-10-29）。
       *   如果云函数返回 `{ ok: true }` 但 room 字段没带上（响应截断、
       *   或 shape() 里某处抛错导致只返回了 ok），
       *   `stageOf(r.room.phase)` 会在 setData **之前**就崩掉 ——
       *   而 safeDecorate 兜住的是 decorate，不兜 stageOf。
       *   症状：音效响了、界面不动，而且**没有任何错误记录**。
       */
      if (!r.room) {
        this.setData({ err: '建房成功但数据不完整，请再点一次' })
        this.setLoading(false)          // 失败也要关遮罩
        return
      }
      const newStage = stageOf(r.room.phase)
      /* 玩游戏时别让屏幕锁掉（等别人的时间远多于操作时间）；大厅和结算页关掉省电 */
      this.setKeepScreenOn(newStage === 'countdown' || newStage === 'playing')
      /*
       * ★★ decorate 挂了**不能连累界面切换**（2026-10-29）。
       *   用户报"开房间转一会儿、有声音、但没反应一直进不去" ——
       *   "有声音"就是上面的 confetti，说明建房成功了；卡住的是这一句 setData。
       *   如果 `decorate()` 抛异常（它依赖 settle.js / bidOptions.js），
       *   整句都不会执行，界面就停在原处，而音效已经响过了。
       *   兜底：用原始 room 显示（少几个派生字段，但至少进去了），并记一条错误。
       */
      this.setData({ room: this.safeDecorate(r.room), stage: newStage })
      /*
       * ★ 遮罩必须在 setData **之后**关（2026-10-29）。
       *   如果先关遮罩再 setData，中间有一帧空白（遮罩没了、内容还没渲染）。
       *   先 setData 再关遮罩，内容已经在了才揭幕，过渡是无缝的。
       */
      this.setLoading(false)
      this.startPoll()
    }
  },

  /* ================= 加入 ================= */

  onCode(e) {
    /*
     * 房间号是 3 位纯数字，这里**只留数字**：
     * 用户可能手滑打进空格、字母、或者用输入法带出全角字符，
     * 直接滤掉比"输错了再报错"体验好得多。
     */
    const v = String(e.detail.value || '').replace(/\D/g, '').slice(0, 3)
    this.setData({ joinCode: v })
    /* 输满 3 位就自动进 —— 3 位是唯一合法长度，没有歧义，不该再让人点一次 */
    if (v.length === 3) {
      clearTimeout(this._joinTimer)
      this._joinTimer = setTimeout(() => { if (!this._dead) this.doJoin() }, 180)
    }
  },

  /**
   * 打开/关闭 loading 幕，并管理"慢了"的定时器（2026-10-28）。
   * ⚠️ 定时器必须能被关掉 —— 否则一次慢进房之后，
   *    下次 loading 一出现就立刻显示"还在进"。
   */
  setLoading(on) {
    clearTimeout(this._loadingTimer)
    clearTimeout(this._loadingFailsafe)
    this._loadingTimer = null
    this._loadingFailsafe = null
    if (on) {
      this.setData({ loading: true, loadingSlow: false })
      this._loadingTimer = setTimeout(() => {
        if (this._dead) return
        this.setData({ loadingSlow: true })
      }, 5000)
      /*
       * ★★ 兜底（2026-10-29）：全屏遮罩拉起来之后，**15 秒还没有人关，就强制关掉**。
       *
       * 起因是真机报障"每个游戏都卡在正在进入房间"—— `doCreate` 只拉不关。
       * 那是我的错，已经补上 setLoading(false)，也加了断言 ④d 防止复发。
       *
       * 但"只拉不关"是最容易复发的一类错（状态在 A 处打开、B 处关闭，
       * 而两个地方常常不是同一个人改的）。所以再加一道：
       * **就算将来又漏了，用户最多等 15 秒，而不是永远卡住。**
       *
       * 15 秒的选取：云函数超时是 3 秒，加上网络与冷启动，正常最慢 5~8 秒；
       * 15 秒足够覆盖正常情况，又不至于让人干等太久。
       */
      this._loadingFailsafe = setTimeout(() => {
        if (this._dead || !this.data.loading) return
        /*
         * 兜底触发时**记一条错误**（2026-10-29）。
         * 用户报"开不了房间"时我完全看不到现场 —— 遮罩卡住了是"请求没回来"
         * 还是"请求根本没发出去"，这两种的修法完全不同。
         * 把当时的阶段、有没有调过 doCreate、有没有 err 都记下来，
         * 下次用户截图就能直接看出来。
         */
        try {
          const log = wx.getStorageSync('errLog') || []
          log.push({
            t: Date.now(),
            fn: 'room',
            act: 'stuck',
            raw: '遮罩挂了 15 秒：阶段=' + (this.data.stage || '?') +
              ' 建过房=' + (this._didCreate ? '是' : '否') +
              ' err=' + ((this.data.err || '').slice(0, 30) || '无') +
              ' 房间号=' + (this.data.pickGame || '无')
          })
          if (log.length > 20) log.length = 20
          wx.setStorageSync('errLog', log)
        } catch (e) {}
        this.setData({ loading: false, loadingSlow: false })
        wx.showToast({ title: '这次没进去，再试一次', icon: 'none', duration: 2400 })
      }, 15000)
    } else {
      this.setData({ loading: false, loadingSlow: false })
    }
  },

  async doJoin() {
    const code = (this.data.joinCode || '').trim()
    if (code.length !== 3) {
      return this.setData({ err: '房间号是 3 位数字' })
    }
    if (this.data.joining) return
    /*
     * 点击瞬间就要有声音（2026-10-30）。
     * 原来这一下要等云函数返回、进了房才播 confetti ——
     * 中间那 1 秒只有 loading 转圈，"点了没反应"的观感就是这么来的。
     */
    sfx.play('tapSoft')
    this.setData({ joining: true, err: '' })

    const r = await call('room', {
      action: 'join', code: code, name: this.data.myName || '玩家'
    }, { loading: '进房间' })
      .catch((e) => {
        /* no-room: 进不去 = 没进到房间里，没有可同步的状态。
           同样要显示具体原因，理由见 doCreate 那段。 */
        trace.add('join.fail', (e && (e.friendly || e.message)) || '')
        this.setData({ err: (e && (e.friendly || e.message)) || '进不去' })
        this.setLoading(false)
        return null
      })

    this.setData({ joining: false })
    this.setLoading(false)
    if (r && r.ok) {
      sfx.play('confetti')
      if (this._dead) return          // 云函数往返期间页面可能已卸载
      if (!r.room) {
        /* 和 doCreate 同理：r.room 缺失时 stageOf 会在 setData 之前崩掉 */
        this.setData({ err: '进房成功但数据不完整，请再点一次' })
        return
      }
      this.setData({ room: this.safeDecorate(r.room), stage: stageOf(r.room.phase), joinCode: '' })
      this.startPoll()
    } else if (r && !r.ok) {
      this.setData({ err: r.msg || '进不去这个房间' })
    }
  },

  /**
   * 房间号卡片被点了。
   *
   * ★★ 2026-10-30 用户实测：`wx.setClipboardData` 报
   *    `api scope is not declared in the privacy agreement`
   *    —— 微信 2023 之后把剪贴板列为敏感 API，必须在「用户隐私保护指引」里声明，
   *    否则调用直接被拒。而那个声明要在公众平台后台填，代码侧无法绕过。
   *
   * 用户明确说「可以删除复制功能」，所以这里改成**引导转发**：
   * 转发走 `onShareAppMessage`（不需要任何敏感权限），对方点开自动进房，
   * 比"复制一串数字再粘贴"还省一步。房间号仍然大号显示，念给旁边人也行。
   */
  copyCode() {
    const c = this.data.room && this.data.room.code
    if (!c) return
    sfx.play('tapSoft')
    wx.showModal({
      title: '把房间号发给朋友',
      content: '点右上角 · · · → 转发给微信好友，对方点开就直接进这个房间（不用再输号）。\n\n也可以直接把 ' + c + ' 念给他。',
      confirmText: '知道了',
      showCancel: false
    })
  },

  /* ================= 开局 / 再来 ================= */

  /**
   * 记一局（2026-10-28）。
   *
   * 本地记"今晚玩了几局"，跨天自动归零 —— 酒桌上会有人问
   * "咱们今晚第几把了？"，而这个数字只有手机知道。
   *
   * ⚠️ 只记局数，不记胜负：五个玩法的 lastResult 结构各不相同
   *    （liar 有 loserName、dice 只有 winners、uw 只有 winner 是 spy/civilian），
   *    硬凑"谁喝了几杯"必然漏，而漏了不报错 —— 宁可少给一个数字，不给一个错的。
   */
  /**
   * 游戏时保持屏幕常亮（2026-10-29）。
   *
   * 酒桌上大量时间是**看着屏幕等别人**：等别人叫骰、等别人投票、等别人摇。
   * 而手机 30 秒没操作就自动锁屏 —— 锁了要重新解锁，节奏直接断。
   *
   * 所以**只在真正在玩的时候**开着（countdown / playing）；
   * lobby 和结算页关掉，省电。`reduce-motion` 那类设置不冲突。
   *
   * ⚠️ 失败要静默容错：低版本基础库没有这个 API，或系统有省电限制。
   *    这不是功能，关不掉也不该弹窗。
   */
  setKeepScreenOn(on) {
    if (this._keepOn === on) return          // 避免每次 poll 都调一遍
    this._keepOn = on
    try {
      if (typeof wx.setKeepScreenOn === 'function') {
        wx.setKeepScreenOn({ keepScreenOn: !!on, fail: () => {} })
      }
    } catch (e) {}
  },

  bumpNightCount() {
    try {
      const d = new Date()
      const today = d.getFullYear() + '-' + (d.getMonth() + 1) + '-' + d.getDate()
      const rec = wx.getStorageSync('nightGames') || {}
      const n = rec.date === today ? (Number(rec.n) || 0) : 0
      wx.setStorageSync('nightGames', { date: today, n: n + 1 })
      /* 返回"现在是今晚第几局"，结算页要显示它 */
      return n + 1
    } catch (e) { return 0 }
  },

  async doStart() {
    /*
     * 人数不够就直接说，别让请求发出去再被服务端拒 ——
     * 服务端允许单开（调试用），所以它**不会**帮我们拦这个。
     */
    /*
     * ★ 人数不再在前端拦（2026-10-28）。
     *   前端拦一道只会让"到底能不能开"有两个判据，且两边容易不同步
     *   （服务端放开了、前端还挡着，用户看到的就是"按钮点不动"）。
     *   现在：前端只是把开关状态传给服务端，**能不能开由服务端判**，
     *   被拒时用服务端的原话提示 —— 一处判据、一句话。
     */

    if (!this.specGuard()) return
    /* 点「开始」的即时反馈，不等云函数（同 doJoin） */
    sfx.play('tapSoft')
    const r = await call('room', {
      action: 'start', id: this.data.room.id,
      /* 测试期允许单人开局；服务端认这个参数，正式版把它变成 false 即可 */
      solo: !!CFG.soloTest
    }, { loading: '开始' })
      .catch((e) => {
        wx.showToast({ title: (e && e.friendly) || '开不了', icon: 'none' })
        this.resyncAfterFail()
        return null
      })
    if (r && r.ok) {
      /* ★ 走 feedback 而不是裸 sfx.play（2026-10-28）：
         裸播没有音量档位、没有震动分级，也进不了时间轴 ——
         表里定义的 `shaker` 因此一直是个**从没被触发的死动作**。 */
      feedback.fire('shaker')
      /* 记一局，并留下"今晚第几局"给结算页 */
      this.setData({ nightRound: this.bumpNightCount() })
      /* ★ stage 必须跟随服务端返回的 phase（start 之后是 countdown，不是 playing）。
         写死 'playing' 会让房主跳过倒计时、直接对着还没开始的游戏界面操作 ——
         「转盘无法转」「摇盅没反应」都是这么来的。 */
      if (this._dead) return          // 云函数往返期间页面可能已卸载
      this.setData({ room: this.safeDecorate(r.room), stage: stageOf(r.room.phase) })
      /* 房主自己也要走倒计时读秒 —— 否则只有非房主听到读秒声 */
      if (r.room.phase === 'countdown') this.startCountdown(r.room.countdownMs)
    } else if (r && !r.ok) {
      wx.showToast({ title: r.msg || '开不了', icon: 'none', duration: 2500 })
    }
  },

  /**
   * 回大厅 —— 「再来一局」和「换个玩法」是**同一个动作**，只差改不改 game。
   *
   * ★ 为什么合成一个方法：两者的服务端语义完全相同（清局内状态 → 回 lobby），
   *   拆开写就会有两份 UI 更新逻辑，漏一处就是"换了玩法但界面还是旧的"这类
   *   静默故障。这和 AGENTS.md 里记的「派生字段 7 个出口」是同一类错误。
   *
   * @param {string} [game] 要换成的玩法；不传 = 只是再来一局
   */
  async backToLobby(game) {
    /* 点「再来一局 / 换个玩法」的即时反馈，不等云函数（同 doJoin） */
    sfx.play('tapSoft')

    const payload = { action: game ? 'game' : 'again', id: this.data.room.id }
    if (game) payload.game = game
    /* 换到转盘时顺便带上当前选的场合（建房时选的那个） */
    if (game === 'wheel') payload.deck = this.data.pickDeck

    /* ★ 同 doBid：call() 失败会 throw，`.catch(() => null)` 会吞掉原因 → 点了没反应 */
    const r = await call('room', payload, { loading: game ? '换玩法' : '重开' })
      .catch((e) => {
        wx.showToast({
          title: (e && (e.friendly || e.message)) || (game ? '换不了' : '开不了新一局'),
          icon: 'none', duration: 2200
        })
        this.resyncAfterFail()
        return null
      })
    if (r && r.ok) {
      if (game === 'wheel') sfx.play('whoosh')
      else sfx.play('tap')
      if (this._dead) return          // 云函数往返期间页面可能已卸载
      /* 服务端回到 lobby；stage 从 phase 推导，不写死 */
      this.setData({
        room: this.safeDecorate(r.room),
        stage: stageOf(r.room.phase),
        result: null,
        /* 换玩法后，建房时选的那个玩法也要跟着切 —— 否则再点"开一局"会用旧玩法 */
        pickGame: r.game || this.data.pickGame
      })
      this.resetRound()
    } else if (r && !r.ok) {
      wx.showToast({ title: r.msg || (game ? '换不了' : '只有房主能开新局'), icon: 'none', duration: 2500 })
    }
  },

  doAgain() {
    /* 再来一局是界面里唯一的重操作，点了必须有声音（2026-10-28 补） */
    sfx.play('toggleOn')
    return this.backToLobby()
  },

  /*
   * 换个玩法：结算页直接选，不用退回大厅再进来。
   * 用系统 actionSheet 而不是自绘面板 —— 这是一次性的选择动作，
   * 自绘面板要多一套遮罩 + 进出动画，收益不值。
   */
  pickNewGame() {
    sfx.play('tapSoft')
    const list = GAMES.map(g => g.name)
    wx.showActionSheet({
      itemList: list,
      success: (r) => {
        const g = GAMES[r.tapIndex]
        if (g && g.k !== this.data.room.game) this.backToLobby(g.k)
      }
    })
  },

  /* 房主换玩法（只在 lobby 可用；服务端会拦"正在玩"的时候） */
  changeGame(e) {
    const k = e.currentTarget.dataset.k
    /* 点的是"已经在玩的这个" → 不出声也不动，避免"点了没反应"的错觉 */
    if (k === this.data.room.game) return
    sfx.play('toggleOn')
    this.backToLobby(k)
  },

  /* ================= 摇骰子（比大小） =================
     全流程照现实走：摇盅 → 扣盅 → 揭盅 → 骰子在桌上滚两下才停。
     每一步都有对应的声音和动画，不是"点一下出结果"。
     ================= */

  async doRoll() {
    if (!this.specGuard()) return
    /*
     * ★ 守卫不能静默（2026-10-29）。
     *   正常情况下这个按钮在"已摇"时不显示，但有两条路会让它还能被点到：
     *   · 视图层比逻辑层旧一拍（服务端已返回，界面还没重绘）
     *   · 用户在动画期间连点
     *   原来这里直接 `return` —— 用户点了毫无反应，然后报"点了没反应"。
     */
    if (this.data.rolling) {
      wx.showToast({ title: '正在摇', icon: 'none', duration: 1200 })
      return
    }
    if (this.data.myRolled) {
      wx.showToast({ title: '你这一局已经摇过了', icon: 'none', duration: 1600 })
      return
    }
    this.clearCupTimers()
    this.setData({ rolling: true })

    /* ① 摇盅：持续音 + 盅体晃动。
       现实里摇盅是 1~2 秒的事，太快没有"摇"的感觉，
       太慢会让人等得不耐烦 —— 实测 1.05 秒最像。 */
    this.setData({
      cupSrc: 'cup-shake', cupCls: 'shaking',
      cupHint: '摇盅中…', diceShown: false
    }, () => {
      if (this._dead) return
      feedback.fire('cupShake')
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
        this.resyncAfterFail()
        return null
      })

    await this.wait(1050)
    if (this._dead) return          // 摇盅这 1.05 秒里可能已经离开房间

    /* ② 扣盅 —— 整个流程的重音。
       盅砸在桌上，整屏震一下，骰子在盅里被震得跳一下（音效里带了）。 */
    this.setData({ cupSrc: 'cup-down', cupCls: 'slam', cupHint: '扣盅…' },
      () => { if (!this._dead) feedback.fire('cupSlam') })
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
    if (this._dead) return          // 云函数往返期间页面可能已卸载
    this.setData({ room: this.safeDecorate(r.room), myDice: (r.room.me && r.room.me.dice) || [] })
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
    /*
     * 抬盅的声音也要等画面（2026-10-30）：`setData` 是异步的，
     * 同步播 feedback 会让"抬盅声"早于"盅真的抬起来"几帧 —— 同 ② 的根因。
     */
    this.setData({
      cupSrc: 'cup-up', cupCls: 'lift',
      diceShown: true, cupHint: '开了！'
    }, () => {
      if (this._dead) return
      feedback.fire('cupLift')
      /* 表里 cupLift 的 haptic 是 null（抬盅不该有重震），但"手上一下轻震"
         是这个动作的确认感 —— 原来单独调 vibrate('light')，改回调时别丢掉。 */
      feedback.vibrate('light')
    })
    /*
     * 骰子落在桌上滚两下。
     *
     * ★★ 2026-10-28：这里补上"逐颗落定"的声音。
     *   视觉上五颗骰子是逐个落位的（`.cs-die` 的 animation-delay = index*90ms），
     *   而声音只有一声 diceTable —— 画面在"啪啪啪啪啪"，耳朵只听到一下，
     *   这是那种说不上来但一眼假的错位。
     *
     *   节奏直接取视觉的 90ms（改动画记得回来改这里，所以写成常量），
     *   音效延迟压成 0（`sfxDelay` 覆盖）：逐颗音本身就是那一颗的落点，
     *   再叠 90ms 的通道补偿就变成"晚于画面"了。
     */
    const DIE_DROP_MS = 90
    this._cupTimers.push(setTimeout(() => {
      feedback.fire('diceTable')
      const n = (this.data.myDice || []).length
      for (let k = 0; k < n; k++) {
        this._cupTimers.push(setTimeout(() => {
          if (this._dead) return
          /*
           * ★ 最后一颗走重音（2026-10-28）。
           *   五颗同样响的话，重音就被稀释了 —— 整轮只有最后那一下该有分量。
           */
          const last = k === n - 1
          feedback.fire(last ? 'diceSettleLast' : 'diceSettle',
            { sfxDelay: 0, hapticDelay: 0 })
        }, DIE_DROP_MS * k))
      }
      this.bump()
    }, 180))
    /* 盅提走之后留在画面外 */
    this._cupTimers.push(setTimeout(() => {
      this.setData({ cupCls: 'gone' })
    }, 520))
  },

  /** 全员摇完的结果演出 */
  showFinalResult(r) {
    /*
     * ★★ 揭晓前先来一下"悬念"（2026-10-30）。
     *
     * 大话骰点「开」时早就有这个（.gamepage.suspense = 整屏 0.1s 高频微抖），
     * 而比大小全员摇完的那一刻**直接揭盅** —— 少了"要开了"的心理准备。
     *
     * 酒桌上这个时刻是最紧张的：所有人放下手机看最后那个人。
     * 加 380ms 的 suspense 再揭，把"等"和"开"分成两拍。
     * （380ms 是试出来的：再短感觉不到，再长会急。）
     */
    this.setData({ suspense: true })
    this._cupTimers.push(setTimeout(() => {
      if (this._dead) return
      this.setData({ suspense: false })
      this.revealCup()
    }, 380))
    this._cupTimers.push(setTimeout(() => {
      if (this._dead) return
      sfx.play('impactLow', { volume: 0.5 })
      this.bump()
    }, 440))
    this._cupTimers.push(setTimeout(() => sfx.play('revealHit'), 640))

    const mySeat = (r.room.me || {}).seat
    const iWon = (r.result.winnerSeats || []).indexOf(mySeat) >= 0
    /*
     * ★ 结算反馈走 feedback.fire（2026-10-30）。
     *
     * 原来这里是自己裸调 `sfx.play(iWon ? 'confetti' : 'failDrop')` ——
     * 于是**赢和输都没有震动**，而其他三个玩法（金花/卧底/大话骰）的结算
     * 都走 fire('win' / 'penalized')，带音效 + 震动 + 延时补偿。
     * 同一个"这一局结束了"，手上有没有反馈不该看玩法。
     */
    this._cupTimers.push(setTimeout(() => {
      if (this._dead) return
      feedback.fire(iWon ? 'win' : 'penalized')
      if (iWon) this.celebrate()
    }, 1750))  /*
                * ★ 1750ms（不是 900）：revealHit 在 640ms 起、**长 1.05 秒**，
                * 要到 1690ms 才播完。900ms 起结算音 = 两个声音重叠 790ms，
                * 听感就是"糊成一片、没卡在点上"（用户 2026-10-30 的原话）。
                * 原则：**一个音效播完再起下一个**，用实测时长排，不拍脑袋。
                */

    /* ★ 连庄音：连赢的音高逐级升高（combo-1 → combo-4）。
       这是"连庄"这件事的声音表达 —— 连赢两把和赢一把听感不同，
       而且越连越高会形成"还想再来一把"的拉力。 */
    const myStreak = (r.result.streaks || {})[mySeat] || 0
    if (myStreak >= 1) {
      const comboKey = 'combo' + Math.min(4, myStreak)
      this._cupTimers.push(setTimeout(() => sfx.play(comboKey, { pitch: false }), 880))
    }

    /*
     * ★★★ 豹子专属反馈（2026-10-30）。
     *
     * 豹子 = 五颗骰子全同，概率 **1/1296** —— 整晚可能只出现一次。
     * 而在此之前它**只有一个视觉徽章**（`豹 子 · 五个 X`），
     * 声音和震动都和普通胜负一样。
     *
     * 酒桌上摇出五个一样的，全场是会炸的 —— 这个瞬间值得一个"全场最重"的反馈。
     * 这是把"稀有事件"和"普通事件"在感官上区分开，属于体验优化不是新玩法。
     *
     * 排期放在 combo 之后（880ms 起、0.9s 长），2.0s 时接上，不重叠。
     */
    if (r.result.leopardWin) {
      this._cupTimers.push(setTimeout(() => {
        if (this._dead) return
        /* 用 feedback 的动作而不是裸调 sfx —— luckyHit 这套动作
           自带「confetti 音 + double 震动」，比手拼更一致。 */
        feedback.fire('luckyHit')
      }, 2000))
    }

    this._cupTimers.push(setTimeout(() => {
      /* 双重守卫：页面可能已卸载（_dead），也可能人已经离开房间（room 被清空）。
         只判 _dead 不够 —— 后者页面还活着，但它描述的实体没了。 */
      if (this._dead || !this.data.room) return
      this.setData({ result: r.result, stage: 'over' })
    }, 1500))
  },

  /**
   * 等一段时间（Promise 版 setTimeout，让流程能写成顺序的）。
   *
   * ★ 页面卸载时要**立刻 resolve**：onUnload 会 clearTimeout 掉 _cupTimers 里的
   *   所有定时器，若不做处理，这个 Promise 就**永远不会 settle** ——
   *   `await this.wait(1050)` 之后的整段流程（以及它闭包里的页面对象）
   *   会永久挂在那里。虽然不增长、量也小，但属于"该结束却没结束"。
   *   立刻 resolve 后，调用方紧接着的 `if (this._dead) return` 就会正常收尾。
   */
  wait(ms) {
    return new Promise(resolve => {
      const t = setTimeout(resolve, ms)
      this._cupTimers.push(t)
      if (this._dead) { clearTimeout(t); resolve() }
    })
  },

  /** 屏幕震一下（关键结果时的打击感） */
  bump() {
    if (this._dead) return
    this.setData({ impact: true })
    if (this._bumpTimer) clearTimeout(this._bumpTimer)
    this._bumpTimer = setTimeout(() => {
      if (this._dead) return
      this.setData({ impact: false })
    }, 320)
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
    /*
     * ★ 按住偷看同时服务两个玩法（2026-10-30）：
     *   · 大话骰：开叫之前必须先看过自己的骰子
     *   · **比大小：摇完之后想看再看一眼**
     * 原来这里硬判 `game !== 'liar'`，于是比大小摇完就**再也看不到自己的点数** ——
     * 而"我刚才摇的是几来着"是酒桌上极常出现的一句话。
     * 两个骰子玩法在这件事上行为不一致，本身就是个 bug。
     */
    const g = this.data.room && this.data.room.game
    if (g === 'dice' && !this.data.myRolled) {
      /* 还没摇就按盅 —— 说一句，别让盅看起来坏了 */
      wx.showToast({ title: '先摇骰', icon: 'none', duration: 1400 })
      return
    }
    const canPeek = g === 'liar' || (g === 'dice' && this.data.myRolled)
    if (!canPeek) return
    if (!this.data.myDice.length) {
      /* 没骰子时按盅不吭声，用户会以为盅坏了（2026-10-29） */
      wx.showToast({ title: '骰子还没发下来', icon: 'none', duration: 1400 })
      return
    }
    this.setData({
      cupSrc: 'cup-up', cupCls: 'peek',
      diceShown: true, cupHint: '松手扣回去',
      liarReady: true          // 看过骰子之后才允许叫
    })
  },

  onCupRelease() {
    if (this.data.stage !== 'playing') return
    /* 与 onCupPress 同一判据（比大小摇完之后也能按住看） */
    const g = this.data.room && this.data.room.game
    const canPeek = g === 'liar' || (g === 'dice' && this.data.myRolled)
    if (!canPeek) return
    if (!this.data.diceShown) return
    /*
     * ★ 扣盅那一拍要有震动（2026-10-30）。
     *
     * `cupSlam` 在 feedback 表里写着 haptic: 'medium'，但这里是**裸播音效** ——
     * 表里的震动从来没有被执行过。玩家松手把盅扣回去时，手上一点反馈都没有，
     * 而这一步恰恰是"偷偷看完、赶紧盖回去"那个心虚动作的收尾。
     * （不走 feedback.fire 是因为这里要和 setData 的盅落下动画对齐，
     *   延时补偿会把人手感受到的时机推后。）
     */
    this.setData({
      cupSrc: 'cup-down', cupCls: '',
      diceShown: false,
      cupHint: this.data.liarReady ? '按住盅可以再看' : ''
    }, () => {
      /* 声音和震动放在视图更新之后 —— 与 doRoll 里的处理同一个理由：
         setData 是异步的，同步播会让"扣盅声"早于"盅真的落下"。 */
      if (this._dead) return
      sfx.play('cupSlam', { volume: 0.55 })
      feedback.vibrate('medium')
    })
  },

  /* ================= 大话骰 ================= */

  /**
   * 动作失败后立刻同步一次真实状态。
   *
   * ★ 2026-10-28。失败**往往说明本地看到的状态已经是旧的**：
   *   别人刚叫过骰、刚换过牌、刚投完票，而我的轮询还没到（最长 1.5 秒）。
   *   这时服务端回一句「只能往上叫」，如果只弹个 toast 就完事，
   *   用户面前的按钮**还是那批过期的**，于是他会对着同一个按钮连点 ——
   *   每次都失败，每次都提示，体验像是界面坏了。
   *
   *   所以：提示完立刻拉一次，把按钮更新到当前状态。
   *   这不是"重试"（不重发那个失败的请求），是"把脚下换成真实的地面"。
   */
  resyncAfterFail() {
    if (this._dead) return
    this.pollTick()
  },

  /**
   * 改自己的名字。
   *
   * 为什么值得做：这个房间**不让玩家输昵称**（进房就该一步到位，见 entry 的注释），
   * 于是没设过名字的人一律是「玩家N」。酒桌上最常发生的对话是
   * 「该谁喝」——名字对不上，这句话就说不下去。
   *
   * 一个点击 + 系统原生输入框（`wx.showModal` 的 editable，基础库 2.17.1+），
   * 不想改的人完全不受影响。
   */
  renameMe(e) {
    if (!e.currentTarget.dataset.me) return      // 只能改自己
    const room = this.data.room
    if (!room) return
    const cur = (room.me && room.me.name) || ''
    if (typeof wx.showModal !== 'function') return
    wx.showModal({
      title: '你叫什么',
      editable: true,
      placeholderText: '桌上怎么叫你',
      content: cur,
      success: async (r) => {
        if (!r.confirm) return
        const name = String(r.content || '').trim()
        if (!name) return
        if (name === cur) return
        const res = await call('room', { action: 'rename', id: room.id, name: name }, { silent: true })
          .catch((err) => {
            wx.showToast({ title: (err && err.friendly) || '没改成，再试一次', icon: 'none' })
            this.resyncAfterFail()
            return null
          })
        if (res && res.ok) {
          sfx.play('tap')
          this.applyRoom(res.room)
        }
      }
    })
  },

  async doBid(e) {
    if (!this.specGuard()) return
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
    /*
     * ★ 标签格式带了「斋」后缀（2026-10-30）：`5个4` / `5个4斋`。
     *   正则不加 `(斋?)` 的话后面全部匹配不到 → 落到下面的兜底分支 →
     *   用户点按钮"没反应"（这个坑项目里记过：取不到就静默返回是最糟的）。
     */
    const m = /^(\d+)个(\d)(斋?)$/.exec(label)

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
     * ★★ 正常叫骰也要有"嗒"一声（2026-10-30 用户报「没有游戏体验」时挖到的）。
     *
     * 原来 `sfx.play('tapSoft')` **只写在拼不出叫法的兜底分支里** ——
     * 也就是说：正常叫骰一次声音都没有，而那条提示音只在"出bug"时才响。
     *
     * 偏偏断言 ⑮（每个 bindtap 必须播声音）**照样通过** —— 它只查
     * "方法里有没有 sfx.play"，不查"正常路径上有没有"。
     * 而叫骰是一局里点得最多的操作（十几次），全静音 = 每次点击都像没点上。
     */
    sfx.play('tapSoft')

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
      action: 'bid', id: this.data.room.id, n: n, face: face, zhai: !!m[3]
    }, { silent: true }).catch((e) => {
      wx.showToast({
        title: (e && (e.friendly || e.message)) || '这一叫不行，换一个',
        icon: 'none', duration: 2200
      })
      this.resyncAfterFail()
      return null
    })
    if (r && r.ok) {
      if (this._dead) return          // 云函数往返期间页面可能已卸载
      this.setData({ room: this.safeDecorate(r.room) })
    }
  },

  /**
   * 劈：把赌注翻倍，并把回合怼回上一个叫骰的人。
   *
   * 为什么值得加：在这之前只有「叫」和「开」——有人叫了个离谱的，
   * 你除了开没有别的回应，而开是一翻两瞪眼。真实酒桌上最有火药味的
   * 一句是「劈！」，以及被劈的人回的「反劈！」。
   */
  async doPi() {
    if (!this.specGuard()) return
    if (!this.data.room) return
    /*
     * ★ 不是我的回合要给一句（2026-10-29）。
     *   正常情况下按钮只在轮到自己时渲染，但视图层可能比逻辑层旧一拍 ——
     *   那时点下去是**静默 return**，用户就是"点了没反应"。
     *   （`_uwBusy` / `_pkBusy` 这类防重入的静默是对的，别一起改。）
     */
    if (!this.data.room.myTurn) {
      wx.showToast({ title: '还没轮到你', icon: 'none', duration: 1400 })
      return
    }
    sfx.play('tap')
    const r = await call('room', { action: 'pi', id: this.data.room.id }, { silent: true })
      .catch((e) => {
        wx.showToast({ title: (e && (e.friendly || e.message)) || '劈不了', icon: 'none', duration: 2000 })
        this.resyncAfterFail()
        return null
      })
    if (r && r.ok) {
      feedback.fire('penalized')
      this.applyRoom(r.room)
    }
  },

  async doOpen() {
    /* 观战者不该能开别人的盅 —— 这是断言扫出来的真漏 */
    if (!this.specGuard()) return
    /* 开骰只有轮到自己才有意义 —— 先拦，别让玩家白等一次网络往返 */
    if (!this.data.room.myTurn) {
      sfx.play('tapSoft')
      wx.showToast({
        title: '还没轮到你，等 ' + (this.data.room.turnName || '对方') + ' 叫完',
        icon: 'none', duration: 1800
      })
      return
    }
    /*
     * 开骰是全场最紧张的一刻 —— 三段式：
     *   蓄力（自己手机上）→ 开盅重击（全场都会轮询到）→ 结果音
     *
     * ★★ 蓄力音改成**循环**（2026-10-30，用户报「揭盅声音出现时机过慢」）。
     *
     * 这条音效只有 1.2 秒，而云函数往返 0.5~2 秒：
     * 一旦超过 1.2 秒，蓄力音播完、揭盅还没来 → 中间是一段**纯沉默**。
     * 玩家听到的是"点了一下，响一声，然后没动静了" —— 感知上就是"慢半拍"。
     * 循环播放把这段空白填满，揭盅（或失败）时立刻停。
     */
    sfx.play('chargeUp', { volume: 0.6, loop: true })
    /*
     * 循环音必须有护栏：微信 callFunction 默认超时很长（20 秒），
     * 网络卡住时"蓄力音一直响"比静默更糟 —— 用户以为 App 卡死了。
     * 6 秒还没回来就停音并说一句。（定时器走 _cupTimers，离开房间能清掉。）
     */
    this._cupTimers.push(setTimeout(() => {
      if (this._dead) return
      sfx.stop('chargeUp')
      wx.showToast({ title: '网络有点慢，再等一下', icon: 'none', duration: 2000 })
    }, 6000))
    this.setData({ suspense: true })
    const r = await call('room', { action: 'open', id: this.data.room.id }, { silent: true })
      .catch((e) => {
        sfx.stop('chargeUp')          /* 失败也不能让它一直响 */
        /* 同 doBid：吞掉错误 = 点了没反应。把真实原因说出来 */
        wx.showToast({
          title: (e && (e.friendly || e.message)) || '开不了，再试一次',
          icon: 'none', duration: 2200
        })
        this.resyncAfterFail()
        return null
      })
    /* 云函数回来了 —— 无论成败都先停蓄力音，再接揭盅那一拍 */
    sfx.stop('chargeUp')
    this.setData({ suspense: false })
    if (r && r.ok) {
      if (this._dead) return          // 云函数往返期间页面可能已卸载
      /*
       * ★★ 声音/震动放进 setData 的**回调**里（2026-10-30，用户实测
       *    「揭骰盅时声音不匹配，而且感觉声音出现时机过慢」）。
       *
       * 原因：`setData` 是异步的 —— 它把数据丢给视图层后立刻返回，
       * 真正的重绘还要等下一帧甚至几帧。原来音效紧接着 setData 同步播，
       * 于是**声音先到、画面后到**：耳朵听到"开！"，眼睛还看着旧画面，
       * 等画面终于变了，声音早就过去了 —— 用户感知就是"不匹配 + 慢半拍"。
       *
       * setData 的第二个参数是"视图更新完成"回调，放这里面才是真正同一拍。
       * （这处仍刻意不走 feedback.fire —— 它和 bump() 整屏震动是同一件事，
       *   cupOpen 表里的 110ms 通道补偿会把它推到画面之后。）
       */
      this.setData({ room: this.safeDecorate(r.room), result: r.result, stage: 'over' }, () => {
        if (this._dead) return
        sfx.play('revealHit')
        this.bump()
        feedback.vibrate('heavy')
      })
      /* 两处都走 _cupTimers：裸 setTimeout 清不掉 ——
         开骰后 340ms / 900ms 内离开房间，它们仍会执行 sfx.play()，
         而此时 onUnload 的 sfx.destroy() 已清空音频池 → 重建出没人销毁的实例。 */
      /*
       * ★★★ 声音不再叠在一起（2026-10-30 用户报「声音混乱，没卡在点上」）。
       *
       * 原来这条时间线是这样：
       *     0ms    revealHit   —— **1.05 秒长**
       *   340ms    win / lose  —— 叠在 revealHit 还没播完的地方
       *   900ms    gulp       —— 再叠第三个（0.7 秒）
       * 三个声音同时响 → 听感糊成一片，谁也听不清"哪一下是哪一下"。
       *
       * 现在的原则：**一个音效播完再起下一个**（用实测时长排，不拍脑袋）：
       *     revealHit 1.05s → 结算音在 1080ms → 喝酒音在 1900ms
       * 并且把结算音的震动留在原地（触觉比听觉快，不用等声音）。
       */
      this._cupTimers.push(setTimeout(() => {
        if (this._dead) return
        feedback.vibrate('long')          /* 手上先有反馈，不等声音 */
      }, 120))
      this._cupTimers.push(setTimeout(() => {
        if (this._dead) return
        const mySeat = (r.room.me || {}).seat
        const iLost = r.result.loserSeat === mySeat
        feedback.fire(iLost ? 'lose' : 'win')
        if (!iLost) this.celebrate()
      }, 1080))                            /* revealHit(1.05s) 播完之后 */
      this._cupTimers.push(setTimeout(() => {
        if (this._dead) return
        sfx.play('gulp')
      }, 2300))                            /*
                                            * ★ 2260ms（原 1900）：
                                            * 结算音 win='confetti' 实测 **1.20 秒**，
                                            * 1080 + 1200 = 2280ms 才播完。
                                            * 原来按 0.93s（failDrop 的时长）算的 → 差 200ms，
                                            * 喝酒音会压在撒花音尾巴上。
                                            * **两个结算音时长不同，排期要按最长的那个算。**
                                            */
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
    if (!this.specGuard()) return
    if (this.data.wheelSpinning) return
    if (!this.data.room || !this.data.room.host) return

    /*
     * ★ 和 doBid 同样的坑：`call()` 业务失败时 throw，
     *   `.catch(() => null)` 把「这局还没开始」吞掉 → 点转盘**毫无反应**。
     *   必须把 e.friendly 显示出来。
     *
     * ★★ 2026-10-28 加了**乐观反馈**（用户反馈"点了像卡住"）。
     *
     *   原来是"等云函数回来才动"：点下去 → 1~2 秒什么都不发生（冷启动时更久）
     *   → 突然开始转。玩家会以为没点上，于是再点一次。
     *
     *   现在：点下去**立刻**进入"转着呢"状态（按钮禁用 + 转盘先空转一小段），
     *   云函数回来后再走正式的那一段。失败也安全 —— 把状态回滚、提示原因，
     *   玩家看到的是"转了一下但没结果"，比"完全没反应"清楚得多。
     */
    this.setData({ wheelSpinning: true })
    /* 只给一个"收到了"的轻音：正式的起转声由 playWheel 负责，
       两边都播会听到两下“起转”（第一版就这么干了） */
    sfx.play('tapSoft')
    const r = await call('room', { action: 'spin', id: this.data.room.id }, { silent: true })
      .catch((e) => {
        /* 回滚乐观状态，再把真实原因说出来 */
        if (!this._dead) this.setData({ wheelSpinning: false })
        wx.showToast({
          title: (e && (e.friendly || e.message)) || '转不了，再试一次',
          icon: 'none', duration: 2200
        })
        this.resyncAfterFail()
        return null
      })
    if (!r || !r.ok) {
      if (!this._dead) this.setData({ wheelSpinning: false })
      return
    }
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
    /*
     * ★★★ 指针在顶部 = conic-gradient 的 **0°**（12 点方向，顺时针增加）。
     *
     * 原来这里写的是 `- targetMid - 90` —— 那个 -90 是按数学坐标系
     * （0° 在 3 点方向）推的，但 CSS `conic-gradient` 的 0° 在**正上方**。
     * 于是扇区中心被转到 270°（9 点方向）而不是 0°（12 点）——
     * **整整偏了 90°**，指针永远指在隔壁扇区。
     *
     * 用户报「转盘指针指的和最终结果不符合」，根因就是这一行。
     * 这类 bug 最伤信任：玩家不会觉得是 bug，会觉得游戏在骗人。
     *
     * 验证：扇形 [from,to)、中心 mid，转 finalDeg 后位置 = (mid + finalDeg) % 360
     *   = (mid + 360*turns - targetMid) % 360 = 0° ✓ 正上方 = 指针处
     */
    const finalDeg = 360 * (spin.turns || 4) - targetMid

    this.setData({
      wheelSpinning: true,
      wheelText: '转起来了…',
      /* ★ 清掉上一张牌 —— 否则新一转还在转的时候，屏幕上留着上一题的正文，
         看起来像"这题已经抽好了"，等停下再换会有一瞬间的错位感 */
      card: null,
      wheelDeg: finalDeg
    }, () => {
      /*
       * ★ 2026-10-30 修：原来 `sfx.play('wheelStart')` 写在 setData **外面**，
       *   而 setData 是异步的（跨线程 + 视图 diff）—— 于是**盘还没开始转，
       *   "转"的声音先响了**。听感就是"声音抢在动作前面"，
       *   正是用户说的"声音没卡在点上"。
       *
       * 放进回调：视图层真的应用了 wheelDeg 之后才出声。
       * 同一个坑项目里记过（抬盅声、揭盅声），这处漏了。
       */
      if (this._dead) return
      sfx.play('wheelStart')
      /* 持续咔哒：用 tick 按递减频率排期，模拟"越转越慢" */
      this.scheduleTicks(2600)
    })

    this._wheelTimer = setTimeout(() => {
      if (this._dead) return
      this.setData({ wheelSpinning: false })
      feedback.fire('wheelStop')
      /*
       * ★ 题卡与结果**同一次 setData**。
       *   分两次设（先显示"真心话"，再显示题目）会有一帧只显示类别，
       *   而"转到真心话了 → 然后呢？"那一瞬间正是大家盯着屏幕的时候。
       */
      this.setData({ wheelText: spin.t, card: spin.card || null })
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

  /*
   * ★ 2026-10-30：确认框从 wx.showModal 换成**页面内确认卡**（同金花的弃牌/换牌）。
   *   系统弹窗是蓝白样式，与暗金主题两个世界 —— 这是页面里最后一处系统弹窗。
   *   代价是"页面状态坏了就弹不出来"，所以遮罩本身也能关（点空白处 = 取消）。
   */
  leave() {
    sfx.play('tapSoft')
    this.setData({ askLeave: true })
  },

  /** 确认卡：取消 */
  askLeaveNo() {
    sfx.play('tapSoft')
    this.setData({ askLeave: false })
  },

  /** 确认卡：确认离开 */
  async askLeaveYes() {
    this.setData({ askLeave: false })
    sfx.play('tapSoft')
    {
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
        /*
         * ★★ 必须清掉所有定时器再清 room。
         *   原来这里只 stopPoll()，**没有 clearCupTimers / clearCountdown** ——
         *   于是"结算动画那 1.5 秒内退出房间"会留下一个待触发的
         *   setTimeout(() => setData({ stage: 'over' }))；
         *   而此刻 room 已经被置 null → stage 变成 'over' 但 room 为空
         *   → over 分支访问 room.game 得到 undefined → **白屏**。
         *
         *   这是"延迟回调期间的业务状态变化"，和 `_dead` 是两件事：
         *   页面还活着（_dead=false），但**它描述的实体没了**。
         */
        this.clearCupTimers()
        this.clearCountdown()
        this.setData({ room: null, stage: 'entry', result: null, err: '' })
    }
  },

  toggleMute() {
    const m = sfx.setMuted(!this.data.muted)
    this.setData({ muted: m })
  },

  goBack() {
    /* 返回也要有声 —— 页面切换有系统过渡，但手上没反馈会像没点中 */
    sfx.play('tapSoft')
    /*
     * ★ 分享链接直达时**没有上一页**（2026-10-30）。
     *
     * 朋友点分享卡片进来，页面栈里只有房间页自己，`wx.navigateBack()`
     * 会静默失败 —— 用户点「‹ 大厅」**毫无反应**，看起来像按钮坏了。
     * 而分享是酒桌拉人的主入口，这条路遇到的概率不低。
     * 没有上一页就 reLaunch 到大厅（重新起一栈，栈里就有大厅了）。
     */
    const pages = (typeof getCurrentPages === 'function') ? getCurrentPages() : []
    if (pages.length > 1) {
      wx.navigateBack()
    } else {
      wx.reLaunch({ url: '/pages/lobby/lobby' })
    }
  }
})
