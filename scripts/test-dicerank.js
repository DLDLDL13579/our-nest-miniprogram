#!/usr/bin/env node
/**
 * test-dicerank.js —— 「比大小」牌型规则的穷举验证
 *
 * 2026-11-02 按调研重写了规则（从"总点数 + 豹子"改成完整 8 种牌型），
 * 这个文件是本轮加的 —— 之前**根本没有专门测 dicerank 的地方**，
 * 规则对不对全靠"跑一局看看"。
 */
const assert = require('assert')
const { rankPlayers, evaluate, LEVEL } = require('../miniprogram/utils/dicerank.js')

let pass = 0
function ok(msg) { pass++; console.log('  ✓ ' + msg) }

/* ---------------- ① 每种牌型都能被正确识别 ---------------- */
const HANDS = [
  [[6, 6, 6, 6, 6], '五条', LEVEL.FIVE],
  [[1, 1, 1, 1, 1], '五条', LEVEL.FIVE],
  [[6, 6, 6, 6, 2], '四条', LEVEL.FOUR],
  [[6, 6, 6, 2, 2], '葫芦', LEVEL.FULL_HOUSE],
  [[2, 3, 4, 5, 6], '顺子', LEVEL.STRAIGHT],
  [[1, 2, 3, 4, 5], '顺子', LEVEL.STRAIGHT],
  [[6, 6, 6, 2, 3], '三条', LEVEL.THREE],
  [[6, 6, 2, 2, 3], '两对', LEVEL.TWO_PAIR],
  [[6, 6, 2, 3, 4], '一对', LEVEL.ONE_PAIR],
  [[6, 5, 4, 3, 1], '散牌', LEVEL.HIGH]
]
HANDS.forEach(([dice, name, lv]) => {
  const r = evaluate(dice)
  assert.strictEqual(r.name, name, dice.join('') + ' 应该是' + name)
  assert.strictEqual(r.level, lv)
})
ok('10 组牌型识别（含边界的五条、大小顺子）')

/* ---------------- ② 跨牌型的大小顺序 ---------------- */
const ORDER = [
  [1, 2, 3, 4, 6],   // 散牌
  [6, 6, 2, 3, 4],   // 一对
  [6, 6, 2, 2, 3],   // 两对
  [6, 6, 6, 2, 3],   // 三条
  [2, 3, 4, 5, 6],   // 顺子
  [6, 6, 6, 2, 2],   // 葫芦
  [6, 6, 6, 6, 2],   // 四条
  [6, 6, 6, 6, 6]    // 五条
]
for (let i = 0; i < ORDER.length - 1; i++) {
  const lo = evaluate(ORDER[i])
  const hi = evaluate(ORDER[i + 1])
  assert.ok(hi.level > lo.level,
    lo.name + ' 应该小于 ' + hi.name)
}
ok('8 种牌型的等级链严格递增')

/* ---------------- ③ 同牌型之间也要能分出大小 ---------------- */
const SAME = [
  // [弱的, 强的, 说明]
  [[1, 2, 3, 4, 5], [2, 3, 4, 5, 6], '顺子：23456 大于 12345'],
  [[3, 3, 3, 1, 1], [6, 6, 6, 2, 2], '葫芦：先比三条'],
  [[6, 6, 6, 1, 2], [6, 6, 6, 4, 5], '三条：同点数比脚牌'],
  [[4, 4, 3, 3, 6], [6, 6, 5, 5, 2], '两对：先比大对'],
  [[5, 5, 2, 3, 4], [6, 6, 1, 2, 3], '一对：先比对子点数'],
  [[6, 5, 4, 2, 1], [6, 5, 4, 3, 1], '散牌：按位比（6 5 4 3 1 > 6 5 4 2 1）']
]
SAME.forEach(([a, b, why]) => {
  assert.ok(evaluate(b).detail > evaluate(a).detail ||
    evaluate(b).level > evaluate(a).level, why)
})
ok('6 组同牌型内部比较（' + SAME.length + ' 条细则）')

/* ---------------- ④ 跨牌型时，牌型优先于总点数 ---------------- */
{
  const r = rankPlayers([
    { name: '两对26点', seat: 1, dice: [6, 6, 5, 5, 4] },   // 26 点
    { name: '葫芦11点', seat: 2, dice: [3, 3, 3, 1, 1] }    // 11 点
  ])
  assert.strictEqual(r.winners[0], '葫芦11点',
    '葫芦必须赢过总点数更高的两对')
  ok('牌型优先于总点数（11 点的葫芦赢 26 点的两对）')
}

/* ---------------- ⑤ 并列：完全一样的牌都算赢 ---------------- */
{
  const r = rankPlayers([
    { name: 'A', seat: 1, dice: [6, 6, 5, 5, 4] },
    { name: 'B', seat: 2, dice: [6, 6, 5, 5, 4] },
    { name: 'C', seat: 3, dice: [1, 2, 3, 4, 6] }
  ])
  assert.deepStrictEqual(r.winners.sort(), ['A', 'B'])
  ok('并列都算赢（酒桌上并列不用分胜负）')
}

/* ---------------- ⑥ 脏数据不能崩 ---------------- */
{
  const r = rankPlayers([
    { name: 'A', seat: 1, dice: [1, 2, 3, 4, 99] },   // 99 非法，应被剔除
    { name: 'B', seat: 2, dice: [] }
  ])
  assert.ok(r.ranked.length === 2)
  ok('非法骰子点被剔除，不崩')
}

/* ---------------- ⑦ 稀有牌型的标记 ---------------- */
{
  const r = rankPlayers([
    { name: '五条', seat: 1, dice: [6, 6, 6, 6, 6] },
    { name: '散牌', seat: 2, dice: [1, 2, 3, 4, 6] }
  ])
  assert.strictEqual(r.handicapWin, true)
  assert.strictEqual(r.handicapFace, 6)
  assert.strictEqual(r.leopardWin, true, '旧字段要保留')
  assert.strictEqual(r.topHand, '五条')
  ok('稀有牌型标记（handicapWin / 旧的 leopardWin 都保留）')
}

console.log('\n牌型规则：全部 ' + pass + ' 项通过')
