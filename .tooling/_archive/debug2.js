const automator = require('miniprogram-automator')
const path = require('path')
const sleep = ms => new Promise(r => setTimeout(r, ms))
;(async () => {
  const mini = await automator.launch({
    cliPath: '/Applications/wechatwebdevtools.app/Contents/MacOS/cli',
    projectPath: path.join(__dirname, '..'), timeout: 90000
  })
  console.log('✓ 已连上')
  await mini.reLaunch('/pages/index/index')
  await sleep(6000)

  // 全部写成单行，evaluate 对单行最稳
  await mini.evaluate("global.__cf=function(n,d){return new Promise(function(res){wx.cloud.callFunction({name:n,data:d,success:function(x){res(x.result)},fail:function(e){res({FAIL:String(e.errMsg||e)})}})})}")

  const a = await mini.evaluate("global.__cf('reminds',{action:'list'})")
  console.log('list:', JSON.stringify(a))

  const b = await mini.evaluate("global.__cf('reminds',{action:'add',title:'测试提醒',date:'2027-01-01',repeat:'once',leadDays:14})")
  console.log('add :', JSON.stringify(b))

  const c = await mini.evaluate("global.__cf('reminds',{action:'list'})")
  console.log('list:', JSON.stringify(c))

  const d = await mini.evaluate("global.__cf('initdb',{})")
  console.log('initdb:', JSON.stringify(d).slice(0, 400))

  await mini.disconnect()
})().catch(e => { console.error('✗', e.message); process.exit(1) })
