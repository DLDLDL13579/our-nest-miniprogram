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
const assert = require('assert')
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

/* ============ ② 预加载列表里的 key 必须都存在 ============ */
/*
 * ★ 2026-10-29。这个列表里曾经出现过两个"不存在的名字"：
 *   · `diceTumbleWood` —— 那个音频在 3.10.52 被删了，列表没跟着改
 *   · `diceRollBig` / `uwReveal` —— 我照着印象写的，FILES 里根本没有
 * 后果不是崩溃（preload 里有 `if (!src) return`），而是**那个名额白占**，
 * 等于"以为预加载了、其实没有" —— 而用户听到的就是"声音慢半拍"。
 */
const preloadSrc = require('fs').readFileSync(
  require('path').join(__dirname, '..', 'miniprogram/game/sfx.js'), 'utf8')
const pm = /const PRELOAD_KEYS = \[([\s\S]*?)\]/.exec(preloadSrc)
assert.ok(pm, '抽不出 PRELOAD_KEYS')
const preloadKeys = [...pm[1].matchAll(/'([a-zA-Z][a-zA-Z0-9]*)'/g)].map(x => x[1])
const missing = preloadKeys.filter(k => !sfx.FILES[k])
assert.deepStrictEqual(missing, [],
  '★ 预加载列表里有不存在的音效（白占名额，等于没预加载）：' + missing.join(', '))
console.log('  ✓ 预加载 ' + preloadKeys.length + ' 个音效，全部存在')

/* ============ ③ 预加载真的会创建音频实例吗 ============ */
/*
 * ★ 只检查"列表里的名字都存在"是不够的 —— 列表写对了但 preload() 没被调用、
 *   或者函数体里有 bug 提前 return，结果一样是"没预加载"，而代码看着完全正常。
 *   所以这里**真跑一遍** preload()，数它建了几个实例。
 */
{
  let made = 0
  global.wx = {
    getStorageSync: () => '', setStorageSync: () => {},
    createInnerAudioContext: () => {
      made++
      return {
        playbackRate: 1, volume: 1, play() {}, stop() {}, destroy() {},
        onEnded() {}, onError() {},
        set src(v) { this._s = v }, get src() { return this._s }
      }
    }
  }
  delete require.cache[require.resolve(path.join(__dirname, '..', 'miniprogram/game/sfx.js'))]
  const fresh = require(path.join(__dirname, '..', 'miniprogram/game/sfx.js'))
  made = 0
  fresh.preload()
  /*
   * 会比列表短几个：POOL_SIZE > 1 的音效（shakerMetal 等）刻意跳过 ——
   * 它们的实例按 slot 名建，预加载塞进去会和播放逻辑打架。
   */
  assert.ok(made >= 8, '★ 预加载只建了 ' + made + ' 个实例，至少要覆盖 8 个（列表 13 个，池化的会跳过）')
  console.log('  ✓ 预加载真的建了 ' + made + ' 个音频实例')
}
