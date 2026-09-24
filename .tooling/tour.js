const automator = require('miniprogram-automator')
const path = require('path'), fs = require('fs')
const OUT = path.join(__dirname, '..', 'outputs')
const sleep = ms => new Promise(r => setTimeout(r, ms))
const pages = [
  ['pages/index/index', '1-今日'],
  ['pages/write/write', '2-记一笔'],
  ['pages/chronicle/chronicle', '3-编年史'],
  ['pages/wishes/wishes', '4-想去去过'],
  ['pages/settings/settings', '5-设置']
]
;(async () => {
  const mini = await automator.launch({
    cliPath: '/Applications/wechatwebdevtools.app/Contents/MacOS/cli',
    projectPath: path.join(__dirname, '..'), timeout: 90000
  })
  console.log('✓ 已连上模拟器')
  for (const [p, name] of pages) {
    try {
      await mini.reLaunch('/' + p)
      await sleep(4500)
      await mini.screenshot({ path: path.join(OUT, 'tour-' + name + '.png') })
      const pg = await mini.currentPage()
      console.log('  ✓ ' + name + '  (' + pg.path + ')')
    } catch (e) {
      console.log('  ✗ ' + name + ': ' + e.message.slice(0, 50))
    }
  }
  await mini.disconnect()
  console.log('✓ 五张截图已存 outputs/')
})().catch(e => { console.error('✗', e.message); process.exit(1) })
