/*
 * ⚠️⚠️ 关于这份 mock 的一个硬道理（2026-10-28 用两次翻车换来）
 *
 * 它是**静态数据**，而真机的每个字段都是 room.js 按状态算出来的。
 * 所以 mock 有两种错法，都会让截图变成"假界面"：
 *
 *   ① **少字段** —— `hands` 缺 `cards` 时，金花结算页一个牌面都没有，
 *      看起来像真机的 bug（实际真机有）。
 *   ② **状态之间不自洽** —— `cupHint` 写死"该你了，摇盅"，而同一个界面
 *      又有叫骰按钮 → 截图看上去像"叫我去摇盅但明明已经摇过了"的矛盾。
 *
 * 判据：**截图只能证明"布局对不对"，不能证明"文案/数据对不对"。**
 * 文案和派生字段的正确性由 JS 逻辑（和 test-room-ui 的断言）负责。
 * 看截图发现"某个字不对"时，先去 room.js 查它是怎么算的，
 * 别直接改 mock 就当修好了。
 */

/** 房间页 mock —— 只覆盖 entry（建房/进房）与 lobby 两个状态，够审查骨架 */
const iconSet = require('../../../miniprogram/utils/iconSet.js')
const { GAMES } = require('../../../miniprogram/utils/games.js')
const decks = require('../../../miniprogram/utils/decks.js')
const poker = require('../../../miniprogram/utils/poker.js')

const IC = iconSet.build(['speakerOn', 'speakerOff', 'bulb'], '#E8B33C')
const GAME_SWITCH = GAMES.map(g => ({ k: g.id, name: g.name, icon: g.icon, desc: g.desc }))

/*
 * ★★★ 转盘扇区**直接从真实源码抽取**（2026-10-29）。
 *
 * 原来这里手抄了一份扇区表，跟 room.js 的 SECTORS 早就漂了：
 *   · 大冒险权重写 22（真实 20）、免罚写 4（真实 6）
 *   · key 写成 youdrink/medrink/alldrink（真实 you/me/both）
 *   · 颜色还停在改版前的糖果色
 * → 所有转盘截图都是"假界面"。现在从 room.js 原样抽取，永远同步。
 */
const _fs = require('fs')
const _path = require('path')
const REAL_SECTORS = (function () {
  const src = _fs.readFileSync(_path.join(__dirname, '../../../miniprogram/game/room/room.js'), 'utf8')
  const i = src.indexOf('const SECTORS = [')
  if (i < 0) return []
  const j = src.indexOf(']', i) + 1
  try { return eval('(' + src.slice(i + 'const SECTORS = '.length, j) + ')') } catch (e) { return [] }
})()

/* 与 room.js 的 buildSectors 同一套算法（含 0.5deg 金色分隔线） */
function buildWheel() {
  const sec = REAL_SECTORS
  const total = sec.reduce((a, x) => a + x.weight, 0)
  let acc = 0
  const stops = [], list = []
  sec.forEach((x, i) => {
    const deg = x.weight / total * 360
    const from = acc, to = acc + deg
    stops.push(x.color + ' ' + from.toFixed(2) + 'deg ' + to.toFixed(2) + 'deg')
    if (i < sec.length - 1) {
      stops.push('rgba(232,179,60,.62) ' + to.toFixed(2) + 'deg ' + (to + 0.7).toFixed(2) + 'deg')
    }
    const mid = (from + to) / 2
    const rad = (mid - 90) * Math.PI / 180
    list.push({
      k: x.k, t: x.t, color: x.color, i: i,
      lx: 50 + Math.cos(rad) * (deg < 28 ? 38 : 33),
      ly: 50 + Math.sin(rad) * (deg < 28 ? 38 : 33),
      small: deg < 28
    })
    acc = to
  })
  return { gradient: 'conic-gradient(' + stops.join(',') + ')', list: list }
}

const PLAYERS = [
  { openid: 'a', name: '邓林', initial: '邓', seat: 1, isMe: true, isHost: true, online: true, inRound: true, score: 0, diceCount: 5 },
  { openid: 'b', name: '倩萍', initial: '倩', seat: 2, isMe: false, isHost: false, online: true, inRound: true, score: 0, diceCount: 5 },
  { openid: 'c', name: '老王', initial: '老', seat: 3, isMe: false, isHost: false, online: false, inRound: true, score: 0, diceCount: 5 }
]

/* 卧底局的四人 */
const UW_PLAYERS = [
  { openid: 'a', name: '邓林', initial: '邓', seat: 1, isMe: true, isHost: true, online: true, inRound: true, score: 0, diceCount: 0, out: false },
  { openid: 'b', name: '倩萍', initial: '倩', seat: 2, isMe: false, isHost: false, online: true, inRound: true, score: 0, diceCount: 0, out: false },
  { openid: 'c', name: '阿杰', initial: '阿', seat: 3, isMe: false, isHost: false, online: true, inRound: true, score: 0, diceCount: 0, out: false },
  { openid: 'd', name: '老王', initial: '老', seat: 4, isMe: false, isHost: false, online: true, inRound: true, score: 0, diceCount: 0, out: false }
]

/* 三手固定的牌（用来稳定截图）：♠A ♥K ♠Q = 顺金；♦9 ♣9 ♥3 = 对 9；♠7 ♥5 ♣2 = 单张 */
const PK_PUB = { r: 12, s: 2 }                     // 底牌 ♣Q
const PK_MINE = [{ r: 13, s: 1 }, { r: 12, s: 0 }]  // 明牌 ♥K + 暗牌 ♠Q
const PK_OTHER = [{ r: 9, s: 3 }, { r: 9, s: 2 }, { r: 3, s: 1 }]
const PK_THIRD = [{ r: 7, s: 0 }, { r: 5, s: 1 }, { r: 2, s: 2 }]

/** 补上 derive 会算的派生字段，让模板里的 room.xxx 都有值 */

/*
 * 把 ["4个4", ...] 转成模板真正用的对象数组 [{n,face,zhai,label}]。
 *
 * ★ 2026-10-30：模板在加「斋」功能时改成了 `item.label` / `item.n`，
 *   而 mock 里还是纯字符串 —— 于是**叫骰按钮全部空白**（渲染图里是 4 个灰块），
 *   而真机上是有字的。这是"真实代码改了、mock 没跟着改"的又一例。
 */
function optLabels(arr) {
  return arr.map(l => {
    const m = /^(\d+)个(\d)(斋?)$/.exec(l)
    return m ? { n: +m[1], face: +m[2], zhai: !!m[3], label: l } : { n: 0, face: 0, zhai: false, label: l }
  })
}

