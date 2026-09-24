/** 量首页真实耗时：老的 4 次串行 vs 新的 1 次聚合 */
const automator = require('miniprogram-automator')
const path = require('path')
;(async () => {
  const mini = await automator.launch({
    cliPath: '/Applications/wechatwebdevtools.app/Contents/MacOS/cli',
    projectPath: path.join(__dirname, '..'), timeout: 90000
  })
  console.log('✓ 已连上模拟器\n')

  const r = await mini.evaluate(async () => {
    const t = (fn) => { const s = Date.now(); return fn().then(v => ({ ms: Date.now() - s, v })) }
    const call = (name, data) => wx.cloud.callFunction({ name, data }).then(r => r.result)
    const today = new Date(Date.now() + 8 * 3600e3).toISOString().slice(0, 10)

    const out = {}

    // 老方式：串行 4 次
    let s = Date.now()
    await call('pair', { action: 'status' })
    await call('moments', { action: 'list', size: 2 })
    await call('moments', { action: 'stats' })
    await call('chronicle', { action: 'list', size: 1 })
    out.串行4次 = Date.now() - s

    // 新方式：1 次聚合
    s = Date.now()
    const home = await call('home', { date: today })
    out.聚合1次 = Date.now() - s
    out.homeOk = home.ok
    out.字段 = Object.keys(home).join(',')

    // 再跑一次（热启动对比）
    s = Date.now()
    await call('home', { date: today })
    out.聚合1次_热 = Date.now() - s

    return out
  })
  console.log(JSON.stringify(r, null, 2))
  if (r.串行4次 && r.聚合1次) {
    console.log(`\n  提速：${r.串行4次}ms → ${r.聚合1次}ms（省 ${r.串行4次 - r.聚合1次}ms，${Math.round((1 - r.聚合1次 / r.串行4次) * 100)}%）`)
  }
  await mini.disconnect()
})().catch(e => { console.error('✗', e.message); process.exit(1) })
