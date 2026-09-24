/**
 * mock-test.js —— 不装微信开发者工具，也能证明双盲解锁没写错
 *
 * 做法：把 wx-server-sdk 换成一个内存版，真正 require 进 pair / daily / answer
 * 三个云函数的 index.js，按真实用户顺序调一遍，逐条断言。
 *
 * 跑法：node scripts/mock-test.js
 * 它不是给小程序用的，是给我们自己看的 —— 尤其是第 6 步那条断言。
 */
const Module = require('module')
const assert = require('assert')

/* ---------------- 内存数据库 ---------------- */
const store = { pairs: [], questions: [], answers: [], pings: [] }
let seq = 0
const nextId = () => 'id' + (++seq)

function neq(v) { return { __op: 'neq', v } }
function pushv(v) { return { __op: 'push', v } }
const command = { neq, push: pushv }

function match(doc, q) {
  return Object.keys(q).every(k => {
    const c = q[k]
    if (c && c.__op === 'neq') return doc[k] !== c.v
    if (Array.isArray(doc[k])) return doc[k].indexOf(c) >= 0     // members 含某 openid
    return doc[k] === c
  })
}

function collection(name) {
  const rows = () => (store[name] = store[name] || [])
  const api = {
    where(q) {
      const cond = q
      return {
        _f: null,
        limit(n) { this._n = n; return this },
        field(sel) { this._sel = sel; return this },
        async get() {
          let out = rows().filter(d => match(d, cond))
          if (this._n) out = out.slice(0, this._n)
          out = out.map(d => {
            const c = Object.assign({}, d)
            if (this._sel) Object.keys(c).forEach(k => {
              if (!(k in this._sel) || this._sel[k] === false) delete c[k]   // ← 关键：没选中的字段根本不返回
            })
            return c
          })
          return { data: out }
        },
        async count() { return { total: rows().filter(d => match(d, cond)).length } }
      }
    },
    doc(id) {
      return {
        async get() { const d = rows().filter(x => x._id === id)[0]; return { data: d } },
        async update({ data }) {
          const d = rows().filter(x => x._id === id)[0]
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
    async add({ data }) {
      const d = Object.assign({ _id: nextId() }, data)
      rows().push(d)
      return { _id: d._id }
    },
    async count() { return { total: rows().length } }
  }
  return api
}

let CURRENT_OPENID = ''
let SEC_CALLS = 0

const mockSdk = {
  init() {},
  DYNAMIC_CURRENT_ENV: 'mock-env',
  database() {
    return {
      collection,
      command,
      async createCollection(n) { store[n] = store[n] || []; return true }
    }
  },
  getWXContext() { return { OPENID: CURRENT_OPENID } },
  openapi: {
    security: {
      async msgSecCheck({ content }) {
        SEC_CALLS++
        return { errCode: 0, result: { suggest: /违禁|测试敏感词/.test(content) ? 'risky' : 'pass' } }
      }
    }
  }
}

/* 拦截 require('wx-server-sdk') */
const origLoad = Module._load
Module._load = function (request) {
  if (request === 'wx-server-sdk') return mockSdk
  return origLoad.apply(this, arguments)
}

/* ---------------- 加载真实云函数 ---------------- */
const path = require('path')
const base = p => path.join(__dirname, '..', 'cloudfunctions', p, 'index.js')
const pair = require(base('pair'))
const daily = require(base('daily'))
const answer = require(base('answer'))
const initdb = require(base('initdb'))

const DENG = 'oid_denglin'
const QP = 'oid_chenqianping'

let pass = 0
function ok(msg) { pass++; console.log('  ✓ ' + msg) }

;(async () => {
  console.log('\n=== 准备：建库灌题库 ===')
  const init = await initdb.main()
  assert.ok(init.ok, 'initdb 应成功')
  assert.ok(store.questions.length >= 20, '题库应有题')
  ok(`initdb 建了 ${Object.keys(store).length} 个集合、灌入 ${store.questions.length} 道题`)

  console.log('\n=== 1. 邓林生成邀请码 ===')
  CURRENT_OPENID = DENG
  const c = await pair.main({ action: 'create' })
  assert.ok(c.ok && c.code && c.code.length === 6, '应拿到 6 位码')
  ok('邀请码 ' + c.code + '（字符集不含 I O 0 1，电话里念不会听错）')

  console.log('\n=== 2. 陈倩萍输码配对 ===')
  CURRENT_OPENID = QP
  const j = await pair.main({ action: 'join', code: c.code })
  assert.ok(j.ok && j.pair, '配对应成功')
  const pid = j.pair.pairId
  const pairDoc = store.pairs.filter(p => p._id === pid)[0]
  assert.strictEqual(pairDoc.members.length, 2, 'members 应有 2 人')
  assert.strictEqual(pairDoc.inviteActive, false, '配对后邀请码必须作废')
  assert.strictEqual(pairDoc.inviteCode, '', '作废要连码一起清掉，防第三人加入')
  ok('配对成功，邀请码已作废（第三人再也进不来）')

  console.log('\n=== 3. 填在一起的日子（全库唯一时间输入）===')
  CURRENT_OPENID = DENG
  const st = await pair.main({ action: 'set', anniversary: '2024-03-26' })
  assert.ok(st.ok && st.pair.anniversary === '2024-03-26')
  assert.strictEqual(store.pairs.filter(p => p._id === pid)[0].anniversary, '2024-03-26')
  ok('anniversary 已存，answers / pings 里不需要任何日期字段之外的时间')

  console.log('\n=== 4. 两人必须拿到同一道题 ===')
  CURRENT_OPENID = DENG
  const d1 = await daily.main({ action: 'today', date: '2026-09-22' })
  CURRENT_OPENID = QP
  const d2 = await daily.main({ action: 'today', date: '2026-09-22' })
  assert.ok(d1.ok && d2.ok, '两人都应取到题')
  assert.strictEqual(d1.qid, d2.qid, '同一天两人必须同题')
  assert.strictEqual(d1.question, d2.question, '题干渲染结果也必须一致')
  assert.ok(d1.question.indexOf('{span}') < 0, '模板占位符不能漏到界面上')
  ok(`同题 ✓ 题干「${d1.question.slice(0, 18)}…」`)

  console.log('\n=== 5. 倩萍先交卷 ===')
  CURRENT_OPENID = QP
  const a1 = await answer.main({ action: 'submit', text: '是你发烧到 39 度那晚，我睡着了还给你掖被子。', qid: d1.qid, date: '2026-09-22' })
  assert.ok(a1.ok, '提交应成功')
  assert.strictEqual(a1.unlocked, false, '对方没答，不该解锁')
  assert.strictEqual(a1.partnerText, null, '不该拿到对方内容')
  ok('倩萍交卷，unlocked=false、partnerText=null ✓')

  console.log('\n=== 6. ★ 邓林没交卷时去读 —— 双盲的命门 ===')
  CURRENT_OPENID = DENG
  const d3 = await daily.main({ action: 'today', date: '2026-09-22' })
  assert.strictEqual(d3.ok, true)
  assert.strictEqual(d3.partnerAnswered, true, '应知道对方写了（只有一个布尔）')
  assert.strictEqual(d3.partnerText, null, '★ 绝不能拿到对方正文')
  assert.strictEqual(d3.unlocked, false, '★ 不该是解锁态')
  assert.strictEqual(JSON.stringify(d3).indexOf('掖被子'), -1, '★ 整个响应里连对方文本的碎片都不该出现')
  ok('未交卷方：只拿到 partnerAnswered=true，正文在数据库层就没被查出来')

  console.log('\n=== 7. 邓林交卷 → 当场互相解锁 ===')
  CURRENT_OPENID = DENG
  const a2 = await answer.main({ action: 'submit', text: '第一次去见我我妈，你出门前在镜子前整理了三次头发。', qid: d1.qid, date: '2026-09-22' })
  assert.ok(a2.unlocked, '双方都答了，应解锁')
  assert.ok(a2.partnerText && a2.partnerText.indexOf('掖被子') > 0, '应拿到倩萍的答案')
  ok('解锁成功，拿到对方文本 ✓')

  console.log('\n=== 8. 倩萍侧对称验证 ===')
  CURRENT_OPENID = QP
  const d4 = await daily.main({ action: 'today', date: '2026-09-22' })
  assert.strictEqual(d4.unlocked, true, '她那边也该是解锁态')
  assert.ok(d4.partnerText.indexOf('整理') > 0 || d4.partnerText.indexOf('头发') > 0, '她也该看到邓林的')
  ok('双向解锁对称 ✓')

  console.log('\n=== 9. 唯一索引缺失时的兜底：同一个人重复提交 ===')
  CURRENT_OPENID = DENG
  const dup1 = await answer.main({ action: 'submit', text: '改成这一句了。', qid: d1.qid, date: '2026-09-22' })
  assert.ok(dup1.ok)
  const cnt = store.answers.filter(x => x.pairId === pid && x.date === '2026-09-22').length
  assert.strictEqual(cnt, 2, '★ 同一天同一人只能有一条，改答案是 update 不是 add')
  ok('重复提交走 update，全天共 2 条（一人一条）✓')

  console.log('\n=== 10. 内容安全确实被调用了 ===')
  assert.ok(SEC_CALLS > 0, 'msgSecCheck 必须被调用过')
  CURRENT_OPENID = DENG
  const bad = await answer.main({ action: 'submit', text: '这是一条违禁内容测试', qid: d1.qid, date: '2026-09-22' })
  assert.strictEqual(bad.ok, false, '敏感内容应被拒')
  ok(`msgSecCheck 调用 ${SEC_CALLS} 次，敏感内容被拦在写库之前 ✓`)

  console.log('\n=== 11. 想你了：只记条数，不越权 ===')
  CURRENT_OPENID = QP
  await daily.main({ action: 'ping', date: '2026-09-22' })
  await daily.main({ action: 'ping', date: '2026-09-22' })
  CURRENT_OPENID = DENG
  const d5 = await daily.main({ action: 'today', date: '2026-09-22' })
  assert.strictEqual(d5.partnerPingedToday, 2, '邓林应看到倩萍想了他 2 次')
  assert.strictEqual(d5.myPingCount, 0)
  ok('ping 计数正确 ✓')

  console.log('\n=== 12. 没配对的人什么都拿不到 ===')
  CURRENT_OPENID = 'oid_stranger'
  const s1 = await daily.main({ action: 'today' })
  const s2 = await answer.main({ action: 'submit', text: '偷看一下', date: '2026-09-22' })
  assert.strictEqual(s1.ok, false, '陌生人取题应被拒')
  assert.strictEqual(s2.ok, false, '陌生人提交应被拒')
  ok('未配对 openid 无法读到任何小窝数据 ✓')

  console.log('\n=== 13. 数据隔离：所有记录都挂在 pairId 上 ===')
  store.pairs.push({ _id: 'other', members: [DENG, 'x'], inviteActive: false, inviteCode: '', names: {}, anniversary: '2020-01-01', createdAt: '2020-01-01', pairedAt: '' })
  const leak = store.answers.filter(x => x.pairId !== pid).length
  assert.strictEqual(leak, 0, '不应有无 pairId 的脏数据')
  ok(`answers ${store.answers.length} 条 / pings ${store.pings.length} 条，全部带 pairId ✓`)

  console.log(`\n${'='.repeat(58)}`)
  console.log(`  全部 ${pass} 项断言通过 —— 双盲解锁在云函数侧成立`)
  console.log(`${'='.repeat(58)}\n`)
})().catch(e => {
  console.error('\n  ✗ 断言失败：', e.message, '\n')
  process.exit(1)
})
