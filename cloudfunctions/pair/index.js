/**
 * pair —— 配对 / 状态 / 基础信息
 *
 * 数据模型上最重要的一件事：pairs 是整个产品的根，所有其它集合都靠 pairId 分区。
 * 用户的 openid 只出现在 members 数组里，永远不作为业务主键 ——
 * 这样将来开放给别人用时，一个 pairId 就是一个小窝，不用改任何查询。
 */
const cloud = require('wx-server-sdk')
cloud.init({ env: cloud.DYNAMIC_CURRENT_ENV })

const db = cloud.database()
const _ = db.command
const pairs = db.collection('pairs')

/* 去掉 I O 0 1 —— 电话里念邀请码，这四个必然听错 */
const CHARS = 'ABCDEFGHJKLMNPQRSTUVWXYZ23456789'

function genCode() {
  let s = ''
  for (let i = 0; i < 6; i++) s += CHARS[Math.floor(Math.random() * CHARS.length)]
  return s
}

function normCode(c) {
  return String(c || '').toUpperCase().replace(/[^A-Z0-9]/g, '').slice(0, 6)
}

function today() {
  const d = new Date(Date.now() + 8 * 3600 * 1000)   // 云函数是 UTC，强行掰回东八区
  return d.toISOString().slice(0, 10)
}

async function myPair(openid) {
  const r = await pairs.where({ members: openid }).limit(1).get()
  return r.data[0] || null
}

/** 给前端的精简视图：绝不外泄对方 openid */
function view(p, openid) {
  const members = p.members || []
  const names = p.names || {}
  const partner = members.filter(o => o !== openid)[0]
  return {
    pairId: p._id,
    /**
     * ★ paired 是判断"配对完成没有"的唯一依据。
     * 以前前端拿 myName 判断 —— 但它永远有值（兜底是「我」），
     * 于是单人状态被当成已配对，页面显示"已经和小窝连上了"。
     * 这种"用有兜底值的字段做状态判断"是最典型的坑，所以单独给一个布尔。
     */
    paired: members.length >= 2,
    memberCount: members.length,
    coupleName: p.coupleName || '',
    anniversary: p.anniversary || '',
    myName: names[openid] || '我',
    partnerName: partner ? (names[partner] || 'TA') : '',
    pairedAt: p.pairedAt || '',
    createdAt: p.createdAt || '',
    needAnniversary: !p.anniversary,
    /* 还在等人的时候，要把邀请码带回来 —— 否则刷新一次码就丢了 */
    inviteCode: (members.length < 2 && p.inviteActive) ? (p.inviteCode || '') : ''
  }
}

exports.main = async (event) => {
  const { OPENID } = cloud.getWXContext()
  const action = event.action || 'status'

  try {
    /* ---------- 状态：页面每次 onShow 都会问 ---------- */
    if (action === 'status') {
      const p = await myPair(OPENID)
      return { ok: true, openid: OPENID, pair: p ? view(p, OPENID) : null }
    }

    /* ---------- 生成我的邀请码 ---------- */
    if (action === 'create') {
      const exist = await myPair(OPENID)
      if (exist) {
        if ((exist.members || []).length >= 2) return { ok: true, pair: view(exist, OPENID), already: true }
        return { ok: true, code: exist.inviteCode, pair: view(exist, OPENID) }
      }
      let code = ''
      for (let i = 0; i < 5; i++) {           // 撞了就重生成，6 位 32 字符空间几乎不会撞
        code = genCode()
        const hit = await pairs.where({ inviteCode: code, inviteActive: true }).count()
        if (hit.total === 0) break
      }
      const now = today()
      const added = await pairs.add({
        data: {
          inviteCode: code, inviteActive: true,
          members: [OPENID], names: {},
          coupleName: '', anniversary: '',
          createdAt: now, pairedAt: ''
        }
      })
      const fresh = await pairs.doc(added._id).get()
      return { ok: true, code: code, pairId: added._id, pair: view(fresh.data, OPENID) }
    }

    /* ---------- 输入对方的码配对 ---------- */
    if (action === 'join') {
      const code = normCode(event.code)
      if (code.length !== 6) return { ok: false, msg: '邀请码是 6 位，再核对一下' }

      const mine = await myPair(OPENID)
      if (mine && (mine.members || []).length >= 2) {
        return { ok: false, msg: '你已经有一个小窝了' }
      }

      const r = await pairs.where({ inviteCode: code, inviteActive: true }).limit(1).get()
      const target = r.data[0]
      if (!target) return { ok: false, msg: '找不到这个码，问一下倩萍是不是还没生成' }
      if ((target.members || []).indexOf(OPENID) >= 0) return { ok: false, msg: '这是你自己的码' }
      if ((target.members || []).length >= 2) return { ok: false, msg: '这个小窝已经两个人了' }

      await pairs.doc(target._id).update({
        data: {
          members: _.push(OPENID),
          inviteActive: false,          // 配对成功立刻作废，防第三人加入
          inviteCode: '',
          pairedAt: today()
        }
      })
      /* 我这边如果留着一个空的半成品 pair，删掉，避免 status 查到错的那条 */
      if (mine && (mine.members || []).length === 1 && mine._id !== target._id) {
        await pairs.doc(mine._id).remove()
      }
      const after = await pairs.doc(target._id).get()
      return { ok: true, pair: view(after.data, OPENID) }
    }

    /* ---------- 设置：在一起的日子 / 称呼 ---------- */
    if (action === 'set') {
      const p = await myPair(OPENID)
      if (!p) return { ok: false, msg: '还没配对' }
      const data = {}

      if (event.anniversary !== undefined) {
        const s = String(event.anniversary)
        if (!/^\d{4}-\d{2}-\d{2}$/.test(s)) return { ok: false, msg: '日期格式不对' }
        const y = +s.slice(0, 4)
        if (y < 1970 || s > today()) return { ok: false, msg: '这个日期还没发生呢' }
        data.anniversary = s                     // ← 全库唯一的时间输入字段
      }
      if (event.myName !== undefined) {
        const n = String(event.myName).trim().slice(0, 8)
        if (n) { data.names = data.names || {}; data.names[OPENID] = n }
      }
      if (Object.keys(data).length === 0) return { ok: false, msg: '没要改的东西' }
      data.updatedAt = today()
      await pairs.doc(p._id).update({ data })
      const after = await pairs.doc(p._id).get()
      return { ok: true, pair: view(after.data, OPENID) }
    }

    return { ok: false, msg: '不认识的操作：' + action }

  } catch (err) {
    console.error('[pair]', action, err)
    return { ok: false, msg: '配对服务出错了，稍后再试' }
  }
}
