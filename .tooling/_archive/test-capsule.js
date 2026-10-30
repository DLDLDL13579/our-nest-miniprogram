/**
 * 时间胶囊的命门验证：没到期的信，正文一个字都不能出来。
 * 复用 mock 那套内存 SDK，真跑 capsule 云函数。
 */
const path = require('path')
const Module = require('module')
const assert = require('assert')

const store = { pairs: [], capsules: [] }
let seq = 0
const nextId = () => 'id' + (++seq)
function neq(v){ return { __op:'neq', v } }
function pushv(v){ return { __op:'push', v } }
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
      const api = {
        _n: null, _sel: null, _o: [],
        limit(n){ this._n = n; return this },
        field(s){ this._sel = s; return this },
        orderBy(f, d){ this._o.push([f, d]); return this },
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
          if (this._n) out = out.slice(0, this._n)
          /* field 选择：没选中的字段根本不返回 —— 这正是胶囊保密的关键 */
          out = out.map(d => {
            const c = Object.assign({}, d)
            if (this._sel) Object.keys(c).forEach(k => {
              if (!(k in this._sel) || this._sel[k] === false) delete c[k]
            })
            return c
          })
          return { data: out }
        },
        async count(){ return { total: rows().filter(d => match(d, cond)).length } }
      }
      return api
    },
    doc(id) {
      return {
        async get(){ return { data: rows().filter(x => x._id === id)[0] } },
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
    async add({ data }){ const d = Object.assign({ _id: nextId() }, data); rows().push(d); return { _id: d._id } },
    async count(){ return { total: rows().length } }
  }
}
let OPENID = ''
const mock = {
  init(){}, DYNAMIC_CURRENT_ENV: 'mock',
  database(){ return { collection, command, async createCollection(n){ store[n] = store[n] || []; return true } } },
  getWXContext(){ return { OPENID } },
  openapi: { security: { async msgSecCheck(){ return { errCode: 0, result: { suggest: 'pass' } } } } }
}
const orig = Module._load
Module._load = function(r){ if (r === 'wx-server-sdk') return mock; return orig.apply(this, arguments) }

const ROOT = path.join(__dirname, '..')
const capsule = require(path.join(ROOT, 'cloudfunctions', 'capsule', 'index.js'))
const pair = require(path.join(ROOT, 'cloudfunctions', 'pair', 'index.js'))

const D = 'oid_deng'
let n = 0
const ok = m => { n++; console.log('  ✓ ' + m) }
const today = new Date(Date.now() + 8 * 3600e3).toISOString().slice(0, 10)
const plus = (days) => new Date(Date.now() + 8 * 3600e3 + days * 86400000).toISOString().slice(0, 10)

;(async () => {
  OPENID = D
  const c = await pair.main({ action: 'create' })
  await pair.main({ action: 'set', anniversary: '2024-03-26' })
  ok('建窝完成')

  console.log('\n=== 写一封三年后的信 ===')
  const SECRET = '三年后的你们，如果还在为钱吵架，记得今天是因为一碗番茄炒蛋和好的。'
  const w = await capsule.main({ action: 'add', title: '写给三年后的我们', text: SECRET, unlockAt: plus(1095) })
  assert.ok(w.ok, '应该封存成功')
  assert.ok(w.daysLeft >= 1090, '剩余天数应接近 1095')
  ok(`封存成功，${w.daysLeft} 天后解锁`)

  console.log('\n=== ★ 命门：未到期时，正文绝不能出现在返回里 ===')
  const l = await capsule.main({ action: 'list' })
  assert.strictEqual(l.ok, true)
  assert.strictEqual(l.list.length, 1)
  const item = l.list[0]
  assert.strictEqual(item.unlocked, false, '不该是已解锁')
  assert.strictEqual(item.text, null, '★ text 必须是 null')
  assert.strictEqual(JSON.stringify(l).indexOf('番茄炒蛋'), -1, '★ 整个响应里不能有正文的任何一个片段')
  assert.ok(item.textLength > 0, '但可以给字数，用来画占位')
  assert.ok(item.daysLeft > 1000, '可以给剩余天数')
  ok(`未到期：text=null，响应里搜不到正文片段（但给了字数 ${item.textLength} 和剩余 ${item.daysLeft} 天）`)

  console.log('\n=== 未到期时强行 open 应被拒 ===')
  const o = await capsule.main({ action: 'open', id: w.id })
  assert.strictEqual(o.ok, false, '不该允许打开')
  ok('强行打开被拒：「' + o.msg + '」')

  console.log('\n=== 到期的信：正文正常返回 ===')
  const past = await capsule.main({ action: 'add', title: '去年写的', text: '这是一封已经到期的信，内容应该能读到。', unlockAt: plus(1) })
  assert.ok(past.ok)
  /* 把解锁日改到昨天，模拟"时间到了" */
  store.capsules.filter(x => x._id === past.id)[0].unlockAt = plus(-1)
  const l2 = await capsule.main({ action: 'list' })
  const opened = l2.list.filter(x => x.unlocked)
  assert.strictEqual(opened.length, 1, '应有一封已解锁')
  assert.ok(opened[0].text && opened[0].text.indexOf('已经到期') >= 0, '正文应能读到')
  ok('已到期：正文正常返回 ✓')

  console.log('\n=== 回信 ===')
  const rep = await capsule.main({ action: 'reply', id: past.id, text: '三年后的我看到这封，想说我们还在。' })
  assert.ok(rep.ok)
  const after = store.capsules.filter(x => x._id === past.id)[0]
  assert.strictEqual((after.replies || []).length, 1)
  ok('回信成功，挂在原信下面')

  console.log('\n=== 删除规则：已到期的不能删（那是已寄出的信）===')
  const del1 = await capsule.main({ action: 'remove', id: past.id })
  assert.strictEqual(del1.ok, false, '已到期不该能删')
  ok('已到期的信拒绝删除：「' + del1.msg + '」')

  const del2 = await capsule.main({ action: 'remove', id: w.id })
  assert.strictEqual(del2.ok, true, '未到期的自己的信可以删')
  ok('未到期的信可以删 ✓')

  console.log('\n=== 越权：别人的信动不了 ===')
  store.pairs.push({ _id: 'other', members: ['x', 'y'], inviteActive: false, inviteCode: '', names: {}, anniversary: '', createdAt: '', pairedAt: '' })
  store.capsules.push({ _id: 'alien', pairId: 'other', by: 'x', title: '别人的', text: 'secret', unlockAt: plus(-1), createdAt: today })
  const alien = await capsule.main({ action: 'open', id: 'alien' })
  assert.strictEqual(alien.ok, false)
  ok('别人的信打不开：「' + alien.msg + '」')

  console.log('\n=== 日期校验 ===')
  const bad1 = await capsule.main({ action: 'add', text: 'x', unlockAt: today })
  assert.strictEqual(bad1.ok, false, '今天不该能选')
  ok('选今天被拒：「' + bad1.msg + '」')
  const bad2 = await capsule.main({ action: 'add', text: 'x', unlockAt: plus(4000) })
  assert.strictEqual(bad2.ok, false, '超过 10 年被拒')
  ok('超过 10 年被拒 ✓')

  console.log(`\n${'='.repeat(56)}\n  时间胶囊：全部 ${n} 项断言通过\n${'='.repeat(56)}\n`)
})().catch(e => { console.error('\n  ✗ 失败：', e.message, '\n', (e.stack||'').split('\n')[1]); process.exit(1) })
