/**
 * 情绪 · 冷静期
 *
 * 吵架时的「暂停键」，和好后的「复盘本」。
 *
 * 三个必须记住的点（详见 docs/v2-情绪冷静期.md）：
 *
 * ① 倒计时不用定时器 —— 只认服务端给的 deadline，本地每秒用 Date.now() 重算。
 *    定时器只负责让数字动起来，onHide 时清掉；它停了也不影响正确性。
 *
 * ② 未解锁时拿不到对方的内容 —— 这不是前端遮罩，是云函数压根没返回。
 *    所以这里不需要写"隐藏对方文字"的逻辑，没数据就是没数据。
 *
 * ③ 绝不锁人 —— 发起要对方确认、任一方随时能放弃、不阻止对方说话。
 *    调研结论：单方面停止沟通只会激怒对方，协商式暂停才有效。
 */
const app = getApp()
const { call } = require('../../utils/cloud.js')

/* 时长档位。20 是推荐值 —— 情绪淹没后身体平复至少要 20 分钟 */
const MINUTES = [
  { v: 10, t: '10 分钟', s: '还不太严重' },
  { v: 20, t: '20 分钟', s: '推荐' },
  { v: 30, t: '30 分钟', s: '' },
  { v: 60, t: '1 小时', s: '需要久一点' }
]

/* 每一步的引导语。文案按 Gottman 五步法写，不是随便想的 */
const STEP_TIP = {
  feeling: '先只说感受，不用解释为什么 —— 一解释就容易变成辩解',
  owning: '写自己这边可以更好的地方，不用写对方的',
  planning: '想一条下次可以怎么做，具体一点'
}

