/** 房间页 mock —— 只覆盖 entry（建房/进房）与 lobby 两个状态，够审查骨架 */
const iconSet = require('../../../miniprogram/utils/iconSet.js')
const { GAMES } = require('../../../miniprogram/utils/games.js')
const decks = require('../../../miniprogram/utils/decks.js')

const IC = iconSet.build(['speakerOn', 'speakerOff', 'bulb'], '#E8B33C')
const GAME_SWITCH = GAMES.map(g => ({ k: g.id, name: g.name, icon: g.icon, desc: g.desc }))

const PLAYERS = [
  { openid: 'a', name: '邓林', seat: 1, isMe: true, isHost: true, online: true, inRound: true, score: 0, diceCount: 5 },
  { openid: 'b', name: '倩萍', seat: 2, isMe: false, isHost: false, online: true, inRound: true, score: 0, diceCount: 5 },
  { openid: 'c', name: '老王', seat: 3, isMe: false, isHost: false, online: false, inRound: true, score: 0, diceCount: 5 }
]

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
        id: 'r1', code: '352', game: 'liar', phase: 'lobby', host: true,
        me: { seat: 1, name: '邓林', dice: [] },
        players: PLAYERS, count: 3, turn: 0, round: 0,
        bid: null, lastResult: null, spin: null, deck: 'friends',
        myTurn: false, turnName: '', waitingCount: 0, waitingNames: '',
        options: []
      }
    }),
    /* 进房输错了号 */
    error: () => ({ joinCode: '999', err: '房间不存在或已解散' })
  }
}
