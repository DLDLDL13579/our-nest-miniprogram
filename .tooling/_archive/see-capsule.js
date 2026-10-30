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

  // 直接进页面，用页面自己的方法写一封（走真实 UI 路径）
  await mini.reLaunch('/pages/capsule/capsule')
  await sleep(4000)
  let pg = await mini.currentPage()
  console.log('  页面:', pg.path)

  // 打开写信面板并填内容
  await pg.callMethod('startWrite')
  await sleep(1200)
  await pg.setData({
    title: '写给一年后的我们',
    text: '如果你正在读这封信，说明我们真的走过来了。那天我不敢说的那句「我其实很怕失去你」，现在可以说了。'
  })
  await sleep(600)
  let d = await pg.data()
  console.log('  写信面板: unlockAt =', d.unlockAt, '| 正文字数 =', (d.text || '').length)
  await mini.screenshot({ path: path.join(OUT, 'capsule-写信.png') })

  // 提交
  await pg.callMethod('save')
  await sleep(4500)
  d = await pg.data()
  console.log('\n  提交后 → 封存中:', d.locked, '| 总数:', d.total)
  if (d.list && d.list.length) {
    const it = d.list[0]
    console.log('  第一封:', it.title)
    console.log('  未解锁:', !it.unlocked, '| 剩余天数:', it.daysLeft, '| 字数:', it.textLength)
    console.log('  ★ 前端拿到的 text:', it.text === null ? 'null —— 正文没下发 ✓' : '「' + String(it.text).slice(0,20) + '…」✗ 泄露了')
  }
  await mini.screenshot({ path: path.join(OUT, 'capsule-列表.png') })
  console.log('\n  ✓ 截图已存 outputs/')
  await mini.disconnect()
})().catch(e => { console.error('✗', e.message); process.exit(1) })
