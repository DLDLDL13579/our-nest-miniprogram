/**
 * moments —— 随手记
 *
 * 这个文件替换掉了原来的「今日一题」。
 *
 * 为什么换：每日一问是热恋期产品的套路 —— 靠制造新鲜感让人天天打开。
 * 但在一起两年多以后，真正会让人打开这个小程序的时刻是：
 *   今天发生了一件想记下来的事 / 想翻翻以前写的 / 突然想她了。
 * 每天被问一个问题，三天后就会变成一条未读红点带来的愧疚感。
 *
 * 所以这里没有"今天"的概念，没有连续天数，没有补卡：
 *   想记就记，不想记就不记，一天记十条或者十天不打开都完全不亏欠什么。
 *
 * 可见性：写完对方立刻能看见（用户明确选择）。
 * 不做双盲 —— 双盲是"答题"的规则，不是"记录"的规则。
 * 只有一处保留了延迟：写给未来的时间胶囊（capsules，v2）。
 */
const cloud = require('wx-server-sdk')
cloud.init({ env: cloud.DYNAMIC_CURRENT_ENV })

const db = cloud.database()
const _ = db.command
const pairs = db.collection('pairs')
const moments = db.collection('moments')

const MAXTEXT = 500
const MAXPHOTOS = 3

/* 固定的几个心情，不让用户自由输入 —— 自由输入最后都会变成不用 */
const MOODS = ['happy', 'miss', 'daily', 'moved', 'annoyed']

function nowCN() {
  const d = new Date(Date.now() + 8 * 3600 * 1000)
  return { date: d.toISOString().slice(0, 10), at: d.toISOString().slice(0, 16).replace('T', ' ') }
}

/** 内容安全。没开通时放行，保证功能可用；对外发布前必须改成拒绝 */
async function safe(text, openid) {
  if (!text) return { pass: true }
  try {
    const r = await cloud.openapi.security.msgSecCheck({
      content: text, openid: openid, scene: 2, version: 2
    })
    const s = r && r.result && r.result.suggest
    if (s && s !== 'pass') return { pass: false, msg: '这段话系统判断有风险，改一改再记' }
    return { pass: true }
  } catch (err) {
    console.warn('[moments] msgSecCheck 没跑成，暂时放行：', err.errCode, err.errMsg || err.message)
    return { pass: true, degraded: true }
  }
}

