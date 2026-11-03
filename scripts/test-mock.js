#!/usr/bin/env node
/**
 * test-mock.js —— 渲染 mock 的数据自洽性
 *
 * ============ 为什么需要 ============
 *
 * 2026-11-02 修完「卧底投票进度的两个数字不同分母」之后，我顺手检查了 mock ——
 * 发现 **uw12 这个状态本身就是矛盾的**：显示「已投 5 / 12」和「还差 2 人」，
 * 而 5 + 2 ≠ 12。
 *
 * 也就是说：**渲染图上的那个矛盾，一半来自产品、一半来自 mock**。
 * 而 mock 不自洽的后果比产品 bug 更隐蔽 —— 我会看着截图去改一段正确的代码。
 *
 * AGENTS.md 记过：「mock 失真比没工具更危险」。
 *
 * ============ 检查什么 ============
 *
 * 只查**能机械判定**的关系，不猜语义：
 *   · room.count 与实际 players 数量一致
 *   · 卧底投票：iVoted 时 voteCount + waitingCount = voterCount
 *   · 摇骰进度：rolledCount ≤ count
 *   · 每人的 score / cups 非负
 *   · 结算的 ranked 里每个 seat 都能在 players 里找到
 */
const assert = require('assert')
const mock = require('./ui-render/mock/room.js')

const states = mock.states
assert.ok(states && typeof states === 'object', 'mock 没有导出 states')

const bad = []
for (const k of Object.keys(states)) {
  let s
  try { s = states[k]() } catch (e) { bad.push(k + ' 抛异常：' + e.message); continue }
  if (!s) { bad.push(k + ' 返回 null'); continue }

  const room = s.room || {}
  const players = room.players || []

  /* ① 人数 */
  if (typeof room.count === 'number' && players.length && room.count !== players.length) {
    bad.push(k + '：room.count=' + room.count + ' 但 players 有 ' + players.length + ' 个')
  }

  /* ② 卧底投票口径 */
  const u = room.uw
  if (u && typeof u.voteCount === 'number' && typeof u.voterCount === 'number') {
    if (u.voteCount > u.voterCount) {
      bad.push(k + '：已投 ' + u.voteCount + ' > 应投 ' + u.voterCount)
    }
    if (u.iVoted === true && typeof u.waitingCount === 'number' &&
        u.voteCount + u.waitingCount !== u.voterCount) {
      bad.push(k + '：我投了 → 已投' + u.voteCount + ' + 还差' + u.waitingCount +
        ' ≠ 应投' + u.voterCount)
    }
  }

  /* ③ 摇骰进度 */
  if (typeof room.rolledCount === 'number' && typeof room.count === 'number' &&
      room.rolledCount > room.count) {
    bad.push(k + '：已摇 ' + room.rolledCount + ' > 总人数 ' + room.count)
  }

  /* ④ 分数/杯数非负 */
  players.forEach((p, i) => {
    if (typeof p.score === 'number' && p.score < 0) {
      bad.push(k + '：players[' + i + '](' + p.name + ') score 为负')
    }
  })

  /* ⑤ 结算里的 seat 必须存在 */
  const r = s.result || (room.lastResult)
  if (r && Array.isArray(r.ranked) && players.length) {
    const seats = new Set(players.map(p => p.seat))
    r.ranked.forEach(row => {
      if (row.seat !== undefined && !seats.has(row.seat)) {
        bad.push(k + '：结算里的 seat' + row.seat + '(' + row.name + ') 不在 players 里')
      }
    })
  }
}

if (bad.length) {
  console.error('✗ mock 数据不自洽 ' + bad.length + ' 处：')
  bad.forEach(x => console.error('    · ' + x))
  console.error('\n  渲染图上的矛盾如果不是产品的问题，就是这里的 —— 先修 mock 再看图。')
  process.exit(1)
}

console.log('  ✓ mock 数据自洽（' + Object.keys(states).length + ' 个状态：人数/投票/进度/分数/结算 seat）')

