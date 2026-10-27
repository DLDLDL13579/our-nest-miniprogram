/** 我的页 mock */
const iconSet = require('../../../miniprogram/utils/iconSet.js')
const { GAMES } = require('../../../miniprogram/utils/games.js')
const IC = iconSet.build(['dice', 'chevronRight'], '#C4553F')

module.exports = {
  __height: 1200,
  data: () => ({
    ic: IC,
    nick: '邓林',
    muted: false,
    hapticOn: true,
    gameCount: GAMES.length,
    gameNames: GAMES.map(g => g.name).join(' · '),
    version: '3.0.0'
  }),
  states: {
    /* 新用户：还没起名字 */
    empty: () => ({ nick: '' }),
    /* 都关了 */
    off: () => ({ muted: true, hapticOn: false })
  }
}
