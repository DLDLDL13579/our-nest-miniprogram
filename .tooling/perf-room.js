/**
 * perf-room.js —— 实测 room 页轮询的真实开销（用 automator 连接已开的工具）。
 *
 * 用 connect 而不是 launch：工具已经开着时 launch 会因端口占用失败。
 * ⚠️ 但 AGENTS.md 记录过 connect 的坑（拿不到 data()/$()）——
 *    这里只用 evaluate（不依赖元素句柄），所以 connect 是安全的。
 */
const automator = require('miniprogram-automator')
const path = require('path')

;(async () => {
  const mini = await automator.connect({ wsEndpoint: 'ws://localhost:9420' })
  console.log('✓ 已连接（9420）\n')

  const r = await mini.evaluate(async () => {
    const out = {}
    const c = (await wx.cloud.callFunction({
      name: 'room', data: { action: 'create', name: '性能探针', game: 'liar' }
    })).result
    const id = c.room.id

    const times = [], sizes = []
    for (let i = 0; i < 6; i++) {
      const t0 = Date.now()
      const res = await wx.cloud.callFunction({ name: 'room', data: { action: 'status', id: id } })
      times.push(Date.now() - t0)
      sizes.push(JSON.stringify(res.result).length)
    }
    await wx.cloud.callFunction({ name: 'room', data: { action: 'leave', id: id } })

    out.times = times
    out.sizes = sizes
    out.avg = Math.round(times.reduce((a, b) => a + b, 0) / times.length)
    out.avgSize = Math.round(sizes.reduce((a, b) => a + b, 0) / sizes.length)
    return out
  })

  console.log('=== 轮询实测（房间页每 1.5s 打一次 status）===')
  console.log(`  status 耗时: ${r.times.join(' / ')} ms`)
  console.log(`  平均 ${r.avg}ms`)
  console.log(`  响应体积: ${r.sizes.join(' / ')} 字节`)
  console.log(`  平均 ${r.avgSize} 字节`)
  console.log(`  折算流量: 每小时 ${(r.avgSize * 2400 / 1024).toFixed(0)} KB/小时/人`)
  process.exit(0)
})().catch(e => { console.error('失败:', e.message); process.exit(1) })