/* ============================================================================
 * 2026-11-02 追加：**mock 里的内容必须来自真实库**
 *
 * 起因：`wheelLongCard` 状态手写了一条 60 字的假题卡
 * 「用一句话形容在场每个人今天的状态不能重复形容词说完之后…」，
 * 一整段没有标点。我差点去改题卡的折行样式。
 *
 * 而真实题库 200 条里**最长只有 28 字**，全是带标点的正常中文。
 * 也就是说：那条"极端值"造的极限，产品里根本不存在。
 *
 * 判据：**造边界数据时，边界要来自真实数据的分布，不能凭空造。**
 * ========================================================================== */
{
  const { DECKS } = require('../miniprogram/utils/decks.js')
  const W = require('../miniprogram/utils/words.js')

  const allCards = new Set()
  DECKS.forEach(d => {
    ;(d.truth || []).forEach(t => allCards.add(t))
    ;(d.dare || []).forEach(t => allCards.add(t))
  })
  const allWords = new Set()
  W.DECKS.forEach(d => (d.pairs || []).forEach(p => p.forEach(w => allWords.add(w))))

  assert.ok(allCards.size > 100, '题卡库只有 ' + allCards.size + ' 条，抽取可能失效')
  assert.ok(allWords.size > 100, '词库只有 ' + allWords.size + ' 个，抽取可能失效')

  const fakeCards = []
  const fakeWords = []
  const seen = new Set()
  for (const k of Object.keys(states)) {
    if (seen.has(k)) continue
    seen.add(k)
    const s = states[k]()
    if (!s) continue
    /* 题卡：顶层 card.text 和 cardText 两种写法都要查 */
    const texts = []
    if (s.card && s.card.text) texts.push(s.card.text)
    if (typeof s.cardText === 'string' && s.cardText) texts.push(s.cardText)
    texts.forEach(t => {
      if (!allCards.has(t)) fakeCards.push(k + ' → ' + t.slice(0, 24))
    })
    /* 卧底的词 */
    const uw = s.room && s.room.uw
    if (uw && uw.word && !allWords.has(uw.word)) {
      fakeWords.push(k + ' → ' + uw.word)
    }
  }
  assert.deepStrictEqual(fakeCards, [],
    'mock 里出现了题库里没有的题卡（渲染图会显示产品里不存在的内容）：\n    ' +
    fakeCards.join('\n    '))
  assert.deepStrictEqual(fakeWords, [],
    'mock 里出现了词库里的词：\n    ' + fakeWords.join('\n    '))
  console.log('  ✓ mock 的题卡与卧底词都来自真实库（题卡 %d 条 / 词 %d 个）',
    allCards.size, allWords.size)
}

/* ============================================================================
 * 2026-11-02 追加：倒计时的数字必须和配置对得上
 *
 * mock 的 `cd` 状态原来写的是 `cdText: '3'` + `countdownMs: 2200`——
 * 而产品里 `COUNTDOWN_MS` 是 **2000**，按 `Math.ceil(2000/1000)` 应该显示 **2**。
 *
 * 也就是说：那张渲染图展示的是**产品里不会出现的倒计时画面**（显示"3"）。
 * 这是 mock 造假的第四个变体（前三个：缺字段、数据矛盾、假题卡）。
 * ========================================================================== */
{
  const fs = require('fs')
  const path = require('path')
  const ROOT = path.join(__dirname, '..')
  const cloud = fs.readFileSync(
    path.join(ROOT, 'cloudfunctions/room/index.js'), 'utf8')
  const m = /COUNTDOWN_MS\s*=\s*(\d+)/.exec(cloud)
  assert.ok(m, '找不到 COUNTDOWN_MS')
  const realMs = Number(m[1])
  const expectFirst = String(Math.ceil(realMs / 1000))

  const bad = []
  for (const k of Object.keys(states)) {
    const s = states[k]()
    if (!s || !s.room || s.room.phase !== 'countdown') continue
    const txt = s.cdText
    if (txt === undefined || txt === null || txt === '') continue
    /* 允许两种：读秒数字（= ceil(ms/1000) 或更小，因为会倒数）或"开始" */
    if (txt === '开始') continue
    if (!/^\d+$/.test(String(txt))) {
      bad.push(k + '：cdText 既不是数字也不是「开始」→ ' + JSON.stringify(txt))
      continue
    }
    const n = Number(txt)
    if (n > Math.ceil(realMs / 1000)) {
      bad.push(k + '：倒计时只有 ' + realMs + 'ms，却显示 ' + n +
        '（最多只能显示 ' + expectFirst + '）')
    }
  }
  assert.deepStrictEqual(bad, [],
    '这些 mock 倒计时状态产品里不可能出现：\n    ' + bad.join('\n    '))
  console.log('  ✓ 倒计时数字与 COUNTDOWN_MS(' + realMs + 'ms) 对得上')
}

