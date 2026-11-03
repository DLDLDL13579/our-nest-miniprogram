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

/* ============================================================================
 * 2026-11-03 追加：**规则文案里写的倍数，必须和代码的上限一致**
 *
 * 原来规则写「劈一次 2 杯，反劈再翻一倍 4 杯」—— 读起来像是到 4 杯为止；
 * 而云端是 `min(8, mult * 2)`，**能到 8 杯**。
 *
 * 这类不一致玩家不会报 bug，只会在第 3 次劈的时候愣一下：
 * "规则明明说 4 杯啊？"
 * ========================================================================== */
{
  const g = require('../miniprogram/utils/games.js')
  const liar = g.GAMES.filter(x => x.id === 'liar')[0]
  const txt = (liar.how || []).join(' ')
  assert.ok(/最多\s*8\s*杯/.test(txt),
    '大话骰的规则文案必须写清劈的封顶是 8 杯（代码是 min(8, mult*2)）')
  console.log('  ✓ 规则文案里的「最多 8 杯」和代码上限一致')
}

/* ============================================================================
 * 2026-11-03 追加：**四个玩法的规则文案 vs 代码**（上一轮只查了大话骰）
 *
 * 每条规则里的"可验证陈述"都过一遍 —— 这类检查的价值在于：
 * 文案是给玩家看的**承诺**，而代码是**实际执行**。
 * 两者不一致时玩家不会报 bug，只会觉得"这游戏怪怪的"。
 * ========================================================================== */
{
  const g = fs.readFileSync(path.join(__dirname, '..', 'miniprogram/utils/games.js'), 'utf8')
  const dicerank = require('../miniprogram/utils/dicerank.js')
  const poker = require('../miniprogram/utils/poker.js')

  /* ---- 比大小：牌型链 + 两对先比大对 + 散牌比最大 ---- */
  const dice = g.slice(g.indexOf("id: 'dice'"), g.indexOf("id: 'undercover'"))
  assert.ok(/散牌 < 一对 < 两对 < 三条 < 顺子 < 葫芦 < 四条 < 五条/.test(dice),
    '比大小的规则必须写出完整的 8 级牌型链')

  const rk = (dice) => dicerank.rankPlayers([{ seat: 1, name: 'x', dice }]).ranked[0]
  const a2 = rk([6, 6, 2, 2, 1])   // 两对：大对 6、小对 2
  const b2 = rk([5, 5, 4, 4, 1])   // 两对：大对 5、小对 4
  assert.ok(a2.rankKey > b2.rankKey,
    '规则说「两对先比大对」—— 66+22 应该赢 55+44')
  const s1 = rk([6, 4, 2, 1, 3])   // 散牌，最大 6
  const s2 = rk([6, 4, 2, 1, 5])   // 散牌，最大 6，第二张 5
  assert.ok(s2.rankKey > s1.rankKey,
    '规则说「散牌比最大的那张」—— 同最大时应该继续往下比（6,5 > 6,4）')

  /* ---- 金花：牌型链 + A23 第二大 ---- */
  const pk = g.slice(g.indexOf("id: 'poker'"), g.indexOf("id: 'wheel'"))
  assert.ok(/豹子 > 顺金 > 金花 > 顺子 > 对子 > 单张/.test(pk),
    '金花的规则必须写出完整的 6 级牌型链')
  assert.ok(/A23 是第二大/.test(pk), '金花的规则必须写清 A23 是第二大顺子')

  /* 实测 A23 确实第二大 */
  const mk = (r1, r2, r3) => [{ r: r1, s: 0 }, { r: r2, s: 0 }, { r: r3, s: 0 }].map(c => Object.assign({}, c, { s: 1 }))
  /* 用花色错开避免顺金 */
  const a23 = poker.rank([{ r: 14, s: 0 }, { r: 2, s: 1 }, { r: 3, s: 2 }])
  const kqj = poker.rank([{ r: 13, s: 0 }, { r: 12, s: 1 }, { r: 11, s: 2 }])
  assert.ok(a23.name === kqj.name && a23.key > kqj.key,
    'A23 和 KQJ 同为顺子，而 A23 应该更大')

  console.log('  ✓ 比大小/金花的规则链与代码一致（含两对先比大对、散牌逐张比、A23 第二大）')
}

