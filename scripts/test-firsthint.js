/**
 * test-firsthint.js —— 首次引导只出现一次吗
 *
 * ============ 为什么单独测 ============
 *
 * 大厅第一次进来会给一句「点下面任意一张，直接就开桌」+ 第一张卡呼吸。
 * 它靠 `wx.getStorageSync('openedOnce')` 判断，点了任意一张卡就写进去。
 *
 * 这类"只出现一次"的东西有两种典型错法，都不会报错：
 *   · 记不住 → **每次进大厅都弹**（变成骚扰，用户会烦）
 *   · 记太早 → 没点卡就写入 → **永远不出现**（等于没做）
 *
 * 静态看代码都能"看出对"，只有真跑一遍状态才信。
 *
 * 跑法：node scripts/test-firsthint.js
 */
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
  createInnerAudioContext: () => ({
    playbackRate: 1, volume: 1, play() {}, stop() {}, destroy() {},
    onEnded() {}, onError() {}, set src(v) { this._s = v }, get src() { return this._s }
  }),
  getSystemInfoSync: () => ({}),
  showToast: () => {},
  navigateTo: () => {}
}

require(path.join(__dirname, '..', 'miniprogram/pages/lobby/lobby.js'))
assert.ok(pageObj, 'lobby 的 Page 没捞到')

/** 复用一份自己的 data，模拟"页面实例" */
function makePage() {
  return Object.assign(Object.create(pageObj), {
    data: JSON.parse(JSON.stringify(pageObj.data)),
    setData(patch) { Object.assign(this.data, patch) }
  })
}
let n = 0
const ok = (m) => { n++; console.log('  ✓ ' + m) }

/* ① 第一次进来 → 显示 */
store = {}
let p = makePage()
p.onShow()
assert.strictEqual(p.data.firstHint, true, '第一次进大厅应该显示引导')
ok('第一次进大厅 → 显示引导')

/* ② 没点卡就离开再回来 → 还应该显示（不能"看一眼就算看过"） */
p = makePage()
p.onShow()
assert.strictEqual(p.data.firstHint, true, '没点卡就离开，回来仍应显示')
ok('没点卡离开再回来 → 仍然显示（没被误标成看过）')

/* ③ 点了卡 → 写标记 + 立刻收起 */
p = makePage()
p.onShow()
assert.strictEqual(p.data.firstHint, true)
p.openGame({ currentTarget: { dataset: { id: 'liar' } } })
assert.strictEqual(p.data.firstHint, false, '点了卡应该立刻收起')
assert.ok(store.openedOnce, '点了卡应该写 openedOnce 标记')
ok('点了任意一张卡 → 立刻收起并记标记')

/* ④ 之后再进来 → 不再显示 */
p = makePage()
p.onShow()
assert.strictEqual(p.data.firstHint, false, '★ 点过之后不该再显示（否则每次都弹=骚扰）')
ok('★ 点过之后再进大厅 → 不再显示')

console.log('\n' + '='.repeat(50))
console.log(`  首次引导：全部 ${n} 项断言通过`)
console.log('='.repeat(50) + '\n')
