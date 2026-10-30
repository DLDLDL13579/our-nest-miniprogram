const automator = require('miniprogram-automator')
const path = require('path')
const sleep = ms => new Promise(r => setTimeout(r, ms))

;(async () => {
  const mini = await automator.launch({
    cliPath: '/Applications/wechatwebdevtools.app/Contents/MacOS/cli',
    projectPath: path.join(__dirname, '..'), timeout: 120000
  })
  console.log('✓ 已连上\n')

  /**
   * 关键：reLaunch 之后立刻读 data，此时 loading 一定是 true。
   * 然后轮询直到 loading 变 false —— 这段时间就是用户盯着 loading 的时长。
   * 用高频轮询（30ms）把测量误差压到最小。
   */
  async function measure(route, label) {
    await mini.reLaunch(route)
    const page = await mini.currentPage()
    const t0 = Date.now()
    let sawLoading = false
    for (let i = 0; i < 400; i++) {
      const d = await page.data()
      if (d.loading === true) sawLoading = true
      if (d.loading === false) return { ms: Date.now() - t0, sawLoading, d }
      await sleep(30)
    }
    return { ms: -1, sawLoading, d: await page.data() }
  }

  for (const [route, label] of [
    ['/pages/index/index', '今日'],
    ['/pages/chronicle/chronicle', '编年史'],
    ['/pages/wishes/wishes', '想去去过']
  ]) {
    const rs = []
    for (let i = 0; i < 3; i++) {
      const r = await measure(route, label)
      rs.push(r)
      await sleep(1500)
    }
    const ms = rs.map(x => x.ms)
    console.log(`  ${label}: ${ms.join(' / ')} ms   （捕获到 loading 态: ${rs[0].sawLoading}）`)
  }

  await mini.disconnect()
})().catch(e => { console.error('✗', e.message); process.exit(1) })
