/**
 * test-sieve.js —— 红黑单双大小的规则单测
 *
 * 六条规则 × 骰子颜色/点数的所有组合都验一遍。
 * 项目里的教训：**规则类的东西必须穷举**（test-poker 穷举了 22100 手才对上组合数学）。
 *
 * 跑法：node scripts/test-sieve.js
 */
const path = require('path')
const assert = require('assert')

const S = require(path.join(__dirname, '..', 'miniprogram', 'utils', 'sieveRules.js'))

let n = 0
function ok(msg) { n++; console.log('  ✓ ' + msg) }

const red = (f) => ({ face: f, color: 'red' })
const ivory = (f) => ({ face: f, color: 'ivory' })

/* ============ ① 六条规则的语义，逐条穷举 5 种骰子 ============ */
{
  /*
   * 每条规则对 6 个点数 × 2 种颜色 = 12 种骰子各留不留。
   * 这是**独立写出来的期望表**，不是从代码反推的。
   */
  const expect = {
    red: (d) => d.color === 'red',
    black: (d) => d.color === 'ivory',
    big: (d) => d.face >= 4,
    small: (d) => d.face <= 3,
    odd: (d) => d.face % 2 === 1,
    even: (d) => d.face % 2 === 0
  }
  Object.keys(expect).forEach((k) => {
    for (let f = 1; f <= 6; f++) {
      ['red', 'ivory'].forEach((c) => {
        const d = { face: f, color: c }
        const kept = S.applyRule([d], k).left === 1
        assert.strictEqual(kept, expect[k](d),
          `${k} 规则对 face=${f} color=${c} 的判定错了（期望 ${expect[k](d)}，实际 ${kept}）`)
      })
    }
  })
  ok('六条规则 × 12 种骰子（6 点数 × 2 颜色）全部与独立期望表一致')
}

/* ============ ② 大小 / 单双 必须互补且不重叠 ============ */
{
  for (let f = 1; f <= 6; f++) {
    const d = { face: f, color: 'red' }
    const big = S.applyRule([d], 'big').left
    const small = S.applyRule([d], 'small').left
    assert.strictEqual(big + small, 1, `${f} 点在大小规则下必须恰好被一边收下`)

    const odd = S.applyRule([d], 'odd').left
    const even = S.applyRule([d], 'even').left
    assert.strictEqual(odd + even, 1, `${f} 点在单双规则下必须恰好被一边收下`)
  }
  ok('大小互补不重叠、单双互补不重叠（1..6 全验）')
}

/* ============ ③ 红黑互补（颜色只有两种）============ */
{
  ;[red(3), ivory(3)].forEach((d, i) => {
    const r = S.applyRule([d], 'red').left
    const b = S.applyRule([d], 'black').left
    assert.strictEqual(r + b, 1, `第 ${i} 种颜色在红黑规则下必须恰好被一边收下`)
  })
  ok('红黑互补（两种颜色各归一边）')
}

/* ============ ④ 完整一副 5 颗的取舍 ============ */
{
  const hand = [red(1), red(4), ivory(2), ivory(5), red(6)]
  /* 红 → 留 3 颗（red1 red4 red6） */
  assert.strictEqual(S.applyRule(hand, 'red').left, 3, '红规则应留 3 颗')
  assert.strictEqual(S.applyRule(hand, 'red').removed.length, 2, '红规则应拿掉 2 颗')
  /* 黑 → 留 2 颗（ivory2 ivory5） */
  assert.strictEqual(S.applyRule(hand, 'black').left, 2, '黑规则应留 2 颗')
  /* 大(>=4) → 留 3 颗（red4 ivory5 red6） */
  assert.strictEqual(S.applyRule(hand, 'big').left, 3, '大规则应留 3 颗')
  /* 小(<=3) → 留 2 颗（red1 ivory2） */
  assert.strictEqual(S.applyRule(hand, 'small').left, 2, '小规则应留 2 颗')
  /* 单 → 留 3 颗（red1 ivory5 ... 等等：1,5 是单；red1 ivory5 = 2 颗） */
  assert.strictEqual(S.applyRule(hand, 'odd').left, 2, '单规则应留 2 颗（1 和 5）')
  /* 双 → 留 3 颗（4,2,6） */
  assert.strictEqual(S.applyRule(hand, 'even').left, 3, '双规则应留 3 颗（4 2 6）')
  ok('完整 5 颗手牌 × 六条规则，留几颗全部对得上（含拿掉的补集）')
}

/* ============ ⑤ 留 + 拿掉 = 原有总数（不丢不重）============ */
{
  const hands = [
    [red(1), red(2), red(3), red(4), red(5)],
    [ivory(6), ivory(6), ivory(6), ivory(6), ivory(6)],
    [red(2), ivory(4), red(6), ivory(1), red(3)]
  ]
  hands.forEach((h, hi) => {
    S.RULES.forEach((r) => {
      const a = S.applyRule(h, r.k)
      assert.strictEqual(a.kept.length + a.removed.length, h.length,
        `第 ${hi} 副手牌在 ${r.k} 规则下丢骰子了`)
    })
  })
  ok('留 + 拿掉 = 原有总数（三副手牌 × 六条规则，不丢不重）')
}