function pkRoom(r) {
  return Object.assign({
    /*
     * ★ 派生字段的默认值（2026-10-30 补）。
     * `soloOk` 控制"人数不够时"显示「先自己试试」还是「这个玩法至少要 N 人」——
     * mock 里没给，于是**所有截图都走 `!soloOk` 分支**，等于从没验证过另一半。
     */
    soloOk: true,
    shortBy: 0,
    /*
     * ★★ 2026-11-03：**规则弹层的内容**。
     *
     *   模板读 `room.howList`（由 decorate 从 `games.js` 的 `how` 生成），
     *   而 mock 从来没给过它 —— 于是所有"看规则"的截图里
     *   **弹层只有标题和「知道了」按钮，规则列表是空的**。
     *
     *   这类"mock 缺字段"会让截图变成假界面（AGENTS.md 记过多次），
     *   而这次我等了两轮才在渲染图上注意到。
     */
    /*
     * ★ 2026-11-02：这三个 room 级字段 mock 缺，导致 8 个状态渲染报错 ——
     *   真机安全（模板对 undefined.length 静默为假），但**那几块区域从没被渲染验证过**：
     *   · myCards      —— "已加 N 条 · 抽得到" + 自定义题列表（服务端 shape:802）
     *   · poker.drinks —— 金花每人换牌喝了多少
     *   · nightDrinkList —— 今晚酒量条
     */
    myCards: [],
    nightDrinkList: [],
    // ★ 2026-11-02：金花「可比的人」数量。mock 缺它会永远渲染成「只有你一个人」
    pkTargetCount: 2,
    // ★ 2026-11-02：大话骰起叫下限（没叫过时）。mock 缺它会渲染成「从 个起叫」
    openNeedN: 3,
    /*
     * ★★★ 图片源必须有默认值（2026-10-30 第四次踩同一个坑）。
     *
     * 模板写的是 `src="/game/images/cup/{{cupSrc}}.png"` ——
     * cupSrc 为 undefined 时路径变成 `/game/images/cup/.png` → **破图**，
     * 而且不报错。我给单个 mock 状态补过三次 cupSrc，每次都是下一个状态又忘。
     *
     * 现在在 pkRoom 的默认值里统一给 —— 所有状态自动继承。
     */
    wheelGradient: 'conic-gradient(#9E4029 0deg 79.2deg, #3F5A7A 79.2deg 151.2deg, #573E7A 151.2deg 216deg, #36654C 216deg 266.4deg, #8C6226 266.4deg 309.6deg, #7D3549 309.6deg 338.4deg, #3F6579 338.4deg 360deg)',
    wheelDeg: 0,
    /* 今晚战况（decorate 派生；mock 里给默认值，否则截图会缺这一行） */
    nightDrinks: {}, nightDrinkList: [],
    id: 'r3', code: '627', count: 3,
    me: { seat: 1, name: '邓林', initial: '邓', dice: [] },
    players: [
      { openid: 'a', name: '邓林', initial: '邓', seat: 1, isMe: true, isHost: true, online: true, inRound: true, score: 0, diceCount: 0, out: false, drinkText: '' },
      { openid: 'b', name: '倩萍', initial: '倩', seat: 2, isMe: false, isHost: false, online: true, inRound: true, score: 0, diceCount: 0, out: false, drinkText: '1.5 杯' },
      { openid: 'c', name: '阿杰', initial: '阿', seat: 3, isMe: false, isHost: false, online: true, inRound: true, score: 0, diceCount: 0, out: false }
    ],
    round: 1, bid: null, lastResult: null, spin: null, deck: 'friends',
    myTurn: false, turnName: '', waitingCount: 0, waitingNames: '', options: [], uw: null,
    /*
     * ★ 这些是**前端 decorate 算的派生字段**，真实运行时一定有；
     *   mock 忘了给就会让模板里 `{{room.howList.length}}` 求值失败 →
     *   渲染器只打一条警告，那块内容在预览里凭空消失。
     *   凡是 "decorate 会补" 的字段，工厂函数都要给个默认值。
     */
    /*
     * ⚠️ 2026-11-03：`howList` 原来写死 `[]` —— 于是所有「看规则」的截图里
     *   弹层只有标题和按钮，**规则列表是空的**。而它是 decorate 从
     *   `games.js` 的 `how` 生成的，mock 应该用真实注册表。
     */
    howList: (require('../../../miniprogram/utils/games.js').GAMES.filter(function (x) {
      return x.id === (r.game || 'liar')
    })[0] || { how: [] }).how,
    gameName: '', spectating: false, settleFoot: '', streakText: '',
    shortBy: 0, minPlayers: 2, maxPlayers: 8
  }, r)
}

function uwRoom(r) {
  return Object.assign({
    me: { seat: 1, name: '邓林', initial: '邓', dice: [] },
    turn: 0, round: 1, bid: null, lastResult: null, spin: null, deck: 'food',
    myTurn: false, turnName: '', waitingCount: 0, waitingNames: '', options: [],
    /* ★ 2026-11-03：规则列表也要给（和 pkRoom 同理）——
       卧底状态原来没有，于是「看规则」的截图全是空的。 */
    howList: require('../../../miniprogram/utils/games.js').GAMES.filter(function (x) {
      return x.id === 'undercover'
    })[0].how,
    nightDrinkList: [], myCards: [], confetti: []
  }, r)
}

/*
 * ★ 2026-11-02：兜底 —— 任何状态的 room 缺这几个数组字段时补空，
 *   免得每加一个 mock 状态就漏一次（这已经是第 5 次漏同类字段了）。
 */
const _origStates = {}

