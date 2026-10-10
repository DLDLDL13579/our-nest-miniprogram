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
 *
 * ============ ⚠️ 反向验证这条断言时，判据用**退出码**，别数关键字 ============
 *
 * 本文件的失败路径是 `console.error('✗ 失败：', ...)` + `process.exit(1)`，
 * **输出里没有 `AssertionError` 字样**。
 * 我在这里栽过两次：改坏代码后用 `grep -c AssertionError` 数结果 → 数到 0，
 * 于是误判成"断言漏报"，接着去改本来正确的断言。
 *
 * 正确写法：
 *     node scripts/test-contract.js > /dev/null 2>&1; echo "exit=$?"
 *     # exit=1 → 断言有效；exit=0 → 断言是废的
 *
 * （同类错误在 test-room.js 里也发生过一次 —— 那次是 grep 格式不匹配，
 *   把"验证成功"读成了"验证失败"。凡是**用输出文本判断程序结果**都不可靠，
 *   退出码才是程序自己给出的判据。）
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
        async count() { return { total: rows().filter(d => match(d, cond)).length } },
        /*
         * ★ 条件更新 —— pair.join 靠它做原子闸门（第二个并发请求拿到 updated=0）。
         *   mock 缺了它就报 "is not a function"，而且**报错被 catch 吞掉后
         *   测试可能照样 exit=0**（假绿）。在 mock 里补齐，不在业务代码里绕开。
         */
        async update({ data }) {
          const hit = rows().filter(d => match(d, cond))
          hit.forEach(d => {
            Object.keys(data).forEach(k => {
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
  assert.ok(c.ok && c.code, '准备阶段：生成邀请码应成功 —— ' + (c.msg || ''))

  OPENID = Q
  /*
   * ★★ 准备阶段的每一步都必须**断言成功**，不能只 await。
   *
   * 原来这里是裸的 `await pair.main({action:'join'})` —— join 失败时
   * 脚本照样往下跑，后面 30 项断言就在一个"其实没配对"的假状态上执行。
   * 而它们**可能照样打印 ✓**（假绿），因为很多断言只检查字段形状、
   * 不检查数据是否真的存在。
   *
   * 实际发生过：mock 缺 `where().update()` → join 抛错被吞 → 整个文件
   * 内部报错但 **exit=0**，`test-all.sh` 完全看不出来。
   */
  const pj = await pair.main({ action: 'join', code: c.code })
  assert.ok(pj.ok, '准备阶段：配对应成功 —— ' + (pj.msg || ''))

  OPENID = D
  const ps = await pair.main({ action: 'set', anniversary: '2024-03-26' })
  assert.ok(ps.ok, '准备阶段：设置纪念日应成功 —— ' + (ps.msg || ''))

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

  /* ============ ③a require 的相对路径必须指到真实文件 ============ */
  console.log('\n=== ③a require 路径必须真实存在（白屏杀手）===')
  /*
   * 为什么加这条：2026-09-30 踩过一次 —— 游戏页在 pages/game/dice/ 下（两层深），
   * 我写了 require('../../utils/sfx.js')，实际应该是 '../../../utils/'。
   * 后果不是报个错就算了，而是**整个页面白屏**，控制台只有一句
   *   module 'pages/utils/sfx.js' is not defined
   * 更糟的是：check.sh（语法）和契约测试（死绑定）都发现不了它 ——
   * 语法是对的、绑定也是对的，只有真跑起来才炸。
   * 所以在这里静态解析 require 路径，直接验证文件存在。
   */
  const badRequire = []
  function walkJs(dir, out) {
    out = out || []
    fs.readdirSync(dir).forEach(f => {
      const p = path.join(dir, f)
      if (fs.statSync(p).isDirectory()) walkJs(p, out)
      else if (f.endsWith('.js')) out.push(p)
    })
    return out
  }
  walkJs(path.join(ROOT, 'miniprogram')).forEach(jsFile => {
    let src = fs.readFileSync(jsFile, 'utf8')
    /* 先剥掉注释再解析 —— 否则会把文档里举例的 require 当成真代码
       （derive.js 头部就有个示例，第一次跑就误报了） */
    src = src
      .replace(/\/\*[\s\S]*?\*\//g, '')      // 块注释
      .replace(/(^|[^:])\/\/[^\n]*/g, '$1')  // 行注释（不误伤 http://）
    /* 匹配 require('...') 里的相对路径（跳过 wx.cloud / 绝对模块名） */
    const re = /require\(\s*['"](\.[^'"]+)['"]\s*\)/g
    let m
    while ((m = re.exec(src))) {
      const rel = m[1]
      const target = path.resolve(path.dirname(jsFile), rel)
      /* 允许省略 .js 后缀 */
      const candidates = [target, target + '.js', path.join(target, 'index.js')]
      if (!candidates.some(c => fs.existsSync(c) && fs.statSync(c).isFile())) {
        badRequire.push(path.relative(ROOT, jsFile) + " → require('" + rel + "') 解析到 " +
          path.relative(ROOT, target) + '（不存在）')
      }
    }
  })
  assert.deepStrictEqual(badRequire, [],
    '存在解析不到文件的 require（会让页面白屏）：\n    ' + badRequire.join('\n    '))
  ok('全部 require 相对路径都能解析到真实文件')

  /* ============ ③c 模板里的动态 class 必须有 CSS 定义 ============ */
  console.log('\n=== ③c 动态 class 必须有样式定义（否则动画白写） ===')
  /*
   * 为什么加这条：模板里写 {{cond ? 'shaking' : ''}} 但 wxss 忘了定义 .shaking 时，
   * 小程序**不会报错**，只是那个状态没有任何视觉变化 ——
   * "动画写了却没生效"这种事靠肉眼很难发现（尤其状态是瞬时的）。
   *
   * 实测抓到两个真的：.table.shaking 和 .result.show 都没定义。
   *
   * 扫描注意：必须排除两类误报 ——
   *   ① {{cond ? '中文文案' : ''}} 里的中文（不是类名）
   *   ② {{x === 'shaking' ? ...}} 里作为**比较值**出现的字符串
   * 第一版没排除，报了 24 条全是误报。
   */
  const missingCls = []
  function walkWxml(dir, out) {
    out = out || []
    fs.readdirSync(dir).forEach(f => {
      const p = path.join(dir, f)
      if (fs.statSync(p).isDirectory()) walkWxml(p, out)
      else if (f.endsWith('.wxml')) out.push(p)
    })
    return out
  }
  const appCss = fs.readFileSync(path.join(ROOT, 'miniprogram', 'app.wxss'), 'utf8')
  walkWxml(path.join(ROOT, 'miniprogram', 'pages')).forEach(wxml => {
    const wxss = wxml.replace(/\.wxml$/, '.wxss')
    let css = appCss
    if (fs.existsSync(wxss)) css += fs.readFileSync(wxss, 'utf8')
    const tpl = fs.readFileSync(wxml, 'utf8')

    /*
     * ★ 只扫 class 属性里的表达式 —— 这一点踩过坑。
     *
     * 2.6.0 加了骰盅之后，模板里有这么一段：
     *     <image src="/images/cup/{{item.diceCount > 0 ? 'cup-down' : 'cup-shake'}}.png" />
     * 这里的 'cup-down' / 'cup-shake' 是**图片文件名**，不是 CSS 类。
     * 但旧版断言扫的是"所有 {{...}} 里的字符串字面量"，于是把它当类名去 CSS 里找，
     * 报了两条**假失败**。
     *
     * 修法：先用正则把 `class="..."` 属性整体抓出来，只在这些片段里找表达式。
     * 这样 src / data-* / style 里的字符串都不会被误判。
     */
    const classRe = /class\s*=\s*"([^"]*)"/g
    let cm
    while ((cm = classRe.exec(tpl))) {
      const clsAttr = cm[1]
      const re = /\{\{([^}]*)\}\}/g
      let m
      while ((m = re.exec(clsAttr))) {
        const expr = m[1]
        if (expr.indexOf('?') < 0) continue
        /*
         * ★ 先剥掉"比较部分"再提取类名。
         *
         * 为什么不能"按字符串值排除"：`phase === 'shaking' ? 'shaking' : ''` 里
         * 同一个 `shaking` 既是比较值**又是**类名。第一版按值排除，
         * 结果两个都被跳过 —— 反向验证时故意删掉 .shaking 的定义，
         * 测试照样通过，等于这条检查根本没工作。
         *
         * 用"先删除 === '...' 片段"就没这个问题：
         * 删完剩下 `phase  ? 'shaking' : ''`，再提取就只剩类名。
         */
        const stripped = expr.replace(/===?\s*'[^']*'/g, '')
        const lits = stripped.match(/'[a-zA-Z][\w-]*'/g) || []
        lits.forEach(q => {
          const lit = q.slice(1, -1)
          /* 词边界匹配，不用 indexOf 子串 ——
             `.table.shakingX` 里包含 `.table.shaking` 这个前缀，
             子串检查会误判成"存在"。CSS 类名后面不能跟 [\w-]。 */
          const re2 = new RegExp('\\.' + lit + '(?![\\w-])')
          if (!re2.test(css)) {
            missingCls.push(path.relative(ROOT, wxml) + ' → .' + lit)
          }
        })
      }
    }
  })
  assert.deepStrictEqual(missingCls, [],
    '模板用了这些动态 class 但 CSS 里没定义（动画不会生效，且不报错）：\n    ' +
    missingCls.join('\n    '))
  ok('全部动态 class 都有 CSS 定义（动画不会白写）')

  /* ============ ③c-2 变量插值的 class 也要有定义 ============ */
  /*
   * ★ 这条是 2.6.0 加骰盅时才发现的**真正盲区**（比 ③c 那个误报严重得多）。
   *
   * 骰盅的模板是这么写的：
   *     <image class="cs-cup {{cupCls}}" ... />
   * 而 `cupCls` 的值在 **js** 里：
   *     this.setData({ cupCls: 'shaking' })
   *
   * ③c 只扫 wxml，所以这种写法它**永远看不到** ——
   * 我把 .cs-cup.shaking 的 CSS 改名做反向验证，断言照样通过（= 废的）。
   * 而这类拼错的后果和 ③c 一样：动画不生效，页面不报错，
   * 只是"摇盅的时候盅不晃"，要靠肉眼才能发现。
   *
   * 修法：扫同名 js 里所有 `xxxCls: '字面量'` 形式的赋值，
   * 把值当类名去 CSS 里找。（变量名以 Cls/class 结尾是约定，
   * 本项目的动态 class 全部走这个约定。）
   */
  const missingVarCls = []
  walkWxml(path.join(ROOT, 'miniprogram', 'pages')).forEach(wxml => {
    const js = wxml.replace(/\.wxml$/, '.js')
    if (!fs.existsSync(js)) return
    const wxss = wxml.replace(/\.wxml$/, '.wxss')
    let css = appCss
    if (fs.existsSync(wxss)) css += fs.readFileSync(wxss, 'utf8')

    const tpl = fs.readFileSync(wxml, 'utf8')
    const src = fs.readFileSync(js, 'utf8')
      .replace(/\/\*[\s\S]*?\*\//g, '')
      .replace(/(^|[^:])\/\/[^\n]*/g, '$1')

    /* 找出模板里所有 {{xxxCls}} 形式的插值 */
    const varRe = /\{\{\s*([a-zA-Z_$][\w$]*[Cc]ls)\s*\}\}/g
    let vm
    const vars = []
    while ((vm = varRe.exec(tpl))) vars.push(vm[1])
    if (!vars.length) return

    vars.forEach(v => {
      /* 抓 js 里所有 `v: 'a b c'` 的赋值，拆成单个类名 */
      const setRe = new RegExp(v + '\\s*:\\s*\'([^\']*)\'', 'g')
      let sm
      while ((sm = setRe.exec(src))) {
        sm[1].split(/\s+/).filter(Boolean).forEach(lit => {
          const re2 = new RegExp('\\.' + lit + '(?![\\w-])')
          if (!re2.test(css)) {
            missingVarCls.push(path.relative(ROOT, wxml) + ' → ' + v + " = '" + lit + "'")
          }
        })
      }
    })
  })
  assert.deepStrictEqual(missingVarCls, [],
    'js 里赋给 class 变量的这些值在 CSS 里没定义（动画不生效且不报错）：\n    ' +
    missingVarCls.join('\n    '))
  ok('js 里变量插值的动态 class 也都有 CSS 定义')

  /* ============ ③d wxml 引用的图片必须真实存在 ============ */
  console.log('\n=== ③d 模板引用的图片文件必须存在（骰子图那类）===')
  /*
   * 为什么加这条：2.5.0 把骰子从 CSS 拼装改成**离线渲染的图片**
   * （miniprogram/images/dice/dice-1..6.png，由 scripts/render-dice.py 生成）。
   *
   * 这引入了一类全新的静默故障：图片没生成 / 被误删 / 路径写错时，
   * `<image>` 只是**不显示**，不报错、不警告，页面照常渲染 ——
   * 骰子直接消失，而 check.sh 与其它断言都发现不了。
   *
   * 这里静态解析 wxml 里所有以 / 开头的 src，验证文件真实存在。
   */
  const missingImg = []
  function walkWxmlImg(dir, out) {
    out = out || []
    fs.readdirSync(dir).forEach(f => {
      const p = path.join(dir, f)
      if (fs.statSync(p).isDirectory()) walkWxmlImg(p, out)
      else if (f.endsWith('.wxml')) out.push(p)
    })
    return out
  }
  walkWxmlImg(path.join(ROOT, 'miniprogram', 'pages')).forEach(wxml => {
    const tpl = fs.readFileSync(wxml, 'utf8')
    const re = /src\s*=\s*"(\/[^"]+)"/g
    let m
    while ((m = re.exec(tpl))) {
      const raw = m[1]
      if (raw.indexOf('{{') < 0) {
        /* 纯静态路径：直接判断存在 */
        if (!fs.existsSync(path.join(ROOT, 'miniprogram', raw))) {
          missingImg.push(path.relative(ROOT, wxml) + ' → ' + raw)
        }
      } else {
        /*
         * 含动态片段：把 {{...}} 换成通配再匹配目录下的真实文件。
         * 例：/images/dice/dice-{{item.v}}.png → 该目录下必须存在 dice-*.png。
         *
         * ★ 顺序不能反：必须**先替换 {{...}}、再转义正则元字符**。
         * 反过来的话 `{` 会先被转义成 `\{`，后面就再也匹配不到 `{{` 了 ——
         * 结果是这条断言对动态路径永远报"无匹配文件"（假失败）。
         */
        const dir = path.dirname(raw)
        const base = path.basename(raw)
        const esc = base.replace(/\{\{[^}]*\}\}/g, '\u0000')
                        .replace(/[.*+?^${}()|[\]\\]/g, '\\$&')
                        .replace(/\u0000/g, '.*')
        const pat = new RegExp('^' + esc + '$')
        const absDir = path.join(ROOT, 'miniprogram', dir)
        const hit = fs.existsSync(absDir) &&
          fs.readdirSync(absDir).some(f => pat.test(f))
        if (!hit) {
          missingImg.push(path.relative(ROOT, wxml) + ' → ' + raw + '（目录下无匹配文件）')
        }
      }
    }
  })
  assert.deepStrictEqual(missingImg, [],
    '模板引用了这些图片但文件不存在（image 组件静默不显示，页面不报错）：\n    ' +
    missingImg.join('\n    '))
  ok('模板引用的图片全部存在')

  /* 骰子图必须 6 张齐全 —— 缺哪张，哪个点数就整颗骰子消失 */
  const diceDir = path.join(ROOT, 'miniprogram', 'images', 'dice')
  const diceMissing = []
  for (let v = 1; v <= 6; v++) {
    if (!fs.existsSync(path.join(diceDir, 'dice-' + v + '.png'))) diceMissing.push('dice-' + v + '.png')
  }
  assert.deepStrictEqual(diceMissing, [],
    '骰子图不齐（缺哪个点数，哪颗骰子就不显示）：\n    ' + diceMissing.join('\n    '))
  ok('骰子图 1~6 六张齐全')

  /* ============ ③b 音效键必须注册且文件存在 ============ */
  console.log('\n=== ③b 音效：调用的键必须已注册，注册的必须有文件 ===')
  /*
   * 为什么加这条：音效是这个项目里最容易"静默失效"的东西 ——
   *   · 页面调 sfx.play('foo') 但 foo 没注册 → 只在控制台 warn，玩家听不到声
   *   · 注册了但 wav 文件没生成 → 同样静默，只是"这个音不出"
   * 两者都不会让页面报错，所以必须静态检查。
   *
   * 注意扫描方式：只认 `sfx.play('xxx')` 这种**直接传字符串**的调用。
   * 第一版扫描把三元表达式里的所有字符串都抓了（`play(k === 'room' ? 'whoosh' : 'tap')`
   * 里的 'room' 被当成音效名），产生误报。宁可少查也不要误报。
   */
  const sfxSrc = fs.readFileSync(path.join(ROOT, 'miniprogram', 'utils', 'sfx.js'), 'utf8')
  const filesBlock = sfxSrc.slice(sfxSrc.indexOf('const FILES = {'), sfxSrc.indexOf('\n}', sfxSrc.indexOf('const FILES = {')))
  const soundKeys = {}
  {
    const re = /^\s*([\w]+):\s*'(audio\/[\w-]+\.wav)'/gm
    let m
    while ((m = re.exec(filesBlock))) soundKeys[m[1]] = m[2]
  }

  /* ① 注册的音效必须有对应文件 */
  const noFile = Object.keys(soundKeys).filter(k =>
    !fs.existsSync(path.join(ROOT, 'miniprogram', soundKeys[k])))
  assert.deepStrictEqual(noFile, [],
    '这些音效注册了但文件不存在（播放时静默失败）：\n    ' + noFile.join('\n    '))
  ok(`${Object.keys(soundKeys).length} 个音效全部有对应文件`)

  /* ② 页面直接传字符串的调用必须已注册 */
  const unregistered = []
  function walkPages(dir, out) {
    out = out || []
    fs.readdirSync(dir).forEach(f => {
      const p = path.join(dir, f)
      if (fs.statSync(p).isDirectory()) walkPages(p, out)
      else if (f.endsWith('.js')) out.push(p)
    })
    return out
  }
  walkPages(path.join(ROOT, 'miniprogram', 'pages')).forEach(jsFile => {
    const lines = fs.readFileSync(jsFile, 'utf8').split('\n')
    lines.forEach((line, i) => {
      const re = /sfx\.play\(\s*'([\w]+)'/g
      let m
      while ((m = re.exec(line))) {
        if (!(m[1] in soundKeys)) {
          unregistered.push(path.relative(ROOT, jsFile) + ':' + (i + 1) + '  → ' + m[1])
        }
      }
    })
  })
  assert.deepStrictEqual(unregistered, [],
    '这些音效调用没有注册（不会报错，只是没声音）：\n    ' + unregistered.join('\n    '))
  ok('全部音效调用都已注册')

  /* ③ 池化列表（POOL_SIZE）不能有幽灵条目 ——
     删音效时很容易忘了它还在池化表里，虽然不报错，
     但那份配置就成了误导（下一个人会以为这个音效还在用）。 */
  const poolBlock = sfxSrc.slice(sfxSrc.indexOf('const POOL_SIZE = {'),
    sfxSrc.indexOf('\n}', sfxSrc.indexOf('const POOL_SIZE = {')))
  const poolKeys = []
  {
    const re = /^\s*([\w]+):\s*\d/gm
    let m
    while ((m = re.exec(poolBlock))) poolKeys.push(m[1])
  }
  const ghostPool = poolKeys.filter(k => !(k in soundKeys))
  assert.deepStrictEqual(ghostPool, [],
    'POOL_SIZE 里有已删除的音效（幽灵配置）：\n    ' + ghostPool.join('\n    '))
  ok(`池化配置 ${poolKeys.length} 条，无幽灵条目`)

  /* ============ ③b-2 音频质量：直流偏置与响度 ============ */
  console.log('\n=== ③b-2 音频质量：直流偏置必须为 0，且不能有「过轻」的音效 ===')
  /*
   * 2026-10-08 全面体检时用客观测量（不是听感）查出来的两个真问题：
   *
   * ① **直流偏置**：9 个音效的信号均值不为 0（最重达 1.53% 满量程）。
   *    带偏置的音频播放时，喇叭要做"多推/多拉一下"的位移去平衡这段偏移，
   *    听感上就是**开头"噗"的一声闷响** —— 这是很典型的廉价感。
   *
   *    ⚠️ 这里踩过一个反直觉的坑：浮点域把直流去干净了，
   *    但 `int(v*32767)` 是**向零截断**，给每个样本引入 -0.5 LSB 的
   *    系统性偏置 —— 浮点 DC 只有 -0.009（可忽略），转 int16 后变成 **-306**。
   *    **四舍五入也救不了**（实测 DC 完全一样）。
   *    唯一可靠的办法是量化之后再减一次整数均值（gen-audio.py 的 quantize()）。
   *
   * ② **过轻**：19 个音效 RMS 不到峰值的 3% —— 峰值高但能量极短，
   *    在游戏里混着播会被盖过，听起来"薄、很轻"。
   *
   * 这两条都**不会让任何检查失败**，只能靠数值体检发现，所以写成断言。
   */
  const audioDir = path.join(ROOT, 'miniprogram', 'audio')
  const audioFiles = fs.readdirSync(audioDir).filter(f => f.endsWith('.wav'))
  const dcBad = []
  const loudBad = []
  let dcWorst = 0
  audioFiles.forEach(f => {
    const buf = fs.readFileSync(path.join(audioDir, f))
    /* WAV: 44 字节头，找 fmt/data 块 */
    let pos = 12, dataOff = -1, dataLen = 0
    while (pos + 8 <= buf.length) {
      const id = buf.toString('ascii', pos, pos + 4)
      const sz = buf.readUInt32LE(pos + 4)
      if (id === 'data') { dataOff = pos + 8; dataLen = sz; break }
      pos += 8 + sz + (sz % 2)
    }
    if (dataOff < 0) return
    let sum = 0, sumSq = 0, n = dataLen >> 1
    for (let i = 0; i < n; i++) {
      const v = buf.readInt16LE(dataOff + i * 2)
      sum += v; sumSq += v * v
    }
    if (!n) return
    const dc = Math.abs(sum / n)
    const rms = Math.sqrt(sumSq / n)
    if (dc > dcWorst) dcWorst = dc
    if (dc > 50) dcBad.push(f + ' (DC=' + dc.toFixed(0) + ')')

    /*
     * 响度判据 ★ 必须区分两类音效，不能一刀切用 RMS：
     *
     *   · 连续型（摇盅声、倒数声）：整体 RMS 才有意义
     *   · 零散撞击型（入盅的几声脆响、骰子在桌上滚两下）：
     *     大部分时间是静音，**整体 RMS 天然就低**（这是对的，不是缺陷）。
     *     这类要看**单次撞击的峰值** —— 实测 dice-into-cup 整体 RMS 只有 1.6%，
     *     但撞击峰值有 76%，混播时完全听得见。
     *     一刀切用 RMS 会把它误判成"过轻"，然后错误地把它推响 → 削顶失真。
     *
     * 所以判据是「两者取其一达标即可」：
     *   整体 RMS ≥ 3.5%   （连续型够响）
     *   或 撞击峰值 ≥ 55%  （撞击型够响）
     */
    const rmsRatio = rms / 32768
    /* 撞击峰值：按 10ms 分窗（采样率未知，用 441 采样 ≈ 10ms@22.05k 的下界近似） */
    const win = Math.max(1, Math.round(dataLen / Math.max(1, n / 441) * 0.01))
    let hitPeak = 0
    for (let i = 0; i + win < n; i += win) {
      let mx = 0
      for (let k = i; k < i + win; k++) {
        const v = Math.abs(buf.readInt16LE(dataOff + k * 2))
        if (v > mx) mx = v
      }
      if (mx > hitPeak) hitPeak = mx
    }
    const hitRatio = hitPeak / 32768
    if (rmsRatio < 0.035 && hitRatio < 0.55) {
      loudBad.push(f + ' (RMS=' + (rmsRatio * 100).toFixed(1) + '%' +
        ' 撞击峰值=' + (hitRatio * 100).toFixed(0) + '%)')
    }
  })
  assert.deepStrictEqual(dcBad, [],
    '这些音效有直流偏置（播放时会有开头"噗"的一声闷响，典型廉价感）：\n    ' +
    dcBad.join('\n    '))
  ok(audioFiles.length + ' 个音效直流偏置全部为 0（最大 ' + dcWorst.toFixed(1) + '/32768）')

  assert.deepStrictEqual(loudBad, [],
    '这些音效过轻（RMS 低于 −32 dBFS，游戏里混播会被盖过）：\n    ' + loudBad.join('\n    '))
  ok('没有过轻的音效（峰值有余量的都已推上去）')

  /* 音效总量：超过 1.1MB 就该重新审视（小程序主包上限 2MB） */
  let audioBytes = 0
  audioFiles.forEach(f => { audioBytes += fs.statSync(path.join(audioDir, f)).size })
  assert.ok(audioBytes < 1.15 * 1024 * 1024,
    `音频总计 ${(audioBytes / 1024 / 1024).toFixed(2)} MB，超出预算（主包上限 2 MB）`)
  ok(`音频总计 ${(audioBytes / 1024).toFixed(0)} KB（在 1.15 MB 预算内）`)

  /* ============ ③e 图标系统：禁止 emoji 回潮 + image 必须有尺寸 ============ */
  console.log('\n=== ③e 图标：必须用内联 SVG，且 <image> 图标必须有尺寸 ===')
  /*
   * 2026-10-08 全面审查实测：项目里有 **31 种 emoji、56 个使用点**（18 个文件）。
   * emoji 是小程序专业度最大的破绽：
   *   ① 跨机型完全不一致（iOS 彩色立体 / Android 黑白单色）
   *   ② 颜色不可控，放进设计好的配色体系里会显得很脏
   *   ③ 视觉大小基线不齐，排列时对不准
   *
   * 换成 miniprogram/utils/icons.js 的内联 SVG 后，这两条会防止回潮。
   */
  const wxmlFiles = []
  ;(function walkW(d) {
    fs.readdirSync(d).forEach(f => {
      const p = path.join(d, f)
      if (fs.statSync(p).isDirectory()) walkW(p)
      else if (f.endsWith('.wxml')) wxmlFiles.push(p)
    })
  })(path.join(ROOT, 'miniprogram', 'pages'))

  /* ① 模板里不该再有 emoji（★ 只扫 text 节点与属性值，跳过注释） */
  const emojiRe = /[\u{1F300}-\u{1FAFF}\u{2600}-\u{27BF}\u{2B00}-\u{2BFF}\u{FE0F}\u{2190}-\u{21FF}]/u
  const emojiHits = []
  wxmlFiles.forEach(f => {
    /* 先剥掉注释 —— 注释里写「这里用 📅」不该报错 */
    const raw = fs.readFileSync(f, 'utf8').replace(/<!--[\s\S]*?-->/g, '')
    raw.split('\n').forEach((line, i) => {
      const ms = line.match(emojiRe)
      if (ms) {
        emojiHits.push(path.relative(ROOT, f) + ':' + (i + 1) + ' → ' +
          Array.from(new Set(ms)).join(''))
      }
    })
  })
  assert.deepStrictEqual(emojiHits, [],
    '模板里还有 emoji（跨机型渲染不一致，应换成 utils/icons.js 的内联 SVG）：\n    ' +
    emojiHits.join('\n    '))
  ok('模板里已无 emoji（全部换成内联 SVG 图标）')

  /* ② <image class="X"> 的 X 必须在 wxss 里有 width/height。
   *    ⚠️ 这条是实测踩出来的：图标改成 <image> 后，
   *    原来只写了 font-size 的类（比如 .lh-mute { font-size:34rpx }）
   *    对 <image> **完全无效** —— image 会撑满容器，
   *    实测把游戏大厅的喇叭放大到占半屏，把文字挤成竖排。
   *    而且它**不报错**，只是"看起来很奇怪"。
   */
  const appCss2 = fs.readFileSync(path.join(ROOT, 'miniprogram', 'app.wxss'), 'utf8')
  const noSize = []
  /* ③e-3 用（在本段之后断言）：class 压根没定义的 <image> */
  const undefinedCss = []
  wxmlFiles.forEach(f => {
    const wxss = f.replace(/\.wxml$/, '.wxss')
    let css = appCss2
    if (fs.existsSync(wxss)) css += fs.readFileSync(wxss, 'utf8')
    const raw = fs.readFileSync(f, 'utf8')
    const re = /<image[^>]*class="([^"]+)"[^>]*>/g
    let m
    while ((m = re.exec(raw))) {
      /* class 可能是**组合类**（如 class="bigicon sm"）——
         真正生效的规则是 `.bigicon.sm`。
         ⚠️ 第一版按单词逐个查 `.sm`，结果匹配到了 app.wxss 里给文字用的
         `.sm { font-size }`，把一个根本没问题的图标误报成缺尺寸。
         所以要把整串 class 当成一个选择器来查。 */
      const sel = '.' + m[1].trim().split(/\s+/)
        .map(c => c.replace(/[-[\]{}()*+?.,\\^$|#\s]/g, '\\$&')).join('.')
      const rule = new RegExp(sel + '\\s*\\{([^}]*)\\}')
      const hit = rule.exec(css)
      /*
       * ⚠️ 这里必须用 `continue` 而不是 `return`。
       *    外面是 `while (re.exec(...))` 循环 —— `return` 会**退出整个文件**的扫描，
       *    后面所有的 <image> 都不再检查。
       *
       *    实测踩到过：index.wxml 里第一个 <image class="hero-glow">（无 CSS 定义）
       *    触发 return，后面 4 个真缺尺寸的图标全被跳过，断言报"通过"。
       *    —— 又一次「测试通过但测试根本没在工作」。
       *
       * ★ 「类没定义」不在这里报 —— 那一条由下面的 ③e-3 单独查。
       *   这里只管"定义了、但只写了 font-size"（对 <image> 无效）。
       */
      if (!hit) continue                       // 没定义 → 交给 ③e-3
      if (/width\s*:/.test(hit[1])) continue   // 有尺寸，OK
      if (/font-size\s*:/.test(hit[1])) {
        noSize.push(path.relative(ROOT, f) + ' → ' + sel +
          '（只有 font-size，对 <image> 无效 → 图标会撑满容器）')
      }
    }
  })
  assert.deepStrictEqual(noSize, [],
    '这些图标只定义了 font-size（对 <image> 完全无效，会撑满容器挤爆布局）：\n    ' +
    noSize.join('\n    '))
  ok('<image> 图标全部有显式尺寸')

  /*
   * ★★ ③e-3 `<image>` 的 class **必须有 CSS 定义**（哪怕只有尺寸）
   *
   * 2026-10-08 真实事故（用户截图报「首页最上面的卡片太大了」）：
   *   首页 hero 里的小气球写的是 `<image class="hn-ic">`，
   *   而 `.hn-ic` **在 wxss 里根本没有定义** ——
   *   `<image>` 不给 width/height 时会**按原始尺寸撑满容器**，
   *   气球被放大到几百 rpx，hero 从 ~380rpx 涨到 1000rpx+，
   *   占满整个首屏，下面的功能入口全被挤出屏幕。
   *
   * ★ 为什么原来查不到：上面那条断言里写着 `if (!hit) continue  // 类没定义，不管`
   *   —— 它只查"定义了但只写 font-size"，**"压根没定义"被主动跳过了**。
   *   而"没定义"恰恰是后果最严重的一种（撑满容器）。
   *   AGENTS.md 里记过同一个坑（游戏页喇叭撑满半屏），说明这类问题**会反复出现**。
   *
   * ⚠️ 两个必须处理的例外（否则会大量误报）：
   *   ① **动态 class**：`class="cs-cup {{cupCls}}"` 里的插值要剥掉；
   *   ② **占位类**：有些 class 只用来给 JS 选择器定位、或纯装饰，
   *      确实不需要样式 —— 用显式白名单放行，而不是放宽判据。
   */
  const CSS_OK_WITHOUT_RULE = new Set([
    /* 首页 hero 的装饰光晕：只是一个绝对定位的空 view，样式由内联/父级控制 */
    'hero-glow'
  ])
  wxmlFiles.forEach(f => {
    const wxss = f.replace(/\.wxml$/, '.wxss')
    let css = appCss2
    if (fs.existsSync(wxss)) css += fs.readFileSync(wxss, 'utf8')
    const raw = fs.readFileSync(f, 'utf8')
    const re = /<image[^>]*class="([^"]+)"[^>]*>/g
    let m
    while ((m = re.exec(raw))) {
      /*
       * ⚠️ 处理顺序踩了两次坑，最终必须是「**先整体剥插值，再按空格拆**」：
       *   ① 先拆后剥 → `{{hapticOn ? '' : 'off'}}` 被空格拆成 5 段乱码；
       *   ② 剥的时候用 `[^}]*` → 遇到嵌套/多表达式会提前收尾，留残余。
       *   所以：用非贪婪 `[\s\S]*?` 匹配到 `}}`，**先整串替换掉**，再拆分。
       */
      const noTpl = m[1].replace(/\{\{[\s\S]*?\}\}/g, ' ')
      for (const cls of noTpl.trim().split(/\s+/).filter(Boolean)) {
        if (CSS_OK_WITHOUT_RULE.has(cls)) continue
        /* 词边界查选择器：.hn-icX 不该被当成 .hn-ic 命中 */
        if (!new RegExp('\\.' + cls.replace(/[-]/g, '\\-') + '(?![\\w-])').test(css)) {
          undefinedCss.push(path.relative(ROOT, f) + ' → .' + cls)
        }
      }
    }
  })
  assert.deepStrictEqual(undefinedCss, [],
    '★ 这些 <image> 的 class 没有任何 CSS 定义 ——\n' +
    '    `<image>` 缺 width/height 时会**按原始尺寸撑满容器**（不报错，只是变得巨大）。\n' +
    '    实测踩过：首页 hero 的小气球没定义 → hero 被撑到占满整屏。\n    ' +
    undefinedCss.join('\n    '))
  ok('<image> 的 class 全部有 CSS 定义（不会撑满容器）')

  /*
   * ★★ ③e-4 图标不能**撑满它自己的容器**
   *
   * 2026-10-08 用户截图报「记一笔的那个笔也太大了」。
   * 根因和 hero 的气球**同源、方向相反**：
   *   · 气球是「class 没定义 → 撑满」
   *   · 笔是「class 有定义、也有尺寸，但**尺寸给满了整个圆**」——
   *     `.wc-pen` 是 86rpx 的金色圆底，而 <image> 也是 86rpx，
   *     图标直接顶到圆的边缘，显得又大又笨。
   *
   * 正确做法（参考 game 页的 .gc-icon）：**容器定尺寸，图标靠 padding 内缩**。
   *
   * ★ 判据：一个 class 如果**同时**是
   *     ① 有 `background` 或 `border-radius: 50%`（说明它是"底"）
   *     ② 被 `<image>` 直接使用
   *   那它就应该有 padding（或给内部留出内缩），否则图标会顶满。
   *
   * ⚠️ 例外：**照片容器**（`mode="aspectFill"` 的图）本来就该撑满，
   *    它们同样"有背景 + 被 image 用"。所以按 `mode` 区分：
   *    aspectFill = 照片，跳过；aspectFit = 图标，要求内缩。
   *    （首页 .mc-photo、编年史 .photo、wishes .shot、capsule .pimg 都是这类）
   */
  /*
   * ⚠️ 两个必须处理的误报（否则这条断言会天天喊狼来了）：
   *
   *   ① **组合类**：`class="mk on"` 里的 `.on` 单独查会命中 `.mk.on` 之外的规则，
   *      或者查不到正确规则。→ 用**整串 class 拼成选择器**来查（和 ③e 一样）。
   *   ② **底色来自父级**：write 页的 `.me`（心情图标）自己没背景，
   *      但它在 `.mood.on` 选中态里会被父级给底色 —— 那不是它的容器。
   *      → 只认"这个类**自己**有 background/border-radius:50%"。
   *
   * 另外：`mode="aspectFill"` 的图一律跳过 —— 那是照片容器，本来就该撑满。
   */
  const filledIcon = []
  wxmlFiles.forEach(f => {
    const wxss = f.replace(/\.wxml$/, '.wxss')
    let css = appCss2
    if (fs.existsSync(wxss)) css += fs.readFileSync(wxss, 'utf8')
    const raw = fs.readFileSync(f, 'utf8').replace(/<!--[\s\S]*?-->/g, '')
    /* 只取 aspectFit 的 <image>（图标），排除照片容器 */
    const re = /<image(?![^>]*mode="aspectFill")[^>]*class="([^"]+)"[^>]*>/g
    let m
    while ((m = re.exec(raw))) {
      const noTpl = m[1].replace(/\{\{[\s\S]*?\}\}/g, ' ')
      const classes = noTpl.trim().split(/\s+/).filter(Boolean)
      for (const cls of classes) {
        /*
         * 只认**这个类独占选择器**的规则 —— 组合类（`.mk.on`、`.side.me`、
         * `.btn.on`）不算它自己的定义，否则会把"父级给的底色"误判成
         * "这个图标自己的容器"，天天误报。
         *
         * ⚠️ 前后都要挡：
         *   前面 `(^|[^.\w-])` —— 挡 `.mk.on` 里的 `on`（前面是点）
         *   后面 `(?!\.)(?![\w-])` —— 挡 `.on.xxx` 这种（后面是点）
         *   实测：只挡后面会漏掉 `.mk.on`（我就是这么误报了两条）。
         */
        const esc = cls.replace(/[-]/g, '\\-')
        const ruleRe = new RegExp(
          '(?:^|[^.\\w-])\\.' + esc + '(?!\\.)(?![\\w-])\\s*\\{([^}]*)\\}')
        const rule = ruleRe.exec(css)
        if (!rule) continue
        const body = rule[1]
        const isBase = /background\s*:/.test(body) || /border-radius\s*:\s*50%/.test(body)
        if (!isBase) continue
        if (!/padding\s*:/.test(body)) {
          filledIcon.push(path.relative(ROOT, f) + ' → .' + cls)
        }
      }
    }
  })
  assert.deepStrictEqual(filledIcon, [],
    '★ 这些图标直接撑满了自己的容器（有底色/圆底、但没给图标留内缩）：\n    ' +
    filledIcon.join('\n    ') +
    '\n    图标会顶到容器边缘，显得又大又笨（实测：首页「记一笔」的笔）。\n' +
    '    修法：容器定尺寸 + `box-sizing: border-box` + `padding` 内缩\n' +
    '    （参考 game 页 .gc-icon 的 padding: 18rpx）。')
  ok('带底色的图标都留了内缩（不会顶满容器）')

  /* ③ 图标库本身要健康：每个条目都能生成合法的 data URI */
  const iconsJs = fs.readFileSync(path.join(ROOT, 'miniprogram/utils/icons.js'), 'utf8')
  const iconNames = [...iconsJs.matchAll(/^\s{2}([a-zA-Z][\w]*):\s*'/gm)].map(m => m[1])
  assert.ok(iconNames.length >= 30,
    `图标库只有 ${iconNames.length} 个，覆盖的种类太少`)
  /* 模板里用到的图标键必须在库里存在 —— 拼错的话 icon 返回空串、界面直接少个图标 */
  const usedKeys = new Set()
  wxmlFiles.forEach(f => {
    const raw = fs.readFileSync(f, 'utf8')
    for (const m of raw.matchAll(/ic\[['"]?([a-zA-Z][\w]*)['"]?\]/g)) usedKeys.add(m[1])
    for (const m of raw.matchAll(/\bic\.([a-zA-Z][\w]*)/g)) usedKeys.add(m[1])
  })
  const missingIcon = [...usedKeys].filter(k => !iconNames.includes(k))
  assert.deepStrictEqual(missingIcon, [],
    '模板引用了图标库里没有的键（会渲染成空白）：\n    ' + missingIcon.join('\n    '))
  ok(`图标库 ${iconNames.length} 个，模板用到的 ${usedKeys.size} 个全部存在`)

  /* ============ ③e-2 ★ 图标 key 不能被当成文字渲染 ============
   *
   * 2026-10-08 真实事故（用户截图报障「改错了」）：
   *   emoji→SVG 改造时，room 页把 GAMES 里的 icon 从 '🎯' 改成 'target'，
   *   但 wxml 里还是 `{{item.icon}}` —— 它打印的是**字符串本身**，
   *   于是页面上直接显示「target 大话骰 / dice 摇骰子比大小」英文乱码。
   *   同一个改造里 write 页的心情也是同一处漏改（e: '😊' → key 后没改渲染）。
   *
   * ★ 为什么原来的断言抓不到：
   *   上面那条「模板里已无 emoji」**只扫 wxml 文件**，
   *   而 `icon: 'target'` 这个值写在 **js 里** ——
   *   它查的是"还有没有 emoji 残留"，管不到"图标 key 被当文字渲染"。
   *   这类漏检的共同特征是：**值在 js、渲染在 wxml，断言只看了一边**。
   *
   * 检查两条，缺一不可：
   *   ① js 里作为图标用的字面量，必须在该页 _IC 注册表里 —— 否则是空白；
   *   ② wxml 里不能直接渲染这些图标字段 —— 否则会打印英文 key。
   */
  const iconFieldPages = []
  ;(function walkJ(d) {
    fs.readdirSync(d).forEach(f => {
      const p = path.join(d, f)
      if (fs.statSync(p).isDirectory()) walkJ(p)
      else if (f.endsWith('.js')) iconFieldPages.push(p)
    })
  })(path.join(ROOT, 'miniprogram', 'pages'))

  const iconUnregistered = []   // ① 数据里有 key 但没注册
  const printedRaw = []     // ② wxml 直接渲染了图标字段

  iconFieldPages.forEach(js => {
    const src = fs.readFileSync(js, 'utf8')
    const wxml = js.replace(/\.js$/, '.wxml')
    if (!fs.existsSync(wxml)) return

    /* 页面注册表：for (const _k of ['a','b']) { _IC[_k] = ... } */
    const reg = new Set()
    for (const m of src.matchAll(/for \(const _k of \[([^\]]*)\]\)/g)) {
      for (const k of m[1].matchAll(/'([^']+)'/g)) reg.add(k[1])
    }
    /* 页面数据里"当作图标用"的字段：icon: 'xxx' / e: 'xxx' */
    const used = new Set()
    for (const m of src.matchAll(/\b(?:icon|e)\s*:\s*'([a-zA-Z][\w]*)'/g)) used.add(m[1])

    /* ① 用到但没注册 —— 只报"确实是图标库里的名字"的，
       避免把 `e: 'none'`（wx.showToast 的 icon 参数）这类误报。 */
    for (const k of used) {
      if (iconNames.includes(k) && !reg.has(k)) {
        iconUnregistered.push(path.relative(ROOT, js) + ' → ' + k)
      }
    }

    /* ② wxml 里 {{item.xxx}} / {{xxx}} 直接渲染图标字段 —— 必须是 ic[...] 包裹 */
    const tpl = fs.readFileSync(wxml, 'utf8').replace(/<!--[\s\S]*?-->/g, '')
    tpl.split('\n').forEach((line, i) => {
      /* 先剥掉合法的 ic[...] 用法，再看剩下的裸渲染 */
      const stripped = line.replace(/ic\[[^\]]*\]/g, '')
      for (const m of stripped.matchAll(/\{\{\s*(?:item\.)?(icon|e)\s*\}\}/g)) {
        printedRaw.push(path.relative(ROOT, wxml) + ':' + (i + 1) + ' → {{' + m[1] + '}}')
      }
    })
  })

  assert.deepStrictEqual(iconUnregistered, [],
    '这些图标 key 被数据引用，但页面没注册进 _IC（会渲染成空白）：\n    ' +
    iconUnregistered.join('\n    '))
  ok('数据里用到的图标 key 全部已注册（不会静默空白）')

  assert.deepStrictEqual(printedRaw, [],
    'wxml 直接渲染了图标字段（会把 key 当文字打印，页面显示英文乱码）：\n    ' +
    printedRaw.join('\n    ') + '\n    改用 <image src="{{ic[item.xxx]}}" />')
  ok('wxml 没有裸渲染图标字段（不会打印英文 key）')

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

  /* ============================================================
     * ⑦ 全仓扫描：缩略图 / 存活守卫 / 无限循环
     * ============================================================
     *
     * 这一组是 2026-10-09 全面审计的产物。三条断言都是**全仓扫描**，
     * 不是逐个页面点名 —— 因为上一轮修同类 bug 时只改了被点名的页面，
     * 漏掉的详情页半年后才被发现（见 ⑦-1 的说明）。
     */
  const glob = (dir, ext) => {
    const out = []
    const walk = (d) => {
      for (const f of fs.readdirSync(d, { withFileTypes: true })) {
        const fp = path.join(d, f.name)
        if (f.isDirectory()) walk(fp)
        else if (f.name.endsWith(ext)) out.push(fp)
      }
    }
    walk(dir)
    return out
  }
  const MINI = path.join(ROOT, 'miniprogram')
  const allWxml = glob(MINI, '.wxml')
  const allPages = glob(path.join(MINI, 'pages'), '.js')

  /* ---------- ⑦-1 图片列表必须缩略图优先 ---------- */
  console.log('\n=== ⑦-1 渲染 photos 的 <image> 必须有 thumbs 回退 ===')
  /*
   * ★ 为什么这条必须全仓扫描：
   *   AGENTS.md 记过一次「列表加载慢、流量大」——home / chronicle 漏返回 thumbs，
   *   前端回退加载原图（3~5MB/张）。当时只修了**被点名的两个页面**，
   *   而 day 详情页和 capsule 读信弹层是**同一个根因**，一直漏着：
   *     · day 页：一天最多 50 条 × 3 张 = 最多 150 张原图同时下载
   *     · capsule 弹层：读信那一刻要等 3~5MB
   *   逐页点名的做法必然会漏，所以这里改成扫全仓。
   *
   * 判据：任何 `<image>` 只要 src 里出现 `photos`，就必须同时出现 `thumbs`
   *      （形如 `xxx.thumbs[i] || xxx` 的兜底写法）。
   */
  /*
   * ⚠️ 判据要**只看 src**，不能"标签里出现 photos 字样就报"。
   *    第一版写成了后者，结果误报了 capsule.wxml:53 ——
   *    那一处 `<image src="{{item}}">` 里的 item 来自 `wx:for="{{thumbs}}"`
   *    （渲染的就是缩略图），`data-src="{{photos[index]}}"` 只是点击预览时才用的原图。
   *    **那是完全正确的写法。**
   *
   *    假阳性比漏报更糟：它会让我去改本来正确的代码。
   *    所以判据收紧为：src 的表达式里**直接**引用原图数组（photos / .photo），
   *    且同一标签内没有 thumbs 兜底。
   */
  /*
   * ★★ 判据的难点：**修复后的正确写法里根本不含 `photos` 字段名** ——
   *    它写成了 `{{it.thumbs[pi] || ph}}`，ph 是 wx:for 的临时变量。
   *    所以"看 src 里有没有 photos"这个思路是废的：
   *    改坏成 `src="{{ph}}"` 之后，src 里同样没有 photos 字样，
   *    断言**照样通过**（反向验证时发现的 —— 这条断言第一版就是废的）。
   *
   * 正确判据：**从 wx:for 的源数组倒推**。
   *   `<image>` 若是遍历原图数组（photos / reading.photos / …）渲染的，
   *   它的 src 就必须带缩略图兜底。
   *
   * 做法：先找出模板里所有"遍历原图数组"的 wx:for，
   *      再看**同一个 <image> 标签内**有没有 thumbs 兜底。
   *      这样无论变量叫什么名字都能抓到。
   */
  const badImg = []
  for (const f of allWxml) {
    const src = fs.readFileSync(f, 'utf8')
    for (const m of src.matchAll(/<image\b[^>]*>/g)) {
      const tag = m[0]
      const srcM = /src="([^"]*)"/.exec(tag)
      if (!srcM) continue
      const expr = srcM[1]
      /* 缩略图兜底：表达式里出现 thumb（含 thumbs / photoThumb / thumbUrl）即放行 */
      if (/thumb/i.test(expr)) continue
      /*
       * 没有 thumbs 字样的，要判断"这个 src 是不是原图"。
       */
      /*
       * ★★ 判据的核心：**只看这个 <image> 自己遍历的是什么**。
       *
       * 原来的写法是"src 里出现 photos 字样才检查" —— 那是废的：
       * 修复后的正确写法 `src="{{it.thumbs[pi] || ph}}"` 里**不含 photos**，
       * 而改坏成 `src="{{ph}}"` 之后同样不含 photos，
       * 于是改坏了也检测不到（反向验证时发现，第一版断言完全无效）。
       *
       * 现在改成从 **wx:for 的源数组**倒推，与变量名无关：
       *   · 遍历的是原图数组（photos / photo）→ 必须有缩略图兜底
       *   · 缩略图兜底可以写在两个地方，任一即可：
       *       ① src 表达式里      `src="{{it.thumbs[pi] || ph}}"`
       *       ② wx:for 表达式里   `wx:for="{{it.thumbs.length ? it.thumbs : it.photos}}"`
       *
       * ⚠️ 曾经试图加"文件里别处有 thumbs 遍历就放行"的例外，来兼容
       *    `src="{{item}}"` 遍历 thumbs 的正确写法 —— 结果那个例外
       *    把**改坏后的** `src="{{item}}"`（遍历 photos）也放行了，
       *    反向验证报不出错。**例外条件不能跨标签传播**，已彻底去掉；
       *    那种正确写法由"遍历的是 thumbs"这一步自然放行（不含原图字段名）。
       */
      const ORIG = /photos?|photo/i
      if (!ORIG.test(expr)) {
        /* src 没写原图字段名 —— 再看它遍历的是什么 */
        const f2 = /wx:for="\{\{([^}]*)\}\}"/.exec(tag)
        if (!(f2 && ORIG.test(f2[1]))) continue
        /* 遍历的确实是原图，但兜底写在了 wx:for 里 → 放行 */
        if (/thumb/i.test(f2[1])) continue
      } else {
        /* src 直接引用原图 → 必须自带缩略图兜底 */
        if (/thumb/i.test(expr)) continue
      }
      const line = src.slice(0, m.index).split('\n').length
      badImg.push(`${path.relative(ROOT, f)}:${line}  ${tag.replace(/\s+/g, ' ').slice(0, 96)}`)
    }
  }
  assert.deepStrictEqual(badImg, [],
    '★ 这些 <image> 直接绑 photos（原图）却没有 thumbs 回退：\n    ' +
    badImg.join('\n    ') +
    '\n    原图 3~5MB/张，列表会同时发起大量下载 → 白屏久、流量大。\n' +
    '    写法：src="{{item.thumbs[i] || item.photos[i]}}"，点击预览才用原图')
  ok('全部渲染 photos 的 <image> 都做了缩略图回退')

  /* ---------- ⑦-2 异步回调必须有存活守卫 ---------- */
  console.log('\n=== ⑦-2 页面 onUnload 后不能 setData（必须声明存活标志）===')
  /*
   * ★ 为什么：页面里有大量 `await call(...)`，而**每个 await 之后都可能已经
   *   不在这个页面上了**（用户点返回、退出房间）。再 setData 会：
   *     · 控制台报 `setData: Page has been unloaded`
   *     · 闭包短时把整个页面对象（含全量数据）吊住
   *
   *   ⚠️ 不能拿 `this.data.xxx` 当存活判据 —— 卸载后它仍是旧值，永远是"还活着"。
   *      必须是一个在 onUnload 里显式翻转的标志。
   *
   * 判据：onUnload 里设了存活标志（`this._dead = true` 或 `this._alive = false`），
   *      且该文件里确实有 `await` + `setData` 的组合。
   */
  /*
   * ⚠️ 判据要**分级**，不能一刀切。
   *
   * 第一版写的是"凡有 await+setData 就必须有 _dead"，结果报出 8 个页面。
   * 逐个看下来，其中大部分**不值得改**：
   *   · index / chronicle / wishes / mood 是 **tabBar 页面** ——
   *     切 tab 只触发 onHide，**永远不会 unload**，不存在"打到已卸载页面"
   *   · write / pair / settings / day 等是表单页，await 只有一次
   *     （进页面加载或点保存），几百毫秒内离开的概率极低，
   *     而且 setData 之后闭包就结束了，没有累积效应
   *
   * 真正有**持续性**风险的是**带定时器**的页面：
   * 轮询/走秒每秒都在跑，云函数往返期间卸载就会反复打到死页面，
   * 这才是必须挡的（room 的 1.5 秒轮询、mood 的 1 秒走秒）。
   *
   * 所以判据收敛为：**有 setInterval 的页面必须声明存活标志**。
   * 宁可精确也不要宽 —— 假阳性会让我去改本来正确的代码。
   */
  const noGuard = []
  for (const f of allPages) {
    const src = fs.readFileSync(f, 'utf8')
    /* 只挑有持续定时器的页面 */
    if (!/setInterval\s*\(/.test(src)) continue
    if (!/await\s/.test(src)) continue
    const declares = /this\._(dead|visible)\s*=\s*(true|false)/.test(src) &&
                     /on(Unload|Hide)\s*\([^)]*\)\s*\{[\s\S]{0,300}?this\._(dead|visible)\s*=/.test(src)
    if (!declares) noGuard.push(path.relative(ROOT, f))
  }
  assert.deepStrictEqual(noGuard, [],
    '★ 这些页面有 setInterval（持续轮询/走秒）但没有存活标志：\n    ' +
    noGuard.join('\n    ') +
    '\n    定时器每秒都在跑，云函数往返期间页面被卸载就会反复 setData 到死页面。\n' +
    '    修法：onUnload/onHide 里翻转 this._dead / this._visible，异步回调处判断')
  ok('所有带定时器的页面都声明了存活/可见标志（room 的 _dead、mood 的 _visible）')

  /* ---------- ⑦-3 定时器自重启不能形成无限循环 ---------- */
  console.log('\n=== ⑦-3 走秒/轮询：重置标志不能被自己的回调清掉 ===')
  /*
   * ★★ 这是本轮最严重的一个（mood 页**整个不可用**）：
   *
   *     tick():  left<=0 且 !_pulled  →  _pulled=true; load()
   *     load():  _pulled = false;  若 cool 非空 → startTick()   ← 又起表
   *              ↑____________________________________|
   *
   *   实测（用真实源码跑闭环）：旧版 6 帧内 load **6 次**（每秒一次，
   *   每次 2 个云函数调用），而且 load() 首行的 setData({loading:true})
   *   让整页每秒闪一次 —— 页面直接没法用。修复后同样 6 帧只 load 1 次。
   *
   * 判据：如果某函数体里出现"把 _pulled/_done 这类**一次性标志重置**"，
   *      就必须同时存在让它只在**新条件**下才重置的判断（形如 `if (x > 0)`），
   *      不能是无条件赋值。
   */
  const moodSrc = fs.readFileSync(path.join(MINI, 'pages/mood/mood.js'), 'utf8')
  const unconditional = /^\s*this\._pulled\s*=\s*false\s*$/m.test(moodSrc)
  assert.ok(!unconditional,
    '★ mood.js 里 `this._pulled = false` 是无条件赋值 —— ' +
    '它会被 load() 每次执行时清掉，而 load() 结尾又 startTick() 起表，\n' +
    '    于是 tick→load→startTick→tick 形成闭环：**每秒一次云函数调用 + 整页闪烁**。\n' +
    '    必须改成"只有服务端给出新的未来截止时刻（remainMs > 0）才重置"。')
  assert.ok(/if\s*\(remain\s*>\s*0\)\s*this\._pulled\s*=\s*false/.test(moodSrc),
    '★ 找不到"仅在新周期才重置 _pulled"的判断 —— 循环防护可能被删掉了')
  /* 归零时必须停表，不能只靠标志 */
  assert.ok(/if\s*\(up\)\s*\{[\s\S]{0,200}?this\.stopTick\(\)/.test(moodSrc),
    '★ mood 的 tick() 在归零时没有 stopTick() —— ' +
    '表会一直跑，靠标志挡不住"每次都重新起表"')
  ok('mood 走秒：归零后停表 + _pulled 仅在新周期重置（无每秒循环）')

  /* ---------- ⑦-4 离线兜底：取不到 ≠ 没有 ---------- */
  console.log('\n=== ⑦-4 ensurePair 断网时必须返回旧值，不能返回 null ===')
  /*
   * ★ 真实缺陷（2026-10-09）：`ensurePair` 的 catch 里 `return null`，
   *   而 9 个页面都拿 `if (!pair)` 判断"还没配对" ——
   *   **已配对的老用户在地铁里打开小程序，看到的是配对引导页**，以为数据丢了。
   *
   * 「取不到」和「没有」是两件完全不同的事，不能都表达成 null。
   *
   * 判据三条（缺一不可）：
   *   ① catch 里不能直接 return null（要有旧值兜底）
   *   ② 联网成功且 r.ok 时**同步快照**（含 pair 为 null 时清空快照）——
   *      否则"已解绑"的旧状态会在断网时复活
   *   ③ 兜底读快照时**不要更新 _pairAt** —— 否则旧数据会被当成"刚拉过"，
   *      联网后 60 秒内不再刷新
   */
  const appSrc = fs.readFileSync(path.join(MINI, 'app.js'), 'utf8')
  const epBody = /ensurePair\(force\)\s*\{([\s\S]*?)\n  \}/.exec(appSrc)
  assert.ok(epBody, '★ app.js 里抽不出 ensurePair 函数体')
  const ep = epBody[1]

  assert.ok(!/catch\s*\([^)]*\)\s*\{\s*[\s\S]{0,400}?return null\s*\}\s*$/.test(ep.trim()),
    '★ ensurePair 的 catch 直接 return null —— 断网时已配对用户会看到配对引导页。\n' +
    '    「取不到」和「没有」必须区分：优先返回内存里的 g.pair，其次读本地快照。')
  assert.ok(/if\s*\(g\.pair\)\s*return g\.pair/.test(ep),
    '★ 找不到"有内存旧值就先用旧值"的兜底')
  assert.ok(/getStorageSync\(\s*'pairCache'\s*\)/.test(ep),
    '★ 找不到本地快照兜底（冷启动就断网时会退回 null）')
  assert.ok(/if\s*\(r\.ok\)\s*wx\.setStorageSync\(\s*'pairCache'/.test(ep),
    '★ 快照没有在 r.ok 时同步 —— 若写成 `if (g.pair)`，' +
    '服务端明确回答"没配对"时旧快照会残留，断网时又复活成"还配着对"')
  ok('ensurePair 区分「取不到」与「没有」，且快照不会让旧状态复活')

  console.log(`\n${'='.repeat(56)}\n  字段契约：全部 ${n} 项断言通过\n${'='.repeat(56)}\n`)
})().catch(e => {
  console.error('\n  ✗ 失败：', e.message, '\n')
  process.exit(1)
})
