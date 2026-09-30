/**
 * test-contract.js —— 前后端字段契约测试
 *
 * 为什么单独写这一组：
 *   这个小程序出过的 bug，有一类反复出现且特别隐蔽 ——
 *   **云函数忘了返回某个字段，前端 wxml 却在用它。**
 *
 *   小程序不会因此报错：{{item.thumbs.length}} 在 thumbs 是 undefined 时
 *   只是求值成假，页面照常渲染，只是走了另一条分支。
 *   所以这类问题在开发者工具里看不出任何异常，只有真机上"怎么这么慢/怎么点不开"。
 *
 *   已经真实发生过的：
 *     · home / chronicle 漏返回 thumbs → 列表回退加载原图（3~5MB/张），
 *       media.js 辛苦压的缩略图完全没被用上，提速优化等于白做
 *     · chronicle.wxml 绑定 previewPhoto，但 js 里没这个方法 → 图片点不开
 *     · chronicle.wxml 绑定 goAnswer（今日一题遗留）→ 按钮点了没反应
 *     · day.wxml 把数组当对象用（d.partner.at）→ 永远空白
 *
 *   这一组测试就是把这些"静默失败"钉死。
 *
 * 跑法：node scripts/test-contract.js
 */
const path = require('path')
const Module = require('module')
const assert = require('assert')
const fs = require('fs')

/* ---------------- 内存 SDK（与其它测试同构） ---------------- */
const store = { pairs: [], questions: [], answers: [], pings: [], wishes: [], moments: [], capsules: [], reminds: [] }
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
        async get() { return { data: rows().filter(x => x._id === id)[0] } },
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
    async add({ data }) { const d = Object.assign({ _id: nextId() }, data); rows().push(d); return { _id: d._id } },
    async count() { return { total: rows().length } },
    /* 聚合链：chronicle.stats 用它按 date 去重数天数。
       真聚合在数据库端跑，这里等价地在内存里做 ——
       没有它，contract 测试里调 chronicle 会直接抛错。 */
    aggregate() {
      const stages = []
      const api = {
        match(c) { stages.push(['match', c]); return api },
        group(g) { stages.push(['group', g]); return api },
        count(f) { stages.push(['count', f]); return api },
        async end() {
          let cur = rows().slice()
          for (const [op, arg] of stages) {
            if (op === 'match') cur = cur.filter(d => match(d, arg))
            else if (op === 'group') {
              const key = String(arg._id || '').replace(/^\$/, '')
              const seen = new Set()
              cur = cur.filter(d => { const v = d[key]; if (seen.has(v)) return false; seen.add(v); return true })
            } else if (op === 'count') { cur = [{ [arg || 'n']: cur.length }] }
          }
          return { list: cur }
        }
      }
      return api
    }
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
const home = require(path.join(ROOT, 'cloudfunctions', 'home', 'index.js'))
const chronicle = require(path.join(ROOT, 'cloudfunctions', 'chronicle', 'index.js'))
const moments = require(path.join(ROOT, 'cloudfunctions', 'moments', 'index.js'))

const D = 'oid_deng', Q = 'oid_qp'
let n = 0
function ok(msg) { n++; console.log('  ✓ ' + msg) }

