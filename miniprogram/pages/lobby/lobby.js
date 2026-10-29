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
const haptic = require('../../utils/haptic.js')
const icons = require('../../utils/icons.js')
const iconSet = require('../../utils/iconSet.js')
const { CATS, GAMES } = require('../../utils/games.js')
const { warmup } = require('../../utils/cloud.js')

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
/**
 * 按"最近玩过"排序（2026-10-28 从只记 1 个改成记 3 个）。
 *
 * 原来只记 `lastGame` 一个 —— 一桌人常玩的往往是两三个（"再来把大话骰"、
 * "换金花"），而只有最后一个会被顶上来，其余散在后面。
 *
 * ⚠️ 兼容老数据：`lastGame` 还在，把它并进最近列表的第一位 ——
 *    否则升级后"上次玩的"标记会全没了。
 */
function recentList() {
  let arr = []
  try { arr = wx.getStorageSync('recentGames') || [] } catch (e) {}
  if (!Array.isArray(arr)) arr = []
  if (!arr.length) {
    try {
      const last = wx.getStorageSync('lastGame') || ''
      if (last) arr = [last]
    } catch (e) {}
  }
  return arr.slice(0, 3)
}

function sortByRecent(list) {
  const recent = recentList()
  if (!recent.length) return list
  /*
   * 只有**最近玩的那一个**打「上次」标签（2026-10-28）。
   * 三个都排到前面是对的，但三个都写"上次"就不通顺了 ——
   * 第二、三个是"更早玩的"，不是"上次"。
   */
  const hit = recent
    .map((id, i) => {
      const g = list.filter(x => x.id === id)[0]
      return g ? Object.assign({}, g, { recent: i === 0 }) : null
    })
    .filter(Boolean)
  if (!hit.length) return list
  const rest = list.filter(g => recent.indexOf(g.id) < 0)
  return hit.concat(rest)
}

/** 记一次"玩过这个"（保留最近 3 个，新的在前） */
function pushRecent(id) {
  try {
    const arr = recentList().filter(x => x !== id)
    arr.unshift(id)
    wx.setStorageSync('recentGames', arr.slice(0, 3))
    wx.setStorageSync('lastGame', id)   // 老字段继续写，防回滚后丢标记
  } catch (e) {}
}

Page({
  data: {
    ic: _IC,
    /* data 初始化也走同一套排序，否则首帧会闪一下（未排序 → onShow 排序） */
    list: sortByRecent(buildList()),
    joinCode: '',
    /* 首次进入的指向（点过任意一张卡就永久关掉） */
    firstHint: false,
    err: '',
    muted: false,
    hapticOn: true,
    /* 内容量一行（"5 个玩法 · 160 道题 · 120 对词"），onShow 时现算 */
    stats: ''
  },

  /*
   * 内容量（2026-10-28）。
   *
   * 大厅原来只列 5 个玩法卡片 —— 玩家不知道后面还有多少东西。
   * 而"有 160 道题、120 对词"恰恰是这些玩法能玩一晚上的原因，
   * 也是它们值得用手机的理由（现实中现场出题几轮就干了）。
   *
   * ★ 数字全部**从数据源现算**，不写死：写死的数字会在内容扩充后
   *   悄悄变成谎话（本项目对"注释/文案与实现不一致"栽过）。
   */
  statsText() {
    const decks = require('../../utils/decks.js')
    const words = require('../../utils/words.js')
    const all = decks.DECKS || []
    const cardCount = all.reduce((n, d) => n + (d.truth || []).length + (d.dare || []).length, 0)
    const pairCount = (words.DECKS || []).reduce((n, d) => n + (d.pairs || []).length, 0)
    const parts = []
    if (GAMES && GAMES.length) parts.push(GAMES.length + ' 个玩法')
    if (cardCount) parts.push(cardCount + ' 道题')
    if (pairCount) parts.push(pairCount + ' 对词')
    return parts.join(' · ')
  },

  onLoad() {
    this.setData({ muted: sfx.isMuted(), hapticOn: haptic.isHapticOn() })
  },

  /* 从房间退回来时刷新开关状态 —— 房间页里也能改，别让两边显示不一致 */
  /**
   * 首屏渲染完，记一笔启动耗时（2026-10-28）。
   *
   * 判据用的是「onLaunch → onReady」的差值 —— 它**不等于**用户感知的"点开到看见"，
   * 因为 onLaunch 之前还有小程序的启动/下载阶段（那部分拿不到）。
   * 但它能反映**主包大小 + 首屏渲染**的变化，而这个正是我能改的部分：
   * 拆分包前后这个数字应该明显不同。
   *
   * ⚠️ 只在**冷启动**时记（热启动没啥参考价值），所以用 globalData 里的起点，
   *    取不到就不记。
   */
  onReady() {
    const app = getApp()
    const t0 = app && app.globalData && app.globalData.bootAt
    if (!t0) return
    const ms = Date.now() - t0
    /* 超过 30 秒的肯定是异常（切后台回来之类），不记 */
    if (ms <= 0 || ms > 30000) return
    try { wx.setStorageSync('lastBootMs', ms) } catch (e) {}
  },

  onShow() {
    /* 首次进来给一个指向 —— 之后再也不出现（storage 记着） */
    try {
      if (!wx.getStorageSync('openedOnce')) {
        this.setData({ firstHint: true })
      }
    } catch (e) {}
    /* 大厅停留时就先把云函数叫醒 —— 等用户点玩法卡时容器已经是热的，
       否则第一次操作会撞上 1~3 秒冷启动，而云函数超时只有 3 秒 */
    warmup()
    this.setData({
      muted: sfx.isMuted(),
      hapticOn: haptic.isHapticOn(),
      stats: this.statsText(),
      list: sortByRecent(buildList())
    })
  },

  onShareAppMessage() {
    return {
      title: '酒桌上缺个游戏？这几个都能手机一起玩',
      path: '/pages/lobby/lobby',
      imageUrl: '/images/share-cover.png'
    }
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
    const h = haptic.setHapticOn(!this.data.hapticOn)
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
    /*
     * 点玩法卡 = 开桌，是**大厅最重要的那一下**，原来完全没声音。
     * 这里只能用主包的 `tick`：音效资源都在分包里，而大厅是主包页面 ——
     * 主包不能引用分包资源（微信的硬规则，见 README 的"已知限制"）。
     */
    sfx.play('tick')
    /* 点过任意一张卡 → 首次指向永久关掉 */
    if (this.data.firstHint) {
      try { wx.setStorageSync('openedOnce', 1) } catch (err) {}
      this.setData({ firstHint: false })
    }
    const id = e.currentTarget.dataset.id
    /* 记住最近玩过的几个 —— 酒桌上常玩的是两三个，只有最后一个被顶上来不够用 */
    pushRecent(id)
    /* 玩法次数统计：只记"开过几次桌"，不做胜率之类（酒桌上没有可靠的胜负归属） */
    try {
      const st = wx.getStorageSync('gameStats') || {}
      st[id] = (Number(st[id]) || 0) + 1
      wx.setStorageSync('gameStats', st)
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
    sfx.play('tick')
    wx.navigateTo({
      url: '/game/room/room?code=' + encodeURIComponent(code),
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

  /* ---------- 我的 ---------- */
  /*
   * ⚠️ 这里原来有个 `goMe()`（wx.switchTab 到「我的」）——
   * 但 tabBar 已经有「我的」入口，这个方法从来没被任何模板绑定过。
   * 2026-10-28 由「死功能」断言扫出来并删除。
   */
})
