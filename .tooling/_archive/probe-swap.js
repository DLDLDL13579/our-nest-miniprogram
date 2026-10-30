/* 真实云端：连续三次换手牌，看服务端到底怎么回 */
const automator = require('miniprogram-automator')
const ROOT = '/Users/meihaoshidai/Downloads/邓林work/个人项目/小程序'
const CLI = '/Applications/wechatwebdevtools.app/Contents/MacOS/cli'
const sleep = ms => new Promise(r => setTimeout(r, ms))
;(async () => {
  const mini = await automator.launch({ cliPath: CLI, projectPath: ROOT, timeout: 120000 })
  try {
    await sleep(9000)
    await mini.navigateTo('/pages/me/me').catch(() => {})
    await sleep(1500)
    const out = await mini.evaluate(function () {
      const api = (data) => wx.cloud.callFunction({ name: 'room', data }).then(r => r.result)
      return (async () => {
        const log = []
        const cr = await api({ action: 'create', name: '探针', game: 'poker' })
        if (!cr.ok) return { err: 'create fail: ' + JSON.stringify(cr) }
        const id = cr.room.id
        await api({ action: 'start', id, solo: true })
        for (let i = 0; i < 6; i++) {
          await new Promise(r => setTimeout(r, 1200))
          const st = await api({ action: 'status', id })
          log.push('t+' + ((i + 1) * 1.2).toFixed(1) + 's phase=' + (st.room && st.room.phase))
          if (st.room && st.room.phase === 'playing') break
        }
        for (let i = 1; i <= 3; i++) {
          const r = await api({ action: 'pkAct', act: 'swapMine', id })
          const p = r.room && r.room.poker
          log.push('swapMine#' + i + ' ok=' + !!r.ok + ' msg=' + (r.msg || '') +
                   ' turn=' + (r.room && r.room.turn) + ' step=' + (p && p.step) +
                   ' drink=' + (p && p.myDrink) + ' known=' + (p && p.myKnownText))
          await new Promise(r2 => setTimeout(r2, 500))
        }
        return { log }
      })()
    })
    console.log(out.log ? out.log.join('\n') : JSON.stringify(out))
  } finally { await mini.close().catch(() => {}) }
})().catch(e => { console.error('失败:', e.message); process.exit(1) })
