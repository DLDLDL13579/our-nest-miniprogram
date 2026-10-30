const automator = require('miniprogram-automator')
const path = require('path')
const sleep = ms => new Promise(r => setTimeout(r, ms))

;(async () => {
  const mini = await automator.launch({
    cliPath: '/Applications/wechatwebdevtools.app/Contents/MacOS/cli',
    projectPath: path.join(__dirname, '..'), timeout: 120000
  })
  console.log('✓ 已连上\n')
  const today = new Date(Date.now() + 8 * 3600e3).toISOString().slice(0, 10)

  // 把测量逻辑挂到 global 上，evaluate 只负责调用它 —— 避开多行字符串的坑
  await mini.evaluate(`global.__t = function(){ return Date.now() }`)
  await mini.evaluate(`global.__call = function(n, d){ return new Promise(function(res, rej){ wx.cloud.callFunction({ name: n, data: d, success: function(x){ res(x.result) }, fail: rej }) }) }`)

  const warm = await mini.evaluate(`(async function(){ var s=Date.now(); await global.__call('home',{date:'${today}'}); return Date.now()-s })()`)
  console.log('  冷启动（只影响第一次）:', warm, 'ms')

  const oldMs = await mini.evaluate(`(async function(){
    var s = Date.now();
    await global.__call('pair',{action:'status'});
    await global.__call('moments',{action:'list',size:2});
    await global.__call('moments',{action:'stats'});
    await global.__call('chronicle',{action:'list',size:1});
    return Date.now()-s })()`)
  console.log('  老方式 4 次串行      :', oldMs, 'ms')

  const newMs = await mini.evaluate(`(async function(){ var s=Date.now(); await global.__call('home',{date:'${today}'}); return Date.now()-s })()`)
  console.log('  新方式 1 次聚合      :', newMs, 'ms')

  if (oldMs && newMs) console.log(`  → 省 ${oldMs-newMs}ms，快了 ${Math.round((oldMs-newMs)/oldMs*100)}%`)

  const info = await mini.evaluate(`(async function(){ var h = await global.__call('home',{date:'${today}'}); return { ok:h.ok, keys:Object.keys(h).join(','), days:h.D?h.D.days:null, n:h.moments?h.moments.length:-1, otd:h.onThisDay?'有':'无' } })()`)
  console.log('\n  home 字段:', info.keys)
  console.log('  ok:', info.ok, '| 天数:', info.days, '| 首页记录数:', info.n, '| 那年今日:', info.otd)

  await mini.disconnect()
})().catch(e => { console.error('✗', e.message); process.exit(1) })
