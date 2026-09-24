const automator = require('miniprogram-automator')
const path = require('path')
const sleep = ms => new Promise(r => setTimeout(r, ms))

;(async () => {
  const mini = await automator.launch({
    cliPath: '/Applications/wechatwebdevtools.app/Contents/MacOS/cli',
    projectPath: path.join(__dirname, '..'), timeout: 120000
  })
  console.log('✓ 已连上')
  console.log('（模拟器里的 console 输出会打到下面）\n')

  for (let i = 1; i <= 3; i++) {
    await mini.reLaunch('/pages/index/index')
    await sleep(3500)
    const d = await (await mini.currentPage()).data()
    console.log(`  第 ${i} 轮完成 | 天数 ${d.D ? d.D.days : '—'} | 记录 ${(d.moments||[]).length} 条`)
  }
  await mini.disconnect()
  console.log('\n✓ 完成 —— 上面若有 [home] 一次往返用时 NNN ms，那就是真实网络耗时')
})().catch(e => { console.error('✗', e.message); process.exit(1) })
