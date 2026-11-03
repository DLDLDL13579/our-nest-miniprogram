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

/*
 * ★★ 2026-11-03：清单从**硬编码**改成**自动扫描**。
 *
 *   原来是 `const MODS = ['games.js', ...]` —— 而它漏了两个：
 *     · `liarRules.js`（2019…不，2026-10 加的起叫公式）
 *     · `betweenRules.js`（今天加的射龙门判定器）
 *   漏掉的表现是**这条断言对它们是绿的，只是从来没比过** ——
 *   和 `deploy.sh` 曾经硬编码函数清单、`sync-derive.sh` 曾经硬编码路径
 *   是同一个病：**清单是手写的，就会有人忘记加。**
 *
 *   现在的判据是**结构性的**：
 *     云函数目录里存在的 .js 文件，如果 `miniprogram/utils/` 里有同名文件，
 *     它就是"共享模块"，必须逐字节一致。
 *   加新的共享模块 → 只要 sync-derive 复制过去，这条断言自动覆盖它。
 *
 *   ⚠️ 反过来也要防：如果哪天有人把**云端独有**的文件（如 index.js）误判成共享模块，
 *      这里会报"源文件不存在"。当前 `miniprogram/utils/` 下没有 index.js，
 *      所以不会误报；规则写在下面那句 continue 里。
 */
function discoverMods() {
  const utilsDir = path.join(ROOT, 'miniprogram', 'utils')
  const seen = new Set()
  for (const fn of fs.readdirSync(path.join(ROOT, 'cloudfunctions'))) {
    const dir = path.join(ROOT, 'cloudfunctions', fn)
    if (!fs.existsSync(path.join(dir, 'index.js'))) continue
    for (const f of fs.readdirSync(dir)) {
      if (!f.endsWith('.js')) continue
      if (f === 'index.js') continue                       /* 云函数入口，不是共享模块 */
      if (!fs.existsSync(path.join(utilsDir, f))) continue  /* 云端独有，没有前端源 */
      seen.add(f)
    }
  }
  return Array.from(seen).sort()
}
const MODS = discoverMods()

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
