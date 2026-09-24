/**
 * test-mood.js —— 情绪与冷静期的逻辑验证
 *
 * 复用 mock-test 的内存 SDK，真跑 mood 云函数。
 *
 * 这一组的重点是三个命门：
 *   ① 未解锁时，响应里搜不到对方感受的任何字（双盲）
 *   ② 倒计时只认 deadline 时间戳，不依赖定时器
 *   ③ 绝不锁人：发起要对方确认、任一方随时能放弃
 *
 * 跑法：node scripts/test-mood.js
 */
const path = require('path')
const Module = require('module')
const assert = require('assert')

const store = { pairs: [], moments: [], cools: [], capsules: [], reminds: [], wishes: [] }
let seq = 0
const nextId = () => 'id' + (++seq)

function neq(v) { return { __op: 'neq', v } }
function pushv(v) { return { __op: 'push', v } }
const command = { neq, push: pushv }

function match(doc, q) {
  return Object.keys(q).every(k => {
    const c = q[k]
    if (c && c.__op === 'neq') return doc[k] !== c.v
    if (Array.isArray(doc[k])) return doc[k].indexOf(c) >= 0
    return doc[k] === c
  })
}

function collection(name) {
  const rows = () => (store[name] = store[name] || [])
  return {
    where(q) {
      const cond = q
      return {
        _n: null, _sel: null, _o: [], _s: 0,
        limit(n) { this._n = n; return this },
        field(s) { this._sel = s; return this },
        orderBy(f, d) { this._o.push([f, d]); return this },
        skip(n) { this._s = n; return this },
        async get() {
          let out = rows().filter(d => match(d, cond))
          for (let i = this._o.length - 1; i >= 0; i--) {
            const [f, dir] = this._o[i]
            out = out.slice().sort((a, b) => {
              const x = a[f], y = b[f]
              if (x === y) return 0
              return (x > y ? 1 : -1) * (dir === 'desc' ? -1 : 1)
            })
          }
          if (this._s) out = out.slice(this._s)
          if (this._n) out = out.slice(0, this._n)
          out = out.map(d => {
            const c = Object.assign({}, d)
            if (this._sel) Object.keys(c).forEach(k => { if (!(k in this._sel) || this._sel[k] === false) delete c[k] })
            return c
          })
          return { data: out }
        },
        async count() { return { total: rows().filter(d => match(d, cond)).length } }
      }
    },
    doc(id) {
      return {
        /* ★ 必须返回深拷贝。真实云数据库的 get() 每次都给你新对象；
           而内存 mock 若直接返回引用，update 里做 push 会改到这个引用，
           调用方手里那份「更新前的快照」就被偷偷改掉了 ——
           表现是断言莫名失败（实测踩过：feelings 明明只写了 1 条，
           函数里读到的却是 2 条，于是误判成"已解锁"）。 */
        async get() {
          const d = rows().filter(x => x._id === id)[0]
          return { data: d ? JSON.parse(JSON.stringify(d)) : undefined }
        },
        async update({ data }) {
          const d = rows().filter(x => x._id === id)[0]
          if (!d) throw new Error('doc not found: ' + id)
          Object.keys(data).forEach(k => {
            if (data[k] && data[k].__op === 'push') d[k] = (d[k] || []).concat(data[k].v)
            else d[k] = data[k]
          })
          return { stats: { updated: 1 } }
        },
        async remove() {
          const i = rows().findIndex(x => x._id === id)
          if (i >= 0) rows().splice(i, 1)
          return { stats: { removed: 1 } }
        }
      }
    },
    async add({ data }) { const d = Object.assign({ _id: nextId() }, data); rows().push(d); return { _id: d._id } },
    async count() { return { total: rows().length } }
  }
}

let OPENID = ''
const mock = {
  init() {}, DYNAMIC_CURRENT_ENV: 'mock',
  database() { return { collection, command, async createCollection(n) { store[n] = store[n] || []; return true } } },
  getWXContext() { return { OPENID } },
  openapi: { security: { async msgSecCheck() { return { errCode: 0, result: { suggest: 'pass' } } } } }
}
const ROOT = path.join(__dirname, '..')
const orig = Module._load
Module._load = function (r) { if (r === 'wx-server-sdk') return mock; return orig.apply(this, arguments) }