;(async () => {
  /* ---------- 准备：配对 + 写一条带照片的记录 ---------- */
  OPENID = D
  const c = await pair.main({ action: 'create' })
  OPENID = Q
  await pair.main({ action: 'join', code: c.code })
  OPENID = D
  await pair.main({ action: 'set', anniversary: '2024-03-26' })

  const PHOTOS = ['cloud://x/moments/a.jpg', 'cloud://x/moments/b.jpg']
  const THUMBS = ['cloud://x/moments/a_thumb.jpg', 'cloud://x/moments/b_thumb.jpg']
  const add = await moments.main({
    action: 'add', text: '今天去看了电影', photos: PHOTOS, thumbs: THUMBS, mood: 'happy'
  })
  assert.ok(add.ok, '写一条应成功')

  /* ============ ① 核心：列表接口必须返回 thumbs ============ */
  console.log('\n=== ① 列表接口必须带上缩略图（漏了就等于加载原图）===')

  const m = await moments.main({ action: 'list' })
  assert.deepStrictEqual(m.list[0].thumbs, THUMBS, 'moments.list 必须返回 thumbs')
  ok('moments.list 返回 thumbs ✓')

  const h = await home.main({ date: '2026-09-24' })
  assert.ok(h.ok, 'home 应成功')
  assert.ok(h.moments.length, 'home 应带回记录')
  assert.ok(Array.isArray(h.moments[0].thumbs), '★ home.moments[].thumbs 必须是数组')
  assert.deepStrictEqual(h.moments[0].thumbs, THUMBS, '★ home 漏返回 thumbs → 前端回退加载原图')
  ok('★ home.moments[].thumbs 存在且正确（这是首页提速的关键字段）')

  const cl = await chronicle.main({ action: 'list', size: 10 })
  assert.ok(cl.ok && cl.list.length, 'chronicle 应带回记录')
  const firstItem = cl.list[0].items[0]
  assert.ok(Array.isArray(firstItem.thumbs), '★ chronicle 的 items[].thumbs 必须是数组')
  assert.deepStrictEqual(firstItem.thumbs, THUMBS, '★ chronicle 漏返回 thumbs → 编年史列表加载原图')
  ok('★ chronicle.list[].items[].thumbs 存在且正确')

  /* ============ ② 老记录没有 thumbs 字段时必须回退成空数组 ============ */
  console.log('\n=== ② 老记录（没有 thumbs 字段）不能返回 undefined ===')
  store.moments.push({
    _id: 'old_one', pairId: store.pairs[0]._id, by: D,
    text: '很久以前记的', photos: ['cloud://x/old.jpg'],
    date: '2026-01-01', at: '2026-01-01 10:00', createdAt: '2026-01-01 10:00'
  })
  const h2 = await home.main({ date: '2026-09-24' })
  const oldRow = h2.moments.filter(x => x.id === 'old_one')[0]
  assert.ok(oldRow, '应能读到老记录')
  assert.ok(Array.isArray(oldRow.thumbs), '★ 老记录也必须给空数组，不能是 undefined')
  assert.strictEqual(oldRow.thumbs.length, 0)
  ok('老记录 thumbs 回退成 []（前端 .length 求值安全）')

  const cl2 = await chronicle.main({ action: 'list', size: 10 })
  const oldItem = cl2.list.map(d => d.items).reduce((a, b) => a.concat(b), []).filter(x => x.text === '很久以前记的')[0]
  assert.ok(oldItem && Array.isArray(oldItem.thumbs), '★ 编年史里老记录同样要回退成空数组')
  ok('编年史里老记录 thumbs 也是 []')

  /* ============ ③ 前端 wxml 绑定的方法必须在 js 里真实存在 ============ */
  console.log('\n=== ③ wxml 绑定的事件处理函数必须真实存在 ===')
  const pagesDir = path.join(ROOT, 'miniprogram', 'pages')
  function walk(dir, out) {
    out = out || []
    fs.readdirSync(dir).forEach(f => {
      const p = path.join(dir, f)
      if (fs.statSync(p).isDirectory()) walk(p, out)
      else if (f.endsWith('.wxml')) out.push(p)
    })
    return out
  }
  let missing = []
  walk(pagesDir).forEach(wxml => {
    const js = wxml.replace(/\.wxml$/, '.js')
    if (!fs.existsSync(js)) return
    const src = fs.readFileSync(js, 'utf8')
    const tpl = fs.readFileSync(wxml, 'utf8')
    const handlers = new Set()
    const re = /(?:bind|catch)[a-z]*\s*=\s*"([A-Za-z_$][\w$]*)"/g
    let mm
    while ((mm = re.exec(tpl))) handlers.add(mm[1])
    handlers.forEach(fn => {
      /* 方法定义形如 `fn(` 或 `fn:` 或 `fn =` */
      const defined = new RegExp('(^|[\\s,{])' + fn + '\\s*[(:]').test(src)
      if (!defined) missing.push(path.relative(ROOT, wxml) + ' → ' + fn)
    })
  })
  assert.deepStrictEqual(missing, [], '存在模板绑定了但 js 未定义的方法：\n    ' + missing.join('\n    '))
  ok('全部页面的 bind/catch 处理函数都有定义（goAnswer / previewPhoto 这类已修）')

  /* ============ ④ 模板引用的字段必须真的有人提供 ============ */
  console.log('\n=== ④ 模板引用的字段必须由云函数真实返回（幽灵字段检测）===')
  /*
   * 判据：把云函数真实响应里出现过的字段收集起来，再看模板里 x.y 的引用
   * 是否都能在「真实响应」里找到。
   *
   * 注意两件事，否则这个检查会误报：
   *   · 必须先剥掉 wxml 注释 —— 注释里也会写 {{onThisDay.q}}（正是我们留下的说明）
   *   · D 是 derive() 的返回值，字段多且都在 miniprogram/utils/derive.js 里定义，
   *     单独用 derive 的真实输出校验
   */
  /* 造一条「去年今日」的记录，否则 onThisDay 是 null，字段无从收集 */
  const todayStr = new Date(Date.now() + 8 * 3600 * 1000).toISOString().slice(0, 10)
  const lastYearStr = (Number(todayStr.slice(0, 4)) - 1) + todayStr.slice(4)
  store.moments.push({
    _id: 'last_year_one', pairId: store.pairs[0]._id, by: Q,
    text: '去年今天她做了顿饭', photos: [], thumbs: [],
    date: lastYearStr, at: lastYearStr + ' 19:00', createdAt: lastYearStr + ' 19:00'
  })

  const provided = {
    onThisDay: new Set(),
    stats: new Set(),
    D: new Set()
  }
  /* 让云函数真的返回一次，把字段名收集下来 */
  const realHome = await home.main({ date: '2026-09-24' })
  const realCl = await chronicle.main({ action: 'list', size: 10 })
  const realStats = await chronicle.main({ action: 'stats' })
  const { derive } = require(path.join(ROOT, 'miniprogram', 'utils', 'derive.js'))

  const collect = (obj, set) => { if (obj && typeof obj === 'object') Object.keys(obj).forEach(k => set.add(k)) }
  collect(realHome.onThisDay, provided.onThisDay)
  collect(realCl.onThisDay, provided.onThisDay)
  collect(realStats, provided.stats)
  collect(derive('2024-03-26'), provided.D)
  collect(derive('2024-03-26').next, provided.D)   /* 模板里用了 D.next.xxx */

  const stripComments = (s) => s.replace(/<!--[\s\S]*?-->/g, '')
  const ghost = []
  walk(pagesDir).forEach(wxml => {
    const tpl = stripComments(fs.readFileSync(wxml, 'utf8'))
    const re = /\b(onThisDay|stats|D)\.([a-zA-Z_]\w*)/g
    let mm
    const seen = new Set()
    while ((mm = re.exec(tpl))) {
      const root = mm[1], key = mm[2]
      if (seen.has(root + '.' + key)) continue
      seen.add(root + '.' + key)
      if (!provided[root].has(key)) ghost.push(path.relative(ROOT, wxml) + ' → ' + root + '.' + key)
    }
  })
  assert.deepStrictEqual(ghost, [], '模板引用了云函数从未返回的字段（幽灵字段）：\n    ' + ghost.join('\n    '))
  ok('模板引用的字段都由真实响应提供（onThisDay.q 那类已清掉）')

  /* ============ ⑤ 云函数返回的对象里不该再有 q 这种遗留字段 ============ */
  console.log('\n=== ⑤ 今日一题遗留字段不应再出现在响应里 ===')
  /* 重新取一次（此刻已有「去年今日」的数据，onThisDay 才是非 null 的） */
  const cl3 = await chronicle.main({ action: 'list', size: 10 })
  assert.ok(cl3.onThisDay, '此刻 onThisDay 应该有值（造过去年今日的数据）')
  assert.strictEqual(cl3.onThisDay.q, undefined, 'onThisDay 不该再有 q 字段')
  const day = await chronicle.main({ action: 'day', date: todayStr })
  assert.strictEqual(day.q, undefined, 'day 详情不该再有 q 字段')
  ok('chronicle 的 onThisDay / day 都不再返回 q')

  /* ============ ⑥ day 详情返回的 mine/partner 必须是数组 ============ */
  console.log('\n=== ⑥ 某天详情：mine / partner 必须是数组（前端要 wx:for）===')
  assert.ok(Array.isArray(day.mine), '★ day.mine 必须是数组')
  assert.ok(Array.isArray(day.partner), '★ day.partner 必须是数组')
  assert.ok(day.mine.length, '今天记的那条应该在我的数组里')
  ok('day 详情返回数组，前端 wx:for 可用（原来被当对象用，渲染恒空）')

  console.log(`\n${'='.repeat(56)}\n  字段契约：全部 ${n} 项断言通过\n${'='.repeat(56)}\n`)
})().catch(e => {
  console.error('\n  ✗ 失败：', e.message, '\n')
  process.exit(1)
})
