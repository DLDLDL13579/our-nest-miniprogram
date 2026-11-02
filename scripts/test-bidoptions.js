/**
 * test-bidoptions.js —— 大话骰"只能往上叫"的规则
 *
 * 这是玩家每一回合都在用的东西：候选叫法的生成。
 * 原来内联在 room.js 的 buildOptions 里，**没有单测** —— 而它错一次，
 * 玩家就会叫出非法骰（被服务端拒）、或者干脆看不到能叫的选项。
 *
 * 2026-10-29 搬到 `miniprogram/game/bidOptions.js`（纯函数）后可以喂数据断言。
 *
 * 跑法：node scripts/test-bidoptions.js
 */
const path = require('path')
const assert = require('assert')
const { list, MAX } = require(path.join(__dirname, '..', 'miniprogram/game/bidOptions.js'))

let n = 0
const ok = (m) => { n++; console.log('  ✓ ' + m) }

/* ① 第一个叫：从最小的开始，24 个封顶（2 人 = 10 颗骰子，全列 60 个没人看得完） */
const first = list(2, null)
assert.strictEqual(first.length, MAX, '应封顶 ' + MAX + ' 个')
assert.strictEqual(first[0], '1个1')
assert.strictEqual(first[MAX - 1], '4个6')
ok('第一个叫：1个1 起，封顶 24 个（第 24 个是 4个6）')

/* ② 上家叫了 3个4 → 只剩严格更大的 */
const after = list(2, { n: 3, face: 4 })
assert.ok(after.length > 0, '应该有合法选项')
assert.ok(!after.includes('3个4'), '★ 不能重复上家的叫法')
assert.ok(!after.includes('3个3'), '★ 同数量但点数更小不合法')
assert.ok(!after.includes('2个6'), '★ 数量更小不合法')
assert.strictEqual(after[0], '3个5', '第一合法项应是 3个5（同数量点数更大），实际 ' + after[0])
assert.ok(after.includes('4个1'), '★ 数量变大时点数可以更小')
ok('上家 3个4：同数量只能升点数，数量升了点数可以降')

/* ③ 叫到顶（10 个 6）→ 没有合法选项 */
assert.deepStrictEqual(list(2, { n: 10, face: 6 }), [])
ok('叫到顶（10个6）→ 没有合法选项（否则能无限往上叫）')

/* ④ 人多上限高：4 人 = 20 颗，10个6 之后仍能往上叫 */
assert.ok(list(4, { n: 10, face: 6 }).length > 0, '4 人局 10个6 之后仍可往上叫')
ok('人多上限高：4 人局 10个6 之后仍可继续')

/* ⑤ 人数缺省不崩（buildOptions 原来用 count || 2 兜底） */
assert.ok(list(0, null).length > 0, '人数为 0 时应回退到 2 人而不是崩')
assert.ok(list(undefined, null).length > 0, '人数 undefined 时应回退')
ok('边界：人数 0 / undefined → 回退到 2 人，不崩')

/* ⑥ 每个选项都能被 doBid 的正则解析（格式「N个F」，F 是 1~6） */
const re = /^(\d+)个(\d)$/
const bad = list(8, null).filter(x => {
  const m = re.exec(x)
  return !m || Number(m[2]) < 1 || Number(m[2]) > 6
})
assert.deepStrictEqual(bad, [], '这些选项 doBid 解析不出来：' + bad.join(','))
ok('所有选项都能被 doBid 的正则解析（格式与点数范围都对）')

console.log('\n' + '='.repeat(50))
console.log(`  叫骰规则：全部 ${n} 项通过`)
console.log('='.repeat(50) + '\n')

/* ============================================================================
 * ★ 起叫数量：按调研的公式校验（2026-11-02）
 *
 * 原来 `openNeed` 是一张**硬编码表**：
 *     p=3 斋4 / p=4 斋5 / p=5 斋6 / p≥6 斋 p+1、不斋 p+2
 * 而调研（百度百科「大话骰」）说的是：
 *     不斋 = 总人数的 **1.5 倍**；斋 = **人头数**
 * 那张表里"斋"每个都多 1，6 人不斋少 1 —— 是凭感觉填的。
 *
 * 这条断言把它锁死成公式，以后不能再凭感觉改。
 * ========================================================================== */
{
  const { openNeed } = require('../miniprogram/utils/liarRules.js')
  let bad = []
  for (let p = 2; p <= 8; p++) {
    const day = openNeed(p, false, 2)
    const zhai = openNeed(p, true, 2)   /* ⚠️ 必须是非 1 的点数，否则 face===1 会提前返回人数 */
    const ones = openNeed(p, false, 1)
    if (day !== Math.ceil(p * 1.5)) bad.push(p + '人不斋应' + Math.ceil(p * 1.5) + '实得' + day)
    if (zhai !== p) bad.push(p + '人斋应' + p + '实得' + zhai)
    if (ones !== p) bad.push(p + '人叫1应' + p + '实得' + ones)
  }
  assert.deepStrictEqual(bad, [], '起叫数量不符调研规则：\n    ' + bad.join('\n    '))
  console.log('  ✓ 起叫数量：不斋=1.5倍 / 斋=人头数 / 叫1=人头数（2~8 人逐个核对）')
}

/* ============================================================================
 * ★ 斋 → 不斋（飞斋）必须加倍（2026-11-02 补）
 *
 * 这条规则一直在 `canRaise` 里，但**没有任何测试覆盖** ——
 * 用 verify-assert.py 把 `next.n >= cur.n * 2` 改成恒真，测试照样通过。
 *
 * 规则来源：百度百科「大话骰」
 *   「下家想破斋，需要叫双倍或者以上的骰子数」
 * ========================================================================== */
{
  const { canRaise } = require('../miniprogram/utils/liarRules.js')
  const cur = { n: 3, face: 4, zhai: true }     // 上家叫「3个4斋」

  assert.strictEqual(canRaise(cur, { n: 6, face: 2, zhai: false }, 3).ok, true,
    '3个斋 → 6个（加倍）应该允许')
  assert.strictEqual(canRaise(cur, { n: 7, face: 2, zhai: false }, 3).ok, true,
    '3个斋 → 7个（超过加倍）应该允许')
  assert.strictEqual(canRaise(cur, { n: 5, face: 2, zhai: false }, 3).ok, false,
    '3个斋 → 5个（没加倍）必须拒绝')
  assert.strictEqual(canRaise(cur, { n: 4, face: 5, zhai: false }, 3).ok, false,
    '3个斋 → 4个（没加倍）必须拒绝')
  /* 斋 → 斋：正常往上加就行，不需要翻倍 */
  assert.strictEqual(canRaise(cur, { n: 4, face: 5, zhai: true }, 3).ok, true,
    '斋 → 斋 只需数量/点数往上，不要求翻倍')

  console.log('  ✓ 飞斋：从斋改回不斋必须加倍（3个斋 → 6个可，5个不可）')
}
