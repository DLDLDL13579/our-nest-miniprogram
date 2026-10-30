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

    /* ② 点**大话骰**那张卡 → 建房并跳到房间页
       ⚠️ 不能取第一张：大厅会把"上次玩的"置顶，顺序不固定 ——
       第一版就踩了，第二次跑时第一张变成了别的玩法，脚本误报"找不到叫骰按钮"。 */
    const liarIdx = (d.list || []).findIndex(g => g.id === 'liar')
    const gcards = await page.$$('.gcard')
    const card = liarIdx >= 0 ? gcards[liarIdx] : null
    if (!card) { rec('找到大话骰卡片', false, 'list=' + (d.list || []).map(g => g.id).join(',')); return }
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
      /* ★ 顺带验证「开骰 → 再来一局」的状态重置
         （AGENTS.md 记过两次"重开一局漏清字段"：stage 手写死、spin 没清） */
      if (bidOk) {
        const openBtn = await page.$('.openbtn')
        if (openBtn) {
          await openBtn.tap()
          await sleep(3000)
          const od = await page.data()
          rec('点「开」→ 本局结束（over）', od.stage === 'over', 'stage=' + od.stage)

          const againBtn = await page.$('.bigbtn')
          if (againBtn) {
            await againBtn.tap()
            await sleep(3000)
            const ld3 = await page.data()
            const cleared = ld3.stage === 'lobby' && ld3.room && !(ld3.room.bid && ld3.room.bid.n) && !ld3.room.lastResult
            rec('点「再来一局」→ 回大厅且局内状态清空', cleared,
              'stage=' + ld3.stage + ' bid=' + JSON.stringify(ld3.room && ld3.room.bid) + ' lastResult=' + JSON.stringify(ld3.room && ld3.room.lastResult))

            /*
             * ★ 第二局要**真的能玩**（2026-10-30）。
             *   "回到大厅、字段清空"只是必要不充分 —— 真实玩家会连开好几局，
             *   而"重开一局"最容易出的是**状态残留导致第二局一步都动不了**
             *   （项目史上两次：stage 手写死、spin 没清）。
             *   所以这里再走一遍：开局 → 按住偷看 → 叫骰。
             */
            const startBtn2 = await page.$('.bigbtn')
            if (startBtn2) {
              await startBtn2.tap()
              await sleep(2000)
              let d2 = await page.data()
              for (let i = 0; i < 8 && d2.stage !== 'playing'; i++) { await sleep(1200); d2 = await page.data() }
              rec('第二局能开局', d2.stage === 'playing', 'stage=' + d2.stage)
              const cup2 = await page.$('.cs-cup')
              if (cup2) {
                await cup2.touchstart(); await sleep(700)
                const dp2 = await page.data()
                rec('第二局按住骰盅能看到骰子', dp2.diceShown === true, 'diceShown=' + dp2.diceShown)
                await cup2.touchend(); await sleep(500)
              }
              const opt2 = await page.$('.optbtn')
              if (opt2) {
                await opt2.tap(); await sleep(3000)
                const db2 = await page.data()
                rec('第二局能叫骰', !!(db2.room && db2.room.bid && db2.room.bid.n),
                  'bid=' + JSON.stringify(db2.room && db2.room.bid))
              } else {
                rec('第二局找到叫骰选项', false)
              }
            } else {
              rec('第二局找到开始按钮', false)
            }
          }
        } else {
          rec('找到「开」按钮', false)
        }
      }

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

    /* ⑨ 比大小：摇骰 → 单人局摇完立刻结算 */
    console.log('\n── 比大小 ──')
    await mini.navigateBack().catch(() => {})
    await sleep(2500)
    const lob3 = await mini.currentPage()
    const ld3 = await lob3.data()
    const dIdx = ((ld3 && ld3.list) || []).findIndex(g => g.id === 'dice')
    const cards3 = await lob3.$$('.gcard')
    if (dIdx < 0 || !cards3[dIdx]) {
      rec('找到比大小卡片', false, 'list=' + ((ld3 && ld3.list) || []).map(g => g.id).join(','))
    } else {
      await cards3[dIdx].tap()
      let dp = null
      for (let i = 0; i < 20; i++) {
        await sleep(1000)
        dp = await mini.currentPage()
        const dd = await dp.data()
        if (dd.stage === 'lobby' && dd.room && dd.room.code) break
      }
      const startBtn4 = await dp.$('.bigbtn')
      if (startBtn4) { await startBtn4.tap(); await sleep(2000) }
      let dd2 = await dp.data()
      for (let i = 0; i < 8 && dd2.stage !== 'playing'; i++) { await sleep(1200); dd2 = await dp.data() }
      rec('比大小开局 → playing', dd2.stage === 'playing', 'stage=' + dd2.stage)

      /* 点摇骰（单人局：摇完即全员摇完，应立刻结算） */
      const rollBtns = await dp.$$('.bigbtn')
      const rollBtn = rollBtns.length ? rollBtns[rollBtns.length - 1] : null
      if (!rollBtn) { rec('找到摇骰按钮', false) }
      else {
        await rollBtn.tap()
        await sleep(1200)
        let rd = await dp.data()
        rec('点摇盅 → 摇出自己的骰子', !!(rd.myDice && rd.myDice.length),
          '骰子=' + JSON.stringify(rd.myDice))
        await sleep(3000)
        rd = await dp.data()
        rec('单人局摇完 → 立刻结算', rd.stage === 'over', 'stage=' + rd.stage)
      }
    }

    /* ⑩ 金花：确认卡（把 wx.showModal 换成页面内之后，automator 才点得到） */
    console.log('\n── 金花 ──')
    await mini.navigateBack().catch(() => {})
    await sleep(2500)
    const lob2 = await mini.currentPage()
    const ld2 = await lob2.data()
    const pIdx = ((ld2 && ld2.list) || []).findIndex(g => g.id === 'poker')
    const cards2 = await lob2.$$('.gcard')
    if (pIdx < 0 || !cards2[pIdx]) {
      rec('找到金花卡片', false, 'list=' + ((ld2 && ld2.list) || []).map(g => g.id).join(','))
    } else {
      await cards2[pIdx].tap()
      let pkRoom = null
      for (let i = 0; i < 20; i++) {
        await sleep(1000)
        pkRoom = await mini.currentPage()
        const dd = await pkRoom.data()
        if (dd.stage === 'lobby' && dd.room && dd.room.code) break
      }
      const startBtn3 = await pkRoom.$('.bigbtn')
      if (startBtn3) { await startBtn3.tap(); await sleep(2000) }
      let pd = await pkRoom.data()
      for (let i = 0; i < 8 && pd.stage !== 'playing'; i++) { await sleep(1200); pd = await pkRoom.data() }
      rec('金花开局 → playing', pd.stage === 'playing', 'stage=' + pd.stage)

      /* 点「算了，我弃牌」→ 应该弹出页面内确认卡（而不是系统弹窗） */
      const foldBtn = await pkRoom.$('.pk-fold')
      if (!foldBtn) { rec('找到弃牌按钮', false) }
      else {
        await foldBtn.tap()
        await sleep(900)
        let ad = await pkRoom.data()
        rec('点弃牌 → 弹出页面内确认卡', !!(ad.pkAsk && ad.pkAsk.kind === 'fold'),
          'pkAsk=' + JSON.stringify(ad.pkAsk))

        /* 点「再想想」→ 关掉，不生效 */
        const noBtn = await pkRoom.$('.pkask-btn.no')
        if (noBtn) {
          await noBtn.tap()
          await sleep(700)
          ad = await pkRoom.data()
          rec('点「再想想」→ 确认卡关闭且没弃牌', !ad.pkAsk && !(ad.room && ad.room.poker && ad.room.poker.folded),
            'pkAsk=' + JSON.stringify(ad.pkAsk))
        }

        /* 再来一次，点「弃牌」→ 真的弃掉 */
        const foldBtn2 = await pkRoom.$('.pk-fold')
        if (foldBtn2) {
          await foldBtn2.tap()
          await sleep(800)
          const yesBtn = await pkRoom.$('.pkask-btn.yes')
          if (yesBtn) {
            await yesBtn.tap()
            await sleep(2500)
            const fd = await pkRoom.data()
            rec('点「弃牌」→ 真的弃掉', !!(fd.room && fd.room.poker && fd.room.poker.folded),
              'folded=' + (fd.room && fd.room.poker ? fd.room.poker.folded : '?'))
          } else {
            rec('找到确认按钮', false)
          }
        }
      }
    }

    /* ⑩a 点房间号（2026-10-30 起：不再写剪贴板，改成弹"引导转发"）
       验证方法本身能执行、不抛异常即可 —— 弹层内容 automator 读不到。 */
    console.log('\n── 点房间号 ──')
    {
      const cp = await mini.currentPage()
      const cd0 = await cp.data()
      const code = cd0.room && cd0.room.code
      const okCall = await mini.evaluate(function () {
        const pages = getCurrentPages(); const p = pages[pages.length - 1]
        try {
          const orig = wx.showModal
          let called = false
          wx.showModal = function (o) { called = true; if (o && o.showCancel !== false) {} ; return }
          try { p.copyCode() } catch (e) { return '__THREW__ ' + e.message }
          wx.showModal = orig
          return called
        } catch (e) { return '__ERR__ ' + e.message }
      })
      rec('点房间号 → 弹出转发引导（不再依赖剪贴板）', okCall === true,
        'code=' + code + ' showModal=' + okCall)
    }

    /* ⑩b 离开房间的页面内确认卡（从系统弹窗换成页面内，改的是关键操作） */
    console.log('\n── 离开房间确认 ──')
    {
      const lp = await mini.currentPage()
      const leaveBtns = await lp.$$('.textbtn')
      /* 底部的「离开房间」是最后一个 textbtn（前面可能有"看规则"） */
      const leaveBtn = leaveBtns.length ? leaveBtns[leaveBtns.length - 1] : null
      if (!leaveBtn) { rec('找到离开房间按钮', false) }
      else {
        await leaveBtn.tap()
        await sleep(800)
        let ad = await lp.data()
        rec('点离开房间 → 弹页面内确认卡', ad.askLeave === true, 'askLeave=' + ad.askLeave)
        const noBtn = await lp.$('.pkask-btn.no')
        if (noBtn) {
          await noBtn.tap()
          await sleep(600)
          ad = await lp.data()
          rec('点「再想想」→ 留在房间里', ad.askLeave === false && !!ad.room,
            'askLeave=' + ad.askLeave + ' room=' + (ad.room ? ad.room.code : 'null'))
        } else {
          rec('找到「再想想」按钮', false)
        }
      }
    }

    /* ⑪ 分享链接直达：?code= 应自动进房（朋友点分享卡片的主要路径，一直没测过） */
    console.log('\n── 分享链接直达 ──')
    const curPage = await mini.currentPage()
    const curD = await curPage.data()
    const shareCode = curD && curD.room && curD.room.code
    if (!shareCode) {
      rec('取到当前房间号', false)
    } else {
      /*
       * ⚠️ 不能先 navigateBack 再带 code 进 —— 返回会触发本页 onUnload，
       *   而 onUnload 里会主动 leave 退出房间，于是"重进"的是一间我刚退掉的空房，
       *   join 必然失败（这是**测试设计**的问题，不是产品的）。
       * 这里直接叠加一个新页面实例：验证 onLoad 收到 ?code 后会自动 doJoin
       * 这条链路（同 openid 走 rejoined 分支）。
       */
      await mini.navigateTo('/game/room/room?code=' + shareCode).catch(e =>
        rec('navigateTo 带 code', false, e.message))
      await sleep(4500)
      const sp = await mini.currentPage()
      const sd = await sp.data()
      /* 只要求"进到了同一个房间且没报错"——房间可能正好处在 over/playing，
         不能死抠 stage === 'lobby'（第一版就这么写，把正常进房判成了失败）。 */
      rec('分享链接直达 → 自动进房', !!(sd.room && sd.room.code === shareCode && !sd.err),
        'code=' + (sd.room && sd.room.code) + ' stage=' + sd.stage + ' err=' + (sd.err || '无') +
        '（期望 code=' + shareCode + '）')
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
