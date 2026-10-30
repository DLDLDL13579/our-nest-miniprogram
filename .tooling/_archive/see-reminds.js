const automator = require('miniprogram-automator')
const path = require('path'), fs = require('fs')
const OUT = path.join(__dirname, '..', 'outputs')
const sleep = ms => new Promise(r => setTimeout(r, ms))
;(async () => {
  const mini = await automator.launch({
    cliPath: '/Applications/wechatwebdevtools.app/Contents/MacOS/cli',
    projectPath: path.join(__dirname, '..'), timeout: 90000
  })
  console.log('✓ 已连上')
  if (!fs.existsSync(OUT)) fs.mkdirSync(OUT, { recursive: true })

  // 清缓存触发建库（新表 reminds）
  await mini.reLaunch('/pages/index/index')
  await sleep(7000)

  await mini.reLaunch('/pages/reminds/reminds')
  await sleep(5000)
  const pg = await mini.currentPage()
  let d = await pg.data()
  console.log('  提醒页:', pg.path, '| 条数:', (d.list||[]).length, '| 紧急:', d.urgent)

  // 加两条：一条快到期、一条很远
  await pg.callMethod('startAdd')
  await sleep(1000)
  const soon = new Date(Date.now() + 8*3600e3 + 10*86400000).toISOString().slice(0,10)
  const far = new Date(Date.now() + 8*3600e3 + 200*86400000).toISOString().slice(0,10)
  await pg.setData({ 'f.title': '倩萍妈妈生日', 'f.date': soon, 'f.repeat': 'once', 'f.leadDays': 14, 'f.who': '她家', 'f.lastGift': '按摩仪（她说好用）' })
  await sleep(600)
  await pg.callMethod('save')
  await sleep(4000)
  d = await pg.data()
  console.log('  加了一条 → 条数:', (d.list||[]).length, '| 紧急:', d.urgent)
  if (d.list && d.list.length) {
    const it = d.list[0]
    console.log('  第一条:', it.title, '| 剩余', it.daysUntil, '天 | 进窗口:', it.inWindow, '| 上次送:', it.lastGift)
  }
  await mini.screenshot({ path: path.join(OUT, 'reminds-列表.png') })

  await pg.callMethod('startAdd')
  await sleep(1200)
  await mini.screenshot({ path: path.join(OUT, 'reminds-新增.png') })
  console.log('  ✓ 两张截图已存')
  await mini.disconnect()
})().catch(e => { console.error('✗', e.message); process.exit(1) })
