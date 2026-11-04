#!/usr/bin/env node
/**
 * test-page-coverage.js —— 模板里的每个 wx:if 分支，必须至少有一个 mock 状态能点亮它
 *
 * ============ 为什么需要 ============
 *
 * 2026-11-04：「我的」页只有 empty / off / clean 三个渲染状态，
 * 而模板里还有一个 `wx:if="{{diagOpen}}"` 的诊断弹层 —— **`diagOpen`
 * 在 data() 里没有、任何状态也不设，于是那个弹层从来没被渲染过。**
 *
 * 而它正是**用户报障时要截图发我的那个界面**。一个从没被看过的界面。
 *
 * 同类问题在房间页已经犯过一次（4 个玩法没有结算页渲染块），
 * 当时的修法是"每个玩法必须有结算块"。这里是同一个病的另一面：
 * **模板有分支，但没有状态能进那个分支。**
 *
 * ============ 判据 ============
 *
 * 对每个页面的每个 `wx:if` / `wx:elif` 表达式：
 *   把 `data()` 与每个 state 深合并 → 逐个求值 → 至少一次为真。
 *
 * 只支持**简单表达式**（标识符、比较、取反、&&、长度）。
 * 遇到理解不了的表达式**跳过并打印**，不假装已经验过。
 */
const fs = require('fs')
const path = require('path')

const ROOT = path.join(__dirname, '..')
const PAGES = [
  { name: '我的', wxml: 'miniprogram/pages/me/me.wxml', mock: 'scripts/ui-render/mock/me.js' },
  { name: '大厅', wxml: 'miniprogram/pages/lobby/lobby.wxml', mock: 'scripts/ui-render/mock/lobby.js' },
  /*
   * ★ 2026-11-04：加房间页。它有 75 个渲染状态、9 个玩法 × 4 个阶段，
   * wx:if 分支比另两个页面多一个量级 —— **最可能藏着没渲染过的分支**。
   */
  { name: '房间', wxml: 'miniprogram/game/room/room.wxml', mock: 'scripts/ui-render/mock/room.js' }
]

