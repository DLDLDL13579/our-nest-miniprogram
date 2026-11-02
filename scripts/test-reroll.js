#!/usr/bin/env node
/**
 * test-reroll.js —— 单骰重摇的三道约束（2026-11-02）
 *
 * 这个功能是照着真实酒桌规则加的（维基百科「大话骰」：
 * 「单骰，5 个骰子点数各不同，可出示后重摇，但次数不能超三次」）。
 *
 * 而它的三道校验**一条测试都没有** —— 用 verify-assert.py 把
 * `if (new Set(cur).size !== cur.length)` 改成恒假，测试照样绿。
 * 这条文件补上。
 */
const assert = require('assert')
const fs = require('fs')
const path = require('path')

const ROOT = path.join(__dirname, '..')
const SRC = fs.readFileSync(path.join(ROOT, 'cloudfunctions/room/index.js'), 'utf8')

let pass = 0
const ok = (m) => { pass++; console.log('  ✓ ' + m) }

/*
 * 这里**不真跑云函数**（要连数据库），而是从源码里抽出 reroll 分支的校验逻辑，
 * 用同样的判据重算一遍 —— 和 test-game.js 抽数组字面量是同一个思路。
 *
 * ⚠️ 这个做法的风险：源码改了而抽取正则没跟上，测试会继续测旧逻辑。
 *    所以下面先断言"抽到了"，抽不到就直接失败（而不是静默跳过）。
 */
const start = SRC.indexOf("if (action === 'reroll')")
assert.ok(start > 0, '源码里找不到 reroll 分支')
const end = SRC.indexOf("if (action === 'roll')", start)
assert.ok(end > start, '找不到 reroll 分支的结尾')
const block = SRC.slice(start, end)
console.log('  抽到 reroll 分支 ' + block.length + ' 字符')

/* ① 必须是单骰才能重摇 */
assert.ok(/new Set\(cur\)\.size !== cur\.length/.test(block),
  '缺少「必须是单骰」的校验')
ok('校验①：五颗点数必须全不同（单骰）')

/* ② 次数上限 3 */
assert.ok(/used >= 3/.test(block), '缺少次数上限校验')
assert.ok(/rerollCount: used \+ 1/.test(block), '重摇后没有把次数 +1')
ok('校验②：最多 3 次，且次数递增')

/* ③ 叫过骰就不能重摇（用座位号比对） */
assert.ok(/room\.bid\.bySeat === meR\.seat/.test(block),
  '缺少「叫过骰不能重摇」的校验')
ok('校验③：叫过骰就不能重摇（按座位号比对，不用 openid）')

/* ④ 新一摇要把次数归零 */
assert.ok(/rerollCount: 0/.test(SRC), 'roll 时没有把 rerollCount 归零')
ok('校验④：新摇一盅时 rerollCount 归零')

/* ⑤ 校验的顺序：单骰判定必须在改写骰子之前（否则可能改了才发现不合格） */
{
  const iCheck = block.indexOf('new Set(cur).size !== cur.length')
  const iWrite = block.indexOf('dice2 = []')
  assert.ok(iCheck > 0 && iWrite > iCheck,
    '单骰校验必须在生成新骰子之前')
  ok('校验⑤：先校验后改写（不合格的请求不会动数据）')
}

console.log('\n单骰重摇：全部 ' + pass + ' 项通过')
