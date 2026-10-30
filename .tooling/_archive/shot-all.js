/**
 * shot-all.js —— 逐页截图，用于画面审查。
 * 用法：node .tooling/shot-all.js <页面路径> [输出名]
 */
const automator = require('miniprogram-automator')
const path = require('path')
const fs = require('fs')

const target = process.argv[2] || '/pages/index/index'
const name = process.argv[3] || (target.split('/').filter(Boolean).pop() || 'shot')

;(async () => {
  const mini = await automator.launch({
    cliPath: '/Applications/wechatwebdevtools.app/Contents/MacOS/cli',
    projectPath: path.join(__dirname, '..'),
    timeout: 90000
  })
  console.log('✓ 已连上')
  /* tabBar 页要 switchTab，其它用 navigateTo */
  const TABS = ['/pages/index/index', '/pages/chronicle/chronicle',
                '/pages/wishes/wishes', '/pages/mood/mood']
  if (TABS.includes(target)) await mini.switchTab(target)
  else await mini.navigateTo(target)
  await new Promise(r => setTimeout(r, 2500))

  const out = path.join(__dirname, '..', 'outputs', name + '.png')
  await mini.screenshot({ path: out })
  console.log('✓ 已截图 →', out)
  await mini.close()
  process.exit(0)
})().catch(e => { console.error('失败:', e.message); process.exit(1) })
