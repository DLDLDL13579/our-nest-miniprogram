/**
 * test-pool.js —— 音效池化真的轮转吗
 *
 * ============ 为什么单独测这个 ============
 *
 * 摇盅的音效 22ms 一次、金属味很重。如果所有撞击都复用**同一个**
 * InnerAudioContext，后一下会把前一下掐断 —— 听感变成"哒…哒…哒"，
 * 而不像"哗啦"一片。所以 sfx.js 给几个密集音效配了实例池（POOL_SIZE）。
 *
 * 但池化最容易**名存实亡**：轮转下标算错、或者每次都取到 slot 0，
 * 代码看起来有池、实际永远用第一个。静态看不出来，只能真跑一遍看实例数。
 *
 * 跑法：node scripts/test-pool.js
 */
const path = require('path')
const assert = require('assert')

let created = 0
const made = []
global.wx = {
  getStorageSync: () => '',
  setStorageSync: () => {},
  createInnerAudioContext: () => {
    created++
    const a = {
      playbackRate: 1, volume: 1,
      set src(v) { this._src = v },
      get src() { return this._src },
      play() {}, stop() {}, destroy() {}, onEnded() {}, onError() {}
    }
    made.push(a)
    return a
  }
}

const sfx = require(path.join(__dirname, '..', 'miniprogram/game/sfx.js'))

/* shakerMetal 的 POOL_SIZE 是 3 —— 连播 3 次应该建出 3 个实例 */
for (let i = 0; i < 3; i++) sfx.play('shakerMetal')
console.log('shakerMetal 连播 3 次后创建的实例数:', created)
assert.ok(created >= 3, '★ 池化没生效：连播 3 次只建了 ' + created + ' 个实例（后一下会掐断前一下）')

/* 再播几轮，实例数不该继续涨（复用了） */
const before = created
for (let i = 0; i < 9; i++) sfx.play('shakerMetal')
console.log('再播 9 次后实例数:', created, '（应仍为', before, '）')
assert.strictEqual(created, before, '★ 池化没有复用：又新建了 ' + (created - before) + ' 个')

/* 单实例音效（如 combo1）连播两次应复用同一个 */
const c0 = created
sfx.play('combo1'); sfx.play('combo1')
console.log('combo1 连播 2 次新增实例:', created - c0, '（应为 1）')
assert.strictEqual(created - c0, 1, '★ 单实例音效没有复用')

console.log('\n✓ 池化生效：密集音效轮转实例、单实例音效复用')
