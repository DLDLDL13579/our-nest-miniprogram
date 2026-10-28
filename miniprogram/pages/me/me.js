/**
 * 我的（tabBar 第二页）
 *
 * 改造前这里是「设置」—— 内容是「在一起的那天」和配对信息，配对没了就整页失效。
 * 现在只留三件与游戏有关的事：**我叫什么 / 声音开关 / 关于**。
 *
 * ★ 昵称为什么存本机而不进服务端：
 *   酒桌游戏是"坐下来玩一会儿"，不该为了玩一局先填一堆资料。
 *   进房间时把昵称带在 create/join 的参数里，服务端只存这次房间用的名字。
 *   换设备就重新起个名字 —— 这对酒桌场景是优点，不是缺陷。
 */
const sfx = require('../../utils/sfx.js')
const haptic = require('../../utils/haptic.js')
const iconSet = require('../../utils/iconSet.js')
const { GAMES } = require('../../utils/games.js')

const _IC = iconSet.build(['dice', 'chevronRight'], '#C4553F')

const NICK_KEY = 'nick'

Page({
  data: {
    ic: _IC,
    nick: '',
    muted: false,
    hapticOn: true,
    reduceMotion: false,
    nightGames: 0,
    errCount: 0,
    gameCount: GAMES.length,
    /* 每个玩法开过几次桌（本地统计）—— 0 次的也列出来，让"还没玩过"可见 */
    gameRows: [],
    /*
     * ⚠️ 版本号是手写的常量，**改发版号时记得同步这里**。
     *    （上一轮它一直停在 3.0.0，而实际已经是 3.7.x —— 用户看到的版本
     *    和 commit 里的版本对不上，排查问题时会误判。）
     */
    /* 版本号来自 config.js（单一来源）—— 硬编码在这里会悄悄过时 */
    /* 版本号来自 config.js（单一来源）—— 硬编码在这里会悄悄过时 */
    version: require('../../config.js').version
  },

  onLoad() {
    this.setData({
      nick: wx.getStorageSync(NICK_KEY) || '',
      muted: sfx.isMuted(),
      hapticOn: haptic.isHapticOn(),
      reduceMotion: haptic.isReduceMotion(),
      errCount: 0,
      /* 由 refreshDiagnostics() 在 onShow 时重算（见下面的说明） */
      nightGames: 0
    })
  },

  /**
   * 玩法统计行。
   * ★ 按"开过次数"降序，但**0 次的也列出来** —— 让"还没玩过"这件事可见，
   *   等于一个弱引导（酒桌上翻到"还没玩过"会想试一下）。
   */
  loadStats() {
    let st = {}
    try { st = wx.getStorageSync('gameStats') || {} } catch (e) {}
    const rows = GAMES.map(g => ({
      id: g.id,
      name: g.name,
      color: g.color,
      count: Number(st[g.id]) || 0
    })).sort((a, b) => b.count - a.count)
    this.setData({ gameRows: rows })
  },

  /* 从房间回来时同步开关（房间页里也能改） */
  onShow() {
    this.setData({ muted: sfx.isMuted(), hapticOn: haptic.isHapticOn() })
    this.loadStats()
    this.refreshDiagnostics()
  },

  /**
   * 重算"今晚几局 / 最近几条错误"（2026-10-28）。
   *
   * ⚠️ 这两个数字只有在**玩完之后**才会变，而页面是 tabBar 页 ——
   *    用户从房间回来时页面**不会重建**，只在 onShow 重算才看得到新值。
   *    原来它们放在 data 的 IIFE 里，等于"只在第一次进这个 tab 时算一遍"，
   *    后面永远是旧的。
   *
   *    （大厅的"上次玩的"排序是同一个毛病的另一个实例：那次的测试也没调 onShow。）
   */
  refreshDiagnostics() {
    let n = 0
    try {
      const d = new Date()
      const today = d.getFullYear() + '-' + (d.getMonth() + 1) + '-' + d.getDate()
      const rec = wx.getStorageSync('nightGames') || {}
      n = rec.date === today ? (Number(rec.n) || 0) : 0
    } catch (e) {}
    let errs = 0
    try { errs = (wx.getStorageSync('errLog') || []).length } catch (e) {}
    this.setData({ nightGames: n, errCount: errs })
  },

  onNick(e) { this.setData({ nick: e.detail.value }) },

  /* 失焦才落盘：边打字边写 storage 是没必要的 IO，
     而且中途的半截名字（比如"邓"）会覆盖掉完整的名字。 */
  saveNick() {
    const v = String(this.data.nick || '').trim().slice(0, 12)
    wx.setStorageSync(NICK_KEY, v)
  },

  toggleMute() {
    const m = sfx.setMuted(!this.data.muted)
    this.setData({ muted: m })
    /* 打开音效时给一声，让用户当场听到"确实有声音了" */
    if (!m) sfx.play('tick')
  },

  /**
   * 复制错误记录（2026-10-28）。
   * 给的是**可粘进聊天窗口的纯文本**，不是 JSON —— 用户在手机上不会看 JSON。
   */
  /**
   * 复制诊断信息（2026-10-28）。
   *
   * 用户说"卡"的时候，机型 / 基础库 / 屏幕这三样决定了我该往哪查：
   *   · 老机型掉帧 → 砍 drop-shadow 这类贵的效果
   *   · 基础库版本低 → 某个 API 可能不支持（如 vibrateShort 的 type）
   *   · 屏幕比例怪 → 布局可能错位
   * 没有这些数字，我只能一个个问，而用户往往会说"就是普通手机"。
   */
  copyDiag() {
    sfx.play('tick')
    var info = {}
    try { info = wx.getSystemInfoSync() } catch (e) {}
    var cfg = require('../../config.js')
    var lines = [
      '酒桌 诊断信息',
      '版本: ' + (cfg.version || '?'),
      '机型: ' + (info.model || '?'),
      '系统: ' + (info.system || '?'),
      '微信: ' + (info.version || '?'),
      '基础库: ' + (info.SDKVersion || '?'),
      '屏幕: ' + (info.windowWidth || '?') + 'x' + (info.windowHeight || '?') + ' @' + (info.pixelRatio || '?') + 'x',
      '网络: ' + ((info.networkType || '?').toLowerCase()),
      '上次启动: ' + (function () {
        try {
          var ms = wx.getStorageSync('lastBootMs')
          return ms ? (ms / 1000).toFixed(1) + ' 秒（加载+首屏渲染）' : '还没记录'
        } catch (e) { return '?' }
      })()
    ]
    /*
     * 顺手把最近的错误也带上（2026-10-28）。
     * 原来"诊断信息"和"错误记录"是两个入口 —— 而用户遇到问题时
     * **不知道该点哪个**，多半只点一个。一次复制全部，粘给我什么都有。
     * 只带最近 5 条：20 条 × 160 字太长，微信输入框里翻起来很难受。
     */
    try {
      var errs = wx.getStorageSync('errLog') || []
      if (errs.length) {
        lines.push('')
        lines.push('最近 ' + errs.length + ' 条错误:' + (errs.length > 5 ? '（只列最近 5 条）' : ''))
        errs.slice(-5).forEach(function (x) {
          var d = new Date(x.t)
          var hh = ('0' + d.getHours()).slice(-2)
          var mm = ('0' + d.getMinutes()).slice(-2)
          lines.push('  ' + hh + ':' + mm + '  ' + x.fn + (x.act ? '/' + x.act : '') + '  ' + x.raw)
        })
      }
    } catch (e) {}
    wx.setClipboardData({
      data: lines.join('\n'),
      success: function () { wx.showToast({ title: '已复制', icon: 'none' }) }
    })
  },

  copyErrLog() {
    /* me 页是主包页面，只能用主包的 tick 试听音（音效资源在分包） */
    sfx.play('tick')
    var log = []
    try { log = wx.getStorageSync('errLog') || [] } catch (e) {}
    if (!log.length) return
    var lines = log.map(function (x) {
      var d = new Date(x.t)
      var hh = ('0' + d.getHours()).slice(-2)
      var mm = ('0' + d.getMinutes()).slice(-2)
      return hh + ':' + mm + '  ' + x.fn + (x.act ? '/' + x.act : '') + '  ' + x.raw
    })
    wx.setClipboardData({
      data: '酒桌 错误记录（' + log.length + ' 条）\n' + lines.join('\n'),
      success: function () { wx.showToast({ title: '已复制', icon: 'none' }) }
    })
  },

  toggleMotion() {
    const v = haptic.setReduceMotion(!this.data.reduceMotion)
    this.setData({ reduceMotion: v })
  },

  toggleHaptic() {
    const h = haptic.setHapticOn(!this.data.hapticOn)
    this.setData({ hapticOn: h })
    if (h) haptic.vibrate('light')
  },

  /* ⚠️ 这里原来有个 `goLobby()`（switchTab 到大厅）—— tabBar 已经有入口，
     从来没被模板绑定过。2026-10-28 由「死功能」断言扫出来并删除。 */

  /**
   * 清理本机缓存。
   *
   * ★ 修一个「名不副实」：原来的弹窗说"会清掉昵称和声音开关"，
   *   但代码**只 wx.removeStorageSync(NICK_KEY)** —— 声音开关、震动开关、
   *   玩法统计、上次玩的，一个都没动。用户以为清干净了，其实没有。
   *   （而且后来加的 gameStats / lastGame 连提都没提。）
   *
   * 现在清的就是"本机所有我们自己写进去的东西"，并把清单写进弹窗 ——
   * 文案和实现对得上，用户才知道按下去会发生什么。
   */
  clearCache() {
    wx.showModal({
      title: '清理本机缓存',
      content: '会清掉昵称、声音与震动开关、玩过的记录。对局数据都在云端，不受影响。',
      confirmText: '清理',
      success: (r) => {
        if (!r.confirm) return
        try {
          wx.removeStorageSync(NICK_KEY)
          wx.removeStorageSync('gameStats')
          wx.removeStorageSync('lastGame')
        } catch (e) {}
        /* 开关走各自的 setter，别直接写 storage —— 内存里的状态也要跟着变，
           否则界面显示"开着"、实际已被清掉。 */
        sfx.setMuted(false)
        haptic.setHapticOn(true)
        this.setData({ nick: '', muted: false, hapticOn: true })
        this.loadStats()
        wx.showToast({ title: '清好了', icon: 'success' })
      }
    })
  }
})
