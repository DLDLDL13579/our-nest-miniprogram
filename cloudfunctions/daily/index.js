/**
 * daily —— 取"今日一题" + 今日双方的回答
 *
 * ★ 双盲解锁的读取侧就在这个文件里，这是整个产品的命门：
 *   我没交卷时，接口连对方的文本都不查出来，而不是查出来在前端藏起来。
 *   前端藏起来 = 抓包就能看到 = 双盲失效，产品退化成一个备忘录。
 */
const cloud = require('wx-server-sdk')
cloud.init({ env: cloud.DYNAMIC_CURRENT_ENV })

const db = cloud.database()
const _ = db.command
const pairs = db.collection('pairs')
const answers = db.collection('answers')
const questions = db.collection('questions')
const pings = db.collection('pings')

const { derive } = require('./derive.js')

function todayCN() {
  return new Date(Date.now() + 8 * 3600 * 1000).toISOString().slice(0, 10)
}

/** 稳定选题：同一个小窝的同一天，两个人必然拿到同一题；不同小窝错开 */
function pick(list, pairId, date) {
  let seed = 0
  const key = String(pairId)
  for (let i = 0; i < key.length; i++) seed = (seed * 31 + key.charCodeAt(i)) >>> 0
  const p = date.split('-')
  const dayNo = Math.floor(Date.UTC(+p[0], +p[1] - 1, +p[2]) / 86400000)
  return list[(dayNo + seed) % list.length]
}

exports.main = async (event) => {
  const { OPENID } = cloud.getWXContext()
  const date = event.date || todayCN()

  try {
    const pr = await pairs.where({ members: OPENID }).limit(1).get()
    const pair = pr.data[0]
    if (!pair) return { ok: false, code: 'NO_PAIR', msg: '还没配对' }
    if ((pair.members || []).length < 2) return { ok: false, code: 'WAITING', msg: '还在等倩萍配对' }

    /* ---- 「想你了」：只记一条，不做推送（小程序没有真后台推送） ---- */
    if (event.action === 'ping') {
      await pings.add({ data: { pairId: pair._id, by: OPENID, date: date, createdAt: new Date().toISOString() } })
      return { ok: true, pinged: true }
    }

    /* ---- 1. 今日题目 ---- */
    const qs = await questions.where({ active: true }).limit(300).get()
    if (!qs.data.length) return { ok: false, code: 'NO_Q', msg: '题库是空的，先跑一次 initdb' }
    const q = pick(qs.data, pair._id, date)

    /* ---- 2. 题干里的时间用 derive 渲染，保证两人看到完全一样的一句 ---- */
    const D = pair.anniversary ? derive(pair.anniversary, date) : null
    const question = D ? D.fill(q.text) : q.text.replace(/\{span\}/g, '这段时间')

    /* ---- 3. 我的答案（有则说明我能看对方的） ---- */
    const mine = await answers.where({ pairId: pair._id, date, by: OPENID }).limit(1).get()
    const myDoc = mine.data[0]

    /* ---- 4. 对方答没答：只查存在性，不取正文 ---- */
    const theirs = await answers.where({ pairId: pair._id, date, by: _.neq(OPENID) })
      .field({ createdAt: true, text: !!myDoc })   // ← 我没交卷时，text 根本不从数据库读出来
      .limit(1).get()
    const theirDoc = theirs.data[0]

    return {
      ok: true,
      date: date,
      qid: q._id,
      question: question,
      tag: q.tag || '',
      anniversary: pair.anniversary || '',
      myName: (pair.names || {})[OPENID] || '我',
      partnerName: (pair.names || {})[(pair.members || []).filter(o => o !== OPENID)[0]] || 'TA',
      mine: myDoc ? { text: myDoc.text, at: myDoc.updatedAt || myDoc.createdAt, editable: true } : null,
      partnerAnswered: !!theirDoc,                  // 只给布尔值 —— 这个不泄露内容
      partnerText: myDoc && theirDoc ? theirDoc.text : null,
      partnerAt: myDoc && theirDoc ? (theirDoc.createdAt || '') : '',
      unlocked: !!(myDoc && theirDoc),

      /* 想你了的计数：一次查询拿两个数，别为红点多打一次云函数 */
      myPingCount: (await pings.where({ pairId: pair._id, date, by: OPENID }).count()).total,
      partnerPingedToday: (await pings.where({ pairId: pair._id, date, by: _.neq(OPENID) }).count()).total
    }
  } catch (err) {
    console.error('[daily]', err)
    return { ok: false, msg: '取今日一题失败了，下拉再试一次' }
  }
}
