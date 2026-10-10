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
    require('path').join(__dirname, '..', 'miniprogram/pages/game/room/room.js'), 'utf8')
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
  assert.ok((rollA.room.me.dice || []).length === 2, '摇骰子每人 2 颗')
  const leaked = (rollA.room.players || []).some(p => !p.isMe && Array.isArray(p.dice) && p.dice.length)
  assert.ok(!leaked, '★ 不能把别人的骰子点数发到前端（抓到就等于作弊）')
  ok('★ A 摇完：有自己的点数、别人的不可见、暂不出结果')
  OPENID = B
  const rollB = await room.main({ action: 'roll', id: drId })
  assert.ok(rollB.ok, 'B 摇应成功：' + (rollB.msg || ''))
  assert.ok(rollB.result, '★ 全员摇完必须自动出结果（这是「已摇完自动开结果」的入口）')
  assert.ok(Array.isArray(rollB.result.ranked) && rollB.result.ranked.length === 2, '结果要有两个人的排名')
  ok('★ 摇骰子：A 摇 → B 摇 → 自动出结果')

  console.log(`\n${'='.repeat(58)}`)
  console.log(`  多人房间：全部 ${n} 项断言通过`)
  console.log(`${'='.repeat(58)}\n`)
})().catch(e => {
  console.error('\n  ✗ 断言失败：', e.message, '\n')
  process.exit(1)
})
