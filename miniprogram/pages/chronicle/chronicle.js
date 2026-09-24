const app = getApp()
const { call } = require('../../utils/cloud.js')
const { derive } = require('../../utils/derive.js')

Page({
  data: {
    loading: true, noPair: false,
    list: [], onThisDay: null, ms: [], stats: null,
    D: null, filter: 'all', empty: false
  },

  onShow() { this.load() },
  onPullDownRefresh() { this.load(true).then(() => wx.stopPullDownRefresh()) },

  async load(force) {
    /* 先用缓存铺满，再静默刷新 —— 和首页同一套策略 */
    if (!force) this.applyCache()
    else this.setData({ loading: true })

    const pair = await app.ensurePair()
    if (!pair) { this.setData({ loading: false, noPair: true }); return }

    const D = pair.anniversary ? derive(pair.anniversary) : null
    this.setData({ D, noPair: false })

    /* 这两个查询互不依赖，改成并发 —— 原来串行等于白等一次往返 */
    const [r, st] = await Promise.all([
      call('chronicle', { action: 'list', size: 30 }, { silent: true }).catch(() => null),
      call('chronicle', { action: 'stats' }, { silent: true }).catch(() => null)
    ])

    if (r) {
      this.rawList = r.list || []
      this.setData({
        list: this.filterList(this.rawList, this.data.filter),
        onThisDay: r.onThisDay || null,
        ms: r.milestones || [],
        empty: !this.rawList.length && !r.onThisDay
      })
    }
    if (st) this.setData({ stats: st })
    this.setData({ loading: false, noPair: false, fromCache: false })

    try {
      wx.setStorageSync('chronicleCache', {
        at: Date.now(), D: r && r.D ? r.D : null,
        raw: this.rawList || [], ms: (r && r.milestones) || [],
        onThisDay: (r && r.onThisDay) || null, stats: st || null
      })
    } catch (e) {}
  },

  applyCache() {
    let c = null
    try { c = wx.getStorageSync('chronicleCache') } catch (e) { return }
    if (!c || Date.now() - (c.at || 0) > 3600000) return   // 编年史缓存 1 小时
    this.rawList = c.raw || []
    this.setData({
      loading: false, noPair: false, fromCache: true,
      list: this.filterList(this.rawList, this.data.filter),
      ms: c.ms || [], onThisDay: c.onThisDay || null, stats: c.stats || null,
      empty: !this.rawList.length && !c.onThisDay
    })
  },

  /**
   * 筛选。
   * 注意不能用 getter —— Page 上的 getter 不会被 setData 触发重渲染，
   * wxml 里读 {{visible}} 会一直拿到第一次的值。必须算好塞进 data。
   */
  setFilter(e) {
    const f = e.currentTarget.dataset.f
    this.setData({ filter: f, list: this.filterList(this.rawList || [], f) })
  },

  filterList(list, f) {
    if (f === 'all') return list
    return list
      .map(d => Object.assign({}, d, { items: d.items.filter(i => i.who === f) }))
      .filter(d => d.items.length > 0)
  },

  openDay(e) {
    const date = e.currentTarget.dataset.date
    wx.navigateTo({ url: '/pages/chronicle/day/day?date=' + date })
  },

  /**
   * 点图片看大图 —— 必须用原图，列表里显示的是缩略图，放大看是糊的。
   * 之前这个方法没定义，点图片直接抛 "previewPhoto is not a function"，
   * 表现就是"图片点不开"。
   */
  previewPhoto(e) {
    const urls = e.currentTarget.dataset.list || []
    if (!urls.length) return
    wx.previewImage({ current: e.currentTarget.dataset.src, urls })
  },

  /* 未配对时那个按钮原本绑的是 goAnswer —— 今日一题遗留的方法名，
     js 里早就没有了，点了毫无反应。改成跳配对页。 */
  goPair() { wx.navigateTo({ url: '/pages/pair/pair' }) },

  goWrite() { wx.navigateTo({ url: '/pages/write/write' }) }
})
