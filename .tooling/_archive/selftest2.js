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

  // mini.evaluate 单行、返回 Promise
  const r = await mini.evaluate("wx.cloud.callFunction({name:'reminds',data:{action:'selftest'}}).then(function(x){return x.result})")
  console.log('  selftest:', JSON.stringify(r))

  await mini.disconnect()
})().catch(e => { console.error('✗', e.message); process.exit(1) })
