const automator = require('miniprogram-automator')
const path = require('path')
;(async () => {
  const mini = await automator.launch({
    cliPath: '/Applications/wechatwebdevtools.app/Contents/MacOS/cli',
    projectPath: path.join(__dirname, '..'), timeout: 120000
  })
  console.log('✓ 已连上\n')
  const today = new Date(Date.now() + 8 * 3600e3).toISOString().slice(0, 10)

  // evaluate 里统一用 async 函数包住，返回值必须是可序列化的普通对象
  const r = await mini.evaluate(`(async () => {
    const call = (n, d) => new Promise((res, rej) => {
      wx.cloud.callFunction({ name: n, data: d,
        success: x => res(x.result), fail: e => rej(e) })
    })
    const out = {}

    // 预热：让 home 完成冷启动（冷启动只影响第一次，不该算进日常耗时）
    const w0 = Date.now()
    await call('home', { date: '${today}' })
    out.冷启动 = Date.now() - w0

    // 老方式：串行 4 次（都是热启动）
    let s = Date.now()
    await call('pair', { action: 'status' })
    await call('moments', { action: 'list', size: 2 })
    await call('moments', { action: 'stats' })
    await call('chronicle', { action: 'list', size: 1 })
    out.串行4次 = Date.now() - s

    // 新方式：1 次聚合（热启动）
    s = Date.now()
    const h = await call('home', { date: '${today}' })
    out.聚合1次 = Date.now() - s

    out.homeOk = h && h.ok
    out.homeKeys = h ? Object.keys(h).join(',') : ''
    out.有天数 = !!(h && h.D && h.D.days)
    out.记录数 = h && h.moments ? h.moments.length : -1
    out.那年今日 = h && h.onThisDay ? '有' : '无'
    return out
  })()`)

  console.log('  冷启动（只影响第一次）:', r.冷启动, 'ms')
  console.log('  老方式 4 次串行      :', r.串行4次, 'ms')
  console.log('  新方式 1 次聚合      :', r.聚合1次, 'ms')
  if (r.串行4次 && r.聚合1次) {
    const saved = r.串行4次 - r.聚合1次
    console.log(`  → 省 ${saved}ms，快了 ${Math.round(saved / r.串行4次 * 100)}%`)
  }
  console.log('\n  home 返回字段:', r.homeKeys)
  console.log('  天数算出来了:', r.有天数, '| 记录数:', r.记录数, '| 那年今日:', r.那年今日)
  await mini.disconnect()
})().catch(e => { console.error('✗', e.message); process.exit(1) })