Page({
  data: {
    loading: true, noPair: false,
    cool: null,                      // 进行中的冷静
    list: [], rules: [],
    partnerName: 'TA', myName: '我',

    /* 倒计时显示 */
    remainText: '', remainMs: 0, timeUp: false,

    /* 发起面板 */
    starting: false, minutes: 20, reason: '',
    minuteOpts: MINUTES,

    /* 输入 */
    feelingText: '', feelingView: '',
    ownText: '', planText: '',
    saving: false,

    stepTip: '',
    staleTip: ''                     // 搁置过久的提醒
  },

  onShow() { this.load() },
  onHide() { this.stopTick() },
  onUnload() { this.stopTick() },
  onPullDownRefresh() { this.load().then(() => wx.stopPullDownRefresh()) },

  async load() {
    this.setData({ loading: true })
    const pair = await app.ensurePair()
    if (!pair) { this.setData({ loading: false, noPair: true }); return }

    const [cur, hist] = await Promise.all([
      call('mood', { action: 'current' }, { silent: true }).catch(() => null),
      call('mood', { action: 'history' }, { silent: true }).catch(() => null)
    ])

    if (cur) {
      const c = cur.cool || null
      this.setData({
        cool: c,
        myName: cur.myName || '我',
        partnerName: cur.partnerName || 'TA',
        stepTip: c ? (STEP_TIP[c.status] || '') : ''
      })
      /* 刚进到某一步时清掉上一次的输入，避免误提交旧文字 */
      if (c && c.status === 'feeling' && !c.iWroteFeeling) this.setData({ feelingText: '', feelingView: '' })
      if (c && c.status === 'owning' && !c.iWroteOwn) this.setData({ ownText: '' })
      if (c && c.status === 'planning' && !c.iWrotePlan) this.setData({ planText: '' })
    }

    if (hist) {
      this.setData({
        list: hist.list || [], rules: hist.rules || [],
        myName: hist.myName || this.data.myName,
        partnerName: hist.partnerName || this.data.partnerName
      })
      /* 搁置超过 3 天的，温和提一句（调研：那已经不是"消化情绪"了） */
      const stale = (hist.list || []).filter(x => x.idleDays >= 3)[0]
      this.setData({
        staleTip: stale ? ('有一条冷静已经过去 ' + stale.idleDays + ' 天了，要不要找她说说？') : ''
      })
    }

    this.setData({ loading: false, noPair: false })

    /* 重设倒计时基准：每次 load 都拿服务端最新的 remainMs 重新对齐 */
    this._baseAt = Date.now()
    this._pulled = false
    if (this.data.cool) this.startTick()
    else this.stopTick()
  },

  /* ---------------- 倒计时 ---------------- */

  /**
   * 走秒只是为了界面好看。
   * 真正的依据是服务端给的 deadline —— 所以即使页面被系统挂起、
   * 或者用户退出小程序，回来重算出来的值依然是对的。
   */
  startTick() {
    this.stopTick()
    this.tick()
    this._timer = setInterval(() => this.tick(), 1000)
  },
  stopTick() {
    if (this._timer) { clearInterval(this._timer); this._timer = null }
  },
  tick() {
    const c = this.data.cool
    if (!c) return this.stopTick()

    /* 服务端给了 remainMs 作为基准，这里减去本地流逝的时间 */
    const elapsed = Date.now() - (this._baseAt || Date.now())
    const left = Math.max(0, (c.remainMs || 0) - elapsed)

    const m = Math.floor(left / 60000)
    const s = Math.floor((left % 60000) / 1000)
    const up = left <= 0

    this.setData({
      remainMs: left,
      remainText: m + ':' + (s < 10 ? '0' + s : s),
      timeUp: up
    })

    /* 时间到了 → 重新拉一次，让服务端把状态推进到写感受。
       只拉一次，否则会打转。 */
    if (up && !this._pulled) {
      this._pulled = true
      this.load()
    }
  },

  /* ---------------- 发起 ---------------- */

  startPanel() { this.setData({ starting: true, minutes: 20, reason: '' }) },
  cancelPanel() { this.setData({ starting: false }) },
  pickMinutes(e) { this.setData({ minutes: Number(e.currentTarget.dataset.v) }) },
  onReason(e) { this.setData({ reason: e.detail.value }) },

  async doStart() {
    if (this.data.saving) return
    this.setData({ saving: true })
    const r = await call('mood', {
      action: 'start', minutes: this.data.minutes, reason: this.data.reason
    }, { loading: '发出去' })
      .catch((e) => { wx.showToast({ title: (e && e.friendly) || '没发出去', icon: 'none', duration: 2500 }); return null })
    this.setData({ saving: false })
    if (r) { this.setData({ starting: false, reason: '' }); this.load() }
  },

  /* ---------------- 回应（对方侧） ---------------- */

  async accept(e) {
    const how = e.currentTarget.dataset.how
    const r = await call('mood', { action: 'accept', id: this.data.cool.id, how }, { loading: '好' })
      .catch((err) => { wx.showToast({ title: (err && err.friendly) || '操作失败', icon: 'none', duration: 2500 }); return null })
    if (r) this.load()
  },

  /* ---------------- 我缓好了 ---------------- */

  async ready() {
    const r = await call('mood', { action: 'ready', id: this.data.cool.id }, { loading: '好' })
      .catch((e) => { wx.showToast({ title: (e && e.friendly) || '操作失败', icon: 'none', duration: 2500 }); return null })
    if (r) this.load()
  },

  /* ---------------- 放弃 ---------------- */

  drop() {
    wx.showModal({
      title: '这次先算了？',
      content: '记录不会归档，也不会进历史。随时可以重新发起。',
      confirmText: '算了',
      success: async (m) => {
        if (!m.confirm) return
        const r = await call('mood', { action: 'drop', id: this.data.cool.id }, { loading: '好' })
          .catch((e) => { wx.showToast({ title: (e && e.friendly) || '操作失败', icon: 'none', duration: 2500 }); return null })
        if (r) this.load()
      }
    })
  },

  /* ---------------- 三个输入 ---------------- */

  onFeeling(e) { this.setData({ feelingText: e.detail.value }) },
  onView(e) { this.setData({ feelingView: e.detail.value }) },
  onOwn(e) { this.setData({ ownText: e.detail.value }) },
  onPlan(e) { this.setData({ planText: e.detail.value }) },

  async saveFeeling() {
    const text = (this.data.feelingText || '').trim()
    if (!text) return wx.showToast({ title: '写一句你当时的感受', icon: 'none' })
    if (this.data.saving) return
    this.setData({ saving: true })
    const r = await call('mood', {
      action: 'feel', id: this.data.cool.id, text, view: this.data.feelingView
    }, { loading: '记下' })
      .catch((e) => { wx.showToast({ title: (e && e.friendly) || '没存上', icon: 'none', duration: 2500 }); return null })
    this.setData({ saving: false })
    if (r) { wx.showToast({ title: '写好了', icon: 'success' }); this.load() }
  },

  async saveOwn() {
    const text = (this.data.ownText || '').trim()
    if (!text) return wx.showToast({ title: '写一句就好，哪怕很小', icon: 'none' })
    if (this.data.saving) return
    this.setData({ saving: true })
    const r = await call('mood', { action: 'own', id: this.data.cool.id, text }, { loading: '记下' })
      .catch((e) => { wx.showToast({ title: (e && e.friendly) || '没存上', icon: 'none', duration: 2500 }); return null })
    this.setData({ saving: false })
    if (r) { wx.showToast({ title: '写好了', icon: 'success' }); this.load() }
  },

  async savePlan() {
    const text = (this.data.planText || '').trim()
    if (!text) return wx.showToast({ title: '想一条下次可以怎么做', icon: 'none' })
    if (this.data.saving) return
    this.setData({ saving: true })
    const r = await call('mood', { action: 'plan', id: this.data.cool.id, text }, { loading: '记下' })
      .catch((e) => { wx.showToast({ title: (e && e.friendly) || '没存上', icon: 'none', duration: 2500 }); return null })
    this.setData({ saving: false })
    if (r) { wx.showToast({ title: '记进规矩本了', icon: 'success' }); this.load() }
  },

  /* 走完或放弃之后回首页 —— mood 是 tab 页，必须用 switchTab */
  goHome() { wx.switchTab({ url: '/pages/index/index' }) }
})
