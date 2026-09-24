/**
 * home —— 首页专用聚合接口
 *
 * 为什么单独做这个：首页原先要串行调 4 个云函数（pain → moments.list →
 * moments.stats → chronicle.list → daily），每次网络往返 300~800ms，
 * 叠起来就是 1.5~3 秒白屏。而云函数还有冷启动，4 个函数意味着最多 4 次冷启动。
 *
 * 现在合成一次调用，服务端内部并发查完再一起返回：
 *   一次网络往返 + 一次冷启动，首页数据齐活。
 *
 * 保留原则：这里只做"读"，所有写操作仍然走各自独立的云函数 ——
 * 聚合只是为了快，不应该让写逻辑也跟着耦合起来。
 */
const cloud = require('wx-server-sdk')
cloud.init({ env: cloud.DYNAMIC_CURRENT_ENV })

const db = cloud.database()
const pairs = db.collection('pairs')
const moments = db.collection('moments')
const capsules = db.collection('capsules')
const reminds = db.collection('reminds')
const cools = db.collection('cools')

const { derive } = require('./derive.js')

function todayCN() {
  return new Date(Date.now() + 8 * 3600 * 1000).toISOString().slice(0, 10)
}

/**
 * 冷静期摘要 —— 首页只显示"有没有在进行中、还剩多久"，
 * 不碰 reason 也不碰任何人的感受（那些只在情绪页里、且未解锁时不返回）。
 *
 * 状态这里算个简化版就够了：首页只需要知道"在等回应"还是"在倒计时"。
 * 完整的状态推导在 mood 云函数里（那边才是唯一真相）。
 */
function summarizeCool(c, openid, now, memberCount) {
  if (!c) return null
  const accepted = c.accepted || []
  /* memberCount 由调用方从 pair.members 传入 —— cools 记录里不存这个字段，
     存了就会在有人退出小窝时变成过期数据 */
  const members = memberCount || 2
  const inviting = accepted.length < members
  return {
    id: c._id,
    status: inviting ? 'inviting' : (now < (c.deadline || 0) ? 'cooling' : 'feeling'),
    minutes: c.minutes || 20,
    remainMs: Math.max(0, (c.deadline || 0) - now),
    mine: c.by === openid,
    /* 对方发起的、且我还没回应 —— 首页要提示得明显一点 */
    needsMe: inviting && c.by !== openid && accepted.indexOf(openid) < 0
  }
}


/**
 * 数一下有多少件事进了提醒窗口。
 * 注意这里只用 date/repeat/leadDays 三个字段本地算，
 * 不调 reminds 云函数 —— 首页已经够多查询了，不能再加一次往返。
 */
function daysToNext(item, today) {
  const a = String(item.date || '').split('-').map(Number)
  if (a.length < 3) return 9999
  const t = today.split('-').map(Number)
  const todayUts = Date.UTC(t[0], t[1] - 1, t[2])
  let target

  if (item.repeat === 'monthly') {
    const day = a[2]
    let y = t[0], m = t[1]
    const clamp = (yy, mm) => Math.min(day, new Date(Date.UTC(yy, mm, 0)).getUTCDate())
    target = Date.UTC(y, m - 1, clamp(y, m))
    if (target < todayUts) {
      m += 1; if (m > 12) { m = 1; y += 1 }
      target = Date.UTC(y, m - 1, clamp(y, m))
    }
  } else if (item.repeat === 'once') {
    target = Date.UTC(a[0], a[1] - 1, a[2])
    if (target < todayUts) return -1          // 已过
  } else {
    /* 每年：2/29 在平年要回落，不能跳到 3/1 */
    const clampY = (yy) => Math.min(a[2], new Date(Date.UTC(yy, a[1], 0)).getUTCDate())
    target = Date.UTC(t[0], a[1] - 1, clampY(t[0]))
    if (target < todayUts) target = Date.UTC(t[0] + 1, a[1] - 1, clampY(t[0] + 1))
  }
  return Math.round((target - todayUts) / 86400000)
}

function countRemindUrgent(list, today) {
  return list.filter(m => {
    const d = daysToNext(m, today)
    return d >= 0 && d <= (Number(m.leadDays) || 0)
  }).length
}

function countRemindNear(list, today) {
  return list.filter(m => {
    const d = daysToNext(m, today)
    return d >= 0 && d <= 30
  }).length
}

