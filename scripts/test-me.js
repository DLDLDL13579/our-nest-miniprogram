const path = require('path')
const assert = require('assert')
let store = {}
let pageObj = null
global.Page = (o) => { pageObj = o }
global.getApp = () => ({ globalData: {} })
global.wx = {
  getStorageSync: (k) => store[k],
  setStorageSync: (k, v) => { store[k] = v },
  removeStorageSync: (k) => { delete store[k] },
  createInnerAudioContext: () => ({ playbackRate:1, volume:1, play(){}, stop(){}, destroy(){}, onEnded(){}, onError(){}, set src(v){this._s=v}, get src(){return this._s} }),
  getSystemInfoSync: () => ({ model: 'X', system: 'iOS' }),
  showToast: () => {}, setClipboardData: (o) => o.success && o.success()
}
require(path.join(__dirname, '..', 'miniprogram/pages/me/me.js'))
const ok = (m) => console.log('  ✓ ' + m)
function makePage() {
  return Object.assign(Object.create(pageObj), {
    data: JSON.parse(JSON.stringify(pageObj.data)),
    setData(p) { Object.assign(this.data, p) }
  })
}

/* ① 首次进：没有数据 → 0 / 0 */
store = {}
let p = makePage()
p.onShow()
assert.strictEqual(p.data.nightGames, 0)
assert.strictEqual(p.data.errCount, 0)
ok('没有数据时显示 0 局 / 0 条错误')

/* ② 玩了几局、出了几条错 → **再次 onShow** 应该看到新值 */
const d = new Date()
const today = d.getFullYear() + '-' + (d.getMonth() + 1) + '-' + d.getDate()
store.nightGames = { date: today, n: 5 }
store.errLog = [{ t: 1, fn: 'room', act: 'open', raw: 'timeout' }, { t: 2, fn: 'room', act: 'roll', raw: 'timeout' }]
p.onShow()
assert.strictEqual(p.data.nightGames, 5, '★ 玩完回来应该看到 5 局（不是 0）')
assert.strictEqual(p.data.errCount, 2, '★ 应该看到 2 条错误')
ok('★ 玩完回到「我的」→ 数字跟着更新（不是停在首次进入时的旧值）')

/* ③ 跨天 → 今晚归零 */
store.nightGames = { date: '2000-1-1', n: 9 }
p.onShow()
assert.strictEqual(p.data.nightGames, 0)
ok('跨天 → 今晚局数归零')
