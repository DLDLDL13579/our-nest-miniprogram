/**
 * 我们的小窝 · 入口
 *
 * 一条硬规则：本文件不存任何业务数据。
 * 配对信息（pairId / 对方 openid / 在一起的日子）一律从云端取，
 * 因为换手机、清缓存之后，"我们在一起多少天"不能变。
 */
const CFG = require('./config.js')

App({
  globalData: {
    openid: '',
    pair: null,        // { pairId, me, partner, coupleName, anniversary, names }
    ready: false       // 配对状态是否已确认
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

    this.bootstrap()
  },

  /**
   * 首次启动自动建库灌题库。
   *
   * 为什么不让你手工点：云函数没有"命令行调用"入口，initdb 每次都要人去控制台点一遍，
   * 换环境、清库之后又得来一次。initdb 本身是幂等的（集合已存在就跳过、题库非空就不重灌），
   * 所以挂在启动时跑一次最省事 —— 用一个 storage 标记避免每次开小程序都打一次云函数。
   */
  bootstrap() {
    /* 用版本号而不是布尔值：以后再加集合时，把 DB_VERSION 加一，
       所有设备下次启动会自动补建，不用教用户清缓存。
       5 = 删掉 questions/answers/pings/foods 遗留集合后的版本
       6 = v2 新增 cools（情绪·冷静期） */
    const DB_VERSION = 6
    if (wx.getStorageSync('dbReady') === DB_VERSION) return

    /* 先调 bootstrap（它会在云端替我们调 initdb）；bootstrap 没部署时退回直接调 initdb */
    const step = (name) => wx.cloud.callFunction({ name: name })
      .then(res => res.result || {})
      .catch(err => ({ ok: false, err: err.errMsg || err.message }))

    const finish = (r) => {
      const inner = (r && r.initdb) || r || {}
      if (inner.ok) {
        wx.setStorageSync('dbReady', DB_VERSION)
        /* 提示语要跟当前架构一致：随手记（moments）已经取代了「今日一题」，
           题库和 questions/answers 表都已删除，这里不再提题库。 */
        const tables = (inner.created || []).length + (inner.alreadyExists || []).length
        wx.showModal({
          title: '数据表已就绪',
          content: tables + ' 张表\n\n' +
                   '建议顺手做一件事（控制台 → 数据库 → moments → 索引管理）：\n' +
                   '给 pairId + createdAt 建一个普通索引。\n' +
                   '不建也能用，只是记录多了翻页会慢一点。',
          showCancel: false, confirmText: '知道了'
        })
      } else {
        wx.showModal({
          title: '数据库初始化失败',
          content: String((inner && (inner.err || inner.msg)) || (r && r.err) || '未知原因') +
                   '\n\n修好后重新编译即可，这个检查会自动重跑。',
          showCancel: false, confirmText: '好'
        })
      }
    }

    step(CFG.fn.bootstrap).then(r => {
      if (r && r.ok) return finish(r)
      return step(CFG.fn.initdb).then(finish)   // bootstrap 不在就用 initdb
    })
  },

  /**
   * 取配对状态。所有页面 onShow 里 await 它，拿到 null 就跳配对页。
   * 缓存 60 秒，避免每次切 tab 都打一次云函数。
   */
  ensurePair(force) {
    const g = this.globalData
    const now = Date.now()
    if (!force && g.pair && now - (g._pairAt || 0) < 60000) {
      return Promise.resolve(g.pair)
    }
    return wx.cloud.callFunction({ name: 'pair', data: { action: 'status' } })
      .then(res => {
        const r = res.result || {}
        g.pair = r.ok ? (r.pair || null) : null
        g.openid = r.openid || g.openid
        g._pairAt = Date.now()
        g.ready = true
        return g.pair
      })
      .catch(err => {
        console.error('[ensurePair] 取配对状态失败：', err)
        g.ready = true
        return null
      })
  }
})
