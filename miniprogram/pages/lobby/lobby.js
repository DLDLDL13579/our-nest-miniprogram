/**
 * 酒桌大厅（tabBar 第一页）
 *
 * ============ 这一版改了什么 ============
 *
 * 改造前这里是「玩法一览」—— 只有一张卡能点，点了进房间再挑玩法。
 * 现在是**真大厅**：所有玩法都在首屏可见、可分类、点哪个就带着哪个进房。
 *
 * 三处结构变化的理由：
 *   ① **玩法由数据驱动**（utils/games.js），不是硬编码数组。
 *      加新玩法只改注册表，大厅自动多一张卡 —— 见 games.js 的头注释。
 *   ② **快捷进房提到上面**。别人开好了房，最自然的动作是「输 3 位号」，
 *      而不是「先选玩法、再进房、再发现房主已经选了别的玩法」。
 *   ③ **静音/震动开关留在大厅**。酒桌上一坐下就要调，藏在设置里等于没有。
 *
 * ============ 从大厅进房间时的两个参数 ============
 *   ?game=liar   预设玩法（开房时这个玩法已选中）
 *   ?code=123    直接加入这个房间（不用再输一遍号）
 */
const sfx = require('../../utils/sfx.js')
const feedback = require('../../utils/feedback.js')
const icons = require('../../utils/icons.js')
const iconSet = require('../../utils/iconSet.js')
const { CATS, GAMES } = require('../../utils/games.js')

/* 图标：内联 SVG 替代 emoji（跨机型渲染不一致、颜色不可控，见 utils/icons.js）。
   玩法图标由 iconSet 自动并入注册表里的全部玩法 —— 加玩法不用改这里。 */
const _IC = iconSet.build(['speakerOn', 'speakerOff', 'hapticOn', 'hapticOff', 'chevronRight'], '#E8B33C')

/*
 * ★★ 2026-10-27 用户定的一条产品原则，改代码前先读：
 *
 *    「手机上不需要太多交互，重点是游戏视觉效果和规则，
 *      因为是朋友一起在线下酒桌上使用，不太需要太多手机点击。」
 *
 * 所以大厅**不做分类筛选**。
 * 原来那排「全部 / 摇骰子 / 抽题卡 / 动嘴皮」看着像专业 App，
 * 实际上是让用户为"找到玩法"多点一次 —— 酒桌上这层筛选毫无价值：
 * 一屏能放下的玩法，直接平铺就是最快的。
 *
 * 判断标准：**这个点击是在服务"手机交互"，还是在服务"桌上的游戏"？**
 * 前者一律砍掉。
 */

/**
 * 给大厅渲染用的玩法列表。
 *
 * ★ 图标必须在 js 里转成 data URI：`item.icon` 存的是**图标 key**，
 *   直接丢进 wxml 会把 key 当文字打印出来（页面上出现「target 大话骰」这种乱码），
 *   或者让 <image src="target"> 变成裂图。这个坑 AGENTS.md 记过一次。
 */
function buildList() {
  return GAMES.map(g => ({
    id: g.id,
    name: g.name,
    desc: g.desc,
    color: g.color,
    cat: g.cat,
    players: g.max > 1 ? (g.min + '–' + g.max + ' 人') : '单人也能玩',
    iconUri: icons.dataUri(g.icon, g.color)
  }))
}

/**
 * 把"上次玩的那个"排到最前面。
 *
 * 为什么值得做：酒桌上最常发生的对话是"还玩刚才那个吧"。
 * 让它排第一，等于省掉每次都要在列表里找一下。
 * ⚠️ 只做**置顶**，不做"按频率排序" —— 后者会让列表顺序莫名其妙地变，
 *   玩家找不到东西比多找一下更烦。
 */
