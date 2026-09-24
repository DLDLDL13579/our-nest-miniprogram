const { call } = require('../../../utils/cloud.js')

Page({
  data: { loading: true, d: null },

  onLoad(q) {
    this.date = q.date
    /* 标题带上日期 —— 从编年史点进来时，一眼知道翻的是哪一天 */
    if (this.date) wx.setNavigationBarTitle({ title: this.date })
    this.load()
  },

  onPullDownRefresh() { this.load().then(() => wx.stopPullDownRefresh()) },

  async load() {
    const r = await call('chronicle', { action: 'day', date: this.date }, { silent: true })
      .catch(() => null)
    /* 失败时 d 保持 null，页面会显示「这一天还没有记录」，
       不会再像原来那样弹一个 loading 然后留一片空白 */
    this.setData({ loading: false, d: r || null })
  },

  /* 点照片看大图 —— 和编年史列表同一套：列表小图，点开原图 */
  previewPhoto(e) {
    const urls = e.currentTarget.dataset.list || []
    if (!urls.length) return
    wx.previewImage({ current: e.currentTarget.dataset.src, urls })
  }
})
