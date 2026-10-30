module.exports = async function (mini, sleep) {
  await sleep(6000)
  /* 转盘 1 人就能开 —— 这是上线态唯一能单人跑完的玩法 */
  const code = await mini.evaluate(function () {
    const api = (d) => wx.cloud.callFunction({ name: 'room', data: d }).then(r => r.result)
    return (async () => {
      const cr = await api({ action: 'create', name: '上线转盘', game: 'wheel' })
      return cr.ok ? cr.room.code : ''
    })()
  })
  await mini.navigateTo('/game/room/room?code=' + code)
  await sleep(3200)
  let p = await mini.currentPage()
  const log = []
  let d = await p.data()
  log.push('lobby: 主按钮=' + JSON.stringify(((await (await p.$('.bigbtn')).text())||'').replace(/\s+/g,' ').trim()))
  /* 点开始（不传 solo）*/
  await (await p.$('.bigbtn')).tap()
  for (let i=0;i<10;i++){ await sleep(700); p = await mini.currentPage(); d = await p.data(); if (d.stage==='playing') break }
  log.push('开局后 stage=' + d.stage)
  /* 找转按钮 */
  const rb = await p.$('.bigbtn')
  if (rb) {
    log.push('转按钮=' + JSON.stringify(((await rb.text())||'').replace(/\s+/g,' ').trim()))
    await rb.tap()
    for (let i=0;i<20;i++){ await sleep(600); p = await mini.currentPage(); d = await p.data(); if (d.wheelText && d.wheelText !== '转起来了…') break }
    log.push('转出结果 wheelText=' + JSON.stringify(d.wheelText))
  } else log.push('找不到转按钮')
  await mini.screenshot({ path: '/tmp/real-shots/wheel-off.png' })
  return { log }
}
