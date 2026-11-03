/**
 * test-docs.js —— 文档里引用的 .md 文件必须真的存在
 *
 * ============ 为什么值得做 ============
 *
 * 2026-10-29 发现 `AGENTS.md` 里把 `miniprogram/utils/feedback.js`
 * 写成了旧路径（实际早搬到 game/ 下）—— 照着找会扑空。
 * 这类错误不报错，只是让下一个人多花时间。
 *
 * ⚠️ 判据要注意**根目录和 docs/ 两个位置**：
 *    第一版只查 `docs/xxx.md`，把索引里写的"根目录 AGENTS.md"误报成不存在。
 *    引用可以指向这两个地方中的任何一个。
 *
 * 跑法：node scripts/test-docs.js
 */
const fs = require('fs')
const path = require('path')
const assert = require('assert')

/*
 * ★ 2026-11-03：**兼容层**。
 *
 * 本仓库三个测试脚本用了三套不同的输出方式：
 *   · `test-contract.js` → `assert` + `ok()`（`ok` 是它自己定义的）
 *   · `test-mock.js`     → `assert` + `console.log`
 *   · `test-docs.js`     → 纯 `console.log` + `process.exitCode`   ← 原来没有 assert
 *
 * 而"从别的文件复制一段断言过来"时，最常见的失败是 `ReferenceError: assert is not defined` ——
 * **它会整个文件崩掉，而不是"这一条不通过"**（这个坑我一天踩了两次）。
 *
 * 所以这里把 `assert` 引进来，让复制过来的断言至少能跑；
 * 而 `ok()` 也定义成 `console.log` 的语法糖，让三种写法都能用。
 */
function ok(msg) { console.log('  ' + msg) }

const ROOT = path.join(__dirname, '..')
const DOCS = path.join(ROOT, 'docs')

/* 要检查的文档：docs 下全部 .md + 根目录的 README/AGENTS */
const sources = fs.readdirSync(DOCS)
  .filter(f => f.endsWith('.md'))
  .map(f => path.join(DOCS, f))
for (const f of ['README.md', 'AGENTS.md']) {
  const p = path.join(ROOT, f)
  if (fs.existsSync(p)) sources.push(p)
}

const bad = []
for (const src of sources) {
  const text = fs.readFileSync(src, 'utf8')
  /* 只查反引号里的 .md 引用（正文里随口提到的路径不算"导航"） */
  for (const m of text.matchAll(/`([a-zA-Z0-9_./-]+\.md)`/g)) {
    const ref = m[1]
    /* 两个位置任一存在即可 */
    const inDocs = fs.existsSync(path.join(DOCS, ref))
    const inRoot = fs.existsSync(path.join(ROOT, ref))
    if (!inDocs && !inRoot) {
      bad.push(path.relative(ROOT, src) + ' → ' + ref)
    }
  }
}

if (bad.length) {
  console.log('✗ 这些文档引用指向不存在的文件：')
  for (const b of bad) console.log('    ' + b)
  console.log('    （引用可以指向 docs/ 或根目录，但必须真的存在）')
  process.exit(1)
}
console.log(`✓ ${sources.length} 份文档里的 .md 引用都有效（docs/ 与根目录两个位置都认）`)

/* ============================================================================
 * 2026-11-03 追加：**文档里提到的文件必须真的存在**
 *
 * 文档写 `docs/待部署清单.md` 或 `scripts/size.py` 时，读者会去点它。
 * 而**文件被删/改名后，文档里的路径会变成一个死链接** —— 不报错，只是找不到。
 *
 * 判据：只查反引号包起来的路径（那是"这是文件"的明确信号），不查正文里的随口提及。
 * ========================================================================== */
{
  const missing = []
  const files = [...require('fs').readdirSync(path.join(ROOT, 'docs'))
    .filter(f => f.endsWith('.md')).map(f => path.join(ROOT, 'docs', f)),
    path.join(ROOT, 'AGENTS.md')]

  files.forEach(f => {
    if (!fs.existsSync(f)) return
    const src = fs.readFileSync(f, 'utf8')
    const rel = path.relative(ROOT, f)
    ;[...src.matchAll(/`(docs\/[\w\u4e00-\u9fa5./-]+\.md|scripts\/[\w.-]+\.(?:js|py|sh))`/g)]
      .forEach(m => {
        if (!fs.existsSync(path.join(ROOT, m[1]))) {
          missing.push(rel + ' → ' + m[1])
        }
      })
  })

  const uniq = [...new Set(missing)]
  if (uniq.length) {
    console.log('  ✗ 这些文档引用的文件不存在（死链接）：')
    uniq.forEach(x => console.log('    ' + x))
    process.exitCode = 1
  } else {
    console.log('  ✓ 文档里提到的 docs/*.md 和 scripts/* 都存在（没有死链接）')
  }
}
