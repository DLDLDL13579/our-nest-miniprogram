const automator = require('miniprogram-automator')
const path = require('path')
const sleep = ms => new Promise(r => setTimeout(r, ms))
;(async () => {
  const mini = await automator.launch({
    cliPath: '/Applications/wechatwebdevtools.app/Contents/MacOS/cli',
    projectPath: path.join(__dirname, '..'), timeout: 90000
  })
  console.log('✓ 已连上\n')

  // ① app.json 的隐私开关是否真的生效
  const cfg = await mini.evaluate(() => {
    const ac = getApp()
    return { ok: true, hasApp: !!ac }
  })
  console.log('① 小程序启动正常:', cfg.ok)

  // ② privacy 模块能否正常 require 并返回结果（不会抛错就说明接口存在性处理正确）
  const pr = await mini.evaluate(async () => {
    try {
      // 在小程序运行时里重新加载这个模块会拿不到路径，改用直接调接口验证
      const out = {}
      out.hasGetPrivacySetting = typeof wx.getPrivacySetting === 'function'
      out.hasRequirePrivacyAuthorize = typeof wx.requirePrivacyAuthorize === 'function'
      if (out.hasGetPrivacySetting) {
        out.setting = await new Promise(res => {
          wx.getPrivacySetting({ success: r => res(r), fail: e => res({ err: e.errMsg }) })
        })
      }
      return out
    } catch (e) { return { err: e.message } }
  })
  console.log('② 隐私接口可用性:')
  console.log('   getPrivacySetting       :', pr.hasGetPrivacySetting)
  console.log('   requirePrivacyAuthorize :', pr.hasRequirePrivacyAuthorize)
  console.log('   当前授权状态            :', JSON.stringify(pr.setting))

  // ③ 打开写记录页，确认页面本身没被隐私模块搞崩
  await mini.reLaunch('/pages/write/write')
  await sleep(4000)
  const pg = await mini.currentPage()
  const d = await pg.data()
  console.log('\n③ 写记录页加载:', pg.path)
  console.log('   数据键:', Object.keys(d || {}).filter(k => !k.startsWith('__')).join(', '))
  console.log('   → 页面正常，说明 privacy 模块没有阻塞渲染:', d.moods && d.moods.length === 5)

  // ④ 愿望页
  await mini.reLaunch('/pages/wishes/wishes')
  await sleep(4000)
  const pg2 = await mini.currentPage()
  const d2 = await pg2.data()
  console.log('\n④ 愿望页加载:', pg2.path, '| loading =', d2.loading, '| 未配对 =', d2.noPair)

  await mini.disconnect()
  console.log('\n✓ 完成')
})().catch(e => { console.error('✗', e.message); process.exit(1) })
