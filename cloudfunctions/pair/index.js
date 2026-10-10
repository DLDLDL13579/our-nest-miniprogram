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


/**
 * 内容安全。
 * ★ 称呼（myName）会展示给**对方**看，属于 UGC，上架要求必须过 msgSecCheck。
 *   2026-10-09 安全审计发现这里一直没做（config 权限配着、代码没用）。
 *   fail-closed：检查服务不可用时拒绝写入，而不是放进去。
 */
async function safe(text, openid) {
  if (!text) return { pass: true }
  try {
    const r = await cloud.openapi.security.msgSecCheck({
      content: text, openid: openid, scene: 2, version: 2
    })
    const s = r && r.result && r.result.suggest
    if (s && s !== 'pass') return { pass: false, msg: '这个称呼系统判断有风险，换一个' }
    return { pass: true }
  } catch (err) {
    console.error('[pair] msgSecCheck 调用失败，按发布策略拒绝写入：',
      err.errCode, err.errMsg || err.message)
    return { pass: false, code: 'SEC_UNAVAILABLE', msg: '内容检查服务暂时不可用，稍后再试一次' }
  }
}

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

      /*
       * ★★ 必须做**条件更新**，不能裸 push（2026-10-09 安全审计发现）。
       *
       * 老写法是「读 target → 检查 members.length < 2 → `_.push(OPENID)`」。
       * `_.push` 是原子追加，但它**不检查追加前的人数** —— 读和写之间的窗口里：
       *
       *     请求A（oid=A）                  请求B（oid=B）
       *     查 target → members=[host]      查 target → members=[host]   ← 同一份快照
       *     1 < 2 → 通过                     1 < 2 → 通过
       *     push A                          push B
       *     ↑ members 变成 [host, A, B] —— **三人同窝**
       *
       * 而 `inviteActive: false` 挡不住 B：B 的 update 是无条件的，
       * 不会因为 A 刚把它置 false 而失败。
       *
       * **pair 是"两人分区"这个产品的根** —— 三人群会让所有挂 pairId 的
       * 查询（moments / wishes / cools…）语义全乱，且没有 UI 能表达这种状态。
       *
       * 修法：把"人数还没满"和"邀请码还有效"做成**更新条件**，
       * 让数据库在一次操作里同时判定并写入。这样第二个请求会 matched=0，
       * 我们据此明确告诉他"已经两个人了"，而不是静静挤进去。
       */
      const upd = await pairs.where({
        _id: target._id,
        inviteActive: true,
        inviteCode: code
      }).update({
        data: {
          members: _.push(OPENID),
          inviteActive: false,          // 配对成功立刻作废，防第三人加入
          inviteCode: '',
          pairedAt: today()
        }
      })
      /*
       * matched 为 0 = 在我们读完之后，这条已经被别人用掉（或码已作废）。
       * 注意：**不能**改成条件里带 `members.length < 2` —— 查询语法不支持
       * 按数组长度过滤。用 inviteActive 做闸门是等价的：
       * 它一旦被置 false，后续任何并发请求都会 matched=0。
       */
      if (!upd || !upd.stats || upd.stats.updated === 0) {
        return { ok: false, msg: '这个小窝刚刚已经两个人了' }
      }
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
        if (n) {
          const sec = await safe(n, OPENID)
          if (!sec.pass) return { ok: false, msg: sec.msg, _code: sec._code }
          data.names = data.names || {}; data.names[OPENID] = n
        }
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
