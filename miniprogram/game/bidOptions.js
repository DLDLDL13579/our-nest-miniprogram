/**
 * bidOptions.js —— 大话骰"可选的叫法"
 *
 * ============ 这是规则的核心，一直没测过 ============
 *
 * 「只能往上叫」是大话骰唯一的硬规则：数量变大，或数量不变点数变大。
 * 它原来内联在 room.js 的 buildOptions 里，**没有单测** ——
 * 而判错了的表现是"按钮点了没用"或"叫出了更低的值"，都不报错。
 *
 * 关于 MAX = 24：
 *   · 第一个叫（没有 cur）时，候选是 1~total 个 × 1~6 面，8 人局就有 240 个 ——
 *     手机上不可能全列出来，也没人会从"20 个 6"开始叫。
 *   · 按 n 递增、f 递增排序后取前 24 个 = "1~4 个 × 全部 6 个面"，
 *     正好覆盖开局的常规叫法（酒桌上第一个叫通常从 2 个几起步）。
 *   · 一旦有人叫了，候选从 cur 往上算，24 个足够覆盖到"数量加一"那一档。
 */

const DICE_PER_PLAYER = 5
const MAX = 24

/**
 * @param {number} count   房间里几个人
 * @param {object|null} cur 当前叫骰 { n, face }，没有就是第一个叫
 * @returns {string[]}     可点的叫法，如 ['2个3', '2个4', ...]
 */
function list(count, cur) {
  const total = (count || 2) * DICE_PER_PLAYER
  const out = []
  for (let n = 1; n <= total; n++) {
    for (let f = 1; f <= 6; f++) {
      if (!cur) {
        out.push(n + '个' + f)
      } else if (n > cur.n || (n === cur.n && f > cur.face)) {
        out.push(n + '个' + f)
      }
    }
  }
  return out.slice(0, MAX)
}

module.exports = { list: list, MAX: MAX, DICE_PER_PLAYER: DICE_PER_PLAYER }
