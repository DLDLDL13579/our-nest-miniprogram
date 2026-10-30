/** 在小程序运行时里直接调云函数，把原始错误抠出来 */
const automator = require('miniprogram-automator')
const path = require('path')
;(async () => {
  const mini = await automator.launch({
    cliPath: '/Applications/wechatwebdevtools.app/Contents/MacOS/cli',
    projectPath: path.join(__dirname, '..'),
    timeout: 90000
  })
  console.log('✓ 已连上\n')

  // 在小程序里直接 eval，拿到云函数的原始返回
  const r = await mini.evaluate(async () => {
    const out = {}
    // ① env 是否正确
    try {
      const c = await wx.cloud.callFunction({ name: 'pair', data: { action: 'status' } })
      out.pair = c.result
    } catch (e) { out.pairErr = (e && (e.errMsg || e.message)) || String(e) }

    // ② daily 的真实错误
    try {
      const c = await wx.cloud.callFunction({ name: 'daily', data: {} })
      out.daily = c.result
    } catch (e) { out.dailyErr = (e && (e.errMsg || e.message)) || String(e) }

    return out
  })
  console.log(JSON.stringify(r, null, 2))
  await mini.disconnect()
})().catch(e => { console.error('✗', e.message); process.exit(1) })
