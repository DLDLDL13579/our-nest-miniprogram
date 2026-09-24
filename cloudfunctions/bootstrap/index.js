/**
 * bootstrap —— 一个只为了"能自动跑起来"存在的函数。
 *
 * 存在的理由：微信 CLI 没有调用云函数的命令，initdb 只能人工去控制台点。
 * 但云函数之间可以互相 callFunction —— 所以让这个函数在云端替我们调 initdb。
 * 它的返回值会被小程序启动时打印出来，我们据此确认库建好了。
 */
const cloud = require('wx-server-sdk')
cloud.init({ env: cloud.DYNAMIC_CURRENT_ENV })

exports.main = async () => {
  try {
    const r = await cloud.callFunction({ name: 'initdb', data: {} })
    return { ok: true, from: 'bootstrap', initdb: r.result }
  } catch (e) {
    return { ok: false, step: 'call initdb', err: e.errMsg || e.message }
  }
}
