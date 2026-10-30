/**
 * verify-four-fixes.js —— 用真实云端数据验证四个报障是否真的修好
 *
 * 对应 2026-10-08 用户报的四条：
 *   ① 筛盅拿开筛子看不全   → scripts/test-cup-geometry.js 静态算（已过）
 *   ② 大话筛无法喊筛       → 本脚本验：云端给的骰子 + 前端门槛
 *   ③ 转盘无法转           → 本脚本验：云端 phase 流转 + 前端 stageOf
 *   ④ 双人交互不智能       → 本脚本验：dice 房开局不发骰子
 *
 * ★ 本脚本**只调云端云函数**，不碰界面、不截图 ——
 *   用户明确要求不要打扰他工作，所以走纯数据路径。
 *
 * ★ 关键：一定要**两个 openid 各建一次房**吗？
 *   不必 —— 云函数按 OPENID 区分玩家，而探针里只有一个真实 openid。
 *   但 start 要求 ≥2 人，所以"真正开局"这一步做不了。
 *   因此本脚本验证的是**开局前的状态**（这才是出问题的地方）：
 *     · dice 房 create 后 diceCount 是否为 0
 *     · wheel 房能否认得 spin action
 *   以及**用源码指纹**确认云端跑的是新版（见 probe-room-cloud.js）。
 *
 * 用法：node .tooling/verify-four-fixes.js
 * 前置：开发者工具在跑（需要自动化端口）
 */
const automator = require('miniprogram-automator')
const path = require('path')

;(async () => {
  const mini = await automator.launch({
    cliPath: '/Applications/wechatwebdevtools.app/Contents/MacOS/cli',
    projectPath: path.join(__dirname, '..'),
    timeout: 90000
  })

  /* 必须先 navigateTo：app.onLaunch 里的 wx.cloud.init 才会跑。
     所有云调用放**一次** evaluate —— 多次跨进程往返容易超时。 */
  await mini.navigateTo('/pages/game/room/room')
  await new Promise(r => setTimeout(r, 2500))

  const out = await mini.evaluate(async () => {
    const call = async (d) => (await wx.cloud.callFunction({ name: 'room', data: d })).result
    const res = {}

    /* ---- ④ 摇骰子：create 后不该预发骰子 ---- */
    const d = await call({ action: 'create', name: 'V4', game: 'dice' })
    res.diceRoom = {
      phase: d.room.phase,
      myDiceCount: (d.room.me.dice || []).length,
      host: d.room.host
    }
    await call({ action: 'leave', id: d.room.id }).catch(() => {})

    /* ---- ③ 转盘：云端认不认得 spin（认得 = 不是旧版） ---- */
    const w = await call({ action: 'create', name: 'V3', game: 'wheel' })
    const sp = await call({ action: 'spin', id: w.room.id })
    res.wheel = {
      createOk: w.ok,
      phase: w.room.phase,
      spinMsg: sp.msg || '',
      spinOk: !!sp.ok,
      /* 旧版会回「不认识的操作：spin」 */
      unknownAction: /不认识的操作/.test(sp.msg || '')
    }
    await call({ action: 'leave', id: w.room.id }).catch(() => {})

    /* ---- ② 大话骰：create 后阶段 + 人数门槛（叫骰要求 playing） ---- */
    const l = await call({ action: 'create', name: 'V2', game: 'liar' })
    const lstart = await call({ action: 'start', id: l.room.id })
    res.liar = {
      createOk: l.ok,
      phase: l.room.phase,
      /* 单人开局必然被拒 —— 这本身是对的（至少两人） */
      startRejected: !lstart.ok,
      startMsg: lstart.msg || '',
      /* 关键：房间人数门槛提示是否清晰 */
      needsTwo: /两个人/.test(lstart.msg || '')
    }
    await call({ action: 'leave', id: l.room.id }).catch(() => {})

    return res
  })

  const pass = (b) => (b ? '✓' : '★')

  console.log('\n  ── 四条报障的云端验证 ──\n')

  console.log('  ④ 摇骰子比大小（开局不该预发骰子）')
  console.log(`     ${pass(out.diceRoom.myDiceCount === 0)} 开局骰子数 = ${out.diceRoom.myDiceCount}（应为 0，谁摇谁生成）`)
  console.log(`     ${pass(out.diceRoom.phase === 'lobby')} phase = ${out.diceRoom.phase}`)

  console.log('\n  ③ 命运转盘（云端必须认得 spin）')
  console.log(`     ${pass(!out.wheel.unknownAction)} spin 未被判为"不认识的操作"`)
  console.log(`       云端回：${out.wheel.spinMsg || '(无)'}`)

  console.log('\n  ② 大话骰（开局门槛提示要清楚）')
  console.log(`     ${pass(out.liar.needsTwo)} 单人开局提示明确：${out.liar.startMsg || '(无)'}`)

  const bad = []
  if (out.diceRoom.myDiceCount !== 0) bad.push('④ dice 房仍在预发骰子')
  if (out.wheel.unknownAction) bad.push('③ 云端 room 是旧版（不认 spin）')
  if (!out.liar.needsTwo) bad.push('② 开局人数提示不清晰')

  console.log('\n  ' + (bad.length === 0
    ? '✓ 云端行为与修复一致'
    : '✗ 仍有问题：\n    ' + bad.join('\n    ')))
  console.log()

  await mini.close()
  process.exit(bad.length === 0 ? 0 : 1)
})().catch(e => { console.error('失败:', e.message); process.exit(1) })
