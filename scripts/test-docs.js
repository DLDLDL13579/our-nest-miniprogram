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
