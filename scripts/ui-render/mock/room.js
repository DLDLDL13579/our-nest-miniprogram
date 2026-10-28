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
      { openid: 'a', name: '邓林', seat: 1, isMe: true, isHost: true, online: true, inRound: true, score: 0, diceCount: 0, out: false },
      { openid: 'b', name: '倩萍', seat: 2, isMe: false, isHost: false, online: true, inRound: true, score: 0, diceCount: 0, out: false },
      { openid: 'c', name: '阿杰', seat: 3, isMe: false, isHost: false, online: true, inRound: true, score: 0, diceCount: 0, out: false }
    ],
    round: 1, bid: null, lastResult: null, spin: null, deck: 'friends',
    myTurn: false, turnName: '', waitingCount: 0, waitingNames: '', options: [], uw: null
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
          folded: false, aliveCount: 3, myDrink: 0, log: [],
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
