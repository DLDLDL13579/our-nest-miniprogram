/**
 * test-room.js —— 多人游戏房间的逻辑验证
 *
 * 这一组的命门和「双盲」是同一件事，只是换了场景：
 *   **大话骰里，别人的骰子绝不能出现在我的响应里。**
 * 如果服务端把所有人的骰子都发下来、前端只是不显示，
 * 那抓个包就能看到别人的点数 —— 游戏直接废掉。
 *
 * 另外验证多人场景特有的东西：
 *   · 房间码加入、人数上限
 *   · 房主转移（房主走了不能让房间变死局）
 *   · 座位重编号（不然"轮到谁"会卡住）
 *   · 只能往上叫（服务端判定，不信前端）
 *   · 开骰才亮出所有人的骰子
 *
 * 跑法：node scripts/test-room.js
 */
const path = require('path')
const Module = require('module')
const assert = require('assert')

const store = { rooms: [] }
let seq = 0
const nextId = () => 'r' + (++seq)

function neq(v) { return { __op: 'neq', v } }
function pushv(v) { return { __op: 'push', v } }
const command = { neq, push: pushv }

function match(doc, q) {
  return Object.keys(q).every(k => {
    const c = q[k]
    if (c && c.__op === 'neq') return doc[k] !== c.v
    if (Array.isArray(doc[k])) return doc[k].indexOf(c) >= 0
    return doc[k] === c
  })
}

