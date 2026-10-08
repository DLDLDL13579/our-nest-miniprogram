/** 冷启动实测：清掉缓存，测真实的「开小程序 → 首页出数据」耗时 */
const automator = require('miniprogram-automator')
const path = require('path')

;(async () => {
  const mini = await automator.launch({
    cliPath: '/Applications/wechatwebdevtools.app/Contents/MacOS/cli',
    projectPath: path.join(__dirname, '..'),
    timeout: 90000
  })
  /* 清掉 homeCache 和 dbReady，模拟"第一次打开/清了缓存" */
  await mini.evaluate(() => {
    try { wx.removeStorageSync('homeCache'); wx.removeStorageSync('dbReady') } catch (e) {}
  })
  await mini.switchTab('/pages/index/index')

  const r = await mini.evaluate(async () => {
    const t = Date.now()
    return await new Promise((resolve) => {
      const timer = setInterval(() => {
        const pages = getCurrentPages()
        const p = pages[pages.length - 1]
        if (p && p.data && p.data.D) { clearInterval(timer); resolve({ ms: Date.now() - t, cached: p.data.fromCache }) }
        if (Date.now() - t > 15000) { clearInterval(timer); resolve({ ms: -1 }) }
      }, 20)
    })
  })
  console.log('=== 冷启动实测（清了缓存）===')
  console.log(`  首页数据就绪: ${r.ms}ms   走了缓存: ${r.cached ? '是（缓存没清干净）' : '否（真实云端往返）'}`)
  await mini.close()
  process.exit(0)
})().catch(e => { console.error('失败:', e.message); process.exit(1) })
