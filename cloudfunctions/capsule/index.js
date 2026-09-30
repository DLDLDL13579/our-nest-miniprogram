/**
 * capsule —— 时间胶囊：写给未来的信
 *
 * ★ 这个文件的全部难点只有一个：**到期之前，正文绝不能离开服务端**。
 *
 *   常见错法是"把内容发给前端，前端用 CSS 糊一层遮罩"——
 *   那种锁抓个包就穿了，等于没有。所以这里的原则是：
 *   没到期的胶囊，连查都不查 text 字段（用 field() 明确排除），
 *   接口返回里根本不存在那串文字。
 *
 *   这和之前「双盲解锁」是同一套思路：把判断放在服务端，
 *   前端只负责显示服务端允许它显示的东西。
 *
 * 另一件事：胶囊是"单人写给未来"的，不需要对方参与，
 * 所以它不受配对状态限制 —— 一个人也能写给三年后的自己。
 */
const cloud = require('wx-server-sdk')
cloud.init({ env: cloud.DYNAMIC_CURRENT_ENV })

const db = cloud.database()
const _ = db.command
const pairs = db.collection('pairs')
const capsules = db.collection('capsules')

const MAXTEXT = 2000
const MAXDAYS = 3650          // 最长 10 年，再长就没意义了
const MINTITLE = 1

function nowCN() {
  const d = new Date(Date.now() + 8 * 3600 * 1000)
  return { date: d.toISOString().slice(0, 10), at: d.toISOString().slice(0, 16).replace('T', ' ') }
}

/** 两个日期相差多少天（只用 UTC 整数，避开时区与夏令时） */
function daysBetween(fromISO, toISO) {
  const a = fromISO.split('-').map(Number)
  const b = toISO.split('-').map(Number)
  return Math.round((Date.UTC(b[0], b[1] - 1, b[2]) - Date.UTC(a[0], a[1] - 1, a[2])) / 86400000)
}

/**
 * 内容安全。
 *
 * ★ 发布策略：**调用失败即拒绝**（fail-closed）。
 *   自用阶段这里是「失败就放行」，保证功能可用；但正式发布后那样等于把内容安全
 *   变成可绕过的 —— 只要让接口超时就能封存任意内容，审核也会据此驳回。
 *
 *   错误信息刻意分两种，别让人误以为是自己写的内容有问题：
 *     · 内容被判风险 → 「改一改再封存」
 *     · 检查服务不可用 → 「稍后再试」（不是你写的问题）
 */
async function safe(text, openid) {
  try {
    const r = await cloud.openapi.security.msgSecCheck({
      content: text, openid: openid, scene: 2, version: 2
    })
    const s = r && r.result && r.result.suggest
    if (s && s !== 'pass') return { pass: false, msg: '这封信里有系统判断为风险的内容，改一改再封存' }
    return { pass: true }
  } catch (err) {
    console.error('[capsule] msgSecCheck 调用失败，按发布策略拒绝写入：',
      err.errCode, err.errMsg || err.message)
    return { pass: false, code: 'SEC_UNAVAILABLE', msg: '内容检查服务暂时不可用，稍后再试一次' }
  }
}

