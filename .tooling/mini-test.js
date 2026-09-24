const automator = require('miniprogram-automator')
const path = require('path')
;(async () => {
  console.log('launch…')
  const mini = await automator.launch({
    cliPath: '/Applications/wechatwebdevtools.app/Contents/MacOS/cli',
    projectPath: path.join(__dirname, '..'),
    timeout: 90000
  })
  console.log('✓ 连上了')
  const page = await mini.currentPage()
  console.log('  当前页面:', page.path)
  const data = await page.data()
  console.log('  数据键:', Object.keys(data || {}).join(', '))
  await mini.disconnect()
  console.log('✓ 断开')
})().catch(e => { console.error('✗', e.message); process.exit(1) })
