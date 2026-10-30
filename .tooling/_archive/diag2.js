/**
 * diag2.js —— 改用 automator.launch，但把 evaluate 拆小、每步单独一次调用，
 * 并且**不用 navigateTo**（用 reLaunch 也不行，会失效句柄）——
 * 目标只是拿到一个能执行 wx.cloud 的页面上下文。
 *
 * 关键改动：一次 evaluate 只做**一件事**，避免 automator 超时。
 */
const automator = require('miniprogram-automator')
const path = require('path')
const ROOT = path.resolve(__dirname, '..')
const CLI = '/Applications/wechatwebdevtools.app/Contents/MacOS/cli'

const sleep = ms => new Promise(r => setTimeout(r, ms))

;(async () => {
  const mp = await automator.launch({ cliPath: CLI, projectPath: ROOT })
  try {
    const page = await mp.navigateTo('/pages/game/room/room')
    await sleep(2000)

    /* 只做一件事：建房。结果尽量小。 */
    const r1 = await page.evaluate(async () => {
      try {
        const r = await wx.cloud.callFunction({ name: 'room', data: { action: 'create', name: 'D', game: 'liar' } })
        const res = r && r.result
        return { ok: !!(res && res.ok), id: res && res.room && res.room.id, msg: (res && res.msg) || '', keys: res ? Object.keys(res) : [] }
      } catch (e) { return { throw: String((e && (e.errMsg || e.message)) || e) } }
    })
    console.log('① create:', JSON.stringify(r1))
    if (!r1.id) { console.log('  建房就失败了，无法继续'); return }

    /* 只做一件事：房主换题卡（doc().update()，且不校验 phase） */
    await sleep(800)
    const r2 = await page.evaluate(async (id) => {
      try {
        const r = await wx.cloud.callFunction({ name: 'room', data: { action: 'deck', id, deck: 'family' } })
        const res = r && r.result
        return { ok: !!(res && res.ok), msg: (res && res.msg) || '', diag: (res && res._diag) || '', probe: (res && res._probe) || null }
      } catch (e) { return { throw: String((e && (e.errMsg || e.message)) || e) } }
    }, r1.id)
    console.log('② deck(房主写库):', JSON.stringify(r2, null, 1))

    /* 只做一件事：加自定义题（也是 doc().update()） */
    await sleep(800)
    const r3 = await page.evaluate(async (id) => {
      try {
        const r = await wx.cloud.callFunction({ name: 'room', data: { action: 'card', id, type: 'truth', text: '诊断题目' } })
        const res = r && r.result
        return { ok: !!(res && res.ok), msg: (res && res.msg) || '', diag: (res && res._diag) || '' }
      } catch (e) { return { throw: String((e && (e.errMsg || e.message)) || e) } }
    }, r1.id)
    console.log('③ card(写库+内容安全):', JSON.stringify(r3))
  } finally {
    await mp.close().catch(() => {})
  }
})().catch(e => { console.error('✗', (e && (e.stack || e.message)) || e); process.exit(1) })
