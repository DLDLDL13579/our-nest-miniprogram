const automator = require('miniprogram-automator')
const path = require('path'), fs = require('fs')
const OUT = path.join(__dirname, '..', 'outputs')
const sleep = ms => new Promise(r => setTimeout(r, ms))
;(async () => {
  const mini = await automator.launch({
    cliPath: '/Applications/wechatwebdevtools.app/Contents/MacOS/cli',
    projectPath: path.join(__dirname, '..'), timeout: 90000
  })
  // 关掉弹窗：重新进页面
  await mini.reLaunch('/pages/capsule/capsule')
  await sleep(5000)
  await mini.screenshot({ path: path.join(OUT, 'capsule-列表.png') })
  const pg = await mini.currentPage()
  const d = await pg.data()
  console.log('  封存中:', d.locked, '| 可拆:', d.ready, '| 总数:', d.total)
  console.log('  第一封 text 字段:', d.list[0] ? (d.list[0].text === null ? 'null ✓' : '有内容 ✗') : '无')
  console.log('  ✓ 已重新截图')
  await mini.disconnect()
})().catch(e => { console.error('✗', e.message); process.exit(1) })
