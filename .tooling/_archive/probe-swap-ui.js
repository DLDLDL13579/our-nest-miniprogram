/* 真实前端：连续点两次"换手牌"，看界面到底卡在哪 */
const automator = require('miniprogram-automator')
const ROOT = '/Users/meihaoshidai/Downloads/邓林work/个人项目/小程序'
const CLI = '/Applications/wechatwebdevtools.app/Contents/MacOS/cli'
const sleep = ms => new Promise(r => setTimeout(r, ms))
;(async () => {
  const mini = await automator.launch({ cliPath: CLI, projectPath: ROOT, timeout: 120000 })
  try {
    await sleep(9000)
    const page = await mini.currentPage()
    await mini.navigateTo('/pages/me/me').then(() => mini.navigateBack()).catch(() => {})
    /* 直接调云函数建房 + start，再进房间页 */
    await mini.navigateTo('/pages/me/me').catch(() => {})
    await sleep(1200)
    const code = await mini.evaluate(function () {
      const api = (d) => wx.cloud.callFunction({ name: 'room', data: d }).then(r => r.result)
      return (async () => {
        const cr = await api({ action: 'create', name: '前端探针', game: 'poker' })
        if (!cr.ok) return ''
        await api({ action: 'start', id: cr.room.id, solo: true })
        return cr.room.code
      })()
    })
    console.log('房间号:', code)
    await mini.navigateTo('/game/room/room?code=' + code)
    for (let i = 0; i < 8; i++) {
      await sleep(1200)
      const p = await mini.currentPage()
      const d = await p.data()
      if (d.stage === 'playing') break
    }
    let p = await mini.currentPage()
    let d = await p.data()
    console.log('阶段:', d.stage, 'myTurn:', d.room && d.room.myTurn, 'folded:', d.room && d.room.poker && d.room.poker.folded)

    for (let round = 1; round <= 2; round++) {
      const btns = await p.$$('.pk-swap')
      console.log(`\n第 ${round} 次点「换手牌」: 找到 ${btns.length} 个换牌按钮`)
      if (btns.length < 2) { console.log('  ✗ 按钮不全'); break }
      await btns[1].tap()
      await sleep(700)
      p = await mini.currentPage(); d = await p.data()
      console.log('  点后 pkAsk =', JSON.stringify(d.pkAsk))
      const yes = await p.$('.pkask-btn.yes')
      if (!yes) { console.log('  ✗ 没弹出确认卡'); break }
      await yes.tap()
      await sleep(3000)
      p = await mini.currentPage(); d = await p.data()
      console.log('  确认后 drink =', d.room && d.room.poker && d.room.poker.myDrink,
                  ' pkAsk =', JSON.stringify(d.pkAsk),
                  ' _pkBusy =', d._pkBusy,
                  ' myTurn =', d.room && d.room.myTurn)
      /* 同时直接问云端，排除前端显示问题 */
      const srv = await mini.evaluate(function () {
        const pages = getCurrentPages(); const pg = pages[pages.length - 1]
        return wx.cloud.callFunction({ name: 'room', data: { action: 'status', id: pg.data.room.id } })
          .then(r => { const p = r.result.room && r.result.room.poker; return { drink: p && p.drinkText, known: p && p.myKnownText } })
      })
      console.log('  云端真实值 drink =', srv.drink, ' known =', srv.known)
    }
  } finally { await mini.close().catch(() => {}) }
})().catch(e => { console.error('失败:', e.message); process.exit(1) })
