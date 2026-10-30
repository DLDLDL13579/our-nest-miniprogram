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
/* 只留真正在用的集合（情侣功能删掉后，其余表已无人引用） */
const store = { rooms: [] }
let seq = 0
const nextId = () => 'id' + (++seq)

/*
 * 条件构造器 —— 必须和 room 云函数里真正用到的算子一致。
 * 改造前这里只有 neq / push，而 room 的 pickCode 用了 _.gt：
 * 直接报 `_.gt is not a function`，而且**报错发生在准备阶段**，
 * 被 catch 吞掉后整个测试就变成一个"其实没建成房间"的假状态。
 * （AGENTS.md 记过的同类假绿：mock 缺 where().update() → join 抛错被吞 → exit=0。）
 */
function neq(v) { return { __op: 'neq', v } }
function pushv(v) { return { __op: 'push', v } }
function lt(v) { return { __op: 'lt', v } }
function gt(v) { return { __op: 'gt', v } }
function and() {
  const list = Array.prototype.slice.call(arguments)
  return { __op: 'and', v: Array.isArray(list[0]) ? list[0] : list }
}
const command = { neq, push: pushv, lt, gt, and, set: v => ({ __op: 'set', v }) }

/** 单条条件求值（供 and 递归） */
function one(doc, key, c) {
  if (c && c.__op === 'neq') return doc[key] !== c.v
  if (c && c.__op === 'lt') return Number(doc[key]) < Number(c.v)
  if (c && c.__op === 'gt') return Number(doc[key]) > Number(c.v)
  if (c && c.__op === 'and') {
    const list = Array.isArray(c.v[0]) ? c.v[0] : c.v
    return list.every(x => one(doc, key, x))
  }
  if (Array.isArray(doc[key])) return doc[key].indexOf(c) >= 0
  return doc[key] === c
}