exports.main = async (event) => {
  const { OPENID } = cloud.getWXContext()
  const date = event.date || todayCN()

  try {
    /* ---- ① 配对状态（必须先拿，后面所有查询都依赖 pairId） ---- */
    const pr = await pairs.where({ members: OPENID }).limit(1).get()
    const pair = pr.data[0]
    if (!pair) return { ok: false, code: 'NO_PAIR', msg: '还没配对' }

    const members = pair.members || []
    const solo = members.length < 2
    const partner = members.filter(o => o !== OPENID)[0]
    const names = pair.names || {}
    const myName = names[OPENID] || '我'
    const partnerName = solo ? '' : (names[partner] || 'TA')

    /* ---- ② 时间派生（纯计算，没有 IO） ---- */
    const D = pair.anniversary ? derive(pair.anniversary, date) : null

    /* ---- ③ 剩下几个查询并发跑，不再串行 ---- */
    const size = Math.min(Number(event.size) || 2, 10)
    /* 「那年今日」：去年同一天写过什么 */
    const lastYear = (Number(date.slice(0, 4)) - 1) + '-' + date.slice(4)

    const [listRes, statsRes, todayRes, onThisDayRes, capsuleRes, remindRes, coolRes] = await Promise.all([
      moments.where({ pairId: pair._id }).orderBy('createdAt', 'desc').limit(size).get(),
      moments.where({ pairId: pair._id }).count(),
      moments.where({ pairId: pair._id, date }).count(),     // 今天记了几条
      moments.where({ pairId: pair._id, date: lastYear }).limit(5).get(),
      /* 胶囊摘要：几封能拆、几封封存中。失败不影响首页 —— 表可能还没建 */
      capsules.where({ pairId: pair._id }).field({ unlockAt: true }).limit(50).get()
        .catch(() => ({ data: [] })),
      /* 提醒摘要：几件进窗口了。用 date+leadDays 本地算，不查两次 */
      reminds.where({ pairId: pair._id })
        .field({ date: true, repeat: true, leadDays: true }).limit(100).get()
        .catch(() => ({ data: [] })),
      /* 冷静摘要：有没有在进行中的冷静。
         只取判状态要用的字段 —— reason 和任何人的感受都不查，
         首页不需要，也不该看到（那些只在情绪页里）。 */
      cools.where({ pairId: pair._id, active: true })
        .field({ by: true, minutes: true, startedAt: true, deadline: true, accepted: true })
        .limit(1).get()
        .catch(() => ({ data: [] }))
    ])

    const list = listRes.data.map(m => ({
      id: m._id,
      text: m.text || '',
      photos: m.photos || [],
      /* 缩略图必须一起返回：前端列表用的是它，漏掉就会被回退成原图 —— 
         一屏 2 张就是 10MB，media.js 辛苦压的小图等于白做。 */
      thumbs: m.thumbs || [],
      mood: m.mood || 'daily',
      date: m.date,
      at: m.at || m.createdAt,
      who: m.by === OPENID ? 'me' : 'partner',
      name: m.by === OPENID ? myName : (partnerName || 'TA'),
      mine: m.by === OPENID
    }))

    /* 那年今日：可能是她写的、也可能是我写的，分开取 */
    let onThisDay = null
    const od = onThisDayRes.data || []
    if (od.length) {
      const mineOd = od.filter(x => x.by === OPENID)
      const taOd = od.filter(x => x.by !== OPENID)
      onThisDay = {
        date: lastYear,
        mine: mineOd.map(x => x.text).filter(Boolean).join(' / '),
        partner: taOd.map(x => x.text).filter(Boolean).join(' / '),
        partnerName: partnerName || 'TA',
        photos: taOd.concat(mineOd).reduce((a, x) => a.concat(x.photos || []), []).slice(0, 3)
      }
    }

    return {
      ok: true,
      date,
      solo,
      onThisDay,
      myName,
      partnerName,
      pair: {
        pairId: pair._id,
        paired: members.length >= 2,
        memberCount: members.length,
        anniversary: pair.anniversary || '',
        inviteCode: (members.length < 2 && pair.inviteActive) ? (pair.inviteCode || '') : '',
        pairedAt: pair.pairedAt || ''
      },
      D: D ? {
        days: D.days, headNo: D.headNo, headNoCn: D.headNoCn, fullYears: D.fullYears,
        spanText: D.spanText, anniversaryLabel: D.anniversaryLabel, todayLabel: D.todayLabel,
        next: D.next, milestones: D.milestones, lastYearLabel: D.lastYearLabel
      } : null,
      moments: list,
      total: statsRes.total,
      capsuleReady: (capsuleRes.data || []).filter(c => c.unlockAt <= date).length,
      capsuleLocked: (capsuleRes.data || []).filter(c => c.unlockAt > date).length,
      remindUrgent: countRemindUrgent(remindRes.data || [], date),
      remindNear: countRemindNear(remindRes.data || [], date),
      todayCount: todayRes.total,
      /* 有没有在进行中的冷静 —— 首页据此显示一条提示条 */
      cooling: summarizeCool((coolRes.data || [])[0], OPENID, Date.now(), members.length)
    }

  } catch (err) {
    console.error('[home]', err)
    return { ok: false, msg: '打开小窝失败，下拉重试' }
  }
}
