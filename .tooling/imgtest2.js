const automator = require('miniprogram-automator')
const path = require('path')
;(async () => {
  const mini = await automator.launch({
    cliPath: '/Applications/wechatwebdevtools.app/Contents/MacOS/cli',
    projectPath: path.join(__dirname, '..'), timeout: 90000
  })
  console.log('✓ 已连上')

  // 一次定义，分次调用 —— 避免多行字符串被 evaluate 处理坏
  await mini.evaluate('global.__cf = function(n,d){ return new Promise(function(res,rej){ wx.cloud.callFunction({name:n,data:d,success:function(x){res(x.result)},fail:rej}) }) }')
  await mini.evaluate('global.__temp = function(f){ return new Promise(function(res){ wx.cloud.getTempFileURL({fileList:[f],success:function(x){res(x.fileList)},fail:function(e){res([{err:String(e)}])}}) }) }')

  const n = await mini.evaluate("(async function(){ var l = await global.__cf('moments',{action:'list',size:10}); return (l.list||[]).filter(function(m){return m.photos&&m.photos.length}).length })()")
  console.log('  库里有照片的记录数:', n)

  if (!n) {
    console.log('  → 还没有带照片的记录，先造一条')
    await mini.disconnect()
    process.exit(0)
  }

  const info = await mini.evaluate("(async function(){ var l = await global.__cf('moments',{action:'list',size:10}); var m=(l.list||[]).filter(function(x){return x.photos&&x.photos.length})[0]; var f=m.photos[0]; var u=await global.__temp(f); return { fileID:f.slice(0,40), hasUrl: !!(u[0]&&u[0].tempFileURL), url: (u[0]&&u[0].tempFileURL||'').slice(0,70) } })()")
  console.log(JSON.stringify(info, null, 2))
  await mini.disconnect()
})().catch(e => { console.error('✗', e.message); process.exit(1) })