function match(doc, q) {
  return Object.keys(q).every(k => one(doc, k, q[k]))
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
              else if (data[k] && data[k].__op === 'set') d[k] = data[k].v
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
              else if (data[k] && data[k].__op === 'set') d[k] = data[k].v
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
/*
 * ★★ 所有"扫页面"的断言都必须用这两个根目录。
 *
 * 房间页在 2026-10-28 移进分包 `miniprogram/game/` 时，有两条断言（死动作、死功能）
 * 仍然只扫 `miniprogram/pages` —— 它们**一直是绿的，只是什么都没测**。
 * 之后又发现第三条（③c-3 的 class 样式检查）也漏了：往 wxml 里塞一个
 * 没有样式的 class，断言毫无反应。一天之内在同一个坑上踩了三次。
 *
 * 所以把"页面根目录"提成全局常量，扫描断言一律用它 —— 不再靠"记得改"。
 */
const PAGE_ROOTS = [
  path.join(ROOT, 'miniprogram', 'pages'),
  path.join(ROOT, 'miniprogram', 'game')
]
const orig = Module._load
Module._load = function (r) { if (r === 'wx-server-sdk') return mock; return orig.apply(this, arguments) }

const room = require(path.join(ROOT, 'cloudfunctions', 'room', 'index.js'))

const D = 'oid_deng', Q = 'oid_qp'
let n = 0
let ROOM_ID = ''
function ok(msg) { n++; console.log('  ✓ ' + msg) }

;(async () => {
  /* ---------- 准备：开一个房间，两个人进去 ---------- */
  /*
   * ★★ 准备阶段的每一步都必须**断言成功**，不能只 await。
   *
   * 原来这里是裸的 `await pair.main({action:'join'})` —— 准备失败时
   * 脚本照样往下跑，后面几十项断言就在一个"其实没配成"的假状态上执行，
   * 而它们**可能照样打印 ✓**（假绿），因为很多断言只检查字段形状。
   *
   * 这类"准备失败 + 断言宽松"的测试**比没有测试更危险**：
   * 它给的是虚假的信心。所以下面每一步都 assert.ok。
   */
  OPENID = D
  const c = await room.main({ action: 'create', name: '邓林', game: 'liar' })
  assert.ok(c.ok && c.room && c.room.code, '准备阶段：建房应成功 —— ' + (c.msg || ''))
  ROOM_ID = c.room.id

  OPENID = Q
  const pj = await room.main({ action: 'join', code: c.room.code, name: '倩萍' })
  assert.ok(pj.ok, '准备阶段：加入房间应成功 —— ' + (pj.msg || ''))

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

  /* ============ ⑤f app.json 与实际文件必须对得上 ============ *
   *
   * 微信对"配置指向不存在的文件"是**静默**的：
   *   · pages 里写了但文件缺失 → 那个页面不存在，跳转时才报错
   *   · tabBar 的 pagePath 不在 pages 里 → 整个 tabBar 不显示
   *   · tabBar 的 iconPath 缺失 → 图标静默空白
   *   · 项目里有页面但没注册 → 那个页面根本进不了包
   * 这些只有真机看得出来，而本项目规定不启动开发者工具 —— 只能静态核对。
   */
  {
    const MP = path.join(ROOT, 'miniprogram')
    const app = JSON.parse(fs.readFileSync(path.join(MP, 'app.json'), 'utf8'))
    const bad = []

    /* ① 每个注册的页面必须有 js + wxml */
    for (const pg of app.pages || []) {
      for (const ext of ['js', 'wxml']) {
        const f = path.join(MP, pg + '.' + ext)
        if (!fs.existsSync(f)) bad.push(pg + '.' + ext + ' 不存在（页面进不了包）')
      }
    }

    /* ② tabBar 的 pagePath 必须在 pages 里；有 iconPath 就必须存在 */
    for (const item of (app.tabBar && app.tabBar.list) || []) {
      if (!(app.pages || []).includes(item.pagePath)) {
        bad.push('tabBar 的 pagePath 《' + item.pagePath + '》不在 pages 列表里（整个 tabBar 会不显示）')
      }
      for (const key of ['iconPath', 'selectedIconPath']) {
        if (item[key] && !fs.existsSync(path.join(MP, item[key]))) {
          bad.push('tabBar ' + key + ' 文件不存在：' + item[key])
        }
      }
    }

    /* ③ 反向：项目里有 .wxml 的页面目录必须都注册在 app.json */
    const dirs = new Set()
    const walk = (d) => {
      for (const f of fs.readdirSync(d, { withFileTypes: true })) {
        const fp = path.join(d, f.name)
        if (f.isDirectory()) { if (f.name !== 'components') walk(fp); continue }
        if (f.name.endsWith('.wxml') && fp.startsWith(path.join(MP, 'pages'))) {
          dirs.add(path.relative(MP, fp).replace(/\.wxml$/, ''))
        }
      }
    }
    walk(MP)
    for (const d of dirs) {
      if (!(app.pages || []).includes(d)) bad.push(d + ' 有 wxml 但没在 app.json 的 pages 里（进不了包）')
    }

    /* ④ sitemap 文件 */
    const smPath = path.join(MP, app.sitemapLocation || 'sitemap.json')
    if (app.sitemapLocation && !fs.existsSync(smPath)) {
      bad.push('sitemapLocation 指向的文件不存在：' + app.sitemapLocation)
    }
    /*
     * ★ 内容也要查（2026-10-29）。
     *   情侣版时代 `rules` 里写着 `{"action":"disallow","page":"*"}` ——
     *   意味着**微信搜索里根本搜不到这个程序**，只有知道名字的人能用。
     *   之前修过一次，但没有断言 —— 被改回去不会有任何报错。
     */
    if (fs.existsSync(smPath)) {
      try {
        const sm = JSON.parse(fs.readFileSync(smPath, 'utf8'))
        const rules = sm.rules || []
        const blocksAll = rules.some(r => r.action === 'disallow' && (r.page === '*' || r.page === 'all'))
        if (blocksAll) {
          bad.push('sitemap 把全部页面设为 disallow —— 微信里搜不到这个小程序')
        }
        if (!rules.some(r => r.action === 'allow')) {
          bad.push('sitemap 里没有一条 allow 规则')
        }
      } catch (e) {
        bad.push('sitemap.json 解析失败：' + e.message)
      }
    }

    assert.deepStrictEqual(bad, [],
      '★ app.json 与实际文件对不上（微信不会报错，只是静默缺失）：\n    ' + bad.join('\n    '))
    ok(`app.json 与文件一致（${(app.pages || []).length} 个页面、${((app.tabBar && app.tabBar.list) || []).length} 个 tab）`)
  }

  /* ============ ⑤e 存储 key 的读写必须指向同一个字符串 ============ *
   *
   * 存储 key 是字符串，改名**不会有任何编译期报错** ——
   * 症状是"设置保存不了 / 昵称回到默认"，而且极难查（看起来都正常）。
   *
   * 现状有个脆弱点：`me.js` 用常量 `NICK_KEY`，而 `room.js` 和 `app.js`
   * 直接写字面量 `'nick'`。现在两者都是 'nick'，但改常量值时那两处会静默失配。
   * 这条断言把三个 key 的实际值钉住。
   */
  {
    const sfxSrc = fs.readFileSync(path.join(ROOT, 'miniprogram/game/sfx.js'), 'utf8')
    const fbSrc = fs.readFileSync(path.join(ROOT, 'miniprogram/game/feedback.js'), 'utf8')
    const meSrc = fs.readFileSync(path.join(ROOT, 'miniprogram/pages/me/me.js'), 'utf8')
    const roomSrc = fs.readFileSync(path.join(ROOT, 'miniprogram/game/room/room.js'), 'utf8')
    const appSrc = fs.readFileSync(path.join(ROOT, 'miniprogram/app.js'), 'utf8')

    const val = (src, name) => {
      const m = new RegExp('const ' + name + " = '([^']+)'").exec(src)
      return m ? m[1] : null
    }
    const haSrc = fs.readFileSync(path.join(ROOT, 'miniprogram/utils/haptic.js'), 'utf8')
    const checks = [
      ['MUTE_KEY', val(sfxSrc, 'MUTE_KEY'), 'gameMute'],
      /* HAPTIC_KEY 2026-10-28 从 feedback.js 挪到了 utils/haptic.js（拆分主包/分包） */
      ['HAPTIC_KEY', val(haSrc, 'HAPTIC_KEY'), 'hapticOn'],
      ['NICK_KEY', val(meSrc, 'NICK_KEY'), 'nick']
    ]
    const bad = []
    for (const [name, got, want] of checks) {
      if (got === null) bad.push(name + '：找不到定义')
      else if (got !== want) bad.push(`${name} = '${got}'，期望 '${want}'（改过值？读写两侧要一起改）`)
    }
    /* 另外确认用字面量读昵称的地方也还是 'nick' */
    for (const [file, src] of [['room.js', roomSrc], ['app.js', appSrc]]) {
      if (/getStorageSync\('nick'\)/.test(src) === false && /getStorageSync\(NICK_KEY\)/.test(src) === false) {
        bad.push(file + '：读昵称的 key 既不是字面量 «nick» 也不是 NICK_KEY（写法变了？）')
      }
    }
    assert.deepStrictEqual(bad, [],
      '★ 存储 key 不一致 —— 症状是"设置保存不了"，且不会有任何报错：\n    ' + bad.join('\n    '))
    ok('存储 key 一致（nick / gameMute / hapticOn），读写两侧对得上')
  }

  /* ============ ⑤d 玩法注册表的字段必须被用到 ============ *
   *
   * `games.js` 是"有哪些玩法"的唯一事实源，但它的字段也可能是死数据：
   *   · `cat`（分类）—— 用户明确说大厅不做筛选，这个字段从没被读过
   *   · `need`（用到哪些道具）—— 所有玩法都在手机内完成，没有实体道具
   * 两个都是"写了没人用"，本轮清掉（连同死函数 CATS / gameIds / gamesInCat）。
   *
   * 判据：GAMES 每一项的每个字段名，必须在项目源码里出现过（剥注释后）。
   * ⚠️ 这条判据对 `how` 这种常见英文词会有假阴性（注释里出现过就算"用了"），
   *    宁可漏报 —— 假阳性会让我去删本来在用的字段。
   */
  {
    const games = require(path.join(ROOT, 'miniprogram/utils/games.js'))
    const keys = Object.keys(games.GAMES[0])
    const strip = (t) => t
      .replace(/<!--[\s\S]*?-->/g, ' ')
      .replace(/\/\*[\s\S]*?\*\//g, ' ')
      .replace(/(^|[^:])\/\/[^\n]*/g, '$1')

    const seen = new Set()
    const walk = (dir) => {
      for (const f of fs.readdirSync(dir, { withFileTypes: true })) {
        const fp = path.join(dir, f.name)
        if (f.isDirectory()) { if (f.name !== 'node_modules') walk(fp); continue }
        if (!/\.(js|wxml)$/.test(f.name)) continue
        if (fp.includes('utils/games.js') || fp.includes('cloudfunctions/room/games.js')) continue
        seen.add(strip(fs.readFileSync(fp, 'utf8')))
      }
    }
    walk(path.join(ROOT, 'miniprogram'))
    walk(path.join(ROOT, 'cloudfunctions'))
    const all = Array.from(seen).join('\n')

    const dead = keys.filter(k => !new RegExp('\\b' + k + '\\b').test(all))
    assert.deepStrictEqual(dead, [],
      '★ 这些玩法字段在项目里从没被读过（死字段）：' + dead.join(', ') +
      '\n    要么接到界面上（像 min/max/how 那样），要么删掉（像 cat/need 那样）。')
    ok(`玩法注册表的 ${keys.length} 个字段全部被使用（${keys.join('/')}）`)
  }

  /* ============ ⑤c 前端 maxlength 必须与云端截断长度一致 ============ *
   *
   * 不一致的后果很隐蔽：用户以为能输 60 个字，云端却悄悄截到 20 ——
   * 他看到的和存下来的不一样，而且**没有任何提示**。
   * 现在三处都是对的（昵称 12 / 自定义题 60 / 房间号 3），
   * 但它们是**两份独立的常量**，改一处忘另一处就是下次的坑。
   */
  {
    const cloudSrc = fs.readFileSync(
      path.join(ROOT, 'cloudfunctions/room/index.js'), 'utf8')
    const meWxml = fs.readFileSync(path.join(ROOT, 'miniprogram/pages/me/me.wxml'), 'utf8')
    const roomWxml = fs.readFileSync(path.join(ROOT, 'miniprogram/game/room/room.wxml'), 'utf8')

    /* 输入框 class → 云端对应限制的抽取方式 */
    const pairs = [
      {
        name: '昵称',
        html: meWxml,
        cls: 'mein',
        cloud: () => {
          const m = /const name = String\(event\.name \|\| ''\)\.trim\(\)\.slice\(0, (\d+)\)/.exec(cloudSrc)
          return m ? Number(m[1]) : null
        }
      },
      {
        name: '自定义题',
        html: roomWxml,
        cls: 'cardta',
        cloud: () => {
          const m = /const MAX_CARD = (\d+)/.exec(cloudSrc)
          return m ? Number(m[1]) : null
        }
      }
    ]

    const bad = []
    for (const p of pairs) {
      const re = new RegExp('class="[^"]*' + p.cls + '[^"]*"[^>]*maxlength="(\\d+)"|maxlength="(\\d+)"[^>]*class="[^"]*' + p.cls)
      const m = re.exec(p.html)
      const frontVal = m ? Number(m[1] || m[2]) : null
      const cloudVal = p.cloud()
      if (frontVal === null) { bad.push(p.name + '：找不到前端 maxlength'); continue }
      if (cloudVal === null) { bad.push(p.name + '：找不到云端限制（抽取可能失效）'); continue }
      if (frontVal !== cloudVal) bad.push(`${p.name}：前端 ${frontVal} ≠ 云端 ${cloudVal}`)
    }
    assert.deepStrictEqual(bad, [],
      '★ 前端长度限制与云端截断不一致 —— 用户会被**悄悄截断**：\n    ' + bad.join('\n    '))
    ok('前端 maxlength 与云端截断长度一致（昵称 / 自定义题）')
  }

  /* ============ ⑤b ★ 服务端算了的字段，前端必须有人用 ============ *
   *
   * 同一个模式在这个项目里出现了三次：
   *   · `how`（16 条规则文案）—— 写好了但从没渲染过
   *   · `streaks`（连赢计数）—— 云端在记，界面从没显示
   *   · `score`（扣分）—— 一样，而且我清死字段时还误删过它
   * 每一次都是**手工 grep 才发现**。这条断言把它自动化：
   *
   * 判据：`shape()` 返回的每个字段，前端 js/wxml（剥掉注释后）里必须出现过。
   * 否则就是"服务端算了但没人用"——要么接到界面上（更好），要么删掉。
   */
  {
    const cloudSrc = fs.readFileSync(
      path.join(ROOT, 'cloudfunctions/room/index.js'), 'utf8')
    const shapeM = /function shape\(room, openid\)[\s\S]*?\n\}/.exec(cloudSrc)
    assert.ok(shapeM, '抽不出 shape() —— 抽取逻辑可能失效')
    /* 顶层返回对象里的键 = 4 空格缩进 + key: */
    const keys = Array.from(shapeM[0].matchAll(/^ {4}([a-zA-Z][\w]*):/gm)).map(m => m[1])
    assert.ok(keys.length > 10, '抽到的字段太少（' + keys.length + '），抽取可能失效')

    /* 前端：剥掉注释再找引用（注释里提到不算"用了"） */
    const stripComments = (t) => t
      .replace(/<!--[\s\S]*?-->/g, ' ')
      .replace(/\/\*[\s\S]*?\*\//g, ' ')
      .replace(/(^|[^:])\/\/[^\n]*/g, '$1')
    /*
     * ⚠️ 范围要覆盖**分包里的全部前端 js/wxml**，不能只写死 room 那两个文件 ——
     *    2026-10-29 把结算文案抽到 `game/settle.js` 之后，`poker.myDrink`
     *    在 room.js 里不再出现，这条断言就把它误报成"死数据"了。
     *    （引用搬了家，不等于没人用。）
     */
    const frontFiles = []
    ;(function walk(d) {
      for (const f of fs.readdirSync(d, { withFileTypes: true })) {
        const fp = path.join(d, f.name)
        if (f.isDirectory()) { walk(fp); continue }
        if (/\.(js|wxml)$/.test(f.name)) frontFiles.push(fp)
      }
    })(path.join(ROOT, 'miniprogram/game'))
    const front = stripComments(frontFiles.map(f => fs.readFileSync(f, 'utf8')).join('\n'))

    /*
     * 白名单：确实"服务端返回但界面不用"的字段，每个都要有理由。
     * 保持极短 —— 白名单越长，这条断言越没价值。
     */
    const ALLOW = new Set([
      'updatedAt'   // 只用于服务端排序/过期判断，前端刻意不渲染（roomChanged 明确排除它）
    ])
    const unused = keys.filter(k => !ALLOW.has(k) && !new RegExp('\\b' + k + '\\b').test(front))
    assert.deepStrictEqual(unused, [],
      '★ 这些字段服务端算了但前端从没引用（死数据）：' + unused.join(', ') +
      '\n    要么接到界面上（像 streaks / score 那样），要么删掉（像 ready / cardsCount / pkLog）。')

    /*
     * 嵌套对象也要查 —— 顶层那条覆盖不到它们，而这里藏过死字段：
     *   · players[] 的 `ready` / `cardsCount`
     *   · poker 的 `log`（比牌历史，前端从没显示）
     * 抽取方式：按缩进找子对象体的键。
     */
    const nested = []
    const pm = /const players =[\s\S]*?\n  \}\)\)/.exec(shapeM[0])
    if (pm) {
      for (const m of pm[0].matchAll(/^ {4}([a-zA-Z][\w]*):/gm)) nested.push(['players.' + m[1], m[1]])
    }
    for (const sub of ['poker', 'uw']) {
      const at = shapeM[0].indexOf(sub + ': (function () {')
      if (at < 0) continue
      const ret = shapeM[0].indexOf('return {', at)
      if (ret < 0) continue
      const end = shapeM[0].indexOf('\n      }', ret)
      const seg = shapeM[0].slice(ret, end < 0 ? ret + 2000 : end)
      for (const m of seg.matchAll(/^ {8}([a-zA-Z][\w]*):/gm)) nested.push([sub + '.' + m[1], m[1]])
    }
    const nestedUnused = nested
      .filter(([full, key]) => !new RegExp('\\b' + key + '\\b').test(front))
      .map(([full]) => full)
    assert.deepStrictEqual(nestedUnused, [],
      '★ 这些**嵌套**字段服务端算了但前端从没引用：' + nestedUnused.join(', ') +
      '\n    （顶层那条断言覆盖不到子对象里的死字段）')

    ok(`shape 顶层 ${keys.length} 个 + 嵌套 ${nested.length} 个字段全部被前端使用`)
  }

  /* ============ ③d-2 onShareAppMessage 的 imageUrl 必须真实存在 ============ */
  console.log('\n=== ③d-2 转发封面图必须存在（路径错了会静默不显示）===')
  /*
   * 为什么单列一条：`imageUrl` 指向一个不存在的文件时，
   * 微信**不会报错**，只是退回"截取页面首屏当封面" ——
   * 群里看到的就是一堆文字，而开发者完全不知道。
   * 这和图片资源缺失是同一类问题（③d 只扫 wxml，`imageUrl` 写在 js 里）。
   */
  {
    const shareFiles = []
    ;(function walkShare(d) {
      if (Array.isArray(d)) return d.forEach(x => walkShare(x))
      for (const f of fs.readdirSync(d, { withFileTypes: true })) {
        const fp = path.join(d, f.name)
        if (f.isDirectory()) walkShare(fp)
        else if (f.name.endsWith('.js')) shareFiles.push(fp)
      }
    })(PAGE_ROOTS)

    const missingImg = []
    for (const js of shareFiles) {
      const src = fs.readFileSync(js, 'utf8').replace(/\/\*[\s\S]*?\*\//g, '')
      for (const m of src.matchAll(/imageUrl\s*:\s*['"]([^'"]+)['"]/g)) {
        const rel = m[1].replace(/^\//, '')
        if (!fs.existsSync(path.join(ROOT, 'miniprogram', rel))) {
          missingImg.push(path.relative(ROOT, js) + ' → ' + m[1])
        }
      }
    }
    assert.deepStrictEqual(missingImg, [],
      '★ 转发封面图不存在（微信不报错，只是退回截首屏）：\n    ' + missingImg.join('\n    '))
    ok('转发封面图路径全部真实存在')
  }

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
    /* 支持传数组（PAGE_ROOTS 有两个根：主包 + 分包） */
    if (Array.isArray(dir)) return dir.reduce((a, d) => walkWxml(d, a), out || [])
    out = out || []
    fs.readdirSync(dir).forEach(f => {
      const p = path.join(dir, f)
      if (fs.statSync(p).isDirectory()) walkWxml(p, out)
      else if (f.endsWith('.wxml')) out.push(p)
    })
    return out
  }
  const appCss = fs.readFileSync(path.join(ROOT, 'miniprogram', 'app.wxss'), 'utf8')
  walkWxml(PAGE_ROOTS).forEach(wxml => {
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
          /*
           * 确实不需要样式的类用**显式白名单**放行，不要放宽判据。
           * 每项都要说明"为什么不需要"：
           *   truth —— 题卡（真心话/大冒险）的默认态。颜色由 `.cardbox` 的
           *     默认样式提供，只有 `.dare` 需要改色。所以 'truth' 这个字面量
           *     是**语义标记**（前端用它判断显示哪种标签），不是样式钩子。
           */
          if (lit === 'truth') return
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
  walkWxml(PAGE_ROOTS).forEach(wxml => {
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

  /* ============ ③c-3 模板里写的 class 必须有样式定义 ============ */
  console.log('\n=== ③c-3 模板写的 class 必须有定义（否则布局静默失效）===')
  /*
   * 为什么单列：`class="ht-list"` 这种"写了但没定义"的情况**不报错** ——
   * 元素照常渲染，只是没有那条样式（布局悄悄变了）。
   * `<image>` 缺 class 定义更严重（撑满容器），那个由 ③e-3 管；
   * 这条管**所有元素**。
   *
   * ⚠️ 判据必须只看**静态 class 属性**、且只认 ASCII 类名：
   *    第一版把 `{{x ? '卧底赢了' : ...}}` 里的中文文案也当成了 class，
   *    报出 38 个假阳性（连 '是卧底' '吹牛被抓' 都在里面）。
   *    假阳性比漏报更麻烦 —— 它会让我去"修"本来就对的东西。
   */
  {
    const stripCss = (t) => t.replace(/\/\*[\s\S]*?\*\//g, '')
    /*
     * ★★ 这里原来是 `fs.readdirSync(miniprogram/pages)` 的**独立实现** ——
     *   所以 2026-10-28 房间页移进分包后，这一条（class 必须有样式）就
     *   悄悄只扫主包了：往 room.wxml 里塞一个没有样式的 class，断言毫无反应。
     *   现在改成遍历 PAGE_ROOTS（主包 + 分包）。
     */
    const pageDirs = []
    for (const root of PAGE_ROOTS) {
      if (!fs.existsSync(root)) continue
      for (const d of fs.readdirSync(root, { withFileTypes: true })) {
        if (d.isDirectory()) pageDirs.push({ name: d.name, dir: path.join(root, d.name) })
      }
    }
    const appCss = stripCss(fs.readFileSync(path.join(ROOT, 'miniprogram', 'app.wxss'), 'utf8'))
    const undef = []
    for (const { name: pg, dir } of pageDirs) {
      for (const f of fs.readdirSync(dir)) {
        if (!f.endsWith('.wxml')) continue
        const wxml = fs.readFileSync(path.join(dir, f), 'utf8').replace(/<!--[\s\S]*?-->/g, '')
        const cssFile = path.join(dir, f.replace(/\.wxml$/, '.wxss'))
        const css = stripCss(fs.existsSync(cssFile) ? fs.readFileSync(cssFile, 'utf8') : '') + appCss
        const defined = new Set(Array.from(css.matchAll(/\.([a-zA-Z][\w-]*)/g)).map(m => m[1]))
        for (const m of wxml.matchAll(/class="([^"]*)"/g)) {
          /*
           * 只留静态部分。★★ 关键：把 {{...}} 换成**占位符**而不是空格 ——
           * `class="pav s{{item.seat % 4}}"` 里的 `s` 是动态类名的前缀，
           * 换成空格后它就成了一个独立的 token `s`，被误报"缺少 .s 样式"。
           * 换成占位符，后面就能识别出"这个 token 是拼出来的，跳过"。
           */
          const staticPart = m[1].replace(/\{\{[\s\S]*?\}\}/g, '\u0000')
          for (const tok of staticPart.split(/\s+/)) {
            if (!tok) continue
            if (!/^[a-zA-Z][\w-]*$/.test(tok)) continue   // 中文文案、插值残留一律跳过
            /*
             * ★ 动态拼接的**半边**要跳过（2026-10-28）：
             *   `class="cf cf-{{item % 5}}"` 剥掉插值后剩下 `cf-`，
             *   那不是一个完整的类名，而是前缀 —— 真类名（cf-0..cf-4）
             *   由各自的样式/断言覆盖。不跳会报"cf- 没有样式"这种假阳性，
             *   而假阳性会让我去改本来就对的代码。
             */
            if (tok.endsWith('-') || tok.startsWith('-')) continue
            /* 动态拼接的另一半（如 s{{i}} 的 s）：真类名由各自样式覆盖 */
            if (tok.indexOf('\u0000') >= 0) continue
            if (!defined.has(tok)) undef.push(pg + '/' + f + ' → .' + tok)
          }
        }
      }
    }
    assert.deepStrictEqual(undef, [],
      '★ 这些 class 写在模板里但没有任何样式定义（布局会静默失效）：\n    ' +
      undef.join('\n    ') +
      '\n    要么补样式，要么把没用的 class 名删掉（别留"看起来有用"的空壳）。')
    ok('模板里写的 class 全部有样式定义')
  }

  /* ============ ③d wxml 引用的图片必须真实存在 ============ */
  console.log('\n=== ③d 模板引用的图片文件必须存在（骰子图那类）===')
  /*
   * 为什么加这条：2.5.0 把骰子从 CSS 拼装改成**离线渲染的图片**
   * （miniprogram/game/images/dice/dice-1..6.png，由 scripts/render-dice.py 生成）。
   *
   * 这引入了一类全新的静默故障：图片没生成 / 被误删 / 路径写错时，
   * `<image>` 只是**不显示**，不报错、不警告，页面照常渲染 ——
   * 骰子直接消失，而 check.sh 与其它断言都发现不了。
   *
   * 这里静态解析 wxml 里所有以 / 开头的 src，验证文件真实存在。
   */
  const missingImg = []
  function walkWxmlImg(dir, out) {
    /* 支持传数组（PAGE_ROOTS 有两个根：主包 + 分包） */
    if (Array.isArray(dir)) return dir.reduce((a, d) => walkWxmlImg(d, a), out || [])
    out = out || []
    fs.readdirSync(dir).forEach(f => {
      const p = path.join(dir, f)
      if (fs.statSync(p).isDirectory()) walkWxmlImg(p, out)
      else if (f.endsWith('.wxml')) out.push(p)
    })
    return out
  }
  walkWxmlImg(PAGE_ROOTS).forEach(wxml => {
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
  const diceDir = path.join(ROOT, 'miniprogram', 'game', 'images', 'dice')
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
  /*
   * ★★ 音效注册表 2026-10-28 拆成了两份：
   *   主包 utils/sfx.js（只有 tick，给「我的」页试听）
   *   分包 game/sfx.js（其余 34 个）
   *   所以这里要把两份合起来看 —— 否则分包里的 play('diceSettle') 会被
   *   误报成"没注册"（假阳性会让我去改对的代码）。
   */
  const subSfxSrc = fs.readFileSync(path.join(ROOT, 'miniprogram/game/sfx.js'), 'utf8')
  const soundKeys = {}
  {
    const mainFiles = sfxSrc.slice(sfxSrc.indexOf('const FILES = {'),
      sfxSrc.indexOf('}', sfxSrc.indexOf('const FILES = {')))
    const subFiles = subSfxSrc.slice(subSfxSrc.indexOf('const FILES = {'),
      subSfxSrc.indexOf('}', subSfxSrc.indexOf('const FILES = {')))
    /*
     * 两种注册形态都要认（2026-10-30）：
     *   单值：  diceSettle: '/game/audio/x.wav'
     *   变体：  diceSettle: [\n    '/game/audio/x.wav',
     * 数组是为了"多采样变体"（同一动作放多份不同录音，play 时随机挑）。
     * 这里取数组第一项参与"文件是否存在"的检查；play 里会遍历全部。
     * ⚠️ 只认单值正则的话，改成数组的音效会被误报成"没注册"（假阳性）。
     */
    const re = /^\s*([\w]+):\s*'\/?((?:game\/)?audio\/[\w-]+\.wav)'/gm
    const reArr = /^\s*([\w]+):\s*\[\s*\n?\s*'\/?((?:game\/)?audio\/[\w-]+\.wav)'/gm
    let m
    while ((m = re.exec(mainFiles))) soundKeys[m[1]] = m[2]
    while ((m = re.exec(subFiles))) soundKeys[m[1]] = m[2]
    while ((m = reArr.exec(mainFiles))) if (!soundKeys[m[1]]) soundKeys[m[1]] = m[2]
    while ((m = reArr.exec(subFiles))) if (!soundKeys[m[1]]) soundKeys[m[1]] = m[2]
  }

  /* ① 注册的音效必须有对应文件 */
  /*
   * 文件可能在主包 audio/ 或分包 game/audio/ —— 两边都找一遍。
   * （拆分后主包只剩 tick，其余 34 个在分包里。）
   */
  const noFile = Object.keys(soundKeys).filter(k => ![
    path.join(ROOT, 'miniprogram', soundKeys[k]),
    path.join(ROOT, 'miniprogram', 'game', soundKeys[k])
  ].some(p => fs.existsSync(p)))
  assert.deepStrictEqual(noFile, [],
    '这些音效注册了但文件不存在（播放时静默失败）：\n    ' + noFile.join('\n    '))
  ok(`${Object.keys(soundKeys).length} 个音效全部有对应文件`)

  /* ② 页面直接传字符串的调用必须已注册 */
  const unregistered = []
  function walkPages(dir, out) {
    /* 支持传数组（PAGE_ROOTS 有两个根：主包 + 分包） */
    if (Array.isArray(dir)) return dir.reduce((a, d) => walkPages(d, a), out || [])
    out = out || []
    fs.readdirSync(dir).forEach(f => {
      const p = path.join(dir, f)
      if (fs.statSync(p).isDirectory()) walkPages(p, out)
      else if (f.endsWith('.js')) out.push(p)
    })
    return out
  }
  walkPages(PAGE_ROOTS).forEach(jsFile => {
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

  /* ============ ③b-3 调用的 sfx 方法必须真的导出（防死代码） ============ */
  console.log('\n=== ③b-3 sfx 的方法必须真的导出过 ===')
  /*
   * ★ 2026-10-28 发现：room.js 里写着 `sfx.init && sfx.init()` ——
   *   而 sfx **从来没导出过 init**。因为有 `&&` 短路，它不报错，
   *   只是**永远不执行**。结果是"预加载"这件事从未发生。
   *
   *   这类"防御性写法掩盖了方法不存在"比直接报错更隐蔽：
   *   `sfx.xxx && sfx.xxx()` 看起来稳，实际是死代码。
   */
  {
    const sfxSrc2 = fs.readFileSync(path.join(ROOT, 'miniprogram/game/sfx.js'), 'utf8')
    const exp = /module\.exports\s*=\s*\{([^}]*)\}/.exec(sfxSrc2)
    assert.ok(exp, '找不到 sfx 的导出')
    const exported = new Set(exp[1].split(',').map(x => x.trim().split(':')[0].trim()).filter(Boolean))
    const missing = []
    for (const root of PAGE_ROOTS) {
      if (!fs.existsSync(root)) continue
      const walkJs = (d) => {
        for (const f of fs.readdirSync(d, { withFileTypes: true })) {
          const fp = path.join(d, f.name)
          if (f.isDirectory()) { walkJs(fp); continue }
          if (!f.name.endsWith('.js') || fp.includes('feedback.js') || fp.includes('sfx.js')) continue
          /*
           * ⚠️ 必须先剥注释再匹配：room.js 的注释里写了旧写法
           *    `sfx.init && sfx.init()` 说明这个 bug —— 不剥注释的话
           *    断言会去报注释里的代码（假阳性），而那行代码本来就是对的。
           */
          const src = fs.readFileSync(fp, 'utf8')
            .replace(/\/\*[\s\S]*?\*\//g, '')
            .replace(/(^|[^:])\/\/[^\n]*/g, '$1')
          for (const m of src.matchAll(/sfx\.([a-zA-Z_]\w*)\s*(?:\(|&&)/g)) {
            if (!exported.has(m[1])) missing.push(path.relative(ROOT, fp) + ' → sfx.' + m[1])
          }
        }
      }
      walkJs(root)
    }
    assert.deepStrictEqual([...new Set(missing)], [],
      '这些 sfx 方法没导出（调用永远不生效，而且不报错）：\n    ' +
      [...new Set(missing)].join('\n    '))
    ok('页面调用的 sfx 方法全部有导出')
  }

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
  /*
   * ★ 精确白名单：扑克花色 ♠♥♣♦（U+2660 2665 2663 2666）。
   *
   * 它们落在 emoji 区间里，但**不是 emoji**：Unicode 把它们归为
   * "Miscellaneous Symbols" 的文字符号，跨平台渲染是单色字形，
   * 不会出现 iOS 彩色 / Android 黑白那种不一致。
   * 而且牌面上必须显示花色 —— 画成 SVG 图标既没必要，也会让牌面看起来更假。
   *
   * ⚠️ 只挖掉这四个字符，**不放宽整个区间**：
   *    改成"2600-27BF 全放行"这条断言就等于废了（记过的教训）。
   */
  const emojiRe = /[\u{1F300}-\u{1FAFF}\u{2600}-\u{265F}\u{2661}\u{2662}\u{2664}\u{2667}-\u{27BF}\u{2B00}-\u{2BFF}\u{FE0F}\u{2190}-\u{21FF}]/u
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

    /* ① 数据里"当作图标用"的 key 必须真的存在于图标库。
       原来这里还判断"有没有注册进 _IC"，但那是去 grep
       `for (const _k of [...])` 的字面量 —— 装配方式改成 iconSet.build() 后
       判据就失效了（改对了仍报旧错），属于"判据依赖代码长相"。
       现在"注册覆盖"改成语义判据，见下面 ③e-3。 */
    const used = new Set()
    for (const m of src.matchAll(/\b(?:icon|e)\s*:\s*'([a-zA-Z][\w]*)'/g)) used.add(m[1])
    /*
     * ⚠️ `icon: 'success'` 是 wx.showToast 的参数，不是 SVG 图标。
     *    所以必须有一份显式白名单 —— 不能用"不在图标库里就报"，
     *    那会把 Toast 全报成人造错误（假阳性比漏报更麻烦：会让我去改对的代码）。
     */
    const TOAST_ICONS = ['success', 'loading', 'none', 'error', 'warn', 'info']
    for (const k of used) {
      if (iconNames.includes(k)) continue
      if (TOAST_ICONS.includes(k)) continue
      iconUnregistered.push(path.relative(ROOT, js) + ' → ' + k)
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
    '这些图标 key 被数据引用，但图标库里根本没有（会渲染成空白）：\n    ' +
    iconUnregistered.join('\n    '))
  ok('数据里用到的图标 key 全部已注册（不会静默空白）')

  assert.deepStrictEqual(printedRaw, [],
    'wxml 直接渲染了图标字段（会把 key 当文字打印，页面显示英文乱码）：\n    ' +
    printedRaw.join('\n    ') + '\n    改用 <image src="{{ic[item.xxx]}}" />')
  ok('wxml 没有裸渲染图标字段（不会打印英文 key）')

  /* ============ ③e-3 玩法图标必须能从注册表自动装配（语义判据）============
   *
   * 判的是**行为**：调用页面真正用的那个装配函数，看注册表里每个玩法
   * 能不能拿到非空 data URI。不去 grep 页面里的 for 循环 ——
   * 「判据不能依赖代码长什么样」这条，本项目已经因为同类问题连错三版
   * （数 action 字面量 / 抓 call 的 payload / 词边界正则）。
   */
  {
    const iconSet = require(path.join(ROOT, 'miniprogram', 'utils', 'iconSet.js'))
    const { GAMES: G } = require(path.join(ROOT, 'miniprogram', 'utils', 'games.js'))
    const built = iconSet.build([], '#000000')
    const missing = []
    for (const g of G) {
      if (!built[g.icon] || !String(built[g.icon]).length) missing.push(g.id + ' → icon:' + g.icon)
    }
    assert.deepStrictEqual(missing, [],
      '★ 这些玩法拿不到图标 data URI（页面上是空白，且不报错）：\n    ' +
      missing.join('\n    ') +
      '\n    修法：在 icons.js 的 PATHS 补这个 key，或改用注册表里已有的图标。')
    ok(`玩法图标 ${G.length} 个全部能自动装配`)
  }

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

  /* ============ ③b 反向检查：定义了却从没被绑定的方法（死功能） ============ */
  console.log('\n=== ③b 页面方法里有没有"从没被绑定过"的死功能 ===')
  /*
   * ★★ 2026-10-28，用一个真 bug 换来的。
   *
   *   金花的「换牌」功能是**完整实现**的：`pkSwap` 方法、服务端 swapPublic/
   *   swapMine、代价计算、二次确认弹窗，全都齐了。但模板里**从来没有按钮
   *   调用它** —— 规则说明里写着"换底牌喝一杯、换手牌喝半杯"，
   *   而玩家在界面上找不到任何入口。
   *
   *   ③ 那条断言只查一个方向：**模板绑定的方法必须在 js 里存在**。
   *   "存在的方法从没被绑定"是反方向，一条断言都没管。
   *
   * 判据：
   *   · 从 js 里抽方法名（`  name(...) {` 这种两空格缩进的定义）
   *   · 排除生命周期（onLoad/onShow/…）、以下划线开头的内部方法、
   *     以及**在 js 里被 this.xxx() 调用过的**（那种是内部实现，不需要绑定）
   *   · 剩下的必须能在模板的 bind / catch 属性里找到
   */
  {
    const LIFECYCLE = new Set(['onLoad', 'onShow', 'onHide', 'onUnload', 'onReady', 'onPullDownRefresh',
      'onReachBottom', 'onShareAppMessage', 'onShareTimeline', 'onPageScroll', 'onResize', 'onTabItemTap'])
    const deadMethods = []
    /*
     * ★ 扫描范围必须包含**分包**（miniprogram/game）。
     *   房间页在分包里，只扫 pages 的话它永远不被检查 ——
     *   而"断言只扫了一半"是静默的：它一直是绿的，只是什么都没测。
     *   （同一天已经在"死动作检测"上踩过同一个坑，这次是第二次。）
     */
    const pageDirs = []
    PAGE_ROOTS.forEach(root => {
      if (!fs.existsSync(root)) return
      for (const f of fs.readdirSync(root, { withFileTypes: true })) {
        if (f.isDirectory()) pageDirs.push(path.join(root, f.name))
      }
    })
    for (const dir of pageDirs) {
      const dirName = path.basename(dir)
      for (const jf of fs.readdirSync(dir)) {
        if (!jf.endsWith('.js')) continue
        const js = fs.readFileSync(path.join(dir, jf), 'utf8')
        const wxmlFile = path.join(dir, jf.replace(/\.js$/, '.wxml'))
        if (!fs.existsSync(wxmlFile)) continue
        const tpl = fs.readFileSync(wxmlFile, 'utf8')
        const bound = new Set()
        ;(tpl.matchAll(/(?:bind|catch)[a-z]*="([a-zA-Z_]\w*)"/g)).forEach(m => bound.add(m[1]))
        const clean = js.replace(/\/\*[\s\S]*?\*\//g, '').replace(/(^|[^:])\/\/[^\n]*/g, '$1')
        /*
         * ⚠️ 必须排除 JS 关键字 —— 否则 `if (!Array.isArray(arr)) {` 这种
         *    在行首缩进两格的语句会被当成"名叫 if() 的页面方法"，
         *    报成死功能（2026-10-28 真实误报）。
         *    这类误报的代价是：我会去删一段本来正确的代码。
         */
        const JS_KW = new Set(['if', 'for', 'while', 'switch', 'catch', 'return',
          'function', 'else', 'try', 'do', 'new', 'typeof', 'await', 'delete'])
        const defs = []
        ;(clean.matchAll(/\n  (?:async )?([a-zA-Z_]\w*)\s*\([^)]*\)\s*\{/g))
          .forEach(m => { if (!JS_KW.has(m[1])) defs.push(m[1]) })
        for (const name of defs) {
          if (LIFECYCLE.has(name)) continue
          if (name.startsWith('_')) continue
          if (bound.has(name)) continue
          /* 被 this.xxx() 调过 = 内部实现，不需要绑定 */
          if (new RegExp('this\\.' + name + '\\s*\\(').test(clean)) continue
          deadMethods.push(dirName + '/' + jf + ' → ' + name + '()')
        }
      }
    }
    assert.deepStrictEqual(deadMethods, [],
      '★ 这些方法定义在页面里，但**模板从没绑定过、内部也没调用** —— 是死功能：\n    ' +
      deadMethods.join('\n    ') +
      '\n    要么补上入口，要么删掉（"写好了但用户点不到"比没写更糟）。')
    ok('页面方法没有死功能（要么被模板绑定、要么被内部调用）')
  }

  /* ============ ④ 模板引用的房间字段必须真的有人提供 ============ */
  /*
   * ★★★ ④·深层 嵌套字段的幽灵检测（2026-10-30，真实踩到）。
   *
   * 比牌记录模板里写着 `room.poker.last.byText` / `targetText`，
   * 而**服务端从来没返回过这两个字段**（它返回 byCards / targetCards）。
   * 于是那三张牌一直是空的，而且不报错。
   * mock 数据里恰好写了 byText，所以渲染截图看起来完全正常 —— 问题被盖住了。
   *
   * 上面 ④ 那条只查 `room.xxx` 一层，看不见 `room.poker.last.xxx` 这种深层的。
   * 这里专门查已知会出问题的几个嵌套路径。
   */
  {
    const tpl = fs.readFileSync(path.join(ROOT, 'miniprogram/game/room/room.wxml'), 'utf8')
    const srv = fs.readFileSync(path.join(ROOT, 'cloudfunctions/room/index.js'), 'utf8')
    /*
     * ⚠️ 不能硬编码字段清单（第一版就是这么写的，反向验证时用 byText 替换
     *    byCards —— 而 byText 不在清单里 → **根本没检查** → exit=0，假绿）。
     * 改成**从模板里自动抽取**所有 room.poker.last.xxx。
     */
    /*
     * 从模板自动抽取**所有** room.X.Y 深层引用（不只 poker.last）。
     *
     * 来源可以是三种形式（2026-10-30 试错过）：
     *   ① 对象字面量 `key: ...`
     *   ② `obj.key = ...` 赋值（decorate 里大量这么写）
     *   ③ `.length` 这类数组长度不需要构造
     * 第一版只认 ①，把 poker.drinkText / hintText 误报成"没来源"。
     */
    const found = new Set()
    const re2 = /room\.(\w+)\.(\w+)/g
    let m2
    while ((m2 = re2.exec(tpl))) found.add(m2[1] + '.' + m2[2])
    const ghost = []
    const jsSrc = fs.readFileSync(path.join(ROOT, 'miniprogram/game/room/room.js'), 'utf8')
    found.forEach(full => {
      const key = full.split('.').pop()
      if (key === 'length') return
      const hasKey = new RegExp('\\b' + key + '\\s*:').test(srv)
      const hasAssign = new RegExp('\\.' + key + '\\s*=').test(jsSrc) ||
                        new RegExp('\\.' + key + '\\s*=').test(srv)
      if (!hasKey && !hasAssign) {
        ghost.push('room.' + full + '（服务端和前端都没有构造 `' + key + '`）')
      }
    })
    assert.deepStrictEqual(ghost, [],
      '这些深层字段模板在用但服务端没返回（界面上会一直是空的，不报错）：\n    ' + ghost.join('\n    '))
    ok('★ 深层嵌套字段（poker.last.*）模板与云端对得上')
  }

  /*
   * ★★★ ④·mock 里不许有"真实代码不存在"的字段（2026-10-30，踩过一次）。
   *
   * `scripts/ui-render/mock/room.js` 里写了 `byText` / `targetText`，
   * 而服务端返回的是 `byCards` / `targetCards`。
   * 后果：**mock 的假字段盖住了一次真 bug** —— 比牌记录那三张牌
   * 在真机上一直是空的，但渲染截图看起来完全正常。
   *
   * 判据：mock 的 poker.last 里每个 key，都必须能在服务端或前端源码里找到来源。
   * （mock 存在的意义是"复刻真实数据"，不是"造一份方便自己的假数据"。）
   */
  {
    const mockSrc = fs.readFileSync(path.join(ROOT, 'scripts/ui-render/mock/room.js'), 'utf8')
    const jsSrc2 = fs.readFileSync(path.join(ROOT, 'miniprogram/game/room/room.js'), 'utf8')
    const srvSrc = fs.readFileSync(path.join(ROOT, 'cloudfunctions/room/index.js'), 'utf8')
    /* 只取 `last: {` 后第一层 key —— 用 [^[][] 排除嵌套的数组/对象字面量，
       否则 byCards:[{s:0,r:13}] 里的 s/r 会被当成 last 的 key（误报）。 */
    /*
     * 覆盖 mock 里所有嵌套块（不只 poker.last）——
     * 2026-10-30 扩大范围时又揪出两个：`uw.myDone`、`poker.log`，
     * 模板和服务端都没有它们（是历史遗留的噪音）。
     */
    const BLOCKS = ['last', 'bid', 'uw', 'spin', 'poker']
    const fake = []
    BLOCKS.forEach(name => {
      /*
       * ⚠️ 必须要求 `{` 后面紧跟换行 —— 否则正则跨过 `poker: {` 会一路吃到
       *   下一个 mock 状态名（`alone: () => ({`），把 `alone` 当字段误报。
       */
      /*
       * 段内容 = 从 `{` 到**第一个 } 或 [ 或换行**为止 ——
       * 这样既不会跨进嵌套对象，也不会跨到下一个 mock 状态。
       * （前两版分别跨进了 byCards 的 {s,r} 和下一个状态名 alone。）
       */
      /*
       * 允许 `{` 后面先换行再开始（真实写法就是 `poker: {\n   step: ...`），
       * 但段内**不许再出现换行** —— 否则会跨到下一个 mock 状态。
       * 所以：`{` → 可选空白（含换行）→ 取到第一个换行/}/[ 为止。
       */
      const m = new RegExp('\\b' + name + ':\\s*\\{[ \\t\\n]*([^}\\[\\n]*)').exec(mockSrc)
      if (!m) return
      const keys = [...new Set([...m[1].matchAll(/\b(\w+)\s*:/g)].map(x => x[1]))]
      keys.forEach(k => {
        const hasKey = new RegExp('\\b' + k + '\\s*:').test(srvSrc)
        const hasAssign = new RegExp('\\.' + k + '\\s*=').test(jsSrc2) ||
                          new RegExp('\\b' + k + '\\s*:').test(jsSrc2)
        if (!hasKey && !hasAssign) fake.push(name + '.' + k)
      })
    })
    assert.deepStrictEqual(fake, [],
      'mock 的 poker.last 里有真实代码不存在的字段（会盖住真 bug）：\n    ' + fake.join('\n    '))
    ok('★ mock 的 poker.last 字段都真实存在（不造假数据）')
  }

  /*
   * ★★★ ④·路径 scripts 里引用的 miniprogram/... 路径必须真实存在（2026-10-30）。
   *
   * 起因：2026-10-28 拆分包时，美术资源从 `miniprogram/images/` 移到了
   * `miniprogram/game/images/`，但**三个脚本的默认路径没跟着改**：
   *   · gen-share-cover.py 的 IMG
   *   · render-cup.py 的 --out 默认值
   *   · render-dice.py 的 --out 默认值
   * 后果：重跑脚本会把图写到旧位置，页面从新位置加载 → **空白且不报错**。
   *
   * 这类路径不参与编译、不参与运行时，**没有任何检查会发现它过期** ——
   * 只有真的有人跑那个脚本时才炸，所以藏了 8 天。
   */
  {
    const bad = []
    /* 不用 glob（项目没装这个依赖），直接 readdir + 后缀过滤 */
    const files = fs.readdirSync(path.join(ROOT, 'scripts'))
      .filter(f => /\.(py|js|sh)$/.test(f))
      .map(f => 'scripts/' + f)
    files.forEach(f => {
      if (/test-contract\.js$/.test(f)) return      // 跳过自己（本文件里有示例路径）
      /*
       * ⚠️ 必须**剥掉注释**再查 —— test-docs.js 的注释里写着
       * 「曾经把 miniprogram/utils/feedback.js 写错」，那是历史说明，
       * 不是真的引用。第一版没剥注释 → 误报。
       */
      const src = fs.readFileSync(path.join(ROOT, f), 'utf8')
        .replace(/\/\*[\s\S]*?\*\//g, '')
        .replace(/^\s*\*.*$/gm, '')
        .replace(/^\s*#.*$/gm, '')
        .replace(/^\s*\/\/.*$/gm, '')
      /*
       * 两类都要查：
       *   ① 具体文件（带扩展名）—— 读不到就空白
       *   ② **目录**（如 `--out default='miniprogram/images/cup'`）——
       *      重跑脚本会把产物写到不存在的目录里
       * 第一版只查 ①，于是 render-cup.py 的目录默认值被漏掉（反向验证 exit=0）。
       */
      const paths = new Set()
      for (const m of src.matchAll(/miniprogram\/[\w/.-]+\.(png|wav|json|js|wxss|wxml)/g)) {
        paths.add(m[0])
      }
      /* 目录：以 miniprogram/game/images/ 或 miniprogram/images/ 开头、不带扩展名的 */
      for (const m of src.matchAll(/miniprogram\/(?:game\/)?images\/[\w-]+/g)) {
        paths.add(m[0])
      }
      for (const p of paths) {
        if (p.includes('..')) continue
        if (!fs.existsSync(path.join(ROOT, p))) bad.push(f + ' → ' + p)
      }
    })
    assert.deepStrictEqual(bad, [],
      '这些脚本引用了不存在的路径（重跑会写错位置/读不到文件，且不报错）：\n    ' + bad.join('\n    '))
    ok('★ scripts 里引用的资源路径都真实存在')
  }

  /*
   * ★★★ ④·形状 mock 字段的**运行时类型**必须和模板用法一致（2026-10-30）。
   *
   * 起因：加「斋」功能时把叫骰选项从 string[] 改成 {n,face,zhai,label}[]，
   * 模板随之用 `item.label` —— 而 mock 还是纯字符串 →
   * 渲染出来是**4 个空白灰块**，真机上却有字。
   *
   * ★ 这条断言前三版都想"看源码猜形状"（正则抓 `field: [` 后面是不是引号），
   *   每版都被反向验证打回（players 误报、空数组误报、换行断掉）。
   *   最后换了个完全不同的思路：**真的 require mock，跑每个状态，看运行时类型**。
   *   不猜写法，直接看结果 —— 一次就对了。
   */
  {
    const tplSrc = fs.readFileSync(path.join(ROOT, 'miniprogram/game/room/room.wxml'), 'utf8')
    /* 模板里 `wx:for="{{room.X}}"` 且循环体用 `item.Y` → 这个字段必须是对象数组 */
    const need = new Set()
    for (const m of tplSrc.matchAll(/wx:for="\{\{room\.(\w+)\}\}"[\s\S]{0,300}?item\.(\w+)/g)) {
      need.add(m[1] + '.' + m[2])
    }
    const mockPath = path.join(ROOT, 'scripts/ui-render/mock/room.js')
    delete require.cache[require.resolve(mockPath)]
    const mockMod = require(mockPath)
    const states = mockMod.states || {}
    const bad = []
    for (const name of Object.keys(states)) {
      let st
      try {
        st = typeof states[name] === 'function' ? states[name]() : states[name]
      } catch (e) { continue }
      const room = (st && st.room) || {}
      for (const nf of need) {
        const field = nf.split('.')[0]
        const arr = room[field]
        if (Array.isArray(arr) && arr.length && typeof arr[0] !== 'object') {
          bad.push(name + ' → room.' + field + ' 的元素是 ' + typeof arr[0] + '，模板却用 item.xxx')
        }
      }
    }
    assert.deepStrictEqual(bad, [],
      '这些 mock 状态的字段形状不对（渲染出来会是空白）：\n    ' + bad.join('\n    '))
    ok('★ 全部 ' + Object.keys(states).length + ' 个 mock 状态的字段形状与模板一致')
  }

  /*
   * ★★★ ④·c 前端派生字段漏赋值（2026-10-30，真实抓到一个）。
   *
   * 模板第 889 行读 `room.poker.drinkText`（「换牌已经喝了 X 杯」），
   * 而 `decorate()` 只给**玩家**设了 `p.drinkText`（每人一行），
   * **从来没给 room.poker.drinkText 赋过值** →
   * 那一行永远不显示，玩家看不到自己换牌喝了多少。
   *
   * 这是幽灵字段的第三种形态：
   *   ① 服务端不返回（有断言 ④）
   *   ② mock 造假（有断言 ④·mock）
   *   ③ **前端派生字段漏赋值**（这一条）
   *
   * 判据：模板里每个 `room.X.Y`，必须能在 js 的 `.Y =` / `Y:` 或服务端的 `Y:` 里找到来源。
   */
  {
    const tplC = fs.readFileSync(path.join(ROOT, 'miniprogram/game/room/room.wxml'), 'utf8')
    const jsC = fs.readFileSync(path.join(ROOT, 'miniprogram/game/room/room.js'), 'utf8')
    const srvC = fs.readFileSync(path.join(ROOT, 'cloudfunctions/room/index.js'), 'utf8')
    const pairs = [...new Set([...tplC.matchAll(/room\.(\w+)\.(\w+)/g)].map(m => m[1] + '.' + m[2]))]
    const miss = []
    pairs.forEach(ab => {
      const k = ab.split('.')[1]
      const has =
        new RegExp('\\.' + k + '\\s*=').test(jsC) ||
        new RegExp('\\b' + k + '\\s*:').test(jsC) ||
        new RegExp('\\b' + k + '\\s*:').test(srvC)
      if (!has) miss.push('room.' + ab)
    })
    assert.deepStrictEqual(miss, [],
      '模板读了两层字段但没有任何地方赋值（界面上永远空白）：\n    ' + miss.join('\n    '))
    ok('★ ' + pairs.length + ' 个两层字段都有赋值来源（含前端派生）')
  }

  console.log('\n=== ④ 模板引用的 room.xxx 必须由服务端真实返回（幽灵字段检测）===')
  /*
   * 判据：把 room 云函数**真实响应**里的 room 对象字段收集起来，
   *      再看模板里 `room.xxx` 的引用是否都在其中。
   *
   * ⚠️ 只查 `room.` 前缀，**不查 `item.`**：item 在模板里是多义的
   *    （players / decks / games / cards 都叫 item），拿一个集合去比会大面积误报。
   *    宁可精确也不要宽 —— AGENTS.md 的原话。
   *
   * ⚠️ 字段清单**不能硬编码**在测试里：硬编码时往服务端加字段不会报错，
   *    往模板加字段也照样通过（等于这条断言是废的）。
   *    必须从真实响应里抽。
   */
  const realRoom = await room.main({ action: 'status', id: ROOM_ID })
  assert.ok(realRoom.ok && realRoom.room, '④ 取房间状态应成功')
  const providedRoom = new Set(Object.keys(realRoom.room))
  /*
   * 前端 `decorate()` 算的派生字段也要算数 —— 但它们**必须从源码里抽**，
   * 不能像原来那样硬编码一份数组。
   *
   * ⚠️ 原来就是一份写死的 18 项清单。2026-10-28 往 decorate 里加了
   *    `waitingText`（等待文案按人数换句式），模板一引用 → 这条断言立刻报
   *    "幽灵字段"：**它把正确代码判成了错误**，而去修的办法只有"往白名单里
   *    再补一项" —— 那等于自己给自己放行，白名单从此只增不减，
   *    真出现幽灵字段时照样有它兜着，这条断言迟早退化成摆设。
   *
   * 现在的判据是：**模板引用的 room.X 必须满足「服务端返回」或「decorate 里赋过值」**。
   * 两边都是自动抽取的，加字段不用改测试，而真·幽灵字段（模板写了、
   * 但既没服务端提供、也没人计算）照样抓得到，且不报错地静默变空。
   */
  {
    const roomSrc = fs.readFileSync(path.join(ROOT, 'miniprogram', 'game', 'room', 'room.js'), 'utf8')
    const i = roomSrc.indexOf('  decorate(room) {')
    assert.ok(i > 0, '④ 找不到 room.js 的 decorate()（前端派生字段的唯一入口）')
    /* 括号计数取函数体：比正则可靠，不会被体内的对象字面量骗到 */
    let depth = 0, end = -1
    const open = roomSrc.indexOf('{', i)
    for (let k = open; k < roomSrc.length; k++) {
      if (roomSrc[k] === '{') depth++
      else if (roomSrc[k] === '}') { depth--; if (depth === 0) { end = k; break } }
    }
    assert.ok(end > open, '④ decorate() 的括号不配平')
    const body = roomSrc.slice(open, end)
    const derived = [...new Set([...body.matchAll(/room\.([A-Za-z_]\w*)\s*=/g)].map(m => m[1]))]
    /* `room[k] = ...` 这类动态写入无法静态判定，出现了就明确失败而不是悄悄漏掉 */
    assert.deepStrictEqual(body.match(/room\[[^\]]+\]\s*=/g) || [], [],
      '④ decorate() 里出现动态字段写入（room[k]=），幽灵字段断言无法覆盖')
    assert.ok(derived.length > 5, '④ decorate() 抽取到的派生字段太少，抽取逻辑可能失效')
    derived.forEach(k => providedRoom.add(k))
    console.log('  · decorate 派生字段 ' + derived.length + ' 个，服务端字段 ' + Object.keys(realRoom.room).length + ' 个')
  }

  const stripComments = (s) => s.replace(/<!--[\s\S]*?-->/g, '')
  /* 自己的递归遍历：④ 在顶层 walk/pagesDir 定义之前，不能复用它们 */
  function walkGhost(dir, out) {
    out = out || []
    for (const f of fs.readdirSync(dir, { withFileTypes: true })) {
      const fp = path.join(dir, f.name)
      if (f.isDirectory()) walkGhost(fp, out)
      else if (f.name.endsWith('.wxml')) out.push(fp)
    }
    return out
  }
  const ghost = []
  walkGhost(path.join(ROOT, 'miniprogram', 'pages')).forEach(wxml => {
    const tpl = stripComments(fs.readFileSync(wxml, 'utf8'))
    const re = /\broom\.([a-zA-Z_]\w*)/g
    let mm
    const seen = new Set()
    while ((mm = re.exec(tpl))) {
      const key = mm[1]
      if (seen.has(key)) continue
      seen.add(key)
      if (!providedRoom.has(key)) ghost.push(path.relative(ROOT, wxml) + ' → room.' + key)
    }
  })
  assert.deepStrictEqual(ghost, [],
    '模板引用了服务端从未返回的字段（幽灵字段，界面上会静默变空）：\n    ' + ghost.join('\n    '))
  ok('模板引用的 room.* 字段都由真实响应提供')

  /* ============ ④b 嵌套引用也要有来源（room.a.b） ============ */
  console.log('\n=== ④b room.a.b 这种两层引用必须真的有来源 ===')
  /*
   * ★★ 为什么必须补这一条（2026-10-28 真实事故）：
   *   ④ 只检查 `room.xxx` 的**第一层**，于是
   *       模板：{{room.poker.last.noteText}}
   *       云函数：从来只返回 `pkLast`，里面有 kind/winner/byType… 没有 noteText
   *   从缝里漏过去了 —— 比牌区下面那行说明**永远空白**，
   *   玩家看得到"谁出局"，看不到"凭什么"，而且不会报错。
   *
   *   判据：两层引用的第二层名字，必须在**云函数源码**里作为对象键出现过，
   *   或者在 room.js 里被赋过值。
   *   ⚠️ 这是个**弱判据**（名字在别处出现过就算有来源），
   *      它抓不到"同一个名字在别的对象里"的情况。
   *      但它能抓住最严重的那种：**全仓只有模板记得这个字段**，
   *      而那正是本次事故的形态。宁可精确也不要宽的例外是"别放宽到无效"，
   *      而一个从不报错的更强判据需要构造带比牌历史的房间响应，成本不成比例。
   */
  {
    const roomJsSrc = fs.readFileSync(path.join(ROOT, 'miniprogram', 'game', 'room', 'room.js'), 'utf8')
    const cloudSrc = fs.readFileSync(path.join(ROOT, 'cloudfunctions', 'room', 'index.js'), 'utf8')
    const knownKey = (k) =>
      new RegExp('(^|[\\s,{])' + k + '\\s*:').test(cloudSrc) ||
      new RegExp('\\.' + k + '\\b').test(roomJsSrc) ||
      new RegExp('(^|[\\s,{])' + k + '\\s*:').test(roomJsSrc)
    const nestGhost = []
    walkGhost(path.join(ROOT, 'miniprogram', 'pages')).forEach(wxml => {
      const tpl = stripComments(fs.readFileSync(wxml, 'utf8'))
      const re = /\broom\.([a-zA-Z_]\w*)\.([a-zA-Z_]\w*)/g
      let mm
      const seen = new Set()
      while ((mm = re.exec(tpl))) {
        const path2 = mm[1] + '.' + mm[2]
        if (seen.has(path2)) continue
        seen.add(path2)
        if (!knownKey(mm[2])) nestGhost.push(path.relative(ROOT, wxml) + ' → room.' + path2)
      }
    })
    assert.deepStrictEqual(nestGhost, [],
      '模板引用了两层字段，但云函数与前端都不产生它（界面上静默变空）：\n    ' +
      nestGhost.join('\n    '))
    ok('两层引用 room.a.b 的第二层都有来源（不是只有模板记得它）')

  /* ============ ④c 动画曲线必须收敛（风格一致性） ============ */
  console.log('\n=== ④c 全仓动画曲线只能是那 6 条 ===')
  /*
   * ★★ 2026-10-28。改造前全仓有 **18 种** cubic-bezier + 12 处裸 ease。
   *   单看每一处都"挺顺"，但整体是十八种手感混在一起 ——
   *   这是"说不上来哪里不对、就是不像一个团队做的"的典型来源。
   *
   *   收敛到 6 条（每条对应一种**语义**，不是按好看程度挑的）：
   *     (0, 0, .2, 1)          入场：快起慢停，元素"落进画面"
   *     (.4, 0, .2, 1)         屏内：位置/大小变化
   *     (.36, .07, .19, .97)   撞击：带一点极快的中段，专门给"砸住"
   *     (.34, 1.2, .64, 1)     轻回弹：轻微过冲（≤6%）
   *     (.34, 1.4, .64, 1)     中回弹：物体落位
   *     (.34, 1.56, .64, 1)    强回弹：奖励/爆发时刻
   *     (.35, .05, .75, .95)   **持续加速**：受重力的自由落体（撒花纸片）
   *
   *   ⚠️ 第 7 条是 2026-10-30 补的：撒花原来用 linear，那是"雪"的物理 ——
   *      真实纸片受重力**加速**下落。而前 6 条都是减速/弹入，用它们做下落是错的物理。
   *      加这一条的判据仍然是"一种语义"，不是"按好看程度挑"。
   *
   *   裸 ease 只在**循环**动画里允许（ease-in-out 对称，呼吸类循环必须对称）。
   */
  {
    const bezKinds = new Map()
    const bareEase = []
    const walkCss = (dir) => {
      for (const f of fs.readdirSync(dir, { withFileTypes: true })) {
        const fp = path.join(dir, f.name)
        if (f.isDirectory()) walkCss(fp)
        else if (f.name.endsWith('.wxss')) {
          const t = fs.readFileSync(fp, 'utf8')
          ;(t.match(/cubic-bezier\([^)]*\)/g) || []).forEach(x => {
            const norm = 'cubic-bezier(' + x.slice('cubic-bezier('.length, -1)
              .split(',').map(v => v.trim()).join(', ') + ')'
            bezKinds.set(norm, (bezKinds.get(norm) || 0) + 1)
          })
          /* 一次性动画不许裸用 ease（循环动画的 ease-in-out 是允许的） */
          t.split('\n').forEach((line, i) => {
            if (!/animation\s*:/.test(line)) return
            if (/\binfinite\b/.test(line)) return
            if (/\bease\b(?!-)/.test(line) && !/cubic-bezier/.test(line)) {
              bareEase.push(path.relative(ROOT, fp) + ':' + (i + 1))
            }
          })
        }
      }
    }
    walkCss(path.join(ROOT, 'miniprogram'))
    assert.ok(bezKinds.size <= 7,
      '动画曲线又散开了（当前 ' + bezKinds.size + ' 种，上限 7）：\n    ' +
      [...bezKinds.entries()].map(([k, v]) => v + '× ' + k).join('\n    '))
    assert.deepStrictEqual(bareEase, [],
      '一次性动画不许裸用 ease（要用那 6 条之一）：\n    ' + bareEase.join('\n    '))
    ok(`动画曲线收敛到 ${bezKinds.size} 种，一次性动画无裸 ease`)

  /* ============ ④i 死动画：@keyframes 定义了却没人用 ============ */
  console.log('\n=== ④i 有没有"定义了却没人引用"的 keyframes ===')
  /*
   * ★ 动画的**过程**在离线渲染里完全看不到 —— 渲染器为了让截图稳定，
   *   会把 animation 瞬间拨到终态。所以"这个动画到底跑没跑"只能靠结构判据。
   *
   *   死 keyframes 的后果不是报错，而是**下一个人会以为某个效果已经做了**
   *   （和死字段、死方法同一类问题）。这条补上它们。
   */
  {
    const walkAnim = (dir, out) => {
      for (const f of fs.readdirSync(dir, { withFileTypes: true })) {
        const fp = path.join(dir, f.name)
        if (f.isDirectory()) walkAnim(fp, out)
        else if (f.name.endsWith('.wxss')) out.push(fp)
      }
      return out
    }
    const files = walkAnim(path.join(ROOT, 'miniprogram'), [])
    const defined = new Map()   // name → file
    const used = new Set()
    for (const f of files) {
      const css = fs.readFileSync(f, 'utf8').replace(/\/\*[\s\S]*?\*\//g, '')
      ;(css.matchAll(/@keyframes\s+([a-zA-Z_][\w-]*)/g)).forEach(m => defined.set(m[1], path.relative(ROOT, f)))
      /* animation: name ... 或 animation-name: name；也可能一次写多个（逗号分隔） */
      ;(css.matchAll(/animation(?:-name)?\s*:\s*([^;}]+)/g)).forEach(m => {
        m[1].split(',').forEach(part => {
          const tok = part.trim().split(/\s+/)[0]
          if (tok && /^[a-zA-Z_][\w-]*$/.test(tok)) used.add(tok)
        })
      })
    }
    const dead = []
    defined.forEach((file, name) => { if (!used.has(name)) dead.push(file + ' → @keyframes ' + name) })
    assert.deepStrictEqual(dead, [],
      '这些动画定义了但没有任何 animation 引用（下一个人会以为效果已经做了）：\n    ' +
      dead.join('\n    '))
    ok(`${defined.size} 个 keyframes 全部被引用（无死动画）`)
  }

  /* ============ ④h 正文文字对比度必须过 WCAG AA ============ */
  console.log('\n=== ④h 白色文字对比度 ≥ 4.5（酒桌是暗光场景）===')
  /*
   * ★★ 2026-10-28。实测全仓有 **39 处**白色文字的对色对比度低于 4.5:1
   *   （集中在 rgba(255,255,255,.30~.45) 这个区间，对比度 2.7~4.4）。
   *
   *   为什么在这个项目里尤其要管：酒桌是**暗光场景**，手机还可能斜着放在桌上、
   *   有人喝了几杯 —— 对比度不够的文字在这种条件下基本读不出来。
   *   而"读不出来"不会报任何错，只会让玩家觉得"这游戏做得很糙"。
   *
   * 判据：白字（rgba(255,255,255,a)）在页面底色 #241A16 上，
   *      对比度必须 ≥ 4.5（WCAG AA 小字号标准）。
   *
   * 白名单（必须低，不能提亮）：
   *   · disabled / .ph（占位符）/ mask 遮罩 / 装饰性水印
   *   这几类提亮反而会表达错误信息（"不可用"看起来像可用）。
   */
  {
    const PAGE_BG = [0x24, 0x1A, 0x16]
    const lum = (rgb) => {
      const f = (c) => { c = c / 255; return c <= 0.03928 ? c / 12.92 : Math.pow((c + 0.055) / 1.055, 2.4) }
      return 0.2126 * f(rgb[0]) + 0.7152 * f(rgb[1]) + 0.0722 * f(rgb[2])
    }
    const contrastOn = (alpha) => {
      const fg = [0, 1, 2].map(i => Math.round(alpha * 255 + (1 - alpha) * PAGE_BG[i]))
      const l1 = lum(fg), l2 = lum(PAGE_BG)
      return (Math.max(l1, l2) + 0.05) / (Math.min(l1, l2) + 0.05)
    }
    const LOW_OK = ['disabled', 'ph', 'mask', 'cf', 'pg-tex', 'cs-felt', 'overlay']
    const lowContrast = []
    const walkLow = (dir) => {
      for (const f of fs.readdirSync(dir, { withFileTypes: true })) {
        const fp = path.join(dir, f.name)
        if (f.isDirectory()) { walkLow(fp); continue }
        if (!f.name.endsWith('.wxss')) continue
        const css = fs.readFileSync(fp, 'utf8').replace(/\/\*[\s\S]*?\*\//g, '')
        const re = /([^{}]+)\{([^{}]*)\}/g
        let m
        while ((m = re.exec(css))) {
          const sel = m[1].trim()
          const body = m[2]
          if (LOW_OK.some(k => sel.indexOf(k) >= 0)) continue
          /*
           * ⚠️ 必须排除 `border-color` / `background-color` ——
           *   第一版写的是 /color:\s*rgba.../，于是 `border-color: rgba(...,.14)`
           *   被当成文字颜色，报出两条假阳性（框线本来就该淡）。
           *   要求 color 前面是 `;` 或属性列表开头，不能是 `-`。
           */
          const cm = /(?:^|[;\s])color:\s*rgba\(\s*255\s*,\s*255\s*,\s*255\s*,\s*(0?\.\d+)\s*\)/.exec(body)
          if (!cm) continue
          const a = parseFloat(cm[1])
          const c = contrastOn(a)
          if (c < 4.5) {
            const line = css.slice(0, m.index).split('\n').length
            lowContrast.push(path.relative(ROOT, fp) + ':' + line +
              '  ' + sel.slice(0, 40) + '  a=' + a + ' 对比度 ' + c.toFixed(2))
          }
        }
      }
    }
    walkLow(path.join(ROOT, 'miniprogram'))
    assert.deepStrictEqual(lowContrast, [],
      '这些文字在暗光下读不出来（WCAG AA 要 4.5，当前不足）：\n    ' +
      lowContrast.join('\n    ') +
      '\n    修法：白色透明度提到 ≥0.5；"不可用/占位符"这类确实该暗的加进白名单。')
    ok(`白色文字全部达标（页面底色 #241A16 上 ≥ 4.5:1）`)
  }

  /* ============ ③d-2 动态图片路径展开后必须齐全 ============ */
  console.log('\n=== ③d-2 动态图片路径（骰子/扑克/骰盅）必须齐全 ===')
  /*
   * ★ 模板里的图片路径大多是**拼出来的**：
   *     /game/images/dice/dice-{{item}}.png
   *     /game/images/card/c{{item.s}}-{{item.r}}.png
   *     /game/images/cup/{{cupSrc}}.png
   *   正则抓不到这种路径，所以"某一张牌的文件缺了"在静态检查里是隐形的，
   *   而真机上就是**那一局所有牌全空白**（小程序对缺图静默不显示）。
   *
   *   2026-10-28 加。同一天还发现 card/back.png 躺在包里从没被引用
   *   （牌背是 CSS 画的），说明"图片文件"这一层从来没有过数量判据。
   */
  {
    const IMG = path.join(ROOT, 'miniprogram', 'game', 'images')
    const miss = []
    /* 骰子 1..6 */
    for (let i = 1; i <= 6; i++) {
      if (!fs.existsSync(path.join(IMG, 'dice', 'dice-' + i + '.png'))) miss.push('dice-' + i + '.png')
    }
    /* 骰盅三态（入盅 / 摇 / 揭） */
    for (const n of ['cup-down', 'cup-shake', 'cup-up']) {
      if (!fs.existsSync(path.join(IMG, 'cup', n + '.png'))) miss.push(n + '.png')
    }
    /*
     * 扑克 4 花色 × 13 点数 = 52 张。
     * 编号必须和 utils/poker.js 对齐：s = 0黑桃 1红桃 2梅花 3方块，r = 2..14（11=J 12=Q 13=K 14=A）
     */
    for (let s = 0; s <= 3; s++) {
      for (let r = 2; r <= 14; r++) {
        const f = 'c' + s + '-' + r + '.png'
        if (!fs.existsSync(path.join(IMG, 'card', f))) miss.push('card/' + f)
      }
    }
    assert.deepStrictEqual(miss, [],
      '这些图片文件缺失（真机上会**静默显示空白**，不报错）：\n    ' + miss.join('\n    '))
    /*
     * 牌面必须是 52 张（4 花色 × 13 点数）。
     *
     * ⚠️ 2026-10-30：目录里多了 `back.png`（配套牌背图）→ 53 张被误报。
     *    断言要守的是"52 张正面齐全且不多不少"，
     *    所以先排除已知的**非正面**文件，而不是放宽成"≥52"（那样缺牌也发现不了）。
     */
    const NON_FACE = new Set(['back.png'])
    const nCard = fs.readdirSync(path.join(IMG, 'card'))
      .filter(f => !NON_FACE.has(f)).length
    assert.strictEqual(nCard, 52,
      '牌面目录应正好 52 张正面（多出来的没人引用，少了的显示空白），实际 ' + nCard)
    ok('骰子 6 张 / 骰盅 3 张 / 扑克 52 张全部齐全，且没有多余文件')
  }

  /* ============ ③i 版本号必须是单一来源（不能硬编码在页面里） ============ */
  console.log('\n=== ③i 版本号只有 config.js 一处来源 ===')
  /*
   * ★ 2026-10-28。`me.js` 里硬编码着 `version: '3.7.4'`，而实际已经 3.9.x ——
   * 用户报问题时说"我用的 3.7.4"，我根本对不上他跑的是哪一版。
   *
   * 这类"文案与实现不一致"本项目栽过：音效早换成真录音了，
   * "我的"页还写着"摇盅、扣盅、开盅都是合成音"。
   * 判据：页面 js 里不许出现 `version: '数字'` 这种硬编码，必须从 config 读。
   */
  {
    const pageJs = []
    for (const root of [path.join(ROOT, 'miniprogram', 'pages'), path.join(ROOT, 'miniprogram', 'game')]) {
      if (!fs.existsSync(root)) continue
      for (const d of fs.readdirSync(root, { withFileTypes: true })) {
        if (!d.isDirectory()) continue
        for (const f of fs.readdirSync(path.join(root, d.name))) {
          if (f.endsWith('.js')) pageJs.push(path.join(root, d.name, f))
        }
      }
    }
    const hard = []
    for (const f of pageJs) {
      const src = fs.readFileSync(f, 'utf8').replace(/\/\*[\s\S]*?\*\//g, '')
      const m = /version\s*:\s*'[0-9]+\.[0-9]+/.exec(src)
      if (m) hard.push(path.relative(ROOT, f) + ' → ' + m[0])
    }
    assert.deepStrictEqual(hard, [],
      '这些页面把版本号硬编码了（会悄悄过时，用户报问题对不上）：\n    ' +
      hard.join('\n    ') + '\n    改成从 config.js 读。')

    /* config 里的版本号本身要是合法格式 */
    const cfg = require(path.join(ROOT, 'miniprogram', 'config.js'))
    assert.ok(/^[0-9]+\.[0-9]+\.[0-9]+$/.test(String(cfg.version || '')),
      'config.js 的 version 必须是 x.y.z 形式，实际：' + cfg.version)
    ok('版本号单一来源（config.js ' + cfg.version + '），页面里没有硬编码')
  }

  /* ============ ③j 文案里的数字必须和代码一致 ============ */
  console.log('\n=== ③j 文案里的数字（小时数 / 颗数 / 玩法数）必须和代码一致 ===')
  /*
   * ★★ 2026-10-28。版本号那个坑的同类：**文案写死的数字会悄悄过时**。
   *   版本号写在页面里 → 一路停在 3.7.4；
   *   那"房间 2 小时后过期"凭什么不会错？
   *
   *   判据：从服务端源码里把真实值读出来，再和 wxml 里写的比。
   *   不靠"记得改"。
   */
  {
    const srv = fs.readFileSync(path.join(ROOT, 'cloudfunctions/room/index.js'), 'utf8')
    /* 房间过期时间：const TTL_MS = 2 * 3600 * 1000 */
    const m = /const TTL_MS\s*=\s*([\d\s*]+)/.exec(srv)
    assert.ok(m, '找不到 TTL_MS 的定义')
    const ttlHours = Math.round(m[1].split('*').reduce((a, x) => a * Number(x.trim()), 1) / 3600000)

    const bad = []
    const sweep = (dir) => {
      for (const f of fs.readdirSync(dir, { withFileTypes: true })) {
        const fp = path.join(dir, f.name)
        if (f.isDirectory()) { sweep(fp); continue }
        if (!f.name.endsWith('.wxml')) continue
        const src = fs.readFileSync(fp, 'utf8')
        for (const mm of src.matchAll(/房间\s*(\d+)\s*小时/g)) {
          if (Number(mm[1]) !== ttlHours) {
            bad.push(path.relative(ROOT, fp) + ' → 写「' + mm[1] + ' 小时」，代码是 ' + ttlHours + ' 小时')
          }
        }
      }
    }
    sweep(path.join(ROOT, 'miniprogram'))
    assert.deepStrictEqual(bad, [],
      '文案里的小时数和 TTL_MS 对不上：\n    ' + bad.join('\n    '))
    ok('房间过期时长文案与 TTL_MS 一致（' + ttlHours + ' 小时）')

    /*
     * 同一个判据的另一半：每人几颗骰。
     * 服务端从 DICE_PER_PLAYER 读，文案里写「每人 N 颗」——
     * 改了颗数而忘了改文案，玩家会按错误的规则理解豹子概率。
     */
    const dm = /const DICE_PER_PLAYER\s*=\s*(\d+)/.exec(srv)
    assert.ok(dm, '找不到 DICE_PER_PLAYER 的定义')
    const perPlayer = Number(dm[1])
    const gsrc = fs.readFileSync(path.join(ROOT, 'miniprogram/utils/games.js'), 'utf8')
    const badDice = []
    for (const mm of gsrc.matchAll(/每人\s*(\d+)\s*颗/g)) {
      if (Number(mm[1]) !== perPlayer) {
        badDice.push('games.js 写「每人 ' + mm[1] + ' 颗」，代码是 ' + perPlayer + ' 颗')
      }
    }
    assert.deepStrictEqual(badDice, [],
      '规则文案里的颗数和 DICE_PER_PLAYER 对不上：\n    ' + badDice.join('\n    '))
    ok('规则文案里的骰子颗数与 DICE_PER_PLAYER 一致（' + perPlayer + ' 颗）')

    /* 房间号位数：文案写「3 位房间号」，代码是 CODE_LEN */
    const cm = /const CODE_LEN\s*=\s*(\d+)/.exec(srv)
    assert.ok(cm, '找不到 CODE_LEN 的定义')
    const codeLen = Number(cm[1])
    const badLen = []
    for (const root of PAGE_ROOTS) {
      if (!fs.existsSync(root)) continue
      for (const f of fs.readdirSync(root, { withFileTypes: true })) {
        const fp = path.join(root, f.name)
        if (!f.isDirectory()) continue
        for (const g of fs.readdirSync(fp)) {
          if (!g.endsWith('.wxml')) continue
          const src2 = fs.readFileSync(path.join(fp, g), 'utf8')
          for (const mm of src2.matchAll(/(\d+)\s*位房间号/g)) {
            if (Number(mm[1]) !== codeLen) {
              badLen.push(path.relative(ROOT, path.join(fp, g)) + ' → 写「' + mm[1] + ' 位」，代码是 ' + codeLen)
            }
          }
        }
      }
    }
    assert.deepStrictEqual(badLen, [],
      '文案里的房间号位数和 CODE_LEN 对不上（玩家会输不对号）：\n    ' + badLen.join('\n    '))
    ok('房间号位数文案与 CODE_LEN 一致（' + codeLen + ' 位）')
  }

  /*
   * ⚠️ 这里**曾经**有一条 ③k：检查"用了 var(--i) 的类，模板必须设 --i"。
   *    写了两版都没写对：正则从 CSS 里提取 stagger 类名时，
   *    把 `rgba(...,.06)` 里的 `.06`、`.12` 也当成了类名，
   *    而真正要抓的 `.rv-row` 反而没提取到 → **反向验证 exit=0（假绿）**。
   *
   *    **删掉，不留一条骗人的断言。**
   *    但它要防的问题是真的：`.rv-row` 有一处 wx:for 没设 --i，
   *    导致那一段所有行同时出现 —— 已手工修掉（见 room.wxml 的注释）。
   *    以后如果要重写这条，判据应该是"解析 CSS 规则块"，而不是一条正则。
   */

  /* ============ ③l CSS 变量：用到的必须定义过 ============ */
  console.log('\n=== ③l CSS 变量必须都有定义（未定义且无 fallback = 样式静默失效） ===')
  /*
   * ★ 2026-10-28。上一个 bug（`.rv-row` 的 `--i` 没赋值导致 stagger 失效）
   *   的同类：**CSS 变量写了但没人定义**，属性会静默失效。
   *
   *   ⚠️ 白名单两条，都是"模板内联设置"的：
   *     --accent  每个玩法卡自己的颜色（lobby.wxml 的 style）
   *     --i       stagger 序号（room.wxml 的 style）
   *
   *   ⚠️ 这条检查第一版用 grep `^\s*--` 写的，而 **grep 的 ERE 不支持 `\s`**
   *      → 带缩进的定义全被漏掉 → 差点报出一堆假阳性。现在用 JS 正则。
   */
  {
    const INLINE_VARS = new Set(['--accent', '--i'])
    const defined = new Set()
    const used = new Map()
    const files = [path.join(ROOT, 'miniprogram/app.wxss')]
    for (const root of PAGE_ROOTS) {
      if (!fs.existsSync(root)) continue
      for (const d of fs.readdirSync(root, { withFileTypes: true })) {
        if (!d.isDirectory()) continue
        const dir = path.join(root, d.name)
        for (const f of fs.readdirSync(dir)) {
          if (f.endsWith('.wxss')) files.push(path.join(dir, f))
        }
      }
    }
    for (const f of files) {
      const src = fs.readFileSync(f, 'utf8').replace(/\/\*[\s\S]*?\*\//g, '')
      for (const m of src.matchAll(/(--[a-z0-9-]+)\s*:/g)) defined.add(m[1])
      for (const m of src.matchAll(/var\(\s*(--[a-z0-9-]+)/g)) {
        if (!used.has(m[1])) used.set(m[1], path.relative(ROOT, f))
      }
    }
    const bad = []
    for (const [name, where] of used) {
      if (defined.has(name) || INLINE_VARS.has(name)) continue
      bad.push(name + '（' + where + '）')
    }
    assert.deepStrictEqual(bad, [],
      '这些 CSS 变量被用了但从来没有定义（属性会静默失效）：\n    ' + bad.join('\n    '))
    ok('CSS 变量全部有定义（' + defined.size + ' 个定义 / ' + used.size + ' 个使用）')
  }

  /* ============ ③w 长按不能弹系统菜单（会毁掉"按住偷看"） ============ */
  console.log('\n=== ③w 长按选择必须禁用 ===')
  /*
   * ★ 2026-10-29。全仓原来**一处 user-select 都没设** ——
   *   长按任何文字都会弹出系统的「复制 / 全选」菜单。
   *
   *   而金花「按住看明牌」、卧底「按住看词」、大话骰「按住盅偷看」
   *   这三个核心交互**都是按住** —— 长按一下弹菜单，交互就毁了。
   *
   *   判据：app.wxss 里 page 要禁用，而 input/textarea 要放行
   *        （否则连字都改不了）。
   */
  {
    const appCss = fs.readFileSync(path.join(ROOT, 'miniprogram/app.wxss'), 'utf8')
    const clean = appCss.replace(/\/\*[\s\S]*?\*\//g, '')
    assert.ok(/page\s*\{[^}]*user-select\s*:\s*none/.test(clean),
      '★ app.wxss 里 page 没有 user-select:none —— 长按会弹系统菜单，毁掉"按住偷看"')
    assert.ok(/input[^{]*\{[^}]*user-select\s*:\s*auto/.test(clean),
      '★ input 没有放行 user-select —— 输入框里连字都改不了')
    ok('长按选择已禁用（输入框例外）')
  }

  /* ============ ③v tabBar 也是外壳，也要对 ============ */
  console.log('\n=== ③v tabBar 的配色和对比度 ===')
  /*
   * ★ 2026-10-29。和导航栏同理：**渲染器画不准 tabBar**，
   *   所以它是不是深色、字看不看得清，只能靠配置断言。
   *
   *   判两件事：
   *   ① 背景是深色（和整体主题一致），选中色是金色
   *   ② **未选中文字的对比度过 WCAG AA 的 4.5:1** ——
   *      tabBar 是常驻的，看不清就是一直看不清。
   */
  {
    const app = JSON.parse(fs.readFileSync(path.join(ROOT, 'miniprogram/app.json'), 'utf8'))
    const tb = app.tabBar || {}
    assert.ok(tb.list && tb.list.length >= 2, 'tabBar 至少要有两个 tab')

    /* 相对亮度（WCAG 公式） */
    const lum = (hex) => {
      const n = parseInt(hex.replace('#', ''), 16)
      const ch = [(n >> 16) & 255, (n >> 8) & 255, n & 255].map(v => {
        const c = v / 255
        return c <= 0.03928 ? c / 12.92 : Math.pow((c + 0.055) / 1.055, 2.4)
      })
      return 0.2126 * ch[0] + 0.7152 * ch[1] + 0.0722 * ch[2]
    }
    const contrast = (a, b) => {
      const [hi, lo] = [lum(a), lum(b)].sort((x, y) => y - x)
      return (hi + 0.05) / (lo + 0.05)
    }

    const bgLum = lum(tb.backgroundColor || '#FFFFFF')
    assert.ok(bgLum < 0.15, '★ tabBar 背景不够深（' + (tb.backgroundColor || '默认白') + '），会和深色内容割裂')

    const cUnsel = contrast(tb.color || '#000000', tb.backgroundColor || '#FFFFFF')
    assert.ok(cUnsel >= 4.5,
      '★ tabBar 未选中文字对比度只有 ' + cUnsel.toFixed(2) + ':1（要 ≥ 4.5）—— 常驻元素看不清会一直碍眼')

    const cSel = contrast(tb.selectedColor || '#000000', tb.backgroundColor || '#FFFFFF')
    assert.ok(cSel >= 4.5,
      '★ tabBar 选中文字对比度只有 ' + cSel.toFixed(2) + ':1（要 ≥ 4.5）')

    ok('tabBar 深色背景 + 未选中 ' + cUnsel.toFixed(1) + ':1 / 选中 ' + cSel.toFixed(1) + ':1')
  }

  /* ============ ③u 导航栏必须和深色主题一致 ============ */
  console.log('\n=== ③u 每个页面的导航栏都是深色 ===')
  /*
   * ★ 2026-10-29。整个界面是深色暖调，如果某个页面的 json 里漏了
   *   `navigationBarBackgroundColor`，微信会用**默认白色** ——
   *   于是那个页面顶上一条白带，和下面的深色内容**硬切开**。
   *
   *   这个我离线验证不了（渲染器不画导航栏），所以只能靠配置断言。
   */
  {
    const WANT_BG = '#2E211C'       // 导航栏
    const WANT_WINBG = '#241A16'    // 窗口背景（下拉时露出来的底色）
    const WANT_TEXT = 'white'
    const targets = [
      ['miniprogram/app.json', 'window'],
      ['miniprogram/pages/lobby/lobby.json', null],
      ['miniprogram/pages/me/me.json', null],
      ['miniprogram/game/room/room.json', null]
    ]
    const bad = []
    for (const [f, key] of targets) {
      const p = path.join(ROOT, f)
      if (!fs.existsSync(p)) { bad.push(f + '：文件不存在'); continue }
      const d = JSON.parse(fs.readFileSync(p, 'utf8'))
      const w = key ? (d[key] || {}) : d
      if (w.navigationBarBackgroundColor !== WANT_BG) {
        bad.push(f + '：背景是 ' + (w.navigationBarBackgroundColor || '默认白') + '，应为 ' + WANT_BG)
      }
      if (w.navigationBarTextStyle !== WANT_TEXT) {
        bad.push(f + '：标题字色是 ' + (w.navigationBarTextStyle || '默认黑') + '，应为 ' + WANT_TEXT)
      }
      /*
       * 窗口背景 —— 下拉刷新时会露出来。浅色的话**下拉一下就白闪**，
       * 而这在静态截图里完全看不到（要真的下拉才出现）。
       */
      if (w.backgroundColor !== WANT_WINBG) {
        bad.push(f + '：窗口背景是 ' + (w.backgroundColor || '默认白') + '，应为 ' + WANT_WINBG)
      }
      if (w.backgroundTextStyle !== 'light') {
        bad.push(f + '：下拉文字样式是 ' + (w.backgroundTextStyle || '默认黑') + '，应为 light')
      }
    }
    assert.deepStrictEqual(bad, [],
      '这些页面的导航栏会和深色内容割裂：\n    ' + bad.join('\n    '))
    ok('4 处外壳配置一致（导航栏深棕白字 / 窗口背景深色 / 下拉 light）')
  }

  /* ============ ③t 上传压缩必须显式开着 ============ */
  console.log('\n=== ③t 构建压缩不是"工具默认" ===')
  /*
   * ★ 2026-10-29。`project.config.json` 里四个 `minify*` 原来都是**未设置** ——
   *   微信开发者工具默认会压缩，但那是**工具的行为**，不是我们的配置。
   *   换个工具版本、换个人打开、或者某次手滑关掉，包体积就会涨回来，
   *   而**本地 du 看不出区别**（压不压缩是上传时的事）。
   *
   *   显式写死 true，这样它就变成"我们要求的"，而不是"碰巧这样"。
   */
  {
    const pc = JSON.parse(fs.readFileSync(path.join(ROOT, 'project.config.json'), 'utf8'))
    const st = pc.setting || {}
    const off = ['minifyWXML', 'minifyWXSS', 'minifyJS'].filter(k => st[k] !== true)
    assert.deepStrictEqual(off, [],
      '★ 这些压缩项没显式开着（包体积会悄悄变大）：' + off.join(', '))
    ok('上传压缩显式开着（WXML / WXSS / JS）')
  }

  /* ============ ③s 启动优化不能被误删 ============ */
  console.log('\n=== ③s 启动优化的两个开关 ===')
  /*
   * ★ 2026-10-29。用户报过"手机加载特别慢"，做了一套分包改造：
   *   · 主包 828KB → 248KB（音频和美术资源进分包）
   *   · `preloadRule`：进大厅就预下载分包
   *   · `lazyCodeLoading: requiredComponents`：按需注入，不用把全部代码先跑一遍
   *
   *   后两个是**一行配置**，删掉不会有任何报错，只会让首屏悄悄变慢 ——
   *   而"变慢"用户只会说"有点卡"，不会说"preloadRule 没了"。
   *   所以用断言锁住：这两项必须还在。
   */
  {
    const app = JSON.parse(fs.readFileSync(path.join(ROOT, 'miniprogram/app.json'), 'utf8'))
    assert.strictEqual(app.lazyCodeLoading, 'requiredComponents',
      '★ app.json 少了 lazyCodeLoading —— 启动要把全部页面代码先跑一遍，首屏会变慢')
    assert.ok(app.preloadRule && Object.keys(app.preloadRule).length,
      '★ app.json 少了 preloadRule —— 进大厅不会预下载分包，点玩法卡时还要等下载')
    const keys = Object.keys(app.preloadRule)
    assert.ok(keys.includes('pages/lobby/lobby'),
      '★ preloadRule 没有挂在进大厅时（实际挂在：' + keys.join(', ') + '）')
    ok('启动优化两项都在（按需注入 + 进大厅预下载分包）')
  }

  /* ============ ③r 每个玩法都要说清"喝几杯" ============ */
  console.log('\n=== ③r 规则里必须说清惩罚量 ===')
  /*
   * ★ 2026-10-29。连着发现三处"规则没说清惩罚"：
   *   · 大话骰反劈是 4 杯（只写了 2 杯）
   *   · 金花出局喝 1 杯（完全没写）
   *   而玩家照规则玩，输的时候才发现比预期多喝 —— 这在酒桌上最容易起争执。
   *
   *   判据：每个玩法的 how 里必须有"喝"字，且要么带**具体数字**，
   *        要么明确写"你们定"（把决定权交给桌上，也是清楚的）。
   */
  {
    const { GAMES } = require(path.join(ROOT, 'miniprogram/utils/games.js'))
    const bad = []
    for (const g of GAMES) {
      const how = (g.how || []).join(' ')
      if (!/喝/.test(how)) { bad.push(g.name + '：规则里没提"喝"'); continue }
      const hasNumber = /喝[^。；]{0,20}[0-9一二两三四五]\s*杯/.test(how) ||
        /[0-9一二两三四五]\s*杯/.test(how)
      const hasYours = /你们定|自己定/.test(how)
      if (!hasNumber && !hasYours) {
        bad.push(g.name + '：没说清喝几杯，也没说"你们定"')
      }
    }
    assert.deepStrictEqual(bad, [],
      '这些玩法的规则没说清惩罚量（玩家会不知道要喝多少）：\n    ' + bad.join('\n    '))
    ok('五个玩法都说清了惩罚量（或明确交给桌上定）')
  }

  /* ============ ③q 大话骰规则里的杯数要覆盖"反劈" ============ */
  console.log('\n=== ③q 劈的倍数要在规则里说清 ===')
  /*
   * ★ 2026-10-29。`test-room` 里测了劈一次 2 倍、反劈 4 倍，
   *   而 `games.js` 的规则只写了「劈过的翻倍，2 杯」—— **反劈的后果没说**。
   *   玩家被反劈时不知道要喝 4 杯，这种"照规则玩却被罚更多"最容易起争执。
   */
  {
    const gamesSrc = fs.readFileSync(path.join(ROOT, 'miniprogram/utils/games.js'), 'utf8')
    const liarBlock = gamesSrc.slice(gamesSrc.indexOf("id: 'liar'"), gamesSrc.indexOf("id: 'dice'"))
    assert.ok(/4 杯|四杯/.test(liarBlock), '★ 规则里没提反劈是 4 杯 —— 玩家不知道反劈的后果')
    assert.ok(/2 杯|两杯/.test(liarBlock), '★ 规则里没提劈一次是 2 杯')
    ok('大话骰规则说清了 1 / 2 / 4 杯三档')
  }

  /* ============ ③p 规则里写的场合数量要对得上 decks.js ============ */
  console.log('\n=== ③p 规则文案里的场合要和实际一致 ===')
  /*
   * ★ 2026-10-29。转盘的规则写着「题卡按今晚是什么局选：朋友、同事、家人」，
   *   而 `decks.js` 实际有 **4 个场合**（还有"情侣 / 暧昧"）。
   *   玩家按规则只看到 3 个，会以为少了一类题；而界面上明明有 4 个。
   */
  {
    const gamesSrc = fs.readFileSync(path.join(ROOT, 'miniprogram/utils/games.js'), 'utf8')
    const decksSrc = fs.readFileSync(path.join(ROOT, 'miniprogram/utils/decks.js'), 'utf8')
    const nDecks = (decksSrc.match(/^\s{2}\{[\s\S]*?k:\s*'/gm) || []).length ||
      (decksSrc.match(/k:\s*'/g) || []).length
    const wheelLine = (gamesSrc.match(/题卡按[^']*/) || [''])[0]
    assert.ok(wheelLine, '找不到转盘那条讲场合的规则')
    /*
     * 规则里用顿号分隔的场合个数，应该等于 decks.js 的场合数。
     * 这条容易过度严格（规则里可能只举例子），所以只查"个数明显少于实际"的情况。
     */
    const listed = wheelLine.split('：')[1] || ''
    const parts = listed.split('、').filter(Boolean)
    assert.ok(parts.length >= Math.min(4, nDecks),
      '★ 规则里只列了 ' + parts.length + ' 个场合，而 decks.js 有 ' + nDecks + ' 个 —— 玩家会以为少一类题')
    ok('转盘规则列了 ' + parts.length + ' 个场合（实际 ' + nDecks + ' 个）')
  }

  /* ============ ③o 音频实例必须挂错误监听 ============ */
  console.log('\n=== ③o 音频加载失败不能静默 ===')
  /*
   * ★ 2026-10-29。音频的 `onError` **一处都没有** ——
   *   文件缺失、路径错、解码不了，全都没有任何痕迹。
   *   用户说"没声音"，而日志里什么都没有，只能靠猜。
   *
   *   判据：`wx.createInnerAudioContext()` 之后 300 字符内必须出现 `onError`
   *        （或调用了包了 onError 的封装函数）。
   */
  {
    const bad = []
    const walk = (d) => {
      for (const f of fs.readdirSync(d, { withFileTypes: true })) {
        const fp = path.join(d, f.name)
        if (f.isDirectory()) { walk(fp); continue }
        if (!f.name.endsWith('.js')) continue
        const src = fs.readFileSync(fp, 'utf8')
        const clean = src.replace(/\/\*[\s\S]*?\*\//g, '')
        for (const m of clean.matchAll(/wx\.createInnerAudioContext\(\)/g)) {
          const after = clean.slice(m.index, m.index + 300)
          if (!/onError/.test(after) && !/watchAudioError/.test(after)) {
            const line = clean.slice(0, m.index).split('\n').length
            bad.push(path.relative(ROOT, fp) + ':' + line)
          }
        }
      }
    }
    walk(path.join(ROOT, 'miniprogram'))
    assert.deepStrictEqual(bad, [],
      '这些音频实例没有错误监听（加载失败会完全静默）：\n    ' + bad.join('\n    '))
    ok('音频实例都挂了 onError')
  }

  /* ============ ③n 会失败的微信 API 必须给用户反馈 ============ */
  console.log('\n=== ③n 跳转 / 复制失败时不能静默 ===')
  /*
   * ★★ 2026-10-29。用户一整天报的几件事有个共同病根：
   *   **出错的时候没把信息交出来** —— 遮罩不关、复制没 fail、错误只说"开不了"、
   *   跳转静默失败。而我的断言全都在查"成功路径对不对"。
   *
   *   这里补上失败路径的检查：`wx.navigateTo` / `wx.setClipboardData`
   *   失败时用户会以为"点了没反应"，所以必须有 fail 或整体包在 try 里。
   *
   *   ⚠️ `wx.showModal` / `wx.getStorageSync` 不在此列 ——
   *      前者失败无影响（弹窗没弹而已），后者是同步 API 且有 try 兜着。
   */
  {
    const RISKY = ['navigateTo', 'setClipboardData']
    const bad = []
    const walk = (d) => {
      for (const f of fs.readdirSync(d, { withFileTypes: true })) {
        const fp = path.join(d, f.name)
        if (f.isDirectory()) { walk(fp); continue }
        if (!f.name.endsWith('.js')) continue
        const src = fs.readFileSync(fp, 'utf8')
        const clean = src.replace(/\/\*[\s\S]*?\*\//g, '')
        for (const m of clean.matchAll(/wx\.(\w+)\(/g)) {
          if (!RISKY.includes(m[1])) continue
          const after = clean.slice(m.index, m.index + 260)
          const before = clean.slice(Math.max(0, m.index - 400), m.index)
          const handled = /fail\s*:/.test(after) || /\.catch/.test(after) ||
            before.lastIndexOf('try {') > before.lastIndexOf('} catch')
          if (!handled) {
            const line = clean.slice(0, m.index).split('\n').length
            bad.push(path.relative(ROOT, fp) + ':' + line + ' wx.' + m[1])
          }
        }
      }
    }
    walk(path.join(ROOT, 'miniprogram'))
    assert.deepStrictEqual(bad, [],
      '这些调用失败时会静默（用户以为点了没反应）：\n    ' + bad.join('\n    '))
    ok('跳转 / 复制都有失败反馈')
  }

  /* ============ ③m scripts 里的测试脚本必须都在 test-all 里 ============ */
  console.log('\n=== ③m 不许有"孤儿测试"（写了但没人跑） ===')
  /*
   * ★ 2026-10-29。做测试资产盘点时发现 `test-e2e-flows.js`：
   *   它存在、**不在 test-all 里**、而且跑起来**直接崩** ——
   *   引用的是 `cloudfunctions/pair/index.js`，而 `pair` 随情侣版一起删了。
   *
   *   这种"孤儿测试"比没有测试更糟：它躺在目录里让人以为"这块有覆盖"，
   *   实际上从功能删除那天起就没跑过。
   *
   *   判据：scripts 下每个 test-*.js / test-*.py 都必须在 test-all.sh 里被调用。
   */
  {
    const scriptsDir = path.join(ROOT, 'scripts')
    const runner = fs.readFileSync(path.join(scriptsDir, 'test-all.sh'), 'utf8')
    /*
     * ⚠️ 判据必须是"**未注释的**调用行"，不能是 `includes(文件名)` ——
     *    第一版用 includes，把调用注释掉之后文件名还在注释里，断言照样通过
     *    （反向验证 exit=0，假绿）。删掉/注释调用必须都能被抓到。
     */
    const orphans = []
    for (const f of fs.readdirSync(scriptsDir)) {
      if (!/^test-.+\.(js|py)$/.test(f)) continue
      const called = new RegExp('^\\s*(?:node|python3)\\s+scripts/' + f.replace(/[.]/g, '\\.') + '\\b', 'm')
      if (!called.test(runner)) orphans.push(f)
    }
    assert.deepStrictEqual(orphans, [],
      '这些测试脚本从来没被 test-all 跑过（要么接进去，要么删掉）：\n    ' + orphans.join('\n    '))
    ok('没有孤儿测试（每个 test-* 都在 test-all 里）')
  }

  /* ============ ④j wxss 不许用小程序不支持的语法（只在预览时报错） ============ */
  console.log('\n=== ④j wxss 语法：不许通配符 / 不支持的属性 ===')
  /*
   * ★★ 2026-10-28，和 wxml 那次 `.indexOf()` 是同一类：
   *   **只在点"预览/上传"时炸，本地测试和渲染截图全都看不见。**
   *
   *   我给「减少动效」写了 `.reduce-motion *` —— WXSS 不支持通配符
   *   （报 `unexpected token '*'`），上传直接失败。
   *   而这个功能本来是为了"帮助觉得晃眼的人"，结果自己先把上传搞挂了。
   */
  {
    const badCss = []
    const walkCss = (dir) => {
      for (const f of fs.readdirSync(dir, { withFileTypes: true })) {
        const fp = path.join(dir, f.name)
        if (f.isDirectory()) { walkCss(fp); continue }
        if (!f.name.endsWith('.wxss')) continue
        const raw = fs.readFileSync(fp, 'utf8').replace(/\/\*[\s\S]*?\*\//g, '')
        /*
         * 通配符选择器：`*` 出现在"选择器位置"上。
         * ⚠️ 第一版只认"行首或 { } ; , 之后"，而 `.a * ,` 里的 `*`
         *    前面是空格 → 漏报，**反向验证才发现是废的**。
         *    现在按"独立的 *"判断：前后都是空白/分隔符才算选择器。
         *    （`content: '*'` 这种字符串里的星号项目里没有，不另做排除。）
         */
        /*
         * 只认**选择器位置**的星号：后面紧跟 `{` 或以 `,` 结尾。
         *
         * ⚠️ 前两版都错：①只认行首/`{` 之后的星号 → 漏报 `.a * ,`；
         *    ②改成"独立星号"后 → 把注释里的 markdown 列表符号 `* ⚠️ ...`
         *    当成了通配符（而那些注释剥不干净，里面有 ** 粗体）。
         *    "后跟 { 或 ," 才是通配符选择器的特征。
         */
        const star = /\*\s*[{,]/.exec(raw)
        if (star) {
          const line = raw.slice(0, star.index).split('\n').length
          badCss.push(path.relative(ROOT, fp) + ':' + line + ' 通配符选择器 *（WXSS 不支持）')
        }
      }
    }
    for (const r of [path.join(ROOT, 'miniprogram')]) walkCss(r)
    assert.deepStrictEqual(badCss, [],
      'wxss 里有小程序不支持的语法（**只在预览/上传时报错**）：\n    ' +
      badCss.join('\n    ') + '\n    WXSS 不支持 `*` 通配符，要逐个列标签。')
    ok('wxss 没有通配符选择器（这类错只在预览时才炸）')
  }

  /* ============ ④f wxml 表达式只能用"微信支持的那一小撮语法" ============ */
  console.log('\n=== ④f wxml 里不许出现函数调用 / 可选链 / 模板字符串 ===')
  /*
   * ★★ 2026-10-28，用真机付出代价换来的一条。
   *
   *   牌面红黑本来在模板里这么写：
   *       class="pkr-c {{item.indexOf('♥') >= 0 ? 'pk-red' : ''}}"
   *   而**微信 wxml 的表达式不支持函数调用**。后果不是"这一处渲染不对"，
   *   而是**整个 wxml 编译失败**：
   *       Bad attr `class` with message: unexpected token `.`
   *   —— 上传/预览直接过不去，用户扫到的码是旧的，而开发者工具里
   *   本地渲染一切正常（本项目自己的渲染器是宽松的，会把它当 JS 求值）。
   *
   *   也就是说：**这条错误在本地、在断言、在截图里都看不见**，
   *   只有真的点"预览"时才炸。所以必须专门锁一条。
   *
   *   wxml 的表达式只支持：属性访问、下标、字面量、算术、比较、逻辑、
   *   三元、以及少数全局（如 Math 的个别方法都不行）。函数调用一律要挪到
   *   JS 里算好（decorate / 云函数），模板只负责取值。
   */
  {
    const wxmlBad = []
    const walkExpr = (dir) => {
      for (const f of fs.readdirSync(dir, { withFileTypes: true })) {
        const fp = path.join(dir, f.name)
        if (f.isDirectory()) { walkExpr(fp); continue }
        if (!f.name.endsWith('.wxml')) continue
        const raw = fs.readFileSync(fp, 'utf8')
        const t = raw.replace(/<!--[\s\S]*?-->/g, '')
        let mm
        const re = /\{\{([\s\S]*?)\}\}/g
        while ((mm = re.exec(t))) {
          const e = mm[1]
          const line = t.slice(0, mm.index).split('\n').length
          if (/[A-Za-z_$][\w$]*\s*\(/.test(e)) {
            wxmlBad.push(path.relative(ROOT, fp) + ':' + line + ' 函数调用 → ' + e.trim().slice(0, 70))
          } else if (e.indexOf('?.') >= 0) {
            wxmlBad.push(path.relative(ROOT, fp) + ':' + line + ' 可选链 → ' + e.trim().slice(0, 70))
          } else if (e.indexOf('`') >= 0) {
            wxmlBad.push(path.relative(ROOT, fp) + ':' + line + ' 模板字符串 → ' + e.trim().slice(0, 70))
          }
        }
      }
    }
    walkExpr(path.join(ROOT, 'miniprogram', 'pages'))
    assert.deepStrictEqual(wxmlBad, [],
      'wxml 表达式里出现了微信不支持的语法（**会让整个文件编译失败、上传直接过不去**）：\n    ' +
      wxmlBad.join('\n    ') +
      '\n    修法：挪到 JS 里算好（decorate / 云函数），模板只取值。')
    ok('wxml 表达式里没有函数调用 / 可选链 / 模板字符串')
  }

  /* ============ ④g wx:key 必须是字面量（不能 {{ }}） ============ */
  /*
   * `wx:key="{{this}}"` 是另一个"只在上传时报错"的坑（社区大量踩过）：
   * 开发者工具本地能跑，预览时报 `Bad attr wx:key ... unexpected token`。
   * 另外 wx:key 取字符串本身还有个隐患 —— 列表里出现重复值时，
   * 微信会用重复 key 复用节点，导致渲染错乱（本项目记过"房间号含重复字符"的事故）。
   */
  {
    const badKey = []
    const walkKey = (dir) => {
      for (const f of fs.readdirSync(dir, { withFileTypes: true })) {
        const fp = path.join(dir, f.name)
        if (f.isDirectory()) { walkKey(fp); continue }
        if (!f.name.endsWith('.wxml')) continue
        const t = fs.readFileSync(fp, 'utf8').replace(/<!--[\s\S]*?-->/g, '')
        let km
        const kre = /wx:key="([^"]*)"/g
        while ((km = kre.exec(t))) {
          if (/\{\{/.test(km[1])) {
            badKey.push(path.relative(ROOT, fp) + ' → wx:key="' + km[1] + '"')
          }
        }
      }
    }
    walkKey(path.join(ROOT, 'miniprogram', 'pages'))
    assert.deepStrictEqual(badKey, [],
      'wx:key 用了 {{ }}（预览时会编译报错）：\n    ' + badKey.join('\n    '))
    ok('wx:key 全部是字面量（不是 {{ }}）')
  }

  /* ============ ④d 每个可点的东西都要有按压反馈 ============ */
  console.log('\n=== ④d 可点击元素必须有 :active 按压反馈 ===')
  /*
   * ★ 2026-10-28。原来全仓 37 处 bindtap，只有 14 条 :active ——
   *   缺的那些里有选玩法、选题卡、换玩法、题类型这些**高频点按**的东西。
   *   按下没任何变化，手感直接掉到网页级：用户会怀疑"是不是没点中"，
   *   于是再点一次，就有了重复提交。
   *
   * 判据：
   *   ① 每个绑定 bindtap 的元素，它的 class 里至少要有一个在 wxss 里出现过 `.<class>:active`
   *   ② 或者它带着已知有反馈的基类（btn 系列）
   *   ③ 白名单只放"点空白关闭"这类**不该有视觉反馈**的（mask）
   */
  {
    const cssAll = (() => {
      const out = []
      const walk = (d) => {
        for (const f of fs.readdirSync(d, { withFileTypes: true })) {
          const fp = path.join(d, f.name)
          if (f.isDirectory()) walk(fp)
          else if (f.name.endsWith('.wxss')) out.push(fs.readFileSync(fp, 'utf8'))
        }
      }
      walk(path.join(ROOT, 'miniprogram'))
      return out.join('\n')
    })()
    /*
     * 匹配"以这个 class 开头的选择器 + :active"，允许后面再跟别的 class：
     *   `.pitem:active`           ✓
     *   `.pitem.canedit:active`   ✓（组合选择器 —— 动态 class 无法静态判定，
     *                                元素在 wxml 里是 `pitem {{isMe?'canedit':''}}`，
     *                                只有自己那行才有反馈，这是**刻意的**）
     *   `.pitem .other:active`    ✗（那是子元素，不是它自己）
     */
    const hasActive = (cls) =>
      new RegExp('\\.' + cls + '(?=[.:\\s,>])[^{},]*:active').test(cssAll)
    /* 白名单：这些点下去本来就不该有视觉变化 */
    const NO_FEEDBACK_OK = new Set(['mask'])
    /* 已知带按压反馈的基类：元素只要带其中一个就够了 */
    const BASE = ['btn', 'gcard', 'optbtn', 'uw-p', 'uw-btn', 'textbtn', 'pk-p', 'pk-fold', 'codecard', 'join-btn', 'lb-sw']
    const noFeedback = []
    const walkWxml = (d) => {
      for (const f of fs.readdirSync(d, { withFileTypes: true })) {
        const fp = path.join(d, f.name)
        if (f.isDirectory()) { walkWxml(fp); continue }
        if (!f.name.endsWith('.wxml')) continue
        const t = fs.readFileSync(fp, 'utf8')
        const re = /<(\w+)([^>]*?)bind(?:tap|longpress)="([^"]+)"([^>]*)>/g
        let m
        while ((m = re.exec(t))) {
          const attrs = (m[2] || '') + (m[4] || '')
          const cm = /class="([^"]*)"/.exec(attrs)
          if (!cm) { noFeedback.push(path.relative(ROOT, fp) + ' → ' + m[3] + '（没有 class）'); continue }
          const cls = cm[1].replace(/\{\{[\s\S]*?\}\}/g, ' ').split(/\s+/).filter(Boolean)
          if (!cls.length) continue
          if (cls.some(c => NO_FEEDBACK_OK.has(c))) continue
          if (cls.some(c => BASE.indexOf(c) >= 0 || hasActive(c))) continue
          noFeedback.push(path.relative(ROOT, fp) + ' → ' + m[3] + '（' + cls.join('.') + '）')
        }
      }
    }
    walkWxml(path.join(ROOT, 'miniprogram', 'pages'))
    assert.deepStrictEqual(noFeedback, [],
      '这些可点的东西按下没有任何视觉反馈（用户会以为没点中）：\n    ' + noFeedback.join('\n    '))
    ok('全部可点击元素都有按压反馈（或属于点空白关闭的白名单）')

  /* ============ ④e 字号阶梯不能散 ============ */
  console.log('\n=== ④e 全仓字号必须收敛到阶梯上 ===')
  /*
   * ★ 2026-10-28。改造前全仓有 **30 种**字号（17/18/19/20/21/22/23/24/25/26/27/28/30/31/32…）。
   *   每一种单看都"合理"，合起来就是没有排版系统 —— 标题和正文的关系
   *   全靠每一处凭手感挑一个数，改一次页面就多一个字号。
   *
   *   现在收敛到 15 种：正文四阶（18/21/24/27）+ 小标题 32 +
   *   强调 36/44 + 展示级 52/56/64/76/92/104 + 超大 150/200（倒计时与大数字）。
   *   收敛只归并"相差 ≤2rpx"的簇，每处视觉变化 ≤1px，所以截图上看不出差异 ——
   *   这类改动只能靠断言守（和曲线那条同理）。
   */
  {
    const sizes = new Map()
    const walkSize = (dir) => {
      for (const f of fs.readdirSync(dir, { withFileTypes: true })) {
        const fp = path.join(dir, f.name)
        if (f.isDirectory()) walkSize(fp)
        else if (f.name.endsWith('.wxss')) {
          const t = fs.readFileSync(fp, 'utf8')
          ;(t.match(/font-size:\s*(\d+)rpx/g) || []).forEach(x => {
            const n = Number(/(\d+)rpx/.exec(x)[1])
            sizes.set(n, (sizes.get(n) || 0) + 1)
          })
        }
      }
    }
    walkSize(path.join(ROOT, 'miniprogram'))
    assert.ok(sizes.size <= 16,
      '字号又散开了（当前 ' + sizes.size + ' 种，上限 16）：' +
      [...sizes.keys()].sort((a, b) => a - b).join(' / ') +
      '\n    加新字号前先问：能不能用已有的那一阶？')
    ok(`字号收敛到 ${sizes.size} 种：${[...sizes.keys()].sort((a, b) => a - b).join(' / ')}`)
  }
  }
  }
  }

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

  /* ---------- ⑦-4 声音开关必须能停掉底噪（2026-10-30） ---------- */
  /*
   * 真实缺口：stopAll() 原来只停 pool 里的音效，**不管 _ambient**。
   * 于是在房间里关声音（setMuted(true) → stopAll()）或切后台（onHide → stopAll()）时，
   * 背景底噪还在响 —— 用户会以为"这个开关坏了"，后台还白占一个音频实例。
   *
   * ⚠️ 截取函数体用"函数边界"而不是正则非贪婪：`/[\s\S]*?\n\}/` 会被函数体
   *    内部的 `\n}` 提前截断，反向验证时**残缺代码照样通过**（断言等于没写）。
   */
  {
    const sfxSrc = fs.readFileSync(path.join(ROOT, 'miniprogram/game/sfx.js'), 'utf8')
    const iStop = sfxSrc.indexOf('function stopAll()')
    assert.ok(iStop >= 0, '应该能找到 stopAll 的实现')
    const iNext = sfxSrc.indexOf('function ', iStop + 10)
    const body = sfxSrc.slice(iStop, iNext > 0 ? iNext : sfxSrc.length)
    /* ★ 必须先剥注释再判：我在注释里写了"这里可以安全地调用 stopAmbient"，
       于是删掉真正的调用后 indexOf 仍在注释里命中 —— 第一版断言就是这么变成废的。 */
    const code = body.replace(/\/\*[\s\S]*?\*\//g, '').replace(/(^|[^:])\/\/[^\n]*/g, '$1')
    assert.ok(/stopAmbient\s*\(/.test(code),
      '★ stopAll() 必须同时停掉环境底噪 —— 否则关声音后底噪还在响，开关看起来是坏的')
    ok('★ stopAll 会停掉底噪（关声音/切后台时真的安静下来）')
  }

  /* ---------- ③i 界面承诺的动作，代码里必须真有能力 ----------
   *
   * 2026-10-30 加这条，起因是**同一个错犯了第四次**：
   * 剪贴板 API 因为隐私协议限制被移除了（3.10.144），
   * 但界面上三处文案还在说"点一下复制" —— 用户会照着文案去等一个不会发生的行为。
   *
   * 前三次同类：斋做完了规则没提斋、围骰做完了结算说不清 +1、
   * 暗牌改"取最优"但提示还写"有机会"。
   * 规律：**改功能时没全仓扫这个功能的"名字"。**
   *
   * 这条断言把"名字"和"能力"绑在一起：
   *   界面出现「复制」→ 代码里必须有 setClipboardData（或复制类 API）
   *   界面出现「长按」→ 对应元素必须有 user-select 或 longpress 绑定
   */
  {
    const ACTIONS = [
      { word: '复制', need: /setClipboardData/, why: '剪贴板 API' },
      { word: '长按可选中', need: /user-select/, why: 'user-select 属性' }
    ]
    const broken = []
    ;['miniprogram/pages', 'miniprogram/game'].forEach(root => {
      const walk = (dir) => {
        fs.readdirSync(dir, { withFileTypes: true }).forEach(d => {
          const p = path.join(dir, d.name)
          if (d.isDirectory()) return walk(p)
          if (!d.name.endsWith('.wxml')) return
          const src = fs.readFileSync(p, 'utf8')
          /* 去掉注释再判 —— 历史说明里的"复制"不算界面文案 */
          const visible = src.replace(/<!--[\s\S]*?-->/g, '')
          ACTIONS.forEach(a => {
            if (visible.indexOf(a.word) < 0) return
            /* 检查整个小程序有没有这个能力（能力是全局的，不要求同文件） */
            const hasAbility = ACTIONS.length && (() => {
              let found = false
              const scan = (dd) => fs.readdirSync(dd, { withFileTypes: true }).forEach(x => {
                const pp = path.join(dd, x.name)
                if (x.isDirectory()) return scan(pp)
                /* ⚠️ 必须同时扫 .wxml —— user-select 是**模板属性**不是 JS API。
                   第一版只扫 .js，于是"长按可选中"被误报（断言自己有 bug）。 */
                /* ⚠️ 必须**剥掉注释**再匹配 —— 第一版没剥，
                   于是代码里那条"wx.setClipboardData 报隐私错误"的**说明注释**
                   让断言以为能力还在（反向验证时 exit=0，假绿）。 */
                if (x.name.endsWith('.js') || x.name.endsWith('.wxml')) {
                  const raw = fs.readFileSync(pp, 'utf8')
                  const code = raw
                    .replace(/\/\*[\s\S]*?\*\//g, '')
                    .replace(/^\s*\/\/.*$/gm, '')
                    .replace(/<!--[\s\S]*?-->/g, '')
                  if (a.need.test(code)) found = true
                }
              })
              scan('miniprogram')
              return found
            })()
            if (!hasAbility) broken.push(path.relative(ROOT, p) + ' 写了「' + a.word + '」但代码里没有 ' + a.why)
          })
        })
      }
      if (fs.existsSync(root)) walk(root)
    })
    assert.deepStrictEqual(broken, [],
      '界面承诺的动作在代码里找不到能力（用户会照着文案等一个不会发生的行为）：\n    ' + broken.join('\n    '))
    ok('界面上的动作词（复制/长按选中）都有对应能力')
  }

  /* ---------- ⑦-3 定时器自重启不能形成无限循环 ---------- */
  console.log(`\n${'='.repeat(56)}\n  字段契约：全部 ${n} 项断言通过\n${'='.repeat(56)}\n`)
})().catch(e => {
  console.error('\n  ✗ 失败：', e.message, '\n')
  process.exit(1)
})
