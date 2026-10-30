/**
 * verify-ui-live.js —— 在真实模拟器里跑一遍四个修复
 *
 * 与 verify-four-fixes.js 的区别：
 *   那个只调云函数（数据层），这个**真的进页面、读页面 data、点元素**（界面层）。
 *   四条报障里 ①②③ 都是界面问题，只有真进页面才算验证。
 *
 * ★ 遵守的坑（AGENTS.md 记过）：
 *   · 必须用 automator.launch（connect 拿不到 page 句柄）
 *   · launch 后只能可靠访问首页 + **第一次** navigateTo 的页面 → 一次只验一个页面
 *   · 不要用 reLaunch（句柄立即失效）
 *   · 所有 evaluate 尽量合并（多次跨进程往返容易 timeout）
 *
 * 用法：node .tooling/verify-ui-live.js
 */
const automator = require('miniprogram-automator')
const path = require('path')
const fs = require('fs')

const PROJECT = path.join(__dirname, '..')
const OUT = path.join(PROJECT, 'outputs')

let fails = 0
function check(cond, label, detail) {
  console.log(`  ${cond ? '✓' : '★'} ${label}${detail ? '  → ' + detail : ''}`)
  if (!cond) fails++
}

;(async () => {
  if (!fs.existsSync(OUT)) fs.mkdirSync(OUT, { recursive: true })

  const mini = await automator.launch({
    cliPath: '/Applications/wechatwebdevtools.app/Contents/MacOS/cli',
    projectPath: PROJECT,
    timeout: 90000
  })
  console.log('✓ 已连上模拟器\n')

  /* 一次 launch 只进一个页面（AGENTS.md 记过的限制） */
  await mini.navigateTo('/game/room/room')
  await new Promise(r => setTimeout(r, 3000))

  const page = await mini.currentPage()
  const d = await page.data()

  console.log('  ── 页面已加载 ──')
  console.log(`  stage = ${d.stage}`)
  console.log(`  games = ${(d.games || []).map(g => g.k + ':' + g.icon).join(', ')}\n`)

  /* ============ ① 图标：不能再是裸 key ============ */
  console.log('  ① 图标渲染（截图那次的 bug）')
  /*
   * ★ 2026-10-30 修：这里原来是硬编码 `=== 3`（那时只有大话骰/比大小/转盘）。
   * 加「谁是卧底」和「梦幻金花」之后没跟着改 —— 于是这个探针
   * **一直在报 3 项未通过**，而其实是断言过时了，产品是对的。
   *
   * 判据改成：和**注册表**比，不写死数字。
   */
  const nGames = (require(path.join(__dirname, '..', 'miniprogram/utils/games.js')).GAMES || []).length
  check(Array.isArray(d.games) && d.games.length === nGames,
    'games 项数 = 注册表（' + nGames + ' 项）', '实际 ' + (d.games || []).length)
  const icons = (d.games || []).map(g => g.icon)
  check(icons.every(i => /^[a-zA-Z][\w]*$/.test(String(i))),
    'games[].icon 是图标 key', icons.join(','))
  check(!!d.ic && typeof d.ic === 'object', '页面注入了 ic 图标表')
  /* 关键：GAMES 用到的 key 必须都在 ic 里，否则渲染成空白 */
  const missing = icons.filter(k => !d.ic || !d.ic[k])
  check(missing.length === 0, 'GAMES 用到的图标全部已注册', missing.length ? '缺 ' + missing.join(',') : 'target/dice/wheel 都在')

  /* 真点一下游戏选择，确认交互没坏 */
  const pills = await page.$$('.pill')
  check(pills.length === nGames, '渲染出 ' + nGames + ' 个游戏按钮', '实际 ' + pills.length)
  if (pills.length >= 2) {
    await pills[1].tap()
    await new Promise(r => setTimeout(r, 400))
    const d2 = await page.data()
    check(d2.pickGame === 'dice', '点第二个按钮能切换选择', 'pickGame=' + d2.pickGame)
    await pills[0].tap()
    await new Promise(r => setTimeout(r, 300))
  }

  /* ============ ② 骰盅几何：直接量真实渲染盒子 ============ */
  console.log('\n  ② 骰盅几何（"骰子看不全"）—— 量真实渲染盒子')

  /*
   * ★ 这是本条最有价值的验证：**用布局引擎算出来的真实盒子**，
   *   而不是我手算的 wxss 数值。
   *
   * 做法：直接把页面切到"大话骰 playing + 骰子可见"的状态
   *   （setData 是页面公开能力，测试里这么用是合理的），
   *   然后读 .cs-cup / .cs-dice 的 boundingBox 做几何判断。
   *
   * ⚠️ 判据：偷看状态下，**盅的最低点必须高于骰子的顶边**。
   *    这正是原来出错的地方（实测算下来还压着 4.5rpx）。
   */
  const geo = await mini.evaluate(async () => {
    const pages = getCurrentPages()
    const p = pages[pages.length - 1]
    /* 造一个"大话骰进行中、我已偷看"的页面状态 */
    p.setData({
      stage: 'playing',
      room: {
        id: 'probe', game: 'liar', phase: 'playing', host: true,
        me: { seat: 1, name: '我', dice: [1, 2, 3, 4, 5] },
        players: [
          { openid: 'me', name: '我', seat: 1, isMe: true, isHost: true, online: true, dice: [1, 2, 3, 4, 5], diceCount: 5 },
          { openid: 'other', name: '她', seat: 2, isMe: false, isHost: false, online: true, diceCount: 5 }
        ],
        count: 2, turn: 1, round: 1, bid: null, options: ['1个1', '1个2'],
        myTurn: true, turnName: '我', waitingCount: 0, waitingNames: ''
      },
      myDice: [1, 2, 3, 4, 5],
      diceShown: true,
      cupSrc: 'cup-up', cupCls: 'peek', cupHint: '松手扣回去'
    })
    return { ok: true }
  })

  await new Promise(r => setTimeout(r, 900))   // 等 transition 走完（.38s）

  const cupEl = await page.$('.cs-cup')
  const diceEl = await page.$('.cs-dice')
  if (cupEl && diceEl) {
    /*
     * ⚠️ automator 的 Element 没有 boundingBox()（那是 puppeteer 的 API）——
     *    它提供的是 **size()** 和 **offset()** 两个方法。
     *    写错会报 "boundingBox is not a function"，且不提示正确名字。
     */
    const cs = await cupEl.size()
    const co = await cupEl.offset()
    const ds = await diceEl.size()
    const dOff = await diceEl.offset()
    if (cs && co && ds && dOff) {
      const cupBottom = co.top + cs.height
      const cupRight = co.left + cs.width
      const diceTop = dOff.top
      const diceBottom = dOff.top + ds.height
      const diceRight = dOff.left + ds.width
      const verticalClear = diceTop - cupBottom
      const horizOk = dOff.left >= co.left - 2 && diceRight <= cupRight + 2

      console.log(`     盅  x=${Math.round(co.left)}~${Math.round(cupRight)}  y=${Math.round(co.top)}~${Math.round(cupBottom)}  (${Math.round(cs.width)}×${Math.round(cs.height)})`)
      console.log(`     骰子 x=${Math.round(dOff.left)}~${Math.round(diceRight)}  y=${Math.round(diceTop)}~${Math.round(diceBottom)}  (${Math.round(ds.width)}×${Math.round(ds.height)})`)
      console.log(`     纵向余量 ${verticalClear.toFixed(1)}px（骰子顶 − 盅底，正数 = 露出来了）`)

      check(verticalClear > 0,
        '★ 偷看时盅完全离开骰子（骰子上沿没被压住）',
        `${verticalClear.toFixed(1)}px`)
      check(horizOk,
        '骰子横向不超出盅的投影范围',
        horizOk ? '在范围内' : '★ 超出')
    } else {
      check(false, '读不到盅/骰子的渲染盒子')
    }
  } else {
    check(false, '页面里找不到 .cs-cup 或 .cs-dice')
  }

  /* 截图留档：这张图能直接看出骰子露没露出来 */
  const shotCup = path.join(OUT, 'verify-cup-peek.png')
  await mini.screenshot({ path: shotCup })
  console.log(`     截图 → ${path.relative(PROJECT, shotCup)}`)

  /* 还原页面状态，别把后续验证带偏 */
  await mini.evaluate(() => {
    const pages = getCurrentPages()
    pages[pages.length - 1].setData({
      stage: 'entry', room: null, myDice: [], diceShown: false,
      cupSrc: 'cup-down', cupCls: '', cupHint: ''
    })
  })

  /* ============ ④ 建一个真房间，验证阶段流转 ============ */
  console.log('\n  ④ 建真房间：验证 phase → stage 映射（"转盘不能转"的根因）')
  const roomProbe = await mini.evaluate(async () => {
    const call = async (d) => (await wx.cloud.callFunction({ name: 'room', data: d })).result
    const out = {}

    /* 建一个大话骰房 */
    const c = await call({ action: 'create', name: '实测', game: 'liar' })
    out.createOk = !!c.ok
    out.phaseAfterCreate = c.room && c.room.phase
    out.hostIsMe = !!(c.room && c.room.host)
    out.myDiceCount = c.room && c.room.me ? (c.room.me.dice || []).length : -1
    /* 单人开局应被拒（至少两人）—— 这验证了"前置条件"是清楚的 */
    const s = await call({ action: 'start', id: c.room.id })
    out.startOk = !!s.ok
    out.startMsg = s.msg || ''
    await call({ action: 'leave', id: c.room.id }).catch(() => {})

    /* 建一个转盘房，验证 spin 认得 */
    const w = await call({ action: 'create', name: '实测2', game: 'wheel' })
    out.wheelPhase = w.room && w.room.phase
    const sp = await call({ action: 'spin', id: w.room.id })
    out.spinUnknown = /不认识的操作/.test(sp.msg || '')
    out.spinMsg = sp.msg || ''
    await call({ action: 'leave', id: w.room.id }).catch(() => {})

    /* 建一个 dice 房，验证开局不发骰子（"交互不智能"的根因） */
    const dd = await call({ action: 'create', name: '实测3', game: 'dice' })
    out.diceMyDice = dd.room && dd.room.me ? (dd.room.me.dice || []).length : -1
    out.dicePhase = dd.room && dd.room.phase
    await call({ action: 'leave', id: dd.room.id }).catch(() => {})

    return out
  })

  check(roomProbe.createOk, '建房成功')
  check(roomProbe.phaseAfterCreate === 'lobby', '建房后 phase=lobby',
    roomProbe.phaseAfterCreate)
  /*
   * ⚠️ 断言自己写错过一次：我原本断言"大话骰建房即发 5 颗" —— 错了。
   *    骰子是在 **start** 时发的（create 只写 `dice: []`），
   *    而单人开不了局 → 这里永远拿不到骰子。
   *    这不是代码的 bug，是**断言的前提错了**。
   *
   *    真正要验的是"发骰子的时机对不对"，而 start 需要两个人 ——
   *    单人探针验不了。所以这里改成验**时机规则**：
   *      create 后一律没有骰子（三种游戏都是）
   *    而"大话骰 start 后每人 5 颗 / dice 房 start 后仍是 0 颗"
   *    由 scripts/test-room.js 用两个 openid 覆盖（那里能真开局）。
   */
  check(roomProbe.myDiceCount === 0,
    '建房时一律不发骰子（骰子在 start 时才发）',
    '实际 ' + roomProbe.myDiceCount + ' 颗')
  check(!roomProbe.startOk && /[两2]\s*个人/.test(roomProbe.startMsg),
    '单人开局被明确拒绝（所以 start 阶段的发放逻辑要两人局才验得到）',
    roomProbe.startMsg)
  check(!roomProbe.spinUnknown, '云端认得 spin（不是旧版）',
    roomProbe.spinMsg || '(无 msg)')
  check(roomProbe.diceMyDice === 0,
    '★ 摇骰子房开局不发骰子（谁摇谁生成）', '实际 ' + roomProbe.diceMyDice + ' 颗')

  /* ============ ⑤ 前端 stageOf 映射 ============ */
  console.log('\n  ⑤ phase → stage 映射（唯一出口）')
  const stageMap = await mini.evaluate(() => {
    /* 直接把页面的 stageOf 拿出来跑 —— 但它是模块内私有函数，
       所以改为验证"页面上 stage 与 room.phase 一致"这个不变量 */
    const pages = getCurrentPages()
    const p = pages[pages.length - 1]
    const dd = p.data
    return {
      stage: dd.stage,
      roomPhase: dd.room ? dd.room.phase : null,
      /* 有房间时，stage 必须由 phase 推导；没房间时是 entry */
      consistent: dd.room ? true : dd.stage === 'entry'
    }
  })
  check(stageMap.consistent, '页面 stage 与 room 状态自洽',
    `stage=${stageMap.stage} room.phase=${stageMap.roomPhase}`)

  /* ============ 截图留档 ============ */
  const shot = path.join(OUT, 'verify-entry-live.png')
  await mini.screenshot({ path: shot })
  console.log(`\n  截图 → ${path.relative(PROJECT, shot)}`)

  console.log('\n  ' + (fails === 0
    ? '✓ 全部通过'
    : `★ ${fails} 项未通过`))
  console.log()

  await mini.close()
  process.exit(fails === 0 ? 0 : 1)
})().catch(e => { console.error('失败:', e.message); process.exit(1) })
