const app = getApp()
const { call } = require('../../utils/cloud.js')
const privacy = require('../../utils/privacy.js')
const media = require('../../utils/media.js')

Page({
  data: {
    loading: true, noPair: false,
    list: [], total: 0, doneCount: 0, todoCount: 0,
    tab: 'todo',                 // todo | done
    adding: false, newText: '',
    partnerName: 'TA'
  },

  onShow() { this.load() },
  onPullDownRefresh() { this.load(true).then(() => wx.stopPullDownRefresh()) },

  async load(force) {
    if (!force) this.applyCache()
    else this.setData({ loading: true })

    const pair = await app.ensurePair()
    if (!pair) { this.setData({ loading: false, noPair: true }); return }
    const r = await call('wishes', { action: 'list' }, { silent: true }).catch(() => null)
    if (r) {
      this.all = r.list
      this.setData({
        total: r.total, doneCount: r.doneCount, todoCount: r.todoCount,
        partnerName: r.partnerName
      })
      this.applyTab(this.data.tab)
    }
    this.setData({ loading: false, noPair: false, fromCache: false })
    try {
      wx.setStorageSync('wishesCache', {
        at: Date.now(), all: this.all || [],
        total: this.data.total, doneCount: this.data.doneCount,
        todoCount: this.data.todoCount, partnerName: this.data.partnerName
      })
    } catch (e) {}
  },

  applyCache() {
    let c = null
    try { c = wx.getStorageSync('wishesCache') } catch (e) { return }
    if (!c || Date.now() - (c.at || 0) > 3600000) return
    this.all = c.all || []
    this.setData({
      loading: false, noPair: false, fromCache: true,
      total: c.total || 0, doneCount: c.doneCount || 0,
      todoCount: c.todoCount || 0, partnerName: c.partnerName || 'TA'
    })
    this.applyTab(this.data.tab)
  },

  applyTab(tab) {
    const list = (this.all || []).filter(w => tab === 'done' ? w.done : !w.done)
    this.setData({ tab, list })
  },

  setTab(e) { this.applyTab(e.currentTarget.dataset.t) },

  /* ---------- 新增 ---------- */
  startAdd() { this.setData({ adding: true, newText: '' }) },
  cancelAdd() { this.setData({ adding: false }) },
  onNewInput(e) { this.setData({ newText: e.detail.value }) },

  async doAdd() {
    const text = (this.data.newText || '').trim()
    if (!text) return wx.showToast({ title: '写一件想一起做的事', icon: 'none' })
    const r = await call('wishes', { action: 'add', text }, { loading: '记下' })
      .catch((e) => { wx.showToast({ title: (e && e.friendly) || '操作失败', icon: 'none', duration: 2500 }); return null })
    if (r) { this.setData({ adding: false, newText: '' }); this.load() }
  },

  /* ---------- 点亮：拍一张 → 上传 → 标记完成 ---------- */
  async light(e) {
    const id = e.currentTarget.dataset.id
    const item = this.data.list.filter(w => w.id === id)[0]
    try {
      const up = await this.pickAndUpload()
      if (!up) return
      const r = await call('wishes', {
        action: 'done', id, photo: up.full, photoThumb: up.thumb
      }, { loading: '点亮中' })
      .catch((e) => { wx.showToast({ title: (e && e.friendly) || '操作失败', icon: 'none', duration: 2500 }); return null })
      if (r) {
        wx.showToast({ title: '点亮了', icon: 'success' })
        this.load()
      }
    } catch (err) {
      wx.showToast({ title: '照片没传上去，再试一次', icon: 'none' })
    }
  },

  async pickAndUpload() {
    const allowed = await privacy.ensure()
    if (!allowed) return null
    return new Promise((resolve, reject) => {
      wx.chooseMedia({
        count: 1, mediaType: ['image'], sourceType: ['camera', 'album'],
        sizeType: ['compressed'], camera: 'back',
        success: async (res) => {
          const path = res.tempFiles[0].tempFilePath
          wx.showLoading({ title: '上传照片', mask: true })
          try {
            const up = await media.uploadWithThumb(path, 'wishes')
            wx.hideLoading()
            resolve(up)                       // { full, thumb }
          } catch (err) {
            wx.hideLoading()
            reject(err)
          }
        },
        fail: () => resolve(null)     // 用户取消，静默返回
      })
    })
  },

  /* 点照片看大图 —— 用原图，列表里那张是缩略图 */
  previewPhoto(e) {
    const url = e.currentTarget.dataset.src
    if (!url) return
    wx.previewImage({ current: url, urls: [url] })
  },

  undo(e) {
    const id = e.currentTarget.dataset.id
    wx.showModal({
      title: '撤销点亮？', content: '照片会一起删掉，这一件回到"想去"。',
      success: async (m) => {
        if (!m.confirm) return
        const r = await call('wishes', { action: 'undo', id }, { loading: '撤销中' })
      .catch((e) => { wx.showToast({ title: (e && e.friendly) || '操作失败', icon: 'none', duration: 2500 }); return null })
        if (r) this.load()
      }
    })
  },

  remove(e) {
    const id = e.currentTarget.dataset.id
    wx.showModal({
      title: '删掉这件？', content: '删了就找不回来了。',
      success: async (m) => {
        if (!m.confirm) return
        const r = await call('wishes', { action: 'remove', id }, { loading: '删除中' })
      .catch((e) => { wx.showToast({ title: (e && e.friendly) || '操作失败', icon: 'none', duration: 2500 }); return null })
        if (r) this.load()
      }
    })
  }
})
