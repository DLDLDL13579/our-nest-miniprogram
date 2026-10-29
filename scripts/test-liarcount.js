/**
 * test-liarcount.js —— 大话骰「实际有几个」的统计规则
 *
 * ============ 为什么需要它 ============
 *
 * 这是大话骰唯一的判定核心，而它有一条**反直觉**的规则：
 *   1 点恒为万能（可以当任何点数），**除非叫的就是 1**。
 *
 * 原逻辑内联在云函数里、骰子随机发，所以"1 有没有被算进去"从来没法单测 ——
 * 而算错了不会报错，只会"明明够数却判我输"。
 *
 * 跑法：node scripts/test-liarcount.js
 */
const path = require('path')
const assert = require('assert')
const { countActual } = require(path.join(__dirname, '..', 'cloudfunctions/room/liarCount.js'))

let n = 0
const ok = (m) => { n++; console.log('  ✓ ' + m) }

const P = (...diceList) => diceList.map(d => ({ dice: d }))

/* ① 叫 4，骰子是 4 → 算 */
assert.strictEqual(countActual(P([4, 2, 3]), 4), 1)
ok('叫 4，有一颗 4 → 算 1')

/* ② 叫 4，骰子里有 1 → **1 当 4 算**（万能） */
assert.strictEqual(countActual(P([1, 2, 3]), 4), 1,
  '叫 4 时，1 应该算作 4')
ok('★ 叫 4，有一颗 1 → 也算 1（1 是万能）')

/* ③ 叫 1，骰子里有 1 → 只算 1 自己，不额外算万能 */
assert.strictEqual(countActual(P([1, 2, 3]), 1), 1,
  '叫 1 时，1 只算自己（不万能）')
assert.strictEqual(countActual(P([2, 3, 4]), 1), 0,
  '叫 1 时，非 1 的骰子一颗也不算')
ok('★ 叫 1 时，1 不万能（只算自己）')

/* ④ 混合：叫 4，有 4 也有 1 → 都算 */
assert.strictEqual(countActual(P([4, 1, 1]), 4), 3,
  '叫 4 时，4 和两颗 1 都算')
ok('叫 4，4 + 两颗 1 → 算 3')

/* ⑤ 多人：统计全场，不只一个人 */
assert.strictEqual(countActual(P([4], [1], [4, 1]), 4), 4)
ok('多人局统计全场（3 人共 4 颗）')

/* ⑥ 边界：空数组 / 没有骰子 / 空玩家列表 */
assert.strictEqual(countActual([], 4), 0, '没有玩家时应为 0')
assert.strictEqual(countActual(P([], []), 4), 0, '都没骰子时应为 0')
assert.strictEqual(countActual(P(undefined), 4), 0, 'dice 缺失时应为 0，不崩')
ok('边界：空数据返回 0，不抛错')

/* ⑦ 叫 6 时 1 也万能（不是只有叫大点数才万能） */
assert.strictEqual(countActual(P([1, 1, 6]), 6), 3)
ok('叫 6，两颗 1 + 一颗 6 → 算 3')

console.log('\n' + '='.repeat(50))
console.log(`  大话骰统计：全部 ${n} 项通过`)
console.log('='.repeat(50) + '\n')
