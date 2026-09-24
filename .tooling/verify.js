/** 走一遍真实界面：截图 + 读数据，确认改造生效 */
const automator = require('miniprogram-automator')
const path = require('path')
const fs = require('fs')
const OUT = path.join(__dirname, '..', 'outputs')

;(async () => {
  const mini = await automator.launch({
    cliPath: '/Applications/wechatwebdevtools.app/Contents/MacOS/cli',
    projectPath: path.join(__dirname, '..'),
    timeout: 90000
  })
  console.log('✓ 已连上模拟器')
  if (!fs.existsSync(OUT)) fs.mkdirSync(OUT, { recursive: true })

  const sleep = ms => new Promise(r => setTimeout(r, ms))

  // 清缓存，让 app.js 的 bootstrap 重新跑一次（建 moments 集合）
  await mini.evaluate(() => { wx.clearStorageSync() })
  console.log('✓ 已清本地缓存，触发重新初始化')

  await mini.reLaunch('/pages/index/index')
  await sleep(6000)

  const page = await mini.currentPage()
  console.log('  页面:', page.path)
  const d = await page.data()
  console.log('  加载中:', d.loading, '| 未配对:', d.noPair, '| solo:', d.solo)
  console.log('  天数:', d.D && d.D.days, '| 第几个年头:', d.D && d.D.headNo)
  console.log('  记录条数:', d.moments ? d.moments.length : 'n/a', '| 总条数:', d.total)
  console.log('  那年今日:', d.onThisDay ? '有' : '无')

  await mini.screenshot({ path: path.join(OUT, '今日页-新版.png') })
  console.log('✓ 截图：outputs/今日页-新版.png')

  // 再跑一次看云函数有没有报错
  const err = await mini.evaluate(async () => {
    const r = {}
    try { r.moments = (await wx.cloud.callFunction({ name: 'moments', data: { action: 'list', size: 3 } })).result }
    catch (e) { r.momentsErr = e.errMsg || e.message }
    try { r.chronicle = (await wx.cloud.callFunction({ name: 'chronicle', data: { action: 'list', size: 1 } })).result }
    catch (e) { r.chronicleErr = e.errMsg || e.message }
    return r
  })
  console.log('\n云函数返回：')
  console.log('  moments :', JSON.stringify(err.moments || err.momentsErr).slice(0, 240))
  console.log('  chronicle:', JSON.stringify(err.chronicle || err.chronicleErr).slice(0, 240))

  await mini.disconnect()
  console.log('\n✓ 完成')
})().catch(e => { console.error('✗', e.message); process.exit(1) })
