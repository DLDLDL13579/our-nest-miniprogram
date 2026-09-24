/**
 * 云函数调用统一入口。
 *
 * 为什么要包一层：裸用 wx.cloud.callFunction 有三件事每次都忘 ——
 *   1. 网络失败 / 云函数超时，不 catch 就是白屏；
 *   2. 云函数返回 { ok:false, msg } 时，业务代码经常当成功处理；
 *   3. loading 忘了关。
 * 这三个都在 call() 里统一掉。
 */

function call(name, data, opt) {
  opt = opt || {}
  if (opt.loading) wx.showLoading({ title: opt.loading, mask: true })
  return wx.cloud.callFunction({ name: name, data: data || {} })
    .then(function (res) {
      if (opt.loading) wx.hideLoading()
      var r = res && res.result
      if (!r) throw new Error('云函数 ' + name + ' 没有返回结果')
      if (r.ok !== true) {
        var e = new Error(r.msg || '操作没成功')
        e.code = r.code || 'BIZ_ERROR'
        throw e
      }
      return r
    })
    .catch(function (err) {
      /* 先关 loading 再弹提示 —— 否则 toast 会被 loading 遮罩盖住，用户看不见 */
      if (opt.loading) wx.hideLoading()
      var raw = (err && err.errMsg) || (err && err.message) || ''
      var msg = raw
      /* 微信服务端对测试号的明确拒绝 —— 这不是代码问题，是账号类型问题 */
      if (/601059|测试号/.test(raw)) {
        msg = '当前 AppID 是测试号，微信不允许使用云开发。需要注册正式小程序（个人主体即可）后换掉 AppID。'
        err.testAccount = true
      } else if (/FunctionName|not found|invalid|env/i.test(raw) && !err.code) {
        msg = '云函数 ' + name + ' 还没部署，或云环境不对。先在开发者工具里上传部署。'
      }
      msg = msg || '网络不太好，再试一次'
      err.friendly = msg
      if (opt.silent) console.warn('[' + name + ']', msg)
      else wx.showToast({ title: msg, icon: 'none', duration: 3500 })
      throw err
    })
}

/** 今天的日期串 YYYY-MM-DD，按本地时区（不是 UTC） */
function todayISO(d) {
  d = d || new Date()
  function p(n) { return n < 10 ? '0' + n : '' + n }
  return d.getFullYear() + '-' + p(d.getMonth() + 1) + '-' + p(d.getDate())
}

module.exports = { call: call, todayISO: todayISO }
