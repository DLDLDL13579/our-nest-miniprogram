/**
 * reminds —— 要记得的事（纪念日 / 生日 / 还款日 / 一次性事项）
 *
 * 这个功能的难点不在增删改查，在两件事：
 *
 * ① **提前量**。生日当天才提醒等于没提醒 —— 那天你已经在饭桌上了。
 *    所以每条事项带一个 leadDays（提前几天开始提醒），
 *    进入窗口就标红并给一句"该准备了"，而不是干巴巴一个"还有 3 天"。
 *
 * ② **日期滚动**。三种重复方式，边界各不相同：
 *      每年（生日、纪念日）—— 2/29 在平年要回落到 2/28，不能跳到 3/1
 *      每月（还款、房租）  —— 31 号在小月要落到月末
 *      一次（体检、旅行）  —— 过了就是过了，不再滚动
 *    这些都在 derive.js 里实现，这里只负责调用和聚合。
 */
const cloud = require('wx-server-sdk')
cloud.init({ env: cloud.DYNAMIC_CURRENT_ENV })

const db = cloud.database()
const _ = db.command
const pairs = db.collection('pairs')
const reminds = db.collection('reminds')

const { nextOccur, nextMonthly, until } = require('./derive.js')

const MAXTITLE = 30
const MAXNOTE = 120

/* 提前量的几档预设，对应不同的准备成本 */
const LEADS = [0, 3, 7, 14, 30]


/**
 * 内容安全。
 * ★ 失败时**拒绝写入**（fail-closed）—— 微信对上架小程序的要求是
 *   UGC 必须先过 msgSecCheck；服务不可用时选择"不让写"而不是"放进去"。
 *   这条策略与 moments / capsule / mood / room 完全一致。
 *
 * ⚠️ 2026-10-09 安全审计发现：wishes / reminds / pair 三处有用户自由输入的
 *    文本，却**从未调用过内容安全**（config.json 里的权限一直配着，代码没用）。
 *    这是上架合规的硬缺口，不是"可优化项"。
 */
async function safe(text, openid) {
  if (!text) return { pass: true }
  try {
    const r = await cloud.openapi.security.msgSecCheck({
      content: text, openid: openid, scene: 2, version: 2
    })
    const s = r && r.result && r.result.suggest
    if (s && s !== 'pass') return { pass: false, msg: '这段文字系统判断有风险，改一改再写' }
    return { pass: true }
  } catch (err) {
    console.error('[reminds] msgSecCheck 调用失败，按发布策略拒绝写入：',
      err.errCode, err.errMsg || err.message)
    return { pass: false, code: 'SEC_UNAVAILABLE', msg: '内容检查服务暂时不可用，稍后再试一次' }
  }
}

function todayCN() {
  const d = new Date(Date.now() + 8 * 3600 * 1000)
  return d.toISOString().slice(0, 10)
}

/**
 * 算一条事项的下一次发生时间与状态。
 * 返回 { nextDate, daysUntil, inWindow, overdue }
 */
function project(item, today) {
  const lead = Number(item.leadDays) || 0
  let nextDate = ''
  let daysUntil = 0
  let turning = 0
  let overdue = false

  if (item.repeat === 'yearly') {
    const r = nextOccur(item.date, today)
    nextDate = r.label.replace(/\./g, '-')
    daysUntil = r.daysUntil
    turning = r.turning
  } else if (item.repeat === 'monthly') {
    const day = Number(String(item.date).slice(-2)) || 1
    const r = nextMonthly(day, today)
    nextDate = today.slice(0, 4) + '-' + r.label.replace('.', '-')
    daysUntil = r.daysUntil
  } else {
    /* 一次性：过了就标记为已过，不再滚动 */
    const r = until(item.date, today)
    nextDate = item.date
    daysUntil = r.days
    overdue = r.past
  }

  /* 进入提醒窗口：还剩的天数 <= 提前量，且还没过 */
  const inWindow = !overdue && daysUntil >= 0 && daysUntil <= lead

  return { nextDate, daysUntil, turning, overdue, inWindow }
}

