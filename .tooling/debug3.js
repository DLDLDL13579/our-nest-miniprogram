const automator = require('miniprogram-automator')
const path = require('path')
const sleep = ms => new Promise(r => setTimeout(r, ms))
;(async () => {
  const mini = await automator.launch({
    cliPath: '/Applications/wechatwebdevtools.app/Contents/MacOS/cli',
    projectPath: path.join(__dirname, '..'), timeout: 90000
  })
  console.log('✓ 已连上')
  await mini.reLaunch('/pages/index/index')
  await sleep(6000)

  // 通过页面实例调云函数：给页面挂一个临时方法不行，
  // 但页面自己的 load() 会调 reminds —— 直接看它的 data 就够了
  await mini.reLaunch('/pages/reminds/reminds')
  await sleep(6000)
  let pg = await mini.currentPage()
  let d = await pg.data()
  console.log('  提醒页初始: 条数 =', (d.list||[]).length, '| loading =', d.loading)

  // 用页面自己的 startAdd + setData + save 走完整 UI 路径
  await pg.callMethod('startAdd')
  await sleep(800)
  await pg.setData({
    'f.title': '倩萍妈妈生日',
    'f.date': '2026-11-06',
    'f.repeat': 'yearly',
    'f.leadDays': 14,
    'f.who': '她家',
    'f.lastGift': '按摩仪'
  })
  await sleep(800)
  d = await pg.data()
  console.log('  表单填好:', JSON.stringify(d.f))

  await pg.callMethod('save')
  await sleep(5000)
  d = await pg.data()
  console.log('  save 之后: 条数 =', (d.list||[]).length, '| adding =', d.adding)
  if (d.list && d.list.length) {
    const it = d.list[0]
    console.log('  第一条:', JSON.stringify({title:it.title, days:it.daysUntil, inWindow:it.inWindow, lastGift:it.lastGift, turning:it.turning}))
  } else {
    console.log('  ✗ 还是 0 条 —— 说明 add 失败了')
  }
  await mini.screenshot({ path: path.join(__dirname, '..', 'outputs', 'reminds-列表.png') })
  await mini.disconnect()
})().catch(e => { console.error('✗', e.message); process.exit(1) })
