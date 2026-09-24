/** 「要记得的事」逻辑验证：重点是日期滚动的边界 */
const path = require('path'), Module = require('module'), assert = require('assert')
const store = { pairs: [], reminds: [] }
let seq = 0
const nextId = () => 'id' + (++seq)
function neq(v){ return { __op:'neq', v } }
const command = { neq, push: v => ({ __op:'push', v }) }
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
    where(q) { const cond = q; return {
      _n:null, limit(n){ this._n = n; return this },
      async get(){ let o = rows().filter(d => match(d, cond)); if (this._n) o = o.slice(0, this._n); return { data: o } },
      async count(){ return { total: rows().filter(d => match(d, cond)).length } } } },
    doc(id) { return {
      async get(){ return { data: rows().filter(x => x._id === id)[0] } },
      async update({ data }){ const d = rows().filter(x => x._id === id)[0]; Object.assign(d, data); return { stats:{updated:1} } },
      async remove(){ const i = rows().findIndex(x => x._id === id); if (i>=0) rows().splice(i,1); return { stats:{removed:1} } } } },
    async add({ data }){ const d = Object.assign({ _id: nextId() }, data); rows().push(d); return { _id: d._id } },
    async count(){ return { total: rows().length } }
  }
}
let OPENID = ''
const mock = {
  init(){}, DYNAMIC_CURRENT_ENV: 'mock',
  database(){ return { collection, command, async createCollection(n){ store[n] = store[n] || []; return true } } },
  getWXContext(){ return { OPENID } },
  openapi: { security: { async msgSecCheck(){ return { errCode:0, result:{ suggest:'pass' } } } } }
}
const orig = Module._load
Module._load = function(r){ if (r === 'wx-server-sdk') return mock; return orig.apply(this, arguments) }

const ROOT = path.join(__dirname, '..')
const reminds = require(path.join(ROOT, 'cloudfunctions', 'reminds', 'index.js'))
const pair = require(path.join(ROOT, 'cloudfunctions', 'pair', 'index.js'))
const { nextOccur, nextMonthly, until } = require(path.join(ROOT, 'prototype', 'derive.js'))

let n = 0
const ok = m => { n++; console.log('  ✓ ' + m) }
const plus = (d) => new Date(Date.now() + 8 * 3600e3 + d * 86400000).toISOString().slice(0, 10)

;(async () => {
  console.log('=== 日期滚动边界（纯函数，最容易错的地方）===')
  // 闰日：2/29 生日，在平年应该回落到 2/28，不能跳到 3/1
  const r1 = nextOccur('2000-02-29', '2027-01-15')
  assert.strictEqual(r1.label, '2027.02.28', '平年应回落到 2/28，实际得到 ' + r1.label)
  ok('2/29 生日在平年 → 2027.02.28（不是 3/1）')

  const r2 = nextOccur('2000-02-29', '2028-01-15')
  assert.strictEqual(r2.label, '2028.02.29', '闰年应保留 2/29')
  ok('2/29 生日在闰年 → 2028.02.29 ✓')

  // 每月 31 号：在小月应该落到月末
  const m1 = nextMonthly(31, '2026-09-15')
  assert.ok(m1.label.endsWith('.30') || m1.label.endsWith('.31'), '应落到 9 月末，实际 ' + m1.label)
  ok('每月 31 号 → 9 月落到 ' + m1.label)

  // 一次性日期过了就是过了
  const u1 = until('2026-01-01', '2026-09-23')
  assert.strictEqual(u1.past, true)
  ok('一次性日期过了 → past = true（不再滚动）')

  console.log('\n=== 提前量：生日不是当天才提醒 ===')
  OPENID = 'oid_deng'
  await pair.main({ action: 'create' })
  await pair.main({ action: 'set', anniversary: '2024-03-26' })
  ok('建窝完成')

  // 造一条 10 天后的事，提前量 14 天 → 应该已经进入提醒窗口
  const soon = await reminds.main({ action: 'add', title: '倩萍妈妈生日', date: plus(10), repeat: 'once', leadDays: 14, who: '她家' })
  assert.ok(soon.ok)
  let l = await reminds.main({ action: 'list' })
  const s = l.list[0]
  assert.strictEqual(s.daysUntil, 10)
  assert.strictEqual(s.inWindow, true, '10 天后 + 提前 14 天 → 应在窗口内')
  ok(`10 天后的事 + 提前 14 天 → inWindow = true（还有 ${s.daysUntil} 天就开始提醒）`)

  // 造一条 40 天后的事，提前量 7 天 → 不该进窗口
  await reminds.main({ action: 'add', title: '体检', date: plus(40), repeat: 'once', leadDays: 7 })
  l = await reminds.main({ action: 'list' })
  const far = l.list.filter(x => x.title === '体检')[0]
  assert.strictEqual(far.inWindow, false, '40 天后 + 提前 7 天 → 不该进窗口')
  ok('40 天后的事 + 提前 7 天 → inWindow = false ✓')

  console.log('\n=== 排序：急的排前面 ===')
  assert.strictEqual(l.list[0].title, '倩萍妈妈生日', '进入窗口的应排最前')
  ok('进入提醒窗口的排在最前 ✓')
  assert.strictEqual(l.urgent, 1, '应有 1 条紧急')
  ok('urgent 计数正确：' + l.urgent)

  console.log('\n=== 每年重复：明年同一天自动滚动 ===')
  await reminds.main({ action: 'add', title: '妈妈生日', date: '1968-11-06', repeat: 'yearly', leadDays: 14, who: '她家' })
  l = await reminds.main({ action: 'list' })
  const y = l.list.filter(x => x.title === '妈妈生日')[0]
  assert.ok(y.nextDate.endsWith('-11-06'), '应滚动到下一个 11.06，实际 ' + y.nextDate)
  assert.ok(y.turning > 0, '应算出这次过多少岁，实际 ' + y.turning)
  ok(`每年重复 → 下次 ${y.nextDate}（过 ${y.turning} 岁）✓`)

  console.log('\n=== 去年送了什么（防连送三年同款）===')
  const upd = await reminds.main({ action: 'update', id: y.id, lastGift: '按摩仪（她说好用）' })
  assert.ok(upd.ok)
  l = await reminds.main({ action: 'list' })
  const y2 = l.list.filter(x => x.title === '妈妈生日')[0]
  assert.strictEqual(y2.lastGift, '按摩仪（她说好用）')
  ok('可以补记「去年送了什么」✓')

  console.log('\n=== 越权 ===')
  store.pairs.push({ _id: 'other', members: ['x','y'], inviteActive:false, inviteCode:'', names:{}, anniversary:'', createdAt:'', pairedAt:'' })
  store.reminds.push({ _id: 'alien', pairId: 'other', title: '别人的', date: plus(5), repeat: 'once' })
  const bad = await reminds.main({ action: 'remove', id: 'alien' })
  assert.strictEqual(bad.ok, false)
  ok('别人的事项删不掉：「' + bad.msg + '」')

  console.log(`\n${'='.repeat(56)}\n  要记得的事：全部 ${n} 项断言通过\n${'='.repeat(56)}\n`)
})().catch(e => { console.error('\n  ✗ 失败：', e.message, '\n', (e.stack||'').split('\n')[1]); process.exit(1) })
