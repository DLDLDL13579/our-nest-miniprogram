/**
 * dicerank.js —— 「比大小」的结算规则（纯函数，无 IO）
 *
 * ============ 为什么单独抽出来 ============
 *
 * 2026-10-28 之前，这套规则是**内联在云函数的 roll 分支里**的。
 * 后果不是"写错了"，而是**根本没法单测** ——
 * 想验证一条规则，只能真的把房间跑起来、摇一次骰子、再看结果；
 * 而骰子是随机的，你没法构造"某人有豹子"这种场面。
 *
 * 抽成纯函数之后：给一组 `[{ name, seat, dice }]`，直接得到排名。
 * 规则改动可以像 poker.js 那样穷举验证，不用跑整个房间。
 *
 * ============ 规则 ============
 *
 * ① 每人 5 颗骰子，比**总点数**（5 ~ 30）。
 * ② **豹子**（五颗同点）直接赢，不看总点数。
 *    它的意义不在规则本身，在于"摇盅时有盼头" ——
 *    纯比总点数的局，数字一加就知道结果了，中间没有任何期待。
 *    豹子概率 1/1296，稀有度刚好。
 * ③ 两个豹子：点数大的赢（五个 6 > 五个 1）。
 * ④ 仍然并列：点数完全一样（或豹子点数一样）就都算赢。酒桌上并列不用分胜负，
 *    反正都要喝。
 *
 * ★ 排序键（rankKey）的设计：
 *     豹子   → 1000 + 点数    （五个 6 = 1006，五个 1 = 1001）
 *     非豹子 → 总点数          （5 ~ 30）
 *   这样一条 `sort((a,b) => b.rankKey - a.rankKey)` 就同时满足 ② 和 ③，
 *   不需要"先筛豹子再排序"那种两段式判断（两段式最容易漏掉并列）。
 */

/** 一颗骰子的范围检查：数据的可信度由服务端保证，这里只做兜底 */
function isDie(d) {
  return Number.isInteger(d) && d >= 1 && d <= 6
}

/**
 * 算出排名与赢家。
 *
 * @param {Array} players [{ name, seat, dice: number[] }]
 * @returns {object} { ranked, winners, top, leopardWin, leopardFace, winnerSeats }
 *   ranked     —— 已按 rankKey 降序；每项含 { name, seat, dice, total, leopard, rankKey }
 *   winners    —— 赢家的名字数组（并列时多个）
 *   top        —— 赢家的总点数（并列取最高那个）
 *   leopardWin —— 赢家里有没有豹子
 *   leopardFace —— 赢家豹子的点数（0 = 没有）
 *   winnerSeats —— 赢家的座位号数组
 */
function rankPlayers(players) {
  const list = (players || []).map(p => {
    /* 只认合法的骰子点：非法值直接剔除，不参与计算（脏数据不该让整局崩） */
    const ds = (p.dice || []).filter(isDie)
    const total = ds.reduce((a, b) => a + b, 0)
    const isLeopard = ds.length >= 5 && ds.every(d => d === ds[0])
    return {
      name: p.name,
      seat: p.seat,
      dice: ds,
      total: total,
      leopard: isLeopard,
      rankKey: isLeopard ? 1000 + ds[0] : total
    }
  }).sort((a, b) => b.rankKey - a.rankKey)

  if (!list.length) {
    return { ranked: [], winners: [], top: 0, leopardWin: false, leopardFace: 0, winnerSeats: [] }
  }

  const topKey = list[0].rankKey
  const winnerRows = list.filter(r => r.rankKey === topKey)
  const leopardRow = winnerRows.filter(r => r.leopard)[0] || null

  return {
    ranked: list,
    winners: winnerRows.map(r => r.name),
    /* top 用"赢家的总点数"：豹子赢的时候它可能比对家低，界面要显示的是赢家的点数 */
    top: winnerRows[0].total,
    leopardWin: !!leopardRow,
    leopardFace: leopardRow ? leopardRow.dice[0] : 0,
    winnerSeats: winnerRows.map(r => r.seat)
  }
}

module.exports = { rankPlayers }