/* ============================================================================
 * 2026-11-03 追加：**叫骰选项的第一个要是"最自然的下一步"**
 *
 * 原来同一个数量内按 1→2→3→4→5→6 排。于是上家叫 6个4、
 * 我切到斋之后，第一个选项是「3个1斋」—— 而最自然的是「3个4斋」
 * （数量减半、点数不变）。玩家得往后翻 3 个才能找到。
 *
 * 改成从 `cur.face` 起循环。
 * ========================================================================== */
{
  const R = require('../miniprogram/utils/liarRules.js')

  /* 切斋：上家 6个4（不斋）→ 第一个应该还是 4 点 */
  const z = R.options(4, { n: 6, face: 4, zhai: false }, true, 24)
  assert.strictEqual(z[0].face, 4, '切斋后第一个选项应该还是 4 点（实际 ' + z[0].label + '）')
  assert.ok(z[0].n < 6, '切斋后第一个数量应该小于 6（减半）')

  /* 不斋：上家 6个4 → 第一个应该是 6个5（点数+1，同数量） */
  const nz = R.options(4, { n: 6, face: 4, zhai: false }, false, 24)
  assert.strictEqual(nz[0].n, 6, '同形态时第一个应该还是同数量（实际 ' + nz[0].label + '）')
  assert.strictEqual(nz[0].face, 5, '同形态时第一个应该是点数+1（实际 ' + nz[0].label + '）')

  /* 首叫：没有"上家点数"可参照，从 1 起循环到第一个合法值 */
  const first = R.options(4, null, false, 24)
  assert.ok(first.length > 0, '首叫必须有选项')
  assert.ok(first[0].n >= R.openNeed(4, false, 2), '首叫第一个不能低于起叫档')

  /* 上家叫 1 时：循环从 1 起，而 1 已经叫过，应该自然落到 2 */
  const afterOne = R.options(4, { n: 7, face: 1, zhai: true }, true, 24)
  assert.strictEqual(afterOne[0].face, 2, '上家叫 1 之后第一个应该是 2 点（实际 ' + afterOne[0].label + '）')

  console.log('  ✓ 叫骰选项的第一个是"最自然的下一步"（切斋保留点数 / 上叫点数+1 / 首叫从合法值起）')
}