/** 把 {{expr}} 求值；不支持就返回 {ok:false} */
function evalExpr(expr, ctx) {
  const e = expr.trim()
  /* 只允许这些字符，防止执行任意代码 */
  if (!/^[!<>=&|0-9a-zA-Z_.\s\[\]'"+*-]+$/.test(e)) return { ok: false }
  /* 属性访问改成安全的取值 */
  /*
   * 属性访问（含 `.length`）原样保留 —— JS 里数组/字符串本来就能取 .length。
   * 只把**根标识符**换成 `ctx["x"]`，并跳过已经在 `ctx[...]` 里的那些。
   */
  const body = e.replace(/(^|[^\w$.'"])([a-zA-Z_]\w*)/g, (m, pre, id) => {
    if (['true', 'false', 'null', 'undefined', 'typeof'].indexOf(id) >= 0) return pre + id
    return pre + 'ctx[' + JSON.stringify(id) + ']'
  })
  try {
    /* eslint-disable no-new-func */
    const fn = new Function('ctx', 'return (' + body + ')')
    return { ok: true, val: fn(ctx) }
  } catch (e) {
    return { ok: false }
  }
}

let n = 0
function ok(msg) { n++; console.log('  ✓ ' + msg) }

const problems = []
const skipped = []

PAGES.forEach((pg) => {
  const wxml = fs.readFileSync(path.join(ROOT, pg.wxml), 'utf8')
  /* 去掉注释，避免注释里的 wx:if 被当成分支 */
  const clean = wxml.replace(/<!--[\s\S]*?-->/g, '')
  const exprs = [...clean.matchAll(/wx:(?:if|elif)="\{\{([^}]+)\}\}"/g)].map((m) => m[1].trim())
  const uniq = [...new Set(exprs)]

  const mock = require(path.join(ROOT, pg.mock))
  const base = typeof mock.data === 'function' ? mock.data() : mock.data
  const states = mock.states || {}

  /* 合并后的上下文：base + 每个 state（深合并一层，和渲染器一致） */
  const ctxs = {}
  Object.keys(states).forEach((k) => {
    const v = typeof states[k] === 'function' ? states[k]() : states[k]
    const merged = Object.assign({}, base)
    Object.keys(v || {}).forEach((f) => {
      const bv = base[f]
      const vv = v[f]
      merged[f] =
        bv && vv && typeof bv === 'object' && typeof vv === 'object' && !Array.isArray(bv)
          ? Object.assign({}, bv, vv)
          : vv
    })
    ctxs[k] = merged
  })

  uniq.forEach((expr) => {
    let anyTrue = false
    let evaluated = false
    Object.keys(ctxs).forEach((k) => {
      const r = evalExpr(expr, ctxs[k])
      if (!r.ok) return
      evaluated = true
      if (r.val) anyTrue = true
    })
    if (!evaluated) { skipped.push(pg.name + '：' + expr); return }
    if (!anyTrue) {
      problems.push(pg.name + ' 的 `wx:if="{{' + expr + '}}"` —— ' +
        '有 ' + Object.keys(states).length + ' 个状态，没有一个能触发它')
    }
  })
})

if (skipped.length) {
  console.log('  ⚠️ 这些表达式太复杂，跳过了（**不算验过**）：')
  skipped.forEach((x) => console.log('      ' + x))
}

if (problems.length) {
  console.log('  ✗ 这些模板分支没有任何 mock 状态能渲染出来：')
  problems.forEach((x) => console.log('      ' + x))
  console.log('  修法：在 mock 里补一个能进这个分支的状态 —— 一个从没被看过的界面等于没验过。')
  process.exitCode = 1
} else {
  ok('所有页面的 wx:if 分支都有 mock 状态能触发（' + PAGES.length + ' 个页面）')
}

console.log('\n' + '='.repeat(58) + '\n')

/* ============================================================================
 * ★★★ mock 的 states 里不许有重名（2026-11-04）
 *
 * 对象字面量的重复键会被**静默覆盖**：写在后面的赢，前面的根本不生效，
 * 而且不报错、不警告。
 *
 * 这一轮我被它坑了**两次**：
 *   · 新建 `uwTie`（两轮平票→卧底拖赢）→ 而库里早有 `uwTie`（首次平票→重投），
 *     我那个被覆盖，覆盖断言一直报"没状态能触发"
 *   · 新建 `wheelCard`（结算页的题卡）→ 库里早有 `wheelCard`（转轮中的题卡），
 *     同样被覆盖
 *
 * 症状是"我明明加了状态，断言还是说没有"—— 很容易误判成断言写错了。
 * 运行期查不出来（对象建出来时重名已经没了），只能查**源码**。
 * ========================================================================== */
{
  const fs2 = require('fs')
  const dupBad = []
  PAGES.forEach((pg) => {
    const src = fs2.readFileSync(require('path').join(ROOT, pg.mock), 'utf8')
    /* 只数 `states: {` 之后、4 空格缩进的 `名字: `（= 状态定义） */
    const si = src.indexOf('states:')
    const seg = si < 0 ? '' : src.slice(si)
    const names = [...seg.matchAll(/^\s{4}([a-zA-Z_]\w*):/gm)].map((m) => m[1])
    const seen = {}
    names.forEach((n) => {
      if (seen[n]) dupBad.push(pg.name + '：`' + n + '` 定义了两次（后面那个会静默覆盖前面）')
      seen[n] = 1
    })
  })
  if (dupBad.length) {
    console.log('  ✗ mock 状态重名（对象字面量重复键静默覆盖）：')
    dupBad.forEach((x) => console.log('      ' + x))
    process.exitCode = 1
  } else {
    ok('所有 mock 状态名唯一（无静默覆盖）')
  }
}
