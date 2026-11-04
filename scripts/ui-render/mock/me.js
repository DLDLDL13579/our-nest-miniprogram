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
    /*
     * ★★ 2026-11-03：**颜色从注册表取，不硬编码**。
     *
     *   原来这里写死了五个 hex —— 而注册表后来改过两次配色
     *   （金花 `#B8863C`→`#D4A03C`、转盘 `#7A5CA8`→`#3E9187`），
     *   mock 没跟着改 → 截图里「我的」页的圆点是**旧颜色**，
     *   和「大厅」页的玩法卡对不上。
     *
     *   真实代码 `me.js` 一直是 `color: g.color`（从注册表取），只有 mock 落后。
     */
    gameRows: GAMES.map(function (g) {
      const counts = { poker: 7, liar: 4, undercover: 2, dice: 0, wheel: 0 }
      return { id: g.id, name: g.name, color: g.color, count: counts[g.id] || 0 }
    }).sort(function (a, b) { return b.count - a.count }),   /* ⚠️ 真实代码按次数降序排 */
    /*
     * ⚠️ 版本号从 config 读，别再硬编码 —— 这里原来写着 '3.7.4'，
     *    而实际早就是 3.10.x 了。真实的 me.js 早改成从 config 读了，
     *    只有 mock 还留着旧字符串（截图里会显示错的版本）。
     */
    version: require('../../../miniprogram/config.js').version,
    /* 下面三个 2026-10-28 新加的字段，mock 没跟上 → 截图里是"缺一块"的界面 */
    reduceMotion: false,
    nightGames: 3,
    errCount: 2,
    errList: [
      { t: 1, fn: 'room', act: 'create', raw: 'cloud.callFunction:fail timeout' },
      { t: 2, fn: 'room', act: 'create', raw: 'cloud.callFunction:fail timeout' }
    ]
  }),
  states: {
    /* 新用户：还没起名字 */
    empty: () => ({ nick: '' }),
    /* 都关了 */
    off: () => ({ muted: true, hapticOn: false }),
    /* 没有错误记录时那一行不该出现 */
    clean: () => ({ errCount: 0, nightGames: 0 }),

    /*
     * ★★ 2026-11-04：补两个**从来没被渲染过**的状态。
     *
     * 原来只有 empty / off / clean 三个，而：
     *   · `diagOpen` 在 `data()` 里没有、任何状态也不设 →
     *     **诊断弹层一次都没被看过**。而那正是用户报障时要截图发我的界面。
     *   · `reduceMotion` 三个状态里全是 false → "减少动效“开着时的样子从没验证过。
     *
     * 这类"整块没渲染过"是最隐蔽的盲区 —— 代码在、模板在、不报错，
     * 只是从来没有人看过它长什么样。
     */
    diag: () => ({
      diagOpen: true,
      diagText: [
        '环境：WX 8.0.49 / iOS 17.4 / iPhone 14',
        '版本：v3.46.1',
        '最近错误（2）：',
        '  01:22:10 · room/create：cloud.callFunction:fail timeout',
        '  01:22:41 · room/create：cloud.callFunction:fail timeout',
        '失败次数：3',
        '最远走到：大厅（停留 12s）',
        '轨迹：启动 → 大厅 → 新建房间'
      ].join('\n')
    }),
    /* 减少动效开着的样子 */
    calm: () => ({ reduceMotion: true, muted: true })
  }
}
