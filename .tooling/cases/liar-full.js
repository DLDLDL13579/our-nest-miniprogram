module.exports = async function (mini, sleep) {
  await sleep(6000)
  const code = await mini.evaluate(function () {
    const api = (d) => wx.cloud.callFunction({ name: 'room', data: d }).then(r => r.result)
    return api({ action: 'create', name: 'L', game: 'liar' }).then(function (cr) {
      if (!cr.ok) return ''
      return api({ action: 'start', id: cr.room.id, solo: true }).then(function () { return cr.room.code + '|' + cr.room.id })
    })
  })
  if (!code) return { err: '建房失败' }
  const rid = code.split('|')[1]
  await mini.navigateTo('/game/room/room?code=' + code.split('|')[0])
  await sleep(4500)
  const log = []
  let p = await mini.currentPage()
  let d = await p.data()
  log.push('stage=' + d.stage + ' 骰子=' + (d.room && d.room.myDice ? d.room.myDice.length : 0))
  /* 按住偷看（必须先看才能叫） */
  const cup = await p.$('.cs-cup')
  if (cup) {
    await cup.trigger('touchstart', {})
    await sleep(700)
    await cup.trigger('touchend', {})
    await sleep(400)
    d = await (await mini.currentPage()).data()
    log.push('偷看后 liarReady=' + d.liarReady)
  }
  /* 点第一个叫法 */
  const opts = await p.$$('.optbtn')
  log.push('叫法按钮 ' + opts.length + ' 个')
  if (opts.length) {
    const label = (await opts[0].text()).trim()
    await opts[0].tap()
    await sleep(3000)
    d = await (await mini.currentPage()).data()
    log.push('点了 "' + label + '" 后 bid=' + JSON.stringify(d.room && d.room.bid && { n: d.room.bid.n, face: d.room.bid.face }))
  }
  return { log }
}