/* ============================================================================
 * 2026-11-03 追加：**结算 mock 的数值必须和它的骰子对得上**
 *
 * `diceWin` / `dice8` 原来是手写编的：`total: 26 - i * 7`，
 * 而 `dice` 用另一套公式 —— 两边对不上（倩萍 total 写 19、实际 24）。
 * 更糟的是**没有 `handName`**，于是比大小结算页那一列牌型名永远是空的
 * —— 而看图会以为是模板写错。
 *
 * 判据：凡是带 `ranked` 的状态，逐个人重算 total 并与 dice 求和比对，
 * 并验证 handName 和真实 rankPlayers 的结论一致。
 * ========================================================================== */
{
  const dicerank = require('../miniprogram/utils/dicerank.js')
  const bad = []
  Object.keys(states).forEach(k => {
    let s
    try { s = states[k]() } catch (e) { return }
    const ranked = (s && s.result && s.result.ranked) ||
      (s && s.room && s.room.lastResult && s.room.lastResult.ranked) || []
    if (!ranked.length) return
    ranked.forEach(p => {
      if (!Array.isArray(p.dice) || p.dice.length !== 5) {
        bad.push(k + ' / ' + p.name + '：骰子不是 5 颗')
        return
      }
      const real = p.dice.reduce((a, b) => a + b, 0)
      if (p.total !== real) {
        bad.push(k + ' / ' + p.name + '：total 写 ' + p.total + '，dice 求和是 ' + real)
      }
      if (!p.handName) bad.push(k + ' / ' + p.name + '：缺 handName')
    })
    /* 排名顺序必须和 rankPlayers 的结论一致 */
    const rk = dicerank.rankPlayers(
      ranked.map(p => ({ name: p.name, seat: p.seat, dice: p.dice.slice() })))
    const want = rk.ranked.map(p => p.name).join(',')
    const got = ranked.map(p => p.name).join(',')
    if (want !== got) bad.push(k + '：排名顺序和 rankPlayers 不一致（应为 ' + want + '）')
  })
  assert.deepStrictEqual(bad, [],
    '结算 mock 的数值对不上：\n    ' + bad.join('\n    '))
  console.log('  ✓ 结算 mock 的 total / handName / 排名顺序都与真实 rankPlayers 一致')
}

/* ============================================================================
 * 2026-11-03 追加：**金花结算的牌必须是一副真牌**（除去公共牌后不能重复）
 *
 * ⚠️ 写这条时我第一版查错了：
 *   "9 张牌去重后只有 7 张 → 有重复" ——
 *   而重复的 `12-2` 是**公共牌（♣Q）**，本来就该出现在每个人手里。
 *
 *   金花的规则是「公共牌 1 张 + 每人私有 2 张」，所以：
 *     · 每人的 cards 里**必须**有那张公共牌
 *     · 除去公共牌后的**私有牌不能重复**（一副牌只有一张 Q♠）
 * ========================================================================== */
{
  const bad = []
  Object.keys(states).forEach(k => {
    let s
    try { s = states[k]() } catch (e) { return }
    const hands = (s && s.room && s.room.lastResult &&
      s.room.lastResult.kind === 'poker' && s.room.lastResult.hands) || []
    if (!hands.length) return
    const pub = s.room.poker && s.room.poker.publicCard
    const pubId = pub ? (pub.r + '-' + pub.s) : null
    const priv = []
    hands.forEach(h => {
      const ids = (h.cards || []).map(c => c.r + '-' + c.s)
      /* 值域 */
      ;(h.cards || []).forEach(c => {
        /* ⚠️ poker.js 的约定是 **A=14**（RANKS[14]='A'），不是 13 —— 第一版断言写错了 */
        if (!(c.r >= 2 && c.r <= 14 && c.s >= 0 && c.s <= 3)) {
          bad.push(k + '/' + h.name + '：牌值越界 r=' + c.r + ' s=' + c.s)
        }
      })
      /* 公共牌必须在每个人手里 */
      if (pubId && ids.indexOf(pubId) < 0) {
        bad.push(k + '/' + h.name + '：手里没有公共牌 ' + pubId)
      }
      priv.push(...ids.filter(x => x !== pubId))
    })
    /* 私有牌不能重复 */
    const seen = new Set()
    priv.forEach(x => {
      if (seen.has(x)) bad.push(k + '：私有牌 ' + x + ' 出现在两个人手上')
      seen.add(x)
    })
  })
  assert.deepStrictEqual(bad, [],
    '金花结算的牌有问题：\n    ' + bad.join('\n    '))
  console.log('  ✓ 金花结算的牌是真的一副（公共牌共享、私有牌不重复、值域合法）')
}

