const automator = require('miniprogram-automator')
const path = require('path')
;(async () => {
  const mini = await automator.launch({
    cliPath: '/Applications/wechatwebdevtools.app/Contents/MacOS/cli',
    projectPath: path.join(__dirname, '..'), timeout: 90000
  })
  console.log('✓ 已连上\n')
  const today = new Date(Date.now() + 8 * 3600e3).toISOString().slice(0, 10)

  // 分次测，避免单次 evaluate 太久超时
  const one = async (label, code) => {
    const t0 = Date.now()
    const r = await mini.evaluate(code)
    console.log(`  ${label}: ${Date.now() - t0}ms  ${r && r.ok === false ? '(ok:false ' + r.code + ')' : ''}`)
    return r
  }

  await one('预热 home（冷启动）', `wx.cloud.callFunction({name:'home',data:{date:'${today}'}}).then(r=>r.result)`)
  await one('home 第 2 次（热）', `wx.cloud.callFunction({name:'home',data:{date:'${today}'}}).then(r=>r.result)`)
  await one('home 第 3 次（热）', `wx.cloud.callFunction({name:'home',data:{date:'${today}'}}).then(r=>r.result)`)

  const r = await mini.evaluate(`(async()=>{
    const call=(n,d)=>wx.cloud.callFunction({name:n,data:d}).then(r=>r.result);
    let s=Date.now();
    await call('pair',{action:'status'});
    await call('moments',{action:'list',size:2});
    await call('moments',{action:'stats'});
    await call('chronicle',{action:'list',size:1});
    const oldMs=Date.now()-s;
    s=Date.now();
    const h=await call('home',{date:'${today}'});
    return { oldMs, newMs:Date.now()-s, homeOk:h.ok, keys:Object.keys(h).join(',') };
  })()`)
  console.log('\n  老方式 4 次串行:', r.oldMs, 'ms')
  console.log('  新方式 1 次聚合:', r.newMs, 'ms')
  if (r.oldMs && r.newMs) {
    console.log('  → 省了', r.oldMs - r.newMs, 'ms，快了', Math.round((1 - r.newMs / r.oldMs) * 100) + '%')
  }
  console.log('\n  home 返回字段:', r.keys)
  await mini.disconnect()
})().catch(e => { console.error('✗', e.message); process.exit(1) })
