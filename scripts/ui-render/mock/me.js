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
    gameRows: [
      { id: 'poker', name: '梦幻金花', color: '#B8863C', count: 7 },
      { id: 'liar', name: '大话骰', color: '#C4573A', count: 4 },
      { id: 'undercover', name: '谁是卧底', color: '#7A5CA8', count: 2 },
      { id: 'dice', name: '比大小', color: '#5E7FA6', count: 0 },
      { id: 'wheel', name: '命运转盘', color: '#7A5CA8', count: 0 }
    ],
    version: '3.7.4'
  }),
  states: {
    /* 新用户：还没起名字 */
    empty: () => ({ nick: '' }),
    /* 都关了 */
    off: () => ({ muted: true, hapticOn: false })
  }
}
