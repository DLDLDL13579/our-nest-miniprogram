/**
 * test-pitch.js —— 音效抖动（playbackRate）真的生效吗
 *
 * ============ 为什么单独测这个 ============
 *
 * 一局里骰子落定要播 5 次、拍牌要播十几次。如果每次**完全一样**，
 * 听感上就是"打点机"而不是"手里在动" —— 这是廉价感最直接的来源之一。
 *
 * 实现上是 `playbackRate` 加 ±4% 随机。但这类"加了随机"的东西最容易**名存实亡**：
 *   · 被某个 `pitch: false` 的调用全关掉
 *   · 或者代码写着随机、实际每次都算成同一个值
 * 静态看代码看不出来，只能真跑一遍看取值分布。
 *
 * 跑法：node scripts/test-pitch.js
 */
global.wx = {
  getStorageSync: () => '',
  setStorageSync: () => {},
  createInnerAudioContext: () => {
    const a = {
      _src: '', playbackRate: 1, volume: 1,
      set src(v) { a._src = v },
      get src() { return a._src },
      play() {}, stop() {}, destroy() {},
      onEnded() {}, onError() {}
    }
    global.__last = a
    return a
  }
}
const path = require('path')
const sfx = require(path.join(__dirname, '..', 'miniprogram/game/sfx.js'))
const rates = []
for (let i = 0; i < 20; i++) {
  sfx.play('diceSettle')
  rates.push(global.__last.playbackRate)
}
const uniq = new Set(rates.map(r => r.toFixed(4)))
console.log('20 次播放的 playbackRate 取值数:', uniq.size)
console.log('范围:', Math.min(...rates).toFixed(3), '~', Math.max(...rates).toFixed(3))
if (uniq.size < 3) { console.log('✗ 抖动没生效（取值太少）'); process.exit(1) }
console.log('✓ 抖动生效（每次略有不同，避免机械重复）')
