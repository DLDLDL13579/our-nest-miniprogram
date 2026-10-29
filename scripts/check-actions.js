#!/usr/bin/env node
/**
 * check-actions.js —— 前端调用的云函数 action 必须真实存在
 *
 * ============ 为什么需要它，以及它曾经是个空检查 ============
 *
 * 2026-10-08 真实踩过：前端调 room 的 `spin`，但云端 room 还是旧版
 * （没有这个 action），返回 `{ ok:false, msg:'不认识的操作：spin' }`，
 * 转盘直接不能用。这类错配**本地完全自洽**：语法对、绑定对、断言全绿。
 *
 * 但这段逻辑原来是用 `node -e "..."` **嵌在 check.sh 里**的，而且只扫
 * `miniprogram/pages` —— 房间页在**分包** `miniprogram/game/` 下，一个都扫不到，
 * 于是恒报"0 处调用、全部一致"。**永远通过的空检查。**
 *
 * 现在独立成文件：不嵌 shell 字符串（没有转义雷），能单独跑，也能被断言。
 *
 * 跑法：node scripts/check-actions.js
 */
const fs = require('fs')
const path = require('path')

const ROOT = path.join(__dirname, '..')

/* ① 每个云函数支持哪些 action */
const actionsOf = {}
for (const fn of fs.readdirSync(path.join(ROOT, 'cloudfunctions'))) {
  const entry = path.join(ROOT, 'cloudfunctions', fn, 'index.js')
  if (!fs.existsSync(entry)) continue
  const src = fs.readFileSync(entry, 'utf8')
  const set = new Set()
  const re = /action\s*===\s*'([a-zA-Z_]+)'/g
  let m
  while ((m = re.exec(src))) set.add(m[1])
  actionsOf[fn] = set
}

/* ② 前端所有 js（**主包 + 分包都要扫**） */
function walkJs(dir, out) {
  out = out || []
  if (!fs.existsSync(dir)) return out
  for (const f of fs.readdirSync(dir)) {
    const p = path.join(dir, f)
    if (fs.statSync(p).isDirectory()) walkJs(p, out)
    else if (f.endsWith('.js')) out.push(p)
  }
  return out
}
const files = [
  ...walkJs(path.join(ROOT, 'miniprogram/pages')),
  ...walkJs(path.join(ROOT, 'miniprogram/game'))
]

/* ③ 找出前端调用的 (fn, action) */
const bad = []
let checked = 0
for (const js of files) {
  const src = fs.readFileSync(js, 'utf8')
  // 先剥注释，避免把文档里的例子算进来
  const clean = src.replace(/\/\*[\s\S]*?\*\//g, '').replace(/(^|[^:])\/\/[^\n]*/g, '$1')
  const re = /call\(\s*'([a-zA-Z]+)'\s*,\s*\{[^}]*?action:\s*'([a-zA-Z_]+)'/g
  let m
  while ((m = re.exec(clean))) {
    const [, fn, act] = m
    if (!actionsOf[fn]) continue          // 不是云函数名（比如本地函数叫 call）
    checked++
    if (!actionsOf[fn].has(act)) {
      bad.push(path.relative(ROOT, js) + ' 调 ' + fn + '.' + act + '，但云函数里没有这个 action')
    }
  }
}

if (bad.length) {
  console.log('  ✗ 前端调用了不存在的 action：')
  for (const b of bad) console.log('     ' + b)
  process.exit(1)
}
if (!checked) {
  /* 扫到 0 处本身就是个信号 —— 要么写法变了、要么扫描范围错了 */
  console.log('  ✗ 一处云函数调用都没扫到 —— 扫描范围或匹配规则可能坏了')
  process.exit(1)
}
console.log('  ✓ ' + checked + ' 处云函数调用都有对应的 action（扫了 ' + files.length + ' 个前端 js）')
