/**
 * room —— 多人游戏房间
 *
 * ============ 和现有云函数最大的不同 ============
 *
 * 之前所有集合都挂 `pairId`（两个人配对的小窝），但多人游戏不能这样：
 *   · 房间是**临时**的 —— 玩完就散，不该长期占着数据库
 *   · 人数任意 —— 3 个人、5 个人都可能，不是固定两人
 *   · 不同微信号进来 —— 没有"配对"关系，靠**房间码**聚到一起
 *
 * 所以这里是独立的一套：房间码 + 玩家列表 + 房主机制。
 *
 * ============ 三个关键设计 ============
 *
 * ① **状态由服务端算，不信任前端**。
 *    谁该出牌、轮到谁、谁赢了 —— 全部在云函数里判定。
 *    前端只负责"显示服务端说的状态"和"发起操作请求"。
 *    这和双盲解锁是同一套思路：把判断放服务端。
 *
 * ② **每个玩家只能看到自己该看的**。
 *    大话骰这类游戏，自己的骰子只有自己能看 ——
 *    接口按 openid 过滤，别人的骰子在服务端就被丢掉了，
 *    不是"发过去前端藏起来"（那样抓包就穿了）。
 *
 * ③ **房主离开要转移**，不能让房间变成没人能管的死局。
 *
 * ============ 为什么用轮询而不是 watch ============
 * 云数据库的 watch 能做实时推送，但它要维持长连接，
 * 且在小程序端需要处理断线重连。酒桌游戏的操作间隔是秒级，
 * 1.2 秒轮询的体感已经"实时"了，且实现简单、失败可重试。
 * 房间数据很小（一个文档），轮询成本可以忽略。
 */
const cloud = require('wx-server-sdk')
cloud.init({ env: cloud.DYNAMIC_CURRENT_ENV })

const db = cloud.database()
const _ = db.command
const rooms = db.collection('rooms')

/*
 * 房间码：**3 位纯数字**（000~999）。
 *
 * 2026-10-09 用户要求「房间号简单一点，纯数字即可，三个数」。
 * 原来是 6 位 × 32 字符集（去掉 I/O/0/1 这些容易看错的字符）。
 *
 * ★★ 但 3 位只有 1000 个号，撞码从"可忽略"变成"必须处理"：
 *    按生日问题算，同时有 10 个活跃房间时撞码概率就有 4.4%，20 个时 17%。
 *    自用产品通常只有 1~2 个房间，够用 —— 但**不能靠概率**，因为
 *    撞码的后果不是"重开一次"，而是**进错房间**：
 *    join 里是 `where({code, active:true}).limit(1)` 取第一个匹配，
 *    两个活跃房间同号时，玩家会静默进到别人的房间去。
 *
 *    所以建号改成**穷举去重**（见 pickCode）：列出所有已被占用的号，
 *    从剩下的里随机挑。这样在号码空间耗尽前**保证不重复**。
 *
 * ⚠️ 纯数字的附带好处：不用再处理大小写（原 normCode 要 toUpperCase）。
 */
const DIGITS = '0123456789'
const CODE_LEN = 3
/* 号码空间 = 1000；用满就没号可发，要明确提示而不是死循环 */
const CODE_SPACE = 1000

/* 房间存活时间：2 小时没人动就当作废弃。
   酒桌游戏一局最多几十分钟，2 小时足够宽松。 */
const TTL_MS = 2 * 3600 * 1000

/* 单房间人数上限 —— 一部手机传着玩，人太多轮不过来 */
const MAX_PLAYERS = 8

/* 开局倒计时：3 秒。太短来不及反应，太长会等得烦 */
const COUNTDOWN_MS = 3200

/*
 * 转盘扇区 —— ★ 必须与前端 miniprogram/pages/game/room/room.js 的
 * SECTORS 完全一致（键、权重、文案）。不一致会导致
 * 「指针指着喝一杯、判出来是真心话」，最伤信任。
 * scripts/test-wheel.js 会断言两边一致。
 */
const WHEEL_SECTORS = [
  { k: 'truth', t: '真心话', weight: 22 },
  { k: 'dare',  t: '大冒险', weight: 20 },
  { k: 'drink', t: '喝一杯', weight: 18 },
  { k: 'you',   t: '你喝',   weight: 14 },
  { k: 'me',    t: '我喝',   weight: 12 },
  { k: 'both',  t: '一起喝', weight: 8 },
  { k: 'pass',  t: '免罚一次', weight: 6 }
]

