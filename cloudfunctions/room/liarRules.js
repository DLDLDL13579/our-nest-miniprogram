/**
 * liarRules.js —— 大话骰的叫骰规则（前后端共享）
 *
 * ============ 为什么必须是共享的 ============
 *
 * 「能怎么叫」有两处需要判断：
 *   · **服务端**：校验请求合不合法（权威）
 *   · **前端**：生成可点的选项（预判）
 *
 * 两边各写一份规则是**必然不一致**的 —— 而这个项目在"同一职责多个出口"
 * 上栽过太多次（派生字段 7 个出口、玩法注册表散在 5 处）。
 * 表现会是"按钮亮了但服务端说不行"或"合法叫法不给按钮"，而且不报错。
 *
 * 所以规则只写在这里，云端用 scripts/sync-derive.sh 拿一份拷贝。
 *
 * 规则依据：docs/大话骰规则.md（广东开平主流玩法）
 */

const DICE_PER_PLAYER = 5

/**
 * 某个叫法最少要喊多少。
 * 分三档：叫 1（人头一）／斋／不斋。
 */
function openNeed(playerCount, zhai, face) {
  /*
   * ★ 2026-10-30 补说明：这里的 `Math.max(2, ...)` 是**有意**的。
   *
   * 真实对局最少 2 人；而单人测试模式（config.js 的 soloTest）为了能测通一局，
   * 会传 playerCount=1。若按 1 人算，起叫只需 2 个，5 颗骰下几乎必中，
   * 反而测不出"叫高了被开"的路径 —— 所以**单人局按 2 人规则跑**。
   *
   * 副作用（不是 bug）：1 人局和 2 人局起叫都是 3 个，看起来像没区分。
   * 真实多人局不会走到这条，规则本身是对的。
   */
  const p = Math.max(2, Number(playerCount) || 2)
  /*
   * ★★★ 2026-11-02 按调研改成公式。原来是一张**硬编码表**：
   *
   *     p=2: 斋2 / 不斋3     p=3: 斋4 / 不斋5
   *     p=4: 斋5 / 不斋6     p=5: 斋6 / 不斋8
   *     p≥6: 斋 p+1 / 不斋 p+2
   *
   * 而调研（百度百科「大话骰」）说的是：
   *   · 不斋：**总玩家数的 1.5 倍**（4 人 → 6 个，6 人 → 9 个）
   *   · 斋：  **至少"人头数"个**（4 人 → 4 个）
   *
   * 那张表里："斋"这一列**每个都多 1**，"6 人不斋"少 1（写 8，应 9）。
   * 也就是整张表是**凭感觉填的**，不是算出来的 ——
   * 而"斋从第几个人开始多算一个"这种事，玩家一数就知道错。
   */
  if (face === 1) return p               // 叫「人头一」：几个人就几个 1
  if (zhai) return p                     // 斋：人头数
  return Math.ceil(p * 1.5)              // 不斋：总人数的 1.5 倍
}

/**
 * 下家能不能这样叫。
 * @param {object|null} cur   上家的叫法 {n, face, zhai}；首叫传 null
 * @param {object} next       这一手 {n, face, zhai}
 * @param {number} playerCount
 * @returns {{ok:boolean, why:string}}
 */
