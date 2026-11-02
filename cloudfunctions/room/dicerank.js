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
 *
 * ============ 规则（2026-11-02 按调研重写） ============
 *
 * ⚠️ **旧版只比"总点数 + 豹子"** —— 那是残缺的。
 *
 * 真实酒桌的「摇骰子比大小」（调研来源：恩熙俊《喝酒遊戲 Vol.1》讲的三合一规则）
 * 用的是**扑克牌型系统**，9 种牌型从低到高：
 *
 *     散牌 < 一对 < 两对 < 三条 < 顺子 < 同花 < 葫芦 < 四条 < 五条
 *
 * 「同花」需要骰子有颜色（全黑/全红），而我们的骰子是黑白的 ——
 * 调研文章本身也说"通常是不玩同花"，所以这里**不做同花**，其余 8 种全实现。
 *
 * ★ 这不只是"更完整"，它改变的是**体验**：
 *   只比总点数时，数字一加就知道结果，中间没有任何期待；
 *   而牌型让"两对""顺子""葫芦"这些**常见组合**也有价值 ——
 *   摇到 3 个 6 加 2 个 3 是葫芦，比散牌的 25 点还大。
 *   这才是"有盼头"的来源。
 *
 * ============ 排序键 ============
 *
 *     rankKey = 牌型等级 × 1e10 + 细节分
 *
 * 同牌型之间比细节分（比如都是两对，比大对子；都是散牌，比最大的那张）。
 * 一条 `sort((a,b) => b.rankKey - a.rankKey)` 就够了，
 * 不需要"先按等级分组再排序"那种两段式判断（两段式最容易漏掉并列）。
 */

/** 一颗骰子的范围检查：数据的可信度由服务端保证，这里只做兜底 */
function isDie(d) {
  return Number.isInteger(d) && d >= 1 && d <= 6
}

/* 牌型等级（数值越大越强）。同花没有实现，见文件头说明。 */
const LEVEL = {
  HIGH: 1,        // 散牌
  ONE_PAIR: 2,    // 一对
  TWO_PAIR: 3,    // 两对
  THREE: 4,       // 三条
  STRAIGHT: 5,    // 顺子
  FULL_HOUSE: 6,  // 葫芦（三条 + 一对）
  FOUR: 7,        // 四条
  FIVE: 8         // 五条（豹子）
}

const NAME = {
  1: '散牌', 2: '一对', 3: '两对', 4: '三条',
  5: '顺子', 6: '葫芦', 7: '四条', 8: '五条'
}

/**
 * 判定一组骰子的牌型。
 *
 * @param {number[]} dice 已经过 isDie 过滤
 * @returns {{level:number, name:string, detail:number}}
 *   detail 用于同牌型之间比大小（越大越强）
 */
function evaluate(dice) {
  if (!dice.length) return { level: 0, name: '无', detail: 0 }

  /* 每种点数出现几次 */
  const cnt = {}
  dice.forEach(d => { cnt[d] = (cnt[d] || 0) + 1 })
  /* 按"次数降序、点数降序"排：groups[0] 永远是最主要的那组 */
  const groups = Object.keys(cnt)
    .map(k => ({ v: Number(k), n: cnt[k] }))
    .sort((a, b) => b.n - a.n || b.v - a.v)

  const n5 = groups.filter(g => g.n === 5).length
  const n4 = groups.filter(g => g.n === 4).length
  const n3 = groups.filter(g => g.n === 3).length
  const n2 = groups.filter(g => g.n === 2).length

  const uniq = Array.from(new Set(dice)).sort((a, b) => a - b)
  const straightHigh = uniq.length === 5 &&
    (uniq.join(',') === '1,2,3,4,5' || uniq.join(',') === '2,3,4,5,6')
    ? uniq[4] : 0

  if (n5) {
    /* 五条：比点数（五个 6 > 五个 1） */
    return { level: LEVEL.FIVE, name: NAME[LEVEL.FIVE], detail: groups[0].v }
  }
  if (n4) {
    /* 四条：比四条的点数，再比单张 */
    return { level: LEVEL.FOUR, name: NAME[LEVEL.FOUR],
      detail: groups[0].v * 100 + groups[1].v }
  }
  if (n3 && n2) {
    /* 葫芦：比三条的点数，再比对子的点数 */
    return { level: LEVEL.FULL_HOUSE, name: NAME[LEVEL.FULL_HOUSE],
      detail: groups[0].v * 100 + groups[1].v }
  }
  if (straightHigh) {
    /* 顺子：23456（高）> 12345（低） */
    return { level: LEVEL.STRAIGHT, name: NAME[LEVEL.STRAIGHT], detail: straightHigh }
  }
  if (n3) {
    /* 三条：比三条点数，再比起脚牌（降序） */
    const k = groups.filter(g => g.n === 1).map(g => g.v).sort((a, b) => b - a)
    return { level: LEVEL.THREE, name: NAME[LEVEL.THREE],
      detail: groups[0].v * 10000 + (k[0] || 0) * 100 + (k[1] || 0) }
  }
  if (n2 >= 2) {
    /* 两对：先比大对，再比小对，最后比单张 */
    const ps = groups.filter(g => g.n === 2).map(g => g.v).sort((a, b) => b - a)
    const kick = groups.filter(g => g.n === 1).map(g => g.v)[0] || 0
    return { level: LEVEL.TWO_PAIR, name: NAME[LEVEL.TWO_PAIR],
      detail: ps[0] * 10000 + ps[1] * 100 + kick }
  }
  if (n2 === 1) {
    /* 一对：比对子点数，再比三张起脚牌 */
    const k = groups.filter(g => g.n === 1).map(g => g.v).sort((a, b) => b - a)
    return { level: LEVEL.ONE_PAIR, name: NAME[LEVEL.ONE_PAIR],
      detail: groups[0].v * 1000000 + (k[0] || 0) * 10000 + (k[1] || 0) * 100 + (k[2] || 0) }
  }
  /* 散牌：五张从大到小，按位加权（最大那张最重） */
  const all = dice.slice().sort((a, b) => b - a)
  let det = 0
  for (let i = 0; i < all.length; i++) det += all[i] * Math.pow(10, 8 - i * 2)
  return { level: LEVEL.HIGH, name: NAME[LEVEL.HIGH], detail: det }
}

