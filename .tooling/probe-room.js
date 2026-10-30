/**
 * probe-room.js —— 核对「云端 room 到底是哪个版本」，并跑一遍关键 action。
 *
 * ============ 为什么需要它 ============
 *
 * 2026-10-08 真实踩过：本地代码早就改好了，**但云端 room 还是旧版**，
 * 前端调 spin 得到 `{ ok:false, msg:'不认识的操作：spin' }`，
 * 用户看到的是「开不了房间 / 转盘没反应」。
 *
 * 这类「本地新版 + 云端旧版」的错配，本地怎么检查都发现不了：
 * 语法对、绑定对、159 项断言全绿 —— 因为本地前后端是自洽的。
 * 唯一能发现的办法就是**问云端**。
 *
 * ============ 用法 ============
 *   node .tooling/probe-room.js
 * 前置：开发者工具开着（需要它的自动化端口）
 *
 * 判据：响应里有没有 `spin` 字段 / spin action 认不认。
 *   有 → 云端是新版 ✓
 *   报「不认识的操作」→ 云端是旧版，跑 scripts/deploy.sh 或单独部署 room
 */
const automator = require('miniprogram-automator')
const path = require('path')

;(async () => {
  const mini = await automator.launch({
    cliPath: '/Applications/wechatwebdevtools.app/Contents/MacOS/cli',
    projectPath: path.join(__dirname, '..'),
    timeout: 90000
  })

  /* ★ 必须先 navigateTo 到房间页：app.onLaunch 里的 wx.cloud.init 才会跑。
     直接在首页 evaluate 会报 "Cloud API isn't enabled"。 */
  await mini.navigateTo('/game/room/room')
  await new Promise(r => setTimeout(r, 3000))
  console.log('✓ 已进入房间页\n')

  /* 所有调用放在**一次** evaluate 里 —— 多次跨进程往返容易触发
     "timeout waiting for automator response"（automator 的老问题）。 */
  const steps = await mini.evaluate(async () => {
    const log = []
    const call = async (label, data) => {
      const t0 = Date.now()
      try {
        const res = await wx.cloud.callFunction({ name: 'room', data: data })
        log.push({ label, ms: Date.now() - t0, ok: true, r: res.result })
        return res.result
      } catch (e) {
        log.push({ label, ms: Date.now() - t0, ok: false, err: String(e.errMsg || e.message) })
        return null
      }
    }
    const c = await call('开房间', { action: 'create', name: '探针', game: 'dice' })
    if (!c || !c.ok) return log
    const id = c.room.id
    await call('查状态', { action: 'status', id: id })
    await call('单人开局(应被拒)', { action: 'start', id: id })
    await call('转盘(dice房应被拒)', { action: 'spin', id: id })
    await call('离开', { action: 'leave', id: id })
    return log
  })

  steps.forEach(s => {
    console.log(`  ${s.ok ? '✓' : '✗'} ${s.label} (${s.ms}ms)`)
    console.log(`      ${s.ok ? JSON.stringify(s.r).slice(0, 160) : s.err}`)
  })

  /* 版本判据 */
  const create = steps.find(s => s.label === '开房间')
  if (create && create.ok) {
    const isNew = JSON.stringify(create.r).indexOf('"spin"') >= 0
    console.log(`\n云端 room：${isNew ? '新版 ✓（含 spin 字段）' : '旧版 ✗ —— 跑 scripts/deploy.sh 部署'}`)
  }

  await mini.close()
})().catch(e => { console.error('探针失败:', e.message); process.exit(1) })