/**
 * 生成一个还在用的房间号。
 *
 * ★ 为什么不是"随机生成 + 撞了就重试"：
 *   3 位只有 1000 个号。随机重试在房间多起来后会**反复撞**，
 *   重试 5 次全失败就只能报错让用户重开 —— 体验差且不可控。
 *
 *   改成**穷举去重**：一次查出所有活跃房间的号，从"没被占用的"里随机挑。
 *   代价是每次建房多一次查询（本来就要查重，成本一样），
 *   换来的是**号码空间耗尽前绝不重复** —— 这才是"不靠概率"。
 *
 * @returns {Promise<string|null>} 可用号码；null = 号码用满了
 */
async function pickCode() {
  /*
   * ★★ 只统计**未过期**的房间（2026-10-09 修的真实缺陷）。
   *
   * 老写法是 `where({ active: true })`，但 **active 永远不会被置回 false** ——
   * 全项目只有一处把它设成 false（房主主动解散时），
   * 房间里的人直接退出去、或者干脆关掉小程序，房间就一直挂着 active:true。
   *
   * 而 3 位号码只有 1000 个。过期房间占着号不放 → **号码池只减不增**：
   *   每天 10 局 → 100 天后永久报「房间号用满了，等一会儿再开」
   *   （而且"等一会儿"永远不会好，因为没有任何机制回收号码）
   *
   * 为什么"过期就该释放"是成立的：`loadRoom` / `join` 里都有
   * `isStale(room) → 拒绝`，**过期房间本来就谁也进不去** ——
   * 它占着号码是纯粹的浪费，不是"保护"。
   *
   * 用 updatedAt 做时间下界（心跳每轮都会刷新它），而不是遍历后再过滤：
   * 让数据库只返回真正可能冲突的那些行。
   * ⚠️ 兼容老数据：createdAt 缺失时用 updatedAt 兜底，两者都没有则视为"很旧"。
   */
  const aliveSince = now() - TTL_MS
  const r = await rooms.where({
    active: true,
    updatedAt: _.gt(aliveSince)
  }).field({ code: true }).limit(CODE_SPACE).get()
    .catch(() => ({ data: [] }))
  const used = new Set((r.data || []).map(x => x.code))

  if (used.size >= CODE_SPACE) return null      // 号发完了

  /*
   * 先从**全部号码**里随机起点、顺序找第一个没占用的。
   * 不用"列出所有空闲号再随机挑" —— 那要建一个 1000 元素的数组，
   * 而 1000 以内顺序探测最多 1000 次、每次都只是 Set 查找，够快。
   * 随机起点是为了让号码分散，不是每次都从 000 开始。
   */
  const start = Math.floor(Math.random() * CODE_SPACE)
  for (let i = 0; i < CODE_SPACE; i++) {
    const c = String((start + i) % CODE_SPACE).padStart(CODE_LEN, '0')
    if (!used.has(c)) return c
  }
  return null
}

/** 房间号归一化：只留数字，最多 3 位。纯数字就不用处理大小写了 */
function normCode(c) {
  return String(c || '').replace(/\D/g, '').slice(0, CODE_LEN)
}

function now() { return Date.now() }

/** 内容安全。fail-closed（发布策略）：检查不通过或服务不可用都拒绝 */
async function safe(text, openid) {
  if (!text) return { pass: true }
  try {
    const r = await cloud.openapi.security.msgSecCheck({
      content: text, openid: openid, scene: 2, version: 2
    })
    const s = r && r.result && r.result.suggest
    if (s && s !== 'pass') return { pass: false, msg: '这里有系统判断为风险的内容，改一改' }
    return { pass: true }
  } catch (err) {
    /*
     * 把真实错误码带回前端 —— 否则只能看到「服务不可用」这句笼统的话，
     * 没法区分是「接口挂了」「权限没绑」还是「调用参数不对」。
     * 开发阶段带 errCode，上线后可以按需收紧。
     */
    const code = (err && (err.errCode || err.code)) || 'unknown'
    const detail = (err && (err.errMsg || err.message)) || ''
    console.error('[room] msgSecCheck 调用失败：', code, detail)
    return {
      pass: false,
      code: 'SEC_UNAVAILABLE',
      msg: '内容检查服务暂时不可用，稍后再试',
      /* 带上错误码 —— 否则日志里只有「服务不可用」这句笼统的话，
         没法区分是接口挂了、权限没绑、还是调用参数不对。
         实测踩过：新函数部署后 openapi 权限需要几次部署才绑定生效，
         没有错误码时完全看不出是这个原因。 */
      _code: code
    }
  }
}

/** 房间是否已过期（废弃） */
function isStale(room) {
  return now() - (room.updatedAt || room.createdAt || 0) > TTL_MS
}