/* ============================================================================
 * 2026-11-03 追加：**53 个状态的基础合法性**（房间号 / 座位 / 骰子 / 唯一性）
 *
 * 这些"太简单而不值得测"的东西，恰恰是最容易被手写编坏的地方：
 *   · 座位号跳号 → 界面上出现"seat 1,2,4"
 *   · 两个人同名 → 结算页分不清谁是谁
 *   · 骰子写个 7 → 渲染器找不到 dice-7.png，而它是**静默不显示**
 * ========================================================================== */
{
  const bad = []
  Object.keys(states).forEach(k => {
    let s
    try { s = states[k]() } catch (e) { return }
    const r = s.room || {}
    if (r.code && !/^\d{3}$/.test(String(r.code))) {
      bad.push(k + '：房间号不是 3 位数字（' + r.code + '）')
    }
    const ps = r.players || []
    if (ps.length) {
      const seats = ps.map(p => p.seat).sort((a, b) => a - b)
      const want = ps.map((_, i) => i + 1)
      if (JSON.stringify(seats) !== JSON.stringify(want)) {
        bad.push(k + '：座位号不连续（' + seats.join(',') + '）')
      }
      ps.forEach(p => (p.dice || []).forEach(d => {
        if (!(d >= 1 && d <= 6)) bad.push(k + '/' + p.name + '：骰子值 ' + d + '（应在 1~6）')
      }))
      const names = ps.map(p => p.name)
      const dupN = [...new Set(names.filter((x, i) => names.indexOf(x) !== i))]
      if (dupN.length) bad.push(k + '：玩家名重复（' + dupN.join(',') + '）')
      const oids = ps.map(p => p.openid).filter(Boolean)
      const dupO = [...new Set(oids.filter((x, i) => oids.indexOf(x) !== i))]
      if (dupO.length) bad.push(k + '：openid 重复（' + dupO.join(',') + '）')
    }
  })
  assert.deepStrictEqual(bad, [], 'mock 基础数据不合法：\n    ' + bad.join('\n    '))
  console.log('  ✓ 53 个状态的基础数据：房间号 3 位 / 座位连续 / 骰子 1~6 / 名字与 openid 唯一')
}

/* ============================================================================
 * 2026-11-03 追加：**叫完骰不该又轮到自己**
 *
 * `liarCold` 原来是 `bid.bySeat = 2` + `turn = 2` —— 倩萍刚叫完 1个1，
 * 又轮到倩萍叫。3 人局里这不可能，而界面上会显示
 * 「倩萍 叫的 1个1」+「等 倩萍 叫」这种自相矛盾的组合。
 *
 * 判据：大话骰状态里，`turn` 不能等于 `bid.bySeat`（人数 > 1 时）。
 * ========================================================================== */
{
  const bad = []
  Object.keys(states).forEach(k => {
    let s
    try { s = states[k]() } catch (e) { return }
    const r = s.room || {}
    if (r.game !== 'liar' || r.phase !== 'playing') return
    const n = r.count || (r.players || []).length
    if (n <= 1) return
    const by = r.bid && r.bid.bySeat
    if (by && r.turn && Number(by) === Number(r.turn)) {
      bad.push(k + '：bid.bySeat=' + by + ' 且 turn=' + r.turn +
        '（' + n + ' 人局里叫完不该又轮到自己）')
    }
  })
  assert.deepStrictEqual(bad, [], 'mock 的回合数据自相矛盾：\n    ' + bad.join('\n    '))
  console.log('  ✓ 大话骰状态：叫完骰之后不会又轮到自己')
}

