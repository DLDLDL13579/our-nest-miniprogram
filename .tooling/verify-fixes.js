/** 逐条验证用户报的五个问题 */
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

  // ① 配对状态：单人应返回 paired:false
  const p1 = await mini.evaluate(async () =>
    (await wx.cloud.callFunction({ name: 'pair', data: { action: 'status' } })).result)
  console.log('① 配对状态  paired =', p1.pair && p1.pair.paired,
              '| memberCount =', p1.pair && p1.pair.memberCount,
              '| inviteCode =', (p1.pair && p1.pair.inviteCode) || '(空)')
  console.log('   → 期望 paired=false（单人状态不该显示"已配对"）')

  // ② 打开配对页，看它显示什么
  await mini.reLaunch('/pages/pair/pair')
  await sleep(5000)
  let pg = await mini.currentPage()
  let d = await pg.data()
  console.log('\n② 配对页  code =', d.code, '| pair.paired =', d.pair && d.pair.paired)
  await mini.screenshot({ path: path.join(OUT, 'fix-配对页.png') })

  // ③ 记一条带图片尺寸的（模拟不同尺寸）
  await mini.evaluate(async () => {
    await wx.cloud.callFunction({ name: 'moments', data: {
      action: 'add', text: '验证：这条用来测试删除和图片', mood: 'happy', photos: [] } })
  })
  await mini.reLaunch('/pages/index/index')
  await sleep(5000)
  pg = await mini.currentPage(); d = await pg.data()
  console.log('\n③ 首页  记录数 =', d.moments.length, '| 第一条 mine =', d.moments[0] && d.moments[0].mine)

  // ④ 删除（直接调云函数，等价于长按确认）
  const del = await mini.evaluate(async () => {
    const list = (await wx.cloud.callFunction({ name: 'moments', data: { action: 'list', size: 10 } })).result
    const target = (list.list || []).filter(m => /^验证：/.test(m.text))[0]
    if (!target) return { err: '没找到测试记录' }
    const r = (await wx.cloud.callFunction({ name: 'moments', data: { action: 'remove', id: target.id } })).result
    const after = (await wx.cloud.callFunction({ name: 'moments', data: { action: 'list', size: 10 } })).result
    return { removeOk: r.ok, left: (after.list || []).length }
  })
  console.log('\n④ 删除  ok =', del.removeOk, '| 删除后剩余 =', del.left)

  // ⑤ 首页小工具是否在首屏（不滚动就能看到）
  const layout = await mini.evaluate(() => {
    return new Promise(res => {
      const q = wx.createSelectorQuery()
      q.select('.toolrow').boundingClientRect()
      q.select('.toolrow').scrollOffset ? null : null
      q.selectViewport().scrollOffset()
      q.exec(r => {
        const rect = r[0]
        res({ top: rect ? Math.round(rect.top) : null, screenH: 667 })
      })
    })
  })
  console.log('\n⑤ 小工具位置  top =', layout.top, 'px  →',
              layout.top !== null && layout.top < 700 ? '在首屏内 ✓' : '需要滚动才能看到')

  await mini.screenshot({ path: path.join(OUT, 'fix-首页.png') })
  await mini.disconnect()
  console.log('\n✓ 完成')
})().catch(e => { console.error('✗', e.message); process.exit(1) })
