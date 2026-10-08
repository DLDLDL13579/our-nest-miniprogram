/** 验证内联 SVG data URI 在小程序 image 组件里能否渲染 */
const automator = require('miniprogram-automator')
const path = require('path')

;(async () => {
  const mini = await automator.launch({
    cliPath: '/Applications/wechatwebdevtools.app/Contents/MacOS/cli',
    projectPath: path.join(__dirname, '..'),
    timeout: 90000
  })
  /* 在首页注入几个测试图标 */
  await mini.switchTab('/pages/index/index')
  await new Promise(r => setTimeout(r, 2000))
  const r = await mini.evaluate(async () => {
    const ic = require('/utils/icons.js')
    const out = []
    for (const n of ['dice', 'cup', 'mail', 'heart']) {
      const uri = ic.dataUri(n, '#E0714F')
      out.push({ name: n, len: uri.length, head: uri.slice(0, 40) })
    }
    return out
  })
  r.forEach(x => console.log(`  ${x.name.padEnd(8)} ${x.len} 字节  ${x.head}...`))
  console.log('\n  （若图标能在页面渲染出来，说明方案可行）')
  await mini.close()
  process.exit(0)
})().catch(e => { console.error('失败:', e.message); process.exit(1) })
