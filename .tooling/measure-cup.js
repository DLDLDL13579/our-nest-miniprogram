/**
 * measure-cup.js —— 精确测量骰盅在"偷看"状态下有没有被场景裁掉
 *
 * 起因：截图看起来盅顶是平的，怀疑被 .cupscene 的 overflow:hidden 裁了。
 * **不靠眼睛判断** —— 量元素真实盒子与场景盒子的关系。
 *
 * 用法：node .tooling/measure-cup.js
 */
const automator = require('miniprogram-automator')
const path = require('path')

;(async () => {
  const mini = await automator.launch({
    cliPath: '/Applications/wechatwebdevtools.app/Contents/MacOS/cli',
    projectPath: path.join(__dirname, '..'),
    timeout: 90000
  })
  await mini.navigateTo('/pages/game/room/room')
  await new Promise(r => setTimeout(r, 2500))

  await mini.evaluate(() => {
    const pages = getCurrentPages()
    pages[pages.length - 1].setData({
      stage: 'playing',
      room: {
        id: 'p', game: 'liar', phase: 'playing', host: true,
        me: { seat: 1, name: '我', dice: [1, 2, 3, 4, 5] },
        players: [{ openid: 'me', name: '我', seat: 1, isMe: true, isHost: true, online: true, dice: [1, 2, 3, 4, 5], diceCount: 5 }],
        count: 1, turn: 1, round: 1, bid: null, options: ['1个1'],
        myTurn: true, turnName: '我', waitingCount: 0, waitingNames: ''
      },
      myDice: [1, 2, 3, 4, 5], diceShown: true,
      cupSrc: 'cup-up', cupCls: 'peek', cupHint: '松手扣回去'
    })
  })
  await new Promise(r => setTimeout(r, 1100))

  const page = await mini.currentPage()
  const scene = await page.$('.cupscene')
  const cup = await page.$('.cs-cup')
  const dice = await page.$('.cs-dice')

  const ss = await scene.size(), so = await scene.offset()
  const cs = await cup.size(), co = await cup.offset()
  const ds = await dice.size(), dOff = await dice.offset()

  const cupTopInScene = co.top - so.top
  const cupBottomInScene = co.top + cs.height - so.top
  const diceTopInScene = dOff.top - so.top
  const diceBottomInScene = dOff.top + ds.height - so.top

  console.log('\n  ── 场景（.cupscene，overflow:hidden）──')
  console.log(`     屏幕 y = ${Math.round(so.top)} ~ ${Math.round(so.top + ss.height)}   高 ${Math.round(ss.height)}px`)

  console.log('\n  ── 盅（.cs-cup，peek 状态）──')
  console.log(`     场景内 y = ${Math.round(cupTopInScene)} ~ ${Math.round(cupBottomInScene)}   高 ${Math.round(cs.height)}px`)

  console.log('\n  ── 骰子（.cs-dice）──')
  console.log(`     场景内 y = ${Math.round(diceTopInScene)} ~ ${Math.round(diceBottomInScene)}`)

  const cut = cupTopInScene < -1
  const clear = diceTopInScene - cupBottomInScene

  /*
   * ★★ 关键：**盒子超出 ≠ 图形被裁**。
   *    cup-up.png 顶部有 17% 透明留白（实测内容从 2px 就开始，但 cup-down 是 83px）。
   *    cup-up 的实测边界是 (2,2)-(280,404)，画布 312×485 ——
   *    也就是说 cup-up 这张图**几乎顶到上沿**，透明带很小。
   *
   *    所以判断"有没有被裁"必须看**可见像素**，不能看盒子。
   *    这里把"盒子超出量"和"图片顶部透明带"都算出来，
   *    只有超出量 > 透明带，才真的切到了实体。
   */
  const IMG = { w: 312, h: 485 }
  /* cup-up.png 实测：alpha 边界 (2,2)-(280,404) */
  const CUP_UP_TOP_BLANK = 2
  const cssToPx = cs.width / IMG.w            // CSS 宽 / 图片宽 = 缩放比
  const blankPx = CUP_UP_TOP_BLANK * cssToPx  // 顶部透明带折算成屏幕像素
  const overflow = -cupTopInScene             // 盒子超出上沿多少
  const realCut = overflow - blankPx          // 真正切到实体的像素数

  console.log('\n  判定：')
  console.log(`     盒子超出上沿 ${overflow.toFixed(1)}px，图片顶部透明带 ${blankPx.toFixed(1)}px`)
  console.log(`     ${realCut > 1
    ? '★ 实体被裁掉 ' + realCut.toFixed(1) + 'px → 盅顶真的被切平了'
    : '✓ 只切到透明带，实体完好（' + (-realCut).toFixed(1) + 'px 余量）'}`)
  console.log(`     ${clear > 0 ? '✓ 骰子完全露出（余量 ' + clear.toFixed(1) + 'px）' : '★ 骰子被压住 ' + (-clear).toFixed(1) + 'px'}`)
  console.log()

  await mini.close()
  process.exit(0)
})().catch(e => { console.error('失败:', e.message); process.exit(1) })