/**
 * 算出排名与赢家。
 *
 * @param {Array} players [{ name, seat, dice: number[] }]
 * @returns {object} { ranked, winners, top, handicapWin, handicapFace, winnerSeats, topHand }
 *   ranked      —— 已按 rankKey 降序；含 { name, seat, dice, total, hand, handName, rankKey }
 *   winners     —— 赢家的名字数组（并列时多个）
 *   top         —— 赢家的总点数（并列取最高那个）
 *   handicapWin —— 赢家里有没有「四条及以上」（旧的 leopardWin 的推广版）
 *   handicapFace —— 那个稀有牌型的具体点数（0 = 没有）
 *   winnerSeats —— 赢家的座位号数组
 *   topHand     —— 赢家的牌型名
 *
 * ★ `leopardWin` / `leopardFace` 两个旧字段**保留**（值和 handicapWin 一致），
 *   因为界面和测试里已经在用了。改名是为了语义更准 ——
 *   "豹子"只指五条，而这里四条也算稀有牌型。
 */
function rankPlayers(players) {
  const list = (players || []).map(p => {
    /* 只认合法的骰子点：非法值直接剔除，不参与计算（脏数据不该让整局崩） */
    const ds = (p.dice || []).filter(isDie)
    const total = ds.reduce((a, b) => a + b, 0)
    const hand = evaluate(ds)
    return {
      name: p.name,
      seat: p.seat,
      dice: ds,
      total: total,
      hand: hand.level,
      handName: hand.name,
      rankKey: hand.level * 1e10 + hand.detail
    }
  }).sort((a, b) => b.rankKey - a.rankKey)

  if (!list.length) {
    return { ranked: [], winners: [], top: 0, handicapWin: false, handicapFace: 0,
      leopardWin: false, leopardFace: 0, winnerSeats: [], topHand: '' }
  }

  const topKey = list[0].rankKey
  const winnerRows = list.filter(r => r.rankKey === topKey)
  /*
   * 两个不同的概念，别混：
   *   · 豹子（leopard）—— **只指五条**。有现成的界面文案和测试依赖这个语义，
   *     改成"四条也算"会静默改变别的行为（全量测试当场就抓到了）。
   *   · 稀有牌型（handicap）—— 四条及以上，概率 1/1296 到 1/54，都有仪式感。
   */
  const leopardR = winnerRows.filter(r => r.hand >= LEVEL.FIVE)[0] || null
  const rareRow = winnerRows.filter(r => r.hand >= LEVEL.FOUR)[0] || null

  return {
    ranked: list,
    winners: winnerRows.map(r => r.name),
    /* top 用"赢家的总点数"：四条赢的时候它可能比对家低，界面要显示的是赢家的点数 */
    top: winnerRows[0].total,
    topHand: winnerRows[0].handName,
    handicapWin: !!rareRow,
    handicapFace: rareRow ? rareRow.dice.slice().sort((a, b) => b - a)[0] : 0,
    /* 旧字段：语义保持「只有五条」，不要偷偷改成"四条也算" */
    leopardWin: !!leopardR,
    leopardFace: leopardR ? leopardR.dice.slice().sort((a, b) => b - a)[0] : 0,
    winnerSeats: winnerRows.map(r => r.seat)
  }
}

module.exports = { rankPlayers, evaluate, LEVEL, NAME }
