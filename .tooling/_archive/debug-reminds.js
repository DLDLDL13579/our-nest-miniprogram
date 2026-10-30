const automator = require('miniprogram-automator')
const path = require('path')
const sleep = ms => new Promise(r => setTimeout(r, ms))
;(async () => {
  const mini = await automator.launch({
    cliPath: '/Applications/wechatwebdevtools.app/Contents/MacOS/cli',
    projectPath: path.join(__dirname, '..'), timeout: 90000
  })
  console.log('✓ 已连上\n')

  // ① 本地缓存里的 dbReady 是几？
  await mini.reLaunch('/pages/index/index')
  await sleep(6000)

  // ② 直接看 reminds 云函数返回什么
  await mini.evaluate('global.__cf = function(n,d){ return new Promise(function(res,rej){ wx.cloud.callFunction({name:n,data:d,success:function(x){res(x.result)},fail:function(e){res({FAIL:String(e.errMsg||e)})}}) }) }')
  const listRes = await mini.evaluate("(async function(){ return await global.__cf('reminds',{action:'list'}) })()")
  console.log('  reminds list 返回:', JSON.stringify(listRes).slice(0, 200))

  // ③ 试着加一条，看原始返回
  const addRes = await mini.evaluate("(async function(){ var d=new Date(Date.now()+8*3600e3+10*86400000).toISOString().slice(0,10); return await global.__cf('reminds',{action:'add',title:'测试提醒',date:d,repeat:'once',leadDays:14,who:'她家'}) })()")
  console.log('  reminds add 返回:', JSON.stringify(addRes).slice(0, 200))

  // ④ 再列一次
  const listRes2 = await mini.evaluate("(async function(){ return await global.__cf('reminds',{action:'list'}) })()")
  console.log('  再列一次:', JSON.stringify(listRes2).slice(0, 300))

  // ⑤ initdb 跑一次，确认表建了
  const initRes = await mini.evaluate("(async function(){ return await global.__cf('initdb',{}) })()")
  console.log('\n  initdb 结果:', JSON.stringify(initRes).slice(0, 300))

  await mini.disconnect()
})().catch(e => { console.error('✗', e.message); process.exit(1) })
