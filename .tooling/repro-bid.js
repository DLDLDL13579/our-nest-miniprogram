/**
 * ⚠️ 2026-11-03：本脚本依赖的云端 `probeWrite` action **已被删除**
 *   （它能写任意字段到任意房间、且无属主校验，是纯风险）。
 *   脚本保留作为当时的实验设计与发现记录，但**已经跑不通** ——
 *   根因结论见 AGENTS.md 的「update 写对象到 null 字段」一节。
 */
/**
 * repro-bid.js —— 真实复现「叫骰/摇骰/转盘 → 操作失败了，再试一次」
 *
 * ★ 为什么必须真调云端：本地 mock 永远成功，-502001 只在真实数据库上出现。
 * ★ 为什么拆成多次 evaluate：automator 单次响应有超时（实测 5 秒级），
 *   把 sleep(3.6s) 放进 evaluate 必成 "timeout waiting for automator response"。
 *   等待放在 Node 侧，每次 evaluate 只做少量云调用。
 *
 * 用法：node .tooling/repro-bid.js
 */
const automator = require('miniprogram-automator')
const path = require('path')
const ROOT = path.resolve(__dirname, '..')
const CLI = '/Applications/wechatwebdevtools.app/Contents/MacOS/cli'
const sleep = ms => new Promise(r => setTimeout(r, ms))

/* mini.evaluate 接受「函数 + 参数」；字符串 IIFE 会被当表达式解析并报
   "Uncaught (in promise) ... is not a function"（踩过） */
async function callInRuntime(mini, label, data) {
  return mini.evaluate(async (payload) => {
    try {
      const res = await wx.cloud.callFunction({ name: 'room', data: payload.data })
      const r = (res && res.result) || {}
      return {
        step: payload.label, ok: r.ok, msg: r.msg || '', diag: r._diag || '',
        probe: r.probe || null,
        rid: r.room ? r.room.id : '', phase: r.room ? r.room.phase : '', code: r.room ? r.room.code : ''
      }
    } catch (e) {
      return { step: payload.label, THROW: String((e && (e.errMsg || e.message)) || e) }
    }
  }, { label: label, data: data })
}

const pretty = x => {
  if (!x) return '  (无返回)'
  if (x.probe) {
    return '  ' + x.step + ' → probe:\n' + x.probe.map(p =>
      '      ' + p.s + ' : ' + (p.ok ? 'ok' : 'FAIL ' + [p.code, p.op, p.tag].filter(Boolean).join(':'))).join('\n')
  }
  if (x.THROW) return '  ' + x.step + ' → THROW: ' + x.THROW
  return '  ' + x.step + ' → ok=' + x.ok + (x.msg ? ' msg=' + x.msg : '') +
    (x.diag ? ' _diag=' + x.diag : '') + (x.phase ? ' phase=' + x.phase : '')
}

;(async () => {
  console.log('启动小程序运行时…')
  const mini = await automator.launch({ cliPath: CLI, projectPath: ROOT, timeout: 120000 })
  const log = []
  const run = async (label, data) => {
    const r = await callInRuntime(mini, label, data)
    log.push(r)
    console.log(pretty(r))
    return r
  }
  try {
    await sleep(9000)
    await mini.navigateTo('/game/room/room').then(
      () => console.log('  ✓ 已进入房间页'),
      e => console.log('  (navigate warn:', e.message, '— 继续)')
    )
    await sleep(2500)

    await run('selftest', { action: 'selftest' })

    const c = await run('create', { action: 'create', name: '复现甲', game: 'liar' })
    if (!c || !c.ok || !c.rid) { console.log('\n✗ 建房失败，无法继续'); throw new Error('create failed') }
    const rid = c.rid
    await run('start', { action: 'start', id: rid, solo: true })

    await sleep(4200)
    await run('status', { action: 'status', id: rid })

    await run('bid', { action: 'bid', id: rid, n: 1, face: 1 })
    await run('bid2', { action: 'bid', id: rid, n: 2, face: 2 })

    await run('selftest.room', { action: 'selftest', probeRoomId: rid })

    /* ⑤b 字段级写入探测：逐个字段试写，精确定位是哪一个引发 -502001 */
    const pw = await mini.evaluate(async (payload) => {
      try {
        const res = await wx.cloud.callFunction({ name: 'room', data: payload })
        return (res && res.result) || {}
      } catch (e) { return { THROW: String((e && (e.errMsg || e.message)) || e) } }
    }, { action: 'probeWrite', probeRoomId: rid })
    console.log('  probeWrite → 字段级写入结果:')
    ;((pw && pw.writes) || []).forEach(w => {
      console.log('      ' + w.k + ' : ' + (w.ok ? 'ok'
        : 'FAIL ' + [w.code, w.op].filter(Boolean).join(':') + (w.hint ? ' | ' + w.hint : '')))
    })
    if (pw && pw.THROW) console.log('      THROW: ' + pw.THROW)

    const c2 = await run('create2', { action: 'create', name: '复现乙', game: 'dice' })
    if (c2 && c2.ok && c2.rid) {
      await run('start2', { action: 'start', id: c2.rid, solo: true })
      await sleep(4200)
      await run('status2', { action: 'status', id: c2.rid })
      await run('roll', { action: 'roll', id: c2.rid })
    }

    const fails = log.filter(x => x && (x.ok === false || x.THROW))
    console.log('\n════════ 结论 ════════')
    if (!fails.length) {
      console.log('  ✓ 全链路成功：建房 → 开局 → 叫骰 → 再叫 → 摇骰 都没有报错')
    } else {
      console.log('  ✗ 失败步骤：')
      fails.forEach(f => console.log('    ' + f.step + ' → ' + (f.diag || f.msg || f.THROW)))
    }
  } finally {
    await mini.close().catch(() => {})
  }
})().catch(e => {
  console.error('\n✗ 复现脚本失败：', (e && (e.stack || e.message)) || e)
  process.exit(1)
})