/**
 * 给前端的房间视图。
 * ★ 关键：骰子按 openid 过滤 —— 别人的骰子不在响应里。
 */
function shape(room, openid) {
  const players = (room.players || []).map(p => ({
    openid: p.openid,
    name: p.name,
    seat: p.seat,
    isMe: p.openid === openid,
    isHost: p.openid === room.hostOpenid,
    online: now() - (p.lastSeen || 0) < 30000,   // 30 秒内有心跳算在线
    ready: !!p.ready,
    score: p.score || 0,
    /* ★ 只有自己的骰子才返回；别人的在服务端就丢掉 */
    dice: p.openid === openid ? (p.dice || []) : undefined,
    diceCount: (p.dice || []).length
  }))

  const me = players.filter(p => p.isMe)[0] || null

  return {
    id: room._id,
    code: room.code,
    game: room.game || '',          // 'dice' | 'liar' | 'wheel'
    phase: room.phase || 'lobby',   // lobby | countdown | playing | over
    host: room.hostOpenid === openid,
    me: me ? { seat: me.seat, name: me.name, dice: me.dice || [] } : null,
    players: players,
    count: players.length,
    /* 游戏相关的公共状态（不含任何人的私密骰子） */
    /* 倒计时剩余毫秒（前端本地算更准，这里给基准） */
    countdownMs: room.phase === 'countdown' ? Math.max(0, (room.countdownEnd || 0) - now()) : 0,
    turn: room.turn || 0,           // 轮到第几号座位
    round: room.round || 0,
    bid: room.bid || null,          // 大话骰：当前叫骰
    lastResult: room.lastResult || null,
    streaks: room.streaks || {},
    /* 转盘：当前这一转的结果（所有人靠它同步看到同一个扇区） */
    spin: room.spin || null,
    updatedAt: room.updatedAt || 0
  }
}

/** 统一取房间：按 id 或 code，并校验"我是不是房间里的人" */
async function loadRoom(event, openid, needMember) {
  let room = null
  if (event.id) {
    const r = await rooms.doc(String(event.id)).get().catch(() => null)
    room = r && r.data
  } else if (event.code) {
    /*
     * 按 code 找房间。
     * ★ pickCode 已保证活跃房间的号不重复，所以这里 limit(1) 是安全的；
     *   万一历史数据里有重复（旧版 6 位号残留），也只影响那一批旧房间。
     */
    const r = await rooms.where({ code: normCode(event.code), active: true }).limit(1).get().catch(() => ({ data: [] }))
    room = (r.data || [])[0]
  }
  if (!room) return { err: '房间不存在或已解散' }
  if (isStale(room)) return { err: '房间已过期（超过 2 小时没人玩了）' }
  const isMember = (room.players || []).some(p => p.openid === openid)
  if (needMember && !isMember) return { err: '你不在这个房间里' }
  return { room, isMember }
}