exports.main = async (event) => {
  const { OPENID } = cloud.getWXContext()
  const action = event.action || 'list'
  const today = todayCN()

  try {
    const pr = await pairs.where({ members: OPENID }).limit(1).get()
    const pair = pr.data[0]
    if (!pair) return { ok: false, code: 'NO_PAIR', msg: '还没配对' }

    /* ---------------- 列表 ---------------- */
    if (action === 'list') {
      const r = await reminds.where({ pairId: pair._id }).limit(100).get()
      const rows = r.data || []

      const list = rows.map(m => {
        const p = project(m, today)
        return {
          id: m._id,
          title: m.title,
          who: m.who || '',              // 她家 / 我家 / 我们
          date: m.date,
          repeat: m.repeat || 'yearly',
          leadDays: Number(m.leadDays) || 0,
          lastGift: m.lastGift || '',     // 去年送了什么 —— 防止连送三年同款
          note: m.note || '',
          nextDate: p.nextDate,
          daysUntil: p.daysUntil,
          turning: p.turning,
          overdue: p.overdue,
          inWindow: p.inWindow,
          by: m.by === OPENID ? 'me' : 'partner'
        }
      })

      /* 排序：进入窗口的排最前，然后按剩余天数 */
      list.sort((a, b) => {
        if (a.overdue !== b.overdue) return a.overdue ? 1 : -1
        if (a.inWindow !== b.inWindow) return a.inWindow ? -1 : 1
        return a.daysUntil - b.daysUntil
      })

      return {
        ok: true, today, list,
        urgent: list.filter(x => x.inWindow && !x.overdue).length,
        total: list.length
      }
    }

    /* ---------------- 新增 ---------------- */
    if (action === 'add') {
      const title = String(event.title || '').trim().slice(0, MAXTITLE)
      const date = String(event.date || '')
      const repeat = ['yearly', 'monthly', 'once'].indexOf(event.repeat) >= 0 ? event.repeat : 'yearly'

      if (!title) return { ok: false, msg: '写一件要记得的事' }
      if (!/^\d{4}-\d{2}-\d{2}$/.test(date)) return { ok: false, msg: '选一个日期' }

      /* ★ 自由文本都要过内容安全 —— title / who / lastGift / note 全都是用户输入 */
      const secText = [title, event.who, event.lastGift, event.note]
        .map(x => String(x || '').trim()).filter(Boolean).join('\n')
      const sec = await safe(secText, OPENID)
      if (!sec.pass) return { ok: false, msg: sec.msg, _code: sec._code }

      let lead = Number(event.leadDays)
      if (LEADS.indexOf(lead) < 0) lead = repeat === 'monthly' ? 3 : 14

      const added = await reminds.add({
        data: {
          pairId: pair._id, by: OPENID,
          title, date, repeat, leadDays: lead,
          who: String(event.who || '').slice(0, 10),
          lastGift: String(event.lastGift || '').slice(0, MAXNOTE),
          note: String(event.note || '').slice(0, MAXNOTE),
          createdAt: today
        }
      })
      return { ok: true, id: added._id }
    }

    /* ---------------- 修改（主要用来补"去年送了什么"）---------------- */
    if (action === 'update') {
      const id = String(event.id || '')
      const cur = await reminds.doc(id).get().catch(() => null)
      if (!cur || !cur.data) return { ok: false, msg: '这一条找不到了' }
      if (cur.data.pairId !== pair._id) return { ok: false, msg: '不属于你们的小窝' }

      const data = {}
      if (event.title !== undefined) {
        /* 改标题也要过检查 —— 否则"先写合法的、再改成违规的"就绕过了 */
        const sec2 = await safe(String(event.title).trim(), OPENID)
        if (!sec2.pass) return { ok: false, msg: sec2.msg, _code: sec2._code }
        data.title = String(event.title).trim().slice(0, MAXTITLE)
      }
      if (event.date !== undefined && /^\d{4}-\d{2}-\d{2}$/.test(event.date)) data.date = event.date
      if (event.repeat !== undefined && ['yearly', 'monthly', 'once'].indexOf(event.repeat) >= 0) data.repeat = event.repeat
      if (event.leadDays !== undefined && LEADS.indexOf(Number(event.leadDays)) >= 0) data.leadDays = Number(event.leadDays)
      if (event.lastGift !== undefined) data.lastGift = String(event.lastGift).slice(0, MAXNOTE)
      if (event.note !== undefined) data.note = String(event.note).slice(0, MAXNOTE)
      if (event.who !== undefined) data.who = String(event.who).slice(0, 10)
      if (!Object.keys(data).length) return { ok: false, msg: '没要改的东西' }

      data.updatedAt = today
      await reminds.doc(id).update({ data })
      return { ok: true }
    }

    /* ---------------- 删除 ---------------- */
    if (action === 'remove') {
      const id = String(event.id || '')
      const cur = await reminds.doc(id).get().catch(() => null)
      if (!cur || !cur.data) return { ok: false, msg: '这一条找不到了' }
      if (cur.data.pairId !== pair._id) return { ok: false, msg: '不属于你们的小窝' }
      await reminds.doc(id).remove()
      return { ok: true }
    }

    return { ok: false, msg: '不认识的操作：' + action }

  } catch (err) {
    console.error('[reminds]', action, err)
    const raw = String((err && (err.errMsg || err.message)) || '')
    if (/ResourceNotFound|not exist|Table not exist/i.test(raw)) {
      return { ok: false, code: 'NO_TABLE', msg: '数据表还没建好，重启一次小程序即可' }
    }
    return { ok: false, msg: '操作失败了，再试一次' }
  }
}
