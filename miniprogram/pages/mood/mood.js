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
const icons = require('../../utils/icons.js')
/* 图标：内联 SVG 替代 emoji（跨机型渲染不一致，见 utils/icons.js） */
const _IC = {}
for (const _k of ['speech', 'dove', 'leaf', 'sunCloud', 'check']) { _IC[_k] = icons.dataUri(_k, '#C4553F') }

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
    ic: _IC,
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

  /*
   * ★ `_visible` —— 页面可见性标志。
   *   为什么需要：load() 里有 3 个 await（ensurePair + current + history），
   *   而 await 期间用户可能已经切走了。onHide 虽然停掉了走秒，
   *   但 await 返回后 load() 结尾又会 startTick() **把定时器重新拉起来** ——
   *   于是隐藏的页面继续每秒 setData。（mood 是 tab 页，不会被卸载，
   *   所以这是"后台空转"而不是崩溃，但同样该修。）
   */
  onShow() { this._visible = true; this.load() },
  onHide() { this._visible = false; this.stopTick() },
  onUnload() { this._visible = false; this.stopTick() },
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

    /*
     * ★★ `_pulled` 不能在这里无条件重置（2026-10-09 修的真实缺陷）。
     *
     * 它表示「倒计时归零后已经拉过一次状态」，用来保证只拉一次。
     * 原来这里写死 `this._pulled = false`，于是和 tick() 组成死循环：
     *
     *     tick(): left<=0 且 !_pulled  →  _pulled=true; load()
     *     load(): _pulled = false;  若 cool 非空 → startTick()
     *              ↑______________________________________|
     *
     * 为什么 cool 不会变空：云端 `active` 只在「放弃」时置 false，
     * **倒计时归零本身不改它**（否则就变成"到点自动结束"，违背设计）。
     * 所以 remainMs 恒为 0 → 每秒一次 load → 每次 2 个云函数调用（current+history），
     * 而且 load() 首行的 setData({loading:true}) 会让整页**每秒闪一次**
     * （wxml 是 wx:if="{{loading}}" 互斥分支）—— 页面直接没法用。
     *
     * 修法：只有当服务端**又给出一个未来的截止时刻**（remainMs > 0，
     * 即新一次冷静期开始）才重置 _pulled，让它有机会再拉一次。
     */
    const remain = (this.data.cool && this.data.cool.remainMs) || 0
    if (remain > 0) this._pulled = false

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
    /* 页面不可见就别起定时器（见 _visible 的注释） */
    if (this._visible === false) return
    /* ★ 用 tick() 的返回值决定要不要起表 —— 它返回 false 表示
       "已经归零/没有进行中的冷静期"，那时界面停在 0:00，不需要再走秒。 */
    if (this.tick() === false) return
    this._timer = setInterval(() => this.tick(), 1000)
  },
  stopTick() {
    if (this._timer) { clearInterval(this._timer); this._timer = null }
  },
  /**
   * 走一帧倒计时。
   * @returns {boolean} 是否还需要继续走秒（false = 该停了）
   *   ★ 用返回值而不是"看 _timer 有没有被设过"来表达 —— 后者不成立：
   *     startTick 会先 stopTick 清掉 _timer，再去调 tick，
   *     所以 tick 执行完 _timer 一定是 null，判断不出"该不该起表"。
   */
  tick() {
    const c = this.data.cool
    if (!c) { this.stopTick(); return false }
    if (this._visible === false) { this.stopTick(); return false }

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

    /*
     * 时间到了 → 重新拉一次，让服务端把状态推进到「写感受」。
     *
     * ★ 只拉一次，**然后停掉走秒** —— 两件事缺一不可：
     *   · 只拉一次：否则每秒一次云函数调用（详见 load() 里 _pulled 的注释）
     *   · 停掉走秒：归零后界面已经不需要每秒更新了（显示的就是 0:00），
     *     留着定时器等于让页面永远空转
     *
     * 之后的状态推进由**用户操作**驱动 —— 提交感受/责任/约定时
     * 每个入口都会 load()，所以不需要轮询。
     */
    if (up) {
      this.stopTick()
      if (!this._pulled) {
        this._pulled = true
        this.load()
      }
      return false            // 归零了，不用再走秒
    }
    return true
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
