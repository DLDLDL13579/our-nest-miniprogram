/**
 * test-errlog.js —— 错误记录里能不能看出"是哪个操作"失败
 *
 * 起因（2026-10-29）：用户截图发来的错误是
 *     room：没找到这个房间，确认一下房间号
 * —— **没有 action**，我只好猜是建房还是进房。
 *
 * 根因：`act` 只查了 `opt.action` / `opt.payload.action`，
 * 而所有调用都是 `call('room', { action: 'join' }, { loading: '进房间' })`
 * —— action 在第二个参数里。
 *
 * 跑法：node scripts/test-errlog.js
 */
const path = require('path')
const assert = require('assert')
let store = {}
let captured = null
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
cloud.call('room', { action: 'join', code: '627' }, { loading: '进房间' })
  .then(() => console.log('不该成功'))
  .catch(() => {
    const log = store.errLog || []
    console.log('errLog:', JSON.stringify(log[0]))
    assert.ok(log[0], '错误应该被记进 errLog')
    assert.strictEqual(log[0].act, 'join',
      '★ act 必须从 data.action 取到 —— 否则用户截图里看不出是哪个操作')
    console.log('  ✓ 错误记录带 action（act = join）')
  })
