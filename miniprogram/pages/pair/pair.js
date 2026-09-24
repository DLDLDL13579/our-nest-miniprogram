const app = getApp()
const { call } = require('../../utils/cloud.js')

Page({
  data: { loading: true, pair: null, code: '', chars: [], joinCode: '', joining: false },

  onShow() { this.refresh() },

  async refresh() {
    this.setData({ loading: true })
    let pair = await app.ensurePair(true)

    /* 已配对：直接进主页，别停在这一屏 */
    if (pair && pair.paired) {
      this.setData({ pair, loading: false, code: '', chars: [] })
      return
    }

    /* 没配对：要么还没建窝（create），要么建了在等人（码已经带回来了） */
    try {
      const r = await call('pair', { action: 'create' })
      if (r && r.pair) pair = r.pair
      const code = (r && r.code) || (pair && pair.inviteCode) || ''
      this.setData({
        pair, loading: false, err: '',
        code: code,
        chars: code ? code.split('').map((c, i) => ({ i: i, c: c })) : []
      })
    } catch (e) {
      /* 失败必须说出来 —— 停在「正在生成…」比报错更让人摸不着头脑 */
      this.setData({ loading: false, err: e.friendly || '连不上云端' })
    }
  },

  async regen() {
    const r = await call('pair', { action: 'create' }, { loading: '生成中' })
    if (r && r.code) this.setData({ code: r.code, chars: r.code.split('').map((c, i) => ({ i: i, c: c })) })
  },

  copyCode() {
    if (!this.data.code) return
    wx.setClipboardData({ data: this.data.code, success: () => wx.showToast({ title: '复制了，发给倩萍', icon: 'none' }) })
  },

  onInput(e) { this.setData({ joinCode: e.detail.value.toUpperCase() }) },

  async doJoin() {
    const code = (this.data.joinCode || '').trim()
    if (code.length !== 6) return wx.showToast({ title: '邀请码是 6 位', icon: 'none' })
    if (this.data.joining) return
    this.setData({ joining: true })
    try {
      const r = await call('pair', { action: 'join', code })
      app.globalData.pair = r.pair
      wx.showToast({ title: '窝建好了', icon: 'success' })
      /* 刚配对完，anniversary 还没填，直接去设置页 */
      setTimeout(() => wx.redirectTo({ url: '/pages/settings/settings?first=1' }), 700)
    } catch (e) { /* call 里已经提示过了 */ }
    this.setData({ joining: false })
  },

  goHome() { wx.switchTab({ url: '/pages/index/index' }) }
})
