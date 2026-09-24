const app = getApp()
const { call } = require('../../utils/cloud.js')
const { derive } = require('../../utils/derive.js')

/* wxml 里不能 filter，"下一个里程碑"必须在 js 里挑出来 */
function nextMilestone(D) {
  if (!D) return '—'
  for (var i = 0; i < D.milestones.length; i++) if (D.milestones[i].isNext) return D.milestones[i].label
  return '—'
}

Page({
  data: {
    loading: true, first: false, pair: null,
    anniv: '', D: null, nextMs: '—', myName: '', saving: false,
    today: new Date().toISOString().slice(0, 10)
  },

  async onLoad(q) {
    this.setData({ first: !!(q && q.first) })
    const pair = await app.ensurePair()
    if (!pair) return wx.redirectTo({ url: '/pages/pair/pair' })
    this.setData({
      loading: false, pair,
      anniv: pair.anniversary || '',
      myName: pair.myName === '我' ? '' : pair.myName
    })
    if (pair.anniversary) { const D = derive(pair.anniversary); this.setData({ D, nextMs: nextMilestone(D) }) }
  },

  /* 只改一个 state，预览整块重算 —— 这就是"不写死"在界面上的样子 */
  onDate(e) {
    const v = e.detail.value
    const D = v ? derive(v) : null
    this.setData({ anniv: v, D, nextMs: nextMilestone(D) })
  },

  onName(e) { this.setData({ myName: e.detail.value } ) },

  async save() {
    if (!this.data.anniv) return wx.showToast({ title: '先选在一起的那天', icon: 'none' })
    if (this.data.saving) return
    this.setData({ saving: true })
    const r = await call('pair', {
      action: 'set', anniversary: this.data.anniv, myName: this.data.myName
    }, { loading: '保存中' })
      .catch((e) => { wx.showToast({ title: (e && e.friendly) || '操作失败', icon: 'none', duration: 2500 }); return null })
    if (r) {
      app.globalData.pair = r.pair
      wx.showToast({ title: '存好了', icon: 'success' })
      setTimeout(() => {
        if (this.data.first) wx.switchTab({ url: '/pages/index/index' })
        else this.onLoad({})
      }, 600)
    }
    this.setData({ saving: false })
  },

  goPair() { wx.navigateTo({ url: '/pages/pair/pair' }) }
})
