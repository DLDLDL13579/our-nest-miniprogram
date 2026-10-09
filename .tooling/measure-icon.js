/**
 * measure-icon.js —— 量首页图标真实尺寸（不依赖 page.$ 句柄）
 *
 * automator 的 page.$/size 在 IDE 模拟器非活动时偶发 "getPageMetaByWebviewId null"。
 * 改用 evaluate + createSelectorQuery —— 它走的是小程序自己的 API，
 * 不依赖 IDE 的 webview 元信息通道，稳得多。
 *
 * 用法：node .tooling/measure-icon.js
 */
const automator = require('miniprogram-automator')
const path = require('path')
;(async () => {
  const mini = await automator.launch({
    cliPath: '/Applications/wechatwebdevtools.app/Contents/MacOS/cli',
    projectPath: path.join(__dirname, '..'),
    timeout: 90000
  })
  await mini.navigateTo('/pages/index/index')
  await new Promise(r => setTimeout(r, 4000))

  const out = await mini.evaluate(() => new Promise(resolve => {
    const q = wx.createSelectorQuery()
    ;['.wc-pen', '.hn-ic', '.hero', '.writecard', '.capsulebar'].forEach(s => q.select(s).boundingClientRect())
    q.exec(res => resolve(res.map((r, i) =>
      r ? { sel: ['.wc-pen', '.hn-ic', '.hero', '.writecard', '.capsulebar'][i],
            w: Math.round(r.width), h: Math.round(r.height), top: Math.round(r.top) }
        : { sel: ['.wc-pen', '.hn-ic', '.hero', '.writecard', '.capsulebar'][i], missing: true })))
  }))

  console.log('\n  ── 首页元素实测尺寸（px，dpr=2 时 1rpx=0.5px）──')
  for (const r of out) {
    if (r.missing) { console.log(`  ${r.sel.padEnd(14)} 未渲染`); continue }
    const rpx = (v) => Math.round(v / 0.5)
    console.log(`  ${r.sel.padEnd(14)} ${String(r.w).padStart(4)}×${String(r.h).padStart(4)}px  = ${String(rpx(r.w)).padStart(4)}×${String(rpx(r.h)).padStart(4)}rpx`)
  }
  console.log()
  await mini.close(); process.exit(0)
})().catch(e => { console.error('失败:', e.message); process.exit(1) })
