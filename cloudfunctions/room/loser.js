/**
 * loser.js —— 从一局的结果里提取"谁喝了、喝多少"
 *
 * ============ 为什么单独抽出来 ============
 *
 * 2026-10-29 加「今晚战况」时，这段逻辑是**内联在 `again` 分支里**的，
 * 于是没法单独测 —— 想测就得模拟一整局金花（比牌流程、出局条件、牌不够……），
 * 我照着自己想的流程写测试，跑出来是"1 次比牌就结束了"，
 * **测试前提本身就是错的**，最后只能删掉、留一句"这里没有覆盖"。
 *
 * 抽成纯函数之后：喂 `{game, lastResult, players, pkDrink}` 就能断言，
 * 不需要真的玩一局。
 *
 * ============ 统计口径（刻意保守） ============
 *
 * | 玩法 | 输家是谁 | 记几杯 |
 * |---|---|---|
 * | 大话骰 | `lastResult.loserName` | 1 |
 * | 比大小 | `ranked` 里 total 最小的 | 1 |
 * | 梦幻金花 | 所有 `out: true` 的人 + `pkDrink` 里换牌的代价 | 1 / 换牌量 |
 * | 谁是卧底 | **不计** —— 出局是过程，游戏没结束，谁喝取决于桌上规矩 | — |
 * | 命运转盘 | **不计** —— 没有输家 | — |
 *
 * **算错比不算更糟**：喝酒游戏里"你欠几杯"是较真的事。
 * 所以只统计"输家明确"的三种，另外两种宁可留空。
 */

/**
 * @param {object} o
 * @param {string} o.game        玩法 id
 * @param {object} o.lastResult  这一局的结算（可能为 null）
 * @param {Array}  o.players     玩家（金花要用 out 标记）
 * @param {object} o.pkDrink     金花：{ openid: 杯数 }
 * @returns {Array<{name: string, cups: number}>} 这一局喝了的人
 */
function drinkers(o) {
  const out = []
  const push = (name, cups) => {
    if (!name || !(cups > 0)) return
    const hit = out.filter(x => x.name === name)[0]
    if (hit) hit.cups += cups
    else out.push({ name: name, cups: cups })
  }

  const lr = (o && o.lastResult) || {}
  const game = o.game
  const players = Array.isArray(o.players) ? o.players : []

  /*
   * ★★ 2026-11-04：**不能在这里就 return**。
   *
   *   原来是 `if (!lr) return out` —— 而**射龙门认低威根本不写 lastResult**
   *   （它只写 btLast 和 btDrink，因为认低威不是"结算"而是"中途放弃"）。
   *   于是认低威的半杯永远进不了「今晚战况」。
   *
   *   正确语义：lastResult 是"谁输了"的依据（liar/dice/poker/consensus/sieve
   *   靠它），但**射龙门和额头牌的杯数在 btDrink / fhDrinks 里就有**，
   *   不依赖 lastResult。所以把"要不要继续"推迟到每个分支自己判。
   */
  if (!o.lastResult && game !== 'between' && game !== 'forehead') return out

  if (game === 'liar' && lr.loserName) {
    push(lr.loserName, 1)
  } else if (game === 'dice' && Array.isArray(lr.ranked) && lr.ranked.length) {
    /* 点数最少的那个喝 */
    const low = lr.ranked.slice().sort((a, b) => (a.total || 0) - (b.total || 0))[0]
    if (low) push(low.name, 1)
  } else if (game === 'poker') {
    /* 比牌输的人**出局**，可能有 1~2 个 */
    players.filter(p => p.out).forEach(p => push(p.name, 1))
    /* 换牌喝的量记在 pkDrink 里（按 openid），换成名字 */
    const pkd = o.pkDrink || {}
    Object.keys(pkd).forEach(oid => {
      const p = players.filter(x => x.openid === oid)[0]
      if (p) push(p.name, Number(pkd[oid]) || 0)
    })
  }
  /*
   * ★★ 2026-11-04：额头牌 / 射龙门 / 众口一致 / 红黑单双 也进「今晚战况」。
   *
   * 原来只认前三个玩法（大话骰 / 比大小 / 金花）——
   * 后果：用射龙门（喝得最细的玩法，一把 0.5～6 杯）玩一晚上，
   * 结算页那条「今晚：某某 2 杯」永远不出现。不报错，只是永远黑着。
   *
   * 口径沿用同一条：**只统计输家明确的玩法**，
   * 谁喝几杯服务端已经算好（btDrink / fhDrinks / loserSeat），
   * 这里只做「openid → 昵称」的转换，不重新判定。
   */
  if (game === 'between' && o.btDrink) {
    /* 射龙门：btDrink 按 openid 记喝的量（可能是 0.5 这种小数） */
    const btd = o.btDrink
    Object.keys(btd).forEach(oid => {
      const p = players.filter(x => x.openid === oid)[0]
      if (p) push(p.name, Number(btd[oid]) || 0)
    })
  } else if (game === 'forehead' && o.fhDrinks) {
    /* 额头牌：fhDrinks 记换牌喝的半杯，累计 */
    const fhd = o.fhDrinks
    Object.keys(fhd).forEach(oid => {
      const p = players.filter(x => x.openid === oid)[0]
      if (p) push(p.name, Number(fhd[oid]) || 0)
    })
  } else if ((game === 'consensus' || game === 'sieve') && lr.loserName) {
    /* 众口一致 / 红黑单双：输家喝 1 杯 */
    push(lr.loserName, 1)
  }

  /* undercover / wheel：不统计，见文件头的说明（前者是阵营胜负，后者扇区决定谁喝） */

  return out
}

module.exports = { drinkers: drinkers }