/* ============================================================================
 * 2026-11-03 追加：**派生字段必须和它的来源对得上**
 *
 * `shortBy = max(0, minPlayers - count)` —— 而 mock 里两处对不上：
 *   · `howOpen`        count=3, min=2, shortBy=**1**  ← 人已经够了
 *   · `wheelLandedPass` count=1, min=2（默认值）, shortBy=0 ← 转盘 1 人就能玩
 *
 * 界面上"人够了"和"还差 N 人"是**两个互斥的按钮** —— 写错会让截图自相矛盾，
 * 而我可能对着一个不存在的矛盾去改代码。
 * ========================================================================== */
{
  const bad = []
  Object.keys(states).forEach(k => {
    let s
    try { s = states[k]() } catch (e) { return }
    const r = s.room || {}
    const ps = r.players || []
    /* count 必须等于 players 长度 */
    if (r.count != null && ps.length && r.count !== ps.length) {
      bad.push(k + '：count=' + r.count + ' 但 players 有 ' + ps.length + ' 个')
    }
    /* shortBy 必须等于 max(0, minPlayers - count) */
    if (r.shortBy != null && r.minPlayers != null && r.count != null) {
      const want = Math.max(0, r.minPlayers - r.count)
      if (Number(r.shortBy) !== want) {
        bad.push(k + '：shortBy=' + r.shortBy + '，但 min-count=' + want)
      }
    }
    /* diceCount 必须等于 dice 长度（两者都有时） */
    ps.forEach(p => {
      if (p.diceCount != null && Array.isArray(p.dice) && p.dice.length &&
          p.diceCount !== p.dice.length) {
        bad.push(k + '/' + p.name + '：diceCount=' + p.diceCount + ' 但 dice 有 ' + p.dice.length + ' 颗')
      }
    })
  })
  assert.deepStrictEqual(bad, [], 'mock 的派生字段和来源对不上：\n    ' + bad.join('\n    '))
  console.log('  ✓ 派生字段一致（count=players / shortBy=min-count / diceCount=dice）')
}

/* ============================================================================
 * 2026-11-03 追加：**金花的 aliveCount / out / winner 必须自洽**
 *
 * 查出来四处矛盾：`aliveCount: 1` 说只剩一个人，而 `players` 里三个人全活着；
 * `result.hands[].out` 是对的，`players[].out` 却是全 false —— **同一页面两套数据**。
 *
 * 表现：结算页说「邓林 赢」，而列表里三个人都是"活着"的样子。
 * ========================================================================== */
{
  const bad = []
  Object.keys(states).forEach(k => {
    let s
    try { s = states[k]() } catch (e) { return }
    const r = s.room || {}
    const ps = r.players || []
    const pk = r.poker || {}
    if (!ps.length) return

    /* aliveCount 必须等于未出局人数 */
    if (pk.aliveCount != null) {
      const want = ps.filter(p => !p.out).length
      if (pk.aliveCount !== want) {
        bad.push(k + '：aliveCount=' + pk.aliveCount + ' 但未出局 ' + want + ' 人')
      }
    }
    /* winner 不能是已出局的人 */
    if (pk.winner) {
      const w = ps.filter(p => p.name === pk.winner)[0]
      if (w && w.out) bad.push(k + '：winner=' + pk.winner + ' 但该玩家 out=true')
    }
    /* result.hands 的 out 必须和 players 一致 */
    const hands = (r.lastResult && r.lastResult.kind === 'poker' && r.lastResult.hands) || []
    hands.forEach(h => {
      const p = ps.filter(x => x.name === h.name)[0]
      if (p && h.out != null && p.out != null && h.out !== p.out) {
        bad.push(k + '/' + h.name + '：hands.out=' + h.out + ' 但 players.out=' + p.out)
      }
    })
  })
  assert.deepStrictEqual(bad, [], '金花状态自相矛盾：\n    ' + bad.join('\n    '))
  console.log('  ✓ 金花的 aliveCount / winner / out 三处一致')
}

