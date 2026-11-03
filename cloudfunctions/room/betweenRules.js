/**
 * betweenRules.js —— 射龙门（In Between）的规则与判定
 *
 * ============ 为什么单独一个文件 ============
 *
 * 这个玩法**只有三个判定器**，但它们都会直接决定"谁喝多少"：
 *   ① 第三张牌落在龙门内 / 外 / 撞柱（三档结果，撞柱双倍）
 *   ② 两张龙门牌同点 → 龙门关死（不能翻第三张）
 *   ③ 认低威（不翻牌，直接喝一啖）
 *
 * 项目里反复出现的一条教训：**内联在 action 分支里的规则根本没法单测**
 * （`dicerank.js` 就是从 roll 分支里抽出来才测得了豹子）。
 * 所以这里全部写成纯函数：输入牌 / 输入押注，输出结论，不碰数据库、不碰 wx。
 *
 * ============ 规则口径（各家不同，本项目必须写死并在规则页写明）============
 *
 * 来源：HANGOVER HK《射龍門玩法與規則・圖解》+ 知乎酒桌游戏条目，两处口径一致之处采用。
 *
 *   ① **押注在前**：轮到你，先说这一把赌多少，**说了不许改**。
 *      现实中靠"你刚才说了半杯"这句口头承诺 —— 酒后最容易反悔；
 *      服务端先落库再发牌，反悔不了。这是这个玩法用手机的第一个理由。
 *   ② **A 最大（14）**，成晚不变。各家有的把 A 当 1，我们不采用 ——
 *      混用会让"5 到 K 之间"这种判断产生歧义。
 *   ③ **撞柱 = 第三张与任一张龙门牌同点 → 喝双倍**。
 *   ④ **龙门关死**（两张龙门牌同点）→ 直接喝一啖，不翻第三张。
 *   ⑤ **认低威**（门太窄可以不翻）→ 直接喝一啖收工。这是止损阀门，必须提供。
 */

/** A 最大：点数 2..14，14 = A。比大小用 `r` 直接比即可。 */
const MIN_RANK = 2
const MAX_RANK = 14

/** 单次押注的上下限（单位：杯）。半杯是最小单位 —— 和金花换牌同一档。 */
const MIN_BET = 0.5
const MAX_BET = 3

/** 认低威的固定代价：一啖 = 半杯（各枱口径不同，本项目取最小单位） */
const BAIL_COST = 0.5

/**
 * 押注合法性。
 *
 * 为什么不用"必须整数"：酒桌上"半杯"是非常常见的量词，
 * 而项目里唯一的量纲就是杯 —— 所以允许 0.5 的倍数，不接受 0.3 这种。
 *
 * @returns {{ok:boolean, why:string, bet:number}}
 */
function checkBet(bet) {
  const n = Number(bet)
  if (!isFinite(n) || isNaN(n)) return { ok: false, why: '押注必须是数字', bet: 0 }
  /*
   * ★ 用 `n * 2` 是否为整数来判断"是不是 0.5 的倍数"，
   *   而不是 `n % 0.5 === 0` —— 浮点取模在 0.5 上虽然恰好安全，
   *   但这个写法对"0.1 的倍数"这类扩展更容易改对，也更不容易被后人改错。
   */
  if (Math.abs(n * 2 - Math.round(n * 2)) > 1e-9) {
    return { ok: false, why: '押注只能是 0.5 杯的倍数', bet: 0 }
  }
  if (n < MIN_BET) return { ok: false, why: '最少押 ' + MIN_BET + ' 杯', bet: 0 }
  if (n > MAX_BET) return { ok: false, why: '最多押 ' + MAX_BET + ' 杯', bet: 0 }
  return { ok: true, why: '', bet: n }
}

/**
 * 龙门是否关死（两张牌同点）。
 * 关死时不翻第三张、直接喝一啖 —— 规则里写死的一条。
 */
function isClosed(a, b) {
  return !!a && !!b && a.r === b.r
}