exports.main = async (event) => {
  const { OPENID } = cloud.getWXContext()
  const action = event.action || 'list'

  try {
    const pr = await pairs.where({ members: OPENID }).limit(1).get()
    const pair = pr.data[0]
    if (!pair) return { ok: false, code: 'NO_PAIR', msg: '还没配对' }

    /* 一个人也能先记 —— 不用等对方加入才敢动笔，那太打击人了 */
    const solo = (pair.members || []).length < 2
    const partner = (pair.members || []).filter(o => o !== OPENID)[0]
    const names = pair.names || {}
    const myName = names[OPENID] || '我'
    const partnerName = solo ? '' : (names[partner] || 'TA')

    /* ---------------- 记一条 ---------------- */
    if (action === 'add') {
      const text = String(event.text || '').trim().slice(0, MAXTEXT)
      const photos = (Array.isArray(event.photos) ? event.photos : [])
        .filter(x => typeof x === 'string' && x)
        .slice(0, MAXPHOTOS)
      /* 缩略图与 photos 一一对应。老记录没有这个字段，读取时回退用原图 */
      const thumbs = (Array.isArray(event.thumbs) ? event.thumbs : [])
        .filter(x => typeof x === 'string' && x)
        .slice(0, MAXPHOTOS)
      const mood = MOODS.indexOf(event.mood) >= 0 ? event.mood : 'daily'

      if (!text && !photos.length) return { ok: false, msg: '写点什么，或者放一张照片' }

      const sec = await safe(text, OPENID)
      if (!sec.pass) return { ok: false, msg: sec.msg }

      const t = nowCN()
      const added = await moments.add({
        data: {
          pairId: pair._id, by: OPENID,
          text: text, photos: photos, thumbs: thumbs, mood: mood,
          date: t.date, at: t.at,
          createdAt: t.at, secPass: !sec.degraded
        }
      })
      return { ok: true, id: added._id }
    }

    /* ---------------- 列表 ---------------- */
    if (action === 'list') {
      const size = Math.min(Number(event.size) || 20, 50)
      const skip = Math.max(Number(event.skip) || 0, 0)

      const r = await moments.where({ pairId: pair._id })
        .orderBy('createdAt', 'desc')
        .skip(skip).limit(size).get()

      const list = r.data.map(m => ({
        id: m._id,
        text: m.text,
        photos: m.photos || [],
        thumbs: m.thumbs || [],          // 老记录为空数组，前端会回退用 photos
        mood: m.mood || 'daily',
        date: m.date,
        at: m.at,
        who: m.by === OPENID ? 'me' : 'partner',
        name: m.by === OPENID ? myName : (partnerName || 'TA'),
        mine: m.by === OPENID
      }))

      return {
        ok: true,
        list: list,
        hasMore: r.data.length >= size,
        solo: solo,
        myName: myName,
        partnerName: partnerName,
        today: nowCN().date
      }
    }

    /* ---------------- 按天聚合（给编年史用）---------------- */
    if (action === 'days') {
      const size = Math.min(Number(event.size) || 20, 50)
      const r = await moments.where({ pairId: pair._id })
        .orderBy('createdAt', 'desc').limit(200).get()

      const bucket = {}
      const order = []
      r.data.forEach(m => {
        if (!bucket[m.date]) { bucket[m.date] = { date: m.date, items: [] }; order.push(m.date) }
        bucket[m.date].items.push({
          id: m._id,
          text: m.text,
          photos: m.photos || [],
          thumbs: m.thumbs || [],
          mood: m.mood || 'daily',
          at: m.at,
          who: m.by === OPENID ? 'me' : 'partner',
          name: m.by === OPENID ? myName : (partnerName || 'TA')
        })
      })
      const days = order.slice(0, size).map(d => bucket[d])
      return { ok: true, days: days, totalDays: order.length }
    }

    /* ---------------- 统计 ---------------- */
    if (action === 'stats') {
      const c = await moments.where({ pairId: pair._id }).count()
      const r = await moments.where({ pairId: pair._id }).field({ date: true }).limit(1000).get()
      const set = {}
      r.data.forEach(m => { set[m.date] = 1 })
      return { ok: true, total: c.total, days: Object.keys(set).length }
    }

    /* ---------------- 删除（只能删自己的）---------------- */
    if (action === 'remove') {
      const id = String(event.id || '')
      const cur = await moments.doc(id).get().catch(() => null)
      if (!cur || !cur.data) return { ok: false, msg: '这条找不到了' }
      if (cur.data.pairId !== pair._id) return { ok: false, msg: '不属于你们的小窝' }
      if (cur.data.by !== OPENID) return { ok: false, msg: '只能删自己记的' }
      await moments.doc(id).remove()
      return { ok: true }
    }

    return { ok: false, msg: '不认识的操作：' + action }

  } catch (err) {
    console.error('[moments]', action, err)
    const raw = String((err && (err.errMsg || err.message)) || '')
    /* 集合不存在是最常见的第一次失败原因，直接说清楚，别让用户看"再试一次"干瞪眼 */
    if (/ResourceNotFound|not exist|集合不存在|Table not exist/i.test(raw)) {
      return { ok: false, code: 'NO_TABLE', msg: '数据表还没建好，重启一次小程序即可（会自动创建）' }
    }
    return { ok: false, msg: '操作失败了，再试一次', debug: raw.slice(0, 120) }
  }
}
