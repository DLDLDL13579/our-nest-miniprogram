const app = getApp()
const { call, todayISO } = require('../../utils/cloud.js')

const LEADS = [
  { v: 0, t: '当天' },
  { v: 3, t: '提前 3 天' },
  { v: 7, t: '提前一周' },
  { v: 14, t: '提前两周' },
  { v: 30, t: '提前一月' }
]
const REPEATS = [
  { v: 'yearly', t: '每年' },
  { v: 'monthly', t: '每月' },
  { v: 'once', t: '只一次' }
]
const WHOS = ['她家', '我家', '我们']

Page({
  data: {
    loading: true, noPair: false,
    list: [], urgent: 0, total: 0,
    leads: LEADS, repeats: REPEATS, whos: WHOS,
    adding: false,
    f: { title: '', date: '', repeat: 'yearly', leadDays: 14, who: '她家', lastGift: '' },
    editing: null,
    giftText: ''
  },

  onShow() { this.load() },
  onPullDownRefresh() { this.load().then(() => wx.stopPullDownRefresh()) },

  async load() {
    this.setData({ loading: true })
    const pair = await app.ensurePair()
    if (!pair) { this.setData({ loading: false, noPair: true }); return }
    const r = await call('reminds', { action: 'list' }, { silent: true }).catch(() => null)
    if (r) this.setData({ list: r.list || [], urgent: r.urgent || 0, total: r.total || 0 })
    this.setData({ loading: false, noPair: false })
  },

  /* ---------- 新增 ---------- */
  startAdd() {
    this.setData({
      adding: true,
      f: { title: '', date: '', repeat: 'yearly', leadDays: 14, who: '她家', lastGift: '' }
    })
  },
  cancelAdd() { this.setData({ adding: false }) },
  onTitle(e) { this.setData({ 'f.title': e.detail.value }) },
  onDate(e) { this.setData({ 'f.date': e.detail.value }) },
  onGift(e) { this.setData({ 'f.lastGift': e.detail.value }) },
  pickRepeat(e) { this.setData({ 'f.repeat': e.currentTarget.dataset.v }) },
  pickLead(e) { this.setData({ 'f.leadDays': Number(e.currentTarget.dataset.v) }) },
  pickWho(e) { this.setData({ 'f.who': e.currentTarget.dataset.v }) },

  async save() {
    const f = this.data.f
    if (!f.title.trim()) return wx.showToast({ title: '写一件要记得的事', icon: 'none' })
    if (!f.date) return wx.showToast({ title: '选一个日期', icon: 'none' })
    /* 显式列字段，不用 ...f 展开 —— 展开在小程序里行为不稳，
       而且显式写出来，发出去的参数一眼可见，排查时不用回头猜 */
    const r = await call('reminds', {
      action: 'add',
      title: f.title,
      date: f.date,
      repeat: f.repeat,
      leadDays: f.leadDays,
      who: f.who,
      lastGift: f.lastGift
    }, { loading: '记下' })
      .catch((e) => { wx.showToast({ title: (e && e.friendly) || '操作失败', icon: 'none', duration: 2500 }); return null })

    if (r && r.ok) {
      this.setData({ adding: false })
      this.load()
    } else {
      /* 失败必须让用户看见 —— 之前静默吞掉，表现就是"点了没反应" */
      wx.showToast({ title: (r && r.msg) || '没存上，再试一次', icon: 'none', duration: 2500 })
    }
  },

  /* ---------- 补记"去年送了什么" ---------- */
  startGift(e) {
    const id = e.currentTarget.dataset.id
    const item = this.data.list.filter(x => x.id === id)[0]
    this.setData({ editing: id, giftText: (item && item.lastGift) || '' })
  },
  onGiftInput(e) { this.setData({ giftText: e.detail.value }) },
  cancelGift() { this.setData({ editing: null, giftText: '' }) },

  async saveGift() {
    const r = await call('reminds', {
      action: 'update', id: this.data.editing, lastGift: this.data.giftText
    }, { loading: '记下' })
      .catch((e) => { wx.showToast({ title: (e && e.friendly) || '操作失败', icon: 'none', duration: 2500 }); return null })
    if (r) { this.setData({ editing: null, giftText: '' }); this.load() }
  },

  remove(e) {
    const id = e.currentTarget.dataset.id
    wx.showModal({
      title: '删掉这一条？', content: '删了就找不回来了。',
      success: async (m) => {
        if (!m.confirm) return
        const r = await call('reminds', { action: 'remove', id }, { loading: '删除中' })
      .catch((e) => { wx.showToast({ title: (e && e.friendly) || '操作失败', icon: 'none', duration: 2500 }); return null })
        if (r) this.load()
      }
    })
  },

  /* 剩余天数的显示：进窗口的说"该准备了"，不是干巴巴一个数字 */
  nothing() {}
})
