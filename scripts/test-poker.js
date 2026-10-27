#!/usr/bin/env node
/**
 * test-poker.js —— 梦幻金花的牌型比较
 *
 * ============ 为什么这个文件值得单独存在 ============
 *
 * 牌型比错了**不会报错**：只会"明明我比他大却判我输"。
 * 玩家不会觉得是 bug，会觉得这个 App 在作弊 —— 这类问题的代价比崩溃还大。
 *
 * 而牌型逻辑的正确答案是**可穷举的**：52 选 3 只有 22100 种，
 * 每种牌型的数量有精确的组合数学值。所以这里的判据不是"举几个例子"，
 * 而是"穷举全部 22100 手，逐类点数"。
 *
 * 组合数学基准（可手算核对）：
 *   总数 C(52,3) = 22100
 *   豹子       13 点 × C(4,3)=4          = 52
 *   顺金       12 个顺子 × 4 花色        = 48
 *   金花       C(13,3)=286 × 4 − 48      = 1096
 *   顺子       12 × 4^3 − 48             = 720
 *   对子       13 × C(4,2) × 12 × 4      = 3744
 *   单张       22100 − 其余              = 16440
 *
 * ⚠️ 这六个数字如果对不上，说明**要么算法错，要么我上面的算式错**。
 *    两种都必须停下来查，不能改断言去迁就代码。
 */
const path = require('path')
const assert = require('assert')
const { newDeck, shuffle, rank, compare, TYPES, TYPE_NAMES, cardText } = require(
  path.join(__dirname, '..', 'miniprogram', 'utils', 'poker.js'))

let n = 0
function ok(msg) { n++; console.log('  ✓ ' + msg) }

/* 便捷构造：'♠A' 这种写太长，直接用 [点数, 花色] */
function C(r, s) { return { r: r, s: s } }
const SPADE = 0, HEART = 1, CLUB = 2, DIAMOND = 3

