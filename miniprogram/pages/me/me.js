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
const { call } = require('../../utils/cloud.js')

const _IC = iconSet.build(['dice', 'chevronRight'], '#C4553F')

const NICK_KEY = 'nick'

Page({
  data: {
    ic: _IC,
    nick: '',
    muted: false,
    hapticOn: true,
    reduceMotion: false,
    /* 诊断信息弹层（剪贴板被隐私限制后改成页面内显示） */
    diagOpen: false,
    diagText: '',
    nightGames: 0,
    errCount: 0,
    /* 最近 2 条错误的内容（直接显示，方便截图反馈） */
    errList: [],
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
    let list = []
    try { list = (wx.getStorageSync('errLog') || []).slice(-2) } catch (e) {}
    /*
     * 给每条补一个可读时间（2026-10-29）。
     * 用户报障时，**时间能立刻区分"这条是刚才的还是几小时前的"** ——
     * 而这恰恰是判断"他看到的是新问题还是旧记录"的关键。
     * wxml 表达式不能调函数，所以在数据层格式化好。
     */
    list = list.map(function (x) {
      var d = new Date(x.t || 0)
      var hh = ('0' + d.getHours()).slice(-2)
      var mm = ('0' + d.getMinutes()).slice(-2)
      return Object.assign({}, x, { time: hh + ':' + mm })
    })
    /* 只显示最近 2 条：够判断问题，又不会把页面撑爆 */
    this.setData({ nightGames: n, errCount: (list.length ? (wx.getStorageSync('errLog') || []).length : 0), errList: list })
  },

  /**
   * 从「我的」直接开桌（2026-10-28）。
   *
   * 玩法统计原来只能看。而"我上周玩金花最多"和"再来一把金花"是同一件事 ——
   * 让用户为这个差别绕回大厅、再找那张卡，没必要。
   */
  openFromMe(e) {
    const id = e.currentTarget.dataset.id
    if (!id) return
    sfx.play('tick')
    /* 和老字段保持一致：从「我的」进也算"最近玩过" */
    try {
      const arr = (wx.getStorageSync('recentGames') || []).filter(x => x !== id)
      arr.unshift(id)
      wx.setStorageSync('recentGames', arr.slice(0, 3))
      wx.setStorageSync('lastGame', id)
    } catch (err) {}
    wx.navigateTo({
      url: '/game/room/room?game=' + encodeURIComponent(id) + '&auto=1',
      /*
       * ⚠️ 跳转失败必须说话（2026-10-29）。
       * 分包没下载完、页面栈超限、路径写错 —— 这几种都会让 navigateTo 静默失败，
       * 用户点了卡什么也没发生，然后报"点了没反应"。而我们没有真机，看不到。
       */
      fail: function (e) {
        wx.showToast({
          title: '打不开房间（' + ((e && e.errMsg) || '未知原因') + '）',
          icon: 'none',
          duration: 2600
        })
      }
    })
  },

  onNick(e) { this.setData({ nick: e.detail.value }) },

  /* 失焦才落盘：边打字边写 storage 是没必要的 IO，
     而且中途的半截名字（比如"邓"）会覆盖掉完整的名字。 */
  saveNick() {
    const v = String(this.data.nick || '').trim().slice(0, 12)
    /*
     * ★ 写失败要说（2026-10-29）。存储满了 / 权限异常时 setStorageSync 会抛异常，
     *   而这里原来没有 try —— 用户以为名字存了，下次打开又变回「玩家N」，
     *   而界面上一点提示都没有。
     */
    try {
      wx.setStorageSync(NICK_KEY, v)
    } catch (e) {
      wx.showModal({
        title: '名字没存住',
        content: '本地存储写不进去了（可能空间满了）。这次房间里的名字仍然有效，但下次打开会变回默认。',
        showCancel: false
      })
    }
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
  /** 空处理：阻止弹层内部的点击冒泡到遮罩 */
  noop() {},

  /** 关掉诊断弹层 */
  closeDiag() { sfx.play('tick'); this.setData({ diagOpen: false }) },

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
        /*
         * ★ 失败频次（2026-10-30）。20 条错误里"哪一类最多"比"最近 5 条"更有诊断价值：
         *   最近 5 条可能全是同一个偶发错误，也可能被最后几次无关失败挤占；
         *   而频次直接告诉你"这个人的问题集中在哪个操作上"。
         *   只列前 3，避免诊断信息无限长。
         */
        var freq = {}
        errs.forEach(function (x) {
          var k = x.act || x.fn || '?'
          freq[k] = (freq[k] || 0) + 1
        })
        var top = Object.keys(freq).sort(function (a, b) { return freq[b] - freq[a] }).slice(0, 3)
        if (top.length) {
          lines.push('失败最多: ' + top.map(function (k) { return k + ' ×' + freq[k] }).join(' · '))
        }
      }
    } catch (e) {}
    /*
     * ★ 复制前先跑一次数据库自检（2026-10-29 晚）。
     *
     * 用户报「游戏从来没正常玩过」，而 -502001 是官方明说"无特殊语义"的
     * 通用码 —— 再靠猜就是浪费用户的时间。自检把「最小写入→读→改→删」
     * 每步的结果拼进诊断文本：用户点一次按钮，根因证据就带走了。
     * 自检失败也照样复制（降级），不让诊断入口自己变成新的故障点。
     */
    /*
     * ★ 行为轨迹（2026-10-30）。诊断信息原来只有"版本/机型/错误记录"——
     * 而错误记录只覆盖"报错的操作"，**没有报错的卡点（点了没反应、界面不动）一条线索都不留**。
     * 轨迹补的就是这一段：用户从哪进来、走到哪个阶段、停在哪。
     */
    try {
      var tr = require('../../utils/trace.js')
      var tl = tr.lines()
      if (tl.length) {
        lines.push('')
        tl.forEach(function (x) { lines.push(x) })
      }
    } catch (e) {}
    var finish = function () {
      /*
       * ★★ 2026-10-30 用户实测：`wx.setClipboardData` 报
       *    `api scope is not declared in the privacy agreement`
       *    —— 剪贴板是敏感 API，必须在公众平台「用户隐私保护指引」里声明，
       *    代码侧绕不过去。用户明确说「可以删除复制功能」。
       *
       * 改成**把诊断信息显示在页面上**：长按可以选中，也可以直接截图发我。
       * 弹层比一次性 toast 好的地方是：内容不会消失，能慢慢看、能重看。
       */
      this.setData({ diagText: lines.join('\n'), diagOpen: true })
    }
    call('room', { action: 'selftest' }, { silent: true }).then(function (r) {
      if (r && r.probe && r.probe.length) {
        lines.push('')
        lines.push('数据库自检:')
        r.probe.forEach(function (p) {
          var tail = p.ok ? 'ok' : 'FAIL ' + [p.code, p.op, p.tag].filter(Boolean).join(':')
          lines.push('  ' + p.s + ' ' + tail)
        })
      }
      finish()
    }).catch(function (e) {
      lines.push('')
      lines.push('数据库自检: 调用失败 ' + ((e && (e._diag || e.message)) || '?'))
      finish()
    })
  },


  toggleMotion() {
    const v = haptic.setReduceMotion(!this.data.reduceMotion)
    this.setData({ reduceMotion: v })
    /*
     * ★ 2026-11-02 真机审核：**这个开关原来点了完全没反馈** ——
     *   既没声音也没震动（减少动效本来就不该震）。
     *   用户点完不知道"到底切过去了没有"，只能靠开关自己动了一下。
     *   声音反馈在这里不影响它要表达的东西（动效开关不控制声音）。
     */
    sfx.play(v ? 'toggleOn' : 'toggleOff')
  },

  toggleHaptic() {
    const h = haptic.setHapticOn(!this.data.hapticOn)
    this.setData({ hapticOn: h })
    if (h) haptic.vibrate('light')
    /* 关掉震动时**必须**有声音，否则用户听不到也觉不到，像是没点上 */
    sfx.play(h ? 'toggleOn' : 'toggleOff')
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
          /* 最近玩过的排序（3.10.41 加的）也要清 —— 否则"清理后还是那几个排在前面"，
             和"会清掉玩过的记录"这句话对不上（2026-10-29） */
          wx.removeStorageSync('recentGames')
          /* 行为轨迹也清 —— 它记录的是"这台机器上玩过什么"，属于本机数据。
             （错误记录 errLog 有意保留：用户清完缓存来报障时，错误码还得在。） */
          try { require('../../utils/trace.js').clear() } catch (e2) {}
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
