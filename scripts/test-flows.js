/**
 * test-flows.js —— 五个玩法的**完整一局**能不能从头走到尾
 *
 * ============ 为什么单独一个脚本 ============
 *
 * 其他测试都是"某个函数的某个行为对不对"（叫骰能不能叫、投票计票对不对）。
 * 这一组只问一件事：**一个正常的玩家，从开局点到结算，会不会被卡住。**
 *
 * 2026-10-28 加这个脚本的直接原因：那天发现**单人开卧底会卡死在投票页** ——
 * 每个零件都对（发词对、计票对、结算对），但串起来走不完。
 * 之后又发现"摇完再摇会把骰子重摇""重开一局卧底状态残留"。
 * 这三个问题都不是单点断言能发现的，只有**真的把一局跑完**才会露出来。
 *
 * 所以这里不做任何边界/异常测试（那是 test-room.js 的事），
 * 只跑最普通的那条路径，并断言终点状态。
 *
 * 跑法：node scripts/test-flows.js
 */
const path = require('path')
const Module = require('module')
const assert = require('assert')

/* ============ 内存版 wx-server-sdk（与 test-room.js 同一套骨架）============
 * ⚠️ 这份是**复制**过来的，不是 require 的：test-room.js 是自执行脚本，
 *    没法复用它的内部对象。复制时如果 SDK 的行为变了，两边要一起改。
 */
const store = { rooms: [] }
let seq = 0
const nextId = () => 'r' + (++seq)
const command = {
  neq: v => ({ __op: 'neq', v }),
  push: v => ({ __op: 'push', v }),
  lt: v => ({ __op: 'lt', v }),
  gt: v => ({ __op: 'gt', v }),
  and: (...args) => ({ __op: 'and', v: args })
}
function one(doc, key, c) {
  if (c && c.__op === 'neq') return doc[key] !== c.v
  if (c && c.__op === 'lt') return Number(doc[key]) < Number(c.v)
  if (c && c.__op === 'gt') return Number(doc[key]) > Number(c.v)
  if (c && c.__op === 'and') {
    const list = Array.isArray(c.v[0]) ? c.v[0] : c.v
    return list.every(x => one(doc, key, x))
  }
  if (Array.isArray(doc[key])) return doc[key].indexOf(c) >= 0
  return doc[key] === c
}
const match = (doc, q) => Object.keys(q).every(k => one(doc, k, q[k]))
function collection(name) {
  const rows = () => (store[name] = store[name] || [])
  return {
    where(q) {
      return {
        _n: null, _f: null,
        limit(n) { this._n = n; return this },
        orderBy() { return this },
        /* ⚠️ `.field()` 必须实现：pickCode 用它只取 code 列。
           第一版 mock 没写，建房直接报 `field is not a function` ——
           **mock 缺口要在 mock 里补，不能在业务代码里绕开**。 */
        field(f) { this._f = f; return this },
        async get() {
          let out = JSON.parse(JSON.stringify(rows().filter(d => match(d, q))))
          if (this._n) out = out.slice(0, this._n)
          if (this._f) {
            const keys = Object.keys(this._f).filter(k => this._f[k])
            out = out.map(d => {
              const o = { _id: d._id }
              keys.forEach(k => { o[k] = d[k] })
              return o
            })
          }
          return { data: out }
        },
        async count() { return { total: rows().filter(d => match(d, q)).length } },
        async update({ data }) {
          const hit = rows().filter(d => match(d, q))
          hit.forEach(d => Object.keys(data).forEach(k => { d[k] = data[k] }))
          return { stats: { updated: hit.length } }
        }
      }
    },
    doc(id) {
      return {
        async get() {
          const d = rows().filter(x => x._id === id)[0]
          return { data: d ? JSON.parse(JSON.stringify(d)) : undefined }
        },
        async update({ data }) {
          const d = rows().filter(x => x._id === id)[0]
          if (!d) throw new Error('doc not found: ' + id)
          Object.keys(data).forEach(k => {
            if (data[k] && data[k].__op === 'push') d[k] = (d[k] || []).concat(data[k].v)
            else d[k] = data[k]
          })
          return { stats: { updated: 1 } }
        }
      }
    },
    async add({ data }) {
      const d = Object.assign({ _id: nextId() }, data)
      rows().push(d)
      return { _id: d._id }
    },
    async count() { return { total: rows().length } }
  }
}

