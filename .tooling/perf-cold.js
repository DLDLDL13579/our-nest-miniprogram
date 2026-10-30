#!/usr/bin/env node
/**
 * perf-cold.js —— 冷启动实测：从打开到大厅可用要多久
 *
 * ⚠️ 2026-10-30 重写。旧版测的是 `pages/index/index` 的 `p.data.D` ——
 *    **那个页面在 2026-10-27 转酒桌时已经删了**，所以它从那天起就一直失败，
 *    但没人跑它，也就没人发现。报错还是包装成 `[object Object]` 的。
 *
 * 现在测真实的：
 *   1. 清缓存（模拟第一次打开）
 *   2. 打开大厅，等「能建房」为止
 *   3. 报耗时 + 走了缓存没有
 *
 * 用法：node .tooling/perf-cold.js
 */
const automator = require('miniprogram-automator')
const path = require('path')

const ROOT = path.join(__dirname, '..')
const CLI = '/Applications/wechatwebdevtools.app/Contents/MacOS/cli'

;(async () => {
  const mini = await automator.launch({ cliPath: CLI, projectPath: ROOT, timeout: 90000 })
  try {
    const t0 = Date.now()
    /* tabBar 页只能 switchTab（navigateTo 会静默失败） */
    await mini.switchTab('/pages/lobby/lobby').catch(() => {})
    /* automator 启动后要等页面真正就绪，否则 evaluate 会 timeout */
    await new Promise(r => setTimeout(r, 5000))

    const r = await mini.evaluate(async () => {
      try { wx.clearStorageSync() } catch (e) {}
      const t = Date.now()
      return await new Promise((resolve) => {
        const timer = setInterval(() => {
          const pages = getCurrentPages()
          const p = pages[pages.length - 1]
          /* 大厅"能用了"的判据：玩法卡渲染出来（games 非空） */
          if (p && p.data && Array.isArray(p.data.list) && p.data.list.length > 0) {
            clearInterval(timer)
            resolve({ ms: Date.now() - t, n: p.data.list.length })
          }
          if (Date.now() - t > 15000) { clearInterval(timer); resolve({ ms: -1, n: 0 }) }
        }, 20)
      })
    })

    const total = Date.now() - t0
    console.log('=== 冷启动实测（清了全部缓存）===')
    if (r.ms < 0) {
      console.log('  ✗ 15 秒内大厅没准备好 —— 可能是云函数冷启动卡住')
      process.exitCode = 1
    } else {
      console.log('  玩法卡渲染: ' + r.ms + 'ms（' + r.n + ' 个玩法）')
      console.log('  从启动到可用（含 automator 开销）: ' + total + 'ms')
      console.log(r.ms < 3000 ? '  ✓ 3 秒内可用' : '  ⚠️ 超过 3 秒，用户会感到"卡"')
    }
  } finally {
    await mini.close().catch(() => {})
  }
})().catch(e => { console.error('失败:', e && (e.message || e)); process.exit(1) })
