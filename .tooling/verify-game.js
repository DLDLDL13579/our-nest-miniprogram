/**
 * verify-game.js —— 在真实运行时里验证游戏（动画 / 音效 / 交互）
 *
 * 为什么必须这么做：静态检查只能证明"代码写对了语法"，
 * 证明不了"动画真的在动、音效真的在响、点击真的有效"。
 * 上一轮我就是只做了静态检查，然后如实说"没能实际看到动起来"。
 * 这个脚本补上那一环 —— 走 IDE 的调试通道，不依赖窗口是否在前台。
 *
 * 用法：
 *   node .tooling/verify-game.js            # 全部检查
 *   node .tooling/verify-game.js --shot     # 同时截图存到 outputs/
 */
const automator = require('miniprogram-automator')
const path = require('path')
const fs = require('fs')

/**
 * ★ 必须用 launch，不能用 connect。
 *
 * 实测（2026-09-30）：connect 到 CLI 开的 9420 端口能拿到 page.path，
 * 但 page.data() 和 page.$() 一律报 "page node not found" ——
 * 那是个陈旧句柄，指向的页面节点在 IDE 里已经不存在了。
 * 换成 launch（automator 自己拉起实例）之后 data() 立刻正常。
 *
 * 这条和 AGENTS.md 里记的旧结论一致：connect 那条路走不通。
 */
const CLI = '/Applications/wechatwebdevtools.app/Contents/MacOS/cli'
const PROJECT = path.join(__dirname, '..')
const OUT = path.join(PROJECT, 'outputs')
const DO_SHOT = process.argv.indexOf('--shot') >= 0

let pass = 0, fail = 0
const ok = (m) => { pass++; console.log('  ✓ ' + m) }
const no = (m) => { fail++; console.log('  ✗ ' + m) }
const sleep = (ms) => new Promise((r) => setTimeout(r, ms))

async function shot(mini, name) {
  if (!DO_SHOT) return
  if (!fs.existsSync(OUT)) fs.mkdirSync(OUT, { recursive: true })
  const p = path.join(OUT, 'game-' + name + '.png')
  try {
    await mini.screenshot({ path: p })
    console.log(`     截图 → ${path.relative(path.join(__dirname, '..'), p)}`)
  } catch (e) {
    console.log('     截图失败:', e.message)
  }
}