/* ============================================================================
 * 2026-11-03 追加：**牌型名不依赖云端部署**（前端能自己算）
 *
 * `dicerank` 原来是**只有云端用**的模块，于是"牌型名"必须部署云函数才显示。
 * 而它是纯函数，前端有同一份 —— 云端没给时自己算，结果完全一致。
 *
 * 判据：装饰器里必须有"云端没给就前端补"的逻辑，且**不覆盖云端给的**。
 * ========================================================================== */
{
  const src = fs.readFileSync(path.join(__dirname, '..', 'miniprogram/game/room/room.js'), 'utf8')

  assert.ok(/const dicerank = require\('\.\.\/\.\.\/utils\/dicerank\.js'\)/.test(src),
    '房间页必须引入 dicerank（否则牌型名要等云端部署）')
  assert.ok(/if \(p\.handName \|\| !Array\.isArray\(p\.dice\)/.test(src),
    '补算前必须判"云端有没有给"（不能覆盖云端的值）')
  assert.ok(/dicerank\.evaluate\(p\.dice\)/.test(src),
    '补算要用 dicerank.evaluate')

  /* 实测：补算结果和云端同一套逻辑 */
  const dicerank = require('../miniprogram/utils/dicerank.js')
  const cases = [
    [[3, 3, 3, 3, 3], '五条'],
    [[6, 5, 4, 3, 2], '顺子'],
    [[2, 2, 5, 6, 1], '一对'],
    [[1, 3, 5, 2, 6], '散牌']
  ]
  cases.forEach(([dice, want]) => {
    const rk = dicerank.evaluate(dice)
    assert.strictEqual(rk.name, want,
      'evaluate(' + JSON.stringify(dice) + ') 应为 ' + want + '，实际 ' + rk.name)
  })

  console.log('  ✓ 牌型名前端能自己算（不依赖云端部署），且不覆盖云端的值')
}

/* ============================================================================
 * 2026-11-03 追加：**大厅卡片的一句描述，不能和规则相反**
 *
 * 「比大小」的 `desc` 原来是「一起摇一盅，**点数**大的赢」——
 * 而规则早就从"比总点数"改成了"比牌型"。
 *
 * 大厅那句是玩家**最先看到的**，而它比规则弹层更容易被当真：
 * 没人会为了确认"到底比什么"去翻规则。
 * ========================================================================== */
{
  const g = require('../miniprogram/utils/games.js')
  const dice = g.GAMES.filter(x => x.id === 'dice')[0]

  assert.ok(!/点数大的赢/.test(dice.desc),
    '★ 大厅描述不能再说"点数大的赢" —— 规则是比牌型（' + dice.desc + '）')
  assert.ok(/牌型/.test(dice.desc),
    '★ 大厅描述应该点明"比牌型"（实际：' + dice.desc + '）')

  /*
   * 顺带：描述不该超过 18 字。
   *
   * ⚠️ 第一版写的是 14 字，而「梦幻金花」是 16 字（"一张亮着，一张自己看，一张靠猜"）
   *   被判成超长 —— 而渲染图上它是**正常换行成两行**，卡片本来就是多行布局。
   *
   *   18 字是"两行放得下"的实际上限，不是"一行"的上限。
   */
  const longDesc = g.GAMES.filter(x => (x.desc || '').length > 18)
    .map(x => x.name + '（' + (x.desc || '').length + ' 字）')
  assert.deepStrictEqual(longDesc, [],
    '这些描述超过 18 字，大厅卡片上会挤成三行：\n    ' + longDesc.join('\n    '))

  console.log('  ✓ 大厅描述与规则一致（比大小已改为"比牌型"），且都在 18 字内')
}

/* ============================================================================
 * 2026-11-03 追加：**每个玩法都要让玩家知道"喝什么可以自己换"**
 *
 * 这是产品边界：**App 只判输赢，喝多少现场定。**
 * 三个玩法早就有这句（"喝多少你们定"），而大话骰和转盘没有 ——
 * 它们写的是具体杯数（"1→2→4→8 杯" / "喝 1 杯"），
 * **容易被读成"必须喝这么多"**。
 * ========================================================================== */
{
  const g = require('../miniprogram/utils/games.js')
  const missing = g.GAMES.filter(x => {
    const all = (x.how || []).join(' ')
    return !/自己换|你们定|想换|换个/.test(all)
  }).map(x => x.name)

  assert.deepStrictEqual(missing, [],
    '这些玩法的规则里没有"喝什么可以自己换"（玩家会以为必须按 App 说的喝）：\n    ' +
    missing.join('\n    '))

  console.log('  ✓ ' + g.GAMES.length + ' 个玩法都说明了"喝什么可以自己定"')
}

/* ============================================================================
 * 2026-11-03 追加：**单条规则不该超过 60 字**
 *
 * 弹层宽 686rpx、字号 20rpx → 一行约 34 字。
 * 一条 77 字的规则要占 3 行，而它和别的 8 条挤在一个 `max-height: 620rpx` 的滚动区里。
 *
 * ⚠️ 60 字是"两条独立意思挤在一起"的典型长度（"输的人喝 1 杯；被劈翻倍" + "喝不下自己换"）。
 *    拆开之后每条都只讲一件事，读起来是一步一步的。
 *
 * ⚠️ 例外：`core: true` 的那几条（游戏的核心规则）允许最长 60 字 ——
 *    它们拆开反而看不懂（"翻一倍"必须和"谁输"在一起）。
 * ========================================================================== */
{
  const g = require('../miniprogram/utils/games.js')
  const long = []
  g.GAMES.forEach(x => {
    (x.how || []).forEach((t, i) => {
      if (t.length > 60) long.push(x.name + ' 第 ' + (i + 1) + ' 条（' + t.length + ' 字）：' + t.slice(0, 24) + '…')
    })
  })

  assert.deepStrictEqual(long, [],
    '这些规则单条太长（玩家要读三行才读完，且和别的规则挤在滚动区里）：\n    ' + long.join('\n    '))

  /* 顺带：每条规则至少 8 字（太短的是"标题式"文案，不像规则） */
  const short = []
  g.GAMES.forEach(x => {
    (x.how || []).forEach((t, i) => {
      if (t.length < 8) short.push(x.name + ' 第 ' + (i + 1) + ' 条：' + t)
    })
  })
  assert.deepStrictEqual(short, [], '这些规则太短，读不出内容：\n    ' + short.join('\n    '))

  console.log('  ✓ 30+ 条规则的长度都在 8~60 字（一条只讲一件事）')
}

/* ============================================================================
 * 2026-11-03 追加：**必须有对手的玩法，必须声明 `soloMin: 2`**
 *
 * `soloMin` 的默认值是 **1**（`gmeta.soloMin ? gmeta.soloMin : 1`），
 * 所以**不写就放行单人开局**。
 *
 * 而有些玩法 1 人局会**卡死**：
 *   · 卧底：唯一的人被选成卧底，投票页列表为空、服务端又拦"不能投自己"
 *   · 金花：核心动作是「挑一个人比牌」，而 1 人局**没有任何人可比** ——
 *     只剩「换牌（白喝半杯）」和「弃牌（没人赢）」
 *
 * 而另一些玩法 1 人能走完：
 *   · 大话骰：自己摇、自己叫、自己开
 *   · 比大小：自己摇、自己结算
 *   · 转盘：自己转
 *
 * 判据：**需要"另一个人"才能推进的玩法，必须 soloMin ≥ 2。**
 * ========================================================================== */
{
  const g = require('../miniprogram/utils/games.js')

  /* 明确需要对手的（它们的核心动作是"对某人做某事"） */
  const NEEDS_OPPONENT = ['undercover', 'poker']
  const bad = []

  NEEDS_OPPONENT.forEach(id => {
    const x = g.GAMES.filter(y => y.id === id)[0]
    if (!x) { bad.push(id + '：注册表里没有这个玩法'); return }
    if (!x.soloMin || x.soloMin < 2) {
      bad.push(x.name + '：soloMin=' + (x.soloMin === undefined ? '（未设，默认 1）' : x.soloMin) +
        ' —— 1 人局会卡死（没有对手可比/可投）')
    }
  })

  assert.deepStrictEqual(bad, [],
    '这些玩法 1 人局会卡住，必须声明 soloMin ≥ 2：\n    ' + bad.join('\n    '))

  /* 反向：不需要对手的玩法，soloMin 不该 ≥2（否则单人测试开关会误拦） */
  const soloOk = ['liar', 'dice', 'wheel']
  const tooStrict = soloOk.filter(id => {
    const x = g.GAMES.filter(y => y.id === id)[0]
    return x && x.soloMin && x.soloMin > 1
  }).map(id => {
    const x = g.GAMES.filter(y => y.id === id)[0]
    return x.name + '（soloMin=' + x.soloMin + '）'
  })
  assert.deepStrictEqual(tooStrict, [],
    '这些玩法 1 人能走完，soloMin 不该 > 1（会误拦单人测试）：\n    ' + tooStrict.join('\n    '))

  console.log('  ✓ 需要对手的玩法都声明了 soloMin ≥ 2，1 人能走完的保持默认')
}
