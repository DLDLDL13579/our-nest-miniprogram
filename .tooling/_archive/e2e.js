/** 真机端到端：写一条记录 → 看首页是否显示 → 看编年史是否归档 */
const automator = require('miniprogram-automator')
const path = require('path'), fs = require('fs')
const OUT = path.join(__dirname, '..', 'outputs')
const sleep = ms => new Promise(r => setTimeout(r, ms))

;(async () => {
  const mini = await automator.launch({
    cliPath: '/Applications/wechatwebdevtools.app/Contents/MacOS/cli',
    projectPath: path.join(__dirname, '..'), timeout: 90000
  })
  console.log('✓ 已连上\n')

  // ① 直接调云函数写一条（模拟用户点"记下来"）
  const add = await mini.evaluate(async () => {
    return (await wx.cloud.callFunction({
      name: 'moments',
      data: { action: 'add', text: '测试：今天她做的番茄炒蛋特别好吃，比上次咸了一点点，但更好吃。', mood: 'happy', photos: [] }
    })).result
  })
  console.log('① 写一条记录 →', JSON.stringify(add))

  // ② 回首页看是否显示
  await mini.reLaunch('/pages/index/index')
  await sleep(5000)
  let page = await mini.currentPage()
  let d = await page.data()
  console.log('② 首页 → 记录数:', d.moments.length, '| 总条数:', d.total, '| 天数:', d.days)
  if (d.moments.length) console.log('   最新一条:', d.moments[0].text.slice(0, 30) + '…')
  await mini.screenshot({ path: path.join(OUT, '首页-有记录.png') })

  // ③ 编年史
  await mini.reLaunch('/pages/chronicle/chronicle')
  await sleep(5000)
  page = await mini.currentPage()
  d = await page.data()
  console.log('③ 编年史 → 天数分组:', (d.list || []).length, '| 空态:', d.empty, '| 里程碑:', (d.ms || []).length)
  await mini.screenshot({ path: path.join(OUT, '编年史-实机.png') })

  // ④ 写记录页
  await mini.reLaunch('/pages/write/write')
  await sleep(3500)
  page = await mini.currentPage()
  d = await page.data()
  console.log('④ 写记录页 → 心情选项:', d.moods.length, '| 引子:', (d.spark || '').slice(0, 20) + '…')
  await mini.screenshot({ path: path.join(OUT, '写记录页-实机.png') })

  await mini.disconnect()
  console.log('\n✓ 完成，三张截图已存 outputs/')
})().catch(e => { console.error('✗', e.message); process.exit(1) })
