/**
 * measure-index.js —— 量首页真实布局，定位"酒桌游戏卡片被 tabBar 压住"
 *
 * 用户截图：底部"酒桌游戏"卡片被 tabBar 遮住一半。
 *
 * 先分清三种可能，它们的修法完全不同：
 *   ① **页面根本不能滚**（内容高度 = 视口高度）→ 底部内容永久看不到
 *   ② 能滚，但**滚动到底仍被遮**（padding-bottom 不够）
 *   ③ 能滚且滚到底能看全 → 那就只是"首屏恰好切在卡片中间"，属正常
 *
 * 所以本脚本量四样东西：
 *   · 视口高度（可用窗口高）
 *   · 页面实际内容高度（scrollHeight）
 *   · 底部留白（padding-bottom 折算成 px）
 *   · 最后一个卡片距内容底部的距离
 *
 * 用法：node .tooling/measure-index.js
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
  await new Promise(r => setTimeout(r, 3500))

  const info = await mini.evaluate(() => {
    const out = {}
    /* 用 createSelectorQuery 拿真实布局信息 */
    return new Promise(resolve => {
      const q = wx.createSelectorQuery()
      /* 页面根节点 */
      q.select('.page').boundingClientRect()
      q.select('.gamebar').boundingClientRect()
      q.select('.writecard').boundingClientRect()
      /* 页面滚动信息 */
      q.selectViewport().scrollOffset()
      q.selectViewport().boundingClientRect()
      q.exec(res => {
        const [pageR, gameR, writeR, scroll, viewport] = res
        out.page = pageR && { top: pageR.top, bottom: pageR.bottom, height: pageR.height }
        out.gamebar = gameR && { top: gameR.top, bottom: gameR.bottom, height: gameR.height }
        out.writecard = writeR && { top: writeR.top, bottom: writeR.bottom }
        out.scrollTop = scroll && scroll.scrollTop
        out.viewport = viewport && { width: viewport.width, height: viewport.height }
        /* 系统信息：拿窗口高度与安全区 */
        try {
          const si = wx.getWindowInfo ? wx.getWindowInfo() : wx.getSystemInfoSync()
          out.window = {
            windowHeight: si.windowHeight,
            screenHeight: si.screenHeight,
            safeAreaBottom: si.safeArea ? (si.screenHeight - si.safeArea.bottom) : 0,
            pixelRatio: si.pixelRatio
          }
        } catch (e) { out.windowErr = String(e) }
        resolve(out)
      })
    })
  })

  console.log('\n  ── 首页布局实测 ──')
  if (info.window) {
    console.log(`  窗口高 ${info.window.windowHeight}px   屏高 ${info.window.screenHeight}px   底部安全区 ${info.window.safeAreaBottom}px   dpr ${info.window.pixelRatio}`)
  }
  if (info.viewport) {
    console.log(`  视口 ${Math.round(info.viewport.width)}×${Math.round(info.viewport.height)}px`)
  }
  console.log(`  当前 scrollTop = ${info.scrollTop}`)
  if (info.page) {
    console.log(`  .page  高 ${Math.round(info.page.height)}px   top=${Math.round(info.page.top)}  bottom=${Math.round(info.page.bottom)}`)
  }
  if (info.gamebar) {
    console.log(`  .gamebar  top=${Math.round(info.gamebar.top)}  bottom=${Math.round(info.gamebar.bottom)}  高 ${Math.round(info.gamebar.height)}px`)
  }
  if (info.writecard) {
    console.log(`  .writecard top=${Math.round(info.writecard.top)}  bottom=${Math.round(info.writecard.bottom)}`)
  }

  /* 换算：1rpx = 屏宽/750 px */
  const dpr = info.window ? info.window.pixelRatio : 2
  const rpx2px = (info.viewport ? info.viewport.width : 375) / 750
  console.log(`\n  换算：1rpx ≈ ${rpx2px.toFixed(4)}px`)

  /* 关键判定：滚到底之后，最后一个内容块能不能完整露出来 */
  const scrolled = await mini.evaluate(() => {
    return new Promise(resolve => {
      wx.pageScrollTo({ scrollTop: 99999, duration: 0 })
      setTimeout(() => {
        const q = wx.createSelectorQuery()
        q.select('.gamebar').boundingClientRect()
        q.selectViewport().scrollOffset()
        q.selectViewport().boundingClientRect()
        q.exec(res => {
          const [gameR, scroll, vp] = res
          resolve({
            game: gameR && { top: gameR.top, bottom: gameR.bottom },
            scrollTop: scroll && scroll.scrollTop,
            vpBottom: vp ? vp.bottom : null,
            vpHeight: vp ? vp.height : null
          })
        })
      }, 600)
    })
  })

  console.log('\n  ── 滚到底之后 ──')
  console.log(`  scrollTop = ${scrolled.scrollTop}`)
  if (scrolled.game) {
    console.log(`  .gamebar top=${Math.round(scrolled.game.top)} bottom=${Math.round(scrolled.game.bottom)}`)
  }
  console.log(`  视口底 = ${scrolled.vpBottom}`)

  /* 结论 */
  console.log('\n  ── 判定 ──')
  if (scrolled.game && scrolled.vpBottom != null) {
    const gameBottom = scrolled.game.bottom
    const vpBottom = scrolled.vpBottom
    if (gameBottom <= vpBottom) {
      console.log(`  ✓ 滚到底时"酒桌游戏"卡片完全可见（底 ${Math.round(gameBottom)} ≤ 视口底 ${Math.round(vpBottom)}）`)
      console.log(`     → 说明只是"首屏恰好切在卡片中间"，往下滚就能看全`)
    } else {
      console.log(`  ★ 滚到底仍被遮 ${Math.round(gameBottom - vpBottom)}px → 底部留白不够，是**真 bug**`)
    }
  }
  console.log()

  await mini.close()
  process.exit(0)
})().catch(e => { console.error('失败:', e.message); process.exit(1) })
