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
    gameNames: GAMES.map(g => g.name).join(' · '),
    version: '3.0.0'
  },

  onLoad() {
    this.setData({
      nick: wx.getStorageSync(NICK_KEY) || '',
      muted: sfx.isMuted(),
      hapticOn: feedback.isHapticOn()
    })
  },

  /* 从房间回来时同步开关（房间页里也能改） */
  onShow() {
    this.setData({ muted: sfx.isMuted(), hapticOn: feedback.isHapticOn() })
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

  goLobby() { wx.switchTab({ url: '/pages/lobby/lobby' }) },

  clearCache() {
    wx.showModal({
      title: '清理本机缓存',
      content: '会清掉昵称和声音开关。对局数据都在云端，不受影响。',
      confirmText: '清理',
      success: (r) => {
        if (!r.confirm) return
        wx.removeStorageSync(NICK_KEY)
        this.setData({ nick: '' })
        wx.showToast({ title: '清好了', icon: 'success' })
      }
    })
  }
})
