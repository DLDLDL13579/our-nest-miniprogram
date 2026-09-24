const automator = require('miniprogram-automator')
const path = require('path')
;(async () => {
  const mini = await automator.launch({
    cliPath: '/Applications/wechatwebdevtools.app/Contents/MacOS/cli',
    projectPath: path.join(__dirname, '..'), timeout: 90000
  })
  const r = await mini.evaluate(async () => {
    const out = []
    // 逐个 action 试，看哪个炸
    for (const act of ['list', 'stats']) {
      try {
        const c = await wx.cloud.callFunction({ name: 'moments', data: { action: act } })
        out.push({ action: act, result: c.result })
      } catch (e) { out.push({ action: act, err: e.errMsg || e.message }) }
    }
    // 直接查集合是否存在
    try {
      const db = wx.cloud.database()
      const c = await db.collection('moments').count()
      out.push({ collection: 'ok', total: c.total })
    } catch (e) { out.push({ collection: 'err', msg: e.errMsg || e.message }) }
    return out
  })
  console.log(JSON.stringify(r, null, 2))
  await mini.disconnect()
})().catch(e => { console.error('✗', e.message); process.exit(1) })
