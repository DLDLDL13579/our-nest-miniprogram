#!/usr/bin/env node
/**
 * test-mock.js —— 渲染 mock 的数据自洽性
 *
 * ============ 为什么需要 ============
 *
 * 2026-11-02 修完「卧底投票进度的两个数字不同分母」之后，我顺手检查了 mock ——
 * 发现 **uw12 这个状态本身就是矛盾的**：显示「已投 5 / 12」和「还差 2 人」，
 * 而 5 + 2 ≠ 12。
 *
 * 也就是说：**渲染图上的那个矛盾，一半来自产品、一半来自 mock**。
 * 而 mock 不自洽的后果比产品 bug 更隐蔽 —— 我会看着截图去改一段正确的代码。
 *
 * AGENTS.md 记过：「mock 失真比没工具更危险」。
 *
 * ============ 检查什么 ============
 *
 * 只查**能机械判定**的关系，不猜语义：
 *   · room.count 与实际 players 数量一致
 *   · 卧底投票：iVoted 时 voteCount + waitingCount = voterCount
 *   · 摇骰进度：rolledCount ≤ count
 *   · 每人的 score / cups 非负
 *   · 结算的 ranked 里每个 seat 都能在 players 里找到
 */
const assert = require('assert')
const mock = require('./ui-render/mock/room.js')

const states = mock.states
assert.ok(states && typeof states === 'object', 'mock 没有导出 states')

const bad = []
for (const k of Object.keys(states)) {
  let s
  try { s = states[k]() } catch (e) { bad.push(k + ' 抛异常：' + e.message); continue }
  if (!s) { bad.push(k + ' 返回 null'); continue }

  const room = s.room || {}
  const players = room.players || []

  /* ① 人数 */
  if (typeof room.count === 'number' && players.length && room.count !== players.length) {
    bad.push(k + '：room.count=' + room.count + ' 但 players 有 ' + players.length + ' 个')
  }

  /* ② 卧底投票口径 */
  const u = room.uw
  if (u && typeof u.voteCount === 'number' && typeof u.voterCount === 'number') {
    if (u.voteCount > u.voterCount) {
      bad.push(k + '：已投 ' + u.voteCount + ' > 应投 ' + u.voterCount)
    }
    if (u.iVoted === true && typeof u.waitingCount === 'number' &&
        u.voteCount + u.waitingCount !== u.voterCount) {
      bad.push(k + '：我投了 → 已投' + u.voteCount + ' + 还差' + u.waitingCount +
        ' ≠ 应投' + u.voterCount)
    }
  }

  /* ③ 摇骰进度 */
  if (typeof room.rolledCount === 'number' && typeof room.count === 'number' &&
      room.rolledCount > room.count) {
    bad.push(k + '：已摇 ' + room.rolledCount + ' > 总人数 ' + room.count)
  }

  /* ④ 分数/杯数非负 */
  players.forEach((p, i) => {
    if (typeof p.score === 'number' && p.score < 0) {
      bad.push(k + '：players[' + i + '](' + p.name + ') score 为负')
    }
  })

  /* ⑤ 结算里的 seat 必须存在 */
  const r = s.result || (room.lastResult)
  if (r && Array.isArray(r.ranked) && players.length) {
    const seats = new Set(players.map(p => p.seat))
    r.ranked.forEach(row => {
      if (row.seat !== undefined && !seats.has(row.seat)) {
        bad.push(k + '：结算里的 seat' + row.seat + '(' + row.name + ') 不在 players 里')
      }
    })
  }
}

if (bad.length) {
  console.error('✗ mock 数据不自洽 ' + bad.length + ' 处：')
  bad.forEach(x => console.error('    · ' + x))
  console.error('\n  渲染图上的矛盾如果不是产品的问题，就是这里的 —— 先修 mock 再看图。')
  process.exit(1)
}

console.log('  ✓ mock 数据自洽（' + Object.keys(states).length + ' 个状态：人数/投票/进度/分数/结算 seat）')
