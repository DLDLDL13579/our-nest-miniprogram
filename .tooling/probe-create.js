/* 直调云端 create（带 debug），看建房耗时的真实分布 */
const automator = require('miniprogram-automator')
const ROOT = '/Users/meihaoshidai/Downloads/邓林work/个人项目/小程序'
const CLI = '/Applications/wechatwebdevtools.app/Contents/MacOS/cli'
const sleep = ms => new Promise(r => setTimeout(r, ms))
;(async () => {
  const mini = await automator.launch({ cliPath: CLI, projectPath: ROOT, timeout: 120000 })
  try {
    await sleep(9000)
    await mini.navigateTo('/pages/me/me').catch(() => {})
    await sleep(2000)
    for (let i = 0; i < 3; i++) {
      const r = await mini.evaluate(function (i) {
        return new Promise(function (resolve) {
          const t0 = Date.now()
          wx.cloud.callFunction({
            name: 'room',
            data: { action: 'create', name: '探针' + i, game: 'liar', debug: true }
          }).then(function (res) {
            const x = res.result || {}
            resolve({ total: Date.now() - t0, _t: x._t || null, ok: x.ok, msg: x.msg || '' })
          }).catch(function (e) { resolve({ err: String((e && e.errMsg) || e) }) })
        })
      }, i)
      console.log('第 ' + (i + 1) + ' 次: 总 ' + r.total + 'ms' +
        (r._t ? ' | pick ' + r._t.pick + ' + add ' + r._t.add + ' + shape ' + r._t.shape : '') +
        (r.ok === false ? ' | ' + r.msg : ''))
      await sleep(300)
    }
  } finally { await mini.close().catch(() => {}) }
})().catch(e => { console.error('失败:', e.message); process.exit(1) })