module.exports = {
  __height: 1400,
  data: () => ({
    ic: IC,
    loading: false,
    /*
     * ★★★ 页面级变量默认值（2026-10-30，第四次因为缺它破图）。
     * 模板写的是 `src="/game/images/cup/{{cupSrc}}.png"`，
     * 而 `cupSrc` 是**页面 data** 上的字段（不是 room.cupSrc）。
     * 缺了它路径就变成 `/game/images/cup/.png` → 破图，且不报错。
     * 之前给单个状态补过三次，每次下一个状态又忘 —— 现在放默认值，全体继承。
     */
    cupSrc: 'cup-down', cupCls: '', diceShown: false, diceRolling: false,
    /*
     * ★ 2026-11-02：这几个页面级字段 mock 一直没有，导致 **45 个渲染状态全部报**
     *   `confetti.length → Cannot read properties of undefined`。
     *   真机上它们是安全的（`data` 里有默认 `[]`，小程序对 undefined.length 静默为假），
     *   但**渲染图里这些区块从来没显示过** —— 撒花特效、金花手牌区缩略、
     *   事件流、今晚酒量条，全是黑盒。
     *
     *   mock 的意义是复刻真实数据；缺字段 = 那块永远验证不到。
     */
    confetti: [], myCards: [], events: [], nightDrinkList: [],
    stage: 'entry',
    room: null,
    games: GAME_SWITCH,
    myName: '',
    pickGame: 'liar',
    pickGameName: '大话骰',
    decks: decks.DECKS,
    pickDeck: 'friends',
    joinCode: '',
    err: '',
    muted: false,
    netTip: ''
  }),
  states: {
    /* 等人齐 */
    lobby: () => ({
      stage: 'lobby',
      room: {
        gameName: '大话骰',
        howList: GAMES.filter(g => g.id === 'liar')[0].how,
        id: 'r1', code: '352', game: 'liar', phase: 'lobby', host: true,
        me: { seat: 1, name: '邓林', initial: '邓', dice: [] },
        players: PLAYERS, count: 3, turn: 0, round: 0, locked: false,
        bid: null, lastResult: null, spin: null, deck: 'friends',
        myTurn: false, turnName: '', waitingCount: 0, waitingNames: '',
        options: []
      }
    }),
    /*
     * 新人视角：朋友点分享进来、房间还没开局、自己不是房主。
     * 这是**拉新转化的第一屏** —— 他知不知道要等？知不知道房主是谁？
     */
    /* 超长名字：12 个字 + 房主/我/掉线三枚标签，验证不撑破 */
    /* 转到喝酒类扇区（没有题卡，只有提示 + 酒杯图标） */
    wheelDrink: () => {
      const base = buildWheel()
      return {
        stage: 'playing',
        wheelSectors: base.list,
        wheelGradient: base.gradient,
        wheelDeg: 1234,
        wheelDur: 2700,
        wheelSpinning: false,
        wheelText: '喝一杯',
        cupIcon: require('../../../miniprogram/utils/icons.js').dataUri('cup', '#C4553F'),
        decks: decks.DECKS,
        room: pkRoom({ game: 'wheel', phase: 'playing', host: true, count: 3, gameName: '命运转盘' })
      }
    },

    /* 最长自定义题卡（60 字上限）—— 验证不会把转盘和按钮挤出屏幕 */
    wheelLongCard: () => {
      const base = buildWheel()
      return {
        stage: 'playing',
        wheelSectors: base.list,
        wheelGradient: base.gradient,
        wheelDeg: 1234,
        wheelDur: 2700,
        wheelSpinning: false,
        wheelText: '大冒险',
        /*
         * ★★★ 2026-11-02：这里原来手写了一条 60 字的**假题**
         *   「用一句话形容在场每个人今天的状态不能重复形容词说完之后…」
         *   —— 渲染图上它是一整段没有标点的长句，我差点去改题卡的折行样式。
         *
         *   而真实题卡库里**最长只有 28 字**，全是带标点的正常中文。
         *   也就是说：这条"极端值"造的极限，**产品里根本不存在**，
         *   它唯一的作用是让我对着一个假问题改真代码。
         *
         *   现在取真实题卡库里最长的那一条 —— 既仍然是"最长"这个边界条件，
         *   又是真实会出现的字符串。
         */
        card: {
          type: 'dare', deck: 'friends', deckName: '朋友聚会',
          text: decks.DECKS
            .filter(d => d.k === 'friends')
            .map(d => [].concat(d.truth || [], d.dare || []))
            .reduce((a, b) => a.concat(b), [])
            .sort((a, b) => b.length - a.length)[0]
        },
        decks: decks.DECKS,
        room: pkRoom({ game: 'wheel', phase: 'playing', host: true, count: 3, gameName: '命运转盘' })
      }
    },

    longName: () => ({
      stage: 'lobby',
      room: pkRoom({
        game: 'liar', phase: 'lobby', host: true, count: 3, gameName: '大话骰',
        howList: GAMES.filter(g => g.id === 'liar')[0].how,
        players: [
          { seat: 1, name: '一二三四五六七八九十甲乙', initial: '一', isMe: true, isHost: true, online: false, diceCount: 0 },
          { seat: 2, name: '短名字', initial: '短', isMe: false, isHost: false, online: true, diceCount: 0 },
          { seat: 3, name: '另一个也很长的名字啊', initial: '另', isMe: false, isHost: false, online: true, diceCount: 0 }
        ]
      })
    }),

    lobbyGuest: () => ({
      stage: 'lobby',
      room: pkRoom({
        game: 'liar', phase: 'lobby', host: false, count: 3,
        gameName: '大话骰',
        howList: GAMES.filter(g => g.id === 'liar')[0].how,
        players: [
          { seat: 1, name: '倩萍', initial: '倩', isMe: false, isHost: true, online: true, diceCount: 0 },
          { seat: 2, name: '邓林', initial: '邓', isMe: true, isHost: false, online: true, diceCount: 0 },
          { seat: 3, name: '阿杰', initial: '阿', isMe: false, isHost: false, online: true, diceCount: 0 }
        ]
      })
    }),

    /* 开局倒计时（普通读秒 / 最后一拍） */
    cd: () => ({ nightRound: 1, stage: 'countdown', cdText: '2', cdTick: 1, room: pkRoom({ game: 'liar', phase: 'countdown', countdownMs: 2000, host: true }) }),
    /* 第 3 局开局：验「今晚第 N 局」的文案拼接 */
    cdRound3: () => ({ nightRound: 3, stage: 'countdown', cdText: '2', cdTick: 1, room: pkRoom({ game: 'dice', phase: 'countdown', countdownMs: 2000, host: true }) }),
    cdGo: () => ({ stage: 'countdown', cdText: '开始', cdTick: 4, room: pkRoom({ game: 'liar', phase: 'countdown', countdownMs: 200, host: true }) }),
    /* 倒计时走完却没进游戏（网络断了）—— 兜底出口应该出现 */
    cdStuck: () => ({ stage: 'countdown', cdText: '开始', cdTick: 4, cdStuck: true, room: pkRoom({ game: 'liar', phase: 'countdown', countdownMs: 200, host: true }) }),

    /* 中途加入只能观战 */
    spectate: () => ({
      stage: 'playing',
      room: pkRoom({
        game: 'poker', phase: 'playing', host: false, turn: 2, myTurn: false, turnName: '倩萍',
        spectating: true,
        poker: { drinks: [],
          step: 'play', publicCard: PK_PUB, publicText: poker.cardText(PK_PUB),
          myKnown: null, myKnownText: '', folded: true, aliveCount: 3, myDrink: 0,
          last: null, winner: null
        }
      })
    }),

    /*
     * 上线状态：soloTest 关闭（单人不能开局）→ 少人时应该显示**可点的"叫人来"**，
     * 而不是灰色的"还差 N 个人"。2026-10-30 改的。
     */
    soloOffline: () => ({
      stage: 'lobby', soloTest: false,
      room: pkRoom({
        game: 'liar', phase: 'lobby', host: true, count: 1,
        shortBy: 2, soloOk: true, minPlayers: 3, soloMinPlayers: 2,
        players: [{ openid: 'a', name: '邓林', initial: '邓', seat: 1, isMe: true, isHost: true, online: true, inRound: true, score: 0, diceCount: 0, out: false }]
      })
    }),

    /*
     * 人数不够，但这个玩法**支持单人开局**（soloOk=true）→ 应该显示「先自己试试」
     * 2026-10-30 加的：以前 mock 没给 soloOk，这个分支从没被渲染过。
     */
    soloCanStart: () => ({
      stage: 'lobby',
      /* 页面级开关（不在 room 里）：决定"人数不够"时是否有"先自己试试"这个入口 */
      soloTest: true,
      room: pkRoom({
        game: 'liar', phase: 'lobby', host: true, count: 1,
        shortBy: 2, soloOk: true, minPlayers: 3, soloMinPlayers: 2,
        players: [{ openid: 'a', name: '邓林', initial: '邓', seat: 1, isMe: true, isHost: true, online: true, inRound: true, score: 0, diceCount: 0, out: false }]
      })
    }),

    /*
     * 人数不够，且这个玩法**单人玩不转**（soloOk=false）→ 应该显示「至少要 N 人」
     */
    soloCantStart: () => ({
      stage: 'lobby',
      /* 页面级开关（不在 room 里）：决定"人数不够"时是否有"先自己试试"这个入口 */
      soloTest: true,
      room: pkRoom({
        game: 'undercover', phase: 'lobby', host: true, count: 1,
        shortBy: 2, soloOk: false, minPlayers: 3, soloMinPlayers: 3,
        players: [{ openid: 'a', name: '邓林', initial: '邓', seat: 1, isMe: true, isHost: true, online: true, inRound: true, score: 0, diceCount: 0, out: false }]
      })
    }),

    /*
     * 三个**弹层**状态（2026-10-30 补）。
     * 之前 mock 里完全没有 askLeave / cardPanel / howOpen 的取值，
     * 这三个弹层在离线渲染里**一次都没被看到过** —— 而它们都是全屏遮罩，
     * 一旦样式出错（比如没盖满、按钮点不到）就是死路。
     */
    leaveAsk: () => ({
      stage: 'playing', askLeave: true,
      room: pkRoom({ game: 'liar', phase: 'playing', host: true, count: 3,
        myTurn: true, shortBy: 0, soloOk: true })
    }),

    cardPanelOpen: () => ({
      stage: 'playing', cardPanel: true, cardType: 'truth',
      /* 来自真实题库（decks.DECKS 里 friends 的第 1 条真心话）——
     2026-11-02 之前这里是手写的假题，和题库完全对不上 */
      cardText: decks.DECKS.filter(d => d.k === 'friends')[0].truth[0],
      room: pkRoom({ game: 'wheel', phase: 'playing', host: true, count: 3,
        shortBy: 0, soloOk: true })
    }),

    howOpen: () => ({
      stage: 'lobby', howOpen: true,
      /*
       * ★ 2026-11-03：`shortBy` 原来是 1 —— 而 `shortBy = max(0, minPlayers - count)`，
       *   3 人局 vs 最少 2 人应该是 **0**（人已经够了）。
       *   而界面上"人够了"和"还差 1 人"是**两个互斥的按钮**，写错会让截图自相矛盾。
       */
      room: pkRoom({ game: 'liar', phase: 'lobby', host: true, count: 3,
        shortBy: 0, soloOk: true, minPlayers: 2 })
    }),

    /* 单人房：人数不够，开始按钮应该说"还差 N 个人" */
    alone: () => ({
      stage: 'lobby',
      room: pkRoom({
        game: 'liar', phase: 'lobby', host: true, count: 1,
        gameName: '大话骰', minPlayers: 2, maxPlayers: 8, shortBy: 1,
        players: [UW_PLAYERS[0]],
        howList: GAMES.filter(g => g.id === 'liar')[0].how
      })
    }),

    /* 大话骰开盅结算：命中高亮的预览 */
    liarOver: () => ({
      stage: 'over',
      nightRound: 3,
      pkDrinks: 0,
      result: {
        need: 5, face: 3, actual: 5, bidderWins: true, gap: 0,
        loserSeat: 2, loserName: '倩萍', bidderName: '阿杰',
        allDice: [
          { name: '邓林', initial: '邓', seat: 1, dice: [3, 5, 1, 2, 6] },
          { name: '倩萍', initial: '倩', seat: 2, dice: [3, 4, 2, 6, 5] },
          { name: '阿杰', initial: '阿', seat: 3, dice: [3, 1, 4, 2, 6] }
        ]
      },
      room: pkRoom({
        game: 'liar', phase: 'over', host: true, count: 3,
        /* 今晚战况（decorate 会排好序；这里直接给排好的） */
        nightDrinks: { '倩萍': 2, '邓林': 1 },
        nightDrinkList: [{ name: '倩萍', cups: 2 }, { name: '邓林', cups: 1 }],
        players: [
          { seat: 1, name: '邓林', initial: '邓', isMe: true, isHost: true, online: true, inRound: true, diceCount: 5 },
          { seat: 2, name: '倩萍', initial: '倩', isMe: false, isHost: false, online: true, inRound: true, diceCount: 5 },
          { seat: 3, name: '阿杰', initial: '阿', isMe: false, isHost: false, online: true, inRound: true, diceCount: 5 }
        ]
      })
    }),

    /*
     * 斋开 + 围骰的结算（2026-10-30）。
     * 专门用一个状态覆盖三处新改动：①「叫的是 N 个（斋 · 1 不算）」
     * ② 斋里 1 不高亮 ③ 围骰那盅标「围骰 +1」。
     */
    /* 吹炸了：叫 8 个实际 3 个 —— 专门验"吐槽行"（2026-11-02 调研落地） */
    liarBlowup: () => ({
      stage: 'over', room: pkRoom({ game: 'liar', phase: 'over', host: true }),
      result: {
        need: 8, face: 6, actual: 3, bidderWins: false, gap: -5,
        loserName: '倩萍', bidderName: '倩萍', mult: 1, cups: 1,
        allDice: [
          { name: '邓林', seat: 1, dice: [6, 2, 6, 1, 4] },
          { name: '倩萍', seat: 2, dice: [3, 5, 6, 1, 2] },
          { name: '阿杰', seat: 3, dice: [2, 4, 1, 6, 5] }
        ]
      }
    }),
    liarZhaiOver: () => ({
      stage: 'over',
      nightRound: 4,
      pkDrinks: 0,
      result: {
        need: 6, face: 4, zhai: true, actual: 6, bidderWins: true, gap: 0,
        loserSeat: 2, loserName: '倩萍', bidderName: '阿杰',
        allDice: [
          { name: '邓林', initial: '邓', seat: 1, dice: [4, 1, 4, 2, 6], leopard: false },
          /* 五颗全同 → 围骰 +1（这一盅贡献 6 而不是 5） */
          { name: '倩萍', initial: '倩', seat: 2, dice: [4, 4, 4, 4, 4], leopard: true },
          { name: '阿杰', initial: '阿', seat: 3, dice: [4, 1, 5, 3, 2], leopard: false }
        ]
      },
      room: pkRoom({
        game: 'liar', phase: 'over', host: true, count: 3,
        nightDrinks: { '倩萍': 3, '邓林': 1 },
        nightDrinkList: [{ name: '倩萍', cups: 3 }, { name: '邓林', cups: 1 }],
        players: [
          { seat: 1, name: '邓林', initial: '邓', isMe: true, isHost: true, online: true, inRound: true, diceCount: 5 },
          { seat: 2, name: '倩萍', initial: '倩', isMe: false, isHost: false, online: true, inRound: true, diceCount: 5 },
          { seat: 3, name: '阿杰', initial: '阿', isMe: false, isHost: false, online: true, inRound: true, diceCount: 5 }
        ]
      })
    }),

    /*
     * 比大小：我已摇完，还差 1 个人（2026-10-30 加的"揭晓进度"就出现在这一刻）。
     * 这是酒桌上最有气氛的一刻 —— 所有人都盯着最后一个没摇的人。
     */
    diceAlmost: () => ({
      stage: 'playing',
      myRolled: true, diceShown: false, rolling: false,
      cupSrc: 'cup-down', cupCls: '',
      myDice: [6, 3, 5, 2, 4],
      room: pkRoom({
        game: 'dice', phase: 'playing', host: true, count: 3,
        count: 3,
        waitingCount: 1, waitingNames: '阿杰',
        waitingText: '等 阿杰 摇',
        players: [
          { seat: 1, name: '邓林', initial: '邓', isMe: true, isHost: true, online: true, inRound: true, diceCount: 5 },
          { seat: 2, name: '倩萍', initial: '倩', isMe: false, isHost: false, online: true, inRound: true, diceCount: 5 },
          { seat: 3, name: '阿杰', initial: '阿', isMe: false, isHost: false, online: true, inRound: true, diceCount: 0 }
        ]
      })
    }),

    /*
     * 转盘停在「免罚一次」（最后一个扇区，index=6）。
     * 专门用来肉眼核对：**指针（12 点）+ 停下的扇区 + 下面的文字**三者是否一致。
     * 2026-10-30 修了 90° 偏移的 bug，这个状态就是那次的验收画面。
     */
    wheelLandedPass: () => ({
      stage: 'playing',
      wheelSpinning: false,
      /* finalDeg = 360*4 - mid，pass 的 mid=349.2 → 1090.8 */
      wheelDeg: 1090.8,
      wheelText: '免罚一次',
      card: null,
      /* 模板用的是 wheelGradient（整串 conic-gradient），不是 wheelStops */
      wheelGradient: 'conic-gradient(#9E4029 0.00deg 79.20deg, #3F5A7A 79.20deg 151.20deg, #573E7A 151.20deg 216.00deg, #36654C 216.00deg 266.40deg, #8C6226 266.40deg 309.60deg, #7D3549 309.60deg 338.40deg, #3F6579 338.40deg 360.00deg)',
      wheelLabels: [
        { t: '真心话', x: 0, y: 0, r: 39.6 }, { t: '大冒险', x: 0, y: 0, r: 115.2 },
        { t: '喝一杯', x: 0, y: 0, r: 183.6 }, { t: '你喝', x: 0, y: 0, r: 241.2 },
        { t: '我喝', x: 0, y: 0, r: 288 }, { t: '一起喝', x: 0, y: 0, r: 324 },
        { t: '免罚一次', x: 0, y: 0, r: 349.2 }
      ],
      room: pkRoom({
        /* ★ 2026-11-03：转盘 1 人就能玩，`minPlayers` 必须显式设 1 ——
           否则会落进 `pkRoom` 的默认值 2，于是 shortBy(0) 和 min-count(1) 自相矛盾。 */
        game: 'wheel', phase: 'playing', host: true, count: 1, minPlayers: 1, shortBy: 0,
        players: [{ seat: 1, name: '邓林', initial: '邓', isMe: true, isHost: true, online: true, inRound: true }]
      })
    }),

    /* ===== 骰盅类：这两个核心界面此前**从没被预览过** ===== */

    /* 大话骰：扣盅后轮到我叫骰 */
    liarPlay: () => ({
      stage: 'playing',
      /* 事件流：别人刚做了什么（2026-10-28 加，见 room.wxss 的 .evstrip） */
      events: [{ id: 'e2', text: '倩萍 叫 3 个 4' }],
      /*
       * ⚠️ cupHint 在真机上是**按状态算的**（room.js）：
       *   没摇 → 「该你了，摇盅！」；摇了 → 「已扣盅，等其他人摇完」。
       *   这里原本写死「该你了，摇盅」而同一个界面又有叫骰按钮 ——
       *   截图看上去像"叫我去摇盅，可明明已经摇过了"的矛盾。
       *   **mock 的文案是硬编码的，不代表真机**，但截图里看起来一样，
       *   所以状态之间要自洽。
       */
      cupSrc: 'cup-down', cupCls: '', cupHint: '已扣盅，等其他人摇完',
      myRolled: true, diceShown: true, rolling: false, liarReady: true,
      myDice: [3, 5, 1, 6, 3],
      room: pkRoom({
        game: 'liar', phase: 'playing', host: true, turn: 1, myTurn: true,
        turnName: '邓林', count: 3,
        bid: { bySeat: 2, byName: '倩萍', n: 3, face: 4, zhai: false, mult: 2, piBy: '阿杰' },
        players: [
          { seat: 1, name: '邓林', initial: '邓', isMe: true, isHost: true, online: true, diceCount: 5 },
          { seat: 2, name: '倩萍', initial: '倩', isMe: false, isHost: false, online: true, diceCount: 5 },
          { seat: 3, name: '阿杰', initial: '阿', isMe: false, isHost: false, online: true, diceCount: 5 }
        ],
        options: optLabels(['4个4', '4个5', '4个6', '5个2', '5个3', '5个4'])
      })
    }),

    /*
     * 大话骰开局第一手：**还没偷看** + **不是我的回合**。
     * 这是真机上最常出现的画面（几个人刚开局，谁还没轮到时都在看这一屏），
     * 而之前没有任何 mock 状态覆盖它 —— 2026-10-29 补上，
     * 用来验证「先按住盅偷看」与「等谁叫完就轮到你」两条信息能同时读到。
     */
    liarCold: () => ({
      stage: 'playing',
      events: [],
      /* cupHint 必须与 myRolled 自洽：已扣盅的人看到的应该是"等其他人"，
         而不是"先按住盅看看"（那句会和下方的金色引导重复，且与真实算值不符）。 */
      cupSrc: 'cup-down', cupCls: '', cupHint: '已扣盅，等其他人摇完',
      myRolled: true, diceShown: false, rolling: false, liarReady: false,
      myDice: [3, 5, 1, 6, 3],
      room: pkRoom({
        game: 'liar', phase: 'playing', host: false, turn: 3, myTurn: false,
        /*
         * ★★ 2026-11-03：`turn` 原来是 2 —— 而 `bid.bySeat` 也是 2（倩萍刚叫完）。
         *   3 人局里"自己叫完又轮到自己"是不可能的，界面上就会显示
         *   「倩萍 叫的 1个1」+「等 倩萍 叫」这种自相矛盾的组合。
         *   叫完应该轮到下一个人（seat 3 阿杰）。
         */
        turnName: '阿杰', count: 3,
        bid: { bySeat: 2, byName: '倩萍', n: 1, face: 1, zhai: false, mult: 1 },
        players: [
          { seat: 1, name: '邓林', initial: '邓', isMe: true, isHost: false, online: true, diceCount: 5 },
          { seat: 2, name: '倩萍', initial: '倩', isMe: false, isHost: true, online: true, diceCount: 5 },
          { seat: 3, name: '阿杰', initial: '阿', isMe: false, isHost: false, online: true, diceCount: 5 }
        ],
        /* ⚠️ 没偷看也要有可叫项：真机 decorate 一律算 options（引导而不是上锁），
           这里留空数组会让「叫一个」下面空一大截 —— mock 自己造出来的假布局。 */
        options: optLabels(['2个2', '2个3', '2个4', '2个5', '3个1', '3个2'])
      })
    }),

    /* 比大小：摇盅中 */
    /* 单骰（五颗全不同）：验「重摇」按钮（2026-11-02 按真实规则加的） */
    diceSingle: () => ({
      stage: 'playing', myRolled: true, diceShown: true,
      myDice: [1, 2, 3, 4, 6],
      room: pkRoom({
        game: 'dice', phase: 'playing', host: true, count: 2, canReroll: true,
        bid: null,
        me: { seat: 1, name: '邓林', dice: [1, 2, 3, 4, 6], rerollCount: 0 },
        players: [
          { seat: 1, name: '邓林', isMe: true, isHost: true, online: true, dice: [1, 2, 3, 4, 6], diceCount: 5, rerollCount: 0 },
          { seat: 2, name: '倩萍', isMe: false, online: true, dice: [], diceCount: 0 }
        ]
      })
    }),
    diceRoll: () => ({
      stage: 'playing',
      cupSrc: 'cup-shake', cupCls: 'shaking', cupHint: '摇盅中…',
      myRolled: false, diceShown: false, rolling: true,
      myDice: [],
      room: pkRoom({
        game: 'dice', phase: 'playing', host: true, turn: 0, myTurn: false,
        turnName: '', count: 3,
        players: [
          { seat: 1, name: '邓林', initial: '邓', isMe: true, isHost: true, online: true, diceCount: 0 },
          { seat: 2, name: '倩萍', initial: '倩', isMe: false, isHost: false, online: true, diceCount: 5 },
          { seat: 3, name: '阿杰', initial: '阿', isMe: false, isHost: false, online: true, diceCount: 5 }
        ]
      })
    }),

    /* 金花满员 6 人摊牌：6 行牌面会不会挤（金花 max=6） */
    pk6: () => {
      const names = ['邓林', '倩萍', '阿杰', '老王', '小美', '大刘']
      /*
       * ★ 必须走 poker.cardText() 生成牌面文字，不能自己拼 `花色 + 数字`：
       *   直拼会显示成「♥12」，而真实界面是「♥Q」——
       *   这种 mock 失真会让我误判"牌面太宽放不下"之类根本不存在的问题。
       * （真实数据里 cardsText 就是服务端用 cardText 生成的。）
       */
      /*
       * ★★ 2026-11-03：**用真正的发牌函数生成**（`dealDream` + `fullHand` + `rank`）。
       *
       *   原来手写的 `cards: [{ r: 14 - i, ... }]` 有三个问题：
       *     ① `14 - i` 在 i=0 时给 r=14 —— **A 是 13，牌值越界**
       *     ② **没有 `handName`** —— 结算页那一列牌型名是空的
       *     ③ 三张牌是"自己、自己、自己"，**没有公共牌** ——
       *        而金花的规则是「公共牌 + 私有 2 张」，每人都该有那张公共牌
       *
       *   而 mock 一旦和真实规则脱节，我看图就会误判"牌型名没显示是不是模板问题"。
       */
      const dealt = poker.dealDream(names.length)
      const hands = names.map((n, i) => {
        const full = poker.fullHand(dealt.publicCard, dealt.hands[i])
        const rk = poker.rank(full)
        return {
          name: n, out: i > 0,
          handName: rk.name,
          cards: full,
          cardsText: full.map(c => poker.cardText(c))
        }
      })
      return {
        stage: 'over',
        room: pkRoom({
          game: 'poker', phase: 'over', host: true, turn: 0, count: 6,
          players: names.map((n, i) => ({
            seat: i + 1, name: n, initial: String(n).charAt(0), isMe: i === 0, isHost: i === 0, online: true,
            diceCount: 0, inRound: true, out: i > 0
          })),
          settleFoot: '邓林 没换过牌就赢了',
          lastResult: {
            kind: 'poker', winner: '邓林', winText: '邓林 赢',
            hands: hands
          },
          poker: { publicCard: dealt.publicCard, drinks: [], 
            step: 'result',
            /* ★ 2026-11-03：必须用 `dealt.publicCard`，不能再用模块级的 `PK_PUB` ——
               否则**结算的牌（用 dealt 生成）和界面显示的公共牌（PK_PUB）不是同一张**，
               于是每人的 cards 里都找不到那张"公共牌"。 */
            publicCard: dealt.publicCard, publicText: poker.cardText(dealt.publicCard),
            myKnown: PK_MINE[0], myKnownText: poker.cardText(PK_MINE[0]),
            myKnownRed: /[♥♦]/.test(poker.cardText(PK_MINE[0])),
            folded: false, aliveCount: 1, myDrink: 0, last: null, winner: '邓林'
          }
        })
      }
    },

    /* 比大小满员 8 人：8 行骰子墙会不会超屏（比大小 max=8） */
    /* 撒花（赢家那一刻的庆祝）—— 单独一个状态，因为它是一次性的 */
    diceWin: () => {
      const base = (function () {
        const names = ['邓林', '倩萍', '老王']
        return {
          confetti: Array.from({ length: 20 }, (_, i) => i),
          result: {
            /*
             * ★★ 2026-11-03：排名也改成用真实的 `rankPlayers` 算。
             *   原来 `total` / `hand` / `handName` 三个字段是**手写编的**
             *   （`26 - i * 7`），而 `dice` 是另一套公式 —— **两边对不上**
             *   （倩萍的 total 写 19、实际 24；老王写 12、实际 15）。
             *
             *   `rankPlayers` 会一次算全：total / hand / handName / rankKey。
             */
            /* 邓林：五条（五个 6）· 老王：两对 · 倩萍：一对 —— 都必须是 5 颗 */
            ranked: require('../../../miniprogram/utils/dicerank.js').rankPlayers([
              { name: names[0], seat: 1, dice: [6, 6, 6, 6, 6] },
              { name: names[1], seat: 2, dice: [3, 5, 3, 5, 2] },
              { name: names[2], seat: 3, dice: [2, 3, 2, 5, 4] }
            ]).ranked,
            winners: ['邓林'], top: 30, topHand: '五条', handicapWin: true, handicapFace: 6,
            leopardWin: true, leopardFace: 6
          }
        }
      })()
      base.result.topDice = base.result.ranked[0].dice
      base.result.restRanked = base.result.ranked.slice(1)
      base.stage = 'over'
      base.room = pkRoom({
        game: 'dice', phase: 'over', host: true, count: 3,
        players: ['邓林', '倩萍', '老王'].map((n, i) => ({
          seat: i + 1, name: n, isMe: i === 0, isHost: i === 0, online: true,
          diceCount: 5, inRound: true, out: false
        }))
      })
      return base
    },

    dice8: () => {
      const names = ['邓林', '倩萍', '阿杰', '老王', '小美', '大刘', '阿强', '胖虎']
      /*
       * ★★ 2026-11-03：**用真实的 rankPlayers 生成排名**。
       *
       *   原来这里是手写的 `total: 6 + ((i * 7) % 25)` ——
       *   而比大小早就从"比总点数"改成了**比牌型**，所以：
       *     · `total` 是凭空编的（和 dice 数组对不上）
       *     · **没有 `handName`** → 结算页那一列牌型名一直是空的
       *
       *   现在用 `dicerank.rankPlayers` 算，和线上同一套逻辑。
       */
      const dicerank = require('../../../miniprogram/utils/dicerank.js')
      const fakeDice = [
        [4, 6, 3, 6, 5], [2, 2, 3, 5, 1], [6, 6, 6, 2, 1], [1, 1, 1, 1, 3],
        [5, 5, 2, 3, 4], [3, 3, 3, 3, 3], [2, 4, 6, 1, 5], [6, 5, 4, 3, 2]
      ]
      const rk8 = dicerank.rankPlayers(names.map((n, i) => ({
        name: n, seat: i + 1, dice: fakeDice[i]
      })))
      const ranked = rk8.ranked
      return {
        stage: 'over',
        /*
         * ⚠️ `result` 在**顶层**（this.data.result），不是 room.result ——
         *    模板读的是 `wx:elif="{{room.game === 'dice' && result}}"`。
         *    第一版放进了 room 里，渲染出来整块是空的（但页面不报错）。
         */
        result: {
          ranked: ranked, winners: [ranked[0].name], top: ranked[0].total,
          /* 英雄区用（decorate 里算，mock 要手工给） */
          topDice: ranked[0].dice,
          restRanked: ranked.slice(1)
        },
        room: pkRoom({
          game: 'dice', phase: 'over', host: true, turn: 0, count: 8,
          players: names.map((n, i) => ({
            seat: i + 1, name: n, isMe: i === 0, isHost: i === 0, online: true,
            diceCount: 5, inRound: true, out: false
          }))
        })
      }
    },

    /* 卧底满员 12 人：座位条与投票列表会不会挤爆 */
    /* 我自己还没投：应显示「轮到你投了」，而不是「还差 N 人」 */
    /* 12 人房间（卧底的最大人数）：验玩家列表 + 规则 + 按钮会不会挤爆 */
    /* 小屏（iPhone SE）：验紧凑布局 */
    compactPk: () => {
      const s = module.exports.states.pkMine()
      s.compact = true
      return s
    },
    compactLiar: () => {
      const s = module.exports.states.liarPlay()
      s.compact = true
      return s
    },
    lobby12: () => {
      const names = ['邓林', '倩萍', '阿杰', '老王', '小美', '大刘',
                     '阿强', '胖虎', '晓雯', '老陈', '阿凯', '小鱼']
      const players = names.map((n, i) => ({
        seat: i + 1, name: n, isMe: i === 0, isHost: i === 0, online: i !== 3,
        diceCount: 0, inRound: true, out: false
      }))
      return {
        stage: 'lobby',
        room: pkRoom({
          id: 'r12', code: '512', game: 'undercover', phase: 'lobby', host: true,
          count: 12, players: players, gameName: '谁是卧底',
          minPlayers: 3, shortBy: 0, openNeedN: 12
        })
      }
    },
    uwNotVoted: () => {
      const names = ['邓林', '倩萍', '阿杰', '老王', '小美', '大刘']
      const players = names.map((n, i) => ({
        seat: i + 1, name: n, isMe: i === 0, isHost: i === 0, online: true,
        diceCount: 0, inRound: true, out: false
      }))
      return {
        stage: 'playing',
        room: uwRoom({
          id: 'r4', code: '902', game: 'undercover', phase: 'playing', host: true,
          count: 6, players: players, gameName: '谁是卧底',
          uw: { step: 'vote', word: '豆浆', aliveCount: 6, myVote: '', voteCount: 5, voterCount: 6,
                iVoted: false, waitingCount: 1, waitingNames: ['老王'], reveal: [], lastOut: null }
        })
      }
    },
    uw12: () => {
      const names = ['邓林', '倩萍', '阿杰', '老王', '小美', '大刘', '阿强', '胖虎', '晓雯', '老陈', '阿凯', '小鱼']
      const players = names.map((n, i) => ({
        seat: i + 1, name: n, isMe: i === 0, isHost: i === 0, online: true,
        diceCount: 0, inRound: true, out: false
      }))
      return {
        stage: 'playing',
        room: uwRoom({
          id: 'r3', code: '815', game: 'undercover', phase: 'playing', host: true,
          count: 12, players: players, gameName: '谁是卧底',
          uw: { step: 'vote', word: '豆浆', aliveCount: 12, myVote: '', voteCount: 10, voterCount: 12, iVoted: true, waitingCount: 2, waitingNames: ['老王', '小美'], reveal: [], lastOut: null }
        })
      }
    },

    /* 断线态（连续失败 3 次以上） */
    netdown: () => ({
      stage: 'lobby',
      netTip: '连接断了，正在自动重连',
      netDown: true,
      room: pkRoom({ game: 'liar', phase: 'lobby', host: true, gameName: '大话骰' })
    }),

    /* 页面级 loading */
    entering: () => ({ loading: true, stage: 'entry' }),
    /* 进房遮罩等久了（5 秒后）—— 兜底出口该出现 */
    enteringSlow: () => ({ loading: true, loadingSlow: true, stage: 'entry' }),

    /* 进房输错了号 */
    error: () => ({ joinCode: '999', err: '房间不存在或已解散' }),

    /* ---------- 梦幻金花 ---------- */
    /*
     * 金花：**不是我的回合**（等别人决定）。
     * 这是 5-6 人局里最常停留的一屏，而之前没有状态覆盖它 ——
     * 2026-10-29 补上，用来验证等待提示是否说清了"在等什么/轮到我能做什么"。
     */
    pkWait: () => ({
      stage: 'playing',
      showCards: false,
      room: pkRoom({
        game: 'poker', phase: 'playing', host: false,
        turn: 2, myTurn: false, turnName: '倩萍',
        poker: { drinks: [], 
          step: 'play', publicCard: PK_PUB, publicText: poker.cardText(PK_PUB),
          myKnown: PK_MINE[1], myKnownText: poker.cardText(PK_MINE[1]),
          hintText: poker.handHint(PK_PUB, PK_MINE[1]),
          folded: false, aliveCount: 3, myDrink: 0,
          drinks: [
            { name: '邓林', initial: '邓', cups: 0, out: false },
            { name: '倩萍', initial: '倩', cups: 0.5, out: false },
            /* 造一个已出局的人 —— 否则"出局"标记这条视觉永远没被验证过 */
            { name: '阿杰', initial: '阿', cups: 1.5, out: true }
          ],
          /*
           * 造一条"上一步"的比牌记录 —— 等待界面用 `last` 显示"刚才发生了什么"。
           * 之前这里是 null，于是渲染图下半屏一片空白，看起来像"等待时什么都不显示"，
           * 实际是 **mock 缺数据造成的假界面**（AGENTS.md 记过同一类坑）。
           */
          last: {
            kind: 'vs', by: '阿杰', target: '倩萍', winner: '倩萍',
            /* ★ 2026-10-30：mock 原来写 byText/targetText，而服务端返回的是
               byCards/targetCards —— **mock 的这个假字段盖住了一次真 bug**
               （比牌记录那三张牌一直是空的）。mock 必须只用真实字段。 */
            byCards: [{s:0,r:13},{s:0,r:11},{s:1,r:4}],
            targetCards: [{s:0,r:13},{s:0,r:12},{s:1,r:4}],
            noteText: '阿杰 比牌输了 倩萍，出局', at: Date.now() - 4000
          },
          winner: null
        }
      })
    }),

    /* 金花确认卡（2026-10-29 把 wx.showModal 换成页面内确认）：弃牌那一刻 */
    pkAskFold: () => ({
      stage: 'playing',
      showCards: true,
      pkAsk: { kind: 'fold' },
      room: pkRoom({
        game: 'poker', phase: 'playing', host: true,
        turn: 1, myTurn: true, turnName: '邓林',
        poker: { drinks: [], 
          step: 'play', publicCard: PK_PUB, publicText: poker.cardText(PK_PUB),
          myKnown: PK_MINE[1], myKnownText: poker.cardText(PK_MINE[1]),
          hintText: poker.handHint(PK_PUB, PK_MINE[1]),
          folded: false, aliveCount: 3, myDrink: 0,
          drinks: [
            { name: '邓林', initial: '邓', cups: 0, out: false },
            { name: '倩萍', initial: '倩', cups: 1.5, out: false },
            { name: '阿杰', initial: '阿', cups: 0, out: false }
          ], last: null, winner: null
        }
      })
    }),

    pkMine: () => ({
      stage: 'playing',
      showCards: true,
      room: pkRoom({
        game: 'poker', phase: 'playing', host: true,
        turn: 1, myTurn: true, turnName: '邓林',
        poker: { drinks: [], 
          step: 'play', publicCard: PK_PUB, publicText: poker.cardText(PK_PUB),
          myKnown: PK_MINE[1], myKnownText: poker.cardText(PK_MINE[1]),
          /* 牌型提示走真实函数算，保证和线上一致 */
          hintText: poker.handHint(PK_PUB, PK_MINE[1]),
          folded: false, aliveCount: 3, myDrink: 0,
          /* 公开信息：谁换过几次牌（喝了几杯） */
          /*
           * ⚠️ 渲染器**不执行页面的 decorate()**，所以这里要直接写
           *   decorate 算出来的结果（drinkText）—— 否则界面上什么都不显示，
           *   而真实运行是对的。这类 mock 与逻辑的重复是渲染器的固有局限。
           */
          drinks: [
            { name: '邓林', initial: '邓', cups: 0, out: false },
            { name: '倩萍', initial: '倩', cups: 1.5, out: false },
            { name: '阿杰', initial: '阿', cups: 0, out: false }
          ],
          last: null, winner: null
        }
      })
    }),
    pkHidden: () => ({
      stage: 'playing',
      showCards: false,
      room: pkRoom({
        game: 'poker', phase: 'playing', host: true,
        turn: 2, myTurn: false, turnName: '倩萍',
        poker: { drinks: [], 
          step: 'play', publicCard: PK_PUB, publicText: poker.cardText(PK_PUB),
          myKnown: PK_MINE[1], myKnownText: poker.cardText(PK_MINE[1]),
          folded: false, aliveCount: 3, myDrink: 0.5, log: [],
          last: null, winner: null
        }
      })
    }),
    pkLast: () => ({
      stage: 'playing',
      showCards: false,
      room: pkRoom({
          players: [
            { seat: 1, name: '邓林', initial: '邓', isMe: true, isHost: true, online: true, out: false },
            { seat: 2, name: '倩萍', initial: '倩', isMe: false, isHost: false, online: true, out: false },
            { seat: 3, name: '阿杰', initial: '阿', isMe: false, isHost: false, online: true, out: true }
          ],
        game: 'poker', phase: 'playing', host: true,
        turn: 1, myTurn: true, turnName: '邓林',
        poker: { drinks: [], 
          step: 'play', publicCard: PK_PUB, publicText: poker.cardText(PK_PUB),
          myKnown: PK_MINE[1], myKnownText: poker.cardText(PK_MINE[1]),
          /*
           * ★ 2026-11-03：`aliveCount` 说 2 人活着，而 `players` 用的是默认值
           *   （三个人全 out:false）—— 补一个出局的，两处才对得上。
           */
          folded: false, aliveCount: 2, myDrink: 1, log: [],
          last: {
            kind: 'vs', by: '倩萍', target: '阿杰',
            byCards: PK_OTHER, targetCards: PK_THIRD,
            /* 同上：用真实字段（对象数组），不是 cardText 字符串 */
            byCards: PK_OTHER,
            targetCards: PK_THIRD,
            winner: '倩萍', tie: false,
            byType: poker.rank(PK_OTHER).name, targetType: poker.rank(PK_THIRD).name
          },
          winner: null
        }
      })
    }),
    pkOver: () => ({
      stage: 'over',
      showCards: false,
      result: {
        kind: 'poker', winner: '邓林',
        hands: [
          { name: '邓林', initial: '邓', cards: PK_MINE, out: false },
          { name: '倩萍', initial: '倩', cards: PK_OTHER, out: true },
          { name: '阿杰', initial: '阿', cards: PK_THIRD, out: true }
        ]
      },
      room: pkRoom({
        game: 'poker', phase: 'over', host: true, turn: 0, myTurn: false, turnName: '',
        settleFoot: '你为了换牌喝了 1.5 杯',
        streaks: { 1: 3, 2: 0, 3: 0 },
        streakText: '邓林 连赢 3 把',
        loserBoard: '倩萍 今晚已经输了 4 局',
        lastResult: {
          kind: 'poker', winner: '邓林',
          winText: '邓林 赢',
          /*
           * ★ 2026-10-28 补 `cards`：真机的 `hands` 里既有 cards（含 s/r，用来画牌面）
           *   也有 cardsText（文字）。mock 原来只给了 cardsText，于是结算页
           *   截图里**一个牌面都没有** —— 我差点以为是真机的 bug。
           *   mock 少的字段会让截图变成"假界面"，这类漏要在 mock 侧补齐。
           */
          hands: [
            { name: '邓林', initial: '邓', out: false, handName: '对子 Q',
              cards: [{ r: 12, s: 2 }, { r: 13, s: 1 }, { r: 12, s: 0 }],
              cardsText: ['♣Q', '♥K', '♠Q'] },
            { name: '倩萍', initial: '倩', out: true, handName: '对子 9',
              cards: [{ r: 12, s: 2 }, { r: 9, s: 3 }, { r: 9, s: 2 }],
              cardsText: ['♣Q', '♦9', '♣9'] },
            { name: '阿杰', initial: '阿', out: true, handName: '单张 Q',
              cards: [{ r: 12, s: 2 }, { r: 7, s: 0 }, { r: 5, s: 1 }],
              cardsText: ['♣Q', '♠7', '♥5'] }
          ]
        },
        /*
         * ★★ 2026-11-03：**显式给 players 的 out 标记**。
         *   原来 `pkOver` 没写 `players`，用的是默认值（三个人全 out:false）——
         *   而有 `result.hands[].out` 是对的（倩萍、阿杰已出局），
         *   于是同一页里两套 out 不一致：`aliveCount: 1` 说只剩邓林，列表里三个人都活着。
         */
        players: [
          { seat: 1, name: '邓林', initial: '邓', isMe: true, isHost: true, online: true, out: false },
          { seat: 2, name: '倩萍', initial: '倩', isMe: false, isHost: false, online: true, out: true },
          { seat: 3, name: '阿杰', initial: '阿', isMe: false, isHost: false, online: true, out: true }
        ],
        poker: { drinks: [], 
          step: 'result', publicCard: PK_PUB, publicText: poker.cardText(PK_PUB),
          myKnown: PK_MINE[1], myKnownText: poker.cardText(PK_MINE[1]),
          folded: false, aliveCount: 1, myDrink: 0, last: null, winner: '邓林'
        }
      })
    }),

    /* ---------- 谁是卧底 ---------- */
    /*
     * 命运转盘（playing）—— 2026-10-28 补。
     *
     * ★ 为什么之前没有：这个界面**从来没被离线渲染验证过**。
     *   而它是 5 个玩法之一，用户真机截图里的问题（指针像贴纸、
     *   中心按钮像圆片）我在本地一次都看不到。
     *   补上之后，转盘的每次改动才有"眼睛"。
     */
    wheel: () => {
      const w = buildWheel()
      return {
        stage: 'playing',
        wheelSectors: w.list,
        wheelGradient: w.gradient,
        wheelDeg: 0,
        wheelDur: 2700,
        wheelSpinning: false,
        wheelText: '转一下，看看今晚谁喝',
        decks: decks.DECKS,
        room: pkRoom({
          game: 'wheel', phase: 'playing', host: true, count: 3, dealDeck: 'friends',
          gameName: '命运转盘', howList: GAMES.filter(g => g.id === 'wheel')[0].how, myCards: [],
          minPlayers: 1, maxPlayers: 8, shortBy: 0
        })
      }
    },

    /* 转到真心话、题卡已经抽出来的那一刻（最该看的一屏） */
    wheelCard: () => {
      const base = buildWheel()
      return {
        stage: 'playing',
        wheelSectors: base.list,
        wheelGradient: base.gradient,
        wheelDeg: 1234,
        wheelDur: 2700,
        wheelSpinning: false,
        wheelText: '真心话',
        card: { type: 'truth', deck: 'friends', deckName: '朋友聚会',
          text: decks.DECKS.filter(d => d.k === 'friends')[0].truth[0] },
        decks: decks.DECKS,
        room: pkRoom({
          game: 'wheel', phase: 'playing', host: true, count: 3, deck: 'friends',
          gameName: '命运转盘', howList: GAMES.filter(g => g.id === 'wheel')[0].how, myCards: [],
          minPlayers: 1, maxPlayers: 8, shortBy: 0
        })
      }
    },

    uwTalk: () => ({
      stage: 'playing',
      showWord: false,
      room: uwRoom({
        id: 'r2', code: '418', game: 'undercover', phase: 'playing', host: true,
        players: UW_PLAYERS, count: 4,
        uw: { step: 'talk', word: '苹果', myRole: '', myVote: '', voteCount: 0, voterCount: 4, aliveCount: 4, lastOut: null, reveal: null }
      })
    }),
    /* 按住看词的那一刻 —— 这是本玩法最重要的一个状态 */
    uwSee: () => ({
      stage: 'playing',
      showWord: true,
      room: uwRoom({
        id: 'r2', code: '418', game: 'undercover', phase: 'playing', host: true,
        players: UW_PLAYERS, count: 4,
        uw: { step: 'talk', word: '苹果', myRole: '', myVote: '', voteCount: 0, voterCount: 4, aliveCount: 4, lastOut: null, reveal: null }
      })
    }),
    /* 投票（第二轮：上一轮已有人出局，界面要带上那条记忆线索） */
    uwVote: () => ({
      stage: 'playing',
      showWord: false,
      room: uwRoom({
        id: 'r2', code: '418', game: 'undercover', phase: 'playing', host: true,
        players: UW_PLAYERS.map(p => p.name === '倩萍' ? Object.assign({}, p, { out: true }) : p),
        count: 4,
        uw: {
          step: 'vote', word: '苹果', myRole: '', myVote: '', voteCount: 1, voterCount: 3,
          aliveCount: 3, waitingCount: 1, waitingNames: ['老王'],
          lastOut: { name: '倩萍', role: 'good', word: '橘子', ballots: [] },
          reveal: null
        }
      })
    }),
    /*
     * 平票重投（2026-10-28 新规则）：第一次平票不淘汰，让平票的人补一句。
     * 这块界面是新增的，必须单独渲染一张看 —— 它包含"平票是谁 / 接下来做什么 /
     * 再平票什么后果"三层信息，最容易写成一段看不懂的文字。
     */
    uwTie: () => ({
      stage: 'playing',
      showWord: false,
      room: uwRoom({
        id: 'r2', code: '418', game: 'undercover', phase: 'playing', host: true,
        players: UW_PLAYERS, count: 4,
        uw: {
          step: 'talk', word: '苹果', myRole: '', myVote: '', voteCount: 0, voterCount: 4,
          aliveCount: 4, lastOut: null, reveal: null,
          tieBreak: true, tieNames: '倩萍、阿杰'
        }
      })
    }),
    /* 决胜投票：同一批人，提示语必须比普通投票更硬 */
    uwRunoff: () => ({
      stage: 'playing',
      showWord: false,
      room: uwRoom({
        id: 'r2', code: '418', game: 'undercover', phase: 'playing', host: true,
        players: UW_PLAYERS, count: 4,
        uw: {
          step: 'vote', word: '苹果', myRole: '', myVote: '', voteCount: 1, voterCount: 4, waitingCount: 3, waitingNames: ['老王', '阿杰'],
          aliveCount: 4, lastOut: null, reveal: null,
          tieBreak: true, tieNames: ''
        }
      })
    }),
    uwResult: () => ({
      stage: 'playing',
      showWord: false,
      room: uwRoom({
        id: 'r2', code: '418', game: 'undercover', phase: 'playing', host: true,
        /* 出局揭示时对比自己的词 —— 这是 decorate 写在 room 上的派生字段 */
        uwCompare: '你的词是「苹果」',
        players: UW_PLAYERS.map(p => p.name === '老王' ? Object.assign({}, p, { out: true }) : p), count: 4,
        uw: {
          step: 'result', word: '苹果', myRole: '', myVote: 'c', voteCount: 0, voterCount: 4, aliveCount: 3,
          lastOut: {
            name: '老王', initial: '老', word: '梨', role: 'spy', tie: false, votes: 3,
            ballots: [
              { by: '邓林', to: '老王' }, { by: '倩萍', to: '老王' },
              { by: '阿杰', to: '老王' }, { by: '老王', to: '倩萍' }
            ]
          },
          reveal: null
        }
      })
    }),
    uwOver: () => ({
      stage: 'over',
      result: { kind: 'undercover', winner: 'civilian', civilianWord: '苹果', spyWord: '梨' },
      room: uwRoom({
        id: 'r2', code: '418', game: 'undercover', phase: 'over', host: true,
        settleFoot: '卧底是 老王',
        players: UW_PLAYERS.map(p => p.name === '老王' ? Object.assign({}, p, { out: true }) : p), count: 4,
        uw: {
          step: 'result', word: '苹果', myRole: '', myVote: 'c', voteCount: 0, voterCount: 4, aliveCount: 3,
          lastOut: {
            name: '老王', initial: '老', word: '梨', role: 'spy', tie: false, votes: 3,
            ballots: [
              { by: '邓林', to: '老王' }, { by: '倩萍', to: '老王' },
              { by: '阿杰', to: '老王' }, { by: '老王', to: '倩萍' }
            ]
          },
          reveal: [
            { name: '邓林', initial: '邓', word: '苹果', role: 'civilian', out: false },
            { name: '倩萍', initial: '倩', word: '苹果', role: 'civilian', out: false },
            { name: '阿杰', initial: '阿', word: '苹果', role: 'civilian', out: false },
            { name: '老王', initial: '老', word: '梨', role: 'spy', out: true }
          ]
        }
      })
    })
  }
}