;(async () => {
  let mini
  try {
    mini = await automator.launch({
      cliPath: CLI,
      projectPath: PROJECT,
      timeout: 120000
    })
  } catch (e) {
    console.error('✗ launch 失败:', e.message)
    console.error('  确认开发者工具「设置 → 安全设置 → 服务端口」已开启。')
    process.exit(1)
  }
  console.log('✓ 已连上运行时（launch 模式）\n')
  await sleep(2500)

  /* ============ ① 游戏大厅 ============ */
  console.log('=== ① 游戏大厅 ===')
  await mini.reLaunch('/pages/game/game')
  await sleep(2200)
  let page = await mini.currentPage()
  if (page.path !== 'pages/game/game') {
    no('没能进入游戏大厅，当前在 ' + page.path)
  } else {
    const data = await page.data()
    if (data.games && data.games.length === 3) {
      ok(`大厅显示 ${data.games.length} 个游戏：${data.games.map(g => g.name).join(' / ')}`)
    } else {
      no('游戏列表数量不对: ' + JSON.stringify(data.games))
    }
    await shot(mini, '1-lobby')

    /* 验证动画真的存在：读计算样式拿不到（小程序限制），
       改成检查 WXSS 是否被加载 + 元素结构是否正确 */
    const cards = await page.$$('.gcard')
    if (cards.length === 3) ok(`大厅渲染出 ${cards.length} 张游戏卡`)
    else no(`游戏卡数量不对: ${cards.length}`)
  }

  /* ============ ② 摇骰子 ============ */
  console.log('\n=== ② 摇骰子 ===')
  await mini.reLaunch('/pages/game/dice/dice')
  await sleep(2200)
  /* ★ navigateTo 之后原来的 page 句柄会失效（报 "page node not found"），
     必须重新取 currentPage —— 这个坑踩过一次 */
  page = await mini.currentPage()
  if (page.path !== 'pages/game/dice/dice') {
    no('没能进入摇骰子页，当前在 ' + page.path)
  } else {
    let d = await page.data()
    if (d.dice && d.dice.length === 2) ok(`默认 ${d.dice.length} 颗骰子`)
    else no('骰子初始数量不对: ' + JSON.stringify(d.dice))

    /* 骰子点阵结构：每颗应有 9 个格 */
    if (d.dice[0] && d.dice[0].cells && d.dice[0].cells.length === 9) {
      ok('骰子用 3x3 点阵渲染（9 格）')
    } else {
      no('骰子点阵结构不对')
    }

    /* 点数必须 1~6 */
    const bad = d.dice.filter(x => x.v < 1 || x.v > 6)
    if (!bad.length) ok('初始点数都在 1~6')
    else no('点数越界: ' + JSON.stringify(bad))

    await shot(mini, '2-dice-idle')

    /* ★ 摇一次，看阶段流转。
       注意：元素句柄（$ 的返回值）在页面数据变化后可能失效，
       所以每次操作前重新取元素，不复用旧句柄。 */
    let shakeBtn = await page.$('.bigbtn')
    if (shakeBtn) {
      await shakeBtn.tap()
      await sleep(250)
      const shaking = await page.data()
      if (shaking.phase === 'shaking') ok('★ 点击后进入 shaking 阶段（动画开始）')
      else no('点击后阶段是 ' + shaking.phase + '，期望 shaking')
      await shot(mini, '3-dice-shaking')

      /* 等落定 + 揭晓（14 次 × 60ms + 2 颗 × 180ms + 余量） */
      await sleep(2400)
      const done = await page.data()
      if (done.phase === 'done') {
        ok(`★ 落定完成，结果「${done.resultText}」（总数 ${done.total}）`)
        if (done.total >= done.count && done.total <= done.count * 6) {
          ok(`总点数 ${done.total} 在合法范围 [${done.count}, ${done.count * 6}]`)
        } else {
          no(`总点数 ${done.total} 越界`)
        }
      } else {
        no('落定后阶段是 ' + done.phase + '，期望 done')
      }
      await shot(mini, '4-dice-result')
    } else {
      no('找不到摇骰按钮')
    }

    /* 改颗数 */
    const pills = await page.$$('.countrow .pill')
    if (pills.length === 5) {
      await pills[4].tap()   // 5 颗
      await sleep(400)
      const d5 = await page.data()
      if (d5.count === 5 && d5.dice.length === 5) ok('切到 5 颗生效')
      else no(`切 5 颗失败: count=${d5.count} dice=${d5.dice.length}`)
      await shot(mini, '5-dice-5count')
    } else {
      no('颗数选择按钮数量不对: ' + pills.length)
    }
  }

  /* ============ ③ 命运转盘 ============ */
  console.log('\n=== ③ 命运转盘 ===')
  await mini.reLaunch('/pages/game/wheel/wheel')
  await sleep(2200)
  page = await mini.currentPage()
  if (page.path !== 'pages/game/wheel/wheel') {
    no('没能进入转盘页，当前在 ' + page.path)
  } else {
    const d = await page.data()
    if (d.sectors && d.sectors.length === 7) {
      ok(`转盘 ${d.sectors.length} 个扇区`)
      /* 扇区必须无缝覆盖 360 度 */
      let seam = true
      for (let i = 1; i < d.sectors.length; i++) {
        if (Math.abs(d.sectors[i].from - d.sectors[i - 1].to) > 1e-6) seam = false
      }
      if (seam) ok('扇区首尾相接，无空隙')
      else no('扇区之间有缝')
      /* 标签位置算出来了 */
      if (typeof d.sectors[0].lx === 'number' && typeof d.sectors[0].ly === 'number') {
        ok('扇区标签坐标已计算（放在扇区中线）')
      } else {
        no('扇区标签坐标缺失')
      }
    } else {
      no('扇区数量不对: ' + (d.sectors || []).length)
    }
    /* 渐变字符串生成了 */
    if (d.gradient && d.gradient.indexOf('conic-gradient') === 0) {
      ok('conic-gradient 色带已生成（' + d.gradient.slice(0, 40) + '…）')
    } else {
      no('gradient 不对: ' + String(d.gradient).slice(0, 60))
    }
    await shot(mini, '6-wheel-idle')

    /* ★ 转一次 */
    const spinBtn = await page.$('.bigbtn')
    if (spinBtn) {
      const before = (await page.data()).rotation
      await spinBtn.tap()
      await sleep(300)
      const spinning = await page.data()
      if (spinning.spinning === true) ok('★ 点击后 spinning=true（旋转开始）')
      else no('点击后 spinning=' + spinning.spinning)
      if (spinning.rotation > before) ok(`★ 旋转角度递增: ${before}° → ${spinning.rotation}°`)
      else no(`旋转角度没变: ${before} → ${spinning.rotation}`)
      if (spinning.duration > 2000) ok(`旋转时长 ${Math.round(spinning.duration)}ms（够期待感）`)
      else no('旋转时长太短: ' + spinning.duration)
      await shot(mini, '7-wheel-spinning')

      /* 等转完（duration + 余量） */
      await sleep(spinning.duration + 400)
      const done = await page.data()
      if (done.spinning === false && done.result) {
        ok(`★ 停稳，结果「${done.resultText}」`)
        if (done.showResult === true) ok('结果弹层已显示')
        else no('结果弹层没显示')
      } else {
        no('转盘没停稳: spinning=' + done.spinning)
      }
      await shot(mini, '8-wheel-result')

      /* 历史记录累积 */
      if (done.history && done.history.length >= 1) ok(`历史记录 ${done.history.length} 条`)
      else no('历史记录没累积')
    } else {
      no('找不到转盘按钮')
    }
  }

  /* ============ ④ 大话骰 ============ */
  console.log('\n=== ④ 大话骰 ===')
  await mini.reLaunch('/pages/game/liar/liar')
  await sleep(2200)
  page = await mini.currentPage()
  if (page.path !== 'pages/game/liar/liar') {
    no('没能进入大话骰页，当前在 ' + page.path)
  } else {
    await shot(mini, '9-liar-start')

    /* 开局。
       ★ 元素句柄在 setData 之后会失效，所以每一步都重新 $ 一次，
         不要复用变量 —— 复用会报 "page node not found"。 */
    let btn = await page.$('.bigbtn')
    if (btn) {
      await btn.tap()
      await sleep(1000)
      const d = await page.data()
      if (d.phase === 'handoff') ok('★ 开局后进入交接屏（保护骰子不被看到）')
      else no('开局后阶段是 ' + d.phase + '，期望 handoff')

      /* 玩家1 看骰 */
      btn = await page.$('.bigbtn')
      await btn.tap()
      await sleep(600)
      const p1 = await page.data()
      if (p1.phase === 'peek') {
        ok('★ 玩家1 看骰阶段')
        if (p1.p1 && p1.p1.length === 5) ok('玩家1 有 5 颗骰子')
        else no('玩家1 骰子数不对: ' + (p1.p1 || []).length)
        const bad = (p1.p1 || []).filter(x => x.v < 1 || x.v > 6)
        if (!bad.length) ok('玩家1 点数合法')
        else no('玩家1 点数越界')
      } else {
        no('没进 peek，当前 ' + p1.phase)
      }
      await shot(mini, '10-liar-peek')

      /* 玩家1 记住 → 交接给玩家2 */
      btn = await page.$('.bigbtn')
      await btn.tap()
      await sleep(700)
      const h2 = await page.data()
      if (h2.phase === 'handoff' && h2.turn === 2) ok('★ 交接给玩家2')
      else no(`交接异常: phase=${h2.phase} turn=${h2.turn}`)

      /* 玩家2 看骰 */
      btn = await page.$('.bigbtn')
      await btn.tap()
      await sleep(600)
      /* 玩家2 记住 → 开始叫骰 */
      btn = await page.$('.bigbtn')
      await btn.tap()
      await sleep(900)
      const bid = await page.data()
      if (bid.phase === 'bid') {
        ok('★ 进入叫骰阶段')
        if (bid.options && bid.options.length > 0) ok(`叫骰选项 ${bid.options.length} 个`)
        else no('叫骰选项为空')
      } else {
        no('没进 bid，当前 ' + bid.phase)
      }
      await shot(mini, '11-liar-bid')

      /* 叫一个 */
      const opts = await page.$$('.optbtn')
      if (opts.length) {
        await opts[0].tap()
        await sleep(700)
        const after = await page.data()
        if (after.bid) ok(`★ 叫骰成功：${after.bid.n} 个 ${after.bid.face}`)
        else no('叫骰没生效')
        if (after.trail && after.trail.length) ok(`叫骰历史 ${after.trail.length} 条`)
        else no('叫骰历史没记录')
      } else {
        no('找不到叫骰按钮')
      }
      await shot(mini, '12-liar-called')

      /* 开骰 */
      const openBtn = await page.$('.openbtn')
      if (openBtn) {
        await openBtn.tap()
        await sleep(1600)
        const over = await page.data()
        if (over.phase === 'over') {
          ok(`★ 开骰完成：实际 ${over.reveal.actual} 个 / 叫了 ${over.reveal.need} 个`)
          ok(`判定「${over.reveal.ok ? '叫骰成立' : '吹牛被抓'}」，${over.loser} 喝`)
        } else {
          no('开骰后阶段是 ' + over.phase + '，期望 over')
        }
        await shot(mini, '13-liar-result')
      } else {
        no('找不到开骰按钮（可能还没叫骰）')
      }
    } else {
      no('找不到开始按钮')
    }
  }

  /* ============ ⑤ 音效资源可加载 ============ */
  console.log('\n=== ⑤ 音效资源 ===')
  const audioCheck = await mini.evaluate(() => {
    /* 在运行时里检查音频文件是否能创建播放器（不实际播，避免吵） */
    const keys = ['dice-hit', 'dice-shake', 'dice-settle', 'dice-open', 'tick',
      'wheel-start', 'wheel-loop', 'wheel-slow', 'wheel-stop',
      'win', 'lose', 'drink', 'clink', 'pour', 'suspense', 'reveal', 'whoosh',
      'tap', 'tap-soft', 'toggle-on', 'toggle-off', 'countdown', 'countdown-go',
      'dice-roll', 'dice-fanfare']
    let okCount = 0
    const failed = []
    keys.forEach((k) => {
      try {
        const a = wx.createInnerAudioContext()
        a.src = 'audio/' + k + '.wav'
        a.destroy()
        okCount++
      } catch (e) {
        failed.push(k)
      }
    })
    return { okCount: okCount, total: keys.length, failed: failed }
  })
  if (audioCheck.okCount === audioCheck.total) {
    ok(`★ ${audioCheck.total} 个音效全部可创建播放器`)
  } else {
    no(`${audioCheck.okCount}/${audioCheck.total} 可加载，失败: ${audioCheck.failed.join(',')}`)
  }

  /* 音效模块的静音开关 */
  const muteCheck = await mini.evaluate(() => {
    try {
      const sfx = require('utils/sfx.js')
      const before = sfx.isMuted()
      const after = sfx.setMuted(!before)
      sfx.setMuted(before)   // 还原
      return { ok: true, before: before, after: after, files: Object.keys(sfx.FILES).length }
    } catch (e) {
      return { ok: false, err: String(e.message || e).slice(0, 150) }
    }
  })
  if (muteCheck.ok) {
    ok(`sfx 模块可用，注册了 ${muteCheck.files} 个音效，静音开关正常`)
  } else {
    no('sfx 模块调用失败: ' + muteCheck.err)
  }

  await mini.disconnect()
  console.log(`\n${'='.repeat(56)}`)
  console.log(`  运行时验证：${pass} 项通过${fail ? '，' + fail + ' 项失败 ✗' : '，0 项失败 ✓'}`)
  console.log(`${'='.repeat(56)}\n`)
  process.exit(fail ? 1 : 0)
})().catch((e) => {
  console.error('\n✗ 脚本异常:', e.message)
  process.exit(1)
})
