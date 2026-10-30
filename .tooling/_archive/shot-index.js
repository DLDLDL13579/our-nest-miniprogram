const automator = require('miniprogram-automator')
const path = require('path')
;(async () => {
  const mini = await automator.launch({
    cliPath: '/Applications/wechatwebdevtools.app/Contents/MacOS/cli',
    projectPath: '/Users/meihaoshidai/Downloads/邓林work/个人项目/小程序',
    timeout: 90000
  })
  await mini.navigateTo('/pages/index/index')
  await new Promise(r => setTimeout(r, 4000))
  const page = await mini.currentPage()
  /* 量 hero 与气球图标的真实尺寸 */
  const hero = await page.$('.hero')
  const ic = await page.$('.hn-ic')
  if (hero) { const s = await hero.size(); const o = await hero.offset()
    console.log(`  .hero  高 ${Math.round(s.height)}px  top=${Math.round(o.top)} bottom=${Math.round(o.top+s.height)}`) }
  if (ic) { const s = await ic.size(); console.log(`  .hn-ic 图标 ${Math.round(s.width)}×${Math.round(s.height)}px`) }
  else console.log('  .hn-ic 没渲染（可能今天不是"距纪念日<=60天"分支）')
  await mini.screenshot({ path: '/Users/meihaoshidai/Downloads/邓林work/个人项目/小程序/outputs/verify-index-fixed.png' })
  console.log('  截图 → outputs/verify-index-fixed.png')
  await mini.close(); process.exit(0)
})().catch(e => { console.error('失败:', e.message); process.exit(1) })
