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
  const p = Math.max(2, Number(playerCount) || 2)
  if (face === 1) return p               // 「人头一」：几个人就几个 1
  if (p === 2) return zhai ? 2 : 3
  if (p === 3) return zhai ? 4 : 5
  if (p === 4) return zhai ? 5 : 6
  if (p === 5) return zhai ? 6 : 8
  return zhai ? p + 1 : p + 2
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

  /* ---------- 不斋 → 斋：可以同数量 ---------- */
  if (!curZhai && nextZhai) {
    if (next.n > cur.n) return { ok: true, why: '' }
    if (next.n === cur.n) {
      return next.face >= cur.face
        ? { ok: true, why: '' }
        : { ok: false, why: '改叫斋时点数不能降低' }
    }
    return { ok: false, why: '改叫斋时数量不能减少' }
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
  for (let n = startN; n <= total; n++) {
    for (let f = 1; f <= 6; f++) {
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
