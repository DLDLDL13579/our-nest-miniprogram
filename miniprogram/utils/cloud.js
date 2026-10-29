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
        /* ★ 云端脱敏诊断码（阶段名+错误码，如 bid.update:-502）——
           只进本地错误记录，不弹给用户。2026-10-29 加：
           以前兜底文案把线索全吞了，报障时只剩一句「操作失败了」没法查。 */
        if (r._diag) e._diag = r._diag
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
      } else if (/timeout|timed out|超时/i.test(raw)) {
        /*
         * ★★ 超时要说人话（2026-10-28）。
         *
         * 云函数默认只给 3 秒，冷启动就可能吃掉全��。这时 errMsg 是
         * `cloud.callFunction:fail timeout` —— 直接显示给用户就是一句英文，
         * 他只能反馈"操作失败"，而我看不到具体是什么。
         *
         * 所以这里翻成中文，并且**把"再点一次"写进文案**：
         * 冷启动只吃掉第一次，第二次通常就热了。
         */
        msg = '这次等太久了（服务刚启动），再点一次就好'
      } else if (/network|ERR_|request:fail/i.test(raw)) {
        msg = '网络断了，连上再试'
      }
      msg = msg || '网络不太好，再试一次'
      /*
       * ★ 记一条错误日志（2026-10-28）。
       *
       * 现在出了问题只弹一个 toast，弹完就没了 —— 用户来找我说"操作失败了"，
       * 我只能猜。存最近 20 条在本地，「我的」页可以一键复制给开发者。
       *
       * ⚠️ **只记技术信息，不记任何用户内容**：函数名、action、原始错误串、
       *    时间。不记昵称、不记房间号、不记词/题。
       */
      try {
        var log = wx.getStorageSync('errLog') || []
                /*
         * ★ action 要能从**真正带 action 的地方**取到（2026-10-29）。
         *   原来只查 `opt.action`，而调用方都是 `call('room', { action: 'join' }, ...)` ——
         *   action 在**第二个参数 data** 里。于是错误记录长这样：
         *   `room：没找到这个房间` —— 看不出是哪个操作。
         */
        var act = (opt && opt.action) || (data && data.action) ||
          ((opt && opt.payload && opt.payload.action) || '')
        log.push({
          t: Date.now(),
          fn: name,
          act: act,
          /* 云端脱敏诊断码拼在 raw 末尾（如 `操作失败了，再试一次 [bid.update:-502]`），
             复制错误记录时就带走了排查线索 */
          raw: String(raw).slice(0, 160) + (err && err._diag ? ' [' + err._diag + ']' : '')
        })
        if (log.length > 20) log = log.slice(log.length - 20)
        wx.setStorageSync('errLog', log)
      } catch (e) {}
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

/**
 * 预热云函数容器（打开小程序时调一次）。
 *
 * ★ 为什么要它（2026-10-28，用户反馈"加载特别慢"、点转盘弹"操作失败"）：
 *   云函数按需冷启动，容器闲置会被回收，下次调用要重新拉起，实测 1~5 秒。
 *   而这个小程序的每个动作都是云函数调用 —— 第一下最容易撞上冷启动甚至超时。
 *
 *   在启动时发一个空请求把容器叫醒，用户真正点下去时就是热的。
 *   不碰数据库、不写数据，失败也完全不影响玩法（所以静默）。
 */
function warmup() {
  try {
    wx.cloud.callFunction({ name: 'room', data: { action: 'ping' } }).catch(() => {})
  } catch (e) { /* 忽略：预热失败不影响任何功能 */ }
}

module.exports = {
  warmup, call: call, todayISO: todayISO }
