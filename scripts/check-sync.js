#!/usr/bin/env node
/**
 * check-sync.js —— 前后端共享模块是否一致（**只读比对，不写文件**）
 *
 * ============ 为什么单独抽出来 ============
 *
 * 这件事原来在这两个地方各写了一遍，而且**两处都是空检查**：
 *   · `check.sh` 第 4 项：直接跑 `sync-derive.sh`（写文件的同步），
 *     同步完再报"一致" —— 当然一致。
 *   · `health.sh` 第 6 项：同样跑 sync，还顺带 grep 一下输出。
 *
 * 抽成一份只读比对，两个脚本都调它。顺带把 `dicerank.js` 也纳进来
 * （原来两边都只比 4 个，漏了它）。
 *
 * 跑法：node scripts/check-sync.js
 */
const fs = require('fs')
const path = require('path')

const ROOT = path.join(__dirname, '..')
/* 这些是"前端写一份、云端复制一份"的纯数据模块 */
const MODS = ['games.js', 'decks.js', 'words.js', 'poker.js', 'dicerank.js']

const bad = []
let checked = 0
for (const fn of fs.readdirSync(path.join(ROOT, 'cloudfunctions'))) {
  const dir = path.join(ROOT, 'cloudfunctions', fn)
  if (!fs.existsSync(path.join(dir, 'index.js'))) continue
  for (const m of MODS) {
    const dst = path.join(dir, m)
    if (!fs.existsSync(dst)) continue        // 这个云函数不用这个模块
    const src = path.join(ROOT, 'miniprogram/utils', m)
    checked++
    if (!fs.existsSync(src)) {
      bad.push(path.join('cloudfunctions', fn, m) + ' 在，但源文件 miniprogram/utils/' + m + ' 没了')
      continue
    }
    if (fs.readFileSync(src, 'utf8') !== fs.readFileSync(dst, 'utf8')) {
      bad.push('cloudfunctions/' + fn + '/' + m + ' 和 miniprogram/utils/' + m + ' 内容不同')
    }
  }
}

if (bad.length) {
  console.log('  ✗ 前后端共享模块不一致（改完记得跑 bash scripts/sync-derive.sh）：')
  for (const b of bad) console.log('     ' + b)
  process.exit(1)
}
if (!checked) {
  console.log('  ✗ 一份共享模块都没比到 —— 目录结构或模块清单可能变了')
  process.exit(1)
}
console.log('  ✓ ' + checked + ' 份共享模块前后端一致（只读比对，不写文件）')
