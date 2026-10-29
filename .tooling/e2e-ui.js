/**
 * e2e-ui.js —— **UI 层**端到端验证：从点击到界面更新
 *
 * 之前所有真实测试都是直接调云函数（repro-bid / repro-all），验证的是"服务端对不对"。
 * 但用户报障时看到的是**界面**：点了按钮，界面没动 ——
 * 这条链路（tap → 页面方法 → 云函数 → decorate → setData → 视图）从来没被真机验证过。
 *
 * 用法：node .tooling/e2e-ui.js
 */
const automator = require('miniprogram-automator')
const path = require('path')
const ROOT = path.resolve(__dirname, '..')
const CLI = '/Applications/wechatwebdevtools.app/Contents/MacOS/cli'
const sleep = ms => new Promise(r => setTimeout(r, ms))

const steps = []
const rec = (name, ok, extra) => {
  steps.push({ name, ok, extra: extra || '' })
  console.log((ok ? '  ✓ ' : '  ✗ ') + name + (extra ? ' — ' + extra : ''))
}

;(async () => {
  console.log('启动小程序运行时…')
  const mini = await automator.launch({ cliPath: CLI, projectPath: ROOT, timeout: 120000 })
  try {
    await sleep(9000)

    /* ① 首页 */
    let page = await mini.currentPage()
    let d = await page.data()
    rec('进入大厅', page.path.indexOf('lobby') >= 0, 'path=' + page.path + ' 玩法数=' + (d.list || []).length)

    /* ② 点第一张玩法卡 → 应该建房并跳到房间页 */
    const card = await page.$('.gcard')
    if (!card) { rec('找到玩法卡', false); return }
    await card.tap()
    /*
     * ★ 逐秒采样 stage：区分「慢」和「卡死」。
     *   用户报过"一直在正在进入房间"——那种情况下 stage 会永远停在 entry，
     *   而只是冷启动慢的话几秒内会跳到 lobby。
     */
    const trace = []
    let roomOK = false
    for (let i = 0; i < 20; i++) {
      await sleep(1000)
      page = await mini.currentPage()
      d = await page.data()
      const tag = d.stage + (d.room && d.room.code ? '(' + d.room.code + ')' : '')
      if (trace[trace.length - 1] !== tag) trace.push(tag)
      if (d.stage === 'lobby' && d.room && d.room.code) { roomOK = true; break }
    }
    rec('点玩法卡 → 进入房间', page.path.indexOf('room') >= 0, 'path=' + page.path)
    rec('建房拿到房间号', roomOK, '轨迹: ' + trace.join(' → '))
    if (!roomOK) {
      const log = await mini.evaluate(async () => {
        try { return JSON.stringify((wx.getStorageSync('errLog') || []).slice(-3)) } catch (e) { return '[]' }
      })
      rec('失败时的错误记录', false, log)
      console.log('  ⚠ 建房未完成，后续步骤跳过')
      await mini.close().catch(() => {})
      process.exit(1)
    }

    /* ③ 点开始（单人测试开着，房主应能点） */
    const startBtn = await page.$('.bigbtn')
    if (!startBtn) { rec('找到开始按钮', false); return }
    await startBtn.tap()
    await sleep(2500)
    d = await page.data()
    rec('点开始 → 进入倒计时/游戏中', d.stage === 'countdown' || d.stage === 'playing', 'stage=' + d.stage)

    /* ④ 等倒计时结束（status 轮询推进），检查是否进 playing */
    await sleep(4500)
    d = await page.data()
    rec('倒计时结束 → 进入 playing', d.stage === 'playing', 'stage=' + d.stage + ' phase=' + (d.room && d.room.phase))

    /* ⑤ 大话骰：**必须先按住骰盅偷看**，否则点叫骰会被前置条件拦住
       （这是设计，不是 bug —— 第一版脚本漏了这步，看到"点了没反应"差点误判）。 */
    const cup = await page.$('.cs-cup')
    if (cup) {
      await cup.touchstart()
      await sleep(450)
      const peeked = await page.data()
      rec('按住骰盅 → 偷看到自己的骰子', peeked.diceShown === true, 'diceShown=' + peeked.diceShown)
      await cup.touchend()
      await sleep(350)
    }

    /* ⑥ 点叫骰按钮 */
    const bidBtn = await page.$('.optbtn')
    if (bidBtn) {
      const label = await bidBtn.text()
      await bidBtn.tap()
      await sleep(2500)
      d = await page.data()
      const bidOk = !!(d.room && d.room.bid && d.room.bid.n)
      rec('点叫骰 → 界面出现叫骰结果', bidOk,
        'bid=' + (d.room && d.room.bid ? (d.room.bid.n + '个' + d.room.bid.face) : '无') + '（点了 ' + label + '）')
      const errs = (d.room && d.room.id) ? '' : ''
      if (!bidOk) {
        const log = await mini.evaluate(async () => {
          try { return JSON.stringify((wx.getStorageSync('errLog') || []).slice(-3)) } catch (e) { return '[]' }
        })
        rec('失败时的错误记录', false, log)
      }
    } else {
      rec('找到叫骰按钮', false, '（当前玩法可能不是大话骰）')
    }

    /* ⑧ 转盘：回大厅 → 建转盘房 → 开局 → 点「转！」→ 结果出现 */
    console.log('\n── 转盘 ──')
    await mini.navigateBack().catch(() => {})
    await sleep(2500)
    let lobby = await mini.currentPage()
    let ld = await lobby.data()
    if (!ld || !ld.list) { rec('回到大厅', false, 'path=' + lobby.path); }
    else {
      const idx = (ld.list || []).findIndex(g => g.id === 'wheel')
      const cards = await lobby.$$('.gcard')
      if (idx < 0 || !cards[idx]) {
        rec('找到转盘卡片', false, 'list=' + (ld.list || []).map(g => g.id).join(','))
      } else {
        await cards[idx].tap()
        let wheelOK = false
        let wp = null
        for (let i = 0; i < 20; i++) {
          await sleep(1000)
          wp = await mini.currentPage()
          const wd = await wp.data()
          if (wd.stage === 'lobby' && wd.room && wd.room.code) { wheelOK = true; break }
        }
        rec('点转盘卡 → 建房成功', wheelOK)
        if (wheelOK) {
          const startBtn2 = await wp.$('.bigbtn')
          if (startBtn2) { await startBtn2.tap(); await sleep(2000) }
          let wd2 = await wp.data()
          for (let i = 0; i < 8 && wd2.stage !== 'playing'; i++) {
            await sleep(1200); wd2 = await wp.data()
          }
          rec('转盘开局 → playing', wd2.stage === 'playing', 'stage=' + wd2.stage)
          /* 点「转！」 */
          const spinBtns = await wp.$$('.bigbtn')
          const spinBtn = spinBtns.length ? spinBtns[spinBtns.length - 1] : null
          if (spinBtn) {
            await spinBtn.tap()
            await sleep(1200)
            let mid = await wp.data()
            rec('点「转！」→ 立即进入转动状态', mid.wheelSpinning === true, 'wheelText=' + mid.wheelText)
            await sleep(3200)
            const after = await wp.data()
            const done = !after.wheelSpinning && !!after.wheelText && after.wheelText !== '转起来了…'
            rec('转完 → 出现具体结果', done, '结果=' + after.wheelText + (after.card ? ' · 题目: ' + after.card.text : ''))
          } else {
            rec('找到「转！」按钮', false)
          }
        }
      }
    }

    const bad = steps.filter(s => !s.ok)
    console.log('\n════ 汇总 ════')
    console.log('  ' + steps.length + ' 步，失败 ' + bad.length)
    if (!bad.length) console.log('  ✓ UI 链路全部通过：点击 → 建房 → 开局 → 叫骰 → 界面更新')
    process.exitCode = bad.length ? 1 : 0
  } finally {
    await mini.close().catch(() => {})
  }
})().catch(e => { console.error('✗ 脚本失败：', (e && e.stack) || e); process.exit(1) })
