const app = getApp()
const { call, todayISO } = require('../../utils/cloud.js')
const privacy = require('../../utils/privacy.js')
const media = require('../../utils/media.js')

/* 给几个常用的未来日子，省得每次翻日历 */
function quickPicks() {
  const d = new Date()
  const fmt = (dt) => {
    const p = n => (n < 10 ? '0' + n : '' + n)
    return dt.getFullYear() + '-' + p(dt.getMonth() + 1) + '-' + p(dt.getDate())
  }
  const add = (days) => { const x = new Date(d.getTime() + days * 86400000); return fmt(x) }
  const addY = (years) => { const x = new Date(d); x.setFullYear(x.getFullYear() + years); return fmt(x) }
  return [
    { label: '100 天后', value: add(100) },
    { label: '一年后', value: addY(1) },
    { label: '三年后', value: addY(3) },
    { label: '五年后', value: addY(5) }
  ]
}

Page({
  data: {
    loading: true, noPair: false,
    list: [], locked: 0, ready: 0, total: 0,
    /* 写信面板 */
    writing: false, title: '', text: '', unlockAt: '',
    picks: quickPicks(), photos: [], thumbs: [],
    reading: null,          // 正在读的那封
    replyText: '',
    saving: false
  },

  onShow() { this.load() },
  onPullDownRefresh() { this.load().then(() => wx.stopPullDownRefresh()) },

  async load() {
    this.setData({ loading: true })
    const pair = await app.ensurePair()
    if (!pair) { this.setData({ loading: false, noPair: true }); return }
    const r = await call('capsule', { action: 'list' }, { silent: true }).catch(() => null)
    if (r) {
      this.setData({
        list: r.list || [], locked: r.locked || 0, ready: r.ready || 0,
        total: r.total || 0
      })
    }
    this.setData({ loading: false, noPair: false })
  },

  /* ---------- 写一封 ---------- */
  startWrite() {
    /* 默认给"一年后" —— 大多数人想写的就是这个跨度 */
    const y = quickPicks()[1].value
    this.setData({ writing: true, title: '', text: '', unlockAt: y, photos: [], thumbs: [] })
  },
  cancelWrite() { this.setData({ writing: false }) },
  onTitle(e) { this.setData({ title: e.detail.value }) },
  onText(e) { this.setData({ text: e.detail.value }) },
  onDate(e) { this.setData({ unlockAt: e.detail.value }) },
  pickQuick(e) { this.setData({ unlockAt: e.currentTarget.dataset.v }) },

  async addPhoto() {
    if (this.data.photos.length >= 3) return wx.showToast({ title: '最多 3 张', icon: 'none' })
    const allowed = await privacy.ensure()
    if (!allowed) return
    wx.chooseMedia({
      count: 3 - this.data.photos.length, mediaType: ['image'],
      sourceType: ['camera', 'album'], sizeType: ['compressed'], camera: 'back',
      success: async (res) => {
        wx.showLoading({ title: '上传中', mask: true })
        const ps = this.data.photos.slice(), ts = this.data.thumbs.slice()
        for (const f of res.tempFiles) {
          try {
            const up = await media.uploadWithThumb(f.tempFilePath, 'capsules')
            ps.push(up.full); ts.push(up.thumb)
          } catch (e) {}
        }
        wx.hideLoading()
        this.setData({ photos: ps, thumbs: ts })
      }
    })
  },

  previewPhoto(e) {
    const urls = this.data.writing ? this.data.photos : ((this.data.reading || {}).photos || [])
    if (!urls.length) return
    wx.previewImage({ current: e.currentTarget.dataset.src, urls })
  },

  async save() {
    const text = (this.data.text || '').trim()
    if (!text) return wx.showToast({ title: '写点什么再封存', icon: 'none' })
    if (!this.data.unlockAt) return wx.showToast({ title: '选一个能打开的日子', icon: 'none' })
    if (this.data.saving) return
    this.setData({ saving: true })

    const r = await call('capsule', {
      action: 'add', title: this.data.title, text,
      photos: this.data.photos, thumbs: this.data.thumbs,
      unlockAt: this.data.unlockAt
    }, { loading: '封存中' })
      .catch((e) => { wx.showToast({ title: (e && e.friendly) || '操作失败', icon: 'none', duration: 2500 }); return null })

    this.setData({ saving: false })
    if (r) {
      wx.showModal({
        title: '封存好了',
        content: r.daysLeft + ' 天后的这一天，它才会打开。\n在那之前，连你自己也看不到里面的字。',
        showCancel: false, confirmText: '好'
      })
      this.setData({ writing: false, text: '', title: '', photos: [], thumbs: [] })
      this.load()
    }
  },

  /* ---------- 打开一封 ---------- */
  async open(e) {
    const id = e.currentTarget.dataset.id
    const item = this.data.list.filter(x => x.id === id)[0]
    if (!item) return
    if (!item.unlocked) {
      return wx.showToast({ title: '还有 ' + item.daysLeft + ' 天', icon: 'none' })
    }
    const r = await call('capsule', { action: 'open', id }, { loading: '拆开' })
      .catch((e) => { wx.showToast({ title: (e && e.friendly) || '操作失败', icon: 'none', duration: 2500 }); return null })
    if (r) {
      this.setData({
        reading: { id, title: r.title, text: r.text, photos: r.photos || [], at: item.createdAt },
        replyText: ''
      })
      this.load()
    }
  },
  closeReading() { this.setData({ reading: null, replyText: '' }) },
  onReply(e) { this.setData({ replyText: e.detail.value }) },

  async sendReply() {
    const text = (this.data.replyText || '').trim()
    if (!text) return wx.showToast({ title: '写点什么', icon: 'none' })
    const r = await call('capsule', {
      action: 'reply', id: this.data.reading.id, text
    }, { loading: '寄出' })
      .catch((e) => { wx.showToast({ title: (e && e.friendly) || '操作失败', icon: 'none', duration: 2500 }); return null })
    if (r) {
      wx.showToast({ title: '收到了', icon: 'success' })
      this.setData({ reading: null, replyText: '' })
      this.load()
    }
  },

  remove(e) {
    const id = e.currentTarget.dataset.id
    wx.showModal({
      title: '删掉这封信？',
      content: '还没到期才能删。删了就找不回来了。',
      success: async (m) => {
        if (!m.confirm) return
        const r = await call('capsule', { action: 'remove', id }, { loading: '删除中' })
      .catch((e) => { wx.showToast({ title: (e && e.friendly) || '操作失败', icon: 'none', duration: 2500 }); return null })
        if (r) this.load()
      }
    })
  }
})
