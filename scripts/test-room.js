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
const fs = require('fs')
const path = require('path')
const Module = require('module')
const assert = require('assert')

const store = { rooms: [] }
let seq = 0
const nextId = () => 'r' + (++seq)

function neq(v) { return { __op: 'neq', v } }
function pushv(v) { return { __op: 'push', v } }
/* ★ 比较操作符：真实 SDK 有 _.lt / _.gt / _.lte / _.gte / _.and。
   业务代码用 _.lt 过滤"过期房间"（见 pickCode），
   所以 mock 必须支持 —— **在 mock 里补齐，不在业务代码里绕开**，
   否则测的就不是线上真正跑的那份代码。 */
function lt(v) { return { __op: 'lt', v } }
function gt(v) { return { __op: 'gt', v } }
function and(...args) { return { __op: 'and', v: args } }
const command = { neq, push: pushv, lt, gt, and }

/** 单条条件求值（供 and 递归） */
function one(doc, key, c) {
  if (c && c.__op === 'neq') return doc[key] !== c.v
  if (c && c.__op === 'lt') return Number(doc[key]) < Number(c.v)
  if (c && c.__op === 'gt') return Number(doc[key]) > Number(c.v)
  if (c && c.__op === 'and') {
    /* and([_.gt(a), _.lt(b)]) 或 and(_.gt(a), _.lt(b)) 都要支持 */
    const list = Array.isArray(c.v[0]) ? c.v[0] : c.v
    return list.every(x => one(doc, key, x))
  }
  if (Array.isArray(doc[key])) return doc[key].indexOf(c) >= 0
  return doc[key] === c
}

function match(doc, q) {
  return Object.keys(q).every(k => one(doc, k, q[k]))
}