/* ============ ⑥ 规则可用性：全员都不符合时必须判不可用 ============ */
{
  /*
   * 场景：所有人都只剩红色骰子。
   * 此时喊「黑的留下」→ 所有人 0 颗 → 一次淘汰全部。
   * 规则必须拦掉它。
   */
  const allRed = [[red(3), red(4)], [red(1)]]
  assert.strictEqual(S.ruleIsUseful(allRed, 'black'), false,
    '★ 全员红骰时「黑的留下」必须判不可用（否则一次淘汰所有人）')
  assert.strictEqual(S.ruleIsUseful(allRed, 'red'), true, '「红的留下」应该可用')

  const usable = S.usableRules(allRed)
  assert.ok(usable.indexOf('black') < 0, '★ 不可用的规则不能出现在可选列表里')
  assert.ok(usable.indexOf('red') >= 0, '可用的规则必须出现')
  ok('★ 全员红骰时「黑的留下」被判不可用（不会一次淘汰所有人）')
}

/* ============ ⑦ 只剩一种点数时的可用性 ============ */
{
  /* 所有人都是 1 点 → 「大的留下」(4,5,6) 不可用，「小的留下」可用 */
  const allOne = [[red(1), ivory(1)], [red(1)]]
  assert.strictEqual(S.ruleIsUseful(allOne, 'big'), false, '全是 1 点时「大的留下」不可用')
  assert.strictEqual(S.ruleIsUseful(allOne, 'small'), true, '全是 1 点时「小的留下」可用')
  assert.strictEqual(S.ruleIsUseful(allOne, 'even'), false, '全是 1 点时「双数留下」不可用')
  assert.strictEqual(S.ruleIsUseful(allOne, 'odd'), true, '全是 1 点时「单数留下」可用')
  ok('只有一种点数时，四条大小/单双规则的可用性逐条正确')
}

/* ============ ⑧ 结算：单人清零 / 多人清零 ============ */
{
  /* 一个人拿光 → 他输 */
  const r1 = S.settle([{ seat: 1, dice: [] }, { seat: 2, dice: [red(3)] }])
  assert.deepStrictEqual(r1.losers, [1], '单人清零应该判他输')
  assert.strictEqual(r1.allOut, false, '单人清零不是"全员出局"')

  /* 两个人都拿光（且全场只有这两人）→ 这一轮作废 */
  const r2 = S.settle([{ seat: 1, dice: [] }, { seat: 2, dice: [] }])
  assert.deepStrictEqual(r2.losers, [1, 2], '两人都清零应都记入 losers')
  assert.strictEqual(r2.allOut, true, '★ 全场都清零必须标记 allOut —— 这一轮要作废重来，不能算两人都输')

  /* 没人清零 */
  const r3 = S.settle([{ seat: 1, dice: [red(1)] }, { seat: 2, dice: [red(2)] }])
  assert.deepStrictEqual(r3.losers, [], '没人清零时 losers 应为空')
  ok('★ 结算三态：单人输 / 全场清零作废 / 无人清零')
}

/* ============ ⑨ 坏输入不能崩 ============ */
{
  assert.doesNotThrow(() => S.applyRule(null, 'red'), 'applyRule(null) 不能抛')
  assert.doesNotThrow(() => S.applyRule([], '不存在'), '未知规则不能抛')
  assert.strictEqual(S.applyRule([], '不存在').badRule, true, '未知规则要标记 badRule')
  assert.doesNotThrow(() => S.settle(null), 'settle(null) 不能抛')
  assert.deepStrictEqual(S.settle(null).losers, [], 'null 输入返回空 losers')
  assert.strictEqual(S.ruleOf('不存在'), null, 'ruleOf 未知规则返回 null')
  ok('坏输入不崩（null / 未知规则都返回安全值并标记）')
}

/* ============ ⑩ 规则清单是 6 条且 key 唯一 ============ */
{
  const list = S.ruleList()
  assert.strictEqual(list.length, 6, '规则必须是 6 条')
  const keys = list.map((r) => r.k)
  assert.strictEqual(new Set(keys).size, 6, '规则 key 必须唯一')
  assert.strictEqual(S.DICE_PER_PLAYER, 5, '每人 5 颗骰子')
  /* ruleList 不能把函数带出去（它要经过云函数序列化） */
  list.forEach((r) => {
    assert.strictEqual(typeof r.keep, 'undefined', 'ruleList 不该带函数（无法序列化）')
    assert.ok(r.name && r.short && r.desc, '每条规则都要有 name / short / desc')
  })
  ok('规则清单 6 条、key 唯一、可序列化（不带函数）')
}

console.log('\n' + '='.repeat(58))
console.log('  红黑单双大小规则：全部 ' + n + ' 项断言通过')
console.log('='.repeat(58) + '\n')