/* ============================================================================
 * 2026-11-03 追加：**大厅那句「200 道题 · 120 对词」必须和实际内容对得上**
 *
 * 它**是现算的**（`lobby.js` 的 `refreshContentStat`），所以正常情况下不会错。
 * 但有两个风险：
 *   · 有人改成硬编码（那就再也不会更新）
 *   · 数据结构改了（`truth`/`dare` 或 `pairs` 改名），算出来变 0 而不报错
 *
 * 判据：直接从真实数据算出两个数字，和"应该显示的值"比对。
 * ========================================================================== */
{
  const decks = require('../miniprogram/utils/decks.js')
  const words = require('../miniprogram/utils/words.js')

  let cards = 0
  decks.DECKS.forEach(d => { cards += (d.truth || []).length + (d.dare || []).length })
  let pairs = 0
  words.DECKS.forEach(d => { pairs += (d.pairs || []).length })

  assert.ok(cards >= 100, '题卡只算出 ' + cards + ' 条 —— 字段名可能改了（truth/dare）')
  assert.ok(pairs >= 50, '卧底词只算出 ' + pairs + ' 对 —— 字段名可能改了（pairs）')

  /* 每种场合都该有 truth 和 dare（各 25 条） */
  const badDeck = decks.DECKS.filter(d =>
    (d.truth || []).length === 0 || (d.dare || []).length === 0).map(d => d.k)
  assert.deepStrictEqual(badDeck, [],
    '这些场合缺 truth 或 dare：' + badDeck.join(' '))

  console.log('  ✓ 内容量真实：' + cards + ' 道题 / ' + pairs + ' 对词（' + words.DECKS.length + ' 个词库）')
}

/* ============================================================================
 * 2026-11-03 追加：**题卡库不许有重复**（decks.js 的注释说这是"最容易违反的一条"）
 *
 * 而**全仓没有任何去重断言** —— 注释声称"收录标准里最容易违反的一条"，
 * 却没有人检查它。
 *
 * 重复的后果：换场合的人会觉得"怎么还是这些"（这正是注释里写的原话）。
 * ========================================================================== */
{
  const decks = require('../miniprogram/utils/decks.js')
  const seen = new Map()
  const dup = []
  let total = 0

  decks.DECKS.forEach(d => {
    ;['truth', 'dare'].forEach(kind => {
      (d[kind] || []).forEach(t => {
        total++
        const key = String(t).trim()
        if (seen.has(key)) {
          dup.push(seen.get(key) + ' 与 ' + d.k + '：' + key.slice(0, 22))
        } else {
          seen.set(key, d.k)
        }
      })
    })
  })

  assert.deepStrictEqual([...new Set(dup)], [],
    '这些题在两副牌里重复了：\n    ' + dup.slice(0, 8).join('\n    '))
  assert.strictEqual(seen.size, total, '去重后 ' + seen.size + ' 条，实际 ' + total + ' 条')

  console.log('  ✓ 题卡库无重复（' + total + ' 条全部唯一）')
}

/* ============================================================================
 * 2026-11-03 追加：**「我的」页的玩法统计，颜色和顺序都要和真实代码一致**
 *
 * 原来 mock 里五个玩法色是**写死的 hex** —— 而注册表后来改过两次配色
 * （金花 `#B8863C`→`#D4A03C`、转盘 `#7A5CA8`→`#3E9187`），mock 没跟着改。
 *
 * 表现：「我的」页的圆点是旧颜色，和「大厅」的玩法卡对不上 —— 而两页都是同一份数据。
 *
 * 判据：颜色必须等于注册表里的 `color`；顺序必须是按次数降序（真实代码如此）。
 * ========================================================================== */
{
  const meMock = require('./ui-render/mock/me.js')
  const { GAMES } = require('../miniprogram/utils/games.js')

  const rows = (typeof meMock.data === 'function' ? meMock.data() : meMock.data).gameRows || []
  assert.ok(rows.length >= 5, '「我的」页的玩法行只有 ' + rows.length + ' 行')

  /* ① 颜色必须和注册表一致 */
  const wrongColor = []
  rows.forEach(r => {
    const g = GAMES.filter(x => x.id === r.id)[0]
    if (!g) return
    if (String(r.color).toUpperCase() !== String(g.color).toUpperCase()) {
      wrongColor.push(r.name + '：mock ' + r.color + ' / 注册表 ' + g.color)
    }
  })
  assert.deepStrictEqual(wrongColor, [],
    '这些玩法色和注册表对不上（截图里会显示旧颜色）：\n    ' + wrongColor.join('\n    '))

  /* ② 顺序必须是按次数降序 */
  const counts = rows.map(r => r.count)
  const sorted = counts.slice().sort((a, b) => b - a)
  assert.deepStrictEqual(counts, sorted,
    '「我的」页的玩法行没有按次数降序排（真实代码是 sort((a,b)=>b.count-a.count)）')

  console.log('  ✓ 「我的」页的玩法统计与真实代码一致（颜色 ' + rows.length + ' 项 / 按次数降序）')
}