exports.main = async (event) => {
  const { OPENID } = cloud.getWXContext()
  const action = event.action || 'status'
  const ts = now()

  try {
    /* ================= 建房间 ================= */
    if (action === 'create') {
      const name = String(event.name || '').trim().slice(0, 12) || '玩家1'
      const game = ['dice', 'liar', 'wheel'].indexOf(event.game) >= 0 ? event.game : 'dice'

      const sec = await safe(name, OPENID)
      /*
       * 这里原来写的是 `_debug: sec._debug` —— 而 safe() 返回的字段叫 **`_code`**
       * （见 safe 里 `return { pass:false, code:'SEC_UNAVAILABLE', _code: code }`）。
       * 取一个不存在的字段 → 恒为 undefined，**排查信息实际没传到前端**，
       * 而它正是当初为了排查"openapi 权限没绑"才加的。
       * 改成正确的 `_code`，让那条排查线索真的可用。
       */
      if (!sec.pass) return { ok: false, msg: sec.msg, _code: sec._code }
      /*
       * 关于 `_code` 的安全性（想清楚了再改）：
       *   它是微信 openapi 的错误码（如 -601059），**不含 openid / 数据库 id / 堆栈**，
       *   前端也不展示它（只进 console 和日志）。它是"权限没绑 vs 接口挂了"的
       *   唯一区分线索 —— 去掉它等于把当初踩过的坑重新埋一遍。
       *   若将来要收紧，应该按环境开关，而不是直接删。
       */

      /*
       * 房间号：3 位数字，**穷举去重**（见 pickCode）。
       * 原来这里是"随机生成 + count 查重 + 重试 5 次" ——
       * 6 位 32 字符集时够用，但 3 位只有 1000 个号，
       * 房间一多就会反复撞、重试完还失败。改成一次查全、挑空闲的。
       */
      const code = await pickCode()
      if (!code) {
        return { ok: false, msg: '房间号用满了（同时最多 1000 个房间），等一会儿再开' }
      }

      const added = await rooms.add({
        data: {
          code: code,
          game: game,
          phase: 'lobby',
          hostOpenid: OPENID,
          players: [{
            openid: OPENID, name: name, seat: 1,
            ready: false, score: 0, dice: [],
            joinedAt: ts, lastSeen: ts
          }],
          turn: 0,
          round: 0,
          bid: null,
          lastResult: null,
          active: true,
          createdAt: ts,
          updatedAt: ts
        }
      })
      const r = await rooms.doc(added._id).get()
      return { ok: true, room: shape(r.data, OPENID) }
    }

    /* ================= 加入 ================= */
    if (action === 'join') {
      const code = normCode(event.code)
      if (code.length !== CODE_LEN) return { ok: false, msg: '房间号是 3 位数字' }

      const name = String(event.name || '').trim().slice(0, 12) || ('玩家')
      const sec = await safe(name, OPENID)
      if (!sec.pass) return { ok: false, msg: sec.msg }

      const r0 = await rooms.where({ code: code, active: true }).limit(1).get().catch(() => ({ data: [] }))
      const room = (r0.data || [])[0]
      if (!room) return { ok: false, code: 'NO_ROOM', msg: '没找到这个房间，确认一下房间号' }
      if (isStale(room)) return { ok: false, code: 'STALE', msg: '这个房间已经过期了，让房主重新开一个' }

      const already = (room.players || []).some(p => p.openid === OPENID)
      if (already) {
        /* 已在房里（比如退出重进）→ 只刷新心跳，不重复加人 */
        const players = room.players.map(p => p.openid === OPENID ? Object.assign({}, p, { lastSeen: ts, name: name || p.name }) : p)
        await rooms.doc(room._id).update({ data: { players: players, updatedAt: ts } })
        const rr = await rooms.doc(room._id).get()
        return { ok: true, room: shape(rr.data, OPENID), rejoined: true }
      }

      if ((room.players || []).length >= MAX_PLAYERS) {
        return { ok: false, msg: '房间满了（最多 ' + MAX_PLAYERS + ' 人）' }
      }
      if (room.phase !== 'lobby') {
        return { ok: false, msg: '这局已经开始了，等他们打完再进' }
      }

      /*
       * ★★ 用**原子 push** 追加，不要整数组覆盖写（2026-10-09 修竞态）。
       *
       * 老写法是「读 room → 拼一个新数组 → 整数组写回」。问题是读和写之间有窗口：
       * 两个人同时点「进去」时，双方都读到同样的 3 人列表、都算出 seat=4，
       * 然后**后写的覆盖先写的** —— 结果只进来一个人，另一个静默消失
       * （他的请求返回 ok:true，界面上却不在房间里，下一轮轮询才被踢回大厅）。
       *
       * `_.push` 是数据库端的原子追加，天然消除"读-改-写"窗口。
       */
      await rooms.doc(room._id).update({
        data: {
          players: _.push([{
            openid: OPENID, name: name, seat: 0,     // seat 稍后统一重编号
            ready: false, score: 0, dice: [],
            joinedAt: ts, lastSeen: ts
          }]),
          updatedAt: ts
        }
      })

      /* 追加后重读：并发下可能几个人同时通过了容量检查，必须复查 */
      const rr = await rooms.doc(room._id).get()
      let finalPlayers = (rr.data && rr.data.players) || []

      /* 超员 → 把自己摘出去（同样是整写，但此时只有"我"这一个变量） */
      if (finalPlayers.length > MAX_PLAYERS) {
        finalPlayers = finalPlayers.filter(p => p.openid !== OPENID)
        await rooms.doc(room._id).update({ data: { players: finalPlayers, updatedAt: ts } }).catch(() => {})
        return { ok: false, msg: '房间满了（最多 ' + MAX_PLAYERS + ' 人）' }
      }

      /*
       * ★ 座位按最终顺序重编号 —— 保证 seat 是 1..N 连续且唯一。
       *
       * 为什么必须做：并发追加时两个人先都拿到 seat=0（占位），
       * 不重编号就会出现"两个座位相同"的情况。而 `turn` 是按 seat 找人的
       * （`players.filter(p => p.seat === room.turn)`）——
       * 座位重复意味着**回合永远轮不到其中一个**，游戏卡死且不报错。
       * 这和 leave 里的"退出后重编号"是同一个不变式，两处都要维持。
       */
      const seatsOk = finalPlayers.every((p, i) => p.seat === i + 1)
      if (!seatsOk) {
        finalPlayers = finalPlayers.map((p, i) => Object.assign({}, p, { seat: i + 1 }))
        await rooms.doc(room._id).update({ data: { players: finalPlayers, updatedAt: ts } })
      }

      return { ok: true, room: shape(Object.assign({}, rr.data, { players: finalPlayers }), OPENID) }
    }

    /* ================= 房间状态（轮询用） ================= */
    if (action === 'status') {
      let { room, err } = await loadRoom(event, OPENID, false)
      if (err) return { ok: false, code: 'NO_ROOM', msg: err }

      /* ★ 倒计时到点 → 自动进入 playing。
         为什么放在 status 里做：云函数没有定时器，必须靠"有人来问"这个时机推进。
         轮询正好提供了这个时机（每 1.5 秒有人问一次）。
         谁先问到谁触发，其他人下一次轮询就看到新状态 —— 不需要锁，
         因为这一步是幂等的（重复推进结果一样）。 */
      if (room.phase === 'countdown' && ts >= (room.countdownEnd || 0)) {
        await rooms.doc(room._id).update({
          data: { phase: 'playing', updatedAt: ts }
        }).catch(() => {})
        room = Object.assign({}, room, { phase: 'playing' })
      }

      /* 顺手刷新心跳 —— 前端轮询的同时就把"我还活着"告诉服务端，
         省一次专门的请求 */
      const isMember = (room.players || []).some(p => p.openid === OPENID)
      if (isMember) {
        const players = room.players.map(p => p.openid === OPENID ? Object.assign({}, p, { lastSeen: ts }) : p)
        /* 只在心跳确实变旧时才写库，避免每次轮询都写（省写入次数与费用） */
        const mine = room.players.filter(p => p.openid === OPENID)[0]
        if (ts - (mine.lastSeen || 0) > 10000) {
          await rooms.doc(room._id).update({ data: { players: players } }).catch(() => {})
        }
      }
      return { ok: true, room: shape(room, OPENID) }
    }

    /* ================= 开局 ================= */
    if (action === 'start') {
      const { room, err } = await loadRoom(event, OPENID, true)
      if (err) return { ok: false, msg: err }
      if (room.hostOpenid !== OPENID) return { ok: false, msg: '只有房主能开局' }
      if ((room.players || []).length < 2) return { ok: false, msg: '至少两个人才能开始' }
      /*
       * ★ 必须把 countdown 也拦掉（2026-10-09 安全审计发现）。
       *
       * 原来只拦 `playing`，于是房主在 3.2 秒倒计时窗口内重复调用 start，会：
       *   · 反复重置 countdownEnd（永远开不了局）
       *   · **重新生成大话骰的骰子** —— 前一秒偷看过的点数突然变了，
       *     玩家会以为"这游戏作弊"（而骰子确实是重新摇的）
       *
       * 前端此时按钮已隐藏，所以正常操作碰不到；但云函数是公开接口，
       * 直接调用可达 —— 这类"前端藏了、后端没拦"的缺口必须后端补。
       */
      if (room.phase === 'countdown' || room.phase === 'playing') {
        return { ok: false, msg: '这局已经开始了' }
      }

      /* 骰子由**服务端**生成 —— 前端只拿自己的。
         这和"前端摇完上报"有本质区别：那样抓包就能看到别人的点数。

         ★ 大话骰：开局就给每人发好 5 颗 —— 这是玩法本身，
           骰子一开局就定好、藏在盅下等人偷看，所以必须开局就有。

         ★ 摇骰子比大小：**必须等各人自己摇时才生成**。
           这是 2026-10-08 用户实测报「双人交互不智能」时挖出来的 bug ——
           原来这里也给**所有人**预生成了骰子，导致两件事都不对：
             ① 「等其他人摇」形同虚设 —— allRolled 永远成立，
                你一摇就立刻出结果，别人根本不用摇
             ② 别人的骰子在**你摇之前就已经定了**（前端看不到，
                但"等"的仪式感没了，而且白生成了一堆没用的数据）
           所以 dice 房间开局一律发空数组，谁摇谁生成。

         ★ 转盘不需要骰子（它靠 spin 抽扇区），同样跳过。 */
      const players = (room.players || []).map(p => {
        if (room.game === 'wheel' || room.game === 'dice') {
          return Object.assign({}, p, { dice: [], ready: false })
        }
        const n = room.game === 'liar' ? 5 : 2
        const dice = []
        for (let i = 0; i < n; i++) dice.push(1 + Math.floor(Math.random() * 6))
        return Object.assign({}, p, { dice: dice, ready: false })
      })

      /* ★ 进入"开局倒计时"而不是直接开始 —— 商业多人游戏的标配。
         为什么必须有：骰子在这一刻已经生成好了，但玩家还在看别人的名字、
         还没把手机放好。直接开局 = 有人错过第一轮叫骰。
         3 秒倒计时给所有人一个"要开始了"的缓冲。 */
      await rooms.doc(room._id).update({
        data: {
          players: players,
          phase: 'countdown',
          countdownEnd: ts + COUNTDOWN_MS,
          round: (room.round || 0) + 1,
          turn: 1,
          bid: null,
          /* ★ 新一局必须清掉上一转的结果，否则前端一进 playing
             就会看到"上一局转出来的扇区"，误以为这局已经转过了 */
          spin: null,
          lastResult: null,
          updatedAt: ts
        }
      })
      const rr = await rooms.doc(room._id).get()
      return { ok: true, room: shape(rr.data, OPENID) }
    }

    /* ================= 大话骰：叫骰 ================= */
    if (action === 'bid') {
      const { room, err } = await loadRoom(event, OPENID, true)
      if (err) return { ok: false, msg: err }
      if (room.phase !== 'playing') return { ok: false, msg: '这局还没开始' }

      const mySeat = (room.players || []).filter(p => p.openid === OPENID)[0]
      if (!mySeat) return { ok: false, msg: '你不在这个房间里' }
      if (room.turn !== mySeat.seat) return { ok: false, msg: '还没轮到你' }

      const n = Number(event.n)
      const face = Number(event.face)
      const zhai = !!event.zhai
      /*
       * ★ 必须校验**整数**，不只是范围（2026-10-09 安全审计发现）。
       *
       * 范围判断挡不住小数：`2.5 >= 1 && 2.5 <= 10` 成立 → 会落库。
       * 后果不是"数据难看"，而是**玩法被破坏**：
       *   开骰时按 face 精确匹配数骰子（`dice.filter(d => d === face)`），
       *   face=3.7 永远命中 0 颗 → 无论实际有没有 3 点，
       *   判定都是"叫的人输了"→ 谁叫谁输，一局就废了。
       *
       * （顺带澄清：`NaN` 其实**会**被范围判断拦住 —— `NaN >= 1` 为 false。
       *   审计报告说"NaN 直接落库"不准确，真实缺口是小数。）
       */
      if (!Number.isInteger(n) || n < 1 || n > (room.players || []).length * 5) {
        return { ok: false, msg: '数量不对' }
      }
      if (!Number.isInteger(face) || face < 1 || face > 6) {
        return { ok: false, msg: '点数不对' }
      }

      /* 必须比上一个大 —— 服务端判定，不信任前端算好的结果 */
      const cur = room.bid
      if (cur) {
        const okHigher = n > cur.n || (n === cur.n && face > cur.face)
        if (!okHigher) return { ok: false, msg: '只能往上叫（数量变大，或数量同、点数大）' }
      }

      const nextSeat = mySeat.seat >= (room.players || []).length ? 1 : mySeat.seat + 1
      await rooms.doc(room._id).update({
        data: {
          bid: { n: n, face: face, zhai: zhai, bySeat: mySeat.seat, byName: mySeat.name, at: ts },
          turn: nextSeat,
          updatedAt: ts
        }
      })
      const rr = await rooms.doc(room._id).get()
      return { ok: true, room: shape(rr.data, OPENID) }
    }

    /* ================= 大话骰：开骰 ================= */
    if (action === 'open') {
      const { room, err } = await loadRoom(event, OPENID, true)
      if (err) return { ok: false, msg: err }
      if (room.phase !== 'playing') return { ok: false, msg: '这局还没开始' }
      const cur = room.bid
      if (!cur) return { ok: false, msg: '还没人叫骰' }

      const mySeat = (room.players || []).filter(p => p.openid === OPENID)[0]
      if (!mySeat) return { ok: false, msg: '你不在这个房间里' }
      if (room.turn !== mySeat.seat) return { ok: false, msg: '还没轮到你' }

      /* 统计全场骰子（1 是否万能由 zhai 决定） */
      let actual = 0
      ;(room.players || []).forEach(p => {
        (p.dice || []).forEach(d => {
          if (d === cur.face) actual++
          else if (d === 1 && !cur.zhai && cur.face !== 1) actual++
        })
      })

      const bidderWins = actual >= cur.n
      /* 叫的人没吹牛 → 开的人输；吹了 → 叫的人输 */
      const loserSeat = bidderWins ? mySeat.seat : cur.bySeat

      const result = {
        need: cur.n, face: cur.face, zhai: cur.zhai,
        actual: actual, bidderWins: bidderWins,
        loserSeat: loserSeat,
        loserName: ((room.players || []).filter(p => p.seat === loserSeat)[0] || {}).name || '?',
        bidderName: cur.byName,
        /* ★ 开骰后才亮出所有人的骰子 */
        allDice: (room.players || []).map(p => ({ name: p.name, seat: p.seat, dice: p.dice || [] }))
      }

      const players = (room.players || []).map(p =>
        p.seat === loserSeat ? Object.assign({}, p, { score: (p.score || 0) - 1 }) : p)

      await rooms.doc(room._id).update({
        data: { players: players, phase: 'over', lastResult: result, updatedAt: ts }
      })
      const rr = await rooms.doc(room._id).get()
      return { ok: true, room: shape(rr.data, OPENID), result: result }
    }

    /* ================= 命运转盘（联机） =================
     *
     * 房主点"转"，服务端抽结果，全场同步。
     *
     * ★ 结果必须在这里定，不能让房主前端定 ——
     *   单机版可以本地随机（大家看同一块屏幕），
     *   联机版如果让房主前端算，房主就能改结果（"我要真心话"）。
     *   这是"联网游戏"和"传着玩"的根本区别。
     *
     * 扇区权重必须和前端 buildSectors() 完全一致，
     * 否则会出现「指针指着喝一杯、判出来是真心话」——
     * 这类不一致最伤信任（玩家不会觉得是 bug，会觉得游戏在骗人）。
     * scripts/test-wheel.js 会断言两边权重一致。
     */
    if (action === 'spin') {
      const { room, err } = await loadRoom(event, OPENID, true)
      if (err) return { ok: false, msg: err }
      if (room.phase !== 'playing') return { ok: false, msg: '这局还没开始' }
      if (room.game !== 'wheel') return { ok: false, msg: '这个房间玩的不是转盘' }
      if (room.hostOpenid !== OPENID) return { ok: false, msg: '只有房主能转' }

      /* 权重抽样 */
      const total = WHEEL_SECTORS.reduce((a, s) => a + s.weight, 0)
      let roll = Math.random() * total
      let index = 0
      for (let i = 0; i < WHEEL_SECTORS.length; i++) {
        roll -= WHEEL_SECTORS[i].weight
        if (roll <= 0) { index = i; break }
        index = i
      }
      const sec = WHEEL_SECTORS[index]

      const spin = {
        index: index,
        k: sec.k,
        t: sec.t,
        turns: 4 + Math.floor(Math.random() * 3),   // 4~6 圈，每次不一样
        jitter: (Math.random() - 0.5) * 0.6,        // 扇区内随机偏移（前端会夹紧）
        at: ts
      }

      await rooms.doc(room._id).update({
        data: { spin: spin, lastResult: null, updatedAt: ts }
      })
      const rr = await rooms.doc(room._id).get()
      return { ok: true, room: shape(rr.data, OPENID), spin: spin }
    }

    /* ================= 摇骰子：比大小（多人版） ================= */
    if (action === 'roll') {
      const { room, err } = await loadRoom(event, OPENID, true)
      if (err) return { ok: false, msg: err }
      if (room.phase !== 'playing') return { ok: false, msg: '这局还没开始' }

      /* 每人自己摇自己的 —— 服务端摇，前端只拿结果 */
      const n = room.game === 'liar' ? 5 : (room.diceCount || 2)
      const dice = []
      for (let i = 0; i < n; i++) dice.push(1 + Math.floor(Math.random() * 6))

      const players = (room.players || []).map(p =>
        p.openid === OPENID ? Object.assign({}, p, { dice: dice, rolledAt: ts }) : p)

      const allRolled = players.every(p => (p.dice || []).length > 0)

      let result = null
      if (allRolled) {
        /* 全员摇完 → 算点数排名 */
        const ranked = players.map(p => ({
          name: p.name, seat: p.seat,
          dice: p.dice,
          total: (p.dice || []).reduce((a, b) => a + b, 0)
        })).sort((a, b) => b.total - a.total)
        const top = ranked[0].total
        const winnerSeats = ranked.filter(r => r.total === top).map(r => r.seat)

        /* ★ 连庄（streak）：记录每个人连续赢了几局。
           这是酒桌游戏的真实机制 —— "你又赢了？连庄两把了，加倍喝"。
           不是为了让音效有用才加的：连赢本来就该被说出来。 */
        const prevStreaks = room.streaks || {}
        const streaks = {}
        players.forEach(p => {
          const won = winnerSeats.indexOf(p.seat) >= 0
          streaks[p.seat] = won ? ((prevStreaks[p.seat] || 0) + 1) : 0
        })
        const maxStreak = Math.max(0, ...Object.keys(streaks).map(k => streaks[k]))

        result = {
          ranked: ranked,
          winners: ranked.filter(r => r.total === top).map(r => r.name),
          top: top,
          streaks: streaks,
          /* 连庄次数（1 = 刚赢一局，2 = 连庄，3+ = 连庄多次） */
          maxStreak: maxStreak,
          winnerSeats: winnerSeats
        }
      }

      await rooms.doc(room._id).update({
        data: {
          players: players,
          phase: allRolled ? 'over' : 'playing',
          lastResult: result,
          /* 连庄要跨局保留，所以存在房间上而不是 result 里 */
          streaks: result ? result.streaks : (room.streaks || {}),
          updatedAt: ts
        }
      })
      const rr = await rooms.doc(room._id).get()
      return { ok: true, room: shape(rr.data, OPENID), result: result }
    }

    /* ================= 再来一局 ================= */
    if (action === 'again') {
      const { room, err } = await loadRoom(event, OPENID, true)
      if (err) return { ok: false, msg: err }
      if (room.hostOpenid !== OPENID) return { ok: false, msg: '只有房主能开新一局' }

      /* 清掉骰子和结果，回到大厅 */
      const players = (room.players || []).map(p => Object.assign({}, p, { dice: [], ready: false }))
      await rooms.doc(room._id).update({
        data: {
          players: players, phase: 'lobby',
          bid: null, lastResult: null, turn: 0, updatedAt: ts
        }
      })
      const rr = await rooms.doc(room._id).get()
      return { ok: true, room: shape(rr.data, OPENID) }
    }

    /* ================= 离开 ================= */
    if (action === 'leave') {
      const { room, err } = await loadRoom(event, OPENID, true)
      if (err) return { ok: false, msg: err }

      let players = (room.players || []).filter(p => p.openid !== OPENID)
      let hostOpenid = room.hostOpenid
      let active = true
      const upd = {}

      if (!players.length) {
        /* 最后一个人走了 → 房间解散 */
        active = false
      } else {
        /* 房主走了 → 顺位转移给下一个人（不能让房间变成没人能管的死局） */
        if (hostOpenid === OPENID) hostOpenid = players[0].openid

        /*
         * ★ 座位重编号时必须同步修正 turn，否则回合会指向不存在的座位。
         *
         * 场景：3 人局，轮到 seat2，此时 seat2 退出。
         * 重编号后原来 seat3 变成 seat2，而 turn 还是 2 —— 看起来能对上，
         * 但如果退出的是 seat1（当前回合是 2），重编号后只剩 1、2 两号，
         * turn 仍然是 2 却指向了别人，或者人数减少后 turn 越界，
         * 结果就是"没有任何人轮到"，游戏卡死且不报错。
         *
         * 做法：找出"退出者在原座位序列里的位置"，把 turn 映射到新序列上。
         */
        const oldOrder = (room.players || []).map(p => p.openid)
        const leftIdx = oldOrder.indexOf(OPENID)
        const oldTurn = room.turn || 0

        if (room.phase === 'playing' && oldTurn > 0) {
          if (oldTurn === leftIdx + 1) {
            /* 走的人正好是当前回合持有者 → 顺延给下一位（循环） */
            upd.turn = ((leftIdx) % players.length) + 1
          } else if (oldTurn > leftIdx + 1) {
            /* 走的人在当前回合之前 → 回合序号前移一位 */
            upd.turn = oldTurn - 1
          } else {
            /* 走的人在当前回合之后 → 回合序号不变 */
            upd.turn = oldTurn
          }
          /* 双保险：不管怎么算，turn 必须落在 [1, 人数] 内 */
          if (upd.turn > players.length) upd.turn = 1
          if (upd.turn < 1) upd.turn = 1
        }

        players = players.map((p, i) => Object.assign({}, p, { seat: i + 1 }))
      }

      await rooms.doc(room._id).update({
        data: Object.assign({
          players: players, hostOpenid: hostOpenid, active: active, updatedAt: ts
        }, upd)
      })
      return { ok: true, closed: !active }
    }

    return { ok: false, msg: '不认识的操作：' + action }

  } catch (err) {
    console.error('[room]', action, err)
    const raw = String((err && (err.errMsg || err.message)) || '')
    if (/ResourceNotFound|not exist|Table not exist/i.test(raw)) {
      return { ok: false, code: 'NO_TABLE', msg: '数据表还没建好，重启一次小程序即可' }
    }
    return { ok: false, msg: '操作失败了，再试一次' }
  }
}
