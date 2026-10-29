/* 体验时间轴：每一步从"点击"到"界面真的变了"要多久 */
const automator = require('miniprogram-automator')
const ROOT = '/Users/meihaoshidai/Downloads/邓林work/个人项目/小程序'
const CLI = '/Applications/wechatwebdevtools.app/Contents/MacOS/cli'
const sleep = ms => new Promise(r => setTimeout(r, ms))
const rows = []
/* 轮询直到条件成立，返回耗时（含一次 data() 的开销，约 30~80ms） */
async function until(page, cond, maxMs) {
  const t0 = Date.now()
  while (Date.now() - t0 < (maxMs || 8000)) {
    const d = await page.data()
    if (cond(d)) return { ms: Date.now() - t0, d }
    await sleep(40)
  }
  return { ms: Date.now() - t0, d: await page.data(), timeout: true }
}
const rec = (name, r, note) => {
  rows.push({ name, ms: r.ms, timeout: !!r.timeout })
  console.log('  ' + (r.timeout ? '✗' : '·') + ' ' + name.padEnd(22) + String(r.ms).padStart(5) + 'ms ' + (note || ''))
}
;(async () => {
  const mini = await automator.launch({ cliPath: CLI, projectPath: ROOT, timeout: 120000 })
  try {
    await sleep(9000)
    let page = await mini.currentPage()
    let d = await page.data()
    const idx = (d.list || []).findIndex(g => g.id === 'liar')
    const cards = await page.$$('.gcard')
    // ① 点卡片 → 建房
    let t = await (async () => {
      const t0 = Date.now()
      await cards[idx].tap()
      const p = await mini.currentPage()
      const r = await until(p, x => x.stage === 'lobby' && x.room && x.room.code, 15000)
      return { ms: Date.now() - t0, timeout: r.timeout }
    })()
    page = await mini.currentPage()
    rec('点卡片 → 房间号出现', t)
    // ② 点开始 → countdown
    let btn = await page.$('.bigbtn')
    t = await (async () => {
      const t0 = Date.now(); await btn.tap()
      const r = await until(page, x => x.stage === 'countdown', 8000)
      return { ms: Date.now() - t0, timeout: r.timeout }
    })()
    rec('点开始 → 倒计时出现', t)
    // ③ 倒计时 → playing（3 秒是设计值）
    const r3 = await until(page, x => x.stage === 'playing', 12000)
    rec('倒计时 → 进入游戏', { ms: r3.ms }, '（含 3 秒设计倒计时）')
    // ④ 按住骰盅 → 骰子出现（纯前端，应该极快）
    const cup = await page.$('.cs-cup')
    if (cup) {
      t = await (async () => {
        const t0 = Date.now(); await cup.touchstart()
        const r = await until(page, x => x.diceShown === true, 3000)
        await cup.touchend()
        return { ms: Date.now() - t0, timeout: r.timeout }
      })()
      rec('按住骰盅 → 看到骰子', t, '（纯前端）')
    }
    // ⑤ 点叫骰 → 云端返回 + 界面更新
    await sleep(400)
    const opt = await page.$('.optbtn')
    if (opt) {
      t = await (async () => {
        const t0 = Date.now(); await opt.tap()
        const r = await until(page, x => x.room && x.room.bid && x.room.bid.n, 10000)
        return { ms: Date.now() - t0, timeout: r.timeout }
      })()
      rec('点叫骰 → 叫骰结果出现', t, '（含云函数往返）')
    }
    // ⑥ 点开 → 结算出现
    const openBtn = await page.$('.openbtn')
    if (openBtn) {
      t = await (async () => {
        const t0 = Date.now(); await openBtn.tap()
        const r = await until(page, x => x.stage === 'over', 12000)
        return { ms: Date.now() - t0, timeout: r.timeout }
      })()
      rec('点开骰 → 结算出现', t, '（含开盅动画）')
    }
    const bad = rows.filter(r => r.timeout)
    console.log('\n  共 ' + rows.length + ' 步，超时 ' + bad.length + ' 步')
  } finally { await mini.close().catch(() => {}) }
})().catch(e => { console.error('失败:', e.message); process.exit(1) })
