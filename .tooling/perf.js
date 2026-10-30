/* 首屏与进房耗时实测（automator 模拟器，非真机，但能看相对值） */
const automator = require('miniprogram-automator')
const ROOT = '/Users/meihaoshidai/Downloads/邓林work/个人项目/小程序'
const CLI = '/Applications/wechatwebdevtools.app/Contents/MacOS/cli'
const sleep = ms => new Promise(r => setTimeout(r, ms))
;(async () => {
  const mini = await automator.launch({ cliPath: CLI, projectPath: ROOT, timeout: 120000 })
  try {
    await sleep(10000)
    const boot = await mini.evaluate(function () {
      try { return wx.getStorageSync('lastBootMs') || 0 } catch (e) { return -1 }
    })
    console.log('首屏（app.onLaunch → 大厅 onReady）: ' + (boot > 0 ? (boot / 1000).toFixed(2) + ' 秒' : '未记录(' + boot + ')'))

    /* 进房间耗时：点卡片 → 拿到房间号。测两次：
       第一次含云函数冷启动，第二次是热的 —— 分开看才知道慢在哪。 */
    async function oneRound(tag) {
      const page = await mini.currentPage()
      const d = await page.data()
      const cards = await page.$$('.gcard')
      const idx = ((d && d.list) || []).findIndex(g => g.id === 'liar')
      if (idx < 0 || !cards[idx]) { console.log('  ' + tag + ': 找不到卡片'); return 0 }
      const t0 = Date.now()
      await cards[idx].tap()
      for (let i = 0; i < 60; i++) {
        await sleep(120)
        const p = await mini.currentPage()
        const dd = await p.data()
        if (dd.stage === 'lobby' && dd.room && dd.room.code) {
          const ms = Date.now() - t0
          console.log('  ' + tag + ': ' + (ms / 1000).toFixed(2) + ' 秒')
          return ms
        }
      }
      console.log('  ' + tag + ': 超时(>7s)')
      return 0
    }
    /*
     * ★ 验证分包预加载：preloadRule 配的是"进大厅就后台下载 game 分包"。
     * 如果生效，在大厅停一会儿再进房间应该比"进大厅立刻点"更快；
     * 如果没生效，两次都会卡在 1.6MB 分包下载上。
     */
    await oneRound('进大厅立刻建房')
    console.log('  …在大厅等 6 秒（让 preloadRule 有时间下载分包）…')
    await sleep(6000)
    await mini.switchTab('/pages/lobby/lobby').catch(() => {})
    await sleep(1200)
    await oneRound('等 6 秒后再建房（预加载应已生效）')
    /* 回大厅再建一间 */
    await mini.switchTab('/pages/lobby/lobby').catch(() => {})
    await sleep(2500)
    await oneRound('第二次建房（热）')
  } finally { await mini.close().catch(() => {}) }
})().catch(e => { console.error('失败:', e.message); process.exit(1) })
