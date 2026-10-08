/**
 * shot-room.js —— 截图验证「游戏选择按钮」不再打印英文 key。
 *
 * 背景（2026-10-08 用户截图报障）：
 *   emoji→SVG 改造后，room 页的游戏按钮显示成
 *   「target 大话骰 / dice 摇骰子比大小 / wheel 命运转盘」——
 *   因为 wxml 写的是 {{item.icon}}，把图标 key 当文字打印了。
 *
 * 本脚本做两件事：
 *   ① 读页面 data，确认 games[].icon 是 key 而不是 emoji；
 *   ② 截图，肉眼确认按钮上渲染的是 SVG 图标 + 中文名。
 *
 * 用法：node .tooling/shot-room.js
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
  console.log('✓ 已连上模拟器')

  await mini.navigateTo('/pages/game/room/room')
  await new Promise(r => setTimeout(r, 2500))

  const page = await mini.currentPage()
  const data = await page.data()

  console.log('\n  ── 房间页入口数据 ──')
  console.log('  stage = ' + data.stage)
  ;(data.games || []).forEach(g => {
    console.log('  · k=' + g.k + '  icon=' + JSON.stringify(g.icon) + '  name=' + g.name)
  })

  /* 判据：icon 必须是 ASCII 的图标 key，不能是 emoji */
  const bad = (data.games || []).filter(g => !/^[a-zA-Z][\w]*$/.test(String(g.icon || '')))
  console.log('\n  ' + (bad.length === 0
    ? '✓ games[].icon 全部是图标 key（不是 emoji）'
    : '✗ 有 ' + bad.length + ' 个 icon 不是 key：' +
      bad.map(g => g.k + '=' + JSON.stringify(g.icon)).join(', ')))

  /* 实拍一张 */
  const shot = path.join(OUT, 'verify-room-entry.png')
  await mini.screenshot({ path: shot })
  console.log('  截图 → ' + path.relative(PROJECT, shot))

  await mini.close()
  process.exit(0)
})().catch(e => { console.error('失败:', e.message); process.exit(1) })
