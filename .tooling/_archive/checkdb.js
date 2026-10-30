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

  // 直接在小程序侧调云函数并等待 —— 用页面方法，结果写回 data
  await pg.setData({ _probe: 'running' })
  const out = await mini.evaluate(`(function(){
    return new Promise(function(resolve){
      wx.cloud.callFunction({ name:'reminds', data:{ action:'list' },
        success: function(x){ resolve({ ok:true, result:x.result }) },
        fail: function(e){ resolve({ ok:false, err:String(e.errMsg||e) }) } })
    })
  })()`)
  console.log('  直接调云函数:', JSON.stringify(out).slice(0, 400))

  await mini.disconnect()
})().catch(e => { console.error('✗', e.message); process.exit(1) })