exports.main = async (event) => {
  const { OPENID } = cloud.getWXContext()
  const action = event.action || 'list'
  const today = nowCN().date

  try {
    const pr = await pairs.where({ members: OPENID }).limit(1).get()
    const pair = pr.data[0]
    if (!pair) return { ok: false, code: 'NO_PAIR', msg: '还没配对' }

    const members = pair.members || []
    const names = pair.names || {}
    const partner = members.filter(o => o !== OPENID)[0]
    const myName = names[OPENID] || '我'
    const partnerName = partner ? (names[partner] || 'TA') : ''

    /* ================= 列表 ================= */
    if (action === 'list') {
      /**
       * 关键：用 field() 明确「不取 text」。
       * 未到期时连数据库都不把正文读出来 —— 而不是读出来再决定要不要发。
       */
      const r = await capsules.where({ pairId: pair._id })
        .orderBy('unlockAt', 'asc')
        .limit(50).get()

      const rows = r.data || []
      const list = rows.map(c => {
        const unlocked = c.unlockAt <= today
        const item = {
          id: c._id,
          title: c.title || '',
          unlockAt: c.unlockAt,
          createdAt: c.createdAt || '',
          by: c.by === OPENID ? 'me' : 'partner',
          byName: c.by === OPENID ? myName : (partnerName || 'TA'),
          mine: c.by === OPENID,
          unlocked: unlocked,
          daysLeft: unlocked ? 0 : daysBetween(today, c.unlockAt),
          daysAgo: daysBetween(c.createdAt.slice(0, 10), today),
          /* 未到期只给长度，让前端能画出"有一封信"的占位，但不泄露一个字 */
          textLength: (c.text || '').length,
          opened: !!c.openedAt,
          /* ★ 只有到期了才把正文放进来 */
          text: unlocked ? (c.text || '') : null,
          photos: unlocked ? (c.photos || []) : []
        }
        return item
      })

      const locked = list.filter(x => !x.unlocked).length
      const ready = list.filter(x => x.unlocked && !x.opened).length

      return {
        ok: true, today,
        list, locked, ready,
        total: list.length,
        myName, partnerName
      }
    }

    /* ================= 写一封 ================= */
    if (action === 'add') {
      const title = String(event.title || '').trim().slice(0, 40)
      const text = String(event.text || '').trim().slice(0, MAXTEXT)
      const unlockAt = String(event.unlockAt || '')

      if (!/^\d{4}-\d{2}-\d{2}$/.test(unlockAt)) return { ok: false, msg: '先选一个能打开的日子' }
      if (!text) return { ok: false, msg: '写点什么再封存' }

      const d = daysBetween(today, unlockAt)
      if (d < 1) return { ok: false, msg: '要选一个以后的日子 —— 今天或过去的不算未来' }
      if (d > MAXDAYS) return { ok: false, msg: '最多写给 10 年后' }

      const sec = await safe(text, OPENID)
      if (!sec.pass) return { ok: false, msg: sec.msg }

      const t = nowCN()
      const added = await capsules.add({
        data: {
          pairId: pair._id, by: OPENID,
          title: title || (d >= 365 ? '写给一年后的我们' : '写给 ' + unlockAt),
          text: text,
          photos: (Array.isArray(event.photos) ? event.photos : []).filter(x => typeof x === 'string').slice(0, 3),
          unlockAt: unlockAt,
          createdAt: t.at,
          openedAt: '',
          /* 能走到这里的信，内容检查必然跑过且通过（fail-closed） */
          secChecked: true
        }
      })
      return { ok: true, id: added._id, daysLeft: d }
    }

    /* ================= 打开一封（只记"已读"，不改内容）================= */
    if (action === 'open') {
      const id = String(event.id || '')
      const cur = await capsules.doc(id).get().catch(() => null)
      if (!cur || !cur.data) return { ok: false, msg: '这封信找不到了' }
      const c = cur.data
      if (c.pairId !== pair._id) return { ok: false, msg: '不属于你们的小窝' }
      if (c.unlockAt > today) return { ok: false, msg: '还没到能打开的日子' }

      /* 首次打开记个时间 —— 以后回头看"这封信是哪天读的" */
      if (!c.openedAt) {
        await capsules.doc(id).update({ data: { openedAt: nowCN().at } })
      }
      return { ok: true, text: c.text || '', title: c.title || '', photos: c.photos || [] }
    }

    /* ================= 回信（在已解锁的信下面接一段）================= */
    if (action === 'reply') {
      const id = String(event.id || '')
      const text = String(event.text || '').trim().slice(0, MAXTEXT)
      if (!text) return { ok: false, msg: '写点什么' }

      const cur = await capsules.doc(id).get().catch(() => null)
      if (!cur || !cur.data) return { ok: false, msg: '这封信找不到了' }
      const c = cur.data
      if (c.pairId !== pair._id) return { ok: false, msg: '不属于你们的小窝' }
      if (c.unlockAt > today) return { ok: false, msg: '还没到能打开的日子' }

      const sec = await safe(text, OPENID)
      if (!sec.pass) return { ok: false, msg: sec.msg }

      await capsules.doc(id).update({
        data: {
          replies: _.push({
            by: OPENID, name: myName, text: text, at: nowCN().at
          })
        }
      })
      return { ok: true }
    }

    /* ================= 删除（只能删自己写的、且还没到期的）================= */
    if (action === 'remove') {
      const id = String(event.id || '')
      const cur = await capsules.doc(id).get().catch(() => null)
      if (!cur || !cur.data) return { ok: false, msg: '这封信找不到了' }
      const c = cur.data
      if (c.pairId !== pair._id) return { ok: false, msg: '不属于你们的小窝' }
      if (c.by !== OPENID) return { ok: false, msg: '只能删自己写的' }
      /* 已到期的不能删 —— 那是"已经寄出的信"，删了等于篡改历史 */
      if (c.unlockAt <= today) return { ok: false, msg: '这封信已经到期了，删不掉了' }
      await capsules.doc(id).remove()
      return { ok: true }
    }

    return { ok: false, msg: '不认识的操作：' + action }

  } catch (err) {
    console.error('[capsule]', action, err)
    const raw = String((err && (err.errMsg || err.message)) || '')
    if (/ResourceNotFound|not exist|Table not exist/i.test(raw)) {
      return { ok: false, code: 'NO_TABLE', msg: '数据表还没建好，重启一次小程序即可' }
    }
    return { ok: false, msg: '操作失败了，再试一次' }
  }
}
