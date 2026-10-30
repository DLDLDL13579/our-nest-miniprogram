/**
 * shot-dice-wait.js —— 看「摇骰子比大小」的等待界面长什么样
 *
 * 用户报「双人交互不太智能」时，等待期间界面只有一句
 * "已扣盅，等其他人摇完" —— 没说等谁、还差几个。
 * 这次补了「还差 N 个人没摇（某某、某某）」，本脚本把它渲染出来确认。
 *
 * 用法：node .tooling/shot-dice-wait.js
 */
const automator = require('miniprogram-automator')
const path = require('path')
const fs = require('fs')

const PROJECT = path.join(__dirname, '..')
const OUT = path.join(PROJECT, 'outputs')

;(async () => {
  if (!fs.existsSync(OUT)) fs.mkdirSync(OUT, { recursive: true })
  const mini = await automator.launch({
    cliPath: '/Applications/wechatwebdevtools.app/Contents/MacOS/cli',
    projectPath: PROJECT,
    timeout: 90000
  })
  await mini.navigateTo('/pages/game/room/room')
  await new Promise(r => setTimeout(r, 2500))

  /* 造一个"三人局，我已经摇完、另外两人还没摇"的状态 */
  await mini.evaluate(() => {
    const pages = getCurrentPages()
    pages[pages.length - 1].setData({
      stage: 'playing',
      room: {
        id: 'p', game: 'dice', phase: 'playing', host: true,
        me: { seat: 1, name: '我', dice: [3, 5] },
        players: [
          { openid: 'a', name: '我', seat: 1, isMe: true, isHost: true, online: true, dice: [3, 5], diceCount: 2 },
          { openid: 'b', name: '倩萍', seat: 2, isMe: false, isHost: false, online: true, diceCount: 0 },
          { openid: 'c', name: '老王', seat: 3, isMe: false, isHost: false, online: true, diceCount: 0 }
        ],
        count: 3, turn: 0, round: 1, bid: null, options: [],
        myTurn: false, turnName: '',
        waitingCount: 2, waitingNames: '倩萍、老王'
      },
      myDice: [3, 5], myRolled: true, diceShown: false,
      cupSrc: 'cup-down', cupCls: '', cupHint: '已扣盅，等其他人摇完',
      rolling: false, result: null
    })
  })
  await new Promise(r => setTimeout(r, 900))

  const page = await mini.currentPage()
  const d = await page.data()
  console.log('\n  ── 摇骰子·等待界面 ──')
  console.log(`     waitingCount = ${d.room.waitingCount}`)
  console.log(`     waitingNames = ${d.room.waitingNames}`)

  /* 确认"还差谁"这行真的渲染出来了 */
  const waitEl = await page.$('.waitline')
  console.log(`     .waitline 元素 ${waitEl ? '✓ 已渲染' : '★ 没渲染出来'}`)
  if (waitEl) {
    const t = await waitEl.text()
    console.log(`     文案：「${(t || '').trim()}」`)
  }

  /* 每人的"已摇/还没摇"标记 */
  const stats = await page.$$('.oc-stat')
  console.log(`     玩家状态标记 ${stats.length} 个：`)
  for (const s of stats) {
    const t = (await s.text() || '').trim()
    const cls = await s.attribute('class')
    console.log(`        ${t}${/done/.test(cls || '') ? '  (金色高亮)' : ''}`)
  }

  const shot = path.join(OUT, 'verify-dice-wait.png')
  await mini.screenshot({ path: shot })
  console.log(`\n     截图 → ${path.relative(PROJECT, shot)}\n`)

  await mini.close()
  process.exit(0)
})().catch(e => { console.error('失败:', e.message); process.exit(1) })
