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
const feedback = require('../../utils/feedback.js')
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
      hapticOn: feedback.isHapticOn()
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
    this.setData({ muted: sfx.isMuted(), hapticOn: feedback.isHapticOn() })
    this.loadStats()
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

  toggleHaptic() {
    const h = feedback.setHapticOn(!this.data.hapticOn)
    this.setData({ hapticOn: h })
    if (h) feedback.vibrate('light')
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
        feedback.setHapticOn(true)
        this.setData({ nick: '', muted: false, hapticOn: true })
        this.loadStats()
        wx.showToast({ title: '清好了', icon: 'success' })
      }
    })
  }
})