;(function main() {
  console.log('\n=== ① 六种牌型的识别 ===')
  const cases = [
    [[C(14, SPADE), C(14, HEART), C(14, CLUB)], TYPES.TRIPLE, '豹子 AAA'],
    [[C(14, SPADE), C(13, SPADE), C(12, SPADE)], TYPES.STRAIGHT_FLUSH, '顺金 ♠AKQ'],
    [[C(14, SPADE), C(13, SPADE), C(9, SPADE)], TYPES.FLUSH, '金花 ♠AK9'],
    [[C(14, SPADE), C(13, HEART), C(12, CLUB)], TYPES.STRAIGHT, '顺子 AKQ'],
    [[C(13, SPADE), C(13, HEART), C(5, CLUB)], TYPES.PAIR, '对子 KK5'],
    [[C(14, SPADE), C(13, HEART), C(9, CLUB)], TYPES.HIGH, '单张 AK9']
  ]
  for (const [cards, want, label] of cases) {
    const r = rank(cards)
    assert.strictEqual(r.type, want, label + ' 应判为 ' + TYPE_NAMES[want] + '，实际 ' + r.name)
    assert.strictEqual(r.name, TYPE_NAMES[want], label + ' 牌型名要一致')
  }
  ok('豹子 / 顺金 / 金花 / 顺子 / 对子 / 单张 六种全部识别正确')

  console.log('\n=== ② 牌型强弱顺序 ===')
  const order = [
    [C(2, SPADE), C(3, HEART), C(9, CLUB)],          // 单张（最小）
    [C(2, SPADE), C(2, HEART), C(3, CLUB)],          // 对子
    [C(2, SPADE), C(3, HEART), C(4, CLUB)],          // 顺子
    [C(2, SPADE), C(5, SPADE), C(9, SPADE)],         // 金花
    [C(2, SPADE), C(3, SPADE), C(4, SPADE)],         // 顺金
    [C(2, SPADE), C(2, HEART), C(2, CLUB)]           // 豹子（最大）
  ]
  for (let i = 1; i < order.length; i++) {
    assert.ok(compare(order[i], order[i - 1]) > 0,
      TYPE_NAMES[rank(order[i]).type] + ' 应该大于 ' + TYPE_NAMES[rank(order[i - 1]).type])
  }
  ok('强弱顺序：单张 < 对子 < 顺子 < 金花 < 顺金 < 豹子')

  console.log('\n=== ③ 同牌型内部比大小 ===')
  /* 豹子比点数 */
  assert.ok(compare([C(14, SPADE), C(14, HEART), C(14, CLUB)],
    [C(13, SPADE), C(13, HEART), C(13, CLUB)]) > 0, 'AAA > KKK')
  /* 顺子比最大牌 */
  assert.ok(compare([C(14, SPADE), C(13, HEART), C(12, CLUB)],
    [C(13, SPADE), C(12, HEART), C(11, CLUB)]) > 0, 'AKQ > KQJ')
  /* ★ A23 是最小顺子，比 234 还小 */
  assert.strictEqual(rank([C(14, SPADE), C(3, HEART), C(2, CLUB)]).type, TYPES.STRAIGHT,
    'A23 必须算顺子（不算的话拿到的人会以为自己是单张）')
  assert.ok(compare([C(4, SPADE), C(3, HEART), C(2, CLUB)],
    [C(14, SPADE), C(3, HEART), C(2, CLUB)]) > 0,
    '★ A23 是最小顺子，234 要大于 A23')
  /* 对子：先比对子点数，再比单张 */
  assert.ok(compare([C(13, SPADE), C(13, HEART), C(2, CLUB)],
    [C(12, SPADE), C(12, HEART), C(14, CLUB)]) > 0,
    '对 K 带 2 要大于 对 Q 带 A（对子点数优先）')
  assert.ok(compare([C(13, SPADE), C(13, HEART), C(9, CLUB)],
    [C(13, SPADE), C(13, DIAMOND), C(5, CLUB)]) > 0,
    '同为对 K 时比单张：带 9 > 带 5')
  /* 对子里，对子点数是"出现两次"的那个，不是最大的那个 */
  const pairCheck = [C(13, SPADE), C(5, HEART), C(5, CLUB)]
  assert.strictEqual(rank(pairCheck).key[0], 5, 'K55 的对子是 5，不是 K')
  /* 单张逐位比 */
  assert.ok(compare([C(14, SPADE), C(3, HEART), C(2, CLUB)],
    [C(13, SPADE), C(14, HEART), C(2, CLUB)]) > 0,
    '单张先比最大牌：A 开头的更大')
  ok('同牌型内部比较全部正确（含 A23 最小顺子、对子取"出现两次"的点数）')

  console.log('\n=== ④ 并列必须显式存在（不能假装不会发生）===')
  const tieA = [C(14, SPADE), C(13, SPADE), C(9, SPADE)]
  const tieB = [C(14, HEART), C(13, HEART), C(9, HEART)]
  assert.strictEqual(compare(tieA, tieB), 0, '♠AK9 与 ♥AK9 花色不同但点数全同 → 必须判并列')
  ok('同点数不同花色判并列（调用方必须决定并列怎么算，不能静默判输）')

  console.log('\n=== ⑤ ★ 穷举 22100 手，逐类核对组合数学 ===')
  const deck = newDeck()
  const counts = [0, 0, 0, 0, 0, 0]
  let total = 0
  for (let i = 0; i < deck.length; i++) {
    for (let j = i + 1; j < deck.length; j++) {
      for (let k = j + 1; k < deck.length; k++) {
        const t = rank([deck[i], deck[j], deck[k]]).type
        counts[t]++
        total++
      }
    }
  }
  const EXPECT = [16440, 3744, 720, 1096, 48, 52]  // 单张/对子/顺子/金花/顺金/豹子
  assert.strictEqual(total, 22100, '总数必须等于 C(52,3)=22100，实际 ' + total)
  for (let t = 0; t < 6; t++) {
    assert.strictEqual(counts[t], EXPECT[t],
      TYPE_NAMES[t] + ' 的数量应为 ' + EXPECT[t] + '，实际 ' + counts[t] +
      '\n    （对不上说明算法或组合数学有一边错了，必须查清楚，不能改断言迁就代码）')
  }
  ok('全部 22100 手的牌型分布与组合数学完全一致：' +
     TYPE_NAMES.map((nm, i) => nm + ' ' + counts[i]).join(' / '))

  console.log('\n=== ⑥ 比较关系的自洽性（传递性）===')
  /*
   * 比较器必须是个全序：a>b 且 b>c ⇒ a>c。
   * 一旦不满足，就会出现"石头剪刀布"式的循环 —— 三个人的牌互相克制，
   * 谁先比谁后比会得出不同结果。这种错误极难在真机上被发现。
   */
  const rnd = (() => { let s = 42; return () => { s = (s * 1103515245 + 12345) % 2147483648; return s / 2147483648 } })()
  const hands = []
  for (let i = 0; i < 300; i++) {
    const d = shuffle(newDeck(), rnd)
    hands.push([d[0], d[1], d[2]])
  }
  let violations = 0
  for (let i = 0; i < hands.length; i++) {
    for (let j = 0; j < hands.length; j++) {
      for (let k = 0; k < hands.length; k++) {
        const ab = compare(hands[i], hands[j])
        const bc = compare(hands[j], hands[k])
        if (ab > 0 && bc > 0 && compare(hands[i], hands[k]) <= 0) violations++
      }
      /* 反对称性：a>b ⇔ b<a */
      if (compare(hands[i], hands[j]) !== -compare(hands[j], hands[i])) violations++
    }
  }
  assert.strictEqual(violations, 0, '比较器不满足全序（有 ' + violations + ' 处违反传递/反对称）')
  ok('300 手牌两两比较：满足传递性与反对称性')

  console.log('\n=== ⑦ 洗牌：52 张不丢不重 ===')
  for (let t = 0; t < 20; t++) {
    const d = shuffle(newDeck())
    assert.strictEqual(d.length, 52, '洗牌后必须还是 52 张')
    const seen = new Set(d.map(c => c.r + ':' + c.s))
    assert.strictEqual(seen.size, 52, '洗牌后不能有重复牌')
  }
  ok('20 次洗牌：每次都 52 张、无重复')

  console.log('\n=== ⑧ 牌面文字 ===')
  assert.strictEqual(cardText(C(14, SPADE)), '♠A')
  assert.strictEqual(cardText(C(10, HEART)), '♥10')
  assert.strictEqual(cardText(C(11, CLUB)), '♣J')
  ok('牌面文字：♠A / ♥10 / ♣J')

  console.log('\n' + '='.repeat(58))
  console.log('  牌型算法：全部 ' + n + ' 项断言通过')
  console.log('='.repeat(58) + '\n')
})()
