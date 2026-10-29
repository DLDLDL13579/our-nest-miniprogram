/**
 * test-toast.js —— toast 的显示时长够不够读完
 *
 * ============ 为什么值得测 ============
 *
 * `wx.showToast` 默认 1500ms。而一条 15 个字的提示，正常人要 2 秒以上才读完 ——
 * 读不完的后果不是"少看一句"，是**以为这功能坏了**：
 * 「点了没反应」的那类反馈里，有一部分其实是"提示已经消失了"。
 *
 * 判据：约 **150ms/字**（中文），英文按 0.6 折算。不够就报。
 *
 * 跑法：node scripts/test-toast.js
 */
const fs = require('fs')
const path = require('path')
const assert = require('assert')

const ROOT = path.join(__dirname, '..')
const files = []
;(function walk(d) {
  for (const f of fs.readdirSync(d, { withFileTypes: true })) {
    const fp = path.join(d, f.name)
    if (f.isDirectory()) { walk(fp); continue }
    if (f.name.endsWith('.js')) files.push(fp)
  }
})(path.join(ROOT, 'miniprogram'))

const MS_PER_CHAR = 150
const bad = []
for (const f of files) {
  const src = fs.readFileSync(f, 'utf8').replace(/\/\*[\s\S]*?\*\//g, '')
  for (const m of src.matchAll(/showToast\(\s*(\{[^}]*\}|[^)]*)\)/g)) {
    const block = m[1]
    const tm = /title:\s*'([^']*)'/.exec(block) || /title:\s*"([^"]*)"/.exec(block)
    if (!tm) continue           // title 是变量（如服务端返回的话）→ 长度未知，跳过
    const text = tm[1]
    const dm = /duration:\s*(\d+)/.exec(block)
    const dur = dm ? Number(dm[1]) : 1500
    const cn = (text.match(/[\u4e00-\u9fa5]/g) || []).length
    const other = text.replace(/[\u4e00-\u9fa5]/g, '').length
    const need = Math.round((cn + other * 0.6) * MS_PER_CHAR)
    if (dur < need) bad.push({ f: path.relative(ROOT, f), text, dur, need })
  }
}

if (bad.length) {
  console.log('✗ 这些 toast 读不完就消失了：')
  for (const b of bad) {
    console.log(`    ${b.f}：「${b.text}」 ${b.dur}ms < 约需 ${b.need}ms`)
  }
  process.exit(1)
}
console.log(`✓ ${files.length} 个文件里的 toast 时长都够读完（约 ${MS_PER_CHAR}ms/字）`)
