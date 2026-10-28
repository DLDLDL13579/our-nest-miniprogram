const path = require('path')
const assert = require('assert')
let store = {}
let pageObj = null
global.Page = (o) => { pageObj = o }
global.getApp = () => ({ globalData: { bootAt: null } })
global.wx = {
  getStorageSync: (k) => store[k],
  setStorageSync: (k, v) => { store[k] = v },
  removeStorageSync: (k) => { delete store[k] },
  createInnerAudioContext: () => ({ playbackRate:1, volume:1, play(){}, stop(){}, destroy(){}, onEnded(){}, onError(){}, set src(v){this._s=v}, get src(){return this._s} }),
  getSystemInfoSync: () => ({}), showToast: () => {}, navigateTo: () => {}
}
require(path.join(__dirname, '..', 'miniprogram/pages/lobby/lobby.js'))
const ok = (m) => console.log('  ✓ ' + m)

function makePage() {
  return Object.assign(Object.create(pageObj), {
    data: JSON.parse(JSON.stringify(pageObj.data)),
    setData(p) { Object.assign(this.data, p) }
  })
}

/* 玩过三个：liar → poker → wheel */
store = {}
let p = makePage()
for (const id of ['liar', 'poker', 'wheel']) {
  p.openGame({ currentTarget: { dataset: { id } } })
}
console.log('recentGames:', store.recentGames)
assert.deepStrictEqual(store.recentGames, ['wheel', 'poker', 'liar'])
ok('最近三个按"新的在前"记录')

/* 再玩 liar → 它应该跳到最前，且不重复 */
p.openGame({ currentTarget: { dataset: { id: 'liar' } } })
assert.deepStrictEqual(store.recentGames, ['liar', 'wheel', 'poker'])
ok('再玩一次已记录的 → 跳到最前、不重复')

/* 玩第四个 → 只保留最近 3 个 */
p.openGame({ currentTarget: { dataset: { id: 'undercover' } } })
assert.deepStrictEqual(store.recentGames, ['undercover', 'liar', 'wheel'])
ok('超过三个 → 只留最近三个')

/* 排序：三个 recent 都在最前面，且顺序对
   ⚠️ 必须调 onShow —— list 在 data 初始化时算一次，而**真机回到大厅时
      onShow 会重算**。第一版没调，测到的是"模块加载那一刻"的列表。 */
store = { recentGames: ['poker', 'liar'] }
p = makePage()
p.onShow()
const list = p.data.list.map(g => g.id)
console.log('排序后:', list.join(' → '))
assert.deepStrictEqual(list.slice(0, 2), ['poker', 'liar'])
ok('大厅排序：最近两个排在最前，顺序按"最近"')

/* 老数据兼容：只有 lastGame */
store = { lastGame: 'wheel' }
p = makePage()
p.onShow()
assert.strictEqual(p.data.list[0].id, 'wheel')
ok('★ 老数据（只有 lastGame）仍能顶到最前')