function collection(name) {
  const rows = () => (store[name] = store[name] || [])
  return {
    where(q) {
      const cond = q
      return {
        _n: null, _o: [], _f: null,
        limit(n) { this._n = n; return this },
        orderBy(f, d) { this._o.push([f, d]); return this },
        /*
         * ★ `.field({code:true})` —— 真实 SDK 支持"只取某些字段"。
         *   第一版 mock 没实现它，于是 pickCode 报
         *   `rooms.where(...).field is not a function`。
         *   这类缺口必须在 mock 里补齐，**不能在业务代码里绕开** ——
         *   否则测的就不是线上真正跑的那份代码了。
         */
        field(f) { this._f = f; return this },
        async get() {
          let out = rows().filter(d => match(d, cond))
          if (this._n) out = out.slice(0, this._n)
          /* 深拷贝：真数据库每次 get 都是新对象，
             mock 若返回引用，update 会改到调用方手里的"快照" */
          out = JSON.parse(JSON.stringify(out))
          /* field 投影：只保留指定字段（+ _id，与真实行为一致） */
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
  /* ★ 2026-10-09 用户要求改成 3 位纯数字（原来 6 位 32 字符集） */
  assert.strictEqual(code.length, 3, '★ 房间码必须是 3 位')
  assert.ok(/^\d{3}$/.test(code), '★ 房间码必须是纯数字（原来含字母，念给对方容易听错）')
  assert.strictEqual(created.room.count, 1, '建房者自动在房里')
  assert.strictEqual(created.room.host, true, '建房者是房主')
  const roomId = created.room.id
  ok(`建房成功，房间码 ${code}（3 位纯数字，电话里念不会听错）`)

  /* 大小写与空格要能容错 —— 对方手输的 */
  OPENID = B
  /* 纯数字后不用管大小写，但仍要容错**空格和其他字符** —— 用户是手输的 */
  const joined = await room.main({ action: 'join', code: ' ' + code + ' ', name: '倩萍' })
  assert.ok(joined.ok, '带空格的房间码也应能加入')
  assert.strictEqual(joined.room.count, 2, '现在两个人')
  ok('★ 房间码空格容错（对方是手输的，不能苛刻）')

  OPENID = C
  const joined3 = await room.main({ action: 'join', code, name: '老王' })
  assert.strictEqual(joined3.room.count, 3, '第三个人也能进')
  assert.strictEqual(joined3.room.me.seat, 3, '座位顺延到 3')
  ok('3 个人也能进（不是只支持两人）')

  /*
   * 错误房间码 —— 纯数字后有**两种**错法，都要覆盖：
   *   ① 位数不对（含字母会被 normCode 滤掉 → 变成空串）
   *   ② 位数对但房间不存在
   * ⚠️ 原来只测了 'ZZZZZZ'，它在纯数字规则下被滤成空串，
   *    走的是"位数不对"分支、返回的 code 是 undefined，
   *    于是断言 `code === 'NO_ROOM'` 失败 —— 是**测试没跟上新契约**，不是代码错。
   */
  OPENID = 'oid_stranger'
  const badCode = await room.main({ action: 'join', code: 'ZZZ', name: '路人' })
  assert.strictEqual(badCode.ok, false, '字母房间号应被拒（滤完不足 3 位）')
  ok('含字母的房间号被拒：「' + badCode.msg + '」')

  const noSuch = await room.main({ action: 'join', code: '999', name: '路人' })
  assert.strictEqual(noSuch.ok, false)
  assert.strictEqual(noSuch.code, 'NO_ROOM', '位数对但不存在的号应报 NO_ROOM')
  ok('不存在但格式正确的房间号被拒：「' + noSuch.msg + '」')

  /* ============ ② ★ 命门：别人的骰子不能泄露 ============ */
  console.log('\n=== ② ★ 命门：开局后看不到别人的骰子 ===')
  OPENID = A
  const notHost = await room.main({ action: 'start', id: roomId })
  assert.ok(notHost.ok, '房主开局应成功')
  /* ★ 开局先进倒计时阶段（3 秒缓冲），不是直接 playing ——
     骰子已经生成好，但玩家还在看别人的名字、还没把手机放好。
     直接开局 = 有人错过第一轮叫骰。 */
  assert.strictEqual(notHost.room.phase, 'countdown', '★ 开局应进入 countdown 缓冲阶段')
  ok(`★ 开局先进倒计时（剩 ${Math.round(notHost.room.countdownMs)}ms）—— 不是直接开始`)
  /* 把倒计时拨到过去，模拟"3 秒已过" */
  store.rooms.filter(x => x._id === roomId)[0].countdownEnd = Date.now() - 100
  const advance = await room.main({ action: 'status', id: roomId })
  assert.strictEqual(advance.room.phase, 'playing', '★ 倒计时到点后应自动进入 playing')
  ok('★ 倒计时到点 → status 自动推进到 playing（云函数没定时器，靠轮询触发）')

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

  /* ============================================================
   * ⑨ ★★★ 3 位房间号：必须**不重复**（这是改短号码的代价所在）
   * ============================================================ */
  console.log('\n=== ⑨ ★★★ 3 位数字房间号：不能撞码 ===')
  /*
   * 2026-10-09 用户要求「房间号简单一点，纯数字即可，三个数」。
   *
   * ★ 为什么这条断言是**命门**：
   *   号码空间从 32^6（10.7 亿）掉到 1000。
   *   撞码的后果不是"重开一次"，而是**进错房间** ——
   *   join 里是 `where({code, active:true}).limit(1)` 取第一个匹配，
   *   两个活跃房间同号时，玩家会静默进到别人的房间去。
   *
   *   所以建号改成了**穷举去重**（pickCode：列出已占用的号，从空闲的里挑）。
   *   这条断言就是验证那个保证真的成立。
   *
   * ⚠️ 验证方式很关键：**必须建足够多的房间**。
   *   只建 2 个房间时，随机撞码概率约 0.1%，测了等于没测
   *   （这和"测试通过但测试没在工作"是同一类陷阱）。
   *   所以建 40 个 —— 如果是随机生成，撞码概率约 55%，早就该抓到了。
   */
  const CODES = []
  const N_ROOMS = 40
  for (let i = 0; i < N_ROOMS; i++) {
    OPENID = 'oid_code_' + i
    const r = await room.main({ action: 'create', name: 'C' + i, game: 'dice' })
    assert.ok(r.ok, `第 ${i + 1} 个房间应能建：` + (r.msg || ''))
    CODES.push(r.room.code)
  }
  const uniq = new Set(CODES)
  assert.strictEqual(uniq.size, CODES.length,
    `★ 建了 ${N_ROOMS} 个房间出现撞码：` +
    CODES.filter((c, i) => CODES.indexOf(c) !== i).join(',') +
    '\n    撞码会导致**进错房间**（join 取第一个匹配），必须穷举去重而不是随机重试')
  ok(`★ ${N_ROOMS} 个房间的号码互不相同（穷举去重生效，不是靠概率）`)

  /* 号码必须都在 000~999 且是 3 位（含前导零） */
  const badFmt = CODES.filter(c => !/^\d{3}$/.test(c))
  assert.deepStrictEqual(badFmt, [],
    '这些号码格式不对（应形如 007）：\n    ' + badFmt.join('\n    '))
  ok('全部号码都是 3 位纯数字（含前导零，如 007）')

  /* 号码要分散：不能总从 000 开始（随机起点是为了这个） */
  const zeros = CODES.filter(c => c === '000').length
  assert.ok(zeros <= 1, '000 不该被反复发出去（随机起点失效了？）')
  ok('号码分布分散（不是每次都从 000 开始发）')

  /*
   * ★★★ 号码回收：判据必须**二值**（2026-10-09 修的真实缺陷）
   *
   * 缺陷：`active` 永远不会被置回 false —— 全项目只有一处设它（房主主动解散）。
   * 玩家直接退出去、或关掉小程序，房间就一直挂着 active:true。
   * 老写法 `where({active:true})` 把**过期房间的号码也算占用**，
   * 而 3 位只有 1000 个 → **号码池只减不增**：
   *   每天 10 局 → 100 天后**永久**报「房间号用满了」
   *   （"等一会儿再开"永远不会好，没有任何机制回收）
   *
   * 修法：pickCode 的 where 加 `updatedAt: _.gt(now - TTL)`，只统计未过期房间。
   * 依据：loadRoom / join 里都有 isStale → 拒绝，**过期房间本来就谁也进不去**。
   *
   * ⚠️⚠️ 判据设计踩了两次坑，记下来：
   *   第一版「建 12 个房间，看能否撞回被释放的号」—— 单个号命中概率 12/1000 ≈ 1.2%，
   *     **测了等于没测**（跑起来报失败，我一度以为是代码错）。
   *   第二版「999 个过期房占位，断言新房必拿 000」—— 前提就错了：
   *     修复**正是要让过期房不占号**，所以任何号都可能被拿到。
   *   → 正确判据是**两个方向各测一次**，都是二值、不依赖随机：
   *      A. 1000 个号全被**过期**房占着 → 必须**能**建房（回收生效）
   *      B. 1000 个号全被**未过期**房占着 → 必须**不能**建房（占用生效，防过度修复）
   */
  {
    const snapshot = JSON.parse(JSON.stringify(store.rooms))
    const mkFake = (n, updatedAt) => {
      store.rooms.length = 0
      for (let i = 0; i < n; i++) {
        store.rooms.push({
          _id: 'fake_' + i, code: String(i).padStart(3, '0'),
          active: true, updatedAt: updatedAt,
          players: [], phase: 'lobby', game: 'dice', hostOpenid: 'x'
        })
      }
    }
    const OLD = Date.now() - 3 * 3600 * 1000   // 3 小时前 → 超过 2 小时 TTL
    OPENID = 'oid_reclaim'

    try {
      /* ---- A. 1000 个号全被「过期」房占着 → 必须能建房 ---- */
      mkFake(1000, OLD)
      const a = await room.main({ action: 'create', name: 'A', game: 'dice' })
      assert.ok(a.ok,
        '★ 1000 个号全被**过期**房间占着时，仍应能建房 —— ' +
        '过期房间谁也进不去（loadRoom / join 都有 isStale → 拒绝），不该占号。\n' +
        '    实际报错：' + (a.msg || '(无)') + '\n' +
        '    老代码 `where({active:true})` 把过期房算作占用 → 号码池只减不增，\n' +
        '    1000 个号用完后**永久**报「房间号用满了」。')
      ok('★ 过期房间的号码会被回收（1000 个过期房占满时仍能建房）')

      /* ---- B. 1000 个号全被「未过期」房占着 → 必须不能建房 ---- */
      mkFake(1000, Date.now())
      const b = await room.main({ action: 'create', name: 'B', game: 'dice' })
      assert.ok(!b.ok,
        '★ 1000 个号被**未过期**房间占满时，必须明确拒绝 —— ' +
        '否则会发出重复号码，玩家 join 时**进错房间**（取第一个匹配）。\n' +
        '    实际却建成功了，拿到号码：' + (b.room && b.room.code))
      assert.ok(/用满/.test(b.msg || ''),
        '号用满时提示应说清原因，实际：' + (b.msg || '(无)'))
      ok('★ 未过期房间的号码确实占位（占满时明确拒绝，不会发重复号）')
    } finally {
      store.rooms.length = 0
      snapshot.forEach(r => store.rooms.push(r))
    }
  }

  /* 清理这批测试房间，别影响后面的断言 */
  for (let i = 0; i < N_ROOMS; i++) {
    OPENID = 'oid_code_' + i
    await room.main({ action: 'leave', id: store.rooms.filter(x => x.code === CODES[i])[0]._id }).catch(() => {})
  }

  /* ============ ⑦b 摇过不能重摇（后端必须拦，不能只靠前端藏按钮） ============ */
  /*
   * 2026-10-28 补。前端摇完会把"摇盅"藏起来，但云函数是公开接口 ——
   * 再调一次就会**覆盖同一个人的骰子**。这和"偷看过的骰子突然变了"是同一类事故：
   * 玩家不会觉得是 bug，会觉得 App 在作弊。
   */
  {
    OPENID = A
    const rr = await room.main({ action: 'create', name: 'R1', game: 'dice' })
    const rrId = rr.room.id
    OPENID = 'oid_r2'
    await room.main({ action: 'join', code: rr.room.code, name: 'R2' })
    OPENID = A
    await room.main({ action: 'start', id: rrId })
    store.rooms.filter(x => x._id === rrId)[0].countdownEnd = Date.now() - 100
    await room.main({ action: 'status', id: rrId })

    const first = await room.main({ action: 'roll', id: rrId })
    assert.ok(first.ok, '首次摇骰应成功')
    const dice1 = JSON.stringify((first.room.me.dice || []).slice())

    const again = await room.main({ action: 'roll', id: rrId })
    assert.strictEqual(again.ok, false, '★ 摇过之后不能再摇（后端必须拦）')
    assert.ok(/摇过/.test(again.msg || ''), '提示要说清"已经摇过了"，实际：' + (again.msg || ''))

    /* 再读一次，确认点数**没被覆盖** */
    const after = await room.main({ action: 'status', id: rrId })
    assert.strictEqual(JSON.stringify((after.room.me.dice || []).slice()), dice1,
      '★ 被拒的那次不能改动骰子（否则玩家看到点数变了）')
    ok('★ 摇过不能重摇，且被拒时点数不变')
  }

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

  /*
   * ★★ 并发加入不能丢人（2026-10-09 修的真实竞态）
   *
   * 老写法是「读 room → 拼新数组 → **整数组写回**」。读和写之间有窗口：
   * 两个人同时点「进去」，双方都读到同样的列表、都算出同一个 seat，
   * 然后**后写的覆盖先写的** —— 只进来一个人，另一个**静默消失**
   * （他的请求还返回 ok:true，界面上却不在房间里）。
   *
   * 修法：改用 `_.push`（数据库端原子追加），追加后重读并统一重编号座位。
   *
   * ⚠️ 判据必须真的并发：串行 join 永远测不出这个 bug。
   *    这里让两个 join 的 Promise **同时发出**，靠 mock 的深拷贝
   *    复现"两边读到同一份快照"的交错。
   */
  OPENID = A
  const race = await room.main({ action: 'create', name: 'Race', game: 'dice' })
  const raceCode = race.room.code
  const raceId = race.room.id

  OPENID = 'oid_race_1'
  const p1 = room.main({ action: 'join', code: raceCode, name: 'R1' })
  OPENID = 'oid_race_2'
  const p2 = room.main({ action: 'join', code: raceCode, name: 'R2' })
  const [r1, r2] = await Promise.all([p1, p2])

  assert.ok(r1.ok && r2.ok, '两人都应加入成功')
  /* 直接看内存里房间的真实成员：必须三个人（房主 + 两个）都在 */
  const raceDoc = store.rooms.filter(x => x._id === raceId)[0]
  const raceNames = (raceDoc.players || []).map(p => p.name).sort()
  assert.deepStrictEqual(raceNames, ['R1', 'R2', 'Race'],
    '★ 并发加入丢了人 —— 两人同时 join 时后写的覆盖了先写的。\n' +
    '    实际房间成员：' + raceNames.join(',') + '（期望 Race, R1, R2）\n' +
    '    修法：用 _.push 原子追加，不要整数组覆盖写')

  /* 座位必须 1..N 连续且唯一 —— 重复 seat 会让"轮到谁"永远找不到人 */
  const raceSeats = (raceDoc.players || []).map(p => p.seat).sort((a, b) => a - b)
  assert.deepStrictEqual(raceSeats, [1, 2, 3],
    '★ 并发加入后座位不是 1..N 连续唯一：' + JSON.stringify(raceSeats) +
    '\n    turn 是按 seat 找人的（players.filter(p => p.seat === turn)），' +
    '座位重复 → 回合永远轮不到其中一个 → 游戏卡死且不报错')
  ok('★ 并发加入不丢人，且座位重编号为 1..N 连续唯一')

  /* ============ ⑧b 叫骰参数必须校验「整数」而不只是范围 ============ */
  console.log('\n=== ⑧b 叫骰：小数 / NaN 必须被拒 ===')
  /*
   * ★ 2026-10-09 安全审计发现：`!(n >= 1 && n <= max)` 这种范围判断
   *   **挡不住小数** —— 2.5 落在 [1,10] 内，会直接落库。
   *
   *   后果不是"数据难看"，而是**玩法被破坏**：
   *   开骰时按 face 精确匹配数骰子（`dice.filter(d => d === face)`），
   *   face=3.7 永远命中 0 颗 → 无论实际有没有 3 点，
   *   判定都是"叫的人输了"→ 谁叫谁输，一局直接废掉。
   *
   * ⚠️ 顺带澄清一个审计报告的误判：`NaN` 其实**会**被范围判断拦住
   *    （`NaN >= 1` 为 false）—— 真实缺口只有小数。
   *    断言把两种都覆盖上，但注释要写对，否则下次会照着错的前提去改。
   */
  {
    OPENID = A
    const lr = await room.main({ action: 'create', name: 'L', game: 'liar' })
    OPENID = B
    await room.main({ action: 'join', code: lr.room.code, name: 'LB' })
    OPENID = A
    const started = await room.main({ action: 'start', id: lr.room.id })
    assert.strictEqual(started.room.phase, 'countdown', 'start 之后应进倒计时')
    /* 把倒计时拨到过去 —— status 会据此推进到 playing（与文件里其它用例同法） */
    store.rooms.filter(x => x._id === lr.room.id)[0].countdownEnd = Date.now() - 100
    const st = await room.main({ action: 'status', id: lr.room.id })
    assert.strictEqual(st.room.phase, 'playing', '倒计时应已结束')

    for (const [n, face, why] of [
      [2.5, 3, '小数数量'],
      [2, 3.7, '小数点数'],
      [NaN, 3, 'NaN 数量'],
      [2, NaN, 'NaN 点数']
    ]) {
      const r = await room.main({ action: 'bid', id: lr.room.id, n: n, face: face })
      assert.strictEqual(r.ok, false,
        `★ ${why} 竟然被接受了（n=${n} face=${face}）—— ` +
        '范围判断挡不住小数，必须用 Number.isInteger')
    }
    ok('小数 / NaN 的叫骰参数全部被拒（整数校验生效）')

    /* 合法的一叫必须仍然能过 —— 别把功能一起拦死了 */
    const good = await room.main({ action: 'bid', id: lr.room.id, n: 2, face: 3 })
    assert.ok(good.ok, '合法叫骰应能通过：' + (good.msg || ''))
    ok('合法叫骰（2个3）仍然通过')
  }

  /* ============ ⑧c 号码被回收后，按 code 必须进新房间 ============ */
  console.log('\n=== ⑧c 号码回收后：按 code 必须命中新房间，不能命中过期老房间 ===')
  /*
   * ★★ 这是「号码回收」修复**自己引入的回归**（2026-10-09 发现）。
   *
   * pickCode 现在会把过期房间的号码回收给新房间（这是对的）。
   * 但过期的老房间**文档还在、active 仍是 true**，于是「按 code 查」会同时
   * 匹配到两条：老房间（号码被回收、自己已过期）和新房间（刚拿到号，正常）。
   * `limit(1)` 取第一个 —— 命中老房间 → isStale 拒绝 →
   * **玩家看到「这个房间已经过期了」，可新房间明明好好的**。
   *
   * 判据必须构造出「两条同号」的真实状态，否则测不出：
   *   ① 建一个房间，记下号码
   *   ② 把它的 updatedAt 拨到 3 个 TTL 之前（模拟过期）
   *   ③ 再建房 —— pickCode 会把这个号回收出去
   *   ④ 按这个号 join —— 必须进**新房间**
   */
  {
    const snapshot = JSON.parse(JSON.stringify(store.rooms))
    try {
      store.rooms.length = 0
      const TTL = 2 * 3600 * 1000

      OPENID = 'oid_rec_old'
      const oldR = await room.main({ action: 'create', name: '老房主', game: 'dice' })
      const RECODE = oldR.room.code
      const oldId = oldR.room.id
      /* 变老 —— 只改 updatedAt，active 保持 true（这正是真实状态） */
      store.rooms.filter(x => x._id === oldId)[0].updatedAt = Date.now() - 3 * TTL

      /* 再建，直到拿到那个被回收的号（pickCode 随机起点，要试几次） */
      let newId = null
      for (let i = 0; i < 1200 && !newId; i++) {
        OPENID = 'oid_rec_new_' + i
        const r = await room.main({ action: 'create', name: '新房主', game: 'dice' })
        if (!r.ok) break
        if (r.room.code === RECODE) newId = r.room.id
      }
      assert.ok(newId, '号码没有被回收（pickCode 的时间下界失效了？）')

      /* ★ 关键判据：按这个号加入，必须进新房间 */
      OPENID = 'oid_rec_joiner'
      const j = await room.main({ action: 'join', code: RECODE, name: '进来的人' })
      assert.ok(j.ok,
        '★ 号码被回收后，按 code ' + RECODE + ' 加入失败：「' + (j.msg || '') + '」\n' +
        '    过期的老房间 active 仍是 true，where({code, active:true}).limit(1) ' +
        '可能命中它 → isStale 拒绝 → 玩家被告知"已过期"，而新房间明明可用。\n' +
        '    修法：按 code 查询也要带上 updatedAt 时间下界（与 pickCode 同一判据）')
      assert.strictEqual(j.room.id, newId,
        '★ 按 code 进到了**老房间**而不是新房间\n' +
        '    期望 = ' + newId + '  实际 = ' + j.room.id)
      ok('★ 号码被回收后，按 code 进的是新房间（不会命中过期的老房间）')

      /* 反例：只有同号过期房、没有新房 → 提示应说"已过期"而不是"没找到" */
      store.rooms.length = 0
      store.rooms.push({
        _id: 'only_stale', code: '099', game: 'dice', phase: 'lobby',
        hostOpenid: 'h', active: true,
        createdAt: Date.now() - 3 * TTL, updatedAt: Date.now() - 3 * TTL,
        players: [], turn: 0, round: 0, bid: null
      })
      OPENID = 'oid_rec_j2'
      const j2 = await room.main({ action: 'join', code: '099', name: 'x' })
      assert.strictEqual(j2.ok, false)
      assert.strictEqual(j2.code, 'STALE',
        '★ 拿着一个"只是过期了"的号码进来，应提示「已过期」而不是「没找到」\n' +
        '    实际：' + j2.code + ' / ' + j2.msg + '\n' +
        '    房间号没错，说"没找到"会让用户反复核对一个正确的号码')
      ok('只有过期房时，提示是「已过期」而不是「没找到」（语义没退化）')
    } finally {
      store.rooms.length = 0
      snapshot.forEach(r => store.rooms.push(r))
    }
  }

  /* ============ ⑧d 换玩法：清局内状态 + 只在大厅能换 ============ */
  console.log('\n=== ⑧d 换玩法（同一房间不换号）===')
  /*
   * ★ 需求原话：「同一房间内换玩法」。
   *   改造前 game 是建房时定死的，玩腻了只能**重新开一个房**（房间号变了、
   *   要重新发一遍给所有人）。
   *
   * ★★ 关键设计：`again` 与 `game` **合并成同一个服务端入口** ——
   *   两者本质都是"清局内状态 → 回 lobby"，只差改不改 game。
   *   拆成两份清理就会漏字段，而且不报错（本项目栽过两次同类）。
   *   所以断言要验的是「**清得干净**」，不只是「能换」。
   */
  {
    const snapshot = JSON.parse(JSON.stringify(store.rooms))
    try {
      store.rooms.length = 0
      OPENID = A
      const mk = await room.main({ action: 'create', name: 'PA', game: 'liar' })
      const GID = mk.room.id
      OPENID = B
      await room.main({ action: 'join', code: mk.room.code, name: 'PB' })
      OPENID = A
      await room.main({ action: 'start', id: GID })
      store.rooms.filter(x => x._id === GID)[0].countdownEnd = Date.now() - 100
      await room.main({ action: 'status', id: GID })

      /* 造一点"局内状态"，这样才测得出"清干净了" */
      await room.main({ action: 'bid', id: GID, n: 2, face: 3 })
      const dirty = store.rooms.filter(x => x._id === GID)[0]
      dirty.spin = { k: 'truth', t: '真心话', at: Date.now() }
      assert.ok(dirty.bid, '前置：应有一条叫骰')
      assert.ok(dirty.spin, '前置：应有一个转盘结果')

      /* ---- ① 非房主不能换 ---- */
      OPENID = B
      const nope = await room.main({ action: 'game', id: GID, game: 'wheel' })
      assert.strictEqual(nope.ok, false, '★ 非房主竟然能换玩法')
      assert.ok(/房主/.test(nope.msg), '提示应说清是权限问题：' + nope.msg)

      /* ---- ② 玩到一半不能换 ---- */
      OPENID = A
      const mid = await room.main({ action: 'game', id: GID, game: 'wheel' })
      assert.strictEqual(mid.ok, false,
        '★ 正在玩的时候竟然能换玩法 —— 已经摇过的骰子会失去意义')
      assert.ok(/玩完/.test(mid.msg), '提示应说清"玩完再换"：' + mid.msg)

      /* ---- ③ 回大厅后能换，且局内状态清干净 ---- */
      await room.main({ action: 'again', id: GID })          // 回大厅
      const sw = await room.main({ action: 'game', id: GID, game: 'wheel', deck: 'family' })
      assert.ok(sw.ok, '回大厅后应能换玩法：' + (sw.msg || ''))
      assert.strictEqual(sw.game, 'wheel', '换完应报告新玩法')
      assert.strictEqual(sw.room.game, 'wheel', '房间的 game 应已改')
      assert.strictEqual(sw.room.deck, 'family', '顺便带的题卡场合也应生效')
      assert.strictEqual(sw.room.phase, 'lobby', '换完应回到大厅')

      /* ★ 清得干净：这四个字段任一残留都会让新玩法看到旧状态 */
      assert.strictEqual(sw.room.bid, null, '★ 旧叫骰没清 —— 换到转盘后还显示着上一局的叫骰')
      assert.strictEqual(sw.room.lastResult, null, '★ 旧结算没清')
      assert.strictEqual(sw.room.spin, null, '★ 旧转盘结果没清 —— 屏幕会留着上一轮的扇区')
      assert.strictEqual(sw.room.turn, 0, '★ 回合序号没清')
      const after = store.rooms.filter(x => x._id === GID)[0]
      assert.ok((after.players || []).every(p => (p.dice || []).length === 0),
        '★ 有人还留着骰子 —— 换玩法后新一局会带着旧点数')
      assert.strictEqual(after.players.length, 2, '★ 人应该全留下（换玩法不是重开房）')
      ok('★ 换玩法：只在大厅能换、只有房主能换，且局内状态清得干净')

      /* ---- ④ 无效玩法要拒绝，不能静默改成别的 ---- */
      const bad = await room.main({ action: 'game', id: GID, game: '麻将' })
      assert.strictEqual(bad.ok, false, '★ 无效玩法竟然被接受了')
      assert.strictEqual(store.rooms.filter(x => x._id === GID)[0].game, 'wheel',
        '★ 无效玩法把房间改坏了 —— 应保持原样')
      ok('无效玩法被拒，且不会把房间改成别的（房主以为换了、其实没换更糟）')

      /* ---- ⑤ 房间号不变（这正是这个功能的意义）---- */
      assert.strictEqual(sw.room.code, mk.room.code, '★ 房间号变了 —— 那还不如重新开房')
      ok('换玩法后房间号不变（不用重新发给所有人）')
    } finally {
      store.rooms.length = 0
      snapshot.forEach(r => store.rooms.push(r))
    }
  }

  /* ============ ⑨ 开局前不能操作 ============ */
  console.log('\n=== ⑨ 大厅阶段不能叫骰 ===')
  OPENID = A
  const notStarted = await room.main({ action: 'bid', id: rid2, n: 2, face: 2 })
  assert.strictEqual(notStarted.ok, false)
  assert.ok(/还没开始/.test(notStarted.msg))
  ok('开局前叫骰被拒：「' + notStarted.msg + '」')

  /*
   * ★ 2026-10-10 用户要求改为**允许单人开局**：
   *   「能否一个人也能开房间进去…现在为两人以上才能玩游戏我不好调试」
   *
   * ⚠️ 单人开局**必须用独立房间**测 —— 第一版直接对 rid2 开局，
   *    而 rid2 后面的⑩要"再加一个人进来"，房间已在 countdown → join 被拒
   *    → 连锁失败。**测试也要遵守"一个用例只改变它自己需要改变的状态"。**
   */
  OPENID = A
  const soloRoom = await room.main({ action: 'create', name: 'SOLO', game: 'liar' })
  assert.ok(soloRoom.ok, '前置：单人房应能创建')

  /*
   * ★★ 2026-10-28 改了这里的语义，两件事都要锁：
   *
   *   ① **不传 solo** → 必须被拒，而且要说清还差几个人。
   *      （改造前服务端只查"房间不是空的"，人数下限只有前端在拦 ——
   *       两边判据不一致：前端挡着的时候服务端其实早就放行了。）
   *   ② **传 solo: true**（测试开关，config.js 的 soloTest）→ 一个人也能开。
   *      验收要跑遍 5 个玩法，每个都要求 2~3 人，没有这个开关每验一屏都要
   *      拉两台手机。
   */
  const soloDenied = await room.main({ action: 'start', id: soloRoom.room.id })
  assert.strictEqual(soloDenied.ok, false, '★ 不传 solo 时，人数不足必须被拒（服务端是唯一判据）')
  assert.ok(/还差|要 \d+ 个人/.test(soloDenied.msg || ''),
    '拒绝时要说清还差几个人，实际：' + (soloDenied.msg || ''))

  const soloStart = await room.main({ action: 'start', id: soloRoom.room.id, solo: true })
  assert.strictEqual(soloStart.ok, true, '★ 带 solo 开关时单人应该能开局（测试期便于验证）')
  assert.strictEqual(soloStart.room.phase, 'countdown', '单人开局应进入倒计时')
  ok('单人开局：不传开关会被拒并说清差几人；传 solo 可开（测试开关）')

  /* ============ ⑨b 中途加入：只观战，下一局参与 ============ */
  console.log('\n=== ⑨b 中途加入（下一局才参与）===')
  /*
   * ★ 用户要求：「中途别人也能加入房间」。
   *
   * ★★ 但不能只删掉 `phase !== 'lobby'` 那一行 —— 会引入三个更糟的问题：
   *   ① 座位重编号把正在玩的人**座位平移** → 回合错乱
   *   ② `every(dice.length>0)` 把观战者算进去 → **本局永远结束不了**
   *   ③ 回合轮转停在观战者身上 → **卡死**
   *   所以引入 inRound：中途进来 = false（观战），开新一局时统一置回 true。
   *
   * 这一组断言就是锁这三个坑 + "下一局自动参与"的兑现。
   */
  {
    const snapshot = JSON.parse(JSON.stringify(store.rooms))
    try {
      store.rooms.length = 0
      OPENID = A
      const mk = await room.main({ action: 'create', name: 'RA', game: 'dice' })
      const MID = mk.room.id
      const MIDCODE = mk.room.code
      OPENID = B
      await room.main({ action: 'join', code: MIDCODE, name: 'RB' })
      OPENID = A
      await room.main({ action: 'start', id: MID })
      store.rooms.filter(x => x._id === MID)[0].countdownEnd = Date.now() - 100
      await room.main({ action: 'status', id: MID })

      const before = store.rooms.filter(x => x._id === MID)[0]
      const seatsBefore = before.players.map(p => p.seat).sort().join(',')

      /* ---- ① 中途加入应该成功（不再是"这局已经开始了"）---- */
      OPENID = 'C'
      const midJoin = await room.main({ action: 'join', code: MIDCODE, name: 'RC' })
      assert.ok(midJoin.ok, '★ 中途加入应被允许，实际：' + (midJoin.msg || ''))
      const after = store.rooms.filter(x => x._id === MID)[0]
      const C = after.players.filter(p => p.openid === 'C')[0]
      assert.ok(C, '中途加入的人应在 players 里')
      assert.strictEqual(C.inRound, false, '★ 中途加入者必须 inRound=false（只观战）')
      ok('中途加入成功，且标记为"本局观战"')

      /* ---- ② ★ 已有座位不能变（否则轮到 seat2 的人会被顶掉）----
       *
       * ⚠️ 这条断言我写错了两版，都是**判据太弱、反向验证时漏报**：
       *    v1 直接比对"已有人的座位集合" —— 在"新人排末尾"这个场景下，
       *       整队重编号（1,2,3）和"只给新人末尾号"结果**完全一样**，测不出。
       *    v2 把数组顺序颠倒后重试 —— 仍漏报（比对集合的取法不对）。
       *
       * ★ v3 用**逐人比对**，且用已被独立复现验证过的路径：
       *   先记下每个人的 (openid → seat)，打乱数组顺序，再让人中途加入，
       *   然后逐人核对"有没有人的座位被改"。
       *   实测：改坏后 B 从 seat2→1、A 从 seat1→2，v3 能抓到。
       */
      const doc2 = store.rooms.filter(x => x._id === MID)[0]
      /* 打乱数组顺序但不动座位号 —— 逼出"按数组顺序重编号"的实现缺陷 */
      doc2.players = doc2.players.slice().reverse()
      const seatMap = {}
      doc2.players.forEach(p => { seatMap[p.openid] = p.seat })

      /*
       * ⚠️⚠️ 这里必须用**全新的 openid**（'C2'），不能用 'C'。
       *
       * 前两版断言漏报的真因就在这：'C' 已经加入过了，
       * 再次 join 会命中的是「已在房里 → 只刷心跳」那条分支，
       * **根本不进座位重编号代码** —— 于是好实现和坏实现的结果一模一样，
       * 断言无论在哪种实现下都通过（= 废的）。
       *
       * ★ 教训：断言"测不出坏实现"时，先确认**它有没有真的触发目标代码路径**，
       *   而不是继续加强判据。判据再强，路径没走到也是白搭。
       */
      OPENID = 'C2'
      const midJoin2 = await room.main({ action: 'join', code: MIDCODE, name: 'RC4' })
      assert.ok(midJoin2.ok, '第三人中途加入也应成功：' + (midJoin2.msg || ''))

      const after3 = store.rooms.filter(x => x._id === MID)[0]
      const moved = after3.players
        .filter(p => seatMap[p.openid] !== undefined && p.seat !== seatMap[p.openid])
        .map(p => p.openid + ' ' + seatMap[p.openid] + '→' + p.seat)
      assert.deepStrictEqual(moved, [],
        '★ 中途加入改动了已有座位（' + moved.join('、') + '）—— ' +
        '数组顺序被打乱时，"按顺序整队重编号"会移动正在玩的人的座位 → 回合错乱')
      ok('中途加入不改动已有座位（逐人核对，打乱顺序也测得出）')

      /* ---- ③ ★ 观战者拖不住本局：全员摇完仍能判结束 ---- */
      OPENID = A
      await room.main({ action: 'roll', id: MID })
      OPENID = B
      await room.main({ action: 'roll', id: MID })
      const done = store.rooms.filter(x => x._id === MID)[0]
      assert.strictEqual(done.phase, 'over',
        '★ 观战者没摇骰子，导致本局结束不了（phase=' + done.phase + '）—— ' +
        '判"全员摇完"时必须只算 inRound 的人')
      ok('观战者不参与"全员摇完"判定，本局能正常结束')

      /* ---- ④ 观战者不能叫骰（且要有明确提示）---- */
      OPENID = 'C'
      const cBid = await room.main({ action: 'bid', id: MID, n: 2, face: 3 })
      assert.strictEqual(cBid.ok, false, '★ 观战者不该能操作')
      assert.ok(/下一局|中途/.test(cBid.msg), '提示应说清"下一局才能玩"：' + cBid.msg)
      ok('观战者被拒且提示明确：「' + cBid.msg + '」')

      /* ---- ⑤ ★ 开新一局必须把观战者纳入（否则他永远观战）---- */
      OPENID = A
      const nl = await room.main({ action: 'again', id: MID })
      assert.ok(nl.ok, '房主应能开新一局')
      const C2 = (store.rooms.filter(x => x._id === MID)[0].players || []).filter(p => p.openid === 'C')[0]
      assert.strictEqual(C2.inRound, true,
        '★ 开新一局后观战者仍是 inRound=false —— 他会永远观战下去（且不报错）')
      ok('开新一局后观战者自动纳入（inRound 置回 true）')
    } finally {
      store.rooms.length = 0
      snapshot.forEach(r => store.rooms.push(r))
    }
  }

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
  /* 开局先进倒计时；拨到过去再读状态，触发自动推进 */
  store.rooms.filter(x => x._id === rid2)[0].countdownEnd = Date.now() - 100
  await room.main({ action: 'status', id: rid2 })

  const rolled = await room.main({ action: 'status', id: rid2 })
  assert.strictEqual(rolled.room.phase, 'playing', '倒计时过后 playing')
  /*
   * ★ 摇骰子比大小：开局**不发**骰子，谁摇谁生成（2026-10-08 修）。
   *   原来开局就给所有人预生成，导致「等其他人摇」形同虚设。
   *   所以这里断言的是"开局时没有、摇完才有"。
   */
  assert.strictEqual((rolled.room.me.dice || []).length, 0,
    '★ 摇骰子开局不该发骰子（必须等玩家自己摇）')
  const afterRoll = await room.main({ action: 'roll', id: rid2 })
  assert.ok(afterRoll.ok, '摇应成功：' + (afterRoll.msg || ''))
  assert.ok((afterRoll.room.me.dice || []).length > 0, '摇完才有骰子')
  ok('★ 摇骰子：开局无骰子 → 自己摇完才有（等别人摇是真的要等）')

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
  /* 跳过倒计时（拨到过去，下次 status 会自动推进） */
  store.rooms.filter(x => x._id === midId)[0].countdownEnd = Date.now() - 100
  await room.main({ action: 'status', id: midId })
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

  /* ============================================================
   * ⑫ 命运转盘（联机）—— 2.6.0 新增
   * ============================================================ */
  console.log('\n=== ⑫ ★ 转盘：只有房主能转，结果由服务端定 ===')
  OPENID = A
  const wh = await room.main({ action: 'create', name: 'W1', game: 'wheel' })
  const whId = wh.room.id
  const whCode = wh.room.code
  OPENID = B
  await room.main({ action: 'join', code: whCode, name: 'W2' })

  OPENID = A
  await room.main({ action: 'start', id: whId })
  store.rooms.filter(x => x._id === whId)[0].countdownEnd = Date.now() - 100
  await room.main({ action: 'status', id: whId })

  /*
   * ★ 命门：只有房主能转。
   *
   * 为什么结果必须服务端定：单机版可以本地随机（大家看同一块屏幕），
   * 联机版如果让房主前端算，房主就能改结果（"我要真心话"）。
   * 这条锁的是"房主独占"这个权限边界 ——
   * 漏了它，非房主也能点，或者房主能直接指定扇区。
   */
  OPENID = B
  const spinByOther = await room.main({ action: 'spin', id: whId })
  assert.ok(!spinByOther.ok, '★ 非房主不能转 —— 否则谁都能改结果')
  ok('非房主转不了（' + (spinByOther.msg || '') + '）')

  OPENID = A
  const spin1 = await room.main({ action: 'spin', id: whId })
  assert.ok(spin1.ok, '房主应该能转')
  assert.ok(spin1.spin, '必须返回 spin 结果')
  assert.ok(typeof spin1.spin.index === 'number', 'spin.index 必须是数字（前端要用它算角度）')
  assert.ok(spin1.spin.t, 'spin.t 是扇区文案（前端显示用）')
  assert.ok(spin1.spin.at > 0, 'spin.at 是时间戳（前端靠它判断"这一转是新的"）')
  assert.ok(spin1.spin.turns >= 4, '转的圈数至少 4 圈，否则不够爽')
  ok(`房主转出「${spin1.spin.t}」（第 ${spin1.spin.index} 个扇区，转 ${spin1.spin.turns} 圈）`)

  /* 从云函数源码里抽出扇区表，用来核对下标和文案自洽 */
  const backSecs = (function () {
    const src = require('fs').readFileSync(
      require('path').join(__dirname, '..', 'cloudfunctions/room/index.js'), 'utf8')
    const i = src.indexOf('const WHEEL_SECTORS = [')
    const s = src.indexOf('[', i)
    let d = 0, e = -1
    for (let k = s; k < src.length; k++) {
      if (src[k] === '[') d++
      else if (src[k] === ']') { d--; if (d === 0) { e = k; break } }
    }
    return eval('(' + src.slice(s, e + 1) + ')')
  })()
  assert.ok(spin1.spin.index >= 0 && spin1.spin.index < backSecs.length,
    `★ 扇区下标越界：${spin1.spin.index} 不在 [0, ${backSecs.length - 1}] 内`)
  ok('扇区下标在合法范围内（越界会让前端拿不到扇区、转盘乱停）')

  /* 转出来的文案必须和下标对得上（防止 index 和 t 对不上） */
  assert.strictEqual(spin1.spin.t, backSecs[spin1.spin.index].t,
    '★ spin.t 必须与 spin.index 指向的扇区一致')
  assert.strictEqual(spin1.spin.k, backSecs[spin1.spin.index].k,
    '★ spin.k 必须与 spin.index 指向的扇区一致')
  ok('spin 的 index / k / t 三者自洽（不会出现"指着 A 说是 B"）')

  /* 别人（非房主）也要能在 status 里看到这一转 —— 否则其他人不知道转了 */
  OPENID = B
  const seen = await room.main({ action: 'status', id: whId })
  assert.ok(seen.ok && seen.room.spin, '★ 非房主必须能在 status 里看到这一转')
  assert.strictEqual(seen.room.spin.at, spin1.spin.at,
    '★ 别人看到的必须是同一转（at 相同），否则各自转各自的')
  ok('非房主能看到同一转（at 一致）—— 全场同步')

  /* 转盘房间不该发骰子（发了会白白增加响应体积，前端也可能误用） */
  const whPlayers = seen.room.players || []
  const anyDice = whPlayers.some(p => (p.diceCount || 0) > 0)
  assert.ok(!anyDice, '★ 转盘房间不该给任何人发骰子')
  ok('转盘房间没有发骰子（不浪费响应体积）')

  /* 重开一局必须清掉上一转 —— 否则前端一进 playing 就以为已经转过了 */
  OPENID = A
  await room.main({ action: 'again', id: whId })
  await room.main({ action: 'start', id: whId })
  const fresh = store.rooms.filter(x => x._id === whId)[0]
  assert.ok(!fresh.spin, '★ 新一局必须清空 spin（否则一进 playing 就显示上一转的结果）')
  ok('新一局清空了 spin（不会把上一转的结果带进来）')

  /* 非转盘房间不能调 spin */
  OPENID = A
  const notWheel = await room.main({ action: 'create', name: 'L1', game: 'liar' })
  const nwId = notWheel.room.id
  OPENID = B
  await room.main({ action: 'join', code: notWheel.room.code, name: 'L2' })
  OPENID = A
  await room.main({ action: 'start', id: nwId })
  store.rooms.filter(x => x._id === nwId)[0].countdownEnd = Date.now() - 100
  await room.main({ action: 'status', id: nwId })
  const wrongGame = await room.main({ action: 'spin', id: nwId })
  assert.ok(!wrongGame.ok, '★ 大话骰房间不该能转盘')
  ok('大话骰房间调 spin 被拒（游戏类型校验生效）')

  /* ============================================================
   * ⑬ ★★★ 双人完整流程（2026-10-08 用户实测报障后补）
   * ============================================================ */
  console.log('\n=== ⑬ ★★★ 双人完整流程：大话骰 / 转盘 / 摇骰子 ===')
  /*
   * 背景：用户实测报「骰盅拿开骰子看不全 / 大话骰无法喊骰 / 转盘无法转」。
   * 这三条都不是云函数的问题（38 项断言全绿），而是**前端把入口藏起来了**：
   *   · liarReady 初始 false → 整个叫骰区被 wx:if 藏掉 → 玩家看不到任何按钮
   *   · 骰子横排 612rpx 而盅只有 300rpx → 盅一抬两端露在外面
   *   · 转盘「转！」只在 playing 阶段出现，而 phase 推进靠轮询
   *
   * 这条断言锁的是「双人真的能把三个游戏各玩一遍」——
   * 之前所有断言测的都是**单个 action**，没测过**连续流程**。
   */

  /* ---- ① 大话骰：双人开局 → 叫骰 → 开盅 ---- */
  OPENID = A
  const lr = await room.main({ action: 'create', name: 'L1', game: 'liar' })
  const lrId = lr.room.id
  OPENID = B
  await room.main({ action: 'join', code: lr.room.code, name: 'L2' })
  OPENID = A
  const lrStart = await room.main({ action: 'start', id: lrId })
  assert.ok(lrStart.ok, '双人开局应成功：' + (lrStart.msg || ''))
  /* 跳过倒计时 */
  store.rooms.filter(x => x._id === lrId)[0].countdownEnd = Date.now() - 100
  const lrPlay = await room.main({ action: 'status', id: lrId })
  assert.strictEqual(lrPlay.room.phase, 'playing', '★ 倒计时到点后必须自动进入 playing（否则什么都点不了）')
  ok('★ 双人开局 → 倒计时 → 自动进入 playing')

  /* 每个人都要拿到自己的 5 颗骰子 */
  assert.strictEqual((lrPlay.room.me.dice || []).length, 5, '大话骰每人 5 颗骰子')
  ok('每人拿到 5 颗自己的骰子')

  /*
   * ★ 关键：叫骰选项必须非空。
   *
   * ⚠️ options 是**前端算的**（room.js 的 buildOptions），
   *    云函数响应里本来就没有这个字段 ——
   *    第一版测试写成「云函数返回的 options 非空」，永远失败，
   *    是我测错了对象。
   *
   * 这里改为**直接把前端真实代码抽出来测**，
   * 这样测的才是"玩家实际会看到几个按钮"。
   */
  const rjs = require('fs').readFileSync(
    require('path').join(__dirname, '..', 'miniprogram/game/room/room.js'), 'utf8')
  /* ⚠️ 必须匹配**函数定义** `  buildOptions(room) {`，
   *   不能用 indexOf('buildOptions(room)') —— 那个串在 refresh()
   *   里的调用处和注释里也出现，会匹配到调用那一行，抽出来的
   *   其实是 refresh 的一大半（里面引用 room / this，全是 ReferenceError）。
   *   症状就是「room is not defined」，看起来像 mock 的锅，其实是抽错了函数。 */
  const boStart = rjs.search(/^\s*buildOptions\s*\(\s*room\s*\)\s*\{/m)
  assert.ok(boStart > 0, '没找到 buildOptions 的定义')
  let depth = 0, boEnd = -1
  const boOpen = rjs.indexOf('{', boStart)
  for (let k = boOpen; k < rjs.length; k++) {
    if (rjs[k] === '{') depth++
    else if (rjs[k] === '}') { depth--; if (depth === 0) { boEnd = k; break } }
  }
  /*
   * ⚠️ buildOptions 内部没有 this 调用，但为了以后它万一用了也不能炸，
   *    这里给它一个带 setData 的桩对象。
   *    签名 `buildOptions(room)`：new Function 出来的匿名函数
   *    第一个形参就是 room，用 call(thisArg, roomArg) 传。
   */
  /*
   * ★ 关键：`new Function(body)` 生成的函数**形参列表是空的**，
   *   所以 body 里的 `room` 是未定义标识符 → ReferenceError。
   *   正确写法：`new Function('room', 'this', body去掉外层花括号)`，
   *   把 room 和 this 都声明成形参。
   */
  const boBody = rjs.slice(boOpen + 1, boEnd)     // 去掉最外层的 { }
  // 形参名用 _room 并把 body 里的 room 一起改名（this 是保留字，不能当形参名）
  const buildOptions = new Function('_room', boBody.replace(/\broom\b/g, '_room'))
  const opts = buildOptions({ count: 2, bid: null })
  assert.ok(Array.isArray(opts) && opts.length > 0,
    '★ 叫骰选项不能为空 —— 为空的话前端一个按钮都渲染不出来')
  assert.ok(opts[0].indexOf('个') > 0, '选项格式应是「N个F」，否则 doBid 解析不出来')
  ok(`★ 叫骰选项 ${opts.length} 个（首个「${opts[0]}」），前端能渲染出按钮`)

  /* 上家叫过之后，选项必须只剩"更大的" —— 否则玩家能叫更小的，逻辑就崩了 */
  const afterBid = buildOptions({ count: 2, bid: { n: 3, face: 4 } })
  const illegal = afterBid.filter(x => {
    const m = /^(\d+)个(\d)$/.exec(x)
    return m && (Number(m[1]) < 3 || (Number(m[1]) === 3 && Number(m[2]) <= 4))
  })
  assert.deepStrictEqual(illegal, [],
    '这些选项比上家叫的小（点了会被服务端拒绝，白白挨一次网络往返）：\n    ' +
    illegal.join('\n    '))
  ok(`上家叫「3个4」后，只剩更大的 ${afterBid.length} 个选项`)

  /* 参与人数决定上限：2 人 × 5 颗 = 10，不该出现「11个3」 */
  assert.ok(!opts.some(x => x.indexOf('11个') === 0),
    '2 人局不该出现「11个N」这种超上限的叫法')
  ok('叫骰上限跟着人数走（2 人局最高 10 个）')

  /* 叫骰 → 开盅，走完整局 */
  const bidOK = await room.main({ action: 'bid', id: lrId, n: 3, face: 4 })
  assert.ok(bidOK.ok, 'seat1 叫「3个4」应成功：' + (bidOK.msg || ''))
  OPENID = B
  const bid2 = await room.main({ action: 'bid', id: lrId, n: 5, face: 4 })
  assert.ok(bid2.ok, 'seat2 叫「5个4」应成功：' + (bid2.msg || ''))
  /* 两人轮转一圈后 turn 回到 seat1（A），所以开盅要由 A 来做。
     这也顺带验了一条规则：叫骰的回合是严格轮转的，不能自己连叫两次。 */
  assert.strictEqual(bid2.room.turn, 1, '★ B 叫完后回合应回到 seat1（两人轮转）')
  ok('★ 叫骰回合严格轮转（B 叫完回到 A）')
  OPENID = A
  const openOK = await room.main({ action: 'open', id: lrId })
  assert.ok(openOK.ok, '开盅应成功：' + (openOK.msg || ''))
  assert.ok(openOK.result && openOK.result.allDice.length === 2, '开盅后应亮出所有人的骰子')
  ok('★ 大话骰：叫骰 → 叫骰 → 开盅，全流程走通')

  /* ---- ② 转盘：双人开局 → 房主转 ---- */
  OPENID = A
  const wr = await room.main({ action: 'create', name: 'R1', game: 'wheel' })
  const wrId = wr.room.id
  OPENID = B
  await room.main({ action: 'join', code: wr.room.code, name: 'R2' })
  OPENID = A
  await room.main({ action: 'start', id: wrId })
  store.rooms.filter(x => x._id === wrId)[0].countdownEnd = Date.now() - 100
  const wrPlay = await room.main({ action: 'status', id: wrId })
  assert.strictEqual(wrPlay.room.phase, 'playing',
    '★ 转盘房间也必须自动进入 playing（转盘按钮只在 playing 阶段出现）')
  assert.strictEqual(wrPlay.room.host, true, '房主标记要正确（转盘按钮靠它显示）')
  const wrSpin = await room.main({ action: 'spin', id: wrId })
  assert.ok(wrSpin.ok, '★ 房主转盘必须成功：' + (wrSpin.msg || ''))
  ok('★ 转盘：双人开局 → 进入 playing → 房主转，成功')

  /* 非房主在 playing 阶段转，应被拒（前端也会隐藏按钮） */
  OPENID = B
  const notHostSpin = await room.main({ action: 'spin', id: wrId })
  assert.ok(!notHostSpin.ok, '非房主不能转')
  ok('非房主转不了（前端同步隐藏按钮）')

  /* ---- ③ 摇骰子：双人各摇一次 → 自动出结果 ---- */
  OPENID = A
  const dr = await room.main({ action: 'create', name: 'D1', game: 'dice' })
  const drId = dr.room.id
  OPENID = B
  await room.main({ action: 'join', code: dr.room.code, name: 'D2' })
  OPENID = A
  await room.main({ action: 'start', id: drId })
  store.rooms.filter(x => x._id === drId)[0].countdownEnd = Date.now() - 100
  await room.main({ action: 'status', id: drId })
  OPENID = A
  const rollA = await room.main({ action: 'roll', id: drId })
  assert.ok(rollA.ok, 'A 摇应成功：' + (rollA.msg || ''))
  /* 只摇一个时还没到结算 —— 前端此时应显示「已摇，等其他人」 */
  assert.ok(!rollA.result,
    `只摇了一个时不该出结果（要等全员），实际: ${JSON.stringify(rollA.result)}`)
  /* 自己的骰子要点数，且**别人的点数不能出现** */
  assert.ok((rollA.room.me.dice || []).length === 5, '摇骰子每人 5 颗（真实骰盅就是这个数）')
  const leaked = (rollA.room.players || []).some(p => !p.isMe && Array.isArray(p.dice) && p.dice.length)
  assert.ok(!leaked, '★ 不能把别人的骰子点数发到前端（抓到就等于作弊）')
  ok('★ A 摇完：有自己的点数、别人的不可见、暂不出结果')
  OPENID = B
  const rollB = await room.main({ action: 'roll', id: drId })
  assert.ok(rollB.ok, 'B 摇应成功：' + (rollB.msg || ''))
  assert.ok(rollB.result, '★ 全员摇完必须自动出结果（这是「已摇完自动开结果」的入口）')
  assert.ok(Array.isArray(rollB.result.ranked) && rollB.result.ranked.length === 2, '结果要有两个人的排名')
  ok('★ 摇骰子：A 摇 → B 摇 → 自动出结果')

  /* ============ ⑪g 单人大话骰：能不能"叫自己再开自己" ============ */
  /*
   * 单人局的回合是循环回自己的（1 人时 `(seat % n) + 1` 还是 1），
   * 所以"叫完之后开自己"是唯一能走完的路径 —— 必须能走通，
   * 而不是被"不能开自己叫的骰"之类的规则挡住（那样单人局永无出口）。
   */
  {
    OPENID = A
    const lr = await room.main({ action: 'create', name: 'L1', game: 'liar' })
    const lrId = lr.room.id
    await room.main({ action: 'start', id: lrId, solo: true })
    store.rooms.filter(x => x._id === lrId)[0].countdownEnd = Date.now() - 100
    await room.main({ action: 'status', id: lrId })

    /* 单人必须先偷看才给叫骰 —— 这条规则单人局同样适用 */
    const st0 = await room.main({ action: 'status', id: lrId })
    assert.ok(st0.room.me.dice && st0.room.me.dice.length === 5, '单人局也要发 5 颗')

    const bid = await room.main({ action: 'bid', id: lrId, n: 2, face: 3 })
    assert.ok(bid.ok, '单人叫骰应成功：' + (bid.msg || ''))

    /* 叫完之后回合回到自己（1 人循环），此时必须能开 */
    const opened = await room.main({ action: 'open', id: lrId })
    assert.ok(opened.ok, '★ 单人必须能"开自己的骰"走完一局：' + (opened.msg || ''))
    assert.strictEqual(opened.room.phase, 'over', '开完应结算')
    assert.ok(opened.result && opened.result.loserName, '结算要说清谁输（单人就是自己）')
    ok('★ 单人大话骰：叫自己再开自己，能走完一局')
  }

  /* ============ ⑪f 单人金花：没有可比的人，能不能走完 ============ */
  /*
   * 同 ⑪e 的思路：soloTest 下一个人也要能把一局走完，否则就是"能开但卡住"。
   * 金花的单人路径只有一条：**弃牌**（没有别人可以比）。
   * 所以判据是：单人局点弃牌必须能结算，而不是回到"轮到你了"。
   */
  {
    OPENID = A
    const pr = await room.main({ action: 'create', name: 'K1', game: 'poker' })
    const prId = pr.room.id
    const pStart = await room.main({ action: 'start', id: prId, solo: true })
    assert.ok(pStart.ok, '单人金花应能开局：' + (pStart.msg || ''))
    store.rooms.filter(x => x._id === prId)[0].countdownEnd = Date.now() - 100
    await room.main({ action: 'status', id: prId })

    /* 单人时"能比的人"列表应为空 —— 界面据此只给弃牌 */
    const pSt = await room.main({ action: 'status', id: prId })
    const others = (pSt.room.players || []).filter(x => !x.isMe && !x.out)
    assert.strictEqual(others.length, 0, '单人局不该有可以比的人')

    /* 弃牌必须能推进（而不是回到"轮到你了"） */
    const folded = await room.main({ action: 'pkAct', act: 'fold', id: prId })
    assert.ok(folded.ok, '★ 单人金花弃牌应成功：' + (folded.msg || ''))
    /*
     * ⚠️ 这里原来写成 `folded || phase === 'over'` —— 太松。
     *    "folded 了但没结算"同样会让单人局停在废弃界面，
     *    没有别人能推进，和卡死没区别。所以必须是 over。
     */
    assert.strictEqual(folded.room.phase, 'over',
      '★ 单人弃牌后必须结算（只置 folded 不结算 = 一样卡住），实际 phase=' + folded.room.phase)
    ok('★ 单人金花：没有可比的人，弃牌能走完')
  }

  /* ============ ⑪h 单人比大小：摇完就能出结果 ============ */
  /* 同一类判据：soloTest 下一个人点也能看到完整的一局，不能卡在"等别人摇"。 */
  {
    OPENID = A
    const dr = await room.main({ action: 'create', name: 'D1', game: 'dice' })
    const drId = dr.room.id
    await room.main({ action: 'start', id: drId, solo: true })
    store.rooms.filter(x => x._id === drId)[0].countdownEnd = Date.now() - 100
    await room.main({ action: 'status', id: drId })
    const rolled = await room.main({ action: 'roll', id: drId })
    assert.ok(rolled.ok, '单人摇骰应成功：' + (rolled.msg || ''))
    assert.ok(rolled.result, '★ 单人摇完必须立刻出结果（不能卡在"等别人摇"）')
    assert.strictEqual(rolled.room.phase, 'over', '单人摇完应结算')
    ok('★ 单人比大小：摇完立刻出结果')
  }

  /* ============ ⑪e 单人卧底：不能"能开局但玩不了" ============ */
  /*
   * ★★ 2026-10-28 发现。soloTest 打开后一个人也能开局，
   *   而卧底的开局逻辑里有这么一行：
   *       const spies = order.slice(0, Math.min(spyN, Math.max(1, order.length - 1)))
   *   一个人时 `Math.max(1, 0) = 1` → **唯一的人被选成卧底**。
   *   然后进入投票：模板只列"不是自己、没出局"的人 → 列表为空，
   *   而服务端又拦"不能投自己" → **卡死在投票页，没有任何人能推进**。
   *
   *   这不是"玩法不好玩"，是**能开局却永远走不下去** —— 比开不了局更糟，
   *   因为玩家会以为是自己操作错了。
   *
   * 判据：单人开局时，卧底必须**要么被明确拒绝**，要么真的能走完一轮。
   *      现在的实现是"拒绝"（见 games.js 的 soloMin）。
   */
  {
    OPENID = A
    const ur = await room.main({ action: 'create', name: 'U1', game: 'undercover' })
    const urId = ur.room.id
    const uSolo = await room.main({ action: 'start', id: urId, solo: true })
    assert.strictEqual(uSolo.ok, false,
      '★ 一个人不能开卧底局（能开但投票必卡死，比开不了更糟）')
    assert.ok(/个人|至少/.test(uSolo.msg || ''),
      '提示要说清要几个人，实际：' + (uSolo.msg || ''))
    ok('★ 单人卧底被明确拒绝（而不是开局后卡在投票页）')
  }

  /* ============ ⑪d 卧底词库：数量够、无重复、每对都合法 ============ */
  /*
   * 2026-10-28 从 60 对扩到 120 对。
   *
   * 为什么扩：12 人局一轮抽一个词对，60 对大概玩四五轮就开始重复 ——
   * 而"需要大量内容库"本来就是这个玩法存在的理由之一
   * （现实里现场出题几轮就干了）。
   *
   * 扩的时间踩了两个坑，都用断言锁住：
   *   ① 往数组末尾追加时，**原数组最后一项没有尾逗号** ——
   *      直接粘上去会生成非法表达式，而我第一版用 `index(']')` 找插入点，
   *      找到的是**第一个词对的 `]`**，把文件改坏了。
   *   ② 新词和旧词重了三个（薯条 / 乒乓球 / 剧本杀）——
   *      同一个词在两个词对里出现，抽到时会让人以为撞了 bug。
   */
  {
    const words = require('../miniprogram/utils/words.js')
    assert.ok(Array.isArray(words.DECKS) && words.DECKS.length >= 3,
      '词库至少要 3 组（吃的 / 日常 / 玩乐）')
    let total = 0
    const seen = new Map()
    const dup = []
    const bad = []
    words.DECKS.forEach(d => {
      assert.ok(Array.isArray(d.pairs), d.k + ' 缺 pairs 数组')
      d.pairs.forEach(p => {
        total++
        if (!Array.isArray(p) || p.length !== 2 || !p[0] || !p[1]) {
          bad.push(d.k + ' → ' + JSON.stringify(p))
          return
        }
        /* 同一个词出现在两对里 = 抽到时会让人以为撞了 bug */
        p.forEach(w => {
          if (seen.has(w)) dup.push(w + '（' + seen.get(w) + ' 与 ' + d.k + '）')
          else seen.set(w, d.k)
        })
        /* 两个词不能相同（同义词对没得玩） */
        if (p[0] === p[1]) bad.push(d.k + ' → 两个词相同：' + p[0])
      })
    })
    assert.deepStrictEqual(bad, [], '词库里有不合法的词对：\n    ' + bad.join('\n    '))
    assert.deepStrictEqual(dup, [], '这些词在多个词对里重复出现：\n    ' + dup.join('\n    '))
    assert.ok(total >= 100, `词对总数应 ≥100（现在 ${total} 对）—— 太少玩几轮就重复`)
    ok(`卧底词库 ${total} 对，无重复词、无非法项`)

    /* 抽词必须落在该组里，且平民词 ≠ 卧底词 */
    const picked = words.pickPair('food')
    assert.ok(picked && picked.civilian && picked.spy && picked.deck === 'food',
      'pickPair 返回结构不对：' + JSON.stringify(picked))
    assert.notStrictEqual(picked.civilian, picked.spy, '平民词和卧底词不能相同')
    ok('抽词结构正确（平民词 ≠ 卧底词）')
  }

  /* ============ ⑪c 大话骰：劈（加倍） ============ */
  /*
   * 2026-10-28 加。调研过同类产品后的判断：大话骰缺的**不是规则数量，
   * 而是一个让桌上争吵有出口的动作**。原来只有「叫」和「开」——
   * 有人叫了个离谱的，你除了开没有别的回应，而开是一翻两瞪眼。
   *
   * 语义（刻意做到一句话说清）：
   *   · 只能在轮到你、且已经有人叫过时劈
   *   · 劈 → 倍数 ×2，回合**怼回**上一个叫骰的人（不是传给下家）
   *   · 被劈的人可以反劈 / 继续叫 / 开
   *   · 开出来输家喝「倍数」杯，最多 8 倍
   */
  {
    const PA = 'oid_pa', PB = 'oid_pb'
    OPENID = PA
    const pr = await room.main({ action: 'create', name: 'P1', game: 'liar' })
    const prId = pr.room.id
    OPENID = PB
    await room.main({ action: 'join', code: pr.room.code, name: 'P2' })
    OPENID = PA
    await room.main({ action: 'start', id: prId, solo: true })
    store.rooms.filter(x => x._id === prId)[0].countdownEnd = Date.now() - 100
    await room.main({ action: 'status', id: prId })

    /* 还没人叫 → 不能劈 */
    OPENID = PA
    const piNoBid = await room.main({ action: 'pi', id: prId })
    assert.ok(!piNoBid.ok, '★ 还没人叫骰时不能劈')

    /* 先由 P1 叫一个 */
    const firstBid = await room.main({ action: 'bid', id: prId, n: 2, face: 3 })
    assert.ok(firstBid.ok, 'P1 叫骰应成功：' + (firstBid.msg || ''))

    /*
     * ⚠️ 顺序很重要：**先验"回合不在你时不能劈"，再让 P2 劈**。
     *    第一版把这条放在 P2 劈之后，而那时回合正好回到 P1 ——
     *    于是这次"本应被拒"的调用**成功了**，把 piSeat 改成了 P1，
     *    紧接着的"反劈"反而被拦。**测试自己改掉了自己的前置条件。**
     */
    OPENID = PA
    const notMyTurn = await room.main({ action: 'pi', id: prId })
    assert.ok(!notMyTurn.ok && /还没轮到你/.test(notMyTurn.msg || ''),
      '★ 回合不在你时不能劈（实际：' + (notMyTurn.msg || '') + '）')

    /* 轮到 P2，他劈：倍数 ×2，回合怼回 P1 */
    OPENID = PB
    const piRes = await room.main({ action: 'pi', id: prId })
    assert.ok(piRes.ok, '★ 轮到谁谁才能劈：' + (piRes.msg || ''))
    assert.strictEqual(piRes.room.bid.mult, 2, '劈一次 → 2 倍')
    assert.strictEqual(piRes.room.bid.piBy, 'P2', '要记住是谁劈的（结算时要说清）')
    assert.strictEqual(piRes.room.turn, 1,
      '★ 劈之后回合要**怼回**叫骰的人（不是传给下家）—— 实际 turn=' + piRes.room.turn)

    /* 被劈的人反劈：再 ×2 → 4 倍（这是「劈」最有火药味的一半） */
    OPENID = PA
    const backPi = await room.main({ action: 'pi', id: prId })
    assert.ok(backPi.ok, '反劈应成功：' + (backPi.msg || ''))
    assert.strictEqual(backPi.room.bid.mult, 4, '反劈 → 4 倍')
    /* 反劈后回合怼回对方（对 P1 来说对方是 P2，座位 2） */
    assert.strictEqual(backPi.room.turn, 2, '反劈之后回合怼回对方（seat 2）—— 实际 ' + backPi.room.turn)
    ok('★ 劈：倍数翻倍、回合怼回对方、被劈的人可以反劈')

    /* 开：输家要喝「倍数」杯 */
    OPENID = PB
    const openRes = await room.main({ action: 'open', id: prId })
    assert.ok(openRes.ok, '开骰应成功：' + (openRes.msg || ''))
    assert.strictEqual(openRes.result.mult, 4, '开出来的结果要带倍数')
    assert.strictEqual(openRes.result.cups, 4, '★ 输家喝 4 杯（1 杯 × 4 倍）')
    /*
     * piBy 记的是**最后一次**把赌注推到当前倍数的人 —— 这里是 P1 的反劈，
     * 不是最先劈的 P2。结算时说"被 P1 劈了"才对得上"4 倍是谁推上去的"。
     */
    assert.strictEqual(openRes.result.piBy, 'P1', '结算里要能说清最后是谁劈的')
    ok('★ 开骰结算：输家按倍数喝（4 倍 = 4 杯）')
  }

  /* ============ ⑪b 比大小：5 颗骰子 + 豹子直接赢（纯函数直测） ============ */
  /*
   * 2026-10-28 改。两件事：
   *   ① 每人从 2 颗改成 5 颗（原来那个 2 是 `room.diceCount` 恒为 undefined
   *      的回退值，不是设计值）。2 颗只有 12 种结果，比大小几乎没有悬念。
   *   ② 五颗同点 = 豹子，**直接赢**，不看总点数。
   *
   * ★ 规则抽成了纯函数 utils/dicerank.js（云端有一份拷贝）。
   *   原来它内联在 roll 分支里 —— 想验一条规则只能"真把房间跑起来摇一把"，
   *   而骰子是随机的，**根本没法构造"某人有豹子"这种场面**。
   *   现在直接喂数组，规则的每个分支都能测。
   */
  const { rankPlayers } = require('../miniprogram/utils/dicerank.js')
  {
    /* ① 豹子赢：五个 1（总 5 点）压过对方的 22 点 */
    const r1 = rankPlayers([
      { name: '甲', seat: 1, dice: [1, 1, 1, 1, 1] },
      { name: '乙', seat: 2, dice: [6, 6, 6, 2, 2] }
    ])
    assert.deepStrictEqual(r1.winners, ['甲'],
      '★ 五颗同点（豹子）必须直接赢，不看总点数：' + JSON.stringify(r1.winners))
    assert.strictEqual(r1.leopardWin, true, '要标出"赢家里有豹子"')
    assert.strictEqual(r1.leopardFace, 1, '豹子的点数要带出来（界面要喊"五个 1"）')
    ok('★ 豹子（五同）直接赢 —— 5 点压过 22 点')

    /* ② 两个豹子：点数大的赢 */
    const r2 = rankPlayers([
      { name: '甲', seat: 1, dice: [1, 1, 1, 1, 1] },
      { name: '乙', seat: 2, dice: [6, 6, 6, 6, 6] }
    ])
    assert.deepStrictEqual(r2.winners, ['乙'], '★ 两个豹子时点数大的赢（六个 6 > 五个 1）')
    ok('★ 两个豹子：点数大的赢')

    /* ③ 没有豹子时按总点数 */
    const r3 = rankPlayers([
      { name: '甲', seat: 1, dice: [1, 2, 3, 4, 5] },
      { name: '乙', seat: 2, dice: [6, 6, 6, 6, 2] }
    ])
    assert.deepStrictEqual(r3.winners, ['乙'], '没有豹子时按总点数排')
    assert.strictEqual(r3.leopardWin, false, '没有豹子时 leopardWin 应为 false')
    ok('没有豹子时按总点数')

    /* ④ 并列：都算赢（酒桌上并列不用分胜负，反正都要喝） */
    const r4 = rankPlayers([
      { name: '甲', seat: 1, dice: [3, 3, 3, 3, 3] },
      { name: '乙', seat: 2, dice: [3, 3, 3, 3, 3] }
    ])
    assert.strictEqual(r4.winners.length, 2, '点数完全一样时两个都算赢')
    ok('并列：都算赢')

    /* ⑤ 脏数据不能把整局搞崩：非法点数剔掉再算 */
    const r5 = rankPlayers([
      { name: '甲', seat: 1, dice: [1, 2, 3, 4, 99] },
      { name: '乙', seat: 2, dice: [2, 2, 2, 2, 2] }
    ])
    assert.strictEqual(r5.ranked[0].total, 10, '非法点数要剔除（1+2+3+4=10）')
    ok('脏数据（非法点数）被剔除，不会污染排名')
  }

  /* ============ ⑫ 谁是卧底：秘密词 + 匿名身份 + 投票结算 ============ */
  /*
   * 这个玩法是「加新游戏」的第一个真正落地件，判据按两条铁律筛过：
   *   ① 需要**秘密信息**（只有卧底看到不同的词）→ 手机不可替代
   *   ② 需要**大量词库** → 现实里现场出题几轮就干了
   *
   * 断言重点（都是"改坏了也不报错、只是悄悄泄漏"的类型）：
   *   · ★ 别人的词**绝不能**出现在我的响应里
   *   · ★ 谁都不该知道自己的身份（myRole 恒空）—— 这是玩法的核心体验
   *   · 只有房主能切环节
   *   · 不能投自己 / 不能投出局的 / 不能重复投
   *   · 全员投完**自动结算**，票最多出局
   */
  const U1 = 'oid_u1', U2 = 'oid_u2', U3 = 'oid_u3', U4 = 'oid_u4'
  OPENID = U1
  const ur = await room.main({ action: 'create', name: 'U1', game: 'undercover', deck: 'food' })
  assert.ok(ur.ok, '⑫ 建卧底房应成功：' + (ur.msg || ''))
  const urId = ur.room.id
  for (const [oid, nm] of [[U2, 'U2'], [U3, 'U3'], [U4, 'U4']]) {
    OPENID = oid
    const j = await room.main({ action: 'join', code: ur.room.code, name: nm })
    assert.ok(j.ok, '⑫ ' + nm + ' 加入应成功：' + (j.msg || ''))
  }

  OPENID = U1
  const us = await room.main({ action: 'start', id: urId })
  assert.ok(us.ok, '⑫ 开机应成功：' + (us.msg || ''))
  const uRoom = () => store.rooms.filter(x => x._id === urId)[0]
  uRoom().countdownEnd = Date.now() - 100

  /* 每个人分别取一次自己的词 */
  const wordsBy = {}
  for (const oid of [U1, U2, U3, U4]) {
    OPENID = oid
    const st = await room.main({ action: 'status', id: urId })
    assert.ok(st.ok && st.room.uw, '⑫ 应该有 uw 状态')
    wordsBy[oid] = st.room.uw.word
    assert.ok(wordsBy[oid], '⑫ 每个人都必须拿到自己的词')
    /* ★ 命门 1：别人的词不能出现在我的响应里 */
    const leaked = (st.room.players || []).some(p => p.uwWord || p.word)
    assert.ok(!leaked, '⑫ ★★ 别人的词绝不能下发到前端（抓到就等于明牌）')
    /* ★ 命门 2：谁都不该知道自己的身份 */
    assert.strictEqual(st.room.uw.myRole, '', '⑫ ★★ 进行中不能告诉玩家自己的身份（卧底不知道自己是卧底）')
    assert.strictEqual(st.room.uw.step, 'talk', '⑫ 开局应直接进入"说描述"')
  }
  const uniqWords = Array.from(new Set(Object.values(wordsBy)))
  assert.strictEqual(uniqWords.length, 2, '⑫ 4 人局应只有两种词（1 个卧底），实际: ' + JSON.stringify(wordsBy))
  const spyWord = uniqWords.filter(w => Object.values(wordsBy).filter(x => x === w).length === 1)[0]
  assert.ok(spyWord, '⑫ 应该恰有一个人拿到不同的词')
  ok('★ 谁是卧底：4 人开局，1 人拿到不同的词，别人的词与身份都拿不到')

  /* 只有房主能切换环节 */
  OPENID = U2
  const uwNotHost = await room.main({ action: 'uwSay', id: urId })
  assert.ok(!uwNotHost.ok, '⑫ ★ 非房主不能开始投票')
  ok('非房主不能切换环节')

  OPENID = U1
  const uwToVote = await room.main({ action: 'uwSay', id: urId })
  assert.ok(uwToVote.ok, '⑫ 房主开始投票应成功：' + (uwToVote.msg || ''))
  assert.strictEqual(uwToVote.room.uw.step, 'vote', '⑫ 应进入投票环节')
  ok('★ 房主「开始投票」→ 全场进入投票')

  /* 不能投自己 */
  OPENID = U1
  const uwSelf = await room.main({ action: 'uwVote', target: U1, id: urId })
  assert.ok(!uwSelf.ok, '⑫ ★ 不能投自己')
  ok('不能投自己')

  /* 四人各投一票，全投给那个拿到不同词的人（找出卧底） */
  const spyOid = Object.keys(wordsBy).filter(k => wordsBy[k] === spyWord)[0]
  const civilians = [U1, U2, U3, U4].filter(k => k !== spyOid)
  /* 平民都投卧底 → 3 票；卧底投一个平民 → 1 票 */
  let lastRes = null
  for (const oid of civilians) {
    OPENID = oid
    lastRes = await room.main({ action: 'uwVote', target: spyOid, id: urId })
    assert.ok(lastRes.ok, '⑫ ' + oid + ' 投票应成功：' + (lastRes.msg || ''))
  }
  /* 重复投要被拒 */
  OPENID = civilians[0]
  const uwDup = await room.main({ action: 'uwVote', target: U2, id: urId })
  assert.ok(!uwDup.ok, '⑫ ★ 不能重复投票')
  ok('重复投票被拒（不能靠连点改结果）')

  OPENID = spyOid
  lastRes = await room.main({ action: 'uwVote', target: civilians[0], id: urId })
  assert.ok(lastRes.ok, '⑫ 卧底最后一票应成功：' + (lastRes.msg || ''))
  assert.strictEqual(lastRes.room.uw.step, 'result', '⑫ 全员投完应自动结算，不用房主再点')

  const lastOut = lastRes.room.uw.lastOut
  assert.ok(lastOut, '⑫ 结算必须给出出局者')
  assert.strictEqual(lastOut.name, 'U' + spyOid.slice(-1), '⑫ 票最多的人应出局，实际: ' + JSON.stringify(lastOut))
  assert.strictEqual(lastOut.role, 'spy', '⑫ ★ 出局后必须公开他的身份')
  assert.strictEqual(lastOut.word, spyWord, '⑫ ★ 出局后必须公开他的词')
  ok('★ 全员投完自动结算：票最多出局，并公开他的词与身份')

  /* 卧底出局 → 好人赢，进入 over */
  assert.strictEqual(lastRes.room.phase, 'over', '⑫ 卧底全出局应直接结束')
  assert.strictEqual(lastRes.room.lastResult.winner, 'civilian', '⑫ 卧底全出局 → 好人赢')
  assert.ok(Array.isArray(lastRes.room.uw.reveal) && lastRes.room.uw.reveal.length === 4,
    '⑫ 结束时要把所有人的词摊开')
  const uwRevealAll = lastRes.room.uw.reveal
  ok('★ 卧底出局 → 好人赢，全场词与身份公开')

  /* 出局的人在结束后应该能看到自己的身份 */
  OPENID = spyOid
  const uwAfter = await room.main({ action: 'status', id: urId })
  assert.strictEqual(uwAfter.room.uw.myRole, 'spy', '⑫ 结束后应能知道自己就是卧底')
  ok('结束后玩家能看到自己的真实身份（复盘用）')

  /* ============ ⑫c 默认名必须唯一 + 随时能改名字 ============ */
  /*
   * 2026-10-28。原来进房不输昵称，没设过名字的人一律叫「玩家」——
   * 两个人同时进房就是两个「玩家」，桌上完全对不上人：
   * 别人屏幕上写「玩家 叫了 3 个 4」，而屏幕前坐着的是谁、该谁喝，谁也说不清。
   *
   * 两件事都要锁：
   *   ① 默认名带座位号（唯一，且座位号本来就显示在列表里）
   *   ② 自己能改（rename），且**改不了别人**
   */
  {
    const N1 = 'oid_n1', N2 = 'oid_n2'
    OPENID = N1
    /* 故意不传 name —— 模拟"没设过昵称"的人 */
    const nr = await room.main({ action: 'create', game: 'liar' })
    assert.ok(nr.ok, '⑫c 不传名字也应能建房：' + (nr.msg || ''))
    const nrId = nr.room.id
    OPENID = N2
    const nj = await room.main({ action: 'join', code: nr.room.code })
    assert.ok(nj.ok, '⑫c 不传名字也应能进房：' + (nj.msg || ''))

    const nst = await room.main({ action: 'status', id: nrId })
    assert.ok(nst.ok && nst.room.players.length === 2, '⑫c 房间里应有 2 人')
    const names = nst.room.players.map(p => p.name)
    assert.strictEqual(new Set(names).size, names.length,
      '⑫c ★★ 默认名不能重复（否则桌上对不上人），实际：' + names.join(' / '))
    assert.ok(names[1].indexOf(String(nst.room.players[1].seat)) >= 0,
      '⑫c 默认名要带座位号，实际：' + names[1])

    /* 改名：只能改自己 */
    OPENID = N2
    const rn = await room.main({ action: 'rename', id: nrId, name: '阿杰' })
    assert.ok(rn.ok, '⑫c 改名应成功：' + (rn.msg || ''))
    const after = await room.main({ action: 'status', id: nrId })
    const meRow = after.room.players.filter(p => p.isMe)[0]
    const otherRow = after.room.players.filter(p => !p.isMe)[0]
    assert.strictEqual(meRow.name, '阿杰', '⑫c 自己的名字应改掉')
    assert.notStrictEqual(otherRow.name, '阿杰', '⑫c ★ 不能改到别人的名字上')

    /* 空名字要拒绝（而不是"改成空"这种静默失败） */
    const rn0 = await room.main({ action: 'rename', id: nrId, name: '   ' })
    assert.ok(!rn0.ok, '⑫c ★ 空名字应被拒绝')
    ok('★ 默认名唯一（带座位号），且只能改自己的名字')
  }

  /* ============ ⑫b 平票：不淘汰，重投一次；两次平票卧底赢 ============ */
  /*
   * 2026-10-28 改的规则。原来平票是**随机**挑一个人出局 ——
   * 实现上没问题，问题在桌上没法解释：被选中的人一定会问"凭什么是我"，
   * 而服务端唯一能给的答案是"随机"。
   *
   * 现在的口径（腾讯欢乐斗地主系列攻略的主流说法）：
   *   平票 → 平票的人各补一句 → 重投 → 仍平票则卧底胜。
   * 每一步都有桌上能懂的理由，且"投不出结果 = 好人失败"符合游戏逻辑。
   *
   * 断言要锁的正是这三步，尤其是**"第一次平票不能淘汰任何人"** ——
   * 这条如果回归成"随机淘汰"，玩家体验会直接崩，但代码不会报错。
   */
  {
    const T1 = 'oid_t1', T2 = 'oid_t2', T3 = 'oid_t3'
    const trio = [T1, T2, T3]
    OPENID = T1
    const tr = await room.main({ action: 'create', name: 'T1', game: 'undercover', deck: 'food' })
    assert.ok(tr.ok, '⑫b 建 3 人卧底房应成功：' + (tr.msg || ''))
    const trId = tr.room.id
    for (const [oid, nm] of [[T2, 'T2'], [T3, 'T3']]) {
      OPENID = oid
      const j = await room.main({ action: 'join', code: tr.room.code, name: nm })
      assert.ok(j.ok, '⑫b ' + nm + ' 加入应成功：' + (j.msg || ''))
    }
    OPENID = T1
    const st3 = await room.main({ action: 'start', id: trId })
    assert.ok(st3.ok, '⑫b 开局应成功：' + (st3.msg || ''))
    store.rooms.filter(x => x._id === trId)[0].countdownEnd = Date.now() - 100
    /*
     * ★ 必须先 status 一次把 phase 从 countdown 推到 playing。
     *   推进是在 status 里做的（服务端读 countdownEnd 过期就翻页），
     *   start 返回的 phase 还是 countdown —— 直接 uwSay 会被"这局还没开始"拒掉。
     *   第一版就是漏了这一步，报错是 `Cannot read properties of undefined`，
     *   真正的错误信息（"这局还没开始"）被埋在返回值里没打出来。
     */
    OPENID = T1
    const st0 = await room.main({ action: 'status', id: trId })
    assert.ok(st0.ok && st0.room.uw, '⑫b 推进到 playing 后应拿到 uw 状态')

    /* 三人互投成一圈 → 各 1 票，三方平票 */
    const cycle = {}
    cycle[T1] = T2; cycle[T2] = T3; cycle[T3] = T1
    const voteAll = async () => {
      let last = null
      for (const oid of trio) {
        OPENID = oid
        last = await room.main({ action: 'uwVote', target: cycle[oid], id: trId })
        assert.ok(last.ok, '⑫b ' + oid + ' 投票应成功：' + (last.msg || ''))
      }
      return last
    }

    OPENID = T1
    const toVote1 = await room.main({ action: 'uwSay', id: trId })
    assert.strictEqual(toVote1.room.uw.step, 'vote', '⑫b 应进入投票')

    const tieRes = await voteAll()
    assert.strictEqual(tieRes.room.phase, 'playing',
      '⑫b ★ 平票不能结束这一局（随机淘汰的旧行为会在这里 over）')
    assert.strictEqual(tieRes.room.uw.step, 'talk',
      '⑫b ★ 平票应回到"说描述"，让平票的人各补一句')
    assert.strictEqual(tieRes.room.uw.tieBreak, true, '⑫b 应标记"这一轮已经用过重投"')
    assert.ok(tieRes.room.uw.tieNames && tieRes.room.uw.tieNames.length > 0,
      '⑫b 应告诉玩家平票的是谁，实际：' + JSON.stringify(tieRes.room.uw.tieNames))
    assert.strictEqual(tieRes.room.players.filter(x => !x.out).length, 3,
      '⑫b ★★ 第一次平票**不能淘汰任何人**（这条是被"随机挑一个"坑过的地方）')
    ok('★ 平票不淘汰人：回到说描述，并点名平票的几个人')

    /* 重投：票数清零重新开始 */
    OPENID = T1
    const toVote2 = await room.main({ action: 'uwSay', id: trId })
    assert.strictEqual(toVote2.room.uw.step, 'vote', '⑫b 应重新进入投票')
    assert.strictEqual(toVote2.room.uw.voteCount, 0, '⑫b 重投必须从零计票')
    assert.strictEqual(toVote2.room.uw.tieBreak, true,
      '⑫b 决胜投票阶段要保留"已用过重投"的标记（前端靠它改提示语）')

    const deadRes = await voteAll()
    assert.strictEqual(deadRes.room.phase, 'over', '⑫b ★ 两次平票应结束这一局')
    assert.strictEqual(deadRes.room.lastResult.winner, 'spy',
      '⑫b ★★ 两次都投不出结果 —— 判卧底胜（投不出结果本身就是好人失败）')
    assert.strictEqual(deadRes.room.lastResult.tieDeadlock, true,
      '⑫b 要标记这是"两轮平票"造成的，界面才能解释清楚')
    assert.strictEqual(deadRes.room.players.filter(x => !x.out).length, 3,
      '⑫b 死局也不该误淘汰任何人')
    ok('★ 两次平票 → 卧底胜（并标记 tieDeadlock，界面能解释清楚）')
  }

  /* ============ ⑬ 梦幻金花：公共牌 + 明牌 + 靠想象的暗牌 ============ */
  /*
   * ★★ 这是"梦幻金花"，**不是炸金花**（用户 2026-10-27 说明）：
   *   · 1 张公共牌 —— 所有人可见
   *   · 每人 1 张明牌 —— 只有自己看得见
   *   · 每人 1 张暗牌 —— 连自己都看不到，靠想象
   *   每个人只知道 2/3，所以**不存在闷牌**。
   *
   * 断言重点：
   *   · 公共牌人人都能拿到，且大家拿到的是同一张
   *   · ★ 我只看得到自己的明牌，**暗牌必须在服务端就被丢掉**（连自己都不给）
   *   · ★ 别人的明牌也不能下发
   *   · 比牌裁决用「公共牌 + 明牌 + 暗牌」三张，且与 poker.compare 一致
   *   · 并列时发起方输（先开为负）
   */
  const { compare: pCompare, fullHand: pFull, rank: pRank, cardText: pText } =
    require('../miniprogram/utils/poker.js')
  const P1 = 'oid_p1', P2 = 'oid_p2', P3 = 'oid_p3'
  OPENID = P1
  const pkr = await room.main({ action: 'create', name: 'P1', game: 'poker' })
  assert.ok(pkr.ok, '⑬ 建金花房应成功：' + (pkr.msg || ''))
  const pkId = pkr.room.id
  for (const [oid, nm] of [[P2, 'P2'], [P3, 'P3']]) {
    OPENID = oid
    const j = await room.main({ action: 'join', code: pkr.room.code, name: nm })
    assert.ok(j.ok, '⑬ ' + nm + ' 加入应成功：' + (j.msg || ''))
  }
  OPENID = P1
  const pks = await room.main({ action: 'start', id: pkId })
  assert.ok(pks.ok, '⑬ 开局应成功：' + (pks.msg || ''))
  const pkRoom = () => store.rooms.filter(x => x._id === pkId)[0]
  pkRoom().countdownEnd = Date.now() - 100

  const pkSeen = {}
  for (const oid of [P1, P2, P3]) {
    OPENID = oid
    const st = await room.main({ action: 'status', id: pkId })
    assert.ok(st.ok && st.room.poker, '⑬ 应该有 poker 状态')
    const pk = st.room.poker
    assert.ok(pk.publicCard, '⑬ 每人必须拿到公共牌')
    assert.ok(pk.myKnown, '⑬ 每人必须拿到自己的明牌')
    pkSeen[oid] = { pub: pk.publicCard, known: pk.myKnown, pk: pk }
    /* ★ 命门 1：暗牌不能下发 —— 连自己都看不到 */
    assert.strictEqual(pk.myHidden, undefined, '⑬ ★★ 暗牌不能下发（连自己都不该知道）')
    assert.ok(!('myHidden' in pk), '⑬ ★★ 响应里不能有暗牌字段')
    /* ★ 命门 2：别人的明牌不能下发 */
    const leakOther = (st.room.players || []).some(p => p.cards || p.known)
    assert.ok(!leakOther, '⑬ ★★ 别人的明牌绝不能下发')
  }
  /* 公共牌全场必须是同一张 */
  const pubs = [P1, P2, P3].map(o => pkSeen[o].pub.r + ':' + pkSeen[o].pub.s)
  assert.strictEqual(new Set(pubs).size, 1, '⑬ ★ 三人的公共牌必须是同一张，实际: ' + pubs.join(' '))
  /* 发出去的牌无重复（1 公共 + 3 人 × 2 张 = 7） */
  const rawHands = pkRoom().players.map(p => p.cards)
  const allCards = [pkRoom().pkPublic].concat(rawHands.flat()).map(c => c.r + ':' + c.s)
  assert.strictEqual(allCards.length, 7, '⑬ 1 张公共 + 3 人各 2 张 = 7 张')
  assert.strictEqual(new Set(allCards).size, 7, '⑬ 发出去的牌不能重复')
  ok('★ 梦幻金花：1 张公共牌全场一致、各人只看到自己的明牌、暗牌不下发')

  /* 只有轮到的人能行动 */
  const pkTurn = pkRoom().turn
  const pkBySeat = pkRoom().players.filter(p => p.seat === pkTurn)[0]
  const pkOther = [P1, P2, P3].filter(o => o !== pkBySeat.openid)[0]
  OPENID = pkOther
  const pkOutOfTurn = await room.main({ action: 'pkAct', act: 'fold', id: pkId })
  assert.ok(!pkOutOfTurn.ok, '⑬ ★ 没轮到的人不能行动')
  ok('没轮到的人不能行动（回合由服务端定）')

  /* 不能跟自己比 */
  OPENID = pkBySeat.openid
  const pkSelfVs = await room.main({ action: 'pkAct', act: 'vs', target: pkBySeat.openid, id: pkId })
  assert.ok(!pkSelfVs.ok, '⑬ ★ 不能跟自己比牌')
  ok('不能跟自己比牌')

  /* 比牌：裁决必须与"公共牌 + 明牌 + 暗牌"三张的 poker.compare 一致 */
  const pub = pkRoom().pkPublic
  const handOf = (oid) => {
    const pl = pkRoom().players.filter(p => p.openid === oid)[0]
    return pFull(pub, pl.cards)
  }
  const pkTarget = [P1, P2, P3].filter(o => o !== pkBySeat.openid)[0]
  const expectWin = pCompare(handOf(pkBySeat.openid), handOf(pkTarget)) > 0
  OPENID = pkBySeat.openid
  const pkVs = await room.main({ action: 'pkAct', act: 'vs', target: pkTarget, id: pkId })
  assert.ok(pkVs.ok, '⑬ 比牌应成功：' + (pkVs.msg || ''))
  assert.ok(pkVs.room.poker.last, '⑬ 比牌必须给出结果')
  const pkWant = expectWin ? pkBySeat.name : (pkRoom().players.filter(p => p.openid === pkTarget)[0] || {}).name
  assert.strictEqual(pkVs.room.poker.last.winner, pkWant,
    '⑬ ★ 裁决必须与 poker.compare 一致，期望 ' + pkWant + '，实际 ' + pkVs.room.poker.last.winner)
  /* 摊牌时双方的暗牌也要亮出来（否则没人知道凭什么输） */
  assert.strictEqual(pkVs.room.poker.last.byCards.length, 3, '⑬ 摊牌要给出挑战者的三张牌')
  assert.strictEqual(pkVs.room.poker.last.targetCards.length, 3, '⑬ 摊牌要给出被挑战者的三张牌')
  ok('★ 比牌：用「公共牌+明牌+暗牌」裁决，摊牌亮出三张')
  /*
   * ★★ 比牌说明文字（noteText）—— 2026-10-28 发现的真 bug。
   *
   * 模板 room.wxml 的 .pkl-note 一直渲染 `{{room.poker.last.noteText}}`，
   * 而云函数**从来没生成过这个字段**（全仓只有 wxml 里出现过这个词）。
   * 于是比牌区只有四张牌，下面一行永远是空的 ——
   * 玩家看得到"谁出局了"，但看不到"凭什么"。
   *
   * 这类"模板引用、服务端不给"的字段就是幽灵字段，界面只会静默变空，
   * 而 ④ 那条断言只查顶层 `room.xxx`，两层路径 `room.poker.last.noteText`
   * 正好从它的缝里漏过去了。
   */
  assert.strictEqual(typeof pkVs.room.poker.last.noteText, 'string',
    '⑬ ★ 比牌必须给一句文字说明（noteText），模板在渲染它')
  /*
   * ⚠️ 平手是**随机发生**的（发到同样的牌型），而平手时"赢家"是
   *    "先开为负"判出来的，文案里不会出现他的名字 —— 原来这条断言
   *    在平手局会偶发失败，而失败信息看着像功能坏了（"说明文字没点出赢家"）。
   *    现在按两种情况分别判：平局看有没有解释规则，非平局看有没有点出赢家。
   */
  if (pkVs.room.poker.last.tie) {
    assert.ok(/先开为负/.test(pkVs.room.poker.last.noteText),
      '⑬ ★ 平局必须说明"先开为负"这条规则，实际：' + pkVs.room.poker.last.noteText)
  } else {
    assert.ok(pkVs.room.poker.last.noteText.indexOf(pkWant) >= 0,
      '⑬ ★ 说明文字必须点出赢家，实际：' + pkVs.room.poker.last.noteText)
  }
  ok('比牌给出说明文字（不是只有四张牌，得说清凭什么赢）')

  /* ⑬b 换牌：换公共牌喝 1 杯、换手牌喝半杯（用户 2026-10-27 加的规则） */
  {
    const pkCur0 = pkRoom().players.filter(p => p.seat === pkRoom().turn)[0]
    assert.ok(pkCur0, '⑬b 应该有一个当前轮的人')
    OPENID = pkCur0.openid
    const beforePub = pkRoom().pkPublic
    const beforeKnown = pkCur0.cards[0]
    /* 不是轮到的人不能换 */
    const notMe = [P1, P2, P3].filter(o => o !== pkCur0.openid && pkRoom().players.filter(p => p.openid === o)[0].out === false)[0]
    if (notMe) {
      OPENID = notMe
      const bad = await room.main({ action: 'pkAct', act: 'swapPublic', id: pkId })
      assert.ok(!bad.ok, '⑬b ★ 没轮到的人不能换牌')
    }
    /* 换公共牌：喝 1 杯，公共牌必须真的变了 */
    OPENID = pkCur0.openid
    const sw1 = await room.main({ action: 'pkAct', act: 'swapPublic', id: pkId })
    assert.ok(sw1.ok, '⑬b 换公共牌应成功：' + (sw1.msg || ''))
    const afterPub = pkRoom().pkPublic
    assert.notStrictEqual(afterPub.r + ':' + afterPub.s, beforePub.r + ':' + beforePub.s,
      '⑬b ★ 换完之后公共牌必须真的变了')
    assert.strictEqual(sw1.room.poker.myDrink, 1, '⑬b ★ 换公共牌要喝 1 杯，实际 ' + sw1.room.poker.myDrink)
    assert.ok(sw1.room.poker.last && /公共底牌/.test(sw1.room.poker.last.noteText || ''),
      '⑬b ★ 换牌也要有说明文字（模板同一个 .pkl-note 在渲染）')
    /* 换手牌：再喝半杯，累计 1.5 */
    const sw2 = await room.main({ action: 'pkAct', act: 'swapMine', id: pkId })
    assert.ok(sw2.ok, '⑬b 换手牌应成功：' + (sw2.msg || ''))
    assert.strictEqual(sw2.room.poker.myDrink, 1.5, '⑬b ★ 换手牌喝半杯，累计应为 1.5，实际 ' + sw2.room.poker.myDrink)
    /* 换完回合不推进 —— 还能接着操作 */
    assert.strictEqual(pkRoom().turn, pkCur0.seat, '⑬b 换牌不推进回合（喝完还能继续决定）')
    /* 所有人的牌 + 公共牌仍然不重复（52 张不丢不重） */
    const allNow = [pkRoom().pkPublic]
      .concat(pkRoom().players.filter(p => p.inRound !== false).map(p => p.cards).flat())
      .map(c => c && c.r + ':' + c.s)
    assert.strictEqual(new Set(allNow).size, allNow.length, '⑬b ★ 换牌后牌不能重复（52 张不丢不重）')
    ok('★ 换牌：换公共牌喝 1 杯、换手牌喝半杯，累计记账且不推进回合')
  }

  /* 继续打完：剩下两人，轮到的人弃牌 → 只剩一人 → 结束 */
  const pkLeft = pkRoom().players.filter(p => !p.out)
  assert.strictEqual(pkLeft.length, 2, '⑬ 比一次后应剩 2 人，实际 ' + pkLeft.length)
  const pkCurP = pkLeft.filter(p => p.seat === pkRoom().turn)[0]
  assert.ok(pkCurP, '⑬ 剩余两人里应该有一个是当前轮的人')
  const pkWinnerP = pkLeft.filter(p => p.seat !== pkCurP.seat)[0]
  OPENID = pkCurP.openid
  const pkFold = await room.main({ action: 'pkAct', act: 'fold', id: pkId })
  assert.ok(pkFold.ok, '⑬ 弃牌应成功：' + (pkFold.msg || ''))
  assert.strictEqual(pkFold.room.phase, 'over', '⑬ 只剩一人时必须自动结束')
  assert.strictEqual(pkFold.room.poker.winner, pkWinnerP.name, '⑬ 赢家应是那个没弃牌的人')
  const pkHands = pkFold.room.lastResult && pkFold.room.lastResult.hands
  assert.ok(Array.isArray(pkHands) && pkHands.length === 3, '⑬ 结算要把三个人的牌摊开')
  assert.ok(pkHands.every(h => Array.isArray(h.cards) && h.cards.length === 3),
    '⑬ 结算的每手都必须是完整的三张')
  ok('★ 弃牌 → 只剩一人自动结束，结算摊开三人各自的三张牌')

  /* ============ ⑮ 房主离开后接任的人必须能玩 ============ *
   *
   * 死路（修之前存在）：3 人局 → 两人中途加入只能观战 →
   * 原有的 3 人陆续离开 → 房主落到观战者头上，而他 inRound 仍是 false。
   * 此时点"开始"：start 按 inRound 过滤，**没人发骰子、没人参与**，
   * 一个人时直接卡死（turn 指向空气），而且一句错误都没有。
   */
  {
    OPENID = A
    const mk = await room.main({ action: 'create', game: 'liar', name: '房主A' })
    const RID = mk.room.id
    const RCODE = mk.room.code

    /* 再进来两个人，凑成 3 人局后开局 */
    OPENID = B; await room.main({ action: 'join', code: RCODE, name: 'B' })
    OPENID = 'D'; await room.main({ action: 'join', code: RCODE, name: 'D' })

    OPENID = A
    await room.main({ action: 'start', id: RID })
    store.rooms.filter(x => x._id === RID)[0].countdownEnd = Date.now() - 100
    await room.main({ action: 'status', id: RID })

    /* 中途再来一个人 —— 只能观战 */
    OPENID = 'E'
    const mid = await room.main({ action: 'join', code: RCODE, name: 'E' })
    assert.ok(mid.ok, '中途加入应成功：' + (mid.msg || ''))
    let doc = store.rooms.filter(x => x._id === RID)[0]
    assert.strictEqual(doc.players.filter(p => p.openid === 'E')[0].inRound, false,
      '中途加入者本局应观战')

    /* 原有参与者全部离开，只剩中途加入的 E */
    for (const who of [A, B, 'D']) {
      OPENID = who
      await room.main({ action: 'leave', id: RID })
    }

    doc = store.rooms.filter(x => x._id === RID)[0]
    assert.ok(doc, '房间不该因为参与者走光而解散（E 还在）')
    assert.strictEqual(doc.hostOpenid, 'E', '房主应转给剩下的那个人')
    const E = doc.players.filter(p => p.openid === 'E')[0]
    assert.strictEqual(E.inRound, true,
      '★ 接任房主的观战者必须被纳入本局 —— 否则他点开始后没人参与（一个人时直接卡死）')

    /*
     * 而他确实能开局，并且拿到骰子。
     * ⚠️ 这里必须带 solo:true —— 2026-10-28 起服务端会按玩法下限拦人数，
     *    而这个用例是"一个人靠接任房主留下来"的场景，本来就凑不够 2 人。
     *    （这条不是"为了方便而放行"：它测的是**接任房主后还能不能开局**，
     *      人数够不够是另一件事，已在 ⑨ 单独锁过。）
     */
    OPENID = 'E'
    const st = await room.main({ action: 'start', id: RID, solo: true })
    assert.ok(st.ok, '接任房主应该能开局：' + (st.msg || ''))
    doc = store.rooms.filter(x => x._id === RID)[0]
    const E2 = doc.players.filter(p => p.openid === 'E')[0]
    assert.ok(Array.isArray(E2.dice) && E2.dice.length === 5,
      '★ 开局后他自己必须有 5 颗骰子 —— 否则这一局没有任何人能玩')
    ok('★ 房主离开后接任的观战者会被纳入本局（不会开局即卡死）')
  }

  /* ============ ⑭ 房间容量必须按玩法取 ============ *
   *
   * 注册表里每个玩法写着各自的 max，而云端原来用一个全局 MAX_PLAYERS=8 ——
   * 两个方向都不对：
   *   · 卧底 max=12，被全局 8 挡住，12 人根本进不来（"支持 12 人"是假的）
   *   · 金花 max=6，全局 8 却允许第 7、8 个人进来（超员）
   * 这条断言锁"按玩法取上限"，并禁止再出现裸的全局容量判断。
   */
  {
    const { gameOf: capGameOf } = require(path.join(ROOT, 'miniprogram/utils/games.js'))
    const pkCap = capGameOf('poker').max
    const uwCap = capGameOf('undercover').max
    assert.strictEqual(pkCap, 6, '金花的 max 应该是 6')
    assert.strictEqual(uwCap, 12, '卧底的 max 应该是 12')
    assert.ok(uwCap > 8, '★ 卧底上限必须大于 8 —— 否则"最多 12 人"是假的')

    /*
     * ⚠️ 判据第一版写的是 `length\s*[<>]=?\s*MAX_PLAYERS` ——
     *    只抓"直接比"这一种写法。把代码改成 `const cap = MAX_PLAYERS` 就绕过去了，
     *    反向验证当场发现（改坏后断言照样通过）。
     *    现在改成：**除 gameCap 函数体之外，整个云函数里不允许出现 MAX_PLAYERS**。
     */
    let cloudSrc = fs.readFileSync(
      path.join(ROOT, 'cloudfunctions/room/index.js'), 'utf8')
      .replace(/\/\*[\s\S]*?\*\//g, '')
      .replace(/(^|[^:])\/\/[^\n]*/g, '$1')
    /* 把 gameCap 的函数体整段挖掉（它是唯一允许用兜底值的地方） */
    const capAt = cloudSrc.indexOf('function gameCap')
    assert.ok(capAt > 0, '找不到 gameCap —— 抽取可能失效')
    const open = cloudSrc.indexOf('{', capAt)
    let depth = 0, close = -1
    for (let k = open; k < cloudSrc.length; k++) {
      if (cloudSrc[k] === '{') depth++
      else if (cloudSrc[k] === '}') { depth--; if (depth === 0) { close = k; break } }
    }
    assert.ok(close > open, 'gameCap 的括号没配平')
    /*
     * 只检查 gameCap **之后**的部分 ——
     * 定义行 `const MAX_PLAYERS = 8` 和 gameCap 内部的兜底都是合法的，
     * 它们都在 gameCap 之前或之内。
     * （第一版连定义行也算了，导致正常代码报错 —— 反向验证时才发现。）
     */
    const outside = cloudSrc.slice(close + 1)
    const stray = Array.from(outside.matchAll(/\bMAX_PLAYERS\b/g))
    assert.strictEqual(stray.length, 0,
      '★ gameCap 之外还有 ' + stray.length + ' 处直接引用 MAX_PLAYERS —— ' +
      '容量必须按玩法取（gameCap(玩法)），全局值只作兜底')
    ok('★ 房间容量按玩法取（金花 6 / 卧底 12 / 全局 8 只作兜底）')
  }


  console.log(`\n${'='.repeat(58)}`)
  console.log(`  多人房间：全部 ${n} 项断言通过`)
  console.log(`${'='.repeat(58)}\n`)
})().catch(e => {
  console.error('\n  ✗ 断言失败：', e.message, '\n')
  process.exit(1)
})
