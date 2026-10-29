/**
 * test-loser.js —— 「谁喝了、喝多少」的提取规则
 *
 * ============ 为什么这个测试现在才写得出来 ============
 *
 * 这段逻辑原来是**内联在云函数 again 分支里**的。想测它就得真的玩一局金花
 * （比牌流程、出局条件、牌不够……），我照自己想的流程写了一次，
 * 跑出来是"1 次比牌就结束了"——**测试前提本身就是错的**，只能删掉。
 *
 * 抽成 `cloudfunctions/room/loser.js` 之后，喂数据就能断言。
 *
 * 跑法：node scripts/test-loser.js
 */
const path = require('path')
const assert = require('assert')
const { drinkers } = require(path.join(__dirname, '..', 'cloudfunctions/room/loser.js'))

let n = 0
const ok = (m) => { n++; console.log('  ✓ ' + m) }

/* ① 大话骰：输家写在 loserName */
assert.deepStrictEqual(
  drinkers({ game: 'liar', lastResult: { loserName: '倩萍' } }),
  [{ name: '倩萍', cups: 1 }]
)
ok('大话骰：loserName 记 1 杯')

/* ② 比大小：点数最少的那个喝（不是第一个） */
assert.deepStrictEqual(
  drinkers({ game: 'dice', lastResult: { ranked: [
    { name: '邓林', total: 22 }, { name: '阿杰', total: 11 }, { name: '倩萍', total: 17 }
  ] } }),
  [{ name: '阿杰', cups: 1 }]
)
ok('比大小：ranked 里 total 最小的记 1 杯')

/* ③ 金花：出局的每人 1 杯 + 换牌的代价（可能是小数） */
assert.deepStrictEqual(
  drinkers({
    game: 'poker',
    lastResult: { kind: 'poker' },
    players: [
      { name: '邓林', openid: 'o1', out: true },
      { name: '阿杰', openid: 'o2', out: false },
      { name: '倩萍', openid: 'o3', out: true }
    ],
    pkDrink: { o2: 1.5 }
  }),
  [{ name: '邓林', cups: 1 }, { name: '倩萍', cups: 1 }, { name: '阿杰', cups: 1.5 }]
)
ok('金花：出局者各 1 杯 + 换牌的 1.5 杯')

/* ④ 金花：同一个人既出局又换过牌 → 合并成一项，不重复列 */
assert.deepStrictEqual(
  drinkers({
    game: 'poker',
    lastResult: { kind: 'poker' },
    players: [{ name: '邓林', openid: 'o1', out: true }],
    pkDrink: { o1: 0.5 }
  }),
  [{ name: '邓林', cups: 1.5 }]
)
ok('金花：同一人出局 + 换牌 → 合并成 1.5 杯（不重复列两条）')

/* ⑤ 卧底 / 转盘：没有明确的输家 → 空（宁可少算，不算错） */
assert.deepStrictEqual(drinkers({ game: 'undercover', lastResult: { kind: 'undercover' } }), [])
assert.deepStrictEqual(drinkers({ game: 'wheel', lastResult: { kind: 'wheel' } }), [])
ok('卧底 / 转盘：不统计（没有明确输家）')

/* ⑥ 边界：没有 lastResult / 数据不全 → 空数组，不报错 */
assert.deepStrictEqual(drinkers({ game: 'liar', lastResult: null }), [])
assert.deepStrictEqual(drinkers({ game: 'dice', lastResult: {} }), [])
assert.deepStrictEqual(drinkers({ game: 'poker', lastResult: {} }), [])
assert.deepStrictEqual(drinkers({}), [])
ok('边界：缺 lastResult / 缺字段 → 空数组，不抛错')

/* ⑦ 杯数为 0 或负数的人不进列表（防脏数据） */
assert.deepStrictEqual(
  drinkers({
    game: 'poker',
    lastResult: { kind: 'poker' },
    players: [{ name: '邓林', openid: 'o1', out: false }],
    pkDrink: { o1: 0 }
  }),
  []
)
ok('杯数为 0 的人不进列表')

console.log('\n' + '='.repeat(50))
console.log(`  「今晚战况」提取规则：全部 ${n} 项通过`)
console.log('='.repeat(50) + '\n')
