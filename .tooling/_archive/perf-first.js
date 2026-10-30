/** 实测首屏渲染耗时 + 首屏云函数往返 */
const automator = require('miniprogram-automator')
const path = require('path')

;(async () => {
  const t0 = Date.now()
  const mini = await automator.launch({
    cliPath: '/Applications/wechatwebdevtools.app/Contents/MacOS/cli',
    projectPath: path.join(__dirname, '..'),
    timeout: 90000
  })
  await mini.switchTab('/pages/index/index')
  const r = await mini.evaluate(async () => {
    /* 等首屏数据到齐（D 非空） */
    const t = Date.now()
    return await new Promise((resolve) => {
      const timer = setInterval(() => {
        const pages = getCurrentPages()
        const p = pages[pages.length - 1]
        if (p && p.data && p.data.D) { clearInterval(timer); resolve({ ms: Date.now() - t }) }
        if (Date.now() - t > 12000) { clearInterval(timer); resolve({ ms: -1 }) }
      }, 30)
    })
  })
  const total = Date.now() - t0
  console.log('=== 首屏实测 ===')
  console.log(`  launch → 页面数据就绪: ${r.ms}ms`)
  console.log(`  含启动总计: ${total}ms`)
  await mini.close()
  process.exit(0)
})().catch(e => { console.error('失败:', e.message); process.exit(1) })
