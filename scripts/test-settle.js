/**
 * test-settle.js —— 结算页底部那句话（"谁喝一杯"）
 *
 * 这段逻辑原来内联在 decorate 里，四个玩法各一个分支，一直没被测过。
 * 它决定的是**玩家最后看到的那句话** —— 说错了很刺眼（"XX 喝一杯"却判错了人）。
 *
 * 抽到 `miniprogram/game/settle.js` 之后可以直接喂数据断言。
 *
 * 跑法：node scripts/test-settle.js
 */
const path = require('path')
const assert = require('assert')
const { footText } = require(path.join(__dirname, '..', 'miniprogram/game/settle.js'))

let n = 0
const ok = (m) => { n++; console.log('  ✓ ' + m) }

/* ① 大话骰 */
assert.strictEqual(
  footText({ game: 'liar', phase: 'over', lastResult: { loserName: '倩萍' } }),
  '倩萍 喝 1 杯'
)
ok(`大话骰 → "倩萍 喝 1 杯"`)

/* ② 比大小：取点数最少的那个（不是第一个） */
assert.strictEqual(
  footText({ game: 'dice', phase: 'over', lastResult: { ranked: [
    { name: '邓林', total: 22 }, { name: '阿杰', total: 11 }, { name: '倩萍', total: 17 }
  ] } }),
  '阿杰 点数最少，喝 1 杯'
)
ok('比大小 → 取点数最少的那个（不是第一个）')

/* ③ 卧底：说出卧底是谁 */
assert.strictEqual(
  footText({
    game: 'undercover', phase: 'over', lastResult: { kind: 'undercover' },
    uw: { reveal: [{ name: '邓林', role: 'civilian' }, { name: '阿杰', role: 'spy' }] }
  }),
  '卧底是 阿杰'
)
ok('卧底 → "卧底是 阿杰"')

/* ④ 金花：换过牌 → 说"你为了换牌喝了几杯" */
assert.strictEqual(
  footText({ game: 'poker', phase: 'over', lastResult: { kind: 'poker' }, poker: { myDrink: 1 } }),
  '你为了换牌喝了 1 杯'
)
assert.strictEqual(
  footText({ game: 'poker', phase: 'over', lastResult: { kind: 'poker' }, poker: { myDrink: 1.5 } }),
  '你为了换牌喝了 1.5 杯'
)
ok('金花 → 换牌 1 杯 / 1.5 杯的写法都对')

/* ⑤ 金花：没换过牌 → 说"XX 没换过牌就赢了" */
assert.strictEqual(
  footText({ game: 'poker', phase: 'over', lastResult: { kind: 'poker' }, poker: { myDrink: 0, winner: '邓林' } }),
  '邓林 没换过牌就赢了'
)
ok('金花 → 没换牌时夸一句')

/* ⑥ 不该有的时候是空串（不是 undefined，模板会渲染出 "undefined"） */
assert.strictEqual(footText({ game: 'liar', phase: 'playing', lastResult: { loserName: 'A' } }), '')
assert.strictEqual(footText({ game: 'wheel', phase: 'over', lastResult: { kind: 'wheel' } }), '')
assert.strictEqual(footText(null), '')
assert.strictEqual(footText({ game: 'liar', phase: 'over', lastResult: null }), '')
ok('非结算 / 转盘 / 空数据 → 空串（不是 undefined）')

/* ⑦ 边界：ranked 是空数组时不能崩 */
assert.strictEqual(footText({ game: 'dice', phase: 'over', lastResult: { ranked: [] } }), '')
ok('边界：ranked 空数组 → 空串，不崩')

console.log('\n' + '='.repeat(50))
console.log(`  结算文案：全部 ${n} 项通过`)
console.log('='.repeat(50) + '\n')
