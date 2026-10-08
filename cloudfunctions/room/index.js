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

/* 房间码字符集：去掉容易看错的 I O 0 1（要口头念给对方听） */
const CHARS = 'ABCDEFGHJKLMNPQRSTUVWXYZ23456789'
const CODE_LEN = 6

/* 房间存活时间：2 小时没人动就当作废弃。
   酒桌游戏一局最多几十分钟，2 小时足够宽松。 */
const TTL_MS = 2 * 3600 * 1000

/* 单房间人数上限 —— 一部手机传着玩，人太多轮不过来 */
const MAX_PLAYERS = 8

/* 开局倒计时：3 秒。太短来不及反应，太长会等得烦 */
const COUNTDOWN_MS = 3200

function genCode() {
  let s = ''
  for (let i = 0; i < CODE_LEN; i++) s += CHARS[Math.floor(Math.random() * CHARS.length)]
  return s
}

function normCode(c) {
  return String(c || '').toUpperCase().replace(/[^A-Z0-9]/g, '').slice(0, CODE_LEN)
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
    console.error('[room] msgSecCheck 调用失败，按发布策略拒绝：', err.errCode)
    return { pass: false, code: 'SEC_UNAVAILABLE', msg: '内容检查服务暂时不可用，稍后再试' }
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
      if (!sec.pass) return { ok: false, msg: sec.msg }

      /* 房间码撞车重试（6 位 32 字符集，撞车概率极低，但重试 5 次更稳） */
      let code = ''
      for (let i = 0; i < 5; i++) {
        const c = genCode()
        const dup = await rooms.where({ code: c, active: true }).count().catch(() => ({ total: 0 }))
        if (dup.total === 0) { code = c; break }
      }
      if (!code) return { ok: false, msg: '房间号生成失败，再试一次' }

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
      if (code.length !== CODE_LEN) return { ok: false, msg: '房间号是 6 位' }

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

      const seat = (room.players || []).length + 1
      const players = (room.players || []).concat([{
        openid: OPENID, name: name, seat: seat,
        ready: false, score: 0, dice: [],
        joinedAt: ts, lastSeen: ts
      }])
      await rooms.doc(room._id).update({ data: { players: players, updatedAt: ts } })
      const rr = await rooms.doc(room._id).get()
      return { ok: true, room: shape(rr.data, OPENID) }
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
      if (room.phase === 'playing') return { ok: false, msg: '已经开始了' }

      /* 骰子由**服务端**生成 —— 前端只拿自己的。
         这和"前端摇完上报"有本质区别：那样抓包就能看到别人的点数。 */
      const players = (room.players || []).map(p => {
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
      if (!(n >= 1 && n <= (room.players || []).length * 5)) return { ok: false, msg: '数量不对' }
      if (!(face >= 1 && face <= 6)) return { ok: false, msg: '点数不对' }

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
