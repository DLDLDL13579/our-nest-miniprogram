/**
 * trace.js —— 轻量行为轨迹（2026-10-30）
 *
 * ============ 为什么要有这个 ============
 *
 * 用户报「玩不了」时，我们历史上反复陷入同一个困境：
 *   · 错误记录只在他点了会报错的操作时才有一条
 *   · 而"点进去就没反应""看着界面不动"这类**没有报错**的卡点，什么线索都不留
 *
 * 结果就是靠猜：猜是网络、猜是部署、猜是权限 —— 项目史上猜错过很多次。
 *
 * 这个模块只做一件事：**把玩家走过的关键节点留在本机**（最多 30 条，环形覆盖）。
 * 用户点「复制诊断信息」时会一起带走，于是"他卡在哪一步"一目了然。
 *
 * ============ 设计约束 ============
 *
 * 1. **绝不阻塞、绝不抛错** —— 埋点本身不能成为新的故障点
 * 2. **不采集隐私**（没有 openid、没有设备信息，只有动作名 + 时间）
 * 3. **环形缓冲 30 条** —— 够看出一次完整会话，又不会把 storage 撑大
 * 4. **只记"节点"，不记流水** —— 每次轮询都记的话，30 条 5 秒就冲掉了
 */

var KEY = 'traceLog'
var MAX = 30

/** 读（诊断信息用） */
function list() {
  try {
    var v = wx.getStorageSync(KEY)
    return Array.isArray(v) ? v : []
  } catch (e) { return [] }
}

/** 清（「清理本机缓存」会调） */
function clear() {
  try { wx.removeStorageSync(KEY) } catch (e) {}
}

/**
 * 记一个节点。
 * @param {string} name 动作名（短英文，如 'create' / 'join' / 'bid'）
 * @param {string} [note] 附注（错误码、阶段名之类，别放长文本）
 */
function add(name, note) {
  try {
    var arr = list()
    arr.push({ t: Date.now(), n: String(name || '?'), note: note ? String(note).slice(0, 40) : '' })
    if (arr.length > MAX) arr = arr.slice(arr.length - MAX)
    wx.setStorageSync(KEY, arr)
  } catch (e) {
    /* 埋点失败就算了 —— 它不该影响任何功能 */
  }
}

/** 给诊断信息用：渲染成几行文本 */
function lines() {
  var arr = list()
  if (!arr.length) return []
  /*
   * ★ 先给一句结论："最远走到哪"。
   *   用户报「玩不了」时，我最想知道的其实不是流水，而是
   *   **他到底有没有完整玩完一局** —— 结算过 = 能玩通，卡在 playing = 走不下去。
   *   把结论放在流水前面，一眼就能分诊。
   */
  var stages = arr.map(function (x) { return x.n })
  var reached = '刚进房间'
  if (stages.indexOf('over') >= 0) reached = '走完一局（到过结算）'
  else if (stages.indexOf('playing') >= 0) reached = '卡在游戏中（没到结算）'
  else if (stages.indexOf('countdown') >= 0) reached = '卡在倒计时'
  else if (stages.indexOf('lobby') >= 0) reached = '停在房间大厅（没开局）'

  var out = ['最远走到: ' + reached, '轨迹（最近 ' + arr.length + ' 步）:']
  arr.slice(-15).forEach(function (x) {
    var d = new Date(x.t)
    var hh = ('0' + d.getHours()).slice(-2)
    var mm = ('0' + d.getMinutes()).slice(-2)
    var ss = ('0' + d.getSeconds()).slice(-2)
    out.push('  ' + hh + ':' + mm + ':' + ss + '  ' + x.n + (x.note ? '  ' + x.note : ''))
  })
  return out
}

module.exports = { add: add, list: list, clear: clear, lines: lines }