function sortByRecent(list) {
  let last = ''
  try { last = wx.getStorageSync('lastGame') || '' } catch (e) {}
  if (!last) return list
  const hit = list.filter(g => g.id === last)
    .map(g => Object.assign({}, g, { recent: true }))
  if (!hit.length) return list
  return hit.concat(list.filter(g => g.id !== last))
}

Page({
  data: {
    ic: _IC,
    /* data 初始化也走同一套排序，否则首帧会闪一下（未排序 → onShow 排序） */
    list: sortByRecent(buildList()),
    joinCode: '',
    err: '',
    muted: false,
    hapticOn: true
  },

  onLoad() {
    this.setData({ muted: sfx.isMuted(), hapticOn: feedback.isHapticOn() })
  },

  /* 从房间退回来时刷新开关状态 —— 房间页里也能改，别让两边显示不一致 */
  onShow() {
    this.setData({
      muted: sfx.isMuted(),
      hapticOn: feedback.isHapticOn(),
      list: sortByRecent(buildList())
    })
  },

  onHide() { sfx.stopAll() },
  onUnload() { sfx.destroy() },

  /* ---------- 开关 ---------- */

  /* 静音：酒桌上可能不方便出声，一键关掉且记得住 */
  toggleMute() {
    const m = sfx.setMuted(!this.data.muted)
    this.setData({ muted: m })
  },

  /* 震动开关 —— 和静音分开：
     公共场合（酒桌旁边有人）可能想留声音但不震，反之亦然。 */
  toggleHaptic() {
    const h = feedback.setHapticOn(!this.data.hapticOn)
    this.setData({ hapticOn: h })
  },

  /* ---------- 进房 ---------- */

  /*
   * 点玩法卡 = **一步到位直接建房**。
   *
   * 改造前是"点卡 → 房间页 → 输名字 → 选玩法 → 点开房间"，
   * 四步才看见房间号。酒桌上第一个人要做的动作只有一件：
   * **把房间号念出来**。所以这里直接建，房间页一进去就是房间号。
   */
  openGame(e) {
    const id = e.currentTarget.dataset.id
    sfx.play('whoosh')
    /* 记住上次玩的是哪个 —— 酒桌上常常"再来那个"，下次进来它就排在最前面 */
    try { wx.setStorageSync('lastGame', id) } catch (err) {}
    /* 玩法次数统计：只记"开过几次桌"，不做胜率之类（酒桌上没有可靠的胜负归属） */
    try {
      const st = wx.getStorageSync('gameStats') || {}
      st[id] = (Number(st[id]) || 0) + 1
      wx.setStorageSync('gameStats', st)
    } catch (err) {}
    wx.navigateTo({ url: '/pages/room/room?game=' + encodeURIComponent(id) + '&auto=1' })
  },

  /* 输房间号：3 位不是本地能判的（号段由服务端定），所以只做"非空"提示，
     真正的合法性由服务端回答 —— 前端猜规则迟早和服务端不一致。 */
  onCode(e) {
    const v = String(e.detail.value || '').replace(/\D/g, '').slice(0, 3)
    this.setData({ joinCode: v, err: '' })
    /* ★ 输满 3 位**自动进房**，不用再点一下"进去"。
       3 位数是唯一合法的房间号长度，输满就没有歧义 —— 让用户多点一次纯属多余。 */
    if (v.length === 3) {
      clearTimeout(this._joinTimer)
      this._joinTimer = setTimeout(() => { if (!this._dead) this.doJoin() }, 180)
    }
    return v
  },

  onUnload() { clearTimeout(this._joinTimer) },

  doJoin() {
    const code = String(this.data.joinCode || '').trim()
    if (code.length !== 3) {
      this.setData({ err: '房间号是 3 位数字' })
      return
    }
    sfx.play('whoosh')
    wx.navigateTo({ url: '/pages/room/room?code=' + encodeURIComponent(code) })
  },

  /* ---------- 我的 ---------- */
  goMe() { wx.switchTab({ url: '/pages/me/me' }) }
})
