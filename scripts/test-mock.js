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
