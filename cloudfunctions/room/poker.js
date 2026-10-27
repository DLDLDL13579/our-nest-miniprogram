/**
 * poker.js —— 扑克牌与「梦幻金花（炸金花）」牌型比较
 *
 * ============ 为什么单独抽一个文件 ============
 *
 * 牌型比较是这个玩法的**全部正确性**所在：
 *   · 比错了不会报错，只会"明明我比他大却判我输"
 *   · 玩家不会觉得是 bug，会觉得这个 App 在作弊
 *
 * 所以它必须是**纯函数**、可被穷举测试，而且**前后端各有一份逐字节相同的拷贝**
 * （云函数不能跨目录 require，由 scripts/sync-derive.sh 同步）。
 *
 * ============ 牌怎么表示 ============
 *   { r: 2..14, s: 0..3 }
 *   r：2-10 就是点数，J=11 Q=12 K=13 A=14
 *   s：0 黑桃 1 红桃 2 梅花 3 方块（花色**不比大小**，只是为了判同花）
 */

/** 花色名（界面用） */
const SUITS = ['♠', '♥', '♣', '♦']
/** 点数名（界面用） */
const RANKS = ['', '', '2', '3', '4', '5', '6', '7', '8', '9', '10', 'J', 'Q', 'K', 'A']

/** 牌型 —— 数字越大越强 */
const TYPES = {
  HIGH: 0,     // 单张
  PAIR: 1,     // 对子
  STRAIGHT: 2, // 顺子
  FLUSH: 3,    // 金花（同花）
  STRAIGHT_FLUSH: 4, // 顺金（同花顺）
  TRIPLE: 5    // 豹子（三条）
}

const TYPE_NAMES = ['单张', '对子', '顺子', '金花', '顺金', '豹子']

/** 生成一副 52 张 */
function newDeck() {
  const d = []
  for (let s = 0; s < 4; s++) {
    for (let r = 2; r <= 14; r++) d.push({ r: r, s: s })
  }
  return d
}

/**
 * 洗牌（Fisher-Yates）。
 * ★ 不用 `sort(() => Math.random() - 0.5)` —— 那个分布不均，
 *   在"发牌"这种对公平性敏感的地方会导致某些牌更容易出现。
 *
 * @param {Array} deck 可选，默认新牌
 * @param {function} rnd 可注入随机源（测试用）
 */
function shuffle(deck, rnd) {
  const a = (deck || newDeck()).slice()
  const r = rnd || Math.random
  for (let i = a.length - 1; i > 0; i--) {
    const j = Math.floor(r() * (i + 1))
    const t = a[i]; a[i] = a[j]; a[j] = t
  }
  return a
}

/**
 * 算一手牌的牌型与比较键。
 *
 * @returns {{type:number, key:number[], name:string}}
 *   type 越大越强；key 用于同牌型逐位比较（第一位最大）
 */
function rank(cards) {
  const rs = cards.map(c => c.r).sort((a, b) => b - a)   // 降序
  const ss = cards.map(c => c.s)
  const sameSuit = ss[0] === ss[1] && ss[1] === ss[2]

  const isTriple = rs[0] === rs[1] && rs[1] === rs[2]

  /*
   * 顺子判定，含 **A23**（A 当 1 用）。
   * 真实规则里 A23 是最小的顺子（比 234 还小），不是最大的。
   * 所以比较键要把它映射成 3,2,1，让它在顺子里垫底。
   * 不做这条的话，拿到 A23 的人会以为自己有顺子、其实被判成单张 —— 争议点。
   */
  const isA23 = rs[0] === 14 && rs[1] === 3 && rs[2] === 2
  const isSeq = (rs[0] - rs[1] === 1 && rs[1] - rs[2] === 1) || isA23

  let type, key
  if (isTriple) {
    type = TYPES.TRIPLE
    key = [rs[0]]
  } else if (isSeq && sameSuit) {
    type = TYPES.STRAIGHT_FLUSH
    key = isA23 ? [3] : [rs[0]]
  } else if (sameSuit) {
    type = TYPES.FLUSH
    key = rs.slice()
  } else if (isSeq) {
    type = TYPES.STRAIGHT
    key = isA23 ? [3] : [rs[0]]
  } else if (rs[0] === rs[1] || rs[1] === rs[2]) {
    type = TYPES.PAIR
    /* 对子的点数优先，单张次之。rs 已降序：
       [K,K,5] → 对 K；[K,5,5] → 对 5。用出现两次的那个当第一键。 */
    const pairRank = rs[0] === rs[1] ? rs[0] : rs[1]
    const kicker = rs[0] === rs[1] ? rs[2] : rs[0]
    key = [pairRank, kicker]
  } else {
    type = TYPES.HIGH
    key = rs.slice()
  }

  return { type: type, key: key, name: TYPE_NAMES[type] }
}

/**
 * 比两手牌。> 0 表示 a 大，< 0 表示 b 大，=== 0 表示完全并列。
 *
 * ★ 并列是**真实存在**的（同牌型同点数，比如都是黑桃 AK9 和红桃 AK9）。
 *   调用方必须显式处理并列（炸金花里通常是"先比的人赢"或"平局"），
 *   不能假装不会发生 —— 假装的话就是静默判一个人输。
 */
function compare(a, b) {
  const ra = rank(a), rb = rank(b)
  if (ra.type !== rb.type) return ra.type - rb.type
  const n = Math.max(ra.key.length, rb.key.length)
  for (let i = 0; i < n; i++) {
    const x = ra.key[i] || 0
    const y = rb.key[i] || 0
    if (x !== y) return x - y
  }
  return 0
}

/** 给界面用的牌面文字，如 "♠A" */
function cardText(c) {
  return SUITS[c.s] + RANKS[c.r]
}

module.exports = {
  SUITS, RANKS, TYPES, TYPE_NAMES,
  newDeck, shuffle, rank, compare, cardText
}
