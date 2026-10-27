/** 大厅 mock */
const iconSet = require('../../../miniprogram/utils/iconSet.js')
const { GAMES } = require('../../../miniprogram/utils/games.js')

const IC = iconSet.build(['speakerOn', 'speakerOff', 'hapticOn', 'hapticOff', 'chevronRight'], '#E8B33C')

const LIST = GAMES.map(g => ({
  id: g.id, name: g.name, desc: g.desc, color: g.color, cat: g.cat,
  players: g.min + '–' + g.max + ' 人',
  iconUri: IC[g.icon]
}))

module.exports = {
  __height: 980,
  data: () => ({
    ic: IC,
    list: LIST,
    joinCode: '',
    err: '',
    muted: false,
    hapticOn: true
  }),
  states: {
    /* 输了两位还没输满 —— 按钮应该是"待命"态 */
    typing: () => ({ joinCode: '12' }),
    /* 输错了 */
    error: () => ({ joinCode: '123', err: '房间不存在或已解散' }),
    /* 只有两个玩法（玩法还没长起来时的样子） */
    few: () => ({ list: LIST.slice(0, 2) })
  }
}
