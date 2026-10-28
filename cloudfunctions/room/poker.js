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
   *
   * ★★ 2026-10-27 调研纠正：A23 是**第二大**的顺子，不是最小的。
   *    主流平台（16vs 等）明确写的是：
   *        AKQ > A23 > KQJ > QJ10 > ... > 234
   *    我第一版凭印象做成了"最小顺子"，那会让拿到 A23 的人以为自己输
   *    —— 这是个真会吵架的错。
   *
   *    A23 在 AKQ(14) 和 KQJ(13) 之间，所以比较键取 13.5。
   *    用小数是刻意的：它只需要参与"同牌型内部排序"，
   *    而所有合法的点数都是整数，13.5 不会和任何真实点数撞。
   *
   * ⚠️ 235（"豹子杀手"）**不做**：各地规则相反（有的比豹子大、有的比单张小），
   *    线上平台普遍不启用。做成默认会更让人困惑。
   */
  const isA23 = rs[0] === 14 && rs[1] === 3 && rs[2] === 2
  const isSeq = (rs[0] - rs[1] === 1 && rs[1] - rs[2] === 1) || isA23
  /* A23 排在 AKQ 之后、KQJ 之前 */
  const seqKey = isA23 ? 13.5 : rs[0]

  let type, key
  if (isTriple) {
    type = TYPES.TRIPLE
    key = [rs[0]]
  } else if (isSeq && sameSuit) {
    type = TYPES.STRAIGHT_FLUSH
    key = [seqKey]
  } else if (sameSuit) {
    type = TYPES.FLUSH
    key = rs.slice()
  } else if (isSeq) {
    type = TYPES.STRAIGHT
    key = [seqKey]
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
    /* ⚠️ 不能用 `key[i] || 0`：顺子的比较键可能是 0？不会，但 13.5 这类非整数
       用 || 兜底本身是"把缺失当 0"的坏习惯，这里显式判 undefined。 */
    const x = ra.key[i] === undefined ? 0 : ra.key[i]
    const y = rb.key[i] === undefined ? 0 : rb.key[i]
    if (x !== y) return x - y
  }
  return 0
}

/**
 * 梦幻金花的发牌 —— 和炸金花**完全不是一回事**（用户 2026-10-27 说明）。
 *
 * 炸金花：每人三张全看得到，可以"闷牌"（不看就下注）。
 * 梦幻金花：
 *   · **1 张公共牌** —— 所有人可见，是全场共同的话题
 *   · **每人 1 张明牌** —— 只有自己看得见
 *   · **每人 1 张暗牌** —— 连自己都看不到，靠想象
 *
 * 所以每个人只知道 2/3 的信息，第三张是赌的。
 * 这也解释了为什么**不能闷**：本来就没有"全看"这个状态。
 *
 * 比牌时用「公共牌 + 我的明牌 + 我的暗牌」三张算牌型。
 *
 * @param {number} n 人数
 * @returns {{publicCard: Object, hands: Object[][]}} hands[i] = [明牌, 暗牌]
 */
function dealDream(n, rnd) {
  const deck = shuffle(newDeck(), rnd)
  let k = 0
  const publicCard = deck[k++]
  const hands = []
  for (let i = 0; i < n; i++) hands.push([deck[k++], deck[k++]])
  /* 剩下的牌留着换牌用 —— 换牌必须从**没发出去的牌**里抽，
     不能重发已经有人拿着的那张（那会让人觉得"这牌有鬼"） */
  return { publicCard: publicCard, hands: hands, rest: deck.slice(k) }
}

/** 组合出一个人用来比大小的三张牌 */
function fullHand(publicCard, hand) {
  return [publicCard, hand[0], hand[1]]
}

/**
 * 基于**已知的两张**给一句牌型提示（第三张是暗牌，玩家看不到）。
 *
 * ★ 为什么需要：梦幻金花的暗牌连自己都看不到，玩家看到公共底牌和自己的明牌
 *   之后要做的事是"这两张能凑出什么"——而这个心算对多数人很费劲，
 *   尤其是在酒桌上（还喝着酒）。给一句"至少是对子"能显著降低决策门槛。
 *
 * ★ 为什么它不破坏玩法：提示只用**玩家本来就看得见的两张**算，
 *   不含任何暗牌信息，也不改变比牌结果 —— 它只是把心算替玩家做了一遍。
 *
 * ★ 为什么用"有机会"而不是确切牌型：第三张没看到，任何非确定的说法都是错的。
 *   唯一能确定的只有"两张同点数 → 至少是对子"（第三张怎么变都不会更差）。
 */
function handHint(a, b) {
  if (!a || !b) return ''
  const sameRank = a.r === b.r
  const sameSuit = a.s === b.s
  /* 顺子的可能：两张点数相邻或隔一张（A23 这种特殊相连已在 rank() 里处理，
     这里只做粗略的"有没有机会"，不需要精确） */
  const d = Math.abs(a.r - b.r)
  const nearStraight = d === 1 || d === 2 ||
    /* A 和 2/3 也能连（A23 是第二大顺子） */
    (a.r === 13 && (b.r === 1 || b.r === 2)) ||
    (b.r === 13 && (a.r === 1 || a.r === 2))

  if (sameRank) return '至少是对子'
  if (sameSuit && nearStraight) return '有机会顺金'
  if (sameSuit) return '有机会金花'
  if (nearStraight) return '有机会顺子'
  return '全靠想象了'
}

/** 给界面用的牌面文字，如 "♠A" */
function cardText(c) {
  return SUITS[c.s] + RANKS[c.r]
}

module.exports = {
  SUITS, RANKS, TYPES, TYPE_NAMES,
  newDeck, shuffle, rank, compare, cardText,
  dealDream, fullHand, handHint
}
