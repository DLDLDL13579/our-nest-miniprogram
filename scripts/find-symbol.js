#!/usr/bin/env node
/**
 * find-symbol.js —— 查一个符号「定义在哪、被谁调用、调用处被什么包着」
 *
 * ============ 为什么需要这个 ============
 *
 * 2026-11-03 这一天，我**五次**差点改错一个正确的东西，全部源于同一个错误：
 *
 *   「数了调用点，但没看它被谁包着」
 *
 * 最典型的一次：查 `celebrate()` 只在两处调用，于是判断
 * 「比大小赢了没有撒花」—— 而第三处在 `setTimeout(..., 820)` 的闭包里，
 * `grep` 明明看到了，但**数"处"的时候没算它**。
 *
 * 所以这个工具不只列出匹配行，还标出**所在作用域**：
 *   · 在 setTimeout / setInterval 里        → 延迟执行
 *   · 在 .then / .catch / await 后          → 异步
 *   · 在 if / else 里                       → 条件执行
 *   · 在箭头函数里                          → 闭包
 *
 * ============ 用法 ============
 *   node scripts/find-symbol.js celebrate
 *   node scripts/find-symbol.js --def celebrate
 */
const fs = require('fs')
const path = require('path')

const ROOT = path.dirname(__dirname)
const SCAN_DIRS = ['miniprogram', 'cloudfunctions']
const EXT = /\.(js|wxml)$/

function walk(dir, out) {
  if (!fs.existsSync(dir)) return
  fs.readdirSync(dir).forEach(f => {
    const p = path.join(dir, f)
    const st = fs.statSync(p)
    if (st.isDirectory()) {
      if (f === 'node_modules' || f === '.git') return
      walk(p, out)
    } else if (EXT.test(f)) {
      out.push(p)
    }
  })
  return out
}

/** 看这一行往上 12 行，判断它被什么包着 */
function contextOf(lines, idx) {
  const tags = []
  for (let i = idx; i >= Math.max(0, idx - 12); i--) {
    const l = lines[i]
    if (/setTimeout\s*\(|setInterval\s*\(/.test(l)) tags.push('定时器')
    else if (/\.then\s*\(|\.catch\s*\(|await\s/.test(l)) tags.push('异步')
    else if (/^\s*(if|else if|else)\b/.test(l)) tags.push('条件')
    else if (/=>\s*\{?/.test(l) && !/function\s+\w+/.test(l)) tags.push('闭包')
    if (/^\s*\w+\s*\([^)]*\)\s*\{\s*$/.test(l) && !/if|for|while|switch/.test(l)) {
      tags.push('方法')
      break
    }
  }
  return [...new Set(tags)]
}

function main() {
  const args = process.argv.slice(2)
  const onlyDef = args.includes('--def')
  const name = args.find(a => !a.startsWith('--'))
  if (!name) {
    console.error('用法: node scripts/find-symbol.js <符号名> [--def]')
    process.exit(2)
  }

  const files = SCAN_DIRS.reduce((a, d) => walk(path.join(ROOT, d), a), [])
  const hits = []
  const re = new RegExp('\\b' + name + '\\b')

  files.forEach(f => {
    const src = fs.readFileSync(f, 'utf8')
    if (!re.test(src)) return
    const lines = src.split('\n')
    lines.forEach((l, i) => {
      if (!re.test(l)) return
      const isDef = new RegExp(
        '(function\\s+' + name + '\\b|^\\s*(async\\s+)?' + name + '\\s*\\([^)]*\\)\\s*\\{|const\\s+' + name + '\\s*=|let\\s+' + name + '\\s*=|var\\s+' + name + '\\s*=)'
      ).test(l)
      if (onlyDef && !isDef) return
      hits.push({
        file: path.relative(ROOT, f),
        line: i + 1,
        text: l.trim().slice(0, 100),
        isDef,
        ctx: isDef ? [] : contextOf(lines, i)
      })
    })
  })

  if (!hits.length) {
    console.log('（没有出现）')
    return
  }

  const defs = hits.filter(h => h.isDef)
  const calls = hits.filter(h => !h.isDef)

  console.log('符号: ' + name)
  console.log('定义: ' + defs.length + ' 处')
  defs.forEach(h => console.log('  ' + h.file + ':' + h.line + '  ' + h.text))

  if (onlyDef) return

  console.log('引用: ' + calls.length + ' 处')
  const byCtx = {}
  calls.forEach(h => {
    const key = h.ctx.length ? h.ctx.join('+') : '直接'
    ;(byCtx[key] = byCtx[key] || []).push(h)
  })
  Object.keys(byCtx).sort().forEach(k => {
    console.log('  [' + k + '] ' + byCtx[k].length + ' 处')
    byCtx[k].forEach(h => console.log('    ' + h.file + ':' + h.line + '  ' + h.text.slice(0, 80)))
  })

  console.log('')
  console.log('⚠️ 数"几处"之前先看上面每个 [作用域] ——')
  console.log('   同一个逻辑藏在定时器/闭包/条件里时，它在行为上和"另一处"是等价的。')
}

main()
