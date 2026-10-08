/**
 * 游戏大厅
 *
 * 三个酒桌游戏：大话骰 / 摇骰子比大小 / 命运转盘。
 *
 * ★ 2.6.0 起**只有联网版**。
 *   用户明确说：「除了多人联机，其他单机的几乎没用，删除都可以，全部都是在线多人玩的」。
 *   所以三个单机页（pages/game/dice、liar、wheel）已删除，
 *   大厅只留一个入口：开房间 / 输房间号进来，所有游戏在房间页里玩。
 *
 *   删除后顺带解决的三个问题：
 *     ① 同一个游戏有两套实现，改一处忘一处（摇盅这次就要改两遍）
 *     ② 单机版骰子本地随机、可以反复摇到满意为止，联机版服务端摇才公平
 *     ③ 三个单机页共 2371 行，占了页面代码的近一半
 *
 * 设计取舍（保留）：
 *   · **声音是体验的一半**。摇盅的哗啦声、扣盅的闷响、揭盅的提声 ——
 *     这些音效是代码合成的（scripts/gen-audio.py），不是随便加 beep。
 *   · **摇盅全流程照现实走**：骰子入盅 → 摇盅 → 扣盅 → 揭盅 → 桌上滚两下。
 *     现实里摇盅时看不见骰子（盅不透明），悬念恰恰来自"看不见"。
 */
const app = getApp()
const sfx = require('../../utils/sfx.js')
const feedback = require('../../utils/feedback.js')

/* 大厅只展示"有哪些游戏可以玩"，点进去都是开房间。
   所以这里不再是"页面入口"，而是**玩法介绍**。 */
const GAMES = [
  {
    k: 'room',
    name: '一起玩',
    icon: 'dice',
    desc: '开个房间，把房间号发给他们',
    tag: '多人 · 需联网',
    color: '#5E7FA6'
  }
]

/* 玩法一览（只是展示，点任何一个都进同一个房间页） */
const MODES = [
  { icon: 'target', name: '大话骰', desc: '轮流往上叫，不信就开。扣盅后按住盅偷看自己的骰子' },
  { icon: 'dice', name: '摇骰子比大小', desc: '一起摇盅，点数大的赢' },
  { icon: 'wheel', name: '命运转盘', desc: '房主转，真心话 / 大冒险 / 喝一杯，全场同步' }
]

const icons = require('../../utils/icons.js')
/* 图标：内联 SVG 替代 emoji（跨机型渲染不一致，见 utils/icons.js） */
const _IC = {}
for (const _k of ['speakerOn', 'speakerOff', 'hapticOn', 'hapticOff', 'dice', 'target', 'wheel', 'signal']) { _IC[_k] = icons.dataUri(_k, '#E8B33C') }

Page({
  data: {
    ic: _IC,
    games: GAMES,
    modes: MODES,
    muted: false,
    hapticOn: true
  },

  onLoad() {
    this.setData({ muted: sfx.isMuted(), hapticOn: feedback.isHapticOn() })
  },

  onHide() { sfx.stopAll() },
  onUnload() { sfx.destroy() },

  /* 静音：酒桌上可能不方便出声，一键关掉且记得住 */
  toggleMute() {
    const m = sfx.setMuted(!this.data.muted)
    this.setData({ muted: m })
  },

  /* 震动开关 —— 和静音分开。
     公共场合（酒桌旁边有人）可能想留声音但不震，反之亦然。 */
  toggleHaptic() {
    const h = feedback.setHapticOn(!this.data.hapticOn)
    this.setData({ hapticOn: h })
  },

  go() {
    /* 进房间的"开场音"：从列表点进去是该有点仪式感的 */
    sfx.play('whoosh')
    wx.navigateTo({ url: '/pages/game/room/room' })
  }
})
