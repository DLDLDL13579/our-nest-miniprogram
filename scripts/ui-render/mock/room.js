/** 房间页 mock —— 只覆盖 entry（建房/进房）与 lobby 两个状态，够审查骨架 */
const iconSet = require('../../../miniprogram/utils/iconSet.js')
const { GAMES } = require('../../../miniprogram/utils/games.js')
const decks = require('../../../miniprogram/utils/decks.js')
const poker = require('../../../miniprogram/utils/poker.js')

const IC = iconSet.build(['speakerOn', 'speakerOff', 'bulb'], '#E8B33C')
const GAME_SWITCH = GAMES.map(g => ({ k: g.id, name: g.name, icon: g.icon, desc: g.desc }))

const PLAYERS = [
  { openid: 'a', name: '邓林', seat: 1, isMe: true, isHost: true, online: true, inRound: true, score: 0, diceCount: 5 },
  { openid: 'b', name: '倩萍', seat: 2, isMe: false, isHost: false, online: true, inRound: true, score: 0, diceCount: 5 },
  { openid: 'c', name: '老王', seat: 3, isMe: false, isHost: false, online: false, inRound: true, score: 0, diceCount: 5 }
]

/* 卧底局的四人 */
const UW_PLAYERS = [
  { openid: 'a', name: '邓林', seat: 1, isMe: true, isHost: true, online: true, inRound: true, score: 0, diceCount: 0, out: false },
  { openid: 'b', name: '倩萍', seat: 2, isMe: false, isHost: false, online: true, inRound: true, score: 0, diceCount: 0, out: false },
  { openid: 'c', name: '阿杰', seat: 3, isMe: false, isHost: false, online: true, inRound: true, score: 0, diceCount: 0, out: false },
  { openid: 'd', name: '老王', seat: 4, isMe: false, isHost: false, online: true, inRound: true, score: 0, diceCount: 0, out: false }
]

/* 三手固定的牌（用来稳定截图）：♠A ♥K ♠Q = 顺金；♦9 ♣9 ♥3 = 对 9；♠7 ♥5 ♣2 = 单张 */
const PK_PUB = { r: 12, s: 2 }                     // 底牌 ♣Q
const PK_MINE = [{ r: 13, s: 1 }, { r: 12, s: 0 }]  // 明牌 ♥K + 暗牌 ♠Q
const PK_OTHER = [{ r: 9, s: 3 }, { r: 9, s: 2 }, { r: 3, s: 1 }]
const PK_THIRD = [{ r: 7, s: 0 }, { r: 5, s: 1 }, { r: 2, s: 2 }]

/** 补上 derive 会算的派生字段，让模板里的 room.xxx 都有值 */
function pkRoom(r) {
  return Object.assign({
    id: 'r3', code: '627', count: 3,
    me: { seat: 1, name: '邓林', dice: [] },
    players: [
      { openid: 'a', name: '邓林', seat: 1, isMe: true, isHost: true, online: true, inRound: true, score: 0, diceCount: 0, out: false, drinkText: '' },
      { openid: 'b', name: '倩萍', seat: 2, isMe: false, isHost: false, online: true, inRound: true, score: 0, diceCount: 0, out: false, drinkText: '1.5 杯' },
      { openid: 'c', name: '阿杰', seat: 3, isMe: false, isHost: false, online: true, inRound: true, score: 0, diceCount: 0, out: false }
    ],
    round: 1, bid: null, lastResult: null, spin: null, deck: 'friends',
    myTurn: false, turnName: '', waitingCount: 0, waitingNames: '', options: [], uw: null,
    /*
     * ★ 这些是**前端 decorate 算的派生字段**，真实运行时一定有；
     *   mock 忘了给就会让模板里 `{{room.howList.length}}` 求值失败 →
     *   渲染器只打一条警告，那块内容在预览里凭空消失。
     *   凡是 "decorate 会补" 的字段，工厂函数都要给个默认值。
     */
    howList: [], gameName: '', spectating: false, settleFoot: '', streakText: '',
    shortBy: 0, minPlayers: 2, maxPlayers: 8
  }, r)
}

function uwRoom(r) {
  return Object.assign({
    me: { seat: 1, name: '邓林', dice: [] },
    turn: 0, round: 1, bid: null, lastResult: null, spin: null, deck: 'food',
    myTurn: false, turnName: '', waitingCount: 0, waitingNames: '', options: []
  }, r)
}

