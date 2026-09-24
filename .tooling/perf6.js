const automator = require('miniprogram-automator')
const path = require('path')
const sleep = ms => new Promise(r => setTimeout(r, ms))

async function waitReady(page, budgetMs, stepMs) {
  const t0 = Date.now()
  while (Date.now() - t0 < budgetMs) {
    const d = await page.data()
    if (!d.loading) return { ms: Date.now() - t0, d }
    await sleep(stepMs)
  }
  return { ms: -1, d: await page.data() }
}

;(async () => {
  const mini = await automator.launch({
    cliPath: '/Applications/wechatwebdevtools.app/Contents/MacOS/cli',
    projectPath: path.join(__dirname, '..'), timeout: 120000
  })
  console.log('✓ 已连上\n')

  // ① 冷开：清掉缓存再进
  await mini.reLaunch('/pages/index/index')
  let page = await mini.currentPage()
  await sleep(500)
  await page.callMethod('onPullDownRefresh').catch(() => {})
  await sleep(300)

  // ② 热开连续三次，看稳定耗时
  console.log('  连续三次重新进入首页（每次都是真实加载）:')
  const times = []
  for (let i = 0; i < 3; i++) {
    const t0 = Date.now()
    await mini.reLaunch('/pages/index/index')
    page = await mini.currentPage()
    const r = await waitReady(page, 15000, 150)
    times.push(r.ms)
    console.log(`    第 ${i+1} 次: ${r.ms}ms  | 天数 ${r.d.D ? r.d.D.days : '—'} | 记录 ${(r.d.moments||[]).length} 条 | 缓存态 ${r.d.fromCache}`)
    await sleep(1200)
  }
  const avg = Math.round(times.reduce((a, b) => a + b, 0) / times.length)
  console.log(`\n  平均 ${avg}ms（首页从进入到有内容）`)

  // ③ 编年史
  await mini.reLaunch('/pages/chronicle/chronicle')
  page = await mini.currentPage()
  const c = await waitReady(page, 15000, 150)
  console.log(`  编年史: ${c.ms}ms | 分组 ${(c.d.list||[]).length} | 里程碑 ${(c.d.ms||[]).length}`)

  await mini.screenshot({ path: path.join(__dirname, '..', 'outputs', 'perf-首页.png') })
  console.log('\n  ✓ 已截图 outputs/perf-首页.png')
  await mini.disconnect()
})().catch(e => { console.error('✗', e.message); process.exit(1) })