/**
 * 判第三张牌。
 *
 * @param {{r:number}} a 龙门左牌
 * @param {{r:number}} b 龙门右牌
 * @param {{r:number}} third 第三张
 * @returns {{result:'in'|'out'|'post', face:number}}
 *   in   —— 落在两牌之间 → 不用喝
 *   out  —— 落在外面 → 喝押注额
 *   post —— 撞柱（与任一龙门牌同点）→ 喝双倍
 */
function judge(a, b, third) {
  if (!a || !b || !third) return { result: 'out', face: 0 }
  /*
   * ★ 撞柱判定必须在区间判定**之前**。
   *
   *   如果先判区间：`lo <= x && x <= hi` 会把"正好等于端点"算成 in
   *   —— 而端点就是龙门牌本身，那恰好是撞柱（要喝双倍）。
   *   顺序写反 → 撞柱永远判不出来，而且**玩家不会觉得是 bug，
   *   会觉得"我明明撞上了却说我没喝"，正好反了**。
   */
  if (third.r === a.r || third.r === b.r) return { result: 'post', face: third.r }

  const lo = Math.min(a.r, b.r)
  const hi = Math.max(a.r, b.r)
  if (third.r > lo && third.r < hi) return { result: 'in', face: third.r }
  return { result: 'out', face: third.r }
}

/**
 * 一把的完整结算：给定押注 + 三张牌，算出**实际要喝多少杯**。
 *
 * 这是唯一出口 —— 云函数和前端预览、单测都走它，
 * 避免"服务端算一套、界面显示另一套"（项目里叫"两个出口必然不同步"）。
 *
 * @param {{bet:number, gateA:Object, gateB:Object, third:Object|null, bailed:boolean}} s
 * @returns {{outcome:string, cups:number, title:string, detail:string}}
 */
function settle(s) {
  const st = s || {}
  const bet = Number(st.bet) || 0

  /* ① 认低威：自己放弃翻牌，只喝一啖（不看龙门宽窄，代价固定） */
  if (st.bailed) {
    return {
      outcome: 'bail', cups: BAIL_COST,
      title: '认低威',
      detail: '没翻第三张，喝 ' + BAIL_COST + ' 杯收工'
    }
  }

  /* ② 龙门关死：两张同点，规则要求直接喝一啖，不翻牌 */
  if (isClosed(st.gateA, st.gateB)) {
    return {
      outcome: 'closed', cups: BAIL_COST,
      title: '龙门关了',
      detail: '两张都是 ' + (st.gateA ? st.gateA.r : '?') + ' 点，喝 ' + BAIL_COST + ' 杯'
    }
  }

  /* ③ 正常判第三张 */
  const j = judge(st.gateA, st.gateB, st.third)
  if (j.result === 'in') {
    return { outcome: 'in', cups: 0, title: '穿过去了', detail: '不用喝' }
  }
  if (j.result === 'post') {
    return {
      outcome: 'post', cups: bet * 2,
      title: '撞柱',
      detail: '第三张也是 ' + j.face + ' 点 —— 双倍，喝 ' + (bet * 2) + ' 杯'
    }
  }
  return {
    outcome: 'out', cups: bet,
    title: '打偏了',
    detail: '不在龙门里，喝 ' + bet + ' 杯'
  }
}

/**
 * 龙门宽不宽 —— 只用来给界面一句提示，**不参与判定**。
 *
 * 为什么要它：玩家押注时龙门还没开，开完才看到宽窄。
 * 一句"这条缝很窄"能让"我当时该认低威"变成桌上的一句玩笑 ——
 * 那是酒桌游戏最值钱的部分，而它不影响任何数值。
 */
function widthHint(a, b) {
  if (!a || !b) return ''
  if (a.r === b.r) return '龙门关了'
  const w = Math.abs(a.r - b.r)
  if (w === 1) return '就差一个点 —— 这条缝窄得离谱'
  if (w <= 3) return '窄'
  if (w <= 6) return '还行'
  return '开得很宽'
}

module.exports = {
  MIN_RANK, MAX_RANK, MIN_BET, MAX_BET, BAIL_COST,
  checkBet, isClosed, judge, settle, widthHint
}
