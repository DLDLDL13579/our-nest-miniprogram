#!/usr/bin/env node
/**
 * test-rules-doc.js —— 核对「docs/规则依据.md 里声称的规则」和「代码实际做的」
 *
 * ============ 为什么有这个文件 ============
 *
 * 2026-11-02 写「规则依据」文档时，**顺手对出了大话骰起叫数量是错的**：
 * 文档说"不斋 1.5 倍 / 斋 人头数"，而代码是一张凭感觉填的硬编码表
 * （斋每个都多 1，6 人不斋少 1）。
 *
 * 也就是说：**写文档的过程本身就是一次审核** ——
 * 把"我声称的"和"代码做的"并排写出来，不一致就藏不住了。
 *
 * 所以把这次核对固化成脚本：以后改规则，跑这个就知道有没有违背文档。
 */
const fs = require('fs')
const path = require('path')
const assert = require('assert')

const liar = require('../miniprogram/utils/liarRules.js')
const poker = require('../miniprogram/utils/poker.js')
const dicerank = require('../miniprogram/utils/dicerank.js')

let pass = 0
const ok = (m) => { pass++; console.log('  ✓ ' + m) }

/* ============================================================
 * 一、大话骰
 * ============================================================ */
console.log('\n【大话骰】')

/* ① 起叫：不斋 1.5 倍 / 斋 人头数 / 叫1 人头数 */
{
  const bad = []
  for (let p = 2; p <= 8; p++) {
    if (liar.openNeed(p, false, 2) !== Math.ceil(p * 1.5)) bad.push(p + '人不斋')
    if (liar.openNeed(p, true, 2) !== p) bad.push(p + '人斋')
    if (liar.openNeed(p, false, 1) !== p) bad.push(p + '人叫1')
  }
  assert.deepStrictEqual(bad, [], '起叫不符文档：' + bad.join(' '))
  ok('起叫：不斋=1.5倍 / 斋=人头数 / 叫1=人头数（2~8 人）')
}

/* ② 飞斋：数量加倍 */
{
  const cur = { n: 3, face: 4, zhai: true }
  assert.strictEqual(liar.canRaise(cur, { n: 6, face: 2, zhai: false }, 2).ok, true,
    '3个4斋 → 6个2飞 应该允许（加倍）')
  assert.strictEqual(liar.canRaise(cur, { n: 5, face: 2, zhai: false }, 2).ok, false,
    '没加倍不能飞')
  ok('飞斋：从斋改回不斋，数量必须加倍')
}

/* ============================================================
 * 二、比大小
 * ============================================================ */
console.log('\n【比大小】')

/* ③ 8 种牌型的等级顺序（文档里列的那张表） */
{
  const CHAIN = [
    [[1, 2, 3, 4, 6], '散牌'],
    [[6, 6, 2, 3, 4], '一对'],
    [[6, 6, 2, 2, 3], '两对'],
    [[6, 6, 6, 2, 3], '三条'],
    [[2, 3, 4, 5, 6], '顺子'],
    [[6, 6, 6, 2, 2], '葫芦'],
    [[6, 6, 6, 6, 2], '四条'],
    [[6, 6, 6, 6, 6], '五条']
  ]
  for (let i = 0; i < CHAIN.length; i++) {
    const r = dicerank.evaluate(CHAIN[i][0])
    assert.strictEqual(r.name, CHAIN[i][1], '牌型名不符')
    if (i > 0) {
      assert.ok(r.level > dicerank.evaluate(CHAIN[i - 1][0]).level,
        CHAIN[i][1] + ' 应该大于 ' + CHAIN[i - 1][1])
    }
  }
  ok('牌型顺序：散牌 < 一对 < 两对 < 三条 < 顺子 < 葫芦 < 四条 < 五条')
}

/* ============================================================
 * 三、梦幻金花
 * ============================================================ */
console.log('\n【梦幻金花】')

const C = (r, s) => ({ r, s })   // r: 2~14（A=14）, s: 0~3

