/** 大厅 mock */
const iconSet = require('../../../miniprogram/utils/iconSet.js')
const { GAMES } = require('../../../miniprogram/utils/games.js')

const IC = iconSet.build(['speakerOn', 'speakerOff', 'hapticOn', 'hapticOff', 'chevronRight'], '#E8B33C')

const LIST = GAMES.map((g, i) => ({
  id: g.id, name: g.name, desc: g.desc, color: g.color,
  players: g.min + '–' + g.max + ' 人',
  iconUri: IC[g.icon],
  /* 第一个标成"上次玩的"，用来预览新标签 */
  recent: i === 0
}))

module.exports = {
  __height: 1506,
  data: () => ({
    ic: IC,
    list: LIST,
    joinCode: '',
    /* 首次引导：渲染器不跑 onShow，用环境变量模拟 LOBBY_FIRST=1 */
    firstHint: !!process.env.LOBBY_FIRST,
    err: '',
    muted: false,
    /*
     * ★ 内容量必须**从真实数据算**，不能手写死（2026-10-30）。
     *   原来这里硬编码 '5 个玩法 · 160 道题 · 120 对词' ——
     *   我把题卡加到 200 条之后，渲染截图里还显示 160，
     *   差点以为"展示数字没跟着更新"是产品 bug。
     *   渲染器的使命是**反映真实界面**，mock 里的数字过期 = 截图不可信。
     */
    stats: (function () {
      try {
        const decks = require('../../../miniprogram/utils/decks.js')
        const words = require('../../../miniprogram/utils/words.js')
        const games = require('../../../miniprogram/utils/games.js')
        const cards = (decks.DECKS || []).reduce((n, d) => n + (d.truth || []).length + (d.dare || []).length, 0)
        const pairs = (words.DECKS || []).reduce((n, d) => n + (d.pairs || []).length, 0)
        const g = (games.GAMES || []).length
        return [g + ' 个玩法', cards + ' 道题', pairs + ' 对词'].join(' · ')
      } catch (e) { return '5 个玩法 · 200 道题 · 120 对词' }
    })(),
    hapticOn: true
  }),
  states: {
    /* 输了两位还没输满 —— 按钮应该是"待命"态 */
    typing: () => ({ joinCode: '12' }),
    /*
     * ★ 2026-11-03：**小屏紧凑模式**的预览状态。
     *
     *   `compact` 在真机上来自 `wx.getSystemInfoSync().windowHeight <= 600`，
     *   而渲染器不提供 systemInfo —— 所以必须在 mock 里显式给。
     *   不给的话，`--height 504` 渲染出来和正常屏**一模一样**（图片哈希都不变），
     *   而我还会以为是 CSS 没生效。
     */
    compact: () => ({ joinCode: '12', compact: true }),
    /* 输错了 */
    error: () => ({ joinCode: '123', err: '房间不存在或已解散' }),
    /* 只有两个玩法（玩法还没长起来时的样子） */
    few: () => ({ list: LIST.slice(0, 2) }),
    /*
     * ★ 2026-11-03：**全部玩法**的状态（= 真实场景）。
     *   原来只有 few（2 个）/ compact（小屏）等边界用例，
     *   没有"当前版本到底长什么样"这个最基本的一个 ——
     *   于是"7 个玩法首屏装不下"这件事一直没人看见。
     */
    all: () => ({ list: LIST })
  }
}
