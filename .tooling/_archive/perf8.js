const automator = require('miniprogram-automator')
const path = require('path')
const sleep = ms => new Promise(r => setTimeout(r, ms))

;(async () => {
  const mini = await automator.launch({
    cliPath: '/Applications/wechatwebdevtools.app/Contents/MacOS/cli',
    projectPath: path.join(__dirname, '..'), timeout: 120000
  })
  console.log('✓ 已连上\n')

  const page = await mini.currentPage()

  // 通过页面方法清缓存（不直接调 wx.clearStorageSync，绕开 evaluate 限制）
  await page.callMethod('__clearCacheForTest').catch(() => {})

  // ① 冷开：清掉缓存后，明确定义 loading=true 再加载
  await mini.reLaunch('/pages/index/index')
  const p1 = await mini.currentPage()
  await sleep(300)
  let d = await p1.data()
  console.log('  冷开初始态: loading =', d.loading, '| fromCache =', d.fromCache, '| 记录数 =', (d.moments||[]).length)

  const t0 = Date.now()
  let settled = -1
  for (let i = 0; i < 300; i++) {
    d = await p1.data()
    if (d.loading === false && !d.fromCache) { settled = Date.now() - t0; break }
    await sleep(30)
  }
  console.log('  冷开「真正拿到云端数据」用时:', settled, 'ms')
  console.log('    天数:', d.D ? d.D.days : '—', '| 记录:', (d.moments||[]).length, '条 | 那年今日:', d.onThisDay ? '有' : '无')

  await sleep(1500)

  // ② 热开：有缓存，应该瞬间可见
  const t1 = Date.now()
  await mini.reLaunch('/pages/index/index')
  const p2 = await mini.currentPage()
  await sleep(250)
  const d2 = await p2.data()
  console.log('\n  热开 250ms 后的状态:')
  console.log('    loading =', d2.loading, '| fromCache =', d2.fromCache, '| 记录数 =', (d2.moments||[]).length)
  console.log('    → 有内容可看:', (d2.moments||[]).length > 0 || d2.noPair ? '是' : '否')

  await mini.disconnect()
})().catch(e => { console.error('✗', e.message); process.exit(1) })