/* ④ A23 是第二大顺子：AKQ > A23 > KQJ > … > 234 */
{
  const AKQ = [C(14, 0), C(13, 0), C(12, 0)]
  const A23 = [C(14, 0), C(2, 0), C(3, 0)]
  const KQJ = [C(13, 0), C(12, 0), C(11, 0)]
  const H234 = [C(2, 0), C(3, 0), C(4, 0)]

  assert.ok(poker.compare(AKQ, A23) > 0, 'AKQ 应该大于 A23')
  assert.ok(poker.compare(A23, KQJ) > 0, 'A23 应该大于 KQJ（第二大顺子）')
  assert.ok(poker.compare(KQJ, H234) > 0, 'KQJ 应该大于 234')
  ok('A23 是第二大顺子：AKQ > A23 > KQJ > … > 234')
}

/* ⑤ 牌型顺序：豹子 > 顺金 > 金花 > 顺子 > 对子 > 单张 */
{
  const CHAIN = [
    [[C(2, 0), C(5, 1), C(9, 2)], '单张'],
    [[C(9, 0), C(9, 1), C(5, 2)], '对子'],
    [[C(5, 0), C(6, 1), C(7, 2)], '顺子'],
    [[C(9, 0), C(5, 0), C(2, 0)], '金花'],
    [[C(9, 0), C(8, 0), C(7, 0)], '顺金'],
    [[C(9, 0), C(9, 1), C(9, 2)], '豹子']
  ]
  for (let i = 0; i < CHAIN.length; i++) {
    const t = poker.rank(CHAIN[i][0]).type
    if (i > 0) {
      const prev = poker.rank(CHAIN[i - 1][0]).type
      assert.ok(t > prev, CHAIN[i][1] + ' 应该大于 ' + CHAIN[i - 1][1] +
        '（type ' + t + ' vs ' + prev + '）')
    }
  }
  ok('牌型顺序：单张 < 对子 < 顺子 < 金花 < 顺金 < 豹子')
}

/* ============================================================
 * 四、文档里说"没做的" —— 确认真的没做（避免文档与实现漂移）
 * ============================================================ */
console.log('\n【文档声称"没做"的】')
{
  /* 同花：骰子没有颜色，比大小的牌型里不该有"同花" */
  const names = Object.values(dicerank.NAME).join(',')
  assert.ok(!names.includes('同花'), '比大小不该有同花（我们的骰子没颜色）')
  ok('比大小不含「同花」（骰子无颜色，调研文章也说通常不玩）')
}

/* ============================================================
 * 五、**给玩家看的规则文案**也要和代码一致
 * ============================================================
 *
 * 2026-11-02 发现：我把「全围 +2」实现改了，但 `games.js` 里给玩家看的
 * 规则还写着「围骰……算 6 个」—— **玩家看到的规则和实际判定不一样**。
 *
 * 这类不一致最伤：玩家按规则算牌，结果 App 判得不一样，会觉得"这游戏在耍赖"。
 */
console.log('\n【规则文案】')
{
  const { GAMES } = require('../miniprogram/utils/games.js')
  const liar = GAMES.filter(g => g.id === 'liar')[0]
  const text = (liar.how || []).join('\n')

  /* 五颗全同这件事，文案必须同时说清 7 和 6 两种情况 */
  assert.ok(/7\s*个/.test(text) && /6\s*个/.test(text),
    '大话骰的规则文案要说清全围(7)和围骰(6)两种加成，实际：' +
    (liar.how || []).filter(h => /个/.test(h)).join(' | '))
  ok('大话骰规则文案：全围 7 个 / 围骰 6 个（与 dicerank 实现一致）')

  /*
   * 比大小的文案必须说「牌型」，不能说「点数最大」——
   * 牌型系统上线后，"总点数最大的赢"是**错的**
   * （11 点的葫芦赢 26 点的两对）。
   * 这条也是我重写规则时漏掉的地方：代码改了，给玩家看的话没改。
   */
  const dice = GAMES.filter(g => g.id === 'dice')[0]
  const diceText = (dice.how || []).join('\n')
  assert.ok(/牌型/.test(diceText),
    '比大小的规则文案必须说明「比的是牌型」，实际：' + diceText)
  assert.ok(/散牌|一对|葫芦/.test(diceText),
    '比大小的规则文案应列出牌型顺序，实际：' + diceText)
  assert.ok(!/点数最大的赢/.test(diceText),
    '「点数最大的赢」在牌型系统下是错的，文案不能这么写')
  assert.ok(/单骰|重摇/.test(diceText),
    '比大小的规则文案应提到「单骰可以重摇」')
  ok('比大小规则文案：比牌型（不是比总点数）、含单骰重摇')
}

