const automator = require('miniprogram-automator')
const path = require('path'), fs = require('fs')
const sleep = ms => new Promise(r => setTimeout(r, ms))
;(async () => {
  const mini = await automator.launch({
    cliPath: '/Applications/wechatwebdevtools.app/Contents/MacOS/cli',
    projectPath: path.join(__dirname, '..'), timeout: 90000
  })
  await mini.reLaunch('/pages/reminds/reminds')
  await sleep(6000)
  const pg = await mini.currentPage()
  await pg.callMethod('selftest')          // 调页面自己的方法（这个 API 是稳的）
  await sleep(5000)
  const d = await pg.data()
  console.log('  自检结果:', d.probe || '（空）')
  await mini.screenshot({ path: path.join(__dirname, '..', 'outputs', 'reminds-自检.png') })
  await mini.disconnect()
})().catch(e => { console.error('✗', e.message); process.exit(1) })
