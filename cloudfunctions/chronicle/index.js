/**
 * chronicle —— 编年史
 *
 * 两条铁律，这个文件就是围绕它们写的：
 *
 * ① 「那年今日」和「里程碑」永远现算，不查库。
 *    查库就要在每年纪念日那天写一次数据，写一次就等于写死一次。
 *
 * ② 题干和答案读的是快照（qText / text），不是重新渲染的。
 *    因为题干会随年份长大 —— 今天显示「这两年多里」，三年后再渲染就成了
 *    「那五年多里」。编年史要的是当时问的那句话，不是一句话被改到符合现在。
 */
const cloud = require('wx-server-sdk')
cloud.init({ env: cloud.DYNAMIC_CURRENT_ENV })

const db = cloud.database()
const _ = db.command
const pairs = db.collection('pairs')
const answers = db.collection('answers')   // 旧的今日一题数据，留作历史归档
const moments = db.collection('moments')   // 现在的随手记

const { derive } = require('./derive.js')

/** 云函数跑在 UTC，所有"今天"都必须掰回东八区 */
function todayCN() {
  return new Date(Date.now() + 8 * 3600 * 1000).toISOString().slice(0, 10)
}

exports.main = async (event) => {
  const { OPENID } = cloud.getWXContext()
  const action = event.action || 'list'

  try {
    const pr = await pairs.where({ members: OPENID }).limit(1).get()
    const pair = pr.data[0]
    if (!pair) return { ok: false, code: 'NO_PAIR', msg: '还没配对' }

    /* 一个人也能翻自己的编年史 —— 不用等对方加入才有资格看自己写过的东西。
       这和 moments 的口径保持一致：单人是"只能记给自己"，不是"不能用"。 */
    const solo = (pair.members || []).length < 2
    const partner = (pair.members || []).filter(o => o !== OPENID)[0]
    const names = pair.names || {}
    const myName = names[OPENID] || '我'
    const partnerName = solo ? '' : (names[partner] || 'TA')

    /* ================= 首页：那年今日 + 里程碑 + 最近流水 ================= */
    if (action === 'list') {
      const size = Math.min(Number(event.size) || 20, 50)
      const skip = Math.max(Number(event.skip) || 0, 0)

      /* 编年史现在读 moments —— 一本按天归档的流水，不再有每天必须一条的假设 */
      const r = await moments.where({ pairId: pair._id })
        .orderBy('createdAt', 'desc')
        .skip(skip).limit(size * 3).get()

      const rows = r.data

      /* 按天归拢 —— 编年史是按"天"翻的，不是按"条"读的。
         随手记没有"两个人都写完"这个前提：谁记了就是谁的，一条也算数。 */
      const byDate = {}
      const order = []
      rows.forEach(m => {
        if (!byDate[m.date]) { byDate[m.date] = { date: m.date, items: [] }; order.push(m.date) }
        byDate[m.date].items.push({
          who: m.by === OPENID ? 'me' : 'partner',
          name: m.by === OPENID ? myName : (partnerName || 'TA'),
          text: m.text || '',
          photos: m.photos || [],
          /* 和 home 一样必须带上缩略图，否则前端回退加载原图 */
          thumbs: m.thumbs || [],
          mood: m.mood || 'daily',
          at: m.at || m.createdAt
        })
      })
      const list = order.slice(0, size).map(k => byDate[k])

      /* 「那年今日」：去年同一天写过什么（当年那天可能没写，返回 null 由前端处理） */
      const t = todayCN()
      const md = t.slice(5)                       // MM-DD
      const lastYear = (Number(t.slice(0, 4)) - 1) + '-' + md
      let onThisDay = null
      const hit = await moments.where({ pairId: pair._id, date: lastYear }).limit(5).get()
      if (hit.data.length) {
        const mine = hit.data.filter(x => x.by === OPENID)
        const ta = hit.data.filter(x => x.by !== OPENID)
        onThisDay = {
          date: lastYear,
          mine: mine.map(x => x.text).filter(Boolean).join(' / '),
          partner: ta.map(x => x.text).filter(Boolean).join(' / '),
          partnerName: partnerName || 'TA',
          photos: ta.concat(mine).reduce((a, x) => a.concat(x.photos || []), []).slice(0, 3)
        }
      }

      /* 里程碑：现算，不查库 */
      const D = pair.anniversary ? derive(pair.anniversary, t) : null

      return {
        ok: true,
        today: t,
        list: list,
        hasMore: rows.length >= size,
        onThisDay: onThisDay,
        milestones: D ? D.milestones : [],
        days: D ? D.days : 0,
        headNo: D ? D.headNo : 0,
        myName: myName,
        partnerName: partnerName
      }
    }

    /* ================= 某一天的详情 ================= */
    if (action === 'day') {
      const date = String(event.date || '')
      if (!/^\d{4}-\d{2}-\d{2}$/.test(date)) return { ok: false, msg: '日期不对' }
      const r = await moments.where({ pairId: pair._id, date }).orderBy('createdAt', 'asc').limit(50).get()
      if (!r.data.length) return { ok: false, msg: '这一天还没有记录' }
      const pick = (arr) => arr.map(x => ({ text: x.text || '', photos: x.photos || [], mood: x.mood || 'daily', at: x.at || x.createdAt }))
      return {
        ok: true,
        date: date,
        mine: pick(r.data.filter(x => x.by === OPENID)),
        partner: pick(r.data.filter(x => x.by !== OPENID)),
        partnerName: partnerName || 'TA'
      }
    }

    /* ================= 统计：给"已攒 N 条"这类数字 ================= */
    if (action === 'stats') {
      const total = await moments.where({ pairId: pair._id }).count()

      /**
       * 天数用聚合在数据库端去重，不再把记录拉到云函数里数。
       *
       * 旧写法是 field({date:true}).limit(1000) 然后本地 Set 去重 —— 两个问题：
       *   ① 性能：每条记录都要从数据库传一遍，1000 条就是 1000 次传输
       *   ② ★ 正确性：limit(1000) 是硬上限，记录超过 1000 条后天数会**算少**，
       *      而且不会报错，只是数字悄悄不对（这类静默错误最难发现）
       *
       * 聚合只回一个数字，多少条记录都一样快。
       * 聚合失败时回退到旧算法，保证功能不因数据库能力差异而挂掉。
       */
      let fullDays = 0
      try {
        const agg = await moments.aggregate()
          .match({ pairId: pair._id })
          .group({ _id: '$date' })
          .count('n')
          .end()
        fullDays = (agg.list && agg.list[0] && agg.list[0].n) || 0
      } catch (e) {
        console.warn('[chronicle] 聚合不可用，回退本地去重：', e.errMsg || e.message)
        const r = await moments.where({ pairId: pair._id }).field({ date: true }).limit(1000).get()
        const set = {}
        r.data.forEach(m => { set[m.date] = 1 })
        fullDays = Object.keys(set).length
      }

      return { ok: true, totalAnswers: total.total, fullDays: fullDays }
    }

    return { ok: false, msg: '不认识的操作：' + action }

  } catch (err) {
    console.error('[chronicle]', action, err)
    return { ok: false, msg: '编年史读取失败，下拉再试一次' }
  }
}