module.exports = {
  __height: 1400,
  data: () => ({
    ic: IC,
    loading: false,
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
        me: { seat: 1, name: '邓林', dice: [] },
        players: PLAYERS, count: 3, turn: 0, round: 0,
        bid: null, lastResult: null, spin: null, deck: 'friends',
        myTurn: false, turnName: '', waitingCount: 0, waitingNames: '',
        options: []
      }
    }),
    /* 开局倒计时（普通读秒 / 最后一拍） */
    cd: () => ({ stage: 'countdown', cdText: '3', cdTick: 1, room: pkRoom({ game: 'liar', phase: 'countdown', countdownMs: 2200, host: true }) }),
    cdGo: () => ({ stage: 'countdown', cdText: '开始！', cdTick: 4, room: pkRoom({ game: 'liar', phase: 'countdown', countdownMs: 200, host: true }) }),

    /* 中途加入只能观战 */
    spectate: () => ({
      stage: 'playing',
      room: pkRoom({
        game: 'poker', phase: 'playing', host: false, turn: 2, myTurn: false, turnName: '倩萍',
        spectating: true,
        poker: {
          step: 'play', publicCard: PK_PUB, publicText: poker.cardText(PK_PUB),
          myKnown: null, myKnownText: '', folded: true, aliveCount: 3, myDrink: 0,
          log: [], last: null, winner: null
        }
      })
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
      result: {
        need: 5, face: 3, actual: 5, bidderWins: true,
        loserSeat: 2, loserName: '倩萍', bidderName: '阿杰',
        allDice: [
          { name: '邓林', seat: 1, dice: [3, 5, 1, 2, 6] },
          { name: '倩萍', seat: 2, dice: [3, 4, 2, 6, 5] },
          { name: '阿杰', seat: 3, dice: [3, 1, 4, 2, 6] }
        ]
      },
      room: pkRoom({
        game: 'liar', phase: 'over', host: true, count: 3,
        players: [
          { seat: 1, name: '邓林', isMe: true, isHost: true, online: true, inRound: true, diceCount: 5 },
          { seat: 2, name: '倩萍', isMe: false, isHost: false, online: true, inRound: true, diceCount: 5 },
          { seat: 3, name: '阿杰', isMe: false, isHost: false, online: true, inRound: true, diceCount: 5 }
        ]
      })
    }),

    /* ===== 骰盅类：这两个核心界面此前**从没被预览过** ===== */

    /* 大话骰：扣盅后轮到我叫骰 */
    liarPlay: () => ({
      stage: 'playing',
      cupSrc: 'cup-down', cupCls: '', cupHint: '该你了，摇盅',
      myRolled: true, diceShown: true, rolling: false, liarReady: true,
      myDice: [3, 5, 1, 6, 3],
      room: pkRoom({
        game: 'liar', phase: 'playing', host: true, turn: 1, myTurn: true,
        turnName: '邓林', count: 3,
        bid: { bySeat: 2, byName: '倩萍', n: 3, face: 4, zhai: false },
        players: [
          { seat: 1, name: '邓林', isMe: true, isHost: true, online: true, diceCount: 5 },
          { seat: 2, name: '倩萍', isMe: false, isHost: false, online: true, diceCount: 5 },
          { seat: 3, name: '阿杰', isMe: false, isHost: false, online: true, diceCount: 5 }
        ],
        options: ['4个4', '4个5', '4个6', '5个2', '5个3', '5个4']
      })
    }),

    /* 比大小：摇盅中 */
    diceRoll: () => ({
      stage: 'playing',
      cupSrc: 'cup-shake', cupCls: 'shaking', cupHint: '摇盅中…',
      myRolled: false, diceShown: false, rolling: true,
      myDice: [],
      room: pkRoom({
        game: 'dice', phase: 'playing', host: true, turn: 0, myTurn: false,
        turnName: '', count: 3,
        players: [
          { seat: 1, name: '邓林', isMe: true, isHost: true, online: true, diceCount: 0 },
          { seat: 2, name: '倩萍', isMe: false, isHost: false, online: true, diceCount: 5 },
          { seat: 3, name: '阿杰', isMe: false, isHost: false, online: true, diceCount: 5 }
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
      const hands = names.map((n, i) => ({
        name: n, out: i > 0,
        /*
         * 牌不能重复 —— 第一版 i=0 时算出来两张 ♠Q，
         * 真实发牌（newDeck + shuffle）不会出现，但预览图会被它误导。
         */
        cardsText: [
          poker.cardText({ r: 12, s: 0 }),
          poker.cardText({ r: 12 - i, s: (i + 1) % 4 }),
          poker.cardText({ r: 9 - i, s: (i + 2) % 4 })
        ]
      }))
      return {
        stage: 'over',
        room: pkRoom({
          game: 'poker', phase: 'over', host: true, turn: 0, count: 6,
          players: names.map((n, i) => ({
            seat: i + 1, name: n, isMe: i === 0, isHost: i === 0, online: true,
            diceCount: 0, inRound: true, out: i > 0
          })),
          settleFoot: '邓林 没换过牌就赢了',
          lastResult: {
            kind: 'poker', winner: '邓林', winText: '邓林 赢',
            hands: hands
          },
          poker: {
            step: 'result', publicCard: PK_PUB, publicText: poker.cardText(PK_PUB),
            myKnown: PK_MINE[0], myKnownText: poker.cardText(PK_MINE[0]),
            folded: false, aliveCount: 1, myDrink: 0, log: [], last: null, winner: '邓林'
          }
        })
      }
    },

    /* 比大小满员 8 人：8 行骰子墙会不会超屏（比大小 max=8） */
    dice8: () => {
      const names = ['邓林', '倩萍', '阿杰', '老王', '小美', '大刘', '阿强', '胖虎']
      const ranked = names.map((n, i) => ({
        name: n, seat: i + 1, total: 6 + ((i * 7) % 25),
        dice: [((i * 3) % 6) + 1, ((i * 5) % 6) + 1, ((i * 2) % 6) + 1, ((i + 4) % 6) + 1, ((i * 4) % 6) + 1]
      })).sort((a, b) => b.total - a.total)
      return {
        stage: 'over',
        /*
         * ⚠️ `result` 在**顶层**（this.data.result），不是 room.result ——
         *    模板读的是 `wx:elif="{{room.game === 'dice' && result}}"`。
         *    第一版放进了 room 里，渲染出来整块是空的（但页面不报错）。
         */
        result: { ranked: ranked, winners: [ranked[0].name], top: ranked[0].total },
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
          uw: { step: 'vote', word: '豆浆', myDone: true, myVote: '', voteCount: 5, voterCount: 12, reveal: [], lastOut: null }
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

    /* 进房输错了号 */
    error: () => ({ joinCode: '999', err: '房间不存在或已解散' }),

    /* ---------- 梦幻金花 ---------- */
    pkMine: () => ({
      stage: 'playing',
      showCards: true,
      room: pkRoom({
        game: 'poker', phase: 'playing', host: true,
        turn: 1, myTurn: true, turnName: '邓林',
        poker: {
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
            { name: '邓林', cups: 0, out: false },
            { name: '倩萍', cups: 1.5, out: false },
            { name: '阿杰', cups: 0, out: false }
          ], log: [],
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
        poker: {
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
        game: 'poker', phase: 'playing', host: true,
        turn: 1, myTurn: true, turnName: '邓林',
        poker: {
          step: 'play', publicCard: PK_PUB, publicText: poker.cardText(PK_PUB),
          myKnown: PK_MINE[1], myKnownText: poker.cardText(PK_MINE[1]),
          folded: false, aliveCount: 2, myDrink: 1, log: [],
          last: {
            kind: 'vs', by: '倩萍', target: '阿杰',
            byCards: PK_OTHER, targetCards: PK_THIRD,
            byText: PK_OTHER.map(c => poker.cardText(c)),
            targetText: PK_THIRD.map(c => poker.cardText(c)),
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
          { name: '邓林', cards: PK_MINE, out: false },
          { name: '倩萍', cards: PK_OTHER, out: true },
          { name: '阿杰', cards: PK_THIRD, out: true }
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
          hands: [
            { name: '邓林', out: false, cardsText: ['♣Q', '♥K', '♠Q'] },
            { name: '倩萍', out: true, cardsText: ['♣Q', '♦9', '♣9'] },
            { name: '阿杰', out: true, cardsText: ['♣Q', '♠7', '♥5'] }
          ]
        },
        poker: {
          step: 'result', publicCard: PK_PUB, publicText: poker.cardText(PK_PUB),
          myKnown: PK_MINE[1], myKnownText: poker.cardText(PK_MINE[1]),
          folded: false, aliveCount: 1, myDrink: 0, log: [], last: null, winner: '邓林'
        }
      })
    }),

    /* ---------- 谁是卧底 ---------- */
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
    uwVote: () => ({
      stage: 'playing',
      showWord: false,
      room: uwRoom({
        id: 'r2', code: '418', game: 'undercover', phase: 'playing', host: true,
        players: UW_PLAYERS, count: 4,
        uw: { step: 'vote', word: '苹果', myRole: '', myVote: '', voteCount: 2, voterCount: 4, aliveCount: 4, lastOut: null, reveal: null }
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
          lastOut: { name: '老王', word: '梨', role: 'spy', tie: false, votes: 3 },
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
          lastOut: { name: '老王', word: '梨', role: 'spy', tie: false, votes: 3 },
          reveal: [
            { name: '邓林', word: '苹果', role: 'civilian', out: false },
            { name: '倩萍', word: '苹果', role: 'civilian', out: false },
            { name: '阿杰', word: '苹果', role: 'civilian', out: false },
            { name: '老王', word: '梨', role: 'spy', out: true }
          ]
        }
      })
    })
  }
}
