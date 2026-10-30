const automator = require('miniprogram-automator')
const path = require('path')
const sleep = ms => new Promise(r => setTimeout(r, ms))
;(async () => {
  const mini = await automator.launch({
    cliPath: '/Applications/wechatwebdevtools.app/Contents/MacOS/cli',
    projectPath: path.join(__dirname, '..'), timeout: 90000
  })
  await mini.reLaunch('/pages/reminds/reminds')
  await sleep(6000)
  const pg = await mini.currentPage()

  /* 单行 evaluate —— 这个形式在这个版本里是稳的 */
  const r = await pg.evaluate("wx.cloud.callFunction({name:'reminds',data:{action:'selftest'}}).then(function(x){return x.result})")
  console.log('  selftest 结果:', JSON.stringify(r))

  await mini.disconnect()
})().catch(e => { console.error('✗', e.message); process.exit(1) })
