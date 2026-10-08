/**
 * verify-fix.js —— 核对「云端 room 云函数是不是最新版」。
 *
 * ============ 上一版为什么是废的（必须记住） ============
 *
 * 上一版走的是：create 单人房 → start → status，然后看「我的骰子数」。
 * 它打印了「✓ 已生效（开局不发骰子）」，但那是**假阳性**：
 *
 *   云函数 start 有前置条件 `players.length < 2 → 拒绝`，
 *   单人房 start **必然失败**，phase 永远停在 lobby。
 *   而 lobby 阶段 shape() 里骰子本来就该是空的 ——
 *   于是「骰子数 = 0」跟"修复有没有生效"毫无关系。
 *   哪怕云端跑的是去年的旧版本，这个探针照样打印 ✓。
 *
 * ★ 教训：探针的判据必须**只被"目标改动"影响**。
 *   这里"骰子数=0"同时被两件事决定（有没有开局 / 发不发骰子），
 *   就分不清是哪一件在起作用 —— 必须先让前置条件真的成立。
 *
 * 现在改成：用**只受版本影响**的指纹来判定 ——
 * 旧版 room 没有 spin action，会返回「不认识的操作：spin」。
 *
 * 用法：node .tooling/verify-fix.js
 * 前置：开发者工具开着（需要它的自动化端口）
 */
const automator = require('miniprogram-automator')
const path = require('path')

;(async () => {
  const mini = await automator.launch({
    cliPath: '/Applications/wechatwebdevtools.app/Contents/MacOS/cli',
    projectPath: path.join(__dirname, '..'),
    timeout: 90000
  })

  /* ★ 必须先 navigateTo 到页面：app.onLaunch 里的 wx.cloud.init 才会跑。
     直接在首页 evaluate 会报 "Cloud API isn't enabled"。
     所有调用放进**一次** evaluate —— 多次跨进程往返容易
     触发 "timeout waiting for automator response"。 */
  await mini.navigateTo('/pages/game/room/room')
  await new Promise(r => setTimeout(r, 2500))

  const out = await mini.evaluate(async () => {
    const call = async (d) => (await wx.cloud.callFunction({ name: 'room', data: d })).result

    /* ① 单人开局**应当被拒** —— 先证伪这个前置条件，避免又踩假阳性 */
    const c1 = await call({ action: 'create', name: 'V1', game: 'liar' })
    const id1 = c1.room.id
    const s1 = await call({ action: 'start', id: id1 })
    const solitary = { ok: !!s1.ok, msg: s1.msg || '' }
    await call({ action: 'leave', id: id1 }).catch(() => {})

    /* ② 版本指纹：旧版没有 spin，会回「不认识的操作：spin」。
       这一条**只被版本影响**，是最好的判据。 */
    const c2 = await call({ action: 'create', name: 'V2', game: 'wheel' })
    const id2 = c2.room.id
    const sp = await call({ action: 'spin', id: id2 })
    const spinProbe = { ok: !!sp.ok, msg: sp.msg || '', hasSpin: !!sp.spin }
    await call({ action: 'leave', id: id2 }).catch(() => {})

    /* ③ 摇骰子房开局是否发骰子 —— 注意：单人开不了局，
       所以这里**只能**说明 lobby 阶段不发骰子，不足以证明修复生效。 */
    const c3 = await call({ action: 'create', name: 'V3', game: 'dice' })
    const id3 = c3.room.id
    const s3 = await call({ action: 'status', id: id3 })
    const dicePhase = { phase: s3.room.phase, myDiceLen: (s3.room.me.dice || []).length }
    await call({ action: 'leave', id: id3 }).catch(() => {})

    return { solitary, spinProbe, dicePhase }
  })

  console.log('\n  ── 云端 room 探针 ──')
  console.log('  ① 单人开局：' +
    (out.solitary.ok ? '★ 居然成功（云端未校验人数？）' : '被拒 ✓「' + out.solitary.msg + '」'))

  /* ★ 注意措辞：ok:false 不等于"不认得这个 action"。
     旧版会回「不认识的操作：spin」；新版认得 spin，
     只是可能因为 phase/权限被拦（如"这局还没开始"）。
     只有「不认识的操作」才是版本落后的铁证。 */
  const unknownAction = /不认识的操作/.test(out.spinProbe.msg)
  console.log('  ② spin action：' +
    (unknownAction
      ? '★ 不认识 → 云端是旧版「' + out.spinProbe.msg + '」'
      : '认得 ✓（返回「' + out.spinProbe.msg + '」= 通过了 action 分发，' +
        '只是被阶段校验拦下）'))

  console.log('  ③ 摇骰子房 phase=' + out.dicePhase.phase +
    ' 骰子数=' + out.dicePhase.myDiceLen +
    '（单人未开局，仅说明 lobby 不发骰子，不作为判据）')

  console.log('\n  ' + (unknownAction
    ? '✗ 云端 room 不认 spin → ★ 云端还是旧版，需要重新部署 room'
    : '✓ 云端 room 认得 spin → 版本是新的'))

  await mini.close()
  process.exit(0)
})().catch(e => { console.error('失败:', e.message); process.exit(1) })
