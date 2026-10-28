/**
 * test-room-changed.js —— 轮询去重真的在去重吗（行为测试）
 *
 * ============ 为什么需要它 ============
 *
 * 房间页每 1.5 秒轮询一次，一局下来上百次 setData。而 `setData` 不是赋值，
 * 是**跨线程拷贝 + 视图 diff** —— 值相同也要走完。所以加了 `roomChanged()`
 * 只比会**影响画面**的字段，没变化就不重绘。
 *
 * test-room-ui ③ 是**静态检查**（看源码里有没有那几个比较），
 * 它保证不了"比较逻辑写对了"。这里补**行为测试**：给两份快照，看返回值。
 *
 * 最要紧的一条：`countdownMs` **不能**参与比较 —— 它是"服务端此刻还剩多少"，
 * 每轮必然不同。真拿它当变化源，就等于每次轮询都重绘一次，
 * 而这层优化就白做了（而且看不出来，只是"手机有点烫"）。
 *
 * 跑法：node scripts/test-room-changed.js
 */
const path = require('path')
const assert = require('assert')

/* mock 掉小程序运行环境，只为把 Page({}) 里的 methods 捞出来 */
let pageObj = null
global.Page = (o) => { pageObj = o }
global.getApp = () => ({ globalData: {} })
global.wx = {
  getStorageSync: () => '', setStorageSync: () => {}, removeStorageSync: () => {},
  createInnerAudioContext: () => ({
    playbackRate: 1, volume: 1, play() {}, stop() {}, destroy() {},
    onEnded() {}, onError() {}, set src(v) { this._s = v }, get src() { return this._s }
  }),
  getSystemInfoSync: () => ({}),
  onMemoryWarning: () => {},
  showToast: () => {}
}

require(path.join(__dirname, '..', 'miniprogram/game/room/room.js'))
assert.ok(pageObj && typeof pageObj.roomChanged === 'function', 'roomChanged 没捞到')
const roomChanged = pageObj.roomChanged

const base = {
  phase: 'playing', count: 3, turn: 1, round: 2, game: 'liar', host: true,
  bid: { n: 2, face: 3, at: 1000 }, lastResult: null,
  uw: { step: 'talk', voteCount: 0, myVote: '' }
}
const clone = (o) => JSON.parse(JSON.stringify(o))
let n = 0
const ok = (m) => { n++; console.log('  ✓ ' + m) }

/* ① 完全一样 → 不进重绘 */
assert.strictEqual(roomChanged(clone(base), clone(base)), false)
ok('两份相同快照 → 不重绘')

/* ② ★ countdownMs 变了 → 仍然不重绘（这是这层优化的命门） */
assert.strictEqual(roomChanged(clone(base), Object.assign(clone(base), { countdownMs: 1400 })), false)
assert.strictEqual(roomChanged(Object.assign(clone(base), { countdownMs: 1400 }), Object.assign(clone(base), { countdownMs: 100 })), false)
ok('★ countdownMs 变化不触发重绘（否则每轮都 setData，去重就白做了）')

/* ③ 真该重绘的字段变了 → 必须重绘 */
const cases = [
  ['phase', { phase: 'over' }],
  ['count', { count: 4 }],
  ['turn', { turn: 2 }],
  ['round', { round: 3 }],
  ['game', { game: 'dice' }],
  ['host', { host: false }],
  ['bid', { bid: { n: 3, face: 4, at: 2000 } }],
  ['lastResult', { lastResult: { kind: 'liar' } }],
  ['uw.step', { uw: { step: 'vote', voteCount: 0, myVote: '' } }],
  ['uw.voteCount', { uw: { step: 'talk', voteCount: 1, myVote: '' } }]
]
for (const [name, patch] of cases) {
  assert.strictEqual(roomChanged(clone(base), Object.assign(clone(base), patch)), true, name + ' 变化应触发重绘')
}
ok('十个该重绘的字段全部触发（' + cases.map(c => c[0]).join(' / ') + '）')

console.log('\n' + '='.repeat(50))
console.log(`  轮询去重：全部 ${n} 项行为断言通过`)
console.log('='.repeat(50) + '\n')
