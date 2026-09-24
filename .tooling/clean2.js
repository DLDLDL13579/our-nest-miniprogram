const automator = require('miniprogram-automator')
const path = require('path')
;(async () => {
  const mini = await automator.launch({
    cliPath: '/Applications/wechatwebdevtools.app/Contents/MacOS/cli',
    projectPath: path.join(__dirname, '..'), timeout: 90000
  })
  const r = await mini.evaluate(async () => {
    const list = (await wx.cloud.callFunction({ name: 'moments', data: { action: 'list', size: 50 } })).result
    let n = 0
    for (const m of (list.list || [])) {
      if (/^验证：|^测试：/.test(m.text || '')) {
        await wx.cloud.callFunction({ name: 'moments', data: { action: 'remove', id: m.id } })
        n++
      }
    }
    const after = (await wx.cloud.callFunction({ name: 'moments', data: { action: 'list', size: 50 } })).result
    return { removed: n, left: (after.list || []).length }
  })
  console.log('  清理测试数据', r.removed, '条，剩余', r.left, '条')
  await mini.disconnect()
})().catch(e => { console.error('✗', e.message); process.exit(1) })
