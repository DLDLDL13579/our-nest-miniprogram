/**
 * liarCount.js —— 大话骰「实际有几个」的统计
 *
 * ============ 为什么要单独抽出来 ============
 *
 * 这是大话骰**唯一的判定核心**：开骰时数全场有多少颗能满足叫的点数。
 * 而它有一条反直觉的规则：**1 点恒为万能**（可以当任何点数），
 * 除非叫的就是 1 —— 那时 1 只能算 1。
 *
 * 原逻辑内联在 `open` 分支里，而骰子是**随机发的**，
 * 所以从来没法单测 —— 测试只能验"actual >= need 这个判定对不对"，
 * 验不了"1 有没有被算进去"。
 *
 * 抽出来之后，喂数据就能断言。
 */

/**
 * @param {Array} players  玩家列表（每人有 dice 数组）
 * @param {number} face    叫的点数（1~6）
 * @returns {number}       全场能满足这个叫法的骰子数
 */
function countActual(players, face) {
  let n = 0
  ;(players || []).forEach(p => {
    ;(p.dice || []).forEach(d => {
      if (d === face) n++
      /* 1 是万能 —— 但叫的就是 1 时它不算万能，只算自己 */
      else if (d === 1 && face !== 1) n++
    })
  })
  return n
}

module.exports = { countActual: countActual }