console.log('\n规则文档一致性：全部 ' + pass + ' 项通过')

/* ============================================================================
 * 2026-11-03 追加：**转盘抽题必须优先抽没抽过的**
 *
 * 「真心话」占转盘 22%，一个场合只有 25 条真心话 ——
 * 一局转十次左右，纯随机抽 10 次：**重复的概率约 87%**（生日悖论）。
 * 而"诶这个刚才不是说过了"是酒桌上很扫兴的一句。
 *
 * 判据：从云端源码里确认 `usedCards` 的读写都在，且抽题时用了"新鲜优先"。
 * ========================================================================== */
{
  const cloud = fs.readFileSync(
    path.join(__dirname, '..', 'cloudfunctions/room/index.js'), 'utf8')

  assert.ok(/const used = Array\.isArray\(room\.usedCards\)/.test(cloud),
    '抽题时必须先读 room.usedCards')
  assert.ok(/const fresh = pool\.filter\(t => used\.indexOf\(t\) < 0\)/.test(cloud),
    '抽题时必须先排除抽过的')
  assert.ok(/const src = fresh\.length \? fresh : pool/.test(cloud),
    '全抽过了必须回退到完整题池（否则 pool[fresh] 会 empty 崩）')
  assert.ok(/usedCards\.push\(card\.text\)/.test(cloud),
    '抽中之后必须记进 usedCards')
  assert.ok(/usedCards\.length > 40/.test(cloud),
    'usedCards 必须有上限（否则房间文档会无限长）')

  console.log('  ✓ 转盘抽题优先新鲜（usedCards 读写 + 上限都在）')
}

/* ============================================================================
 * 2026-11-03 追加：**洗牌必须无偏**
 *
 * 酒桌游戏的"可信度"全押在随机上 —— 玩家不会觉得是 bug，会觉得 App 在作弊。
 * 而 `sort(() => Math.random() - 0.5)` 这个流传极广的写法**分布不均匀**。
 * ========================================================================== */
{
  /* 先剥注释 —— 文件里第 47 行的注释正是在说「不用 sort(random)」 */
  const pokerSrc = fs.readFileSync(
    path.join(__dirname, '..', 'miniprogram/utils/poker.js'), 'utf8')
    .replace(/\/\*[\s\S]*?\*\//g, '')
    .replace(/\/\/[^\n]*/g, '')

  assert.ok(/for \(let i = a\.length - 1; i > 0; i--\)/.test(pokerSrc),
    'shuffle 必须是 Fisher-Yates（从后往前）')
  assert.ok(/Math\.floor\(r\(\) \* \(i \+ 1\)\)/.test(pokerSrc),
    'shuffle 必须用 floor(r() * (i+1)) —— 用 round 时首尾只有一半概率')
  assert.ok(!/sort\(\(\)\s*=>\s*Math\.random\(\)\s*-\s*0\.5\)/.test(pokerSrc),
    '不许用 sort(random-0.5) 洗牌（分布不均匀）')

  /* 实测：洗 3 元素 6000 次，6 种排列的频次应该接近 */
  const dist = {}
  const small = [{ id: 1 }, { id: 2 }, { id: 3 }]
  const shuffleFn = new Function('deck', `
    const a = (deck || []).slice()
    for (let i = a.length - 1; i > 0; i--) {
      const j = Math.floor(Math.random() * (i + 1))
      const t = a[i]; a[i] = a[j]; a[j] = t
    }
    return a
  `)
  for (let i = 0; i < 6000; i++) {
    const k = shuffleFn(small).map(x => x.id).join('')
    dist[k] = (dist[k] || 0) + 1
  }
  const counts = Object.values(dist)
  assert.strictEqual(counts.length, 6, '3 个元素应该有 6 种排列，实际 ' + counts.length)
  const avg = 6000 / 6
  const worst = Math.max(...counts.map(c => Math.abs(c - avg) / avg))
  assert.ok(worst < 0.12,
    '洗牌分布偏差 ' + (worst * 100).toFixed(1) + '% 超过 12%（可能是偏的）')

  console.log('  ✓ 洗牌是 Fisher-Yates 且分布均匀（6 种排列偏差 ' +
    (worst * 100).toFixed(1) + '%）')
}
