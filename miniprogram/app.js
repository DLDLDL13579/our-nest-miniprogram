/**
 * 酒桌 · 入口
 *
 * 改造前这里是「我们的小窝」——一个情侣记录 App。
 * 现在整站转成**纯酒桌游戏**：没有配对、没有纪念日、没有"属于两个人的小窝"，
 * 谁都能开房间，靠 3 位房间号聚人。
 *
 * 因此本文件只做两件事：
 *   ① 初始化云开发
 *   ② 首次启动确保数据库集合存在（幂等、一次就够）
 *
 * ★ 这里**不存任何业务数据**。昵称存本机 storage（见 pages/me），
 *   房间状态一律以服务端返回为准 —— 前端不做"第二份真相"。
 */
const CFG = require('./config.js')

App({
  globalData: {
    /* 预留给"我"的身份信息，目前只有昵称（本机 storage 为准） */
    nick: ''
  },

  onLaunch() {
    if (!wx.cloud) {
      wx.showModal({
        title: '微信版本过低',
        content: '当前微信不支持云能力，请升级到最新版本后再打开。',
        showCancel: false
      })
      return
    }
    // env 留空时用账号下的默认环境；多环境务必在 config.js 里写死
    wx.cloud.init(CFG.env ? { env: CFG.env, traceUser: true } : { traceUser: true })

    this.globalData.nick = wx.getStorageSync('nick') || ''
    /*
     * ★ 先预热云函数容器（2026-10-28）。
     *   用户反馈"手机加载特别慢"、点转盘还弹"操作失败"——
     *   根因之一是云函数冷启动：容器闲置会被回收，下次调用要重新拉起（1~5 秒）。
     *   这个小程序每个动作都是云函数调用，第一下最容易撞上冷启动。
     *   启动就发一个空请求把容器叫醒，用户真点下去时已经是热的。
     *   （不阻塞启动流程，失败静默 —— 它只是优化，不是功能）
     */
    require('./utils/cloud.js').warmup()
    /*
     * 数字字体（2026-10-28）。
     * 只影响数字/大写的字形，加载失败会回退系统字体 —— 所以不 await、不报错。
     * 放在 warmup 之后：预热云函数更影响操作手感，字体只是好看。
     */
    require('./utils/fonts.js').load()
    this.bootstrap()
  },

  /**
   * 首次启动确保集合存在。
   *
   * 为什么不让你手工点：云函数没有"命令行调用"入口，initdb 每次都要人去控制台点一遍，
   * 换环境、清库之后又得来一次。initdb 本身是幂等的（集合已存在就跳过），
   * 所以挂在启动时跑一次最省事 —— 用一个 storage 标记避免每次打开都打一次云函数。
   */
  bootstrap() {
    /*
     * 用版本号而不是布尔值：以后再加集合时把 DB_VERSION 加一，
     * 所有设备下次启动会自动补建，不用教用户清缓存。
     * 7 = 转成纯酒桌游戏后的版本（只保留 rooms）
     */
    const DB_VERSION = 7
    if (wx.getStorageSync('dbReady') === DB_VERSION) return

    /* 先调 bootstrap（它会在云端替我们调 initdb）；bootstrap 没部署时退回直接调 initdb */
    const step = (name) => wx.cloud.callFunction({ name: name })
      .then(res => res.result || {})
      .catch(err => ({ ok: false, err: err.errMsg || err.message }))

    const finish = (r) => {
      const inner = (r && r.initdb) || r || {}
      if (inner.ok) {
        wx.setStorageSync('dbReady', DB_VERSION)
        /*
         * ★ 这里**不再弹模态框**。
         *   改造前它是给"首次安装的人"看的配置引导（建索引之类），
         *   但酒桌游戏是"坐下来就想玩"——开场先弹一个技术弹窗会打断气氛。
         *   失败才需要说话，成功就安静。
         */
        return
      }
      wx.showModal({
        title: '初始化没成功',
        content: String((inner && (inner.err || inner.msg)) || (r && r.err) || '未知原因') +
                 '\n\n可能是云环境还没开通。修好后重新打开小程序会自动重试。',
        showCancel: false, confirmText: '好'
      })
    }

    step(CFG.fn.bootstrap).then(r => {
      if (r && r.ok) return finish(r)
      return step(CFG.fn.initdb).then(finish)   // bootstrap 不在就用 initdb
    })
  }
})
