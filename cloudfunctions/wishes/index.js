/**
 * wishes —— 想去 · 去过
 *
 * 这个功能和"清单 App"的分界线只有一条：**完成时必须留下一张照片**。
 * 没有照片的愿望清单就是待办清单，三年后翻出来毫无感觉。
 *
 * 两个刻意的设计：
 *   ① 照片只存 fileID，不存外链。云端存储的权限跟着 pairId 走，不进公开域。
 *   ② 完成时间 / 地点在点"点亮"的这一刻自动盖上，不让人填 ——
 *      让用户手填日期，他一定会填成"想起来的那天"而不是"发生的那天"。
 */
const cloud = require('wx-server-sdk')
cloud.init({ env: cloud.DYNAMIC_CURRENT_ENV })

const db = cloud.database()
const _ = db.command
const pairs = db.collection('pairs')
const wishes = db.collection('wishes')

function todayCN() {
  return new Date(Date.now() + 8 * 3600 * 1000).toISOString().slice(0, 10)
}

const MAXTEXT = 60

exports.main = async (event) => {
  const { OPENID } = cloud.getWXContext()
  const action = event.action || 'list'

  try {
    const pr = await pairs.where({ members: OPENID }).limit(1).get()
    const pair = pr.data[0]
    if (!pair) return { ok: false, code: 'NO_PAIR', msg: '还没配对' }
    if ((pair.members || []).length < 2) return { ok: false, code: 'WAITING', msg: '等对方配对成功' }

    const partner = (pair.members || []).filter(o => o !== OPENID)[0]
    const names = pair.names || {}

    /* ---------------- 列表 ---------------- */
    if (action === 'list') {
      const r = await wishes.where({ pairId: pair._id })
        .orderBy('done', 'asc')            // 未完成的排前面
        .orderBy('createdAt', 'desc')
        .limit(100).get()

      const list = r.data.map(w => ({
        id: w._id,
        text: w.text,
        done: !!w.done,
        doneAt: w.doneAt || '',
        place: w.place || '',
        photo: w.photo || '',
        photoThumb: w.photoThumb || w.photo || '',   // 老记录回退用原图
        by: w.by === OPENID ? 'me' : 'partner',
        byName: (names[w.by] || (w.by === OPENID ? '我' : 'TA')),
        createdAt: w.createdAt || ''
      }))

      const doneCount = list.filter(x => x.done).length
      return {
        ok: true,
        list: list,
        total: list.length,
        doneCount: doneCount,
        todoCount: list.length - doneCount,
        myName: names[OPENID] || '我',
        partnerName: names[partner] || 'TA'
      }
    }

    /* ---------------- 新增 ---------------- */
    if (action === 'add') {
      const text = String(event.text || '').trim().slice(0, MAXTEXT)
      if (!text) return { ok: false, msg: '写一件想一起做的事' }
      const added = await wishes.add({
        data: {
          pairId: pair._id, text: text, done: false,
          by: OPENID, createdAt: todayCN(),
          doneAt: '', place: '', photo: ''
        }
      })
      return { ok: true, id: added._id }
    }

    /* ---------------- 点亮（必须带照片）---------------- */
    if (action === 'done') {
      const id = String(event.id || '')
      if (!id) return { ok: false, msg: '没指定是哪一件' }
      const photo = String(event.photo || '')
      if (!photo) return { ok: false, msg: '拍一张照片才算点亮 —— 这是它和待办清单的区别' }

      const cur = await wishes.doc(id).get().catch(() => null)
      if (!cur || !cur.data) return { ok: false, msg: '这一件找不到了' }
      if (cur.data.pairId !== pair._id) return { ok: false, msg: '不属于你们的小窝' }  // 越权检查
      if (cur.data.done) return { ok: false, msg: '这一件已经点亮过了' }

      await wishes.doc(id).update({
        data: {
          done: true,
          doneAt: todayCN(),          // 自动盖章，不让人填
          photo: photo,
          photoThumb: String(event.photoThumb || photo),
          place: String(event.place || '').slice(0, 30),
          doneBy: OPENID
        }
      })
      return { ok: true }
    }

    /* ---------------- 取消点亮（拍照拍错了要能撤）---------------- */
    if (action === 'undo') {
      const id = String(event.id || '')
      const cur = await wishes.doc(id).get().catch(() => null)
      if (!cur || !cur.data) return { ok: false, msg: '这一件找不到了' }
      if (cur.data.pairId !== pair._id) return { ok: false, msg: '不属于你们的小窝' }
      await wishes.doc(id).update({ data: { done: false, doneAt: '', photo: '', photoThumb: '', place: '' } })
      return { ok: true }
    }

    /* ---------------- 删除 ---------------- */
    if (action === 'remove') {
      const id = String(event.id || '')
      const cur = await wishes.doc(id).get().catch(() => null)
      if (!cur || !cur.data) return { ok: false, msg: '这一件找不到了' }
      if (cur.data.pairId !== pair._id) return { ok: false, msg: '不属于你们的小窝' }
      await wishes.doc(id).remove()
      return { ok: true }
    }

    return { ok: false, msg: '不认识的操作：' + action }

  } catch (err) {
    console.error('[wishes]', action, err)
    return { ok: false, msg: '操作失败了，再试一次' }
  }
}
