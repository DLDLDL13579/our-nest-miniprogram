/** 我的页 mock */
const iconSet = require('../../../miniprogram/utils/iconSet.js')
const { GAMES } = require('../../../miniprogram/utils/games.js')
const IC = iconSet.build(['dice', 'chevronRight'], '#C4553F')

module.exports = {
  __height: 1200,  /* 渲染器固定按手机尺寸截图，改这个没用 —— 想看第二屏得改渲染器 */
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
    /*
     * ⚠️ 版本号从 config 读，别再硬编码 —— 这里原来写着 '3.7.4'，
     *    而实际早就是 3.10.x 了。真实的 me.js 早改成从 config 读了，
     *    只有 mock 还留着旧字符串（截图里会显示错的版本）。
     */
    version: require('../../../miniprogram/config.js').version,
    /* 下面三个 2026-10-28 新加的字段，mock 没跟上 → 截图里是"缺一块"的界面 */
    reduceMotion: false,
    nightGames: 3,
    errCount: 2
  }),
  states: {
    /* 新用户：还没起名字 */
    empty: () => ({ nick: '' }),
    /* 都关了 */
    off: () => ({ muted: true, hapticOn: false }),
    /* 没有错误记录时那一行不该出现 */
    clean: () => ({ errCount: 0, nightGames: 0 })
  }
}