let OPENID = ''
const mock = {
  init() {}, DYNAMIC_CURRENT_ENV: 'mock',
  database() { return { collection, command, async createCollection(n) { store[n] = store[n] || []; return true } } },
  getWXContext() { return { OPENID } },
  openapi: { security: { async msgSecCheck() { return { errCode: 0, result: { suggest: 'pass' } } } } }
}
const ROOT = path.join(__dirname, '..')
const orig = Module._load
Module._load = function (r) { if (r === 'wx-server-sdk') return mock; return orig.apply(this, arguments) }
const room = require(path.join(ROOT, 'cloudfunctions', 'room', 'index.js'))

let n = 0
function ok(msg) { n++; console.log('  ✓ ' + msg) }

/** 跳过 3 秒开局倒计时（把时间戳拨到过去，再 status 一次） */
async function enterPlaying(roomId) {
  const r = store.rooms.filter(x => x._id === roomId)[0]
  r.countdownEnd = Date.now() - 100
  await room.main({ action: 'status', id: roomId })
}

/**
 * 跑一局，返回终点状态。
 * ★ 每一步都断言 ok —— 失败时要知道**卡在哪一步**，
 *   而不是只看到最后"没到 over"。
 */
async function playOne(opts) {
  const { game, players, steps } = opts
  OPENID = players[0]
  const created = await room.main({ action: 'create', name: players[0], game })
  assert.ok(created.ok, game + '：建房应成功 —— ' + (created.msg || ''))
  const id = created.room.id
  const code = created.room.code
  for (const p of players.slice(1)) {
    OPENID = p
    const j = await room.main({ action: 'join', code, name: p })
    assert.ok(j.ok, game + '：' + p + ' 加入应成功 —— ' + (j.msg || ''))
  }
  OPENID = players[0]
  const st = await room.main({ action: 'start', id, solo: true })
  assert.ok(st.ok, game + '：开局应成功 —— ' + (st.msg || ''))
  await enterPlaying(id)

  for (let i = 0; i < steps.length; i++) {
    const s = steps[i]
    OPENID = s.as
    const r = await room.main(Object.assign({ id }, s.req))
    assert.ok(r.ok, game + '：第 ' + (i + 1) + ' 步（' + (s.name || s.req.action) + '）失败 —— ' + (r.msg || ''))
  }
  const fin = await room.main({ action: 'status', id })
  return { id, room: fin.room, raw: store.rooms.filter(x => x._id === id)[0] }
}

