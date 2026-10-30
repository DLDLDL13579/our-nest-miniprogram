module.exports = async function (mini, sleep) {
  await sleep(6000)
  const log = []
  for (const g of ['liar', 'dice', 'undercover', 'poker', 'wheel']) {
    const code = await mini.evaluate(function (game) {
      const api = (d) => wx.cloud.callFunction({ name: 'room', data: d }).then(r => r.result)
      return (async () => {
        const cr = await api({ action: 'create', name: '上线态', game: game })
        return cr.ok ? cr.room.code : ''
      })()
    }, g)
    if (!code) { log.push(g + ' 建房失败'); continue }
    await mini.navigateTo('/game/room/room?code=' + code)
    await sleep(3200)
    const p = await mini.currentPage()
    const d = await p.data()
    /* 检查关键元素是否存在 */
    const btns = await p.$$('.bigbtn')
    let txt = '-'
    if (btns.length) txt = (await btns[btns.length-1].text()).replace(/\s+/g,' ').trim()
    log.push(g.padEnd(11) + ' stage=' + d.stage + ' 主按钮=' + JSON.stringify(txt))
    await mini.screenshot({ path: '/tmp/real-shots/off-' + g + '.png' })
    await mini.navigateBack().catch(()=>{})
    await sleep(1000)
  }
  return { log }
}
