/**
 * mood —— 情绪与冷静期
 *
 * 吵架时的「暂停键」，和好后的「复盘本」。
 *
 * ============ 这个文件的三个命门 ============
 *
 * ① **未解锁时，对方的文字在服务端就被丢掉**，不在响应里。
 *    和 capsule（时间胶囊）同一套思路：判断放服务端，前端只显示服务端允许它显示的东西。
 *    常见错法是"内容发给前端 + CSS 遮罩"——抓个包就穿了。
 *
 *    为什么这里必须双盲：如果她先写了我看了，我就会不自觉地回应她的话，
 *    而不是说出我真正想说的。写出来的就不是感受，是辩解。
 *
 * ② **倒计时只认 deadline 时间戳，不用定时器**。
 *    小程序一进后台定时器就死了，只有存 deadline、每次用 Date.now() 减，
 *    退出再进来才依然准确。
 *
 * ③ **绝不锁人**。发起冷静不是"我单方面宣布不理你"——
 *    调研结论很明确：单方面停止沟通只会激怒对方，
 *    双方一起协商暂停的规则和时间才有效。
 *    所以这里：发起要对方确认、任一方随时能放弃、绝不阻止对方说话。
 *    做不好，这个功能会变成冷暴力的工具。
 *
 * 状态不靠人手动改，由 deriveStatus() 从原始事实算出来（谁确认了、谁写了、时间到没到），
 * 每次操作后重算。这样不会出现状态漂移。
 */
const cloud = require('wx-server-sdk')
cloud.init({ env: cloud.DYNAMIC_CURRENT_ENV })

const db = cloud.database()
const _ = db.command
const pairs = db.collection('pairs')
const cools = db.collection('cools')

const MAXTEXT = 600
const MAXREASON = 200

/* 时长档位。20 分钟是推荐值 —— Gottman 的研究里，
   情绪淹没（心率 >100 bpm）后身体代谢掉压力激素至少需要 20 分钟，
   5~10 分钟那种休息几乎从来不够。 */
const MINUTES = [10, 20, 30, 60]
const DEFAULT_MINUTES = 20

function now() { return Date.now() }
function nowCN() {
  const d = new Date(now() + 8 * 3600 * 1000)
  return { date: d.toISOString().slice(0, 10), at: d.toISOString().slice(0, 16).replace('T', ' ') }
}

/** 内容安全。没开通时放行，保证功能可用 */
async function safe(text, openid) {
  if (!text) return { pass: true }
  try {
    const r = await cloud.openapi.security.msgSecCheck({
      content: text, openid: openid, scene: 2, version: 2
    })
    const s = r && r.result && r.result.suggest
    if (s && s !== 'pass') return { pass: false, msg: '这段里有系统判断为风险的内容，改一改再写' }
    return { pass: true }
  } catch (err) {
    console.warn('[mood] msgSecCheck 没跑成，暂时放行：', err.errCode)
    return { pass: true, degraded: true }
  }
}

/**
 * 状态推导 —— 唯一真相。
 * 全部从原始事实算：谁确认了、谁 ready 了、谁写了什么、时间到没到。
 * 不信任存在库里的 status 字段（那会漂移）。
 */
function deriveStatus(c, ts, memberCount) {
  if (c.droppedBy) return 'dropped'
  const n = memberCount || 2

  /* 还没全员确认 —— 停在"等你回应"，倒计时都还没开始 */
  if ((c.accepted || []).length < n) return 'inviting'

  /* 还在冷静：时间没到，且不是所有人都说"缓好了" */
  if (ts < c.deadline && (c.ready || []).length < n) return 'cooling'

  /* 时间到（或双方都缓好了）→ 依次推进，每一步都要全员完成 */
  if ((c.feelings || []).length < n) return 'feeling'
  if ((c.owns || []).length < n) return 'owning'
  if ((c.plans || []).length < n) return 'planning'
  return 'done'
}

/** 只留我自己的那一条 —— 未解锁时的双盲实现 */
function mineOnly(arr, openid) {
  return (arr || []).filter(x => x.by === openid)
}

