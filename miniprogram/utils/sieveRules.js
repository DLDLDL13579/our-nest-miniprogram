/**
 * sieveRules.js —— 红黑单双大小（Sieve）的规则与判定
 *
 * ============ 这个玩法是什么 ============
 *
 * 每人一盅 5 颗骰子。每轮**由当前玩家临时指定一条筛选规则**，
 * 所有人按这条规则把自己不符合的骰子拿掉、剩下的重摇，
 * **先把自己骰子拿光的人输**。
 *
 * 和现有「比大小」的区别：那个是"摇一次、比牌型、定输赢"；
 * 这个是"规则每轮都在变的淘汰赛"。唯一相同的是都用 5 颗骰子。
 *
 * ============ 为什么单独一个文件 ============
 *
 * 六条规则里有三条是**同一件事的两种说法**（大小 / 单双 / 红黑），
 * 而它们各自都会直接决定"谁被拿光"。内联在 action 里就没法穷举验证。
 * 项目里栽过：规则内联 = 设法单测（`dicerank.js` 就是从 roll 里抽出来才测得了豹子）。
 */

/**
 * 六条规则。
 *
 * ★ `keep` 的语义是「**留下来**的骰子」，不是「拿掉的」。
 *   为什么这么定：真正要算的是"你还能留几颗"，而拿掉的是它的补集 ——
 *   写成 keep 后面所有逻辑（判输赢、算剩余）都少一次取反，
 *   而**多一次取反就多一次写反的机会**。
 */
const RULES = [
  {
    k: 'red', name: '红的留下', short: '红',
    desc: '只留红色骰子',
    keep: (d) => d.color === 'red'
  },
  {
    k: 'black', name: '黑的留下', short: '黑',
    desc: '只留白色骰子',
    keep: (d) => d.color === 'ivory'
  },
  {
    k: 'big', name: '大的留下', short: '大',
    desc: '只留 4、5、6',
    keep: (d) => d.face >= 4
  },
  {
    k: 'small', name: '小的留下', short: '小',
    desc: '只留 1、2、3',
    keep: (d) => d.face <= 3
  },
  {
    k: 'odd', name: '单数留下', short: '单',
    desc: '只留 1、3、5',
    keep: (d) => d.face % 2 === 1
  },
  {
    k: 'even', name: '双数留下', short: '双',
    desc: '只留 2、4、6',
    keep: (d) => d.face % 2 === 0
  }
]

const BY_KEY = {}
RULES.forEach((r) => { BY_KEY[r.k] = r })

/** 每人初始骰子数 */
const DICE_PER_PLAYER = 5

/**
 * 一条规则对一副骰子的影响。
 *
 * @param {Array<{face:number,color:string}>} dice
 * @param {string} ruleKey
 * @returns {{kept:Array, removed:Array, left:number}}
 */
function applyRule(dice, ruleKey) {
  const r = BY_KEY[ruleKey]
  const list = Array.isArray(dice) ? dice : []
  if (!r) return { kept: [], removed: [], left: list.length, badRule: true }
  const kept = list.filter((d) => r.keep(d))
  const removed = list.filter((d) => !r.keep(d))
  return { kept: kept, removed: removed, left: kept.length, badRule: false }
}

/**
 * 这条规则在当前局面下**还能不能喊**。
 *
 * ★ 为什么需要这个判断：如果所有人手里的骰子都不符合这条规则，
 *   那喊完大家都是 0 颗 —— 一次淘汰所有人，游戏立刻结束且毫无过程。
 *   这不是"某个人的策略"，是**规则本身在这个局面下失效了**，必须拦掉。
 *
 * @param {Array<Array>} allDice 所有人当前的骰子
 * @returns {boolean} true = 至少还有一个人能留下至少 1 颗
 */
function ruleIsUseful(allDice, ruleKey) {
  const r = BY_KEY[ruleKey]
  if (!r) return false
  const lists = Array.isArray(allDice) ? allDice : []
  for (let i = 0; i < lists.length; i++) {
    const kept = (lists[i] || []).filter((d) => r.keep(d))
    if (kept.length > 0) return true
  }
  return false
}

/**
 * 当前局面下**所有还能喊的规则**。
 * 空数组意味着"没有任何规则可用" —— 那是死锁，调用方必须处理。
 */
function usableRules(allDice) {
  return RULES.filter((r) => ruleIsUseful(allDice, r.k)).map((r) => r.k)
}

/**
 * 结算：谁被淘汰（骰子拿光）。
 *
 * @param {Array<{seat:number, dice:Array}>} players
 * @returns {{losers:number[], allOut:boolean}}
 *   losers: 骰子为 0 的座位号
 *   allOut: 所有人都没了 —— 这一轮必须作废重来（见 below）
 */
function settle(players) {
  const list = Array.isArray(players) ? players : []
  const losers = []
  list.forEach((p) => {
    const n = (p.dice || []).length
    if (n === 0) losers.push(p.seat)
  })
  /*
   * ★ 全员出局 = 这一轮无效。
   *
   *   为什么会发生：某条规则把所有**还活着的人**都筛成 0。
   *   `ruleIsUseful` 已经在喊规则时拦过一次，但那是基于"喊之前"的快照；
   *   而骰子是喊完才摇出来的 —— 所以仍有可能全员清零。
   *
   *   规则口径（写死在规则页）：
   *     · 1 个人清零 = 他输
   *     · **2 个人以上同时清零 = 那一轮作废**，所有人恢复上一轮的状态重来
   *   为什么不是"都喝"：同时清零是运气而不是判断，罚所有人只会让游戏变随机。
   */
  return { losers: losers, allOut: losers.length > 1 && losers.length === list.filter(p => (p.inRound !== false)).length }
}

/** 取规则定义（前端渲染按钮用，避免两处写死文案） */
function ruleOf(k) { return BY_KEY[k] || null }

/** 前端要用的规则清单（只给展示字段，不把函数带出去） */
function ruleList() {
  return RULES.map((r) => ({ k: r.k, name: r.name, short: r.short, desc: r.desc }))
}

module.exports = {
  RULES, DICE_PER_PLAYER, BY_KEY,
  applyRule, ruleIsUseful, usableRules, settle, ruleOf, ruleList
}
