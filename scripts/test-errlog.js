/**
 * test-errlog.js —— 错误记录里能不能看出"是哪个操作"失败、以及"哪一步挂的"
 *
 * 起因（2026-10-29）：用户截图发来的错误是
 *     room：没找到这个房间，确认一下房间号
 * —— **没有 action**，我只好猜是建房还是进房。
 *
 * 根因：`act` 只查了 `opt.action` / `opt.payload.action`，
 * 而所有调用都是 `call('room', { action: 'join' }, { loading: '进房间' })`
 * —— action 在第二个参数里。
 *
 * 第二组（同日）：用户报「点叫骰 → 操作失败了，再试一次」，
 * 错误记录里**只剩这句兜底**，不知道是 update 还是 get、错误码是多少。
 * 云端现在透出 `_diag`（如 bid.update:-502），前端必须把它记进 raw。
 *
 * 跑法：node scripts/test-errlog.js
 */
const path = require('path')
const assert = require('assert')
let store = {}
global.wx = {
  getStorageSync: (k) => store[k],
  setStorageSync: (k, v) => { store[k] = v },
  showToast: () => {}, hideLoading: () => {}, showLoading: () => {},
  cloud: {
    callFunction: () => Promise.reject({ errMsg: 'cloud.callFunction:fail timeout' }),
    init: () => {}
  }
}
const cloud = require('/Users/meihaoshidai/Downloads/邓林work/个人项目/小程序/miniprogram/utils/cloud.js')

;(async () => {
  /* ① act 必须从 data.action 取到 */
  await cloud.call('room', { action: 'join', code: '627' }, { loading: '进房间' })
    .then(() => { throw new Error('不该成功') })
    .catch(() => {})
  {
    const log = store.errLog || []
    console.log('errLog:', JSON.stringify(log[0]))
    assert.ok(log[0], '错误应该被记进 errLog')
    assert.strictEqual(log[0].act, 'join',
      '★ act 必须从 data.action 取到 —— 否则用户截图里看不出是哪个操作')
    console.log('  ✓ 错误记录带 action（act = join）')
  }

  /* ② 云端兜底错误的 _diag（阶段名:错误码）必须拼进 raw */
  global.wx.cloud.callFunction = () => Promise.resolve({
    result: { ok: false, msg: '操作失败了，再试一次', _diag: 'bid.update:-502' }
  })
  await cloud.call('room', { action: 'bid', n: 2, face: 3 })
    .then(() => { throw new Error('不该成功') })
    .catch(() => {})
  {
    const log = store.errLog || []
    const last = log[log.length - 1]
    console.log('errLog:', JSON.stringify(last))
    assert.strictEqual(last.act, 'bid', 'act 应为 bid')
    assert.ok(/\[bid\.update:-502\]$/.test(last.raw),
      '★ raw 必须带 [_diag] —— 错误记录里只剩「操作失败了」就查不了问题；实际：' + last.raw)
    console.log('  ✓ 错误记录带 _diag（bid.update:-502）')
  }

  /* ③ 没有 _diag 时不能凭空拼出空括号（老云函数/别的云函数） */
  global.wx.cloud.callFunction = () => Promise.resolve({
    result: { ok: false, msg: '只能往上叫' }
  })
  await cloud.call('room', { action: 'bid', n: 1, face: 1 })
    .then(() => { throw new Error('不该成功') })
    .catch(() => {})
  {
    const log = store.errLog || []
    const last = log[log.length - 1]
    assert.ok(last.raw.indexOf('[') === -1,
      '★ 没有 _diag 时 raw 不能带括号尾巴；实际：' + last.raw)
    console.log('  ✓ 无 _diag 时不拼空括号')
  }

  console.log('\n  错误记录：全部 3 项断言通过\n')
})().catch(e => {
  console.error('\n  ✗ 断言失败：', e.message, '\n')
  process.exit(1)
})