exports.main = async (event) => {
  const { OPENID } = cloud.getWXContext()
  const action = event.action || 'current'
  const ts = now()

  try {
    const pr = await pairs.where({ members: OPENID }).limit(1).get()
    const pair = pr.data[0]
    if (!pair) return { ok: false, code: 'NO_PAIR', msg: '还没配对' }

    const members = pair.members || []
    const names = pair.names || {}
    const partner = members.filter(o => o !== OPENID)[0]
    const myName = names[OPENID] || '我'
    const partnerName = partner ? (names[partner] || 'TA') : ''

    /* 单人也能自己走完 —— 和其他功能口径一致（不用等她进来才敢用） */
    const memberCount = Math.max(members.length, 1)

    /**
     * 把一条记录整理成给前端的形状。
     * ★ 双盲就发生在这里：未解锁时只放我自己的内容进去。
     */
    const shape = (c) => {
      const st = deriveStatus(c, ts, memberCount)
      const n = memberCount
      const feelDone = (c.feelings || []).length >= n
      const ownDone = (c.owns || []).length >= n
      const planDone = (c.plans || []).length >= n

      const base = {
        id: c._id,
        status: st,
        by: c.by === OPENID ? 'me' : 'partner',
        byName: c.by === OPENID ? myName : (partnerName || 'TA'),
        mine: c.by === OPENID,
        minutes: c.minutes || DEFAULT_MINUTES,
        startedAt: c.startedAt || 0,
        deadline: c.deadline || 0,
        /* 剩余毫秒由服务端给一个基准值，前端拿到后本地每秒重算 ——
           这样即使前端时钟和服务端有几秒偏差，也不会一直飘 */
        remainMs: Math.max(0, (c.deadline || 0) - ts),
        /* 流程期间可见；历史接口不会返回这个字段 */
        reason: c.reason || '',
        iAccepted: (c.accepted || []).indexOf(OPENID) >= 0,
        /* 判断的是「对方」在不在 accepted 里，不是「除我之外还有别人」。
           因为发起人自己一发起就进了 accepted：
           用长度判断的话，发起方会以为对方已经答应了，于是自己开始倒计时 ——
           那正是要避免的单方面行为。用 openid 判断才准。 */
        partnerAccepted: memberCount < 2 ? true : (c.accepted || []).indexOf(partner) >= 0,
        iReady: (c.ready || []).indexOf(OPENID) >= 0,
        partnerReady: memberCount < 2 ? true : (c.ready || []).indexOf(partner) >= 0,
        partnerWanted: c.partnerWanted || '',
        /* 我写没写（用来决定显示输入框还是已提交状态） */
        iWroteFeeling: mineOnly(c.feelings, OPENID).length > 0,
        iWroteOwn: mineOnly(c.owns, OPENID).length > 0,
        iWrotePlan: mineOnly(c.plans, OPENID).length > 0,
        feelDone, ownDone, planDone,
        droppedBy: c.droppedBy ? (c.droppedBy === OPENID ? 'me' : 'partner') : '',
        doneAt: c.doneAt || 0
      }

      /* ---- 感受：★ 双盲的核心 ---- */
      base.feelings = feelDone
        ? (c.feelings || []).map(f => ({
            by: f.by === OPENID ? 'me' : 'partner',
            name: f.by === OPENID ? myName : (partnerName || 'TA'),
            text: f.text, view: f.view || '', at: f.at
          }))
        : mineOnly(c.feelings, OPENID).map(f => ({
            by: 'me', name: myName, text: f.text, view: f.view || '', at: f.at
          }))

      /* ---- 责任：同样双盲 ---- */
      base.owns = ownDone
        ? (c.owns || []).map(f => ({
            by: f.by === OPENID ? 'me' : 'partner',
            name: f.by === OPENID ? myName : (partnerName || 'TA'),
            text: f.text, at: f.at
          }))
        : mineOnly(c.owns, OPENID).map(f => ({ by: 'me', name: myName, text: f.text, at: f.at }))

      /* ---- 下次怎么办：同样双盲 ---- */
      base.plans = planDone
        ? (c.plans || []).map(f => ({
            by: f.by === OPENID ? 'me' : 'partner',
            name: f.by === OPENID ? myName : (partnerName || 'TA'),
            text: f.text, at: f.at
          }))
        : mineOnly(c.plans, OPENID).map(f => ({ by: 'me', name: myName, text: f.text, at: f.at }))

      return base
    }

    /** 取当前进行中的那一条（active=true 且未结束） */
    async function findActive() {
      const r = await cools.where({ pairId: pair._id, active: true })
        .orderBy('startedAt', 'desc').limit(1).get().catch(() => ({ data: [] }))
      return (r.data || [])[0] || null
    }

    /** 拿一条并校验归属 */
    async function load(id) {
      const cur = await cools.doc(String(id || '')).get().catch(() => null)
      if (!cur || !cur.data) return { err: '这次记录找不到了' }
      if (cur.data.pairId !== pair._id) return { err: '不属于你们的小窝' }
      return { c: cur.data }
    }

    /* ================= 当前进行中 ================= */
    if (action === 'current') {
      const c = await findActive()
      return { ok: true, cool: c ? shape(c) : null, myName, partnerName, memberCount, now: ts }
    }

    /* ================= 发起 ================= */
    if (action === 'start') {
      const running = await findActive()
      if (running) {
        const st = deriveStatus(running, ts, memberCount)
        if (st !== 'dropped') return { ok: false, code: 'BUSY', msg: '已经有一次在进行中了' }
      }

      let minutes = Number(event.minutes)
      if (MINUTES.indexOf(minutes) < 0) minutes = DEFAULT_MINUTES
      const reason = String(event.reason || '').trim().slice(0, MAXREASON)

      if (reason) {
        const sec = await safe(reason, OPENID)
        if (!sec.pass) return { ok: false, msg: sec.msg }
      }

      const t = nowCN()
      const added = await cools.add({
        data: {
          pairId: pair._id, by: OPENID,
          reason: reason,
          minutes: minutes,
          startedAt: ts,
          /* ★ 倒计时的唯一依据。注意：对方还没确认时，前端不显示倒计时 ——
             协商式暂停，不能一方单方面开始计时 */
          deadline: ts + minutes * 60000,
          accepted: [OPENID],          // 发起人自己算已确认
          partnerWanted: '',
          ready: [],
          feelings: [], owns: [], plans: [],
          active: true,
          droppedBy: '', droppedAt: 0, doneAt: 0,
          createdAt: t.at
        }
      })
      return { ok: true, id: added._id, minutes: minutes, deadline: ts + minutes * 60000 }
    }

    /* ================= 对方确认 ================= */
    if (action === 'accept') {
      const { c, err } = await load(event.id)
      if (err) return { ok: false, msg: err }
      if (c.droppedBy) return { ok: false, msg: '这次已经结束了' }

      const how = String(event.how || 'ok')   // ok | together | now
      const upd = { accepted: _.push(OPENID) }

      if (how === 'together') {
        /* 我也需要缓一缓 —— 一起冷静，倒计时从此刻重新算 */
        upd.deadline = ts + (c.minutes || DEFAULT_MINUTES) * 60000
        upd.ready = []
      } else if (how === 'now') {
        /* 现在就想说清楚。记录对方意愿，但**不阻止冷静** ——
           绝不能出现"一方锁住另一方"，所以这里只是把意愿告诉发起方。 */
        upd.partnerWanted = 'now'
      }

      await cools.doc(c._id).update({ data: upd })
      const after = Object.assign({}, c, {
        accepted: (c.accepted || []).concat([OPENID]),
        deadline: upd.deadline || c.deadline,
        ready: upd.ready || c.ready,
        partnerWanted: upd.partnerWanted || c.partnerWanted
      })
      return { ok: true, cool: shape(after) }
    }

    /* ================= 我缓好了 ================= */
    if (action === 'ready') {
      const { c, err } = await load(event.id)
      if (err) return { ok: false, msg: err }
      if (c.droppedBy) return { ok: false, msg: '这次已经结束了' }

      const ready = (c.ready || []).indexOf(OPENID) >= 0
        ? (c.ready || [])
        : (c.ready || []).concat([OPENID])
      await cools.doc(c._id).update({ data: { ready: ready } })
      return { ok: true, cool: shape(Object.assign({}, c, { ready: ready })) }
    }

    /* ================= 放弃这次 ================= */
    if (action === 'drop') {
      const { c, err } = await load(event.id)
      if (err) return { ok: false, msg: err }
      if (c.droppedBy) return { ok: true }        // 幂等
      /* 任一方都能放弃 —— 这是"不锁人"的具体体现 */
      await cools.doc(c._id).update({
        data: { droppedBy: OPENID, droppedAt: ts, active: false }
      })
      return { ok: true }
    }

    /* ================= 写感受（双盲）================= */
    if (action === 'feel') {
      const { c, err } = await load(event.id)
      if (err) return { ok: false, msg: err }
      if (c.droppedBy) return { ok: false, msg: '这次已经结束了' }

      const st = deriveStatus(c, ts, memberCount)
      if (st === 'inviting') return { ok: false, msg: '还在等对方回应，先别急' }
      if (st === 'cooling') return { ok: false, msg: '还没缓好，再等等' }
      if (mineOnly(c.feelings, OPENID).length) return { ok: false, msg: '你已经写过了' }

      const text = String(event.text || '').trim().slice(0, MAXTEXT)
      const view = String(event.view || '').trim().slice(0, MAXTEXT)
      if (!text) return { ok: false, msg: '写一句你当时的感受' }

      const sec = await safe(text + ' ' + view, OPENID)
      if (!sec.pass) return { ok: false, msg: sec.msg }

      const t = nowCN()
      await cools.doc(c._id).update({
        data: { feelings: _.push({ by: OPENID, text: text, view: view, at: t.at }) }
      })
      const after = (c.feelings || []).concat([{ by: OPENID, text: text, view: view, at: t.at }])
      return { ok: true, cool: shape(Object.assign({}, c, { feelings: after })) }
    }

    /* ================= 写我这边的问题（双盲）================= */
    if (action === 'own') {
      const { c, err } = await load(event.id)
      if (err) return { ok: false, msg: err }
      if (c.droppedBy) return { ok: false, msg: '这次已经结束了' }

      const st = deriveStatus(c, ts, memberCount)
      if (st === 'feeling') return { ok: false, msg: '先写完感受，再来看自己这边' }
      if (mineOnly(c.owns, OPENID).length) return { ok: false, msg: '你已经写过了' }

      const text = String(event.text || '').trim().slice(0, MAXTEXT)
      if (!text) return { ok: false, msg: '写一句就好，哪怕很小' }

      const sec = await safe(text, OPENID)
      if (!sec.pass) return { ok: false, msg: sec.msg }

      const t = nowCN()
      await cools.doc(c._id).update({
        data: { owns: _.push({ by: OPENID, text: text, at: t.at }) }
      })
      const after = (c.owns || []).concat([{ by: OPENID, text: text, at: t.at }])
      return { ok: true, cool: shape(Object.assign({}, c, { owns: after })) }
    }

    /* ================= 写下次怎么办（双盲）================= */
    if (action === 'plan') {
      const { c, err } = await load(event.id)
      if (err) return { ok: false, msg: err }
      if (c.droppedBy) return { ok: false, msg: '这次已经结束了' }

      const st = deriveStatus(c, ts, memberCount)
      if (st === 'feeling' || st === 'owning') return { ok: false, msg: '先把前面的写完' }
      if (mineOnly(c.plans, OPENID).length) return { ok: false, msg: '你已经写过了' }

      const text = String(event.text || '').trim().slice(0, MAXTEXT)
      if (!text) return { ok: false, msg: '想一条下次可以怎么做' }

      const sec = await safe(text, OPENID)
      if (!sec.pass) return { ok: false, msg: sec.msg }

      const t = nowCN()
      const after = (c.plans || []).concat([{ by: OPENID, text: text, at: t.at }])
      const upd = { plans: _.push({ by: OPENID, text: text, at: t.at }) }
      /* 双方都写了 → 这一次就算走完了，从"进行中"里摘掉 */
      if (after.length >= memberCount) { upd.active = false; upd.doneAt = ts }
      await cools.doc(c._id).update({ data: upd })
      return { ok: true, cool: shape(Object.assign({}, c, { plans: after, active: !(after.length >= memberCount), doneAt: upd.doneAt || 0 })) }
    }

    /* ================= 历史 + 规矩本 ================= */
    if (action === 'history') {
      const r = await cools.where({ pairId: pair._id, active: false })
        .orderBy('startedAt', 'desc').limit(50).get().catch(() => ({ data: [] }))
      const rows = r.data || []

      /* ★ 历史里绝不返回 reason 和感受正文 —— 记录内容 = 以后可以翻旧账 = 更伤感情。
         复盘的价值在「我们学到了什么」，不在「你上次也是这么说的」。 */
      const list = rows.map(c => {
        const st = deriveStatus(c, ts, memberCount)
        const dur = (c.deadline && c.startedAt)
          ? Math.max(0, Math.round((c.deadline - c.startedAt) / 60000)) : 0
        return {
          id: c._id,
          at: c.createdAt || '',
          startedAt: c.startedAt || 0,
          minutes: c.minutes || DEFAULT_MINUTES,
          status: st,
          done: st === 'done',
          dropped: st === 'dropped',
          droppedBy: c.droppedBy ? (c.droppedBy === OPENID ? 'me' : 'partner') : '',
          /* 搁置多久没走完 —— 超过 3 天值得提醒一句（调研：那已不是"消化情绪"了） */
          idleDays: c.active ? Math.floor((ts - (c.startedAt || ts)) / 86400000) : 0,
          by: c.by === OPENID ? 'me' : 'partner'
        }
      })

      /* 规矩本 = 所有完成过的记录里的 plan 正文 */
      const rules = []
      rows.forEach(c => {
        if (deriveStatus(c, ts, memberCount) !== 'done') return
        ;(c.plans || []).forEach(p => {
          rules.push({
            text: p.text,
            at: p.at,
            by: p.by === OPENID ? 'me' : 'partner',
            name: p.by === OPENID ? myName : (partnerName || 'TA')
          })
        })
      })

      return { ok: true, list, rules, total: list.length, myName, partnerName }
    }

    return { ok: false, msg: '不认识的操作：' + action }

  } catch (err) {
    console.error('[mood]', action, err)
    const raw = String((err && (err.errMsg || err.message)) || '')
    if (/ResourceNotFound|not exist|Table not exist/i.test(raw)) {
      return { ok: false, code: 'NO_TABLE', msg: '数据表还没建好，重启一次小程序即可' }
    }
    return { ok: false, msg: '操作失败了，再试一次' }
  }
}