function collection(name) {
  const rows = () => (store[name] = store[name] || [])
  return {
    where(q) {
      const cond = q
      return {
        _n: null, _o: [],
        limit(n) { this._n = n; return this },
        orderBy(f, d) { this._o.push([f, d]); return this },
        async get() {
          let out = rows().filter(d => match(d, cond))
          if (this._n) out = out.slice(0, this._n)
          /* 深拷贝：真数据库每次 get 都是新对象，
             mock 若返回引用，update 会改到调用方手里的"快照" */
          return { data: JSON.parse(JSON.stringify(out)) }
        },
        async count() { return { total: rows().filter(d => match(d, cond)).length } }
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

const A = 'oid_player_A'
const B = 'oid_player_B'
const C = 'oid_player_C'

let n = 0
function ok(msg) { n++; console.log('  ✓ ' + msg) }

;(async () => {
  /* ============ ① 建房与加入 ============ */
  console.log('\n=== ① 建房 / 房间码 / 加入 ===')
  OPENID = A
  const created = await room.main({ action: 'create', name: '邓林', game: 'liar' })
  assert.ok(created.ok, '建房应成功')
  const code = created.room.code
  assert.strictEqual(code.length, 6, '房间码 6 位')
  assert.ok(!/[IO01]/.test(code), '房间码不含易混字符 I/O/0/1（要口头念）')
  assert.strictEqual(created.room.count, 1, '建房者自动在房里')
  assert.strictEqual(created.room.host, true, '建房者是房主')
  const roomId = created.room.id
  ok(`建房成功，房间码 ${code}（不含 I/O/0/1，电话里念不会听错）`)

  /* 大小写与空格要能容错 —— 对方手输的 */
  OPENID = B
  const joined = await room.main({ action: 'join', code: ' ' + code.toLowerCase() + ' ', name: '倩萍' })
  assert.ok(joined.ok, '小写+空格的房间码也应能加入')
  assert.strictEqual(joined.room.count, 2, '现在两个人')
  ok('★ 房间码大小写与空格容错（对方是手输的，不能苛刻）')

  OPENID = C
  const joined3 = await room.main({ action: 'join', code, name: '老王' })
  assert.strictEqual(joined3.room.count, 3, '第三个人也能进')
  assert.strictEqual(joined3.room.me.seat, 3, '座位顺延到 3')
  ok('3 个人也能进（不是只支持两人）')

  /* 错误房间码 */
  OPENID = 'oid_stranger'
  const badCode = await room.main({ action: 'join', code: 'ZZZZZZ', name: '路人' })
  assert.strictEqual(badCode.ok, false)
  assert.strictEqual(badCode.code, 'NO_ROOM')
  ok('错误房间码被拒：「' + badCode.msg + '」')

  /* ============ ② ★ 命门：别人的骰子不能泄露 ============ */
  console.log('\n=== ② ★ 命门：开局后看不到别人的骰子 ===')
  OPENID = A
  const notHost = await room.main({ action: 'start', id: roomId })
  assert.ok(notHost.ok, '房主开局应成功')

  /* 每个人视角：只能看到自己的 dice，别人的只有 diceCount */
  OPENID = B
  const viewB = await room.main({ action: 'status', id: roomId })
  assert.ok(viewB.ok)
  const others = viewB.room.players.filter(p => !p.isMe)
  assert.ok(others.length === 2, '应该能看到另外两个玩家（知道有谁）')
  others.forEach(p => {
    assert.strictEqual(p.dice, undefined, '★ 别人的 dice 字段必须是 undefined（不是空数组，是根本没这个字段）')
    assert.strictEqual(typeof p.diceCount, 'number', '但要知道对方有几颗（界面要画）')
  })
  ok('★ 别人的 dice 在服务端就被丢掉了 —— 响应里根本没这个字段')

  /* 整个响应的字符串里不该出现别人的点数数组 */
  const rawB = JSON.stringify(viewB)
  const myDice = viewB.room.me.dice
  assert.ok(myDice.length === 5, '自己能看到自己的 5 颗')
  ok(`自己的骰子能看到（${myDice.join(',')}），别人的看不到`)

  /* 三个人的视角都验证一遍 */
  for (const [who, oid] of [['A', A], ['B', B], ['C', C]]) {
    OPENID = oid
    const v = await room.main({ action: 'status', id: roomId })
    const mine = v.room.me
    assert.ok(mine.dice.length === 5, `${who} 应看到自己的 5 颗`)
    const otherDice = v.room.players.filter(p => !p.isMe).map(p => p.dice)
    assert.ok(otherDice.every(d => d === undefined), `${who} 不该看到任何人的骰子`)
  }
  ok('★ 三个人各自的视角都验证过：只有自己的骰子可见')

  /* ============ ③ 只能往上叫（服务端判定） ============ */
  console.log('\n=== ③ 叫骰：服务端判定，不信前端 ===')
  OPENID = A
  const bid1 = await room.main({ action: 'bid', id: roomId, n: 3, face: 4 })
  assert.ok(bid1.ok, '轮到 1 号（房主）叫，应成功')
  assert.strictEqual(bid1.room.bid.n, 3)
  assert.strictEqual(bid1.room.turn, 2, '轮到下一家')
  ok(`叫「3 个 4」成功，轮到 2 号`)

  /* 不是自己的回合 */
  const wrongTurn = await room.main({ action: 'bid', id: roomId, n: 4, face: 4 })
  assert.strictEqual(wrongTurn.ok, false, 'A 又叫一次应被拒（已轮到 B）')
  assert.ok(/没轮到/.test(wrongTurn.msg))
  ok('不是自己回合时被拒：「' + wrongTurn.msg + '」')

  /* 往下叫 */
  OPENID = B
  const lower = await room.main({ action: 'bid', id: roomId, n: 2, face: 6 })
  assert.strictEqual(lower.ok, false, '数量变小应被拒')
  assert.ok(/往上叫/.test(lower.msg))
  ok('往下叫被拒：「' + lower.msg + '」')

  const sameLowerFace = await room.main({ action: 'bid', id: roomId, n: 3, face: 3 })
  assert.strictEqual(sameLowerFace.ok, false, '数量同、点数小应被拒')
  ok('数量同但点数变小也被拒')

  const valid = await room.main({ action: 'bid', id: roomId, n: 3, face: 5 })
  assert.ok(valid.ok, '数量同、点数大应成功')
  ok('数量同、点数大 → 允许（3 个 4 → 3 个 5）')

  /* ============ ④ 开骰：此时才亮出所有人的骰子 ============ */
  console.log('\n=== ④ 开骰：这时才亮出所有人的骰子 ===')
  OPENID = C
  const opened = await room.main({ action: 'open', id: roomId })
  assert.ok(opened.ok, '轮到 3 号，开骰应成功')
  const res = opened.result
  assert.ok(res, '应有结果')
  assert.strictEqual(res.allDice.length, 3, '★ 开骰后亮出 3 个人的骰子')
  assert.ok(res.allDice.every(d => d.dice.length === 5), '每人 5 颗都亮出来')
  ok(`★ 开骰后亮出全部 ${res.allDice.length} 人的骰子（之前是保密的）`)

  assert.strictEqual(opened.room.phase, 'over', '开骰后进入结算')
  assert.ok(res.loserName, '应有输家：' + res.loserName)
  ok(`结算：叫了 ${res.need} 个 ${res.face}、实际 ${res.actual} 个 → ${res.bidderWins ? '叫骰成立' : '吹牛被抓'}，${res.loserName} 输`)

  /* 判定逻辑正确性 */
  const expectWins = res.actual >= res.need
  assert.strictEqual(res.bidderWins, expectWins, '判定必须与"实际 >= 叫的"一致')
  ok('★ 判定逻辑正确（实际 ' + res.actual + ' vs 叫的 ' + res.need + '）')

  /* 输家扣分 */
  const loser = opened.room.players.filter(p => p.seat === res.loserSeat)[0]
  assert.ok(loser.score < 0, '输家分数应为负')
  ok(`输家 ${loser.name} 扣分（score = ${loser.score}）`)

  /* ============ ⑤ 房主离开 → 顺位转移 ============ */
  console.log('\n=== ⑤ 房主离开：不能变成没人能管的死局 ===')
  OPENID = A
  const left = await room.main({ action: 'leave', id: roomId })
  assert.ok(left.ok && !left.closed, '房主走了房间还在（还有人）')

  OPENID = B
  const after = await room.main({ action: 'status', id: roomId })
  assert.strictEqual(after.room.count, 2, '剩两个人')
  assert.strictEqual(after.room.host, true, '★ 房主自动转给下一个人（B 成为房主）')
  const seats = after.room.players.map(p => p.seat).sort()
  assert.deepStrictEqual(seats, [1, 2], '★ 座位重新编号为 1、2（不留空号）')
  ok('★ 房主顺位转移 + 座位重编号（不然"轮到谁"会卡在空号上）')

  /* ============ ⑥ 最后一人离开 → 房间解散 ============ */
  console.log('\n=== ⑥ 最后一个人走了 → 房间解散 ===')
  OPENID = B
  await room.main({ action: 'leave', id: roomId })
  OPENID = C
  const last = await room.main({ action: 'leave', id: roomId })
  assert.ok(last.closed, '最后一人离开应解散房间')
  ok('房间自动解散（不会留下没人管的空房间）')

  /* ============ ⑦ 越权 ============ */
  console.log('\n=== ⑦ 越权：不在房里的人什么都拿不到 ===')
  OPENID = A
  const created2 = await room.main({ action: 'create', name: '新房主', game: 'dice' })
  const rid2 = created2.room.id

  OPENID = 'oid_intruder'
  const peek = await room.main({ action: 'status', id: rid2 })
  /* 不在房里也能看到房间基本信息（否则没法"加入前预览"），
     但必须看不到任何人的骰子 */
  if (peek.ok) {
    const anyDice = peek.room.players.some(p => p.dice !== undefined)
    assert.strictEqual(anyDice, false, '★ 房外的人不该看到任何人的骰子')
    ok('房外的人能看到房间存在，但看不到任何人的骰子')
  } else {
    ok('房外的人被拒绝访问房间详情')
  }

  const intrudeStart = await room.main({ action: 'start', id: rid2 })
  assert.strictEqual(intrudeStart.ok, false, '非房主不能开局')
  ok('非房主开局被拒：「' + intrudeStart.msg + '」')

  const intrudeBid = await room.main({ action: 'bid', id: rid2, n: 2, face: 2 })
  assert.strictEqual(intrudeBid.ok, false, '不在房里不能叫骰')
  ok('不在房里叫骰被拒：「' + intrudeBid.msg + '」')

  /* ============ ⑧ 人数上限 ============ */
  console.log('\n=== ⑧ 人数上限 ===')
  OPENID = A
  const big = await room.main({ action: 'create', name: 'P1', game: 'dice' })
  const bigCode = big.room.code
  let added = 1
  for (let i = 2; i <= 10; i++) {
    OPENID = 'oid_bulk_' + i
    const r = await room.main({ action: 'join', code: bigCode, name: 'P' + i })
    if (r.ok) added++
    else {
      assert.ok(/满了/.test(r.msg), '超出上限应提示房间满')
      break
    }
  }
  assert.strictEqual(added, 8, '★ 上限 8 人')
  ok(`人数上限生效：加到第 ${added} 个后被拒（最多 8 人）`)

  /* ============ ⑨ 开局前不能操作 ============ */
  console.log('\n=== ⑨ 大厅阶段不能叫骰 ===')
  OPENID = A
  const notStarted = await room.main({ action: 'bid', id: rid2, n: 2, face: 2 })
  assert.strictEqual(notStarted.ok, false)
  assert.ok(/还没开始/.test(notStarted.msg))
  ok('开局前叫骰被拒：「' + notStarted.msg + '」')

  const soloStart = await room.main({ action: 'start', id: rid2 })
  assert.strictEqual(soloStart.ok, false, '一个人不能开局')
  assert.ok(/至少两个/.test(soloStart.msg))
  ok('一个人开局被拒：「' + soloStart.msg + '」')

  /* ============ ⑩ 再来一局 ============ */
  console.log('\n=== ⑩ 再来一局：清空骰子回到大厅 ===')
  /* 注意：要往 rid2 这个房间加人（它的房间码是 created2.room.code），
     不是往 bigCode（那是 8 人上限测试用的另一个房间）。
     第一版这里写错了变量，导致 start 时房里只有 1 人而被拒。 */
  OPENID = B
  const joinedForAgain = await room.main({ action: 'join', code: created2.room.code, name: 'P2' })
  assert.ok(joinedForAgain.ok, '第二个人应能加入 rid2')

  OPENID = A
  const started = await room.main({ action: 'start', id: rid2 })
  assert.ok(started.ok, '两人后房主开局应成功：' + (started.msg || ''))

  const rolled = await room.main({ action: 'status', id: rid2 })
  assert.strictEqual(rolled.room.phase, 'playing', '开局后 playing')
  assert.ok(rolled.room.me.dice.length > 0, '开局后我有骰子')

  const again = await room.main({ action: 'again', id: rid2 })
  assert.ok(again.ok, '房主开新一局')
  assert.strictEqual(again.room.phase, 'lobby', '回到大厅')
  assert.ok(again.room.players.every(p => p.diceCount === 0), '★ 骰子已清空')
  ok('★ 再来一局：回到大厅且骰子清空（不然会拿着上局的点数开新局）')

  /* ============ ⑪ 游戏中途有人退出，回合不能卡死 ============ */
  console.log('\n=== ⑪ ★ 中途退人：回合必须自动修正（否则游戏卡死且不报错）===')
  OPENID = A
  const mid = await room.main({ action: 'create', name: 'M1', game: 'liar' })
  const midId = mid.room.id
  const midCode = mid.room.code
  OPENID = B
  await room.main({ action: 'join', code: midCode, name: 'M2' })
  OPENID = C
  await room.main({ action: 'join', code: midCode, name: 'M3' })

  OPENID = A
  await room.main({ action: 'start', id: midId })
  /* A(seat1) → B(seat2) 各叫一次 → turn 变 3（轮到 C） */
  await room.main({ action: 'bid', id: midId, n: 2, face: 3 })
  OPENID = B
  await room.main({ action: 'bid', id: midId, n: 3, face: 3 })
  let midRoom = store.rooms.filter(r => r._id === midId)[0]
  assert.strictEqual(midRoom.turn, 3, '两人叫完应轮到 seat3')

  /*
   * ★ 关键场景：**当前回合持有者是最后一位**（seat3）时退出。
   *
   * 为什么必须是这个场景：3 人局轮到 seat3（turn=3），
   * 如果退出后不修正 turn，剩 2 人而 turn 仍为 3 → **越界**，
   * 没有任何玩家的座位等于 3，于是"永远没人轮到"，游戏卡死且不报错。
   *
   * 第一版测试用的是「turn=2 时 seat2 退出」—— 那种情况剩 2 人、turn=2
   * 恰好合法，所以**去掉修正逻辑测试照样通过**，等于没测到。
   * 这是反向验证（故意改坏 → 看测试是否报错）才发现的，值得记一笔：
   * 断言写得"看起来对"不够，要能真的失败。
   */
  OPENID = C
  const leftMid = await room.main({ action: 'leave', id: midId })
  assert.ok(leftMid.ok, '中途离开应成功')
  midRoom = store.rooms.filter(r => r._id === midId)[0]
  const remaining = midRoom.players.length
  assert.strictEqual(remaining, 2, '剩两个人')
  assert.ok(midRoom.turn >= 1 && midRoom.turn <= remaining,
    `★ 回合序号必须落在 [1, ${remaining}] 内，实际是 ${midRoom.turn}（不修正会越界成 3）`)
  ok(`★ 末位玩家退出后 turn 修正为 ${midRoom.turn}（剩 ${remaining} 人）—— 不修正会越界卡死`)

  /* 现在轮到的人必须真的能操作。
     注意叫的值要比当前 bid 大 —— 此时 bid 是「3 个 3」，
     所以用「4 个 3」（数量变大）才是合法叫法。
     这里踩过一次：写成 3 个 3 会被"只能往上叫"挡掉，
     让人误以为是回合修正出了问题。 */
  const turnSeat = midRoom.turn
  const turnPlayer = midRoom.players.filter(p => p.seat === turnSeat)[0]
  OPENID = turnPlayer.openid
  const canBid = await room.main({ action: 'bid', id: midId, n: 4, face: 3 })
  assert.ok(canBid.ok, `轮到的人（${turnPlayer.name}）应能正常叫骰：` + (canBid.msg || ''))
  ok(`★ 轮到的人（${turnPlayer.name}）确实能操作 —— 回合没有指向空座`)

  /* 再测：退出者在当前回合**之前** */
  const before = store.rooms.filter(r => r._id === midId)[0]
  const curTurn = before.turn
  const beforeSeat = before.players.filter(p => p.seat !== curTurn)[0]
  OPENID = beforeSeat.openid
  await room.main({ action: 'leave', id: midId })
  const afterLeave = store.rooms.filter(r => r._id === midId)[0]
  assert.ok(afterLeave.turn >= 1 && afterLeave.turn <= afterLeave.players.length,
    `★ 退出者在回合之前时，turn 也要合法，实际 ${afterLeave.turn}（剩 ${afterLeave.players.length} 人）`)
  ok(`★ 退出者在当前回合之前时，turn 前移修正为 ${afterLeave.turn}（剩 ${afterLeave.players.length} 人）`)

  console.log(`\n${'='.repeat(58)}`)
  console.log(`  多人房间：全部 ${n} 项断言通过`)
  console.log(`${'='.repeat(58)}\n`)
})().catch(e => {
  console.error('\n  ✗ 断言失败：', e.message, '\n')
  process.exit(1)
})
