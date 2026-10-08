/**
 * 游戏大厅
 *
 * 三个酒桌游戏：摇骰子 / 大话骰 / 命运转盘。
 *
 * 设计取舍（重要）：
 *   1. **不做联网对战**。酒桌游戏的乐趣在"当面玩"——两个人坐一起、一部手机传着玩，
 *      比各自盯着屏幕更对。所以这里全部是单机逻辑 + 本地随机，
 *      没有云函数、没有网络延迟、没网也能玩。
 *   2. **声音是体验的一半**。摇骰子的哗啦声、开盅的揭晓音、转盘的咔哒 ——
 *      这些音效是代码合成的（scripts/gen-audio.py），不是随便加 beep。
 *   3. **摇一摇是真的用重力感应**（wx.onAccelerometerChange），
 *      不是点一下假装摇。手感差别很大。
 */
const app = getApp()

const GAMES = [
  {
    k: 'room',
    name: '联网一起玩',
    icon: '📡',
    desc: '各自用自己手机，输房间号进来',
    tag: '多人 · 需联网',
    color: '#5E7FA6'
  },
  {
    k: 'dice',
    name: '摇骰子',
    icon: '🎲',
    desc: '摇一摇手机，比大小',
    tag: '一部手机',
    color: '#E0714F'
  },
  {
    k: 'liar',
    name: '大话骰',
    icon: '🎯',
    desc: '酒桌经典，一人一个盅',
    tag: '一部手机',
    color: '#C4573A'
  },
  {
    k: 'wheel',
    name: '命运转盘',
    icon: '🎡',
    desc: '真心话 / 大冒险 / 喝一杯',
    tag: '一部手机',
    color: '#E8B33C'
  }
]

Page({
  data: {
    games: GAMES,
    /* 玩过次数，从本地存储读 —— 不做云端统计，玩个游戏不该上报 */
    played: {}
  },

  onLoad() {
    this.loadPlayed()
  },

  onShow() {
    this.loadPlayed()
  },

  loadPlayed() {
    let p = {}
    try { p = wx.getStorageSync('gamePlayed') || {} } catch (e) {}
    this.setData({ played: p })
  },

  go(e) {
    const k = e.currentTarget.dataset.k
    wx.navigateTo({ url: '/pages/game/' + k + '/' + k })
  },

  /** 长按清空记录 —— 藏起来的入口，避免误触 */
  clearPlayed() {
    wx.showModal({
      title: '清空游戏记录？',
      content: '只清掉本机记录的「玩过几次」，不影响任何其他数据。',
      success: (m) => {
        if (!m.confirm) return
        try { wx.removeStorageSync('gamePlayed') } catch (e) {}
        this.setData({ played: {} })
        wx.showToast({ title: '清好了', icon: 'none' })
      }
    })
  }
})