/* ============================================================================
 * 2026-11-03 追加：**大厅的玩法卡永远不该为空**
 *
 * `list` 来自注册表（5 个玩法），所以正常情况下不会空。
 * 而如果哪天注册表读失败 / 顺序函数返回空数组，大厅会变成一片空白 ——
 * **没有"空状态"文案，用户只会以为 App 坏了**。
 *
 * 判据：每个 lobby 状态的 `list` 要么显式给了，要么继承默认值 —— 但**结果必须非空**。
 * ========================================================================== */
{
  const mock = require('./ui-render/mock/lobby.js')
  const base = typeof mock.data === 'function' ? mock.data() : mock.data

  const bad = []
  Object.keys(mock.states || {}).forEach(k => {
    const s = mock.states[k]()
    /* 状态自己给了 list 就用它，否则继承 base */
    const list = s.list !== undefined ? s.list : (base && base.list)
    if (!Array.isArray(list) || list.length === 0) {
      bad.push(k + '：list=' + JSON.stringify(list))
    }
  })

  assert.deepStrictEqual(bad, [],
    '这些大厅状态没有玩法卡（大厅会一片空白）：\n    ' + bad.join('\n    '))

  console.log('  ✓ 大厅每个状态都有玩法卡（' + Object.keys(mock.states || {}).length + ' 个状态）')
}

/* ============================================================================
 * 2026-11-03 追加：**"8 人局挤不挤"必须用一个真能看到按钮的状态来测**
 *
 * 我加过 `liar8`（8 人），但它的 `myTurn` 是 false ——
 * 于是界面显示"等老王叫完"，**根本没有叫骰选项**，测不到我想测的东西。
 *
 * 这是"自欺"的一种：**以为加了状态就覆盖了场景，而字段值让它走了另一条分支。**
 * ========================================================================== */
{
  const mock = require('./ui-render/mock/room.js')
  const s = typeof mock.states.liar8Mine === 'function' ? mock.states.liar8Mine() : null

  assert.ok(s, '★ 需要 liar8Mine 状态（8 人 + 轮到我）—— liar8 的 myTurn 是 false，看不到叫骰区')
  assert.strictEqual(s.room.myTurn, true,
    '★ liar8Mine 的 myTurn 必须是 true，否则它走的是"等别人"分支')
  assert.ok(s.room.count >= 8,
    '★ 这个状态要是满员（8 人），否则测不到"人多时挤不挤"')

  console.log('  ✓ 8 人局有"轮到我"的状态（myTurn=' + s.room.myTurn + '，' + s.room.count + ' 人）')
}

/* ============================================================================
 * 2026-11-03 追加：**mock 状态的名字要和它实际走的分支一致**
 *
 * 起因：我加了 `liar8`（8 人局），而它的 `myTurn` 是 false ——
 * **名字说有 8 人，实际走的是"等别人"分支，看不到叫骰区**。
 *
 * 这是"自欺"：以为加了状态就覆盖了场景，而字段值让它走了另一条路。
 *
 * ⚠️ 判据写窄：只查**名字里明确带阶段词**的那几个。
 *    第一版写成"含 Guest 就是大厅"，而 `overGuest` 是"非房主的**结算**页" —— 误报。
 *    这类"名字里恰好含另一个词"的情况，正则越宽越容易错。
 * ========================================================================== */
{
  const mock = require('./ui-render/mock/room.js')
  const bad = []

  Object.keys(mock.states).forEach(k => {
    let s
    try { s = mock.states[k]() } catch (e) { return }
    const r = s.room || {}
    const stage = s.stage || ''

    /* 名字以 Over / Win / Blowup 结尾或开头的 → 必须是结算 */
    if (/^(over|iLost|.*Over|.*Win|.*Blowup)$/i.test(k) && stage !== 'over') {
      bad.push(k + '：名字像结算，但 stage=' + stage)
    }
    /* 名字带 Mine / MyTurn → 必须 myTurn 为真 */
    if (/Mine$|MyTurn/i.test(k) && r.myTurn !== true) {
      bad.push(k + '：名字像"轮到我了"，但 myTurn=' + r.myTurn)
    }
  })

  assert.deepStrictEqual(bad, [],
    '这些 mock 状态的字段值让它走了和名字不符的分支：\n    ' + bad.join('\n    '))
  console.log('  ✓ mock 状态的名字和它走的分支一致（' + Object.keys(mock.states).length + ' 个）')
}
