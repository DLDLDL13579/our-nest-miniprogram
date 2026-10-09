/**
 * test-error-feedback.js —— 用户操作失败时**必须有反馈**，不能静默
 *
 * ============ 为什么需要它 ============
 *
 * 2026-10-09 用户实测报「点击叫骰没有反应」。
 *
 * 根因是 `utils/cloud.js` 的契约：**业务失败会 throw，不是返回 { ok:false }**：
 *
 *     if (r.ok !== true) { throw e }     // 见 cloud.js:19-23
 *
 * 而页面里写的是：
 *
 *     const r = await call(...).catch(() => null)
 *     if (r && r.ok) { ... }              // r 是 null，不进
 *     else if (r && !r.ok) { 提示 }       // r 是 null，也不进  → 什么都没发生
 *
 * `.catch(() => null)` 把真实原因吞成 null，两个分支**一个都进不去**。
 * 用户看到的就是「点了完全没反应」——既没成功、也没报错。
 *
 * ★ 这类 bug 的可怕之处：**不报错、不崩溃、测试全绿**，
 *   只有真人点下去才知道。所以必须用静态断言锁住。
 *
 * 判据：凡是 `call(...).catch(handler)` 之后又用 `r && r.ok` 判断的，
 *      handler 里**必须给出用户可见的提示**（wx.showToast / showModal）。
 *      写成 `.catch(() => null)` 又不提示的 = 静默失败。
 *
 * 跑法：node scripts/test-error-feedback.js
 */
const fs = require('fs')
const path = require('path')
const assert = require('assert')

const ROOT = path.join(__dirname, '..')
let n = 0
function ok(msg) { n++; console.log('  ✓ ' + msg) }

/* 收集所有页面 js */
function walkJs(dir, out) {
  out = out || []
  fs.readdirSync(dir).forEach(f => {
    const p = path.join(dir, f)
    if (fs.statSync(p).isDirectory()) walkJs(p, out)
    else if (f.endsWith('.js')) out.push(p)
  })
  return out
}

;(() => {
  console.log('\n=== 用户操作失败时必须有反馈（不能静默吞掉）===')

  const files = walkJs(path.join(ROOT, 'miniprogram/pages'))
  const silent = []
  let checkedCalls = 0

  files.forEach(f => {
    const src = fs.readFileSync(f, 'utf8')
    const clean = src.replace(/\/\*[\s\S]*?\*\//g, '').replace(/(^|[^:])\/\/[^\n]*/g, '$1')
    const lines = clean.split('\n')

    lines.forEach((line, i) => {
      /* 找 `await call(...)...catch(handler)` —— handler 可能在下一行 */
      if (!/await\s+call\(|=\s*call\(/.test(line)) return
      /* 往后看 6 行，找到 .catch( 的完整 handler */
      const chunk = lines.slice(i, i + 6).join('\n')
      const m = /\.catch\(\s*(\([^)]*\)\s*=>|function\s*\([^)]*\))\s*\{?([\s\S]*?)\}?\s*\)/.exec(chunk)
      if (!m) return
      const handler = m[2] || ''
      checkedCalls++

      /* handler 里有没有给用户反馈？ */
      const hasToast = /showToast|showModal|showLoading/.test(handler)
      /* 有没有把错误传给别人（比如 setData({err:...})）？也算有反馈 */
      const hasSetErr = /setData\([^)]*err/i.test(handler)
      /*
       * ★ 要区分"只读加载"和"用户操作"—— 两者标准不同：
       *
       *   · **只读加载**（列表/状态刷新）：失败时不弹 toast 是**对的** ——
       *     它可能每次进页面都跑，弹一屏提示反而烦；这类页面另有 netTip /
       *     空态 / 缓存兜底。所以按"读操作"放行。
       *   · **用户操作**（叫骰/摇骰/开骰/转盘/开局/再来一局）：失败**必须**说话。
       *     用户是主动点下去的，没反应就只能以为"界面坏了"。
       *
       * ⚠️ 判据不能用"有没有 silent:true"—— 用户操作也带 silent（为了不弹
       *    通用 toast，改由自己给精准文案）。所以按 **action 名** 区分。
       */
      const READ_ACTIONS = /action:\s*'(status|list|stats|detail|get|query|home)'/
      const isReadOnly = READ_ACTIONS.test(chunk) ||
        /* home / wishes / reminds 这类"拿数据"的调用（没有 action 字段，看函数名） */
        /call\(\s*'(home|chronicle|wishes|reminds|moments|capsule|mood|pair)'/.test(chunk)

      if (!hasToast && !hasSetErr && !isReadOnly) {
        silent.push(path.relative(ROOT, f) + ':' + (i + 1) +
          '\n      ' + line.trim().slice(0, 78))
      }
    })
  })

  assert.deepStrictEqual(silent, [],
    '★ 这些调用把业务失败**静默吞掉**了（用户点了没反应）：\n    ' +
    silent.join('\n    ') +
    '\n\n    原因：utils/cloud.js 在 ok!==true 时会 **throw**，' +
    '\n    `.catch(() => null)` 会把它吞成 null，后面的 `r && r.ok` 分支进不去。' +
    '\n    修法：catch 里用 `e.friendly || e.message` 给用户一句提示。')
  ok(`${checkedCalls} 处云函数调用都会把失败原因告诉用户（无静默吞错）`)

  console.log(`\n${'='.repeat(58)}`)
  console.log(`  错误反馈：全部 ${n} 项断言通过`)
  console.log(`${'='.repeat(58)}\n`)
})()

process.on('uncaughtException', (e) => {
  console.error('\n  ✗ 断言失败：', e.message, '\n')
  process.exit(1)
})
