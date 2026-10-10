/**
 * diag-bid.js —— 复现「叫骰/转盘 → document.update:fail -502」
 *
 * ★ 为什么必须真调云端：本地 mock 的写库永远成功，复现不出 -502。
 *
 * ★ automator 的两个 API 坑（实测）：
 *   ① 是 `mini.evaluate`，**不是** `page.evaluate`（后者不是函数）
 *   ② 所有云调用必须放在**一次** evaluate 里 —— 多次往返必触发
 *      "timeout waiting for automator response"
 *   ③ 必须先 navigateTo，否则 app.onLaunch 没跑 → "Cloud API isn't enabled"
 *
 * 用法：node .tooling/diag-bid.js
 */
const automator = require('miniprogram-automator')
const path = require('path')
const ROOT = path.resolve(__dirname, '..')
const CLI = '/Applications/wechatwebdevtools.app/Contents/MacOS/cli'

;(async () => {
  const mini = await automator.launch({ cliPath: CLI, projectPath: ROOT })
  try {
    await mini.navigateTo('/pages/game/room/room')
    await new Promise(r => setTimeout(r, 3000))

    const out = await mini.evaluate(async () => {
      const log = []
      const call = async (label, data) => {
        try {
          const res = await wx.cloud.callFunction({ name: 'room', data })
          return { label, r: res && res.result }
        } catch (e) {
          return { label, throw: String((e && (e.errMsg || e.message)) || e) }
        }
      }
      const push = (x) => {
        const r = x.r || {}
        log.push(x.label + ' → ok=' + r.ok +
          ' msg=' + (r.msg || '') +
          (r._diag ? ' | _diag=' + r._diag : '') +
          (r._probe ? ' | _probe=' + JSON.stringify(r._probe) : '') +
          (x.throw ? ' | THROW=' + x.throw : ''))
        return r
      }

      // ① 建房（.add，之前是能成的）
      const c = push(await call('① create', { action: 'create', name: 'DIAG', game: 'liar' }))
      if (!c.ok) return log
      const id = c.room.id

      // ② 读（之前是能成的）
      push(await call('② status', { action: 'status', id }))

      // ③ ★ 换题卡 = doc().update()，不校验 phase —— 直接测"写库"这一类
      push(await call('③ deck(写库)', { action: 'deck', id, deck: 'family' }))

      // ④ ★ 加自定义题 = doc().update() + 内容安全
      push(await call('④ card(写库)', { action: 'card', id, type: 'truth', text: '诊断题目' }))

      // ⑤ 再读，看③④是否真写进去了
      push(await call('⑤ status2', { action: 'status', id }))

      // ⑥ 带走房间信息
      log.push('ROOM id=' + id + ' code=' + c.room.code)

      // ⑦ 清理
      push(await call('⑦ leave', { action: 'leave', id }))
      return log
    })

    console.log('\n════ 云端真调结果 ════')
    ;(out || []).forEach(l => console.log('  ' + l))
  } finally {
    await mini.close().catch(() => {})
  }
})().catch(e => {
  console.error('\n✗ 探针失败：', (e && (e.stack || e.message)) || e)
  process.exit(1)
})