function canRaise(cur, next, playerCount) {
  const p = Math.max(2, Number(playerCount) || 2)

  /* ---------- 首叫：够起叫档 ---------- */
  if (!cur) {
    const need = openNeed(p, !!next.zhai, next.face)
    if (next.n < need) {
      return { ok: false, why: '起叫至少要 ' + need + ' 个' + (next.zhai ? '（斋）' : '') }
    }
    return { ok: true, why: '' }
  }

  /* ★ 2026-11-03：不斋时不许喊 1（喊 1 = 斋，见 options 里的说明） */
  if (Number(next.face) === 1 && !next.zhai) {
    return { ok: false, why: '喊 1 要先开斋（1 不再当万能）' }
  }
  const curZhai = !!cur.zhai
  const nextZhai = !!next.zhai

  /* ---------- 同一形态：正常往上走 ---------- */
  if (curZhai === nextZhai) {
    if (next.face === 1 && cur.face !== 1) {
      const need = openNeed(p, nextZhai, 1)
      if (next.n < need) return { ok: false, why: '叫 1 至少要 ' + need + ' 个' }
      /*
       * ⚠️ 还要比上家大（2026-10-30 验证生成器时抓到的 bug）：
       *   第一版只查了「够人头一」就直接放过，于是上家喊「5 个 3」时
       *   界面会给出「3 个 1」这种按钮 —— 点数 1 是最小的，数量还更少，
       *   点下去必被拒。**前端生成非法选项**比"少给选项"更糟：
       *   玩家会以为规则坏了。
       */
      if (next.n > cur.n) return { ok: true, why: '' }
      return { ok: false, why: '叫 1 时数量要比上家大' }
    }
    if (next.n > cur.n) return { ok: true, why: '' }
    if (next.n === cur.n && next.face > cur.face) return { ok: true, why: '' }
    return { ok: false, why: '只能往上叫（数量变大，或数量同、点数大）' }
  }

  /* ---------- 不斋 → 斋：**数量可以减半** ---------- */
  if (!curZhai && nextZhai) {
    /*
     * ★★ 2026-11-03：补上"减半"这一半。
     *
     *   斋的 1 不再万能，所以同样叫法的达成难度**变高了** ——
     *   于是酒桌上的通行做法是：不斋 6个4 → 斋 **3个4**（数量减半）。
     *
     *   原实现只允许"同数量或更多"，等于把这条最常见的选择堵死了；
     *   而反方向的"斋 → 不斋要加倍"是实现了的 —— **只有一半**。
     *
     *   规则文案里写的也是「斋要改回不斋，数量得加倍」，
     *   反过来的减半是它的自然推论。
     */
    const half = Math.ceil(cur.n / 2)
    if (next.n > cur.n) return { ok: true, why: '' }
    if (next.n === cur.n) {
      return next.face >= cur.face
        ? { ok: true, why: '' }
        : { ok: false, why: '改叫斋时点数不能降低' }
    }
    if (next.n >= half) return { ok: true, why: '' }
    return { ok: false, why: '改叫斋时最少要 ' + half + ' 个（原叫法的一半）' }
  }

  /* ---------- 斋 → 不斋（破斋）：数量加倍 ---------- */
  if (curZhai && !nextZhai) {
    if (next.n >= cur.n * 2) return { ok: true, why: '' }
    return { ok: false, why: '从斋改回不斋，数量要加倍（至少 ' + (cur.n * 2) + ' 个）' }
  }

  return { ok: false, why: '只能往上叫' }
}

/**
 * 生成可点的叫法（给界面用）。
 *
 * 按 n 递增、f 递增收集，取前 MAX 个 —— 首叫时从起叫档开始，
 * 所以不会出现「1 个 1」这种根本不合法、点下去只会被拒的按钮。
 *
 * @param {number} playerCount
 * @param {object|null} cur
 * @param {boolean} zhaiMode  当前是否处于"要叫斋"的模式
 * @param {number} [max]      最多返回几个（默认 24）
 * @returns {Array<{n:number, face:number, zhai:boolean, label:string}>}
 */
function options(playerCount, cur, zhaiMode, max) {
  const p = Math.max(2, Number(playerCount) || 2)
  const total = p * DICE_PER_PLAYER
  const limit = max || 24
  const zhai = !!zhaiMode
  const out = []

  /* 首叫从起叫档起；之后从上家的叫法往上扫 */
  const startN = cur ? 1 : openNeed(p, zhai, 2)
  /*
   * ★ 2026-11-03：**同一个数量内，点数从"上家叫的那个"开始循环**。
   *
   *   场景：上家叫 6个4（不斋），我切到斋 —— 合法的第一个数量是 3。
   *   而 3 这一档里，最自然的是「3个4斋」（数量减半、点数不变），
   *   原来却排在「3个1斋」后面（1→2→3→4 的顺序）。
   *
   *   玩家看到的第一屏是 3个1 / 3个2 / 3个3 / 3个4 ——
   *   他得往后翻 3 个才能找到"跟我刚才叫的同一个点数"。
   *
   *   改成从 `cur.face` 起循环：3个4 / 3个5 / 3个6 / 3个1 / 3个2 / 3个3。
   */
  const f0 = cur ? (Number(cur.face) || 1) : 1
  const faceOrder = []
  for (let k = 0; k < 6; k++) faceOrder.push(((f0 - 1 + k) % 6) + 1)
  for (let n = startN; n <= total; n++) {
    for (const f of faceOrder) {
      /*
       * ★★ 2026-11-03：**不斋时不生成「N个1」**。
       *
       *   在酒桌上，喊「四个一」本身就意味着**把 1 从万能位上拿下来**
       *   （喊 1 之后 1 只算自己）—— 也就是"斋"。所以「不斋 · 1 当万能」
       *   的标签下根本不该出现「4个1」这个选项。
       *
       *   而原来它确实出现，且 `canRaise` 也放行了 ——
       *   计分上它和「4个1斋」完全一样（`countActual` 里 face===1 时
       *   不加倍、也不算万能），**只有界面标签在骗人**。
       *
       *   要喊 1 就先开斋开关（那个开关就在这一排按钮上面）。
       */
      if (f === 1 && !zhai) continue
      if (canRaise(cur, { n: n, face: f, zhai: zhai }, p).ok) {
        out.push({
          n: n,
          face: f,
          zhai: zhai,
          label: n + '个' + f + (zhai ? '斋' : '')
        })
        if (out.length >= limit) return out
      }
    }
  }
  return out
}

module.exports = {
  openNeed: openNeed,
  canRaise: canRaise,
  options: options,
  DICE_PER_PLAYER: DICE_PER_PLAYER
}
