/**
 * mock-test.js —— 不装微信开发者工具，也能证明核心链路没写错
 *
 * 做法：把 wx-server-sdk 换成一个内存版，真正 require 进 pair / moments / initdb
 * 三个云函数的 index.js，按真实用户顺序调一遍，逐条断言。
 *
 * 跑法：node scripts/mock-test.js
 *
 * 历史：这个文件原本测的是「今日一题」的双盲解锁（14 项断言）。
 * 2026-09-24 该功能连同 daily / answer 两个云函数一起删除 ——
 * 产品决定是「不要每日打卡」，随手记（moments）取代了它。
 * 所以现在测的是配对 + 随手记这条真正在用的链路。
 */
const Module = require('module')
const assert = require('assert')

/* ---------------- 内存数据库 ---------------- */
const store = { pairs: [], questions: [], answers: [], pings: [], moments: [] }
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
        _f: null, _n: null, _sel: null, _o: [], _s: 0,
        limit(n) { this._n = n; return this },
        field(sel) { this._sel = sel; return this },
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
            if (this._sel) Object.keys(c).forEach(k => {
              if (!(k in this._sel) || this._sel[k] === false) delete c[k]   // ← 关键：没选中的字段根本不返回
            })
            return c
          })
          return { data: out }
        },
        async count() { return { total: rows().filter(d => match(d, cond)).length } },
        /*
         * ★ `where(...).update({data})` —— 真实 SDK 支持"条件更新"，
         *   返回 `stats.updated` 告诉调用方实际改了几条。
         *
         *   pair.join 靠它做**原子闸门**（把"邀请码还有效"变成更新条件，
         *   第二个并发请求会拿到 updated=0）。mock 必须支持，
         *   否则那条并发保护测不到 —— 而"测试通过但没测到"比没测更危险。
         *   在 mock 里补齐，**不在业务代码里绕开**。
         */
        async update({ data }) {
          const hit = rows().filter(d => match(d, cond))
          hit.forEach(d => {
            Object.keys(data).forEach(k => {
              /* ★ 必须像 doc().update() 一样处理 `_.push` ——
                 第一版漏了它，把 `{__op:'push', v:'QP'}` 整个对象写进了 members，
                 于是 view() 里 members.filter 报 "not a function"。
                 mock 的操作符处理必须与 doc().update() 保持一致。 */
              if (data[k] && data[k].__op === 'push') d[k] = (d[k] || []).concat(data[k].v)
              else d[k] = data[k]
            })
          })
          return { stats: { updated: hit.length } }
        }
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
const moments = require(base('moments'))
const initdb = require(base('initdb'))

const DENG = 'oid_denglin'
const QP = 'oid_chenqianping'

let pass = 0
function ok(msg) { pass++; console.log('  ✓ ' + msg) }

