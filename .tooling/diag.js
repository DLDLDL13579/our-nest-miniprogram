/* 验证「复制诊断信息」真的能产出可用内容（用户报障的唯一通道） */
const automator = require('miniprogram-automator')
const ROOT = '/Users/meihaoshidai/Downloads/邓林work/个人项目/小程序'
const CLI = '/Applications/wechatwebdevtools.app/Contents/MacOS/cli'
const sleep = ms => new Promise(r => setTimeout(r, ms))
;(async () => {
  const mini = await automator.launch({ cliPath: CLI, projectPath: ROOT, timeout: 120000 })
  let ok = 0, bad = 0
  const rec = (name, pass, note) => { if (pass) { ok++; console.log('  ✓ ' + name + (note ? ' — ' + note : '')) } else { bad++; console.log('  ✗ ' + name + (note ? ' — ' + note : '')) } }
  try {
    await sleep(9000)
    await mini.switchTab('/pages/me/me').catch(() => {})
    await sleep(2500)
    const me = await mini.currentPage()
    const d = await me.data()
    rec('我的页加载', !!d, 'path=' + me.path)
    /* 直接调页面方法，拿它要写进剪贴板的内容 */
    /* 先手动写两条轨迹（模拟用户走过建房/开局），再验证诊断里带出来 */
    /* ⚠️ automator 的 evaluate 上下文**加载不了项目内的模块**（require 只对 node_modules 有效），
       所以这里直接写 storage —— 要验的是 copyDiag 会不会把轨迹带出来，不是 trace.add 本身。 */
    const seeded = await mini.evaluate(function () {
      try {
        const now = Date.now()
        wx.setStorageSync('traceLog', [
          { t: now - 8000, n: 'entry', note: 'liar' },
          { t: now - 5000, n: 'lobby', note: 'liar 3人' },
          { t: now - 2000, n: 'playing', note: 'liar 3人' }
        ])
        return (wx.getStorageSync('traceLog') || []).length
      } catch (e) { return '__ERR__ ' + e.message }
    })
    rec('trace 记录可写入', typeof seeded === 'number' && seeded >= 2, '共 ' + seeded + ' 条')

    /* ★ copyDiag 会先 await 一次数据库自检，再写剪贴板 —— 所以必须：
       ① 把捕获到的内容存到全局（evaluate 的局部变量返回后就没了）；
       ② 轮询等它异步完成。第一版同步取，拿到 0 字符，差点误判成"功能坏了"。 */
    await mini.evaluate(function () {
      const pages = getCurrentPages(); const p = pages[pages.length - 1]
      globalThis.__diagText = '__PENDING__'
      const orig = wx.setClipboardData
      wx.setClipboardData = function (o) {
        globalThis.__diagText = o.data
        if (o.success) o.success({})
        wx.setClipboardData = orig
      }
      try { p.copyDiag() } catch (e) { globalThis.__diagText = '__THREW__ ' + e.message }
    })
    let text = ''
    for (let i = 0; i < 30; i++) {
      await sleep(500)
      text = await mini.evaluate(function () { return globalThis.__diagText })
      if (text && text !== '__PENDING__') break
    }
    const s = String(text || '')
    rec('copyDiag 产出内容', s.length > 20, s.length + ' 字符')
    rec('含版本号', /版本: *3\.10\.\d+/.test(s), (s.match(/版本: *[\d.]+/) || [''])[0])
    rec('含机型/系统', /机型:/.test(s) && /系统:/.test(s))
    rec('含错误记录段', /错误记录|最近|无记录|暂无/.test(s))
    rec('含行为轨迹段', /轨迹（最近 \d+ 步）/.test(s) && /(entry|lobby|playing)/.test(s), (s.match(/轨迹（最近 \d+ 步）/) || [''])[0])
    console.log('\n  ── 内容前 5 行 ──')
    s.split('\n').slice(0, 5).forEach(l => console.log('  ' + l))
  } finally { await mini.close().catch(() => {}) }
  console.log('\n  共 ' + (ok + bad) + ' 项，失败 ' + bad)
  process.exit(bad ? 1 : 0)
})().catch(e => { console.error('失败:', e.message); process.exit(1) })
