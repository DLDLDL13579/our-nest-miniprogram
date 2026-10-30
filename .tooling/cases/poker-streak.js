module.exports = async function (mini, sleep) {
  await sleep(6000)
  const log = []
  /* 建房 + 开局 */
  const code = await mini.evaluate(function () {
    const api = (d) => wx.cloud.callFunction({ name: 'room', data: d }).then(r => r.result)
    return api({ action: 'create', name: 'PK压测', game: 'poker' }).then(function (cr) {
      if (!cr.ok) return ''
      return api({ action: 'start', id: cr.room.id, solo: true }).then(function () { return cr.room.code + '|' + cr.room.id })
    })
  })
  if (!code) return { err: '建房失败' }
  const rid = code.split('|')[1]
  log.push('房间 ' + code.split('|')[0])
  /* 每局一次 evaluate：换一次手牌 + 弃牌 */
  for (let round = 1; round <= 2; round++) {
    const r = await mini.evaluate(function (id) {
      const api = (d) => wx.cloud.callFunction({ name: 'room', data: d }).then(x => x.result)
      return (async () => {
        for (let i = 0; i < 6; i++) {
          await new Promise(x => setTimeout(x, 700))
          const st = await api({ action: 'status', id: id })
          if (st.room && st.room.phase === 'playing') break
        }
        const before = await api({ action: 'status', id: id })
        const k0 = before.room.poker && before.room.poker.myKnownText
        const sw = await api({ action: 'pkAct', act: 'swapMine', id: id })
        if (!sw.ok) return { err: '换牌失败: ' + sw.msg }
        const k1 = sw.room.poker.myKnownText
        const drink = sw.room.poker.myDrink
        const fd = await api({ action: 'pkAct', act: 'fold', id: id })
        if (!fd.ok) return { err: '弃牌失败: ' + fd.msg, k0: k0, k1: k1 }
        return { 换前: k0, 换后: k1, 喝: drink, 弃牌后: fd.room.phase }
      })()
    }, rid).catch(e => ({ err: String(e && e.message || e) }))
    log.push('第' + round + '局: ' + JSON.stringify(r))
    if (r.err) break
    if (round < 2) {
      await mini.evaluate(function (id) {
        const api = (d) => wx.cloud.callFunction({ name: 'room', data: d }).then(x => x.result)
        return api({ action: 'again', id: id }).then(function () { return api({ action: 'start', id: id, solo: true }) }).then(function () { return 'ok' })
      }, rid).catch(() => {})
    }
  }
  return { log }
}
