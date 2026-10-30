/** 实测三个 bug：大话骰能否叫骰 / 转盘能否转 / 骰盅与骰子层叠 */
const automator = require('miniprogram-automator')
const path = require('path')

;(async () => {
  const mini = await automator.launch({
    cliPath: '/Applications/wechatwebdevtools.app/Contents/MacOS/cli',
    projectPath: path.join(__dirname, '..'),
    timeout: 90000
  })
  await mini.navigateTo('/pages/game/room/room')
  await new Promise(r => setTimeout(r, 2500))

  const r = await mini.evaluate(async () => {
    const out = {}
    const call = async (d) => (await wx.cloud.callFunction({ name: 'room', data: d })).result

    /* === ① 大话骰：开局后是什么状态 === */
    const c1 = await call({ action: 'create', name: 'A', game: 'liar' })
    const id1 = c1.room.id
    await call({ action: 'start', id: id1 })
    const s1 = await call({ action: 'status', id: id1 })
    out.liar = {
      phase: s1.room.phase,
      mySeat: s1.room.me.seat,
      myDiceLen: (s1.room.me.dice || []).length,
      turn: s1.room.turn,
      optionsLen: (s1.room.options || []).length
    }
    /* 单人也叫一下试试（服务端会不会因为不是双人拒绝）*/
    try {
      const bid = await call({ action: 'bid', id: id1, n: 2, face: 3 })
      out.liar.bid = bid.ok ? '服务端接受' : ('服务端拒绝: ' + bid.msg)
    } catch (e) { out.liar.bid = '抛错: ' + String(e.errMsg || e.message) }
    await call({ action: 'leave', id: id1 })

    /* === ② 转盘：单人建房 → start → 能否 spin === */
    const c2 = await call({ action: 'create', name: 'B', game: 'wheel' })
    const id2 = c2.room.id
    await call({ action: 'start', id: id2 })
    const s2 = await call({ action: 'status', id: id2 })
    out.wheel = { phase: s2.room.phase, host: s2.room.host, game: s2.room.game }
    const sp = await call({ action: 'spin', id: id2 })
    out.wheel.spin = sp.ok ? ('OK → ' + sp.spin.t) : ('失败: ' + sp.msg)
    await call({ action: 'leave', id: id2 })

    /* === ③ 当前页面 data（看 liarReady / 转盘相关字段）===" */
    const pages = getCurrentPages()
    out.page = { stage: pages[0] && pages[0].data.stage,
                 liarReady: pages[0] && pages[0].data.liarReady }
    return out
  })
  console.log(JSON.stringify(r, null, 2))
  await mini.close()
  process.exit(0)
})().catch(e => { console.error('失败:', e.message); process.exit(1) })