;(async () => {
  console.log('\n=== 五个玩法的完整一局（能不能从头走到尾）===')

  const A = 'flow_A', B = 'flow_B', C = 'flow_C'

  /* ---------- 大话骰：A 叫 → B 开 ---------- */
  {
    const { room: r } = await playOne({
      game: 'liar', players: [A, B],
      steps: [
        { as: A, name: 'A 叫 2 个 3', req: { action: 'bid', n: 2, face: 3 } },
        { as: B, name: 'B 开', req: { action: 'open' } }
      ]
    })
    assert.strictEqual(r.phase, 'over', '大话骰：开完应结算')
    assert.ok(r.lastResult && r.lastResult.loserName, '大话骰：要判出输家')
    ok('大话骰：叫骰 → 开 → 结算')
  }

  /* ---------- 连玩三局：跨局状态不能残留 ---------- */
  /*
   * ★ 2026-10-28。test-flows 之前只跑"一局" —— 但真实场景是连玩一晚上。
   *   而"跨局残留"恰恰是这个项目栽过的坑（again 只清了金花那批字段，
   *   卧底那批靠"下次 start"兜底）。只跑一局永远不会暴露它。
   */
  {
    OPENID = A
    const cr = await room.main({ action: 'create', name: 'C1', game: 'liar' })
    const cid = cr.room.id
    OPENID = B
    await room.main({ action: 'join', code: cr.room.code, name: 'C2' })

    for (let round = 1; round <= 3; round++) {
      OPENID = A
      const st = await room.main({ action: 'start', id: cid })
      assert.ok(st.ok, '第 ' + round + ' 局开局失败：' + (st.msg || ''))
      await enterPlaying(cid)

      OPENID = A
      const b = await room.main({ action: 'bid', id: cid, n: 2, face: 3 })
      assert.ok(b.ok, '第 ' + round + ' 局叫骰失败：' + (b.msg || ''))
      OPENID = B
      const o = await room.main({ action: 'open', id: cid })
      assert.ok(o.ok, '第 ' + round + ' 局开骰失败：' + (o.msg || ''))

      const fin = await room.main({ action: 'status', id: cid })
      assert.strictEqual(fin.room.phase, 'over', '第 ' + round + ' 局应结算')
      assert.ok(fin.room.lastResult && fin.room.lastResult.loserName,
        '第 ' + round + ' 局要判出输家')

      /* 再来一局 → 回到 lobby，且**不能带着上一局的叫骰/结果** */
      OPENID = A
      const ag = await room.main({ action: 'again', id: cid })
      assert.ok(ag.ok, '第 ' + round + ' 局再来一局失败')
      assert.strictEqual(ag.room.phase, 'lobby', '再来一局应回到 lobby')
      assert.ok(!ag.room.bid, '★ 第 ' + round + ' 局结束后 bid 必须清空')
      assert.ok(!ag.room.lastResult, '★ 第 ' + round + ' 局结束后 lastResult 必须清空')
      /*
       * ★ 反过来的要求：**今晚战况不能被清掉**（2026-10-29）。
       *   上面那批断言要求"局内状态清干净"，而 nightDrinks 是跨局累计的 ——
       *   两类字段在同一处清理，很容易顺手一起清掉。
       */
      assert.ok(ag.room.nightDrinks && typeof ag.room.nightDrinks === 'object',
        '★ nightDrinks 必须跨局保留（不能被 again 清掉）')
      const total = Object.keys(ag.room.nightDrinks)
        .reduce((n, k) => n + (Number(ag.room.nightDrinks[k]) || 0), 0)
      assert.strictEqual(total, round,
        '★ 第 ' + round + ' 局后，今晚累计应该是 ' + round + ' 杯（实际 ' + total + '）')
    }
    ok('★ 连玩三局：每局都能正常结算，局内状态清干净，今晚战况跨局累计')
  }

  /* ---------- 比大小：两人各摇一次 ---------- */
  {
    const { room: r } = await playOne({
      game: 'dice', players: [A, B],
      steps: [
        { as: A, name: 'A 摇', req: { action: 'roll' } },
        { as: B, name: 'B 摇', req: { action: 'roll' } }
      ]
    })
    assert.strictEqual(r.phase, 'over', '比大小：全员摇完应结算')
    assert.ok(r.lastResult && r.lastResult.winners.length, '比大小：要判出赢家')
    ok('比大小：两人各摇一次 → 结算')
  }

  /* ---------- 谁是卧底：发词 → 开始投票 → 三人各投一票 ---------- */
  {
    const { room: r } = await playOne({
      game: 'undercover', players: [A, B, C],
      steps: [
        { as: A, name: '房主开投票', req: { action: 'uwSay' } },
        /* 三个人都投 A —— 单一最高票，直接出结果 */
        { as: B, name: 'B 投 A', req: { action: 'uwVote', target: A } },
        { as: C, name: 'C 投 A', req: { action: 'uwVote', target: A } },
        { as: A, name: 'A 投 B', req: { action: 'uwVote', target: B } }
      ]
    })
    /* shape 把卧底状态收在 uw 里（不是顶层） */
    assert.ok(r.uw, '卧底：响应里应有 uw 段')
    assert.strictEqual(r.uw.step, 'result', '卧底：投完应进结算步骤 —— 实际 ' + r.uw.step)
    assert.ok(r.uw.lastOut && r.uw.lastOut.name, '卧底：要判出出局者')
    /* 票型必须留着 —— 这是结算时桌上第一个会问的信息 */
    assert.ok(Array.isArray(r.uw.lastOut.ballots) && r.uw.lastOut.ballots.length === 3,
      '卧底：结算要保留票型（3 票）')
    ok('卧底：发词 → 投票 → 出结果，且票型留在结算里')
  }

  /* ---------- 卧底连玩两局：局内状态最多，也最容易残留 ---------- */
  {
    OPENID = A
    const ur = await room.main({ action: 'create', name: 'U1', game: 'undercover' })
    const uid = ur.room.id
    for (const nm of [B, C]) {
      OPENID = nm
      await room.main({ action: 'join', code: ur.room.code, name: nm })
    }

    for (let round = 1; round <= 2; round++) {
      OPENID = A
      await room.main({ action: 'start', id: uid })
      await enterPlaying(uid)
      await room.main({ action: 'uwSay', id: uid })
      /* 三人各投一个（投 A，单一最高票） */
      for (const who of [B, C]) {
        OPENID = who
        await room.main({ action: 'uwVote', id: uid, target: A })
      }
      OPENID = A
      await room.main({ action: 'uwVote', id: uid, target: B })

      const fin = await room.main({ action: 'status', id: uid })
      assert.strictEqual(fin.room.uw.step, 'result', '第 ' + round + ' 局应出结果')

      OPENID = A
      const ag = await room.main({ action: 'again', id: uid })
      assert.ok(ag.ok, '第 ' + round + ' 局再来一局失败')
      /* ★ 卧底那批字段必须全部清空 —— 之前只靠"下次 start"兜底 */
      assert.ok(!ag.room.uw.lastOut, '★ 跨局 uwLastOut 必须清空')
      assert.ok(!ag.room.uw.tieBreak, '★ 跨局平票标记必须清空')
      assert.strictEqual(ag.room.uw.voteCount, 0, '★ 跨局票数必须归零')
    }
    ok('★ 卧底连玩两局：局内状态（出局/平票/票数）每局都清干净')
  }

  /* ---------- 梦幻金花：A 比 B ---------- */
  {
    const { room: r } = await playOne({
      game: 'poker', players: [A, B],
      steps: [
        { as: A, name: 'A 挑 B 比牌', req: { action: 'pkAct', act: 'vs', target: B } }
      ]
    })
    assert.ok(r.phase === 'over' || r.poker.folded || r.poker.last,
      '金花：比过牌之后要有结果（over / 已弃 / 有比牌记录）')
    ok('金花：挑人比牌 → 结算')
  }

  /* ---------- 换玩法再玩：一桌人会换着玩，换完状态必须干净 ---------- */
  /*
   * ★ 2026-10-28。真实的一桌人是"这局玩大话骰、下局换比大小"。
   *   而换玩法的清理和"再来一局"是**同一个服务端入口**（again / game 合一），
   *   差别只在改不改 game —— 所以这里要验证的是：
   *   换完之后，上一个玩法留下的东西（叫骰、结果、回合）不会污染新的。
   */
  {
    OPENID = A
    const sr = await room.main({ action: 'create', name: 'S1', game: 'liar' })
    const sid = sr.room.id
    OPENID = B
    await room.main({ action: 'join', code: sr.room.code, name: 'S2' })

    /* 第一局：大话骰，玩到结算 */
    OPENID = A
    await room.main({ action: 'start', id: sid })
    await enterPlaying(sid)
    await room.main({ action: 'bid', id: sid, n: 2, face: 3 })
    OPENID = B
    await room.main({ action: 'open', id: sid })

    /* 换成比大小 */
    OPENID = A
    const sw = await room.main({ action: 'game', id: sid, game: 'dice' })
    assert.ok(sw.ok, '换玩法应成功：' + (sw.msg || ''))
    assert.strictEqual(sw.room.game, 'dice', '换完应该是比大小')
    assert.strictEqual(sw.room.phase, 'lobby', '换完应回到 lobby')
    assert.ok(!sw.room.bid, '★ 换玩法后 bid 必须清空（否则新玩法带着旧叫骰）')
    assert.ok(!sw.room.lastResult, '★ 换玩法后 lastResult 必须清空')

    /* 第二局：比大小，正常打完 */
    OPENID = A
    const st2 = await room.main({ action: 'start', id: sid })
    assert.ok(st2.ok, '换玩法后开局应成功：' + (st2.msg || ''))
    await enterPlaying(sid)
    await room.main({ action: 'roll', id: sid })
    OPENID = B
    await room.main({ action: 'roll', id: sid })

    const fin = await room.main({ action: 'status', id: sid })
    assert.strictEqual(fin.room.phase, 'over', '★ 换玩法后的一局必须能正常打完')
    assert.ok(fin.room.lastResult && fin.room.lastResult.winners.length,
      '比大小要判出赢家')
    ok('★ 换玩法再玩：大话骰 → 换比大小 → 照常打完，中间不残留')
  }

  /* ---------- 命运转盘：房主转一次 ---------- */
  {
    const { room: r } = await playOne({
      game: 'wheel', players: [A],
      steps: [
        { as: A, name: '房主转', req: { action: 'spin' } }
      ]
    })
    assert.ok(r.spin && r.spin.t, '转盘：要抽出结果')
    assert.ok(typeof r.spin.index === 'number', '转盘：要带扇区下标')
    ok('转盘：转一次 → 出结果')
  }

  /* ---------- 8 人比大小（上限）：最后一颗骰的判定 ---------- */
  {
    OPENID = 'oid_d1'
    const br2 = await room.main({ action: 'create', name: '骰1', game: 'dice' })
    const bid2 = br2.room.id
    for (let i = 2; i <= 8; i++) {
      OPENID = 'oid_d' + i
      await room.main({ action: 'join', code: br2.room.code, name: '骰' + i })
    }
    OPENID = 'oid_d1'
    await room.main({ action: 'start', id: bid2 })
    await enterPlaying(bid2)

    /* 前 7 个人摇完 → 还不该结算 */
    for (let i = 1; i <= 7; i++) {
      OPENID = 'oid_d' + i
      await room.main({ action: 'roll', id: bid2 })
    }
    let st2 = await room.main({ action: 'status', id: bid2 })
    assert.strictEqual(st2.room.phase, 'playing', '★ 还差 1 个人没摇时不能结算')

    /* 第 8 个摇完 → 结算 */
    OPENID = 'oid_d8'
    await room.main({ action: 'roll', id: bid2 })
    st2 = await room.main({ action: 'status', id: bid2 })
    assert.strictEqual(st2.room.phase, 'over', '★ 8 人全摇完必须结算')
    assert.strictEqual((st2.room.lastResult.ranked || []).length, 8,
      '★ 排名要包含全部 8 个人')
    ok('★ 8 人比大小（上限）：差一个人不结算，全员摇完才出结果')
  }

  /* ---------- 12 人卧底（上限）：大桌也要能走完 ---------- */
  /*
   * ★ 2026-10-28。卧底的 max 是 12 —— 也就是"一桌人全都玩"的最大规模。
   *   2~4 人的小局走得通，不代表 12 人走得通：
   *   投票要收满 11 票（自己不能投自己）、票型要能算、结算列表要能排。
   */
  {
    OPENID = 'oid_u1'
    const br = await room.main({ action: 'create', name: '圈1', game: 'undercover' })
    const bid = br.room.id
    const bcode = br.room.code
    const players = ['oid_u1']
    for (let i = 2; i <= 12; i++) {
      const who = 'oid_u' + i
      players.push(who)
      OPENID = who
      const j = await room.main({ action: 'join', code: bcode, name: '圈' + i })
      assert.ok(j.ok, '第 ' + i + ' 个人应能进：' + (j.msg || ''))
    }
    OPENID = 'oid_u1'
    const st = await room.main({ action: 'start', id: bid })
    assert.ok(st.ok, '12 人应能开局：' + (st.msg || ''))
    await enterPlaying(bid)
    await room.main({ action: 'uwSay', id: bid })

    /* 11 个人投给第 1 个人（自己不能投自己），第 1 个人投第 2 个 */
    for (let i = 2; i <= 12; i++) {
      OPENID = 'oid_u' + i
      const v = await room.main({ action: 'uwVote', id: bid, target: 'oid_u1' })
      assert.ok(v.ok, '第 ' + i + ' 个人投票应成功：' + (v.msg || ''))
    }
    OPENID = 'oid_u1'
    await room.main({ action: 'uwVote', id: bid, target: 'oid_u2' })

    const fin = await room.main({ action: 'status', id: bid })
    assert.strictEqual(fin.room.uw.step, 'result', '★ 12 人投完应出结果')
    assert.ok(fin.room.uw.lastOut, '要判出出局者')
    assert.strictEqual(fin.room.uw.lastOut.ballots.length, 12,
      '★ 票型要收满 12 票（自己那票也在），实际 ' + (fin.room.uw.lastOut.ballots || []).length)
    ok('★ 12 人卧底（上限）：发词 → 12 票 → 出结果，票型齐全')
  }

  /* ---------- 金花换牌的代价：换底牌 1 杯、换手牌半杯，且累计 ---------- */
  /*
   * ★ 2026-10-28。这是这个玩法的**博弈核心**（把运气变成可付费的选择），
   *   而规则里写死了"1 杯 / 半杯"。数字错了，整个博弈就变形了 ——
   *   而且不会报错，玩家只会觉得"这游戏算得不对"。
   */
  {
    OPENID = A
    const dr = await room.main({ action: 'create', name: 'D1', game: 'poker' })
    const did = dr.room.id
    OPENID = B
    await room.main({ action: 'join', code: dr.room.code, name: 'D2' })
    OPENID = A
    await room.main({ action: 'start', id: did })
    await enterPlaying(did)

    /* 轮到我 → 换底牌（1 杯） */
    let st = await room.main({ action: 'status', id: did })
    /* myTurn 是**前端**派生字段（服务端不返回）—— 这里用 turn + me.seat 判 */
    assert.strictEqual(st.room.turn, st.room.me.seat, '房主先手，应该轮到我')
    const sw1 = await room.main({ action: 'pkAct', id: did, act: 'swapPublic' })
    assert.ok(sw1.ok, '换底牌应成功：' + (sw1.msg || ''))
    st = await room.main({ action: 'status', id: did })
    assert.strictEqual(st.room.poker.myDrink, 1, '★ 换底牌应记 1 杯，实际 ' + st.room.poker.myDrink)

    /* 换完回合不推进（规则：喝完还能接着决定） */
    assert.strictEqual(st.room.turn, st.room.me.seat, '★ 换完仍是自己的回合（喝完还能接着决定）')

    /* 再换手牌（+0.5 → 累计 1.5） */
    const sw2 = await room.main({ action: 'pkAct', id: did, act: 'swapMine' })
    assert.ok(sw2.ok, '换手牌应成功：' + (sw2.msg || ''))
    st = await room.main({ action: 'status', id: did })
    assert.strictEqual(st.room.poker.myDrink, 1.5,
      '★ 换手牌 +0.5，累计应为 1.5，实际 ' + st.room.poker.myDrink)
    ok('★ 金花换牌：底牌 1 杯 / 手牌半杯，累计 1.5，且换完回合不推进')
  }

  /* ---------- 房间满了：第 max+1 个人进不来，而且不能留在库里 ---------- */
  /*
   * ★ 2026-10-28。test-room.js 的文件头写着"人数上限"，但实际搜不到对应的用例 ——
   *   而这块代码有一处**必须验证**的地方：超员时是"先 push 再摘出去"，
   *   如果摘的动作失败，那个人就会留在房间里（count 变 7），
   *   而且他不知道自己没进来。
   *
   *   用金花（max=6）测：6 人满员，第 7 个人必须被拒且不留痕。
   */
  {
    OPENID = A
    const fr = await room.main({ action: 'create', name: 'F1', game: 'poker' })
    const fid = fr.room.id
    const fcode = fr.room.code
    /* 再进 5 个（加上房主共 6，正好满） */
    for (let i = 2; i <= 6; i++) {
      OPENID = 'oid_f' + i
      const j = await room.main({ action: 'join', code: fcode, name: 'F' + i })
      assert.ok(j.ok, '第 ' + i + ' 个人应能进：' + (j.msg || ''))
    }
    /* 第 7 个人 */
    OPENID = 'oid_f7'
    const over = await room.main({ action: 'join', code: fcode, name: 'F7' })
    assert.strictEqual(over.ok, false, '★ 满员后第 7 个人必须进不来')
    assert.ok(/满/.test(over.msg || ''), '提示要说清是满了，实际：' + (over.msg || ''))

    /* ★ 关键：他不能留在房间里（不能只看返回值） */
    OPENID = A
    const st = await room.main({ action: 'status', id: fid })
    assert.strictEqual(st.room.count, 6, '★ 被拒的人不能留在玩家列表里（否则人数越进越多）')
    ok('★ 房间满了：第 7 个人被拒、提示说清、且没有留在库里')
  }

  /* ---------- 所有人都走了：房间要失效，号码能回收 ---------- */
  /*
   * ★ 2026-10-28。3 位号码只有 1000 个 —— 空房间如果一直占着号，
   *   玩一晚上能撞号撞到"没号可用"。代码里 `if (!players.length) active = false`
   *   就是干这个的，但从来没有测试验证过"走光之后真的失效"。
   *
   *   判据不看内部字段，看**行为**：拿原房间号再进一次，必须进不去。
   */
  {
    OPENID = A
    const er = await room.main({ action: 'create', name: 'E1', game: 'dice' })
    const ecode = er.room.code
    const eid = er.room.id
    OPENID = B
    await room.main({ action: 'join', code: ecode, name: 'E2' })

    /* 两个人都走 */
    OPENID = A
    await room.main({ action: 'leave', id: eid })
    OPENID = B
    await room.main({ action: 'leave', id: eid })

    /* 拿原号再进 —— 应该进不去（房间已经空了） */
    OPENID = 'oid_newcomer'
    const again = await room.main({ action: 'join', code: ecode, name: '路人' })
    assert.strictEqual(again.ok, false,
      '★ 人都走光的房间必须失效（否则号码池只减不增，玩一晚上就没号了）')
    ok('★ 所有人退出后房间失效（号码可回收）')
  }

  /* ---------- 房主中途走了：房间不能变死局 ---------- */
  /*
   * ★ 2026-10-28。真实场景：房主去上厕所/接电话，直接退出。
   *
   *   代码里做了顺位转移，还有一段很隐蔽的处理（注释里写着）：
   *   接任者如果是"中途加入、本局观战"的人，**必须同时把他纳入本局** ——
   *   否则会出现这条死路：
   *     原有参与者都走光 → 房主落到观战者头上，而他 inRound 仍是 false
   *     → 点"开始"时按 inRound 过滤，没人发骰子 → **一个人卡死，且不报错**。
   *
   *   所以这里测的不只是"有人接手"，而是"**接手的人能不能真的开局**"。
   */
  {
    OPENID = A
    const hr = await room.main({ action: 'create', name: 'H1', game: 'dice' })
    const hid = hr.room.id
    OPENID = B
    await room.main({ action: 'join', code: hr.room.code, name: 'H2' })
    OPENID = C
    await room.main({ action: 'join', code: hr.room.code, name: 'H3' })

    /* 房主直接走人（lobby 阶段） */
    OPENID = A
    const lv = await room.main({ action: 'leave', id: hid })
    assert.ok(lv.ok, '房主退出应成功')
    const after = await room.main({ action: 'status', id: hid })
    assert.strictEqual(after.room.host, false, '走掉的人不该还是房主')
    assert.ok(after.room.count === 2, '应剩 2 人')

    /* 有人接手了 —— 用"谁能开局"来判，而不是猜是谁 */
    let newHost = null
    for (const who of [B, C]) {
      OPENID = who
      const st = await room.main({ action: 'start', id: hid })
      if (st.ok) { newHost = who; break }
    }
    assert.ok(newHost, '★ 房主走后必须有一个人能接手（否则这桌人废了）')

    /* ★ 关键：接手的人要能把这局**真的开起来并打完** */
    await enterPlaying(hid)
    for (const who of [B, C]) {
      OPENID = who
      await room.main({ action: 'roll', id: hid })
    }
    const fin = await room.main({ action: 'status', id: hid })
    assert.strictEqual(fin.room.phase, 'over', '★ 新房的这一局必须能正常结算')
    ok('★ 房主中途走了：有人顺位接手，且这一局能真的开起来打完')
  }

  /* ---------- 有人来晚了：这一局观战，下一局参与 ---------- */
  /*
   * ★ 2026-10-28。真实场景：饭局中途有人赶到。
   *
   *   服务端用 `inRound` 标记处理，而它防的是两个具体的坑
   *   （AGENTS.md 里写着，都是"不报错但整局坏掉"的类型）：
   *     ① 新人插进来重编号座位 → 正在玩的人的回合全乱
   *     ② 比大小的结束判据是 every(dice.length>0)，
   *        新人的 dice 是空的 → **这一局永远结束不了**
   *
   *   所以要测的不只是"能不能进来"，而是"进来之后这一局还能正常结束"。
   */
  {
    OPENID = A
    const mr = await room.main({ action: 'create', name: 'L1', game: 'dice' })
    const mid = mr.room.id
    const mcode = mr.room.code
    OPENID = B
    await room.main({ action: 'join', code: mcode, name: 'L2' })

    OPENID = A
    await room.main({ action: 'start', id: mid })
    await enterPlaying(mid)

    /* 第 3 个人在 playing 中途进来 */
    OPENID = C
    const late = await room.main({ action: 'join', code: mcode, name: '迟到的' })
    assert.ok(late.ok, '中途加入应成功：' + (late.msg || ''))
    const me = (late.room.players || []).filter(p => p.seat === late.room.me.seat)[0] || {}
    assert.strictEqual(me.inRound, false, '★ 中途进来的这一局只能观战（inRound=false）')

    /* 已有的人的座位不能被他挤乱 */
    const seats = late.room.players.map(p => p.seat).sort((a, b) => a - b)
    assert.deepStrictEqual(seats, [1, 2, 3], '座位仍要连续（他在末尾）')

    /* ★ 关键：这一局必须还能正常结束（不能因为多了个没骰子的人而卡死） */
    OPENID = A
    await room.main({ action: 'roll', id: mid })
    OPENID = B
    await room.main({ action: 'roll', id: mid })
    const fin = await room.main({ action: 'status', id: mid })
    assert.strictEqual(fin.room.phase, 'over',
      '★ 观战者不该让这一局卡死（他的 dice 是空的，但判结束只看 inRound 的人）')

    /* 下一局他应该自然参与 */
    OPENID = A
    const ag = await room.main({ action: 'again', id: mid })
    assert.ok(ag.ok, '再来一局应成功')
    const cInRound = (ag.room.players || []).filter(p => p.name === '迟到的')[0] || {}
    assert.notStrictEqual(cInRound.inRound, false, '★ 下一局他就该参与，不再是观战')
    ok('★ 有人来晚了：这一局观战且不卡死，下一局自动参与')
  }

  /* ---------- 连玩中有人退出又回来：座位和回合不能乱 ---------- */
  /*
   * ★ 2026-10-28。真实场景：有人临时接电话退出，过一会儿又回来。
   *   这个项目栽过"回合序号越界"（seat3 退出后 turn 仍是 3 → 永远没人轮到），
   *   而"退出后再重进"是同一类问题的另一种形态。
   */
  {
    OPENID = A
    const xr = await room.main({ action: 'create', name: 'X1', game: 'dice' })
    const xid = xr.room.id
    const xcode = xr.room.code
    OPENID = B
    await room.main({ action: 'join', code: xcode, name: 'X2' })
    OPENID = C
    await room.main({ action: 'join', code: xcode, name: 'X3' })

    /* 中间那个人退出 */
    OPENID = B
    const lv = await room.main({ action: 'leave', id: xid })
    assert.ok(lv.ok, '退出应成功')
    const afterLeave = await room.main({ action: 'status', id: xid })
    assert.strictEqual(afterLeave.room.count, 2, '退出后应剩 2 人')
    /* 座位必须重新连续编号（否则"轮到座位 3"永远没人） */
    const seats = afterLeave.room.players.map(p => p.seat).sort((a, b) => a - b)
    assert.deepStrictEqual(seats, [1, 2], '★ 座位必须重编号成 1..N，不能留空洞')

    /* 他又回来了 */
    OPENID = B
    const re = await room.main({ action: 'join', code: xcode, name: 'X2' })
    assert.ok(re.ok, '重新进房应成功：' + (re.msg || ''))
    const afterRejoin = await room.main({ action: 'status', id: xid })
    assert.strictEqual(afterRejoin.room.count, 3, '回来后应是 3 人')
    const seats2 = afterRejoin.room.players.map(p => p.seat).sort((a, b) => a - b)
    assert.deepStrictEqual(seats2, [1, 2, 3], '★ 回来后座位仍必须连续')

    /* 这一局还能正常开、正常打完 */
    OPENID = A
    const xst = await room.main({ action: 'start', id: xid })
    assert.ok(xst.ok, '退出又进来之后开局应成功：' + (xst.msg || ''))
    await enterPlaying(xid)
    for (const who of [A, B, C]) {
      OPENID = who
      await room.main({ action: 'roll', id: xid })
    }
    const xfin = await room.main({ action: 'status', id: xid })
    assert.strictEqual(xfin.room.phase, 'over', '★ 退出又回来的人参与的那局必须能结算')
    ok('★ 连玩中有人退出又回来：座位重编号连续，这一局照常打完')
  }

  console.log(`\n${'='.repeat(58)}`)
  console.log(`  完整流程：全部 ${n} 个玩法都能从头走到尾`)
  console.log(`${'='.repeat(58)}\n`)
})().catch(e => {
  console.error('\n  ✗ 断言失败：', e.message, '\n')
  process.exit(1)
})
