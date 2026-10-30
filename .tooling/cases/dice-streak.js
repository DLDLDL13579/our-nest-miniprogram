module.exports = async function (mini, sleep) {
  await sleep(6000)
  const log = []
  /* 建房 + 开局 */
  const code = await mini.evaluate(function () {
    const api = (d) => wx.cloud.callFunction({ name: 'room', data: d }).then(r => r.result)
    return api({ action: 'create', name: 'RS', game: 'dice' }).then(function (cr) {
      if (!cr.ok) return ''
      return api({ action: 'start', id: cr.room.id, solo: true }).then(function () { return cr.room.code + '|' + cr.room.id })
    })
  })
  if (!code) return { err: '建房失败' }
  const roomId = code.split('|')[1]
  /* 每局：一次 evaluate 完成「摇→等结算→看图」 */
  for (let round = 1; round <= 3; round++) {
    const r = await mini.evaluate(function (rid) {
      const api = (d) => wx.cloud.callFunction({ name: 'room', data: d }).then(r => r.result)
      return (async () => {
        /* 等 playing */
        let room = null
        for (let i = 0; i < 6; i++) {
          await new Promise(x => setTimeout(x, 700))
          const st = await api({ action: 'status', id: rid }).catch(() => null)
          if (st && st.ok && st.room && st.room.phase === 'playing') { room = st.room; break }
          if (st && st.ok && st.room) room = st.room
        }
        const roll = await api({ action: 'roll', id: rid })
        if (!roll.ok) return { err: '摇骰失败: ' + roll.msg, id: rid }
        for (let i = 0; i < 6; i++) {
          await new Promise(x => setTimeout(x, 600))
          const st = await api({ action: 'status', id: rid })
          if (st.room && st.room.phase === 'over') {
            return { id: rid, phase: 'over', dice: (st.room.me && st.room.me.dice) || [],
                     streaks: JSON.stringify(st.room.streaks || {}) }
          }
        }
        return { id: rid, phase: 'playing', note: '结算超时' }
      })()
    }, roomId).catch(e => ({ err: String(e && e.message || e) }))
    log.push('第' + round + '局: ' + JSON.stringify(r).slice(0, 80))
    if (r.err) break
    /* 再来一局 + 开始（下一次 evaluate） */
    if (round < 3) {
      await mini.evaluate(function (id) {
        const api = (d) => wx.cloud.callFunction({ name: 'room', data: d }).then(r => r.result)
        return api({ action: 'again', id: id }).then(function () {
          return api({ action: 'start', id: id, solo: true })
        }).then(function () { return 'ok' })
      }, r.id).catch(() => {})
    }
  }
  return { log }
}
