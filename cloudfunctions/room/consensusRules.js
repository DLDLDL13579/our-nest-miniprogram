/**
 * consensusRules.js —— 众口一致（Consensus）的规则与判定
 *
 * ============ 这个玩法是什么 ============
 *
 * 房主现场口头出一道估计题（「这瓶酒还剩百分之几」），
 * 每人**秘密**输入一个数；全部交齐后**同时揭晓**。
 *
 *   · 最大值与最小值相差 ≤ 阈值 → **全场通过**，不喝
 *   · 否则 → 离中位数最远的那个人喝
 *
 * ============ 为什么它值得做 ============
 *
 * 8 个现有玩法**全是零和**（一定有人输）。这是第一个"可能全赢"的玩法 ——
 * 大家一起把答案收到一个窄区间里，就都不喝。
 *
 * 而手机在这里承担的是**现实里做不到的两件事**：
 *   ① 秘密收集 —— 口头报数会被后面的人搭便车，判断就消失了
 *   ② 同时揭晓 —— 有先后顺序的话，先说的会影响后说的
 *
 * ⚠️ **零题库**：题目由房主现场出，App 不提供、不校验。
 *    这也是它和「押谁最接近」最大的区别 —— 那个玩法必须有可查证的答案，
 *    题库成本是它的命门；这个玩法**没有标准答案要查**。
 */

/** 允许的数值范围（防止有人输入天文数字把区间撑爆） */
const MIN_VALUE = 0
const MAX_VALUE = 9999

/**
 * 「多接近算一致」的阈值。
 *
 * ★ 单位是**比例**而不是绝对值：题目可能是"还剩百分之几"（0..100），
 *   也可能是"还有几分钟"（0..60），用绝对差会让不同题目难度差几倍。
 *
 * 取 0.30 的理由：
 *   · 太小（0.1）→ 几乎不可能通过，玩法退化成"每次都有人喝"，和零和没区别
 *   · 太大（0.6）→ 几乎每次都通过，没有张力
 *   · 0.30 → 需要大家有意避极端值才有机会通过，是"努力一下能达成"的程度
 */
const SPREAD_RATIO = 0.30

/**
 * 校验一次输入。
 *
 * @returns {{ok:boolean, why:string, value:number}}
 */
function checkValue(v) {
  const n = Number(v)
  if (!isFinite(n) || isNaN(n)) return { ok: false, why: '要输入一个数字', value: 0 }
  if (Math.abs(n - Math.round(n)) > 1e-9) return { ok: false, why: '只接受整数', value: 0 }
  if (n < MIN_VALUE) return { ok: false, why: '不能小于 ' + MIN_VALUE, value: 0 }
  if (n > MAX_VALUE) return { ok: false, why: '不能大于 ' + MAX_VALUE, value: 0 }
  return { ok: true, why: '', value: Math.round(n) }
}

/**
 * 判一致 + 找离群者。
 *
 * @param {Array<{seat:number, name:string, value:number}>} answers
 * @returns {{pass:boolean, spread:number, allowed:number, min:number, max:number,
 *            median:number, outlierSeat:number, outlierName:string, detail:string}}
 */
function judge(answers) {
  const list = (Array.isArray(answers) ? answers : [])
    .filter((a) => a && isFinite(Number(a.value)))
    .map((a) => ({ seat: a.seat, name: a.name, value: Number(a.value) }))
    .sort((a, b) => a.value - b.value)

  if (!list.length) {
    return {
      pass: false, spread: 0, allowed: 0, min: 0, max: 0, median: 0,
      outlierSeat: 0, outlierName: '', detail: '还没有人交答案'
    }
  }

  const min = list[0].value
  const max = list[list.length - 1].value
  const spread = max - min
  const mid = (min + max) / 2
  /*
   * 阈值按**区间中点**算比例，不是按 max 或 min 算。
   *   为什么：如果按 max 算，"0 到 30" 的 ratio 是 1.0，
   *   而 "70 到 100" 的 ratio 只有 0.43 —— 同一个跨度在数值大时更容易通过，
   *   这对猜小数值的题不公平。
   */
  /*
   * ★★ 2026-11-03：阈值改成按**最大值**算，不按中点。
   *
   *   中点版的问题：所有人答案都是 0 时中点 = 0 → 阈值 0 →
   *   `spread <= 0` 虽然仍成立（spread 也是 0），但**玩家看不到一个合理的阈值数字**，
   *   界面上会写"跨度 ≤ 0 算通过"，读起来像 bug。
   *
   *   按最大值算：0..30 → 9；70..100 → 30。大数容得下更大误差，符合直觉，
   *   而且**不会出现"阈值是 0 但还要通过"这种自相矛盾的文案**。
   *
   *   ⚠️ 全 0 时最大值是 0，阈值仍是 0 —— 但那时 spread 也是 0，
   *      所以结论（通过）依然自洽，文案改成"全部一样"即可。
   */
  const base = Math.abs(max) < 1e-9 ? 0 : Math.abs(max)
  const allowed = base * SPREAD_RATIO

  /*
   * 中位数：偶数个取中间两个的平均。
   * ★ 离群判定用中位数而不是平均数 —— 平均数会被离群者自己拉偏，
   *   于是"离群者"可能反而变成最接近的一个（经典陷阱）。
   */
  const n = list.length
  const median = n % 2 === 1
    ? list[(n - 1) / 2].value
    : (list[n / 2 - 1].value + list[n / 2].value) / 2

  if (spread <= allowed) {
    /*
     * ★ 文案要分两种：全同值 vs 有差异但够接近。
     *   全 0 / 全同值时会算出"阈值 0"，写"跨度 ≤ 0 算通过"读起来像 bug。
     */
    const detail = spread === 0
      ? '全场答案都一样'
      : '最远只差 ' + spread + '，全场通过'
    return {
      pass: true, spread: spread, allowed: allowed, min: min, max: max,
      median: median, outlierSeat: 0, outlierName: '', detail: detail
    }
  }

  /*
   * 找离中位数最远的人。并列时取**数值更大**的那个
   * （画面上更直观：往上偏的人更"出头"），这个口径要写死在规则页。
   */
  let worst = null
  let worstD = -1
  list.forEach((a) => {
    const d = Math.abs(a.value - median)
    if (d > worstD || (Math.abs(d - worstD) < 1e-9 && worst && a.value > worst.value)) {
      worstD = d
      worst = a
    }
  })

  return {
    pass: false, spread: spread, allowed: allowed, min: min, max: max,
    median: median,
    outlierSeat: worst ? worst.seat : 0,
    outlierName: worst ? worst.name : '',
    detail: '最远差 ' + spread + '（超过 ' + Math.round(allowed) + '），' +
      ((worst && worst.name) || '有人') + ' 离得最远'
  }
}

/** 每轮有没有收齐 */
function allIn(players, answers) {
  const live = (Array.isArray(players) ? players : []).filter((p) => p.inRound !== false)
  const got = (answers || {})
  return live.length > 0 && live.every((p) => got[p.openid] !== undefined && got[p.openid] !== null)
}

/** 把 { openid: value } 转成 judge() 要的数组 */
function toAnswerList(players, answers) {
  const got = answers || {}
  return (Array.isArray(players) ? players : [])
    .filter((p) => p.inRound !== false)
    .filter((p) => got[p.openid] !== undefined && got[p.openid] !== null)
    .map((p) => ({ seat: p.seat, name: p.name, value: Number(got[p.openid]) }))
}

module.exports = {
  MIN_VALUE, MAX_VALUE, SPREAD_RATIO,
  checkValue, judge, allIn, toAnswerList
}
