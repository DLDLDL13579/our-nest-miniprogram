const automator = require('miniprogram-automator')
const path = require('path')
;(async () => {
  const mini = await automator.launch({
    cliPath: '/Applications/wechatwebdevtools.app/Contents/MacOS/cli',
    projectPath: path.join(__dirname, '..'), timeout: 90000
  })
  const r = await mini.evaluate(async () => {
    const list = (await wx.cloud.callFunction({ name: 'moments', data: { action: 'list', size: 50 } })).result
    return (list.list || []).map(m => ({ id: m.id.slice(-6), text: (m.text || '').slice(0, 30), at: m.at }))
  })
  console.log(JSON.stringify(r, null, 1))
  await mini.disconnect()
})().catch(e => { console.error('✗', e.message); process.exit(1) })
