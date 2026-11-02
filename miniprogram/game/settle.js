/**
 * settle.js —— 结算页底部那句话（"谁喝一杯"）
 *
 * ============ 为什么抽出来 ============
 *
 * 这段逻辑本来内联在 decorate 里，四个玩法各一个分支。
 * 它决定的是**玩家最后看到的那句话** —— 说错了很刺眼
 * （"XX 喝一杯"却判错了人），但它一直没被测过，因为内联在页面逻辑里。
 *
 * 抽成纯函数之后可以直接喂数据断言。**行为与抽取前完全一致**。
 */

/**
 * @param {object} room  已装饰的房间对象
 * @returns {string}     一句话；不该有的时候返回 ''
 */
function footText(room) {
  if (!room || room.phase !== 'over') return ''
  const lr = room.lastResult || {}

  if (room.game === 'liar' && lr.loserName) {
    return lr.loserName + ' 喝 1 杯'
  }
  if (room.game === 'dice' && Array.isArray(lr.ranked) && lr.ranked.length) {
    /*
     * ★ 2026-11-02：「点数最少」要有**别人**做参照才成立。
     *   单人局（soloTest 测试模式才有）里显示「玩家 点数最少，喝一杯」
     *   读起来莫名其妙 —— 只有一个人，跟谁比最少？
     */
    if (lr.ranked.length === 1) {
      const only = lr.ranked[0]
      return only.name + ' 摇出 ' + (only.total || 0) + ' 点'
    }
    /* 点数最少的那个喝 —— 排序取第一个 */
    const low = lr.ranked.slice().sort((a, b) => (a.total || 0) - (b.total || 0))[0]
    if (low) return low.name + ' 点数最少，喝 1 杯'
    return ''
  }
  if (room.game === 'undercover' && lr.kind === 'undercover') {
    const rev = (room.uw && room.uw.reveal) || []
    const spy = rev.filter(x => x.role === 'spy')[0]
    if (spy) return '卧底是 ' + spy.name
    return ''
  }
  if (room.game === 'poker' && room.poker) {
    /* 金花：说"我这局为了换牌喝了几杯" —— 个人化的收尾比复述输赢有用 */
    const dv = Number(room.poker.myDrink) || 0
    if (dv > 0) {
      /* 0.5 的倍数：整数就不带小数点，否则显示 x.5 */
      return '你为了换牌喝了 ' + (dv % 1 === 0 ? dv : Math.floor(dv) + '.5') + ' 杯'
    }
    if (room.poker.winner) return room.poker.winner + ' 没换过牌就赢了'
  }
  return ''
}

module.exports = { footText: footText }
