/**
 * repro-all.js —— 真实云端跑遍**每一个玩法**的核心动作
 *
 * 用户原话：「游戏我测试时从来没有正常能玩过，从刚开始开发到现在」。
 * 所以不能只验一个玩法：每个玩法都要在真实数据库上走一遍关键动作，
 * 全部 ok 才算"能玩"。
 *
 * ★ automator 单次响应有超时，等待一律放 Node 侧。
 * 用法：node .tooling/repro-all.js
 */
const automator = require('miniprogram-automator')
const path = require('path')
const ROOT = path.resolve(__dirname, '..')
const CLI = '/Applications/wechatwebdevtools.app/Contents/MacOS/cli'
const sleep = ms => new Promise(r => setTimeout(r, ms))

async function call(mini, data) {
  return mini.evaluate(async (payload) => {
    try {
      const res = await wx.cloud.callFunction({ name: 'room', data: payload })
      const r = (res && res.result) || {}
      return {
        ok: r.ok, msg: r.msg || '', diag: r._diag || '',
        rid: r.room ? r.room.id : '', phase: r.room ? r.room.phase : '',
        spin: r.spin ? r.spin.t : null, result: r.result ? (r.result.winner || 'yes') : null
      }
    } catch (e) { return { THROW: String((e && (e.errMsg || e.message)) || e) } }
  }, data)
}

;(async () => {
  console.log('启动小程序运行时…')
  const mini = await automator.launch({ cliPath: CLI, projectPath: ROOT, timeout: 120000 })
  const rows = []
  try {
    await sleep(9000)
    await mini.navigateTo('/game/room/room').then(() => {}, () => {})
    await sleep(2500)

    const step = async (label, data) => {
      const r = await call(mini, data)
      const bad = r.THROW || r.ok === false
      rows.push({ label, bad: bad, r })
      console.log((bad ? '  ✗ ' : '  ✓ ') + label +
        (bad ? ' → ' + (r.diag || r.msg || r.THROW) : ''))
      return r
    }

    const flow = async (game, extra) => {
      console.log('\n── ' + game + ' ──')
      const c = await step(game + '.create', { action: 'create', name: '真测', game: game })
      if (!c.rid) return
      await step(game + '.start', { action: 'start', id: c.rid, solo: true })
      await sleep(4200)
      await step(game + '.status', { action: 'status', id: c.rid })
      if (extra) await extra(c.rid)
    }

    await flow('liar', async (id) => {
      await step('liar.bid', { action: 'bid', id: id, n: 1, face: 1 })
      await step('liar.open', { action: 'open', id: id })
    })
    await flow('dice', async (id) => {
      await step('dice.roll', { action: 'roll', id: id })
    })
    await flow('wheel', async (id) => {
      await step('wheel.spin', { action: 'spin', id: id })
      await step('wheel.spin2', { action: 'spin', id: id })
    })
    await flow('poker', async (id) => {
      await step('poker.swapMine', { action: 'pkAct', id: id, act: 'swapMine' })
      await step('poker.fold', { action: 'pkAct', id: id, act: 'fold' })
    })
    await flow('undercover', async (id) => {
      await step('uw.say', { action: 'uwSay', id: id })
      await step('uw.vote', { action: 'uwVote', id: id, target: 'x' })
    })

    const bad = rows.filter(x => x.bad)
    console.log('\n════════ 汇总 ════════')
    console.log('  共 ' + rows.length + ' 步，失败 ' + bad.length + ' 步')
    if (!bad.length) console.log('  ✓ 所有玩法的核心动作在真实云端全部通过')
    else bad.forEach(x => console.log('  ✗ ' + x.label + ' → ' + (x.r.diag || x.r.msg || x.r.THROW)))
  } finally {
    await mini.close().catch(() => {})
  }
})().catch(e => { console.error('✗ 脚本失败：', (e && e.stack) || e); process.exit(1) })
