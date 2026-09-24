/**
 * answer —— 提交今日回答（双盲解锁的写入侧）
 *
 * 三件事必须在这里做，不能放前端：
 *   1. 内容安全 msgSecCheck —— 只要文本会存进云端、将来可能分享，就必须过审；
 *   2. 唯一性 (pairId, date, by) —— 靠数据库唯一索引兜并发，不靠"先查再写"；
 *   3. 解锁判定 —— 交卷的同时顺手看一眼对方在不在，双方都在才把内容放出去。
 */
const cloud = require('wx-server-sdk')
cloud.init({ env: cloud.DYNAMIC_CURRENT_ENV })

const db = cloud.database()
const _ = db.command
const pairs = db.collection('pairs')
const answers = db.collection('answers')

const MAX = 300

function nowCN() {
  const d = new Date(Date.now() + 8 * 3600 * 1000)
  return { date: d.toISOString().slice(0, 10), at: d.toISOString().slice(0, 16).replace('T', ' ') }
}

/**
 * 内容安全。
 * 没开通 / 接口异常时选择放行而不是卡死 —— 自用阶段，功能可用性优先；
 * 但一旦对外发布，这里必须改成"过不了就拒绝"。
 */
async function safe(text, openid) {
  try {
    const r = await cloud.openapi.security.msgSecCheck({
      content: text, openid: openid, scene: 2, version: 2
    })
    const s = r && r.result && r.result.suggest
    if (s && s !== 'pass') return { pass: false, msg: '这段话系统判断有风险，改一改再提交' }
    return { pass: true }
  } catch (err) {
    console.warn('[answer] msgSecCheck 没跑成，暂时放行：', err.errCode, err.errMsg || err.message)
    return { pass: true, degraded: true }
  }
}

exports.main = async (event) => {
  const { OPENID } = cloud.getWXContext()
  const action = event.action || 'submit'

  try {
    const pr = await pairs.where({ members: OPENID }).limit(1).get()
    const pair = pr.data[0]
    if (!pair) return { ok: false, msg: '还没配对' }
    if ((pair.members || []).length < 2) return { ok: false, msg: '等倩萍也配对成功再写' }

    const t = nowCN()
    const date = event.date || t.date

    /**
     * ★ 题干快照（必须定义在 skip 之前 —— skip 分支也要存它）。
     * 题干是用 derive.fill() 渲染过的，会随年份自己长大：今年是「这两年多里」，
     * 三年后重新渲染就成了「那五年多里」。编年史要的是"当时问的那句话"，
     * 所以必须在提交这一刻把渲染结果存下来。
     *
     * 界线：现在的事实（天数 / 年头 / 倒计时）永远现算，入库就等于写死；
     *      当时的历史（题干原话、答案）必须存快照，存了就不再变。
     */
    const qText = String(event.qtext || '').slice(0, 200)

    /* ---------- 跳过今天：留一条痕，别让它看起来像没做 ---------- */
    if (action === 'skip') {
      const exist = await answers.where({ pairId: pair._id, date, by: OPENID }).limit(1).get()
      if (exist.data.length) return { ok: false, msg: '今天已经写过了，改就行' }
      await answers.add({
        data: { pairId: pair._id, qid: event.qid || '', qText: qText,
                date, by: OPENID,
                text: '（今天跳过）', skipped: true, createdAt: t.at, updatedAt: t.at }
      })
      return { ok: true, skipped: true }
    }

    /* ---------- 提交 / 修改 ---------- */
    const text = String(event.text || '').trim()
    if (!text) return { ok: false, msg: '写点什么再提交' }
    if (text.length > MAX) return { ok: false, msg: '最多 ' + MAX + ' 字，现在 ' + text.length + ' 字' }


    const sec = await safe(text, OPENID)
    if (!sec.pass) return { ok: false, msg: sec.msg }

    const exist = await answers.where({ pairId: pair._id, date, by: OPENID }).limit(1).get()
    let doc
    if (exist.data.length) {
      /* 当天可改，隔天由 daily 那边不再给编辑入口 —— 编年史要的是当时的想法 */
      doc = exist.data[0]._id
      await answers.doc(doc).update({ data: { text: text, qText: qText, updatedAt: t.at, skipped: false } })
    } else {
      const added = await answers.add({
        data: { pairId: pair._id, qid: event.qid || '', qText: qText,
                date, by: OPENID,
                text: text, createdAt: t.at, updatedAt: t.at, secPass: !sec.degraded }
      })
      doc = added._id
    }

    /* ---------- 解锁判定：我这条刚落库，再看对方那条 ---------- */
    const other = await answers.where({ pairId: pair._id, date, by: _.neq(OPENID) }).limit(1).get()
    const theirDoc = other.data[0]

    return {
      ok: true,
      unlocked: !!theirDoc,
      myText: text,
      partnerText: theirDoc ? theirDoc.text : null,
      partnerName: (pair.names || {})[(pair.members || []).filter(o => o !== OPENID)[0]] || 'TA',
      partnerAt: theirDoc ? theirDoc.createdAt : ''
    }
  } catch (err) {
    console.error('[answer]', action, err)
    /* 唯一索引冲突：说明同一秒重复提交了，直接当成功，别给用户报错 */
    if (err && /duplicate|E11000/i.test(String(err.errMsg || err.message))) {
      return { ok: true, duplicated: true }
    }
    return { ok: false, msg: '提交失败了，内容还在你输入框里，再试一次' }
  }
}