;(async () => {
  console.log('\n=== 准备：建库 ===')
  const init = await initdb.main()
  assert.ok(init.ok, 'initdb 应成功')
  ok(`initdb 建了 ${Object.keys(store).length} 个集合（created ${init.created.length} / 已存在 ${init.alreadyExists.length}）`)

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

  /*
   * ★★ 并发配对：两个不同 openid **同时**用同一个邀请码，不能三人同窝
   *
   * 老写法是「读 target → 检查 members.length < 2 → `_.push(OPENID)`」。
   * `_.push` 原子追加，但**不检查追加前的人数** —— 读和写之间的窗口里
   * 两个请求都读到 members=[host]、都通过检查，然后各自 push：
   * members 变成 [host, A, B] → **三人同窝**。
   * 而 `inviteActive: false` 挡不住第二个：它的 update 是无条件的。
   *
   * 后果特别重：pair 是"两人分区"这个产品的**根**，
   * 三人群会让所有挂 pairId 的查询（moments / wishes / cools…）语义全乱。
   *
   * 修法：把"邀请码还有效"做成**更新条件** → 第二个请求 matched=0 → 明确拒绝。
   */
  {
    const snap = JSON.parse(JSON.stringify(store.pairs))
    store.pairs.length = 0

    CURRENT_OPENID = 'host_c'
    const cc = await pair.main({ action: 'create' })
    assert.ok(cc.ok, '建房应成功')

    /* 两个不同的人**同时** join 同一个码（真并发，不是串行） */
    const oldOid = CURRENT_OPENID
    const jA = (async () => { CURRENT_OPENID = 'conc_A'; return pair.main({ action: 'join', code: cc.code }) })()
    const jB = (async () => { CURRENT_OPENID = 'conc_B'; return pair.main({ action: 'join', code: cc.code }) })()
    const [rA, rB] = await Promise.all([jA, jB])
    CURRENT_OPENID = oldOid

    const okCount = [rA, rB].filter(x => x.ok).length
    assert.strictEqual(okCount, 1,
      '★ 同一个邀请码被两个人同时使用，成功数应为 1，实际 ' + okCount + '\n' +
      '    老写法（裸 _.push + 无条件 update）会让两人都进去 → **三人同窝**。\n' +
      '    修法：where({_id, inviteActive:true, inviteCode}).update(...)，' +
      '第二个请求会拿到 stats.updated=0，据此拒绝。')

    const pd = store.pairs.filter(p => (p.members || []).indexOf('host_c') >= 0)[0]
    assert.ok(pd, '房主的 pair 应还在')
    assert.strictEqual(pd.members.length, 2,
      '★ members 应为 2 人，实际 ' + pd.members.length + ' 人：' + JSON.stringify(pd.members))
    assert.strictEqual(pd.inviteActive, false, '配对后邀请码必须作废')
    ok('★ 并发配对只有一人成功，members 恰好 2 人（不会三人同窝）')

    /* 恢复：这批并发测试的 pair 不影响后续断言 */
    store.pairs.length = 0
    snap.forEach(x => store.pairs.push(x))
    CURRENT_OPENID = oldOid
  }

  console.log('\n=== 3. 填在一起的日子（全库唯一时间输入）===')
  CURRENT_OPENID = DENG
  const st = await pair.main({ action: 'set', anniversary: '2024-03-26' })
  assert.ok(st.ok && st.pair.anniversary === '2024-03-26')
  assert.strictEqual(store.pairs.filter(p => p._id === pid)[0].anniversary, '2024-03-26')
  ok('anniversary 已存，其余时间值全部由 derive.js 现算')

  console.log('\n=== 4. 随手记：邓林记一条 ===')
  CURRENT_OPENID = DENG
  const m1 = await moments.main({
    action: 'add', text: '今天一起去了菜市场', mood: 'happy',
    photos: ['cloud://x/moments/a.jpg'], thumbs: ['cloud://x/moments/a_thumb.jpg']
  })
  assert.ok(m1.ok && m1.id, '写一条应成功')
  ok('记下了，id=' + m1.id)

  console.log('\n=== 5. ★ 随手记不是双盲：她立刻能看见 ===')
  CURRENT_OPENID = QP
  const l1 = await moments.main({ action: 'list' })
  assert.ok(l1.ok, '列表应成功')
  assert.strictEqual(l1.list.length, 1, '应看到 1 条')
  assert.strictEqual(l1.list[0].text, '今天一起去了菜市场', '★ 对方刚写的正文必须立刻可见')
  assert.strictEqual(l1.list[0].who, 'partner', '应标记为对方写的')
  assert.strictEqual(l1.list[0].mine, false)
  ok('★ 她立刻看到邓林刚写的内容（双盲是答题的规则，不是记录的规则）')

  console.log('\n=== 6. 缩略图字段必须完整往返 ===')
  assert.deepStrictEqual(l1.list[0].thumbs, ['cloud://x/moments/a_thumb.jpg'], 'thumbs 必须原样返回')
  assert.deepStrictEqual(l1.list[0].photos, ['cloud://x/moments/a.jpg'])
  ok('photos 与 thumbs 一一对应返回（列表用小图，点开才用原图）')

  console.log('\n=== 7. 一个人也能先用（不用等对方加入）===')
  /* 单人场景要单独造一个小窝：一个 openid 只能属于一个 pair，
     上面 DENG 已经在两人小窝里了，所以换一个没配对的 openid 来验。 */
  CURRENT_OPENID = 'oid_solo_user'
  const soloCreate = await pair.main({ action: 'create' })
  assert.ok(soloCreate.ok, '单人应能建窝')
  const soloList = await moments.main({ action: 'list' })
  assert.ok(soloList.ok, '单人状态下也应能用')
  assert.strictEqual(soloList.solo, true, '应标记为单人')
  const soloAdd = await moments.main({ action: 'add', text: '一个人的第一条' })
  assert.ok(soloAdd.ok, '单人应能记录')
  ok('未配对时 solo=true，仍可记录（不用等她进来才敢动笔）')

  /* 回到两人小窝继续后面的用例 */
  CURRENT_OPENID = DENG

  console.log('\n=== 8. 内容安全被调用，敏感内容被拦 ===')
  const before = SEC_CALLS
  const bad = await moments.main({ action: 'add', text: '这是一条违禁内容测试' })
  assert.strictEqual(bad.ok, false, '敏感内容应被拒')
  assert.ok(SEC_CALLS > before, 'msgSecCheck 必须被调用')
  assert.strictEqual(store.moments.filter(m => /违禁/.test(m.text || '')).length, 0, '敏感内容不得落库')
  ok(`msgSecCheck 调用 ${SEC_CALLS} 次，敏感内容被拦在写库之前 ✓`)

  console.log('\n=== 9. 空内容不许提交 ===')
  const empty = await moments.main({ action: 'add', text: '   ' })
  assert.strictEqual(empty.ok, false, '既没文字也没照片应被拒')
  ok('空记录被拒：「' + empty.msg + '」')

  console.log('\n=== 10. 超长文本被截断，照片最多 3 张 ===')
  const long = await moments.main({
    action: 'add', text: 'x'.repeat(800),
    photos: ['a', 'b', 'c', 'd', 'e'], thumbs: ['a', 'b', 'c', 'd', 'e']
  })
  assert.ok(long.ok)
  const saved = store.moments.filter(m => m._id === long.id)[0]
  assert.strictEqual(saved.text.length, 500, '正文应截到 500 字')
  assert.strictEqual(saved.photos.length, 3, '照片应截到 3 张')
  assert.strictEqual(saved.thumbs.length, 3, '缩略图必须同步截到 3 张，否则错位')
  ok('正文截到 500 字、照片与缩略图同步截到 3 张')

  console.log('\n=== 11. 只能删自己记的 ===')
  CURRENT_OPENID = QP
  const steal = await moments.main({ action: 'remove', id: m1.id })
  assert.strictEqual(steal.ok, false, '不能删对方记的')
  ok('删别人的被拒：「' + steal.msg + '」')

  CURRENT_OPENID = DENG
  const own = await moments.main({ action: 'remove', id: m1.id })
  assert.ok(own.ok, '删自己的应成功')
  ok('删自己的成功')

  console.log('\n=== 12. 越权：别人的记录删不掉 ===')
  store.moments.push({
    _id: 'alien', pairId: 'other_pair', by: DENG, text: '别人家的',
    photos: [], thumbs: [], date: '2026-01-01', at: '2026-01-01 10:00'
  })
  const alien = await moments.main({ action: 'remove', id: 'alien' })
  assert.strictEqual(alien.ok, false, '跨小窝的记录不能删')
  ok('跨小窝删除被拒：「' + alien.msg + '」')

  console.log('\n=== 13. 按天聚合（编年史的数据源）===')
  CURRENT_OPENID = DENG
  await moments.main({ action: 'add', text: '同一天第二条' })
  const days = await moments.main({ action: 'days', size: 10 })
  assert.ok(days.ok && days.days.length, '应返回按天聚合的数据')
  assert.ok(days.days[0].items.length >= 1, '每天下面应挂 items')
  ok(`按天聚合：${days.totalDays} 天，最新一天 ${days.days[0].items.length} 条`)

  console.log('\n=== 14. 统计：总条数与天数 ===')
  const stats = await moments.main({ action: 'stats' })
  assert.ok(stats.ok)
  assert.ok(stats.total >= 2, '总数应统计到')
  assert.ok(stats.days >= 1, '天数应统计到')
  ok(`统计：共 ${stats.total} 条 / ${stats.days} 天`)

  console.log('\n=== 15. 没配对的人什么都拿不到 ===')
  CURRENT_OPENID = 'oid_stranger'
  const s1 = await moments.main({ action: 'list' })
  assert.strictEqual(s1.ok, false, '陌生人应被拒')
  assert.strictEqual(s1.code, 'NO_PAIR')
  ok('未配对 openid 读不到任何小窝数据 ✓')

  console.log('\n=== 16. 数据隔离：所有记录都挂在 pairId 上 ===')
  const leak = store.moments.filter(m => !m.pairId).length
  assert.strictEqual(leak, 0, '不应有无 pairId 的脏数据')
  ok(`moments ${store.moments.length} 条，全部带 pairId ✓`)

  console.log(`\n${'='.repeat(58)}`)
  console.log(`  全部 ${pass} 项断言通过 —— 配对与随手记链路成立`)
  console.log(`${'='.repeat(58)}\n`)
})().catch(e => {
  console.error('\n  ✗ 断言失败：', e.message, '\n')
  process.exit(1)
})