const pair = require(path.join(ROOT, 'cloudfunctions', 'pair', 'index.js'))
const mood = require(path.join(ROOT, 'cloudfunctions', 'mood', 'index.js'))

const D = 'oid_deng', Q = 'oid_qp'
let n = 0
function ok(msg) { n++; console.log('  ✓ ' + msg) }

;(async () => {
  /* ---------- 准备：配对 ---------- */
  OPENID = D
  const c = await pair.main({ action: 'create' })
  OPENID = Q
  await pair.main({ action: 'join', code: c.code })
  OPENID = D
  await pair.main({ action: 'set', anniversary: '2024-03-26' })

  /* ============ ① 发起：deadline 与"协商式暂停" ============ */
  console.log('\n=== ① 发起冷静：存 deadline，且必须等对方确认 ===')
  const s = await mood.main({ action: 'start', minutes: 20, reason: '刚才那句话说重了' })
  assert.ok(s.ok, '发起应成功')
  const id = s.id
  const rec = store.cools.filter(x => x._id === id)[0]
  assert.ok(rec.deadline > 0, '必须有 deadline 时间戳')
  assert.strictEqual(rec.deadline - rec.startedAt, 20 * 60000, '★ deadline 必须是 startedAt + 20 分钟')
  ok(`deadline 已存 = startedAt + 20 分钟（时间戳 ${rec.deadline}）`)

  /* 关键：对方没确认前，状态是 inviting，不能自己开始倒计时。
     从「发起方」视角看：她的 partner（倩萍）还没确认 → partnerAccepted=false。
     （从倩萍视角看 partnerAccepted 是 true，因为发起人邓林确实已确认 ——
      这是对的，发起本身就是一种确认。） */
  const curD0 = await mood.main({ action: 'current' })
  assert.strictEqual(curD0.cool.status, 'inviting', '★ 对方未确认时应停在 inviting')
  assert.strictEqual(curD0.cool.partnerAccepted, false, '★ 发起方视角：对方还没确认')
  assert.strictEqual(curD0.cool.iAccepted, true, '发起人自己算已确认')

  OPENID = Q
  const curQ = await mood.main({ action: 'current' })
  assert.strictEqual(curQ.cool.status, 'inviting', '★ 对方视角同样是 inviting（等她回应）')
  ok('★ 未确认时 status=inviting —— 不能一方单方面开始计时（协商式暂停）')

  /* ============ ② 同 pair 不能有两条进行中 ============ */
  console.log('\n=== ② 同时只能有一次进行中的冷静 ===')
  OPENID = D
  const dup = await mood.main({ action: 'start', minutes: 10 })
  assert.strictEqual(dup.ok, false, '不该允许第二条')
  assert.strictEqual(dup.code, 'BUSY')
  ok('重复发起被拒：「' + dup.msg + '」')

  /* ============ ③ 对方确认才进 cooling ============ */
  console.log('\n=== ③ 对方确认后才进入冷静 ===')
  OPENID = Q
  const acc = await mood.main({ action: 'accept', id, how: 'ok' })
  assert.ok(acc.ok)
  assert.strictEqual(acc.cool.status, 'cooling', '★ 双方确认后应进入 cooling')
  ok('★ 对方点「好，我等你」→ status=cooling（倒计时这才有意义）')

  /* ============ ④ 「我也需要缓一缓」会重算 deadline ============ */
  console.log('\n=== ④ 对方选「我也要缓一缓」时倒计时重新开始 ===')
  OPENID = D
  await mood.main({ action: 'drop', id })
  const s2 = await mood.main({ action: 'start', minutes: 20 })
  const id2 = s2.id
  const before = store.cools.filter(x => x._id === id2)[0].deadline
  await new Promise(r => setTimeout(r, 1100))
  OPENID = Q
  const acc2 = await mood.main({ action: 'accept', id: id2, how: 'together' })
  const after = store.cools.filter(x => x._id === id2)[0].deadline
  assert.ok(after > before, '★ 选「一起缓」后 deadline 应重算（从此刻开始）')
  ok(`★ 「我也需要缓一缓」→ deadline 重算（+${after - before}ms），双方同步开始`)

  /* ============ ⑤ ★ 双盲命门：未解锁时看不到对方感受 ============ */
  console.log('\n=== ⑤ ★ 双盲：没到写感受阶段时，响应里搜不到对方的字 ===')
  OPENID = Q
  const cur2 = await mood.main({ action: 'current' })
  assert.strictEqual(cur2.cool.status, 'cooling')
  assert.strictEqual(cur2.cool.feelings.length, 0, '还没到写感受阶段')
  ok('cooling 阶段响应里没有感受内容')

  /* ============ ⑥ 双方 ready 提前进入复盘 ============ */
  console.log('\n=== ⑥ 双方都说「缓好了」→ 提前进入写感受 ===')
  const r1 = await mood.main({ action: 'ready', id: id2 })
  assert.strictEqual(r1.cool.status, 'cooling', '★ 只有一方 ready 不能提前')
  ok('★ 单方 ready 仍是 cooling（不提前）')
  OPENID = D
  const r2 = await mood.main({ action: 'ready', id: id2 })
  assert.strictEqual(r2.cool.status, 'feeling', '★ 双方 ready 才进 feeling')
  ok('★ 双方 ready → status=feeling（提前结束冷静）')

  /* ============ ⑦ 写感受：写完拿不到对方的 ============ */
  console.log('\n=== ⑦ ★ 写感受：单方写完，响应里不含对方内容 ===')
  const SECRET_D = '邓林写的秘密感受AABBCC'
  const f1 = await mood.main({ action: 'feel', id: id2, text: SECRET_D, view: '我看到的情况' })
  assert.ok(f1.ok)
  assert.strictEqual(f1.cool.feelDone, false, '只有一个人写了，不该解锁')
  assert.strictEqual(f1.cool.feelings.length, 1, '只应看到自己那一条')
  assert.strictEqual(JSON.stringify(f1.cool).indexOf(SECRET_D) >= 0, true, '自己的能看到')

  OPENID = Q
  const SECRET_Q = '倩萍写的秘密感受XXYYZZ'
  const curBefore = await mood.main({ action: 'current' })
  assert.strictEqual(JSON.stringify(curBefore.cool).indexOf(SECRET_D), -1,
    '★ 她还没写时，整个响应里连邓林感受的碎片都不该出现')
  ok('★ 邓林写了、她还没写 → 她的响应里搜不到邓林的任何字（服务端就没返回）')

  const f2 = await mood.main({ action: 'feel', id: id2, text: SECRET_Q })
  assert.ok(f2.ok)
  assert.strictEqual(f2.cool.feelDone, true, '★ 双方都写了 → 解锁')
  assert.strictEqual(f2.cool.feelings.length, 2, '解锁后应看到双方两条')
  const all = JSON.stringify(f2.cool)
  assert.ok(all.indexOf(SECRET_D) >= 0 && all.indexOf(SECRET_Q) >= 0, '双方内容都应可见')
  ok('★ 双方都写完 → 同时解锁，互相可见（feelDone=true）')

  /* 对称验证：邓林侧也应看到两条 */
  OPENID = D
  const curD = await mood.main({ action: 'current' })
  assert.strictEqual(curD.cool.feelings.length, 2, '邓林侧也该看到两条')
  assert.strictEqual(curD.cool.status, 'owning', '解锁后进入写责任阶段')
  ok('双向解锁对称，状态推进到 owning')

  /* ============ ⑧ 责任与计划同样双盲 ============ */
  console.log('\n=== ⑧ 责任 / 计划：同样双盲 ===')
  const o1 = await mood.main({ action: 'own', id: id2, text: '我不该摔门' })
  assert.ok(o1.ok)
  assert.strictEqual(o1.cool.ownDone, false, '单方写不算完成')
  assert.strictEqual(o1.cool.owns.length, 1)
  ok('责任：单方写完只看到自己那条（ownDone=false）')

  OPENID = Q
  const o2 = await mood.main({ action: 'own', id: id2, text: '我不该翻旧账' })
  assert.strictEqual(o2.cool.ownDone, true)
  assert.strictEqual(o2.cool.status, 'planning', '双方写完责任 → 进入计划阶段')
  ok('责任：双方写完 → 进入 planning')

  /* ============ ⑨ 计划写完 → done，进规矩本 ============ */
  console.log('\n=== ⑨ 下次怎么办 → 完成，进规矩本 ===')
  const p1 = await mood.main({ action: 'plan', id: id2, text: '以后吵架不摔门' })
  assert.strictEqual(p1.cool.planDone, false, '单方写不算完成')
  ok('计划：单方写完不算完成')

  OPENID = D
  const p2 = await mood.main({ action: 'plan', id: id2, text: '晚上 11 点后不谈钱的事' })
  assert.strictEqual(p2.cool.planDone, true)
  assert.strictEqual(p2.cool.status, 'done', '★ 双方写完 → done')
  const recDone = store.cools.filter(x => x._id === id2)[0]
  assert.strictEqual(recDone.active, false, '★ 完成后应从"进行中"摘掉')
  ok('★ 双方写完计划 → status=done 且 active=false（不再出现在进行中）')

  const curAfter = await mood.main({ action: 'current' })
  assert.strictEqual(curAfter.cool, null, '完成后 current 应为 null')
  ok('完成后 current 返回 null（首页提示条会自动消失）')

  /* ============ ⑩ 规矩本 ============ */
  console.log('\n=== ⑩ 规矩本累积双方写的计划 ===')
  const hist = await mood.main({ action: 'history' })
  assert.ok(hist.ok)
  assert.strictEqual(hist.rules.length, 2, '应有两条规矩（双方各一条）')
  const ruleTexts = hist.rules.map(r => r.text).join('|')
  assert.ok(ruleTexts.indexOf('不摔门') >= 0 && ruleTexts.indexOf('11 点') >= 0)
  ok(`规矩本累积 ${hist.rules.length} 条：${hist.rules.map(r => r.text).join(' / ')}`)

  /* ============ ⑪ ★ 历史不泄露吵架内容 ============ */
  console.log('\n=== ⑪ ★ 历史不返回原因与感受正文（不翻旧账）===')
  const histStr = JSON.stringify(hist)
  assert.strictEqual(histStr.indexOf(SECRET_D), -1, '★ 历史里不该有感受正文（邓林）')
  assert.strictEqual(histStr.indexOf(SECRET_Q), -1, '★ 历史里不该有感受正文（倩萍）')
  assert.strictEqual(histStr.indexOf('刚才那句话说重了'), -1, '★ 历史里不该有吵架原因')
  assert.strictEqual(histStr.indexOf('我不该摔门'), -1, '历史里不该有责任正文')
  ok('★ 历史只留日期/时长/进度 —— 搜不到原因、感受、责任正文')

  /* ============ ⑫ 放弃：任一方都能，且不锁人 ============ */
  console.log('\n=== ⑫ 任一方都能放弃（绝不锁人）===')
  OPENID = D
  const s3 = await mood.main({ action: 'start', minutes: 30 })
  OPENID = Q
  await mood.main({ action: 'accept', id: s3.id })
  /* 注意：放弃的是"接受方"，也要能成功 —— 这是不锁人的关键 */
  const dr = await mood.main({ action: 'drop', id: s3.id })
  assert.ok(dr.ok, '★ 接受方也能放弃')
  const recDrop = store.cools.filter(x => x._id === s3.id)[0]
  assert.strictEqual(recDrop.active, false, '放弃后不再进行中')
  ok('★ 任一方都能放弃，放弃后 active=false（不会出现一方锁住另一方）')

  OPENID = D
  const curDrop = await mood.main({ action: 'current' })
  assert.strictEqual(curDrop.cool, null, '放弃后 current 为 null')
  ok('放弃后 current 为 null，可以重新发起')

  /* ============ ⑬ 时间到：不用定时器也能正确推进 ============ */
  console.log('\n=== ⑬ ★ 时间到自动可写感受（不依赖定时器）===')
  const s4 = await mood.main({ action: 'start', minutes: 10 })
  OPENID = Q
  await mood.main({ action: 'accept', id: s4.id })
  /* 直接把 deadline 拨到过去 —— 模拟"过了 10 分钟" */
  const rec4 = store.cools.filter(x => x._id === s4.id)[0]
  rec4.deadline = Date.now() - 1000
  const cur4 = await mood.main({ action: 'current' })
  assert.strictEqual(cur4.cool.status, 'feeling', '★ deadline 过了就该能写感受')
  ok('★ 把 deadline 拨到过去 → status 自动变 feeling（纯时间戳推导，无定时器）')

  /* ============ ⑭ 越权 ============ */
  console.log('\n=== ⑭ 越权：别人的记录读不到也改不了 ===')
  store.pairs.push({ _id: 'other_pair', members: ['x', 'y'], inviteActive: false, inviteCode: '', names: {}, anniversary: '', createdAt: '', pairedAt: '' })
  store.cools.push({ _id: 'alien_cool', pairId: 'other_pair', by: 'x', accepted: ['x', 'y'], deadline: Date.now() + 600000, ready: [], feelings: [], owns: [], plans: [], active: true, minutes: 20, startedAt: Date.now() })
  const alien = await mood.main({ action: 'ready', id: 'alien_cool' })
  assert.strictEqual(alien.ok, false, '★ 别人的记录不能操作')
  assert.strictEqual(alien.msg, '不属于你们的小窝')
  ok('跨小窝操作被拒：「' + alien.msg + '」')

  const alienCur = await mood.main({ action: 'current' })
  assert.ok(!alienCur.cool || alienCur.cool.id !== 'alien_cool', '★ 读不到别人的进行中')
  ok('读不到别人的冷静记录')

  /* ============ ⑮ 单人也能用 ============ */
  console.log('\n=== ⑮ 一个人也能自己走完（不用等她）===')
  OPENID = 'oid_solo'
  const sc = await pair.main({ action: 'create' })
  assert.ok(sc.ok)
  const ss = await mood.main({ action: 'start', minutes: 20, reason: '自己有点烦' })
  assert.ok(ss.ok, '★ 单人应能发起')
  const srec = store.cools.filter(x => x._id === ss.id)[0]
  assert.strictEqual(srec.accepted.length, 1, '单人时发起人自己确认即可')
  /* 单人：deadline 过了就直接能写感受 */
  srec.deadline = Date.now() - 1000
  const scurf = await mood.main({ action: 'current' })
  assert.strictEqual(scurf.cool.status, 'feeling', '★ 单人流程自动简化')
  const sf = await mood.main({ action: 'feel', id: ss.id, text: '就是有点累' })
  assert.strictEqual(sf.cool.feelDone, true, '单人写一条就算完成该步')
  ok('★ 单人：发起即确认、写一条即解锁（memberCount=1 时流程自动简化）')

  /* ============ ⑯ 未配对完全拒绝 ============ */
  console.log('\n=== ⑯ 没配对的人什么都拿不到 ===')
  OPENID = 'oid_stranger'
  const st = await mood.main({ action: 'current' })
  assert.strictEqual(st.ok, false)
  assert.strictEqual(st.code, 'NO_PAIR')
  ok('未配对 openid 被拒 ✓')

  console.log(`\n${'='.repeat(58)}`)
  console.log(`  情绪与冷静期：全部 ${n} 项断言通过`)
  console.log(`${'='.repeat(58)}\n`)
})().catch(e => {
  console.error('\n  ✗ 断言失败：', e.message, '\n')
  process.exit(1)
})
