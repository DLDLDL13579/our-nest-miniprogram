/** 不测云函数，测"页面从进入到能看到内容"的真实耗时 —— 这才是用户感受 */
const automator = require('miniprogram-automator')
const path = require('path')
const sleep = ms => new Promise(r => setTimeout(r, ms))

;(async () => {
  const mini = await automator.launch({
    cliPath: '/Applications/wechatwebdevtools.app/Contents/MacOS/cli',
    projectPath: path.join(__dirname, '..'), timeout: 120000
  })
  console.log('✓ 已连上\n')

  // 清缓存 → 测冷开（第一次，含冷启动）
  await mini.evaluate('wx.clearStorageSync()')
  let t0 = Date.now()
  await mini.reLaunch('/pages/index/index')
  let page = await mini.currentPage()
  let ok = false
  for (let i = 0; i < 40; i++) {
    const d = await page.data()
    if (!d.loading && (d.moments || d.noPair)) { ok = true; break }
    await sleep(150)
  }
  const cold = Date.now() - t0
  let d = await page.data()
  console.log('  冷开（清缓存 + 云函数冷启动）:', cold, 'ms  →', ok ? '出内容' : '超时')
  console.log('    天数:', d.D ? d.D.days : '—', '| 记录数:', (d.moments||[]).length, '| 走缓存:', d.fromCache)

  await sleep(2000)

  // 热开：再进一次（有缓存，能秒开）
  t0 = Date.now()
  await mini.reLaunch('/pages/index/index')
  page = await mini.currentPage()
  let firstPaint = null
  for (let i = 0; i < 40; i++) {
    const dd = await page.data()
    if (!dd.loading && (dd.moments || dd.noPair)) { firstPaint = Date.now() - t0; break }
    await sleep(80)
  }
  console.log('\n  热开（有缓存，首屏可见）:', firstPaint, 'ms')

  // 等云端数据回来
  await sleep(3000)
  d = await page.data()
  console.log('  热开（云端数据到达后）:', d.fromCache ? '仍是缓存' : '已刷新为最新', '| 记录数:', (d.moments||[]).length)

  await mini.disconnect()
})().catch(e => { console.error('✗', e.message); process.exit(1) })
