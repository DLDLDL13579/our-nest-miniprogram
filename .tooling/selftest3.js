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

  // 回调式：结果塞进页面 data，再读出来 —— 不依赖 Promise 返回
  await mini.evaluate("wx.cloud.callFunction({name:'reminds',data:{action:'selftest'},success:function(x){getCurrentPages()[getCurrentPages().length-1].setData({__probe:JSON.stringify(x.result)})},fail:function(e){getCurrentPages()[getCurrentPages().length-1].setData({__probe:'FAIL '+String(e.errMsg||e)})}})")
  await sleep(4000)
  const d = await pg.data()
  console.log('  selftest 结果:', d.__probe || '（没写回来）')

  // 顺便再看一次列表
  await pg.callMethod('load')
  await sleep(4000)
  const d2 = await pg.data()
  console.log('  列表条数:', (d2.list || []).length)

  await mini.disconnect()
})().catch(e => { console.error('✗', e.message); process.exit(1) })
