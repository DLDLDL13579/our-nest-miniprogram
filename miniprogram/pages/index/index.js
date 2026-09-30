const app = getApp()
const { call, todayISO } = require('../../utils/cloud.js')
const { derive } = require('../../utils/derive.js')

const CACHE_KEY = 'homeCache'

Page({
  data: {
    loading: true, noPair: false, solo: false,
    D: null, pair: null, myName: '我', partnerName: '',
    moments: [], total: 0, todayCount: 0, onThisDay: null,
    cooling: null,
    capsuleTip: '写给未来的信',
    remindTip: '生日、纪念日、还款',
    remindUrgent: 0,
    fromCache: false
  },

  onShow() { this.load() },
  onPullDownRefresh() { this.load(true).then(() => wx.stopPullDownRefresh()) },

  /**
   * 打开顺序 —— 这是这次提速的关键。
   *
   * 之前是串行 4 次云函数（pair → moments.list → moments.stats →
   * chronicle.list → daily），每次往返 300~800ms，还得各自冷启动，
   * 所以打开要等 1.5~3 秒。
   *
   * 现在：
   *   1. 先用上次缓存立刻铺满界面（白屏变成"内容已经在，只是可能旧一点"）
   *   2. 同时发一次 home 请求 —— 一次往返、一次冷启动拿齐所有数据
   *   3. 数据回来静默替换
   */
  async load(force) {
    if (!force) this.applyCache()

    const t0 = Date.now()
    const r = await call('home', { date: todayISO() }, { silent: true }).catch(() => null)

    if (!r) {
      /* 请求失败：已经有缓存内容就留着别动，否则结束 loading 让用户能重试 */
      this.setData({ loading: false })
      return
    }
    if (!r.ok) {
      this.setData({ loading: false, noPair: r.code === 'NO_PAIR' })
      return
    }

    /* 天数这类值一律以本地 derive 为准 —— 缓存可能是昨天存的 */
    const D = r.pair && r.pair.anniversary ? derive(r.pair.anniversary) : null

    this.setData({
      loading: false, noPair: false, solo: r.solo,
      pair: r.pair, D,
      myName: r.myName, partnerName: r.partnerName,
      moments: r.moments || [], total: r.total || 0, todayCount: r.todayCount || 0,
      onThisDay: r.onThisDay || null,
      cooling: r.cooling || null,
      capsuleTip: r.capsuleReady ? (r.capsuleReady + ' 封信可以拆了') : (r.capsuleLocked ? (r.capsuleLocked + ' 封封存中') : '写给未来的信'),
      remindUrgent: r.remindUrgent || 0,
      remindTip: r.remindUrgent ? (r.remindUrgent + ' 件快到日子了，该准备了') : (r.remindNear ? (r.remindNear + ' 件在 30 天内') : '生日、纪念日、还款'),
      fromCache: false
    })
    console.log('[home] 一次往返用时', Date.now() - t0, 'ms')

    try {
      wx.setStorageSync(CACHE_KEY, {
        at: Date.now(), solo: r.solo, pair: r.pair,
        myName: r.myName, partnerName: r.partnerName,
        moments: r.moments || [], total: r.total || 0, todayCount: r.todayCount || 0,
        onThisDay: r.onThisDay || null,
        cooling: r.cooling || null
      })
    } catch (e) { /* 缓存写失败不影响主流程 */ }
  },

  /** 用缓存先把界面铺满 */
  applyCache() {
    let c = null
    try { c = wx.getStorageSync(CACHE_KEY) } catch (e) { return }
    if (!c || !c.pair) return
    /* 超过一天就当过期 —— 避免显示很旧的内容 */
    if (Date.now() - (c.at || 0) > 86400000) return

    /* D 本地重算，不直接用缓存里的天数：缓存是昨天的，天数得是今天的 */
    let D = null
    try { D = c.pair.anniversary ? derive(c.pair.anniversary) : null } catch (e) {}

    this.setData({
      loading: false, noPair: false, solo: c.solo,
      pair: c.pair, D,
      myName: c.myName || '我', partnerName: c.partnerName || '',
      moments: c.moments || [], total: c.total || 0, todayCount: c.todayCount || 0,
      onThisDay: null,
      fromCache: true
    })
  },

  goWrite() { wx.navigateTo({ url: '/pages/write/write' }) },

  previewPhoto(e) {
    const item = this.data.moments[e.currentTarget.dataset.i]
    if (!item || !item.photos || !item.photos.length) return
    wx.previewImage({ current: e.currentTarget.dataset.src, urls: item.photos })
  },

  onMomentLongPress(e) {
    const item = this.data.moments[e.currentTarget.dataset.i]
    if (!item) return
    if (!item.mine) return wx.showToast({ title: '只能删自己记的', icon: 'none' })
    wx.showActionSheet({
      itemList: ['删除这条记录'],
      itemColor: '#D9603E',
      success: async (r) => {
        if (r.tapIndex !== 0) return
        const res = await call('moments', { action: 'remove', id: item.id }, { loading: '删除中' })
      .catch((e) => { wx.showToast({ title: (e && e.friendly) || '操作失败', icon: 'none', duration: 2500 }); return null })
        if (res) {
          wx.showToast({ title: '删掉了', icon: 'none' })
          try { wx.removeStorageSync(CACHE_KEY) } catch (err) {}
          this.load(true)
        }
      }
    })
  },

  goPair() { wx.navigateTo({ url: '/pages/pair/pair' }) },
  goMood() { wx.switchTab({ url: '/pages/mood/mood' }) },
  goSettings() { wx.navigateTo({ url: '/pages/settings/settings' }) },
  goChronicle() { wx.switchTab({ url: '/pages/chronicle/chronicle' }) },
  goCapsule() { wx.navigateTo({ url: '/pages/capsule/capsule' }) },
  goReminds() { wx.navigateTo({ url: '/pages/reminds/reminds' }) },
  goGame() { wx.navigateTo({ url: '/pages/game/game' }) }
})
