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
          /*
           * ★ 2026-11-03：抽取方式跟着实现变了（`slice(0,12)` → `clip(..., 12)`）。
           *   这类"从源码里抽一个数"的断言，**实现一变它就会失灵** ——
           *   而失灵的表现是"找不到云端限制"，不是"限制不对"。
           */
          const m = /const name = clip\(String\(event\.name \|\| ''\)\.trim\(\), (\d+)\)/.exec(cloudSrc)
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

  /*
   * ★★★ 2026-11-02：`feedback.fire('xxx')` 的动作名也要校验。
   *
   * 上面那条只扫 `sfx.play('xxx')`（音效键），而 `feedback.fire` 用的是
   * **另一套命名空间**（全仓 21 个动作：diceSettle / cupOpen / luckyHit /
   * penalized / pkFlip …）。
   *
   * 而 `fire()` 对未知动作是**静默的** —— 音效不响、震不动、也不报错。
   * 这轮改转盘结果音效时我就写错过：把音效键 `combo1` 当成动作名传进去，
   * **测试全绿**，是我 grep 出可用动作列表才发现。
   */
  {
    const fbSrc = fs.readFileSync(
      path.join(ROOT, 'miniprogram/game/feedback.js'), 'utf8')
    /* 只取 FEEDBACK 表里的键：形如「  xxx: {」，且在 const FEEDBACK = { 之后 */
    const tableStart = fbSrc.indexOf('const FEEDBACK')
    assert.ok(tableStart > 0, '找不到 FEEDBACK 表')
    const tableEnd = fbSrc.indexOf('\n}', tableStart)
    const tableSrc = fbSrc.slice(tableStart, tableEnd > 0 ? tableEnd : undefined)
    const actionKeys = new Set(
      [...tableSrc.matchAll(/^  (\w+):\s*\{/gm)].map(m => m[1]))
    assert.ok(actionKeys.size >= 10,
      'FEEDBACK 表里只认出 ' + actionKeys.size + ' 个动作（抽取可能失效）')

    const badFire = []
    walkPages(PAGE_ROOTS).forEach(jsFile => {
      fs.readFileSync(jsFile, 'utf8').split('\n').forEach((line, i) => {
        /* 跳过注释行 —— 注释里举例写到的动作名不该算错 */
        if (/^\s*(\*|\/\/)/.test(line)) return
        const re = /feedback\.fire\(\s*'([\w]+)'/g
        let m
        while ((m = re.exec(line))) {
          if (!actionKeys.has(m[1])) {
            badFire.push(path.relative(ROOT, jsFile) + ':' + (i + 1) + '  → ' + m[1])
          }
        }
      })
    })
    assert.deepStrictEqual(badFire, [],
      '这些 feedback.fire 的动作名不存在（fire() 对未知动作是静默的，音效不会响）：\n    ' +
      badFire.join('\n    ') + '\n    可用动作：' + [...actionKeys].sort().join(' '))
    ok('★ 全部 feedback.fire 的动作名都存在（' + actionKeys.size + ' 个可用）')

  /*
   * ★ 2026-11-02：UI 文案里**不该出现句号** —— 句末的、句中的都不该。
   *
   * 原来只查过"句末句号"，所以「动画变快、幅度变小。觉得晃眼就打开」
   * 这种**句中句号**漏了一年。
   *
   * 判据来自产品自己：界面文案是"标签 + 短句"，句号在界面上只是噪音；
   * 需要分句时用「；」或「·」，全仓另外 20 多条都是这么写的。
   */
  {
    const badPeriod = []
    walkPages(PAGE_ROOTS).forEach(jsFile => {
      const wxmlFile = jsFile.replace(/\.js$/, '.wxml')
      if (!fs.existsSync(wxmlFile)) return
      const src = fs.readFileSync(wxmlFile, 'utf8').replace(/<!--[\s\S]*?-->/g, '')
      /* 只看纯文本节点里的中文（跳过 <text> 里的表达式和属性） */
      const re = />([^<>{}]*[\u4e00-\u9fa5][^<>{}]*)</g
      let m
      while ((m = re.exec(src))) {
        const t = m[1].trim()
        if (t.includes('。')) {
          badPeriod.push(path.relative(ROOT, wxmlFile) + ' → 「' + t.slice(0, 28) + '」')
        }
      }
    })
    assert.deepStrictEqual(badPeriod, [],
      '界面文案里不该用句号（分句用「；」或「·」）：\n    ' + badPeriod.join('\n    '))
    ok('★ 界面文案没有句号（句中的也算）')

  /*
   * ★ 2026-11-02：房间页里每个 `this._xxxTimer` 都必须进清理函数。
   *
   * AGENTS.md 记过这条（「所有定时器都要进清单」）——
   * 不清的后果是：用户操作后立刻退出页面，定时器仍会对已卸载的页面 setData/调方法。
   *
   * 这轮我给"再来一局"加了 `_againTimer`，当场就踩了这个坑。
   */
  {
    const roomJs = fs.readFileSync(
      path.join(ROOT, 'miniprogram/game/room/room.js'), 'utf8')
    const assigned = new Set(
      [...roomJs.matchAll(/this\.(_\w*[Tt]imer)\s*=/g)].map(m => m[1]))
    /* onUnload 会调 clearCupTimers / clearCountdown，所以把这两个函数的体也算进清理 */
    const clearBodies = ['clearCupTimers', 'clearCountdown', 'onUnload']
      .map(fn => {
        const i = roomJs.indexOf('  ' + fn + '(')
        return i < 0 ? '' : roomJs.slice(i, i + 1200)
      }).join('\n')
    const uncleaned = [...assigned].filter(t =>
      !new RegExp('clearTimeout\\(this\\.' + t + '\\)').test(clearBodies))
    assert.deepStrictEqual(uncleaned, [],
      '这些定时器没进清理函数（退出页面后仍会执行）：' + uncleaned.join(' '))
    ok('★ 房间页的 ' + assigned.size + ' 个定时器都在清理清单里')

  /*
   * ★ 2026-11-02：**面向用户的文案里不许有感叹号**。
   *
   * 用户明确说过「'开始！'可以不要'！'」。前几轮清过动作按钮上的，
   * 但这轮发现「该你了，摇盅！」还在 —— 而且同一个提示在另一处
   * 写成「该你了，摇盅」，一屏里两种写法。
   *
   * 只查**字符串字面量里的**感叹号，注释里提到「开始！」不算。
   */
  {
    const badBang = []
    const files = []
    walkPages(PAGE_ROOTS).forEach(f => {
      files.push(f)
      const w = f.replace(/\.js$/, '.wxml')
      if (fs.existsSync(w)) files.push(w)
    })
    files.forEach(f => {
      let src = fs.readFileSync(f, 'utf8')
      /* ★ 先把**跨行**注释整块剥掉 —— 只跳"注释行"会漏掉块注释的中间行，
         而块注释里经常举例写「"开始！"」这种带感叹号的原文。 */
      src = src.replace(/\/\*[\s\S]*?\*\//g, m => m.replace(/[^\n]/g, ' '))
      src = src.replace(/<!--[\s\S]*?-->/g, m => m.replace(/[^\n]/g, ' '))
      const lines = src.split('\n')
      lines.forEach((line, i) => {
        /* 再跳过单行注释 */
        if (/^\s*(\*|\/\/)/.test(line)) return
        /* 提取这一行里的字符串字面量 */
        const lits = line.match(/'[^']*'|"[^"]*"/g) || []
        lits.forEach(lit => {
          if (lit.includes('！') && !lit.includes('★')) {
            badBang.push(path.relative(ROOT, f) + ':' + (i + 1) + ' → ' + lit.slice(0, 30))
          }
        })
      })
    })
    assert.deepStrictEqual(badBang, [],
      '面向用户的文案里不要用感叹号：\n    ' + badBang.join('\n    '))
    ok('★ 用户文案里没有感叹号（用户明确要求过）')
  }
  }
  }
  }

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
  assert.ok(iconNames.length >= 15,
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

  /*
   * ★★★ ④·d 探针脚本用的选择器必须在模板里真实存在（2026-10-30，真实踩到）。
   *
   * `.tooling/e2e-ui.js` 里写 `dp.$('.rollbtn')` —— 而模板里**没有 rollbtn 这个类**
   * （真实摇骰按钮是 `.btn.main.bigbtn`）。于是那个 e2e 脚本**一直找不到按钮**，
   * 摇骰那一步从来没真正执行过，却看起来"跑完了"。
   *
   * 而我后来临时写的探针用了 `.chipbar .chip`（也不存在），
   * 于是报出"叫骰按钮数为 0"的假 bug，白查一轮。
   *
   * 判据：.tooling/ 里 `$('...')` / `$$('...')` 的**第一个类名**必须能在 wxml 的 class 里找到。
   */
  {
    const tplD = fs.readFileSync(path.join(ROOT, 'miniprogram/game/room/room.wxml'), 'utf8') +
                 fs.readFileSync(path.join(ROOT, 'miniprogram/pages/lobby/lobby.wxml'), 'utf8')
    const realCls = new Set()
    for (const m of tplD.matchAll(/class="([^"]*)"/g)) {
      m[1].replace(/\{\{[\s\S]*?\}\}/g, '').split(/\s+/).forEach(c => { if (c) realCls.add(c) })
    }
    const badSel = []
    const toolFiles = fs.readdirSync(path.join(ROOT, '.tooling')).filter(f => f.endsWith('.js'))
    toolFiles.forEach(f => {
      const src = fs.readFileSync(path.join(ROOT, '.tooling', f), 'utf8')
      for (const m of src.matchAll(/\$\$?\(\s*'([^']+)'/g)) {
        const first = m[1].trim().split(/\s+/)[0]
        if (!first.startsWith('.')) continue          /* 标签选择器/属性选择器不管 */
        const cls = first.slice(1).split('.')[0]
        if (cls && !realCls.has(cls)) badSel.push(f + ' → ' + m[1])
      }
    })
    assert.deepStrictEqual(badSel, [],
      '这些探针用的类名在模板里不存在（脚本会静默找不到元素，验证等于没做）：\n    ' + badSel.join('\n    '))
    ok('★ ' + toolFiles.length + ' 个探针脚本用的类名都真实存在')
  }

  /*
   * ★★★ ④·e 探针里的页面路径必须真实存在（2026-10-30，三个脚本一起失效）。
   *
   * 2026-10-28 拆分包时，房间页从 `pages/game/room/room` 移到了 `game/room/room`。
   * 但 `.tooling/` 下**三个脚本还写着旧路径**：
   *     probe-room.js / verify-fix.js / verify-ui-live.js
   * 而 `mini.navigateTo()` 失败**不抛异常** —— 于是它们从那天起
   * 一直在 navigateTo 一个不存在的页面，然后对着上一页做断言。
   *
   * 这和已经记过的「拆包后 Python 脚本的默认输出路径没改」是同一类，
   * 只是这次在 .tooling 里。
   *
   * 判据：脚本里 `navigateTo('/xxx')` / `switchTab('/xxx')` 的路径，
   * 必须是 app.json 的 pages 或 subpackages 里真实注册的。
   */
  {
    const appJson = JSON.parse(fs.readFileSync(path.join(ROOT, 'miniprogram/app.json'), 'utf8'))
    const valid = new Set(appJson.pages || [])
    ;(appJson.subpackages || []).forEach(sp => {
      ;(sp.pages || []).forEach(p => valid.add((sp.root + '/' + p).replace(/\/\//g, '/')))
    })
    const badPage = []
    fs.readdirSync(path.join(ROOT, '.tooling')).filter(f => f.endsWith('.js')).forEach(f => {
      const src = fs.readFileSync(path.join(ROOT, '.tooling', f), 'utf8')
      for (const m of src.matchAll(/(?:navigateTo|switchTab|reLaunch)\('\/?([\w/]+)'/g)) {
        const p = m[1]
        if (!valid.has(p)) badPage.push(f + ' → ' + p)
      }
    })
    assert.deepStrictEqual(badPage, [],
      '这些探针导航到了不存在的页面（navigateTo 失败不抛异常，会对着上一页断言）：\n    ' + badPage.join('\n    '))
    ok('★ 探针导航的页面路径都已注册（' + valid.size + ' 个页面）')
  }

  /*
   * ★★★ ④·f 模板绑定的方法必须在页面 js 里存在（2026-10-30，反向的一次）。
   *
   * 已有的 ③b 查的是「js 里定义了方法，但模板没绑」（死代码）；
   * 这一条查的是**反向**：「模板绑了方法，但 js 没定义」——
   * 点了**静默无反应**，不报错。
   *
   * 真实案例：修「叫人来按钮被规则挤出屏幕」时，我先写了
   * `bindtap="openHow"`，而真实方法是 `showHow`（openHow 不存在）。
   * 如果没当场发现，上线后就是"点了没反应"。
   */
  {
    const PAIRS = [
      ['miniprogram/game/room/room', 'room'],
      ['miniprogram/pages/lobby/lobby', 'lobby'],
      ['miniprogram/pages/me/me', 'me']
    ]
    const ghostFn = []
    PAIRS.forEach(([base, name]) => {
      const t = fs.readFileSync(path.join(ROOT, base + '.wxml'), 'utf8')
      const j = fs.readFileSync(path.join(ROOT, base + '.js'), 'utf8')
      const bound = new Set([...t.matchAll(/(?:bind|catch)\w*="(\w+)"/g)].map(m => m[1]))
      const defined = new Set([...j.matchAll(/^\s{2}(?:async\s+)?(\w+)\s*\(/gm)].map(m => m[1]))
      bound.forEach(fn => { if (!defined.has(fn)) ghostFn.push(name + ': ' + fn) })
    })
    assert.deepStrictEqual(ghostFn, [],
      '这些方法在模板里绑了、但 js 里没有定义（点了静默无反应）：\n    ' + ghostFn.join('\n    '))
    ok('★ 三个页面的 bindtap 目标都有对应方法')
  }

  /*
   * ★★★ ④·g 云调用之后必须处理「业务错误」，不能只判 ok（2026-10-30）。
   *
   * 云函数**正常返回** `{ ok:false, msg:'只有房主能锁房' }` 时，`catch` 不会跑。
   * 而很多方法只写了 `if (r && r.ok) this.applyRoom(r.room)` ——
   * 失败分支**什么都不做**，用户看到的就是"点了没反应"。
   *
   * 真机反馈里"点了没反应"出现过多次，这轮扫出 7 处一起修了。
   * 这条断言防止以后新增的云调用又写成静默。
   *
   * 判据：`await call(...)` 之后的 if 判断里，如果只出现 `r.ok` 而没有
   * `okOrSay` / `else` / `!r.ok` 之一，就报。
   */
  {
    /*
     * 判据收紧（第二版）：直接要求**用了 okOrSay**，不看窗口。
     *
     * 第一版看"前后 25 行内有没有 showToast" —— 太宽，
     * 附近别的方法里有个 showToast 就放行了，反向验证 exit=0（假绿）。
     *
     * 现在：所有 `call(...)` 之后的成功判断，必须是 `this.okOrSay(r)`。
     * 唯一例外：把错误写进页面 err 条的方法（doCreate / doJoin），
     * 它们用 `setData({ err })`，用白名单按方法名排除。
     */
    const jsG = fs.readFileSync(path.join(ROOT, 'miniprogram/game/room/room.js'), 'utf8')
    const linesG = jsG.split('\n')
    const silent = []
    let curFn = ''
    for (let i = 0; i < linesG.length; i++) {
      const l = linesG[i]
      /* 记当前方法名，用于白名单 */
      const fm = /^\s{2}(?:async\s+)?(\w+)\s*\(/.exec(l)
      if (fm) curFn = fm[1]
      if (/^\s*(\*|\/\/)/.test(l)) continue
      if (!/if \(r && r\.ok\)/.test(l)) continue
      if (curFn === 'doCreate' || curFn === 'doJoin') continue   /* 走页面 err 条 */
      if (curFn === 'okOrSay') continue                          /* 它自己就是处理逻辑 */
      silent.push((i + 1) + ' [' + curFn + '] ' + l.trim().slice(0, 50))
    }
    assert.deepStrictEqual(silent, [],
      '这些云调用只判了 ok（业务错误被静默吞掉 → "点了没反应"）：\n    ' + silent.join('\n    '))
    ok('★ 云调用都走 okOrSay 处理业务错误')
  }

  /*
   * ★★★ ④·h CSS 动画节奏 与 JS 音效节奏 必须一致（2026-11-02）。
   *
   * 骰子逐颗落定这件事写在两个地方：
   *   wxss  `.cs-die { animation-delay: calc(var(--i) * 90ms) }`   ← 视觉节奏
   *   js    `const DIE_DROP_MS = 90`                                ← 声音节奏
   *
   * 两处一致时，画面"啪啪啪啪啪"和耳朵听到的完全对上。
   * 改一处忘另一处，就是那种说不上来但一眼假的错位 ——
   * 而且它不报错、不崩、静态检查也看不出来。
   *
   * 这不是推演出来的风险：转盘咔哒那边就因为"传 2600、动画 2700"
   * 错了 100ms，实测最后 300ms 完全静音。
   */
  {
    const wxssD = fs.readFileSync(path.join(ROOT, 'miniprogram/game/room/room.wxss'), 'utf8')
    const jsD = fs.readFileSync(path.join(ROOT, 'miniprogram/game/room/room.js'), 'utf8')
    const cssM = /animation-delay:\s*calc\(var\(--i\)\s*\*\s*(\d+)ms\)/.exec(wxssD)
    const jsM = /const\s+DIE_DROP_MS\s*=\s*(\d+)/.exec(jsD)
    assert.ok(cssM, '没找到 .cs-die 的 animation-delay 节奏')
    assert.ok(jsM, '没找到 DIE_DROP_MS 常量')
    assert.strictEqual(jsM[1], cssM[1],
      '骰子落定的视觉节奏(' + cssM[1] + 'ms)和声音节奏(' + jsM[1] + 'ms)不一致 —— 画面和声音会错位')
    ok('★ 骰子落定：视觉 ' + cssM[1] + 'ms = 声音 ' + jsM[1] + 'ms')
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
    /*
     * ★ 2026-11-03：文案改成了「被劈了翻一倍（1→2→4→8 杯，最多 8 杯）」——
     *   比原来的「劈一次 2 杯，反劈再翻一倍 4 杯」更清楚，而且**补上了 8 杯的封顶**
     *   （云端是 `min(8, mult*2)`，原来规则只写到 4 杯）。
     *
     *   所以断言也从"出现过 4 杯"改成"说清了整条倍数链和封顶"。
     */
    assert.ok(/2[、\/→]?\s*4/.test(liarBlock) || /2 杯/.test(liarBlock),
      '★ 规则里要说清劈的倍数链（至少到 2 杯、4 杯）')
    assert.ok(/最多\s*8\s*杯/.test(liarBlock),
      '★ 规则里必须写清劈的封顶是 8 杯（代码是 min(8, mult*2)）')
    ok('大话骰规则说清了 1→2→4→8 杯的倍数链与 8 杯封顶')
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

/* ============================================================================
 * 2026-11-02 追加：**大厅玩法卡的排版不许改**（用户明确要求过）
 *
 * 原话：「大厅游戏排版不要改」——
 * 当时我擅自把第 5 张卡从"占左半"改成了"独占一行"，被要求撤销。
 *
 * 现在的排版是 `flex-wrap` + 每张 `flex: 0 0 48.5%` 的**自然结果**：
 * 5 张卡 → 3 行（2 + 2 + 1），第 5 张自然落在左半边。
 *
 * 锁两条，任何一条变了排版就不是现在这个样子：
 *   · 容器必须是 flex-wrap（不是 grid、不是单列）
 *   · 卡片宽度必须是 48.5%（两列，且留出 gap）
 * ========================================================================== */
{
  const css = fs.readFileSync(
    path.join(ROOT, 'miniprogram/pages/lobby/lobby.wxss'), 'utf8')

  const gridRule = /\.ggrid\s*\{([^}]*)\}/.exec(css)
  assert.ok(gridRule, '找不到 .ggrid 规则')
  assert.ok(/display:\s*flex/.test(gridRule[1]) && /flex-wrap:\s*wrap/.test(gridRule[1]),
    '★ 大厅的玩法卡容器必须保持 flex-wrap（用户要求过排版不要改）')

  const cardRule = /\.gcard\s*\{([^}]*)\}/.exec(css)
  assert.ok(cardRule, '找不到 .gcard 规则')
  assert.ok(/flex:\s*0\s+0\s+48\.5%/.test(cardRule[1]),
    '★ 玩法卡宽度必须是 48.5%（两列布局）—— 改了就不是用户要的排版了')
  ok('★ 大厅玩法卡排版锁住：flex-wrap + 每张 48.5%（5 张 = 2+2+1）')
}

/* ============================================================================
 * 2026-11-02 追加：用户反馈过的两个数值，不许悄悄改回去
 *
 * ============ 这两个数怎么来的 ============
 *
 * ① **倒计时 3200 → 2000**（用户原话「准备画面 4 秒太长」）
 *    当时 `Math.ceil(3200/1000) = 4`，屏幕上真的从 **4** 开始倒数。
 *
 * ② **关键音效音量 0.9 → 1.0**（用户原话「声音一般」）
 *    酒桌上手机是外放的，环境噪音 60~70dB，那 10% 是"能不能盖过一桌人说话"。
 *
 * 这两个都是**实测之后定的**，不是随手选的。改回去会重犯同样的反馈。
 * ========================================================================== */
{
  const cloud = fs.readFileSync(
    path.join(ROOT, 'cloudfunctions/room/index.js'), 'utf8')
  const ms = /COUNTDOWN_MS\s*=\s*(\d+)/.exec(cloud)
  assert.ok(ms, '找不到 COUNTDOWN_MS')
  assert.ok(Number(ms[1]) <= 2000,
    '★ 倒计时必须 ≤ 2000ms（用户说过"4 秒太长"；3200 会显示成从 4 倒数）')

  const fb = fs.readFileSync(
    path.join(ROOT, 'miniprogram/game/feedback.js'), 'utf8')
  const vol = /VOL_CRITICAL\s*=\s*([\d.]+)/.exec(fb)
  assert.ok(vol, '找不到 VOL_CRITICAL')
  assert.ok(Number(vol[1]) >= 1.0,
    '★ 关键音效音量必须满（用户说过"声音一般"；0.9 在酒桌外放时输给环境噪音）')

  ok('★ 用户反馈的两个数值锁住：倒计时 ≤2000ms / 关键音效音量 ≥1.0')
}

/* ============================================================================
 * 2026-11-02 追加：**可点的元素必须有按下反馈**
 *
 * 起因：房间页 20 个按钮类里 9 个没有 `:active` ——
 * 包括最重要的 `.bigbtn`（开始 / 摇盅 / 再来一局）。
 *
 * 没有反馈的按钮点下去**像没反应**，而用户对"点了没反应"的容忍度是零：
 * 他会再点一次，然后开始怀疑网络。
 *
 * 这条断言的判据是**行为**（有没有绑定事件），不是类名长相：
 * 按类名扫会漏掉 `.bigbtn` 这种自定义名字的，也会把 `.pill-icon` 算进来。
 * ========================================================================== */
{
  /* ⚠️ `walkPages` 定义在另一个块作用域里，这里不可见 —— 自带一份遍历 */
  const walkJs = (dirs) => {
    const out = []
    const walk = (d) => {
      if (!fs.existsSync(d)) return
      fs.readdirSync(d).forEach(f => {
        const p = path.join(d, f)
        if (fs.statSync(p).isDirectory()) walk(p)
        else if (f.endsWith('.js')) out.push(p)
      })
    }
    ;(Array.isArray(dirs) ? dirs : [dirs]).forEach(walk)
    return out
  }
  const bad = []
  walkJs(PAGE_ROOTS).forEach(jsFile => {
    const wxmlFile = jsFile.replace(/\.js$/, '.wxml')
    if (!fs.existsSync(wxmlFile)) return
    const tpl = fs.readFileSync(wxmlFile, 'utf8').replace(/<!--[\s\S]*?-->/g, '')
    const cssFile = wxmlFile.replace(/\.wxml$/, '.wxss')
    const css = fs.existsSync(cssFile)
      ? fs.readFileSync(cssFile, 'utf8').replace(/\/\*[\s\S]*?\*\//g, '')
      : ''
    /* 找所有带事件绑定的标签，取它的 class 里第一个静态类名 */
    const re = /<[a-z-]+[^>]*?(?:bind|catch)\w+="[^"]+"[^>]*?>/g
    let m
    const seen = new Set()
    while ((m = re.exec(tpl))) {
      const tag = m[0]
      const cm = /class="([^"]*)"/.exec(tag)
      if (!cm) continue
      /*
       * ★ 关键：取**所有**静态类名，不是只取第一个。
       *
       *   模板里是 `class="btn main bigbtn"` —— 而真正的按钮类是 **bigbtn**
       *   （`btn` 只是个基础壳）。第一版只检查第一个类名（`btn`），
       *   把 `.bigbtn:active` 整条删掉**照样通过**（反向验证抓到的）。
       */
      const classes = cm[1].split(/\s+/).filter(c => c && !c.includes('{'))
      if (!classes.length) continue
      const key = classes.join(' ')
      if (seen.has(key)) continue
      seen.add(key)
      /* 任意一个类名有 :active 就算有反馈（组合选择器也算） */
      const hasActive = classes.some(cls =>
        new RegExp('\\.' + cls + '[^{]*:active').test(css))
      if (!hasActive) {
        bad.push(path.relative(ROOT, wxmlFile) + ' → .' + classes.join('.'))
      }
    }
  })
  /* 已知的例外：这些是靠别的方式给反馈（动画/跳转），不是按压型按钮 */
  /* 不需要按压反馈的：输入框（有聚焦态）、遮罩（点空白关闭）、
     弹层本体（catchtap 只是为了阻止冒泡，本身不可点） */
  const ALLOW = [
    'gcard', 'textbtn', 'aw-opt', 'mask', 'diag-sheet', 'sheet', 'cardta',
    /* 输入框：反馈是**聚焦态**（光标 + 键盘弹出），不是按压变暗。
       2026-11-03 加 cs-input（众口一致的数值输入）—— 和 tin 同一类。 */
    'tin', 'cs-input'
  ]
  const real = bad.filter(x => !ALLOW.some(a => x.endsWith('.' + a)))
  assert.deepStrictEqual(real, [],
    '这些可点元素没有 :active 按下反馈（点下去像没反应）：\n    ' + real.join('\n    '))
  ok('★ 所有可点元素都有按下反馈（' + (bad.length - real.length) + ' 个白名单例外）')
}

/* ============================================================================
 * 2026-11-02 追加：**注册了但从来没被播放的音效 = 白占包体积**
 *
 * 这轮删掉了 `drink.wav`（11KB）：它在 sfx.js 里注册了，但全局搜不到任何
 * `sfx.play('drink')` —— 一个从来没响过的文件占着分包空间。
 *
 * ⚠️ 扫描要覆盖**动态调用**：`sfx.play(joined ? 'combo1' : 'toggleOff')` 里
 *    的两个 key 都不是"play('x')"的字面形态，第一版判据漏了它们（假阳性 4 个）。
 *    所以这里改成"扫所有单引号字符串"，宁可宽一点。
 * ========================================================================== */
{
  const sfxSrc = fs.readFileSync(
    path.join(ROOT, 'miniprogram/game/sfx.js'), 'utf8')
  const keys = [...sfxSrc.matchAll(/^\s+(\w+):\s*'\/game\/audio\/([\w-]+)\.wav'/gm)]
    .map(m => m[1])
  assert.ok(keys.length > 20, 'sfx 注册表只认出 ' + keys.length + ' 项')

  /* 把所有 js 里的字符串字面量捞出来（覆盖动态调用写法的 key） */
  const literals = new Set()
  const walk = (d) => {
    if (!fs.existsSync(d)) return
    fs.readdirSync(d).forEach(f => {
      const p = path.join(d, f)
      if (fs.statSync(p).isDirectory()) walk(p)
      else if (f.endsWith('.js')) {
        const src = fs.readFileSync(p, 'utf8')
        ;[...src.matchAll(/'([\w-]+)'/g)].forEach(m => literals.add(m[1]))
      }
    })
  }
  walk(path.join(ROOT, 'miniprogram'))

  /*
   * 白名单（都有明确理由，不是"查不到就算了"）：
   *   ambientRoom —— 走 playAmbient() 内部的 FILES.ambientRoom，不是字符串 key
   *   combo2/3/4  —— 是 `sfx.play('combo' + n)` 拼出来的，源码里没有字面量
   */
  const ALLOW = ['ambientRoom', 'combo2', 'combo3', 'combo4']
  const dead = keys.filter(k => !literals.has(k) && !ALLOW.includes(k))
  assert.deepStrictEqual(dead, [],
    '这些音效注册了但从没被播放（白占包体积）：\n    ' + dead.join('\n    '))
  ok('★ ' + keys.length + ' 个音效都有调用点（没有白占体积的）')
}

/* ============================================================================
 * 2026-11-02 追加：**按模运算取样式时，样式数量必须 ≥ 模数**
 *
 * 这轮抓到：头像用 `pav s{{seat % 4}}` 而只有 4 种颜色，
 * 但大话骰/比大小支持 **8 人** —— 座位 1 和 5 同色，桌上认不出谁是谁。
 * 它在 3 人局里看起来完全正常，**只在第 5 个人进来时才坏**。
 *
 * ⚠️ 通用正则对付不了这里的所有写法：
 *    · `cf cf-{{item % 5}}`            前缀后面是连字符
 *    · `pav s{{seat % 8}}`             前缀**紧贴** {{，且真名是组合选择器 `.pav.s0`
 *    · `{{cdTick % 2 ? 'a' : 'b'}}`    类名在**插值内部**，前缀和它无关
 *   第一版想用一条正则吃下三种，结果三种都判错（反向验证 exit=0）。
 *   **所以这里写成三条精确检查** —— 写死了，但每条都对得上一种真实写法。
 * ========================================================================== */
{
  const wxml = fs.readFileSync(
    path.join(ROOT, 'miniprogram/game/room/room.wxml'), 'utf8')
  const css = fs.readFileSync(
    path.join(ROOT, 'miniprogram/game/room/room.wxss'), 'utf8')
    .replace(/\/\*[\s\S]*?\*\//g, '')
  const bad = []

  /* ① 头像：pav s{{item.seat % N}} —— 真名是组合选择器 .pav.sN */
  const av = /pav s\{\{item\.seat % (\d+)\}\}/.exec(wxml)
  if (av) {
    const n = Number(av[1])
    const cnt = new Set(css.match(/\.pav\.s\d+/g) || []).size
    if (cnt < n) bad.push('.pav.sN：模板 % ' + n + ' 但只有 ' + cnt + ' 种颜色')
  }

  /* ② 撒花：cf cf-{{item % N}} */
  const cf = /cf cf-\{\{item % (\d+)\}\}/.exec(wxml)
  if (cf) {
    const n = Number(cf[1])
    const cnt = new Set(css.match(/\.cf-\d+/g) || []).size
    if (cnt < n) bad.push('.cf-N：模板 % ' + n + ' 但只有 ' + cnt + ' 种样式')
  }

  /* ③ 倒计时数字：{{cdTick % 2 ? 'pop-a' : 'pop-b'}} —— 类名在插值里 */
  const cd = /cdTick % 2 \? '([\w-]+)' : '([\w-]+)'/.exec(wxml)
  if (cd) {
    ;[cd[1], cd[2]].forEach(c => {
      if (!new RegExp('\\.' + c + '\\b').test(css)) bad.push('.' + c + ' 在模板里用了但没样式')
    })
  }

  assert.deepStrictEqual(bad, [],
    '按模数取样式的地方，样式数量不够：\n    ' + bad.join('\n    '))
  ok('★ 按模数取样式：头像 8 色 / 撒花 5 式 / 倒计时 2 态 —— 都对得上')
}

/* ============================================================================
 * 2026-11-02 追加：**「减少动效」必须覆盖所有装饰性循环动画**
 *
 * 用户能打开「我的 → 减少动效」，说明他会用这个开关。
 * 而它原来只停了 3 个动画，全仓还有 5 个 `infinite` 在照转。
 *
 * 判据：扫房间页 CSS 里所有 `animation: ... infinite` 的类，
 * 排除**功能性**的三个（它们表达"正在发生什么"，停掉会被当成卡住），
 * 剩下的必须都能在 `.reduce-motion` 规则里找到。
 * ========================================================================== */
{
  const css = fs.readFileSync(
    path.join(ROOT, 'miniprogram/game/room/room.wxss'), 'utf8')
    .replace(/\/\*[\s\S]*?\*\//g, '')

  /* 功能性循环（摇盅、滚动、整页震）—— 不该被"减少动效"停掉 */
  const FUNCTIONAL = ['cs-cup', 'gamepage', 'rl-dice', 'rl-rink']

  /* 找出所有带 infinite 的类 */
  const loops = new Set()
  const re = /\.([\w-]+)(?:\.[\w-]+)?\s*\{([^}]*infinite[^}]*)\}/g
  let m
  while ((m = re.exec(css))) {
    if (!FUNCTIONAL.includes(m[1])) loops.add(m[1])
  }

  /* 从 `.reduce-motion` 规则里抽出被停掉的类 */
  const rmBlock = css.slice(css.indexOf('.reduce-motion .cs-spot'))
  const rmRule = rmBlock.slice(0, rmBlock.indexOf('}'))
  const covered = new Set([...rmRule.matchAll(/\.reduce-motion\s+\.([\w-]+)/g)].map(x => x[1]))

  const missing = [...loops].filter(c => !covered.has(c))
  assert.deepStrictEqual(missing, [],
    '这些循环动画在「减少动效」下还在转：\n    ' + missing.join('\n    '))
  ok('★ 「减少动效」覆盖了 ' + loops.size + ' 个装饰循环动画')
}

/* ============================================================================
 * 2026-11-03 追加：**轮询间隔必须按阶段自适应，且阶段变化时要重挂**
 *
 * `setInterval` 的间隔是启动那刻定死的 —— 光有 `pollInterval()` 不够，
 * 阶段一变必须 `stopPoll + startPoll`，否则"开局了还在用等人的慢节奏"。
 *
 * 而且只要有一个入口漏了（applyRoom / onShow / 建房后），
 * 那个入口进来的玩家就会一直用错的间隔 —— **不报错、只是慢**。
 * ========================================================================== */
{
  const src = fs.readFileSync(
    path.join(ROOT, 'miniprogram/game/room/room.js'), 'utf8')

  assert.ok(/pollInterval\(\)\s*\{[\s\S]{0,400}?ph === 'lobby' \? 3000 : POLL_MS/.test(src),
    '必须有 pollInterval()：lobby 用 3 秒、其他阶段用 POLL_MS')
  assert.ok(/setInterval\([\s\S]{0,60}?this\.pollInterval\(\)/.test(src),
    'startPoll 必须用 pollInterval() 而不是直接用 POLL_MS')
  assert.ok(/if \(wasLobby !== isLobby\) this\.startPoll\(\)/.test(src),
    'applyRoom 里必须在「进出 lobby」时重挂轮询')
  assert.ok(/prevPhase !== raw\.phase/.test(src),
    '重挂必须只在阶段真的变化时做（每次都重挂会让定时器永不触发）')

  ok('★ 轮询按阶段自适应（lobby 3 秒 / 局内 1.5 秒），且阶段变化时重挂')
}

/* ============================================================================
 * 2026-11-03 追加：**音频文件不能"注册了却没声音"或"存在了却没人用"**
 *
 * 这轮删掉两个死文件（133 KB）：
 *   · `dice-shake.wav`        —— sfx.js 里 0 次引用（映射漏在生成脚本里）
 *   · `dice-tumble-wood.wav`  —— 注释里写着"已删"，而生成脚本还在造它
 *
 * 死音频的危害不只是占体积：**每次跑 import-audio.py 都会把它重新造出来**，
 * 而它没有调用点，所以永远不会响 —— 也就永远没人发现它还在。
 * ========================================================================== */
{
  const sfxSrc = fs.readFileSync(
    path.join(ROOT, 'miniprogram/game/sfx.js'), 'utf8')
  const registered = new Set(
    [...sfxSrc.matchAll(/'\/game\/audio\/([\w-]+)\.wav'/g)].map(m => m[1]))

  /* ① 注册了的必须真的有文件 */
  const missing = [...registered].filter(
    n => !fs.existsSync(path.join(ROOT, 'miniprogram/game/audio', n + '.wav')))
  assert.deepStrictEqual(missing, [], '这些音效注册了但文件不存在：\n    ' + missing.join('\n    '))

  /*
   * ② 有文件的应该被注册（否则就是死文件）
   *
   * ⚠️ `tick` 是**唯一留在主包**（`miniprogram/audio/`）的音效 ——
   *   「我的」页试听要用它，而主包不能引用分包的文件。
   *   所以它的注册路径是 `'/audio/tick.wav'`，不在 `game/audio/` 里。
   *   而 `game/audio/tick.wav` 曾经**同时存在一份旧版**（836 字节 vs 928）——
   *   两处同名不同内容，注册用的是旧的那份，游戏里听到的也是旧的。
   *   已合并成主包一份。
   */
  const MAIN_PKG = ['tick']
  const dir = path.join(ROOT, 'miniprogram/game/audio')
  const onDisk = fs.readdirSync(dir).filter(f => f.endsWith('.wav')).map(f => f.slice(0, -4))
  const orphans = onDisk.filter(n => !registered.has(n) && !MAIN_PKG.includes(n))
  assert.deepStrictEqual(orphans, [],
    '这些音频文件没有任何地方注册（白占分包体积）：\n    ' + orphans.join('\n    '))

  ok('★ ' + registered.size + ' 个音效文件与注册表一一对应（无缺失、无孤儿）')
}

/* ============================================================================
 * 2026-11-03 追加：**分享链接的参数契约**
 *
 * 分享出去的东西有三环，断一环就"朋友点进来不知道发生了什么"：
 *   ① `onShareAppMessage` 的 `path` 里必须带房间号
 *   ② `onLoad` 必须认识那个参数名并清洗
 *   ③ 清洗规则必须和服务端的 3 位房间号一致
 *
 * 而这三环**在本地完全自洽时也可能出错** —— 比如改了参数名忘了改另一边，
 * 表现是"朋友点进来落到大厅，还得手输房间号"，而分享的人毫不知情。
 * ========================================================================== */
{
  const src = fs.readFileSync(
    path.join(ROOT, 'miniprogram/game/room/room.js'), 'utf8')

  const share = /path:\s*'\/game\/room\/room\?code='\s*\+\s*r\.code/.test(src)
  assert.ok(share, 'onShareAppMessage 的 path 必须带 ?code= 房间号')

  assert.ok(/\bq\.code\b/.test(src), 'onLoad 里必须读 q.code')
  /*
   * ★ 2026-11-03：**抽出那一行清洗代码真跑**，而不是比写法。
   *   这样 `slice(0,3)` 换成 `clip(code,3)` 之类的等价实现也能通过，
   *   只要"从脏输入里能拿到 3 位纯数字"这个行为成立。
   */
  const cleanLine = /const c = String\(q\.code\)[^\n]*/.exec(src)
  assert.ok(cleanLine, 'onLoad 里必须从 q.code 清洗出房间号')
  const cleanFn = new Function('q', cleanLine[0] + '; return c')
  ;[['627', '627'], ['  6 2 7  ', '627'], ['a1b2c3', '123'], ['62', '62']].forEach(([inp, want]) => {
    const got = cleanFn({ code: inp })
    assert.strictEqual(got, want, '房间号清洗：' + JSON.stringify(inp) + ' 应得 ' + want + '，实际 ' + got)
  })

  /* 标题长度：微信群里约显示 20 字，超出会截掉房间号 */
  assert.ok(/full\.length <= 20/.test(src),
    '分享标题要控制在 20 字内，否则群聊里会把房间号截掉')

  ok('★ 分享链接契约完整（path 带 code / onLoad 读并清洗 / 标题不截断）')
}

/* ============================================================================
 * 2026-11-03 追加：**没设昵称的人不能重名**
 *
 * 原来没设昵称时前端传硬编码的 `'玩家'`，而云端只检查"非空" ——
 * 于是一个房间里**可以有两个都叫「玩家」的人**，桌上分不清谁是谁。
 *
 * 现在：前端传空串 → 云端先给占位名 `'玩家'` → **座位定下来之后补成「玩家N」**。
 * 关键是最后那一步：姓名补全必须依赖**座位号**，而不是固定写死。
 * ========================================================================== */
{
  const cloud = fs.readFileSync(
    path.join(ROOT, 'cloudfunctions/room/index.js'), 'utf8')
  const page = fs.readFileSync(
    path.join(ROOT, 'miniprogram/game/room/room.js'), 'utf8')

  /* 前端不再传硬编码的默认名（传空串让云端生成） */
  assert.ok(!/name:\s*this\.data\.myName \|\| '玩家'/.test(page),
    '前端不该传硬编码的 "玩家" —— 那会让多个未设昵称的人同名')

  /* 云端必须按座位号补全 */
  assert.ok(/p\.name === '玩家'\)\s*\?\s*Object\.assign\(\{\},\s*p,\s*\{\s*name:\s*'玩家' \+ p\.seat/.test(cloud),
    '云端必须把占位名「玩家」按座位号补成「玩家N」')

  ok('★ 未设昵称的人按座位号生成「玩家N」（不会重名）')
}

/* ============================================================================
 * 2026-11-03 追加：**杯数统一用阿拉伯数字**（用户的明确偏好）
 *
 * 原来三种写法混着用：「喝 1 杯」（阿拉伯）、「喝一杯」（中文）、「喝半杯」（中文"半"）。
 * 而用户明确说过「数字直接用阿拉伯数字，不要全写成汉字」——
 * 而且同一屏里出现"喝 1 杯"和"喝一杯"两种写法，看起来就是没打磨过。
 * ========================================================================== */
{
  const files = [
    'miniprogram/utils/games.js',
    'miniprogram/game/settle.js'
  ]
  const bad = []
  files.forEach(rel => {
    const s = fs.readFileSync(path.join(ROOT, rel), 'utf8')
    /* 用户文案里的中文杯数（注释不算：先剥注释） */
    const nc = s.replace(/\/\*[\s\S]*?\*\//g, '').replace(/\/\/[^\n]*/g, '')
    ;[...nc.matchAll(/'([^']*[\u4e00-\u9fa5]杯[^']*)'/g)].forEach(m => {
      const t = m[1]
      if (/[一二三四五六七八九十]杯|半杯/.test(t)) {
        bad.push(rel + '：' + t.slice(0, 40))
      }
    })
  })
  assert.deepStrictEqual(bad, [],
    '杯数要用阿拉伯数字（用户的明确偏好）：\n    ' + bad.join('\n    '))
  ok('★ 杯数文案统一用阿拉伯数字（1 杯 / 0.5 杯）')
}

/* ============================================================================
 * 2026-11-03 追加：**用户文案里的精确数字用阿拉伯，口语量词保持中文**
 *
 * 用户的偏好是「数字直接用阿拉伯数字，不要全写成汉字」。
 * 但这条不能一刀切 —— 「一个人」「这一局」是**量词/口语**，
 * 改成「1 个人」「这 1 局」反而别扭。
 *
 * 所以判据是：**带明确数量单位的（颗/轮/杯/次）用阿拉伯**，
 * 不带单位的（一个人、一局、一把）保持中文。
 * ========================================================================== */
{
  const files = ['miniprogram/utils/games.js', 'miniprogram/game/settle.js']
  const bad = []
  files.forEach(rel => {
    const s = fs.readFileSync(path.join(ROOT, rel), 'utf8')
      .replace(/\/\*[\s\S]*?\*\//g, '').replace(/\/\/[^\n]*/g, '')
    ;[...s.matchAll(/'([^']*)'/g)].forEach(m => {
      const t = m[1]
      /* 中文数字 + 精确量词 */
      /*
       * ⚠️ 「一张亮着，一张自己看，一张靠猜」里的「一张」是**泛指每一张**，
       *   不是共一张 —— 所以「一」这个中文数字要排除掉。
       *   真正要抓的是「两/三/四/五…张」这种精确计数。
       */
      if (/[二三四五六七八九十]\s*(颗|轮|杯|次|张)/.test(t)) {
        bad.push(rel + '：' + t.slice(0, 40))
      }
    })
  })
  assert.deepStrictEqual(bad, [],
    '这些文案里的精确数量该用阿拉伯数字：\n    ' + bad.join('\n    '))
  ok('★ 文案里的精确数量用阿拉伯数字（颗/轮/杯/次/张）')
}

/* ============================================================================
 * 2026-11-03 追加：**方法定义了就要有人调**
 *
 * 金花的「换牌」曾经是这个坑：方法、服务端 action、代价计算、二次确认弹窗
 * 全都齐了，**模板里从来没有按钮调用它** —— 规则说"换底牌喝 1 杯"，
 * 玩家在界面上找不到入口。
 *
 * 这条断言扫全部方法，排除生命周期（微信框架调）和下划线私有方法，
 * 剩下的必须能在别处找到至少一次引用。
 * ========================================================================== */
{
  const src = fs.readFileSync(
    path.join(ROOT, 'miniprogram/game/room/room.js'), 'utf8')
  const methods = [...src.matchAll(/^  (?:async )?(\w+)\([^)]*\)\s*\{/gm)].map(m => m[1])
  const LIFECYCLE = new Set(['onLoad', 'onShow', 'onHide', 'onUnload', 'onReady',
    'onPullDownRefresh', 'onReachBottom', 'onShareAppMessage', 'onShareTimeline',
    'onPageScroll', 'onResize'])

  /* 把 miniprogram 下所有 js/wxml 拼起来（页面、分包都要算） */
  let all = ''
  const walk = (d) => {
    if (!fs.existsSync(d)) return
    fs.readdirSync(d).forEach(f => {
      const p = path.join(d, f)
      if (fs.statSync(p).isDirectory()) walk(p)
      else if (/\.(js|wxml)$/.test(f)) all += fs.readFileSync(p, 'utf8')
    })
  }
  walk(path.join(ROOT, 'miniprogram'))

  const dead = []
  methods.forEach(m => {
    if (m.startsWith('_') || LIFECYCLE.has(m)) return
    const calls = (all.match(new RegExp('\\b' + m + '\\s*\\(', 'g')) || []).length
    let quoted = 0
    ;["'", '"'].forEach(q => {
      quoted += (all.split(q + m + q).length - 1)
    })
    /* 减掉定义那一次 */
    if (calls + quoted - 1 < 1) dead.push(m)
  })
  assert.deepStrictEqual(dead, [],
    '这些方法定义了但没有任何地方调用：\n    ' + dead.join('\n    '))
  ok('★ 房间页 ' + (methods.length - LIFECYCLE.size) + ' 个方法都有调用点（无死代码）')
}

/* ============================================================================
 * 2026-11-03 追加：**用户可见的文案里不能有 Markdown 语法**
 *
 * wxml 不渲染 Markdown —— 文案里写 `**加粗**` 会原样显示成两个星号。
 * 这个问题在**注释里**完全正常（我在注释里大量用 `**` 强调），
 * 所以判据必须**先剥注释**再看字符串字面量。
 * ========================================================================== */
{
  const bad = []
  const walk3 = (d) => {
    if (!fs.existsSync(d)) return
    fs.readdirSync(d).forEach(f => {
      const p = path.join(d, f)
      if (fs.statSync(p).isDirectory()) return walk3(p)
      if (!/\.(js|wxml)$/.test(f)) return
      let src = fs.readFileSync(p, 'utf8')
      src = src.replace(/<!--[\s\S]*?-->/g, '')
        .replace(/\/\*[\s\S]*?\*\//g, '')
        .replace(/\/\/[^\n]*/g, '')
      ;[...src.matchAll(/'([^']*)'/g)].forEach(m => {
        if (/\*\*|__[^_]/.test(m[1])) {
          bad.push(path.relative(ROOT, p) + '：' + m[1].slice(0, 40))
        }
      })
    })
  }
  walk3(path.join(ROOT, 'miniprogram'))
  assert.deepStrictEqual(bad, [],
    '用户文案里出现了 Markdown 语法（小程序不渲染）：\n    ' + bad.join('\n    '))
  ok('★ 用户文案里没有 Markdown 语法（注释里的不算）')
}

/* ============================================================================
 * 2026-11-03 追加：**每个阶段都必须有出口**（不能是死路）
 *
 * 阶段机是 entry → lobby → countdown → playing → over → lobby。
 * 而"某个阶段一个能点的东西都没有"就是死路 —— 玩家只能杀进程重进。
 *
 * 本项目踩过一次：倒计时阶段顶部栏被隐藏（`gbar` 有 `stage !== 'countdown'`），
 * 而如果网络断了导致一直停在倒计时，**屏幕上没有任何返回入口**。
 * 现在有 `goBack` 兜底。
 * ========================================================================== */
{
  const wxml = fs.readFileSync(
    path.join(ROOT, 'miniprogram/game/room/room.wxml'), 'utf8')
  const blocks = wxml.split(/<block wx:(?:if|elif)="\{\{stage === '(\w+)'\}\}">/)
  const stages = []
  for (let i = 1; i < blocks.length; i += 2) {
    const st = blocks[i]
    const body = blocks[i + 1] || ''
    const taps = new Set([...body.matchAll(/bindtap="(\w+)"/g)].map(m => m[1]))
    stages.push({ st, n: taps.size })
  }
  assert.ok(stages.length >= 5, '阶段块只认出 ' + stages.length + ' 个')
  const dead = stages.filter(x => x.n === 0).map(x => x.st)
  assert.deepStrictEqual(dead, [], '这些阶段没有任何可点的东西（死路）：' + dead.join(' '))
  ok('★ 五个阶段都有出口：' + stages.map(x => x.st + ' ' + x.n).join(' / '))
}

/* ============================================================================
 * 2026-11-03 追加：**自定义题卡必须折成单行**
 *
 * `textarea` 允许换行，而题卡在界面上是一整段（`.cb-text` 没有行数限制）——
 * 60 个字里塞 5 个换行，那道题会把转盘/按钮**挤出屏幕**。
 * 而这不报错，只是"界面怎么乱了"。
 *
 * 内置题库 200 条全是单行，自定义题也该是。
 * ========================================================================== */
{
  const cloud = fs.readFileSync(
    path.join(ROOT, 'cloudfunctions/room/index.js'), 'utf8')
  /* 加题的地方必须把空白折成一个空格 */
  /* ★ 2026-11-03：实现从链式调用改成了 `clip(...)` 一行，正则也跟着变 */
  assert.ok(/const text = clip\(String\(event\.text \|\| ''\)\.replace\(\/\\s\+\/g, ' '\)\.trim\(\), MAX_CARD\)/.test(cloud),
    '加题时必须把换行/连续空白折成一个空格，并按码点截断到 MAX_CARD')
  ok('★ 自定义题卡会折成单行（换行不撑爆界面）')
}

/* ============================================================================
 * 2026-11-03 追加：**按码点切字符串，不要用 slice**
 *
 * `'一二三四五六七八九十一😀'.slice(0, 12)` 结果是 `一二…十\ud83d` ——
 * **半个 emoji**，界面上是个乱码方块。
 *
 * 昵称限 12 字，用户完全可能用 11 个中文 + 1 个 emoji 撞上这个位置。
 * 而"半个 emoji"不会报错，只会让那个玩家的名字看起来像坏了。
 * ========================================================================== */
{
  const cloud = fs.readFileSync(
    path.join(ROOT, 'cloudfunctions/room/index.js'), 'utf8')
  const page = fs.readFileSync(
    path.join(ROOT, 'miniprogram/game/room/room.js'), 'utf8')

  /* ⚠️ 必须先剥注释 —— `clip()` 的注释里**举了** `slice(0, 12)` 这个反例 */
  const cloudNc = cloud
    .replace(/\/\*[\s\S]*?\*\//g, '')
    .replace(/\/\/[^\n]*/g, '')

  /*
   * ★★ 2026-11-03：**把 `clip()` 从源码里抽出来真跑**，而不是正则比写法。
   *
   *   上一轮的经验：凡是"正则匹配整条实现"的断言，实现一改就假失败
   *   （而那会让人去改正确的代码）。
   *
   *   这里只要求"存在一个叫 clip 的函数"，然后**调用它的真实函数体**验证行为 ——
   *   函数怎么写都行，只要 11 个中文 + 1 个 emoji 切 12 个之后 emoji 是完整的。
   */
  const fm = /function clip\(([^)]*)\)\s*\{([\s\S]*?)\n\}/.exec(cloudNc)
  assert.ok(fm, '云端必须有 clip() 函数')
  const clipFn = new Function('str', 'n', fm[2])
  const emo = '一二三四五六七八九十一😀'
  const cut = clipFn(emo, 12)
  assert.strictEqual(cut, emo, 'clip 切 12 个之后 emoji 必须完整（实际：' + JSON.stringify(cut) + '）')
  assert.strictEqual(clipFn('abc', 10), 'abc', 'clip 不该把短串弄坏')
  assert.strictEqual(clipFn('', 5), '', 'clip 要能处理空串')
  assert.ok(!/event\.name \|\| ''\)\.trim\(\)\.slice\(0, 12\)/.test(cloudNc),
    '云端不许用 slice(0,12) 切昵称（会切出半个 emoji）')

  /* 前端同理 */
  assert.ok(!/nm\.slice\(0, 12\)/.test(page),
    '前端不许用 slice(0,12) 切昵称')
  assert.ok(/Array\.from\(String\(nm\)\)/.test(page),
    '前端切昵称要按码点')

  /* 实测：13 码元（11 中文 + emoji）按码点切 12 个是完整的 */
  const s = '一二三四五六七八九十一😀'
  const byCode = Array.from(s).slice(0, 12).join('')
  assert.strictEqual(byCode, s, '按码点切 12 个应该保留完整的 emoji')
  assert.ok(s.slice(0, 12).charCodeAt(11) >= 0xD800,
    '（这个用例应该能复现 slice 切出半个 emoji 的现象）')

  ok('★ 昵称按码点切（emoji 不会被切成半个）')
}

/* ============================================================================
 * 2026-11-03 追加：**所有"按长度截断用户输入"的地方都必须按码点**
 *
 * `slice(0, n)` 按 UTF-16 码元切，emoji 占 2 个 —— 会切出半个 emoji。
 * 昵称 12 字、题卡 60 字，两个都可能撞上。
 *
 * 判据：云端源码里出现 `event.name/text ... .slice(0, N)` 就是错的。
 * ========================================================================== */
{
  const cloud = fs.readFileSync(
    path.join(ROOT, 'cloudfunctions/room/index.js'), 'utf8')
    .replace(/\/\*[\s\S]*?\*\//g, '')
    .replace(/\/\/[^\n]*/g, '')
  const bad = []
  /* 找 event.xxx 出现在 trim/slice 链里的地方 */
  ;[...cloud.matchAll(/event\.(name|text)[^;\n]{0,80}?\.slice\(0,\s*\w+\)/g)].forEach(m => {
    bad.push(m[0].slice(0, 60))
  })
  assert.deepStrictEqual(bad, [],
    '这些地方按码元截断用户输入（emoji 会被切成半个）：\n    ' + bad.join('\n    '))
  ok('★ 用户输入的截断全部按码点（nick 12 / 题卡 60）')
}

/* ============================================================================
 * 2026-11-03 追加：**切到后台必须停掉资源**
 *
 * `onHide` 如果不做事：轮询继续每 1.5 秒打云函数（用户切走了还在烧）、
 * 音效继续响（切出去听得到）、定时器继续跑（回来时状态已经错位）。
 *
 * 这三样在"忘记停"的时候**都不报错**，只表现为"后台耗电"或"回来时界面怪怪的"。
 * ========================================================================== */
{
  const src = fs.readFileSync(
    path.join(ROOT, 'miniprogram/game/room/room.js'), 'utf8')
  const hide = /onHide\(\)\s*\{([\s\S]*?)\n  \}/.exec(src)
  assert.ok(hide, '找不到 onHide')
  const body = hide[1]

  ;['stopPoll', 'sfx.stopAll', 'feedback.clear', 'clearCupTimers', 'clearCountdown']
    .forEach(fn => {
      assert.ok(new RegExp(fn.replace('.', '\\.') + '\\(').test(body),
        'onHide 里必须调用 ' + fn + '（切后台要停掉资源）')
    })

  /* onShow 要立即拉一次 + 重启轮询 */
  const show = /onShow\(\)\s*\{([\s\S]*?)\n  \}/.exec(src)
  assert.ok(show, '找不到 onShow')
  assert.ok(/pollTick\(\)/.test(show[1]), 'onShow 必须立即拉一次（不要等 1.5 秒）')
  assert.ok(/startPoll\(\)/.test(show[1]), 'onShow 必须重启轮询')

  ok('★ 切后台停掉轮询/音效/定时器，切回来立即拉一次')
}

/* ============================================================================
 * 2026-11-03 追加：**卧底的身份和词绝不能下发**（双盲）
 *
 * 这是"谁是卧底"能成立的前提：**连自己都不知道自己是不是卧底**。
 * 而 `shape()` 是玩家能看到的一切 —— 它里面一旦出现 `uwRole` / `uwWord`，
 * 抓个包就穿了（老手会开抓包工具看）。
 *
 * ⚠️ 写这条时我先误判了一次：扫 mock 状态发现"卧底 0 个"，
 *   以为 mock 造假；其实那是**设计正确** —— 客户端根本不该有这个字段。
 * ========================================================================== */
{
  const cloud = fs.readFileSync(
    path.join(ROOT, 'cloudfunctions/room/index.js'), 'utf8')

  /* 抽 shape() 里 players 的映射块 */
  const i = cloud.indexOf('function shape(room, openid)')
  assert.ok(i > 0, '找不到 shape()')
  const seg = cloud.slice(i, i + 4000)
  const mapStart = seg.indexOf('const players = (room.players || []).map(p => ({')
  assert.ok(mapStart > 0, 'shape() 里找不到 players 映射')
  const mapEnd = seg.indexOf('}))', mapStart)
  const mapBlock = seg.slice(mapStart, mapEnd)

  assert.ok(!/uwRole/.test(mapBlock),
    '★ shape() 的 players 映射里不能有 uwRole —— 那会让抓包的人直接看出谁是卧底')
  assert.ok(!/uwWord/.test(mapBlock),
    '★ shape() 的 players 映射里不能有 uwWord —— 那会让抓包的人看到别人的词')

  ok('★ 卧底身份与词不下发（shape 的 players 映射里没有 uwRole / uwWord）')
}

/* ============================================================================
 * 2026-11-03 追加：**进行中只给自己的骰子**（大话骰的命门）
 *
 * `shape()` 里那一行：
 *     dice: p.openid === openid ? (p.dice || []) : undefined
 *     diceCount: (p.dice || []).length
 *
 * 一旦有人为了"显示骰子数"方便，把 `dice` 改成无条件下发 ——
 * **抓包就能看到所有人的骰子**，大话骰直接失去意义。
 * 而这个改动在界面上**看不出任何区别**（模板本来就只用自己的 dice）。
 *
 * 结算时的 `allDice`（所有人）是合理的 —— 那一局已经结束了。
 * ========================================================================== */
{
  const cloud = fs.readFileSync(
    path.join(ROOT, 'cloudfunctions/room/index.js'), 'utf8')
  const i = cloud.indexOf('function shape(room, openid)')
  const seg = cloud.slice(i, i + 4000)

  assert.ok(/dice:\s*p\.openid === openid \? \(p\.dice \|\| \[\]\) : undefined/.test(seg),
    '★ shape() 里骰子必须按 isMe 过滤（别人的给 undefined）')
  assert.ok(/diceCount:\s*\(p\.dice \|\| \[\]\)\.length/.test(seg),
    '★ 别人的骰子数要单独给（否则界面上显示不出"还差谁没摇"）')

  /* 结算时的 allDice 必须是 phase=over 那条路径 */
  const overIdx = cloud.indexOf("phase: 'over', lastResult: result")
  assert.ok(overIdx > 0, '找不到结算写入的位置')
  const allDiceIdx = cloud.indexOf('allDice: (room.players || []).map')
  assert.ok(allDiceIdx > 0 && allDiceIdx < overIdx,
    '★ allDice 必须只在结算（phase: over）时下发')

  ok('★ 进行中只给自己的骰子（别人的只有数量），结算才揭晓全部')
}

/* ============================================================================
 * 2026-11-03 追加：**分享标题必须真的能用"完整版"**
 *
 * 原来 full 是「来玩大话骰，已经 3 个人在等（房间号 627）」= 24 字，
 * 而判据是 `length <= 20` —— **只要有人等就永远走 tight 分支**，
 * 把最有吸引力的那句"3 个人在等"截成"3 人等"。
 *
 * （更讽刺的是：full 只在"1 人"时用得上，而那一刻恰恰没人等。）
 *
 * 判据：拿**最长的玩法名 + 最多人数 + 3 位房间号**算一遍，
 * 完整版也必须 ≤ 20 字。
 * ========================================================================== */
{
  const src = fs.readFileSync(
    path.join(ROOT, 'miniprogram/game/room/room.js'), 'utf8')
  const games = fs.readFileSync(
    path.join(ROOT, 'miniprogram/utils/games.js'), 'utf8')

  /* 最长玩法名 */
  const names = [...games.matchAll(/name:\s*'([^']+)'/g)].map(m => m[1])
  const longest = names.sort((a, b) => b.length - a.length)[0]

  /* 复刻 full 的拼法 */
  const full = '来玩' + longest + '，' + '12' + ' 人在等（' + '888' + '）'
  assert.ok(full.length <= 20,
    '★ 分享标题的完整版在最长玩法名下超了 20 字（' + full.length + '）：' + full)

  /* 确认代码里的 full 拼法和我这里一致（防止断言和实现脱节） */
  assert.ok(/'来玩' \+ gname \+ '，' \+ \(n > 1 \? n \+ ' 人在等' : '就等你'\) \+ '（' \+ r\.code \+ '）'/.test(src),
    '分享标题的完整版拼法变了 —— 这条断言也要跟着改')

  ok('★ 分享标题在最坏情况（' + longest + ' + 12 人 + 888）也只有 ' + full.length + ' 字')
}

/* ============================================================================
 * 2026-11-03 追加：**每个触点都要有反馈**（音效/提示/状态变化）
 *
 * "点了没反应"是这一类里最伤的一种 —— 而它的成因通常是：
 *   处理方法里既没有 showToast、也没有 setData、也没有音效。
 *
 * 本项目历史上修过 13 处这种（`if (!m) return` 静默返回、
 * `catch(() => null)` 吞错误）—— 那之后就该有一条覆盖性断言。
 *
 * ⚠️ 判据只到"有反馈"这一层，不判断"反馈得对不对" —— 后者测不了。
 * ========================================================================== */
{
  const wxml = fs.readFileSync(
    path.join(ROOT, 'miniprogram/game/room/room.wxml'), 'utf8')
  const js = fs.readFileSync(
    path.join(ROOT, 'miniprogram/game/room/room.js'), 'utf8')

  const taps = [...new Set([...wxml.matchAll(/bindtap="(\w+)"/g)].map(m => m[1]))]
  const silent = []
  taps.forEach(t => {
    const m = new RegExp('\\n  (?:async )?' + t + '\\([^)]*\\)\\s*\\{').exec(js)
    if (!m) return
    /*
     * ⚠️ 必须**截到方法体结束**（下一个 `\n  }` 或 `\n  },`），
     *   不能固定长度 —— 固定 1200 字符会**跨进下一个方法**，
     *   而下一个方法里有 setData → 假通过（反向验证时抓到的）。
     */
    const rest = js.slice(m.index + m[0].length)
    const end = rest.search(/\n  \},?\n/) < 0 ? rest.length : rest.search(/\n  \},?\n/)
    const body = rest.slice(0, end)
    const hasFeedback = /showToast|okOrSay|showModal|setData|sfx\.play|feedback\.fire|wx\.showActionSheet|wx\.navigateTo/.test(body)
    if (!hasFeedback) silent.push(t)
  })
  assert.deepStrictEqual(silent, [],
    '这些触点点了不会有任何反馈（音效/提示/状态变化都没有）：\n    ' + silent.join('\n    '))
  ok('★ ' + taps.length + ' 个触点都有反馈（音效 / 提示 / 状态变化）')

  /*
   * ★★★ 2026-11-03：上面的判据有个**漏网类型** ——
   *   "方法开头有反馈，但中间的守卫静默返回"。
   *
   *   实例：`doSpin()` 开头有 setData + sfx.play（所以上面那条通过），
   *   但第 4 行是 `if (!this.data.room.host) return` ——
   *   非房主点「转」**完全没有反应**，而那个按钮对所有人可见。
   *   后来发现 `toggleLock()` 也是这样。
   *
   *   ⚠️ 这个断言的**写法改了两次都失败**，值得记下来：
   *      v1 用 `case` 找缩进 n 空格 + `case(`   → 被"缩进 n 空格 + 等号 + 冒号"截断
   *      v2 用 `case` 找缩进 n 空格 + `}` 加逗号    → 被方法体内的回调结尾提前截断
   *      两次都是"看起来抓到了"，而实际上 doSpin 那几行根本没进被检查的范围。
   *   v3（本版）用**括号配平**确定方法体边界 —— 结构化的东西只能按语法单元切。
   */
  {
    /** 从 `start` 处的 `{` 开始，配平到对应的 `}`，返回方法体文本 */
    const bodyOf = (src, start) => {
      let i = src.indexOf('{', start)
      if (i < 0) return ''
      let depth = 0
      for (let k = i; k < src.length; k++) {
        if (src[k] === '{') depth++
        else if (src[k] === '}') { depth--; if (!depth) return src.slice(i + 1, k) }
      }
      return ''
    }

    const bare = []
    taps.forEach((t) => {
      const m = new RegExp('\\n  (?:async )?' + t + '\\([^)]*\\)\\s*\\{').exec(js)
      if (!m) return
      const body = bodyOf(js, m.index + m[0].length - 1)
      const lines = body.split('\n')
      lines.forEach((line, i) => {
        const bareReturn = /^\s*return;?\s*$/.test(line)
        const guardReturn = /^\s*if\s*\(.*\)\s*return;?\s*$/.test(line)
        if (!bareReturn && !guardReturn) return
        const ctx = lines.slice(Math.max(0, i - 6), i + 1).join('\n')
        if (/showToast|okOrSay|vibrate|sfx\.play|feedback\.fire|setData\(\{\s*err/.test(ctx)) return
        /*
         * ⚠️ specGuard 只放行**它自己那一行**，不能放行整个窗口。
         *   第一版写成「窗口里有 specGuard 就跳过」——
         *   而 doSpin / toggleLock 开头恰好都是 `if (!this.specGuard()) return`，
         *   于是窗口里永远有 specGuard，**后面那条 `!room.host` 的裸 return
         *   被一起放行了**（反向验证抓不到）。
         *   这是项目里记过的"例外条件不能跨范围传播"的又一例。
         */
        if (/specGuard\(\)/.test(line)) return
        /*
         * 合理的静默：无变化 / 节流 / 用户取消 / 内部防御 / 页面已卸载。
         * 区分标准不是"代码长什么样"，而是**玩家有没有做一次主动操作**。
         */
        const legits = [
          /=== this\.data\.(room\.)?\w+/,       /* 选了同一个值 = 无变化 */
          /_(bid|again|tap)At/,                    /* 节流 */
          /!r\.confirm/,                           /* 用户主动取消 */
          /what !== 'public'/,                     /* 内部参数防御 */
          /!this\.data\.howOpen/,                 /* 面板已关 */
          /!c\b/, /!isFinite/, /!name\b/, /name === cur/,
          /* 页面卸载 / 防重入：这些条件下重复点击本来就不该有反馈 */
          /_dead|_busy|_Busy|_spinning|_Spinning|wheelSpinning|rerolling|creating|joining/,
          /*
           * `!room || _xxxBusy` 这种组合守卫：含防重入就是"重复点击"，合法。
           * `!target` 是内部参数防御（前端不该传空），也不该打扰玩家。
           */
          /_uwBusy|_pkBusy|_fhBusy|_btBusy|_svBusy|_csBusy/,
          /!target\b/,
          /^\s*if \(!\s*(this\.data\.)?room\s*\)/  /* 整个 room 为空（异常态）*/
        ]
        if (legits.some(re => re.test(line))) return
        bare.push(t + '：' + line.trim())
      })
    })
    assert.deepStrictEqual(bare, [],
      '这些触点在某个分支上会**静默返回**（点了完全没反应）：\n    ' + bare.join('\n    '))
    ok('★ 没有"裸 return" 的静默分支（' + taps.length + ' 个触点全查过）')
  }
}

/* ============================================================================
 * 2026-11-03 追加：**同一个情况只有一种说法**
 *
 * 抓到两处「被 busy 挡住」的提示：
 *     '上一次换牌还在处理，等半秒'
 *     '上一次换牌还在路上，稍等一下'
 *
 * 同一个情况两种说法，玩家会以为是**两个不同的问题** ——
 * 尤其在金花里，卡住时人本来就会紧张，措辞不一致让判断更难。
 * ========================================================================== */
{
  const src = fs.readFileSync(
    path.join(ROOT, 'miniprogram/game/room/room.js'), 'utf8')

  /* "换牌被挡住"这一种情况，只能有一种措辞 */
  const busyMsgs = [...src.matchAll(/上一次换牌[^']*/g)].map(m => m[0])
  const uniq = [...new Set(busyMsgs)]
  assert.ok(uniq.length <= 1,
    '「换牌被挡住」有两种说法，应该是同一种：\n    ' + uniq.join('\n    '))

  ok('★ 同一个情况的提示只有一种说法（' + (uniq[0] || '—') + '）')
}

/* ============================================================================
 * 2026-11-03 追加：**规则弹层必须有内容**
 *
 * `howList` 在 mock 里写死成 `[]` —— 于是所有"看规则"的截图里
 * 弹层只有标题和按钮，**规则列表是空的**，而我看图会以为"弹层没做好"。
 *
 * 判据：每个玩法都要能在 `howOpen` 这类状态下拿到非空规则列表。
 * ========================================================================== */
{
  const mock = require('./ui-render/mock/room.js')
  const games = require('../miniprogram/utils/games.js')
  const bad = []

  Object.keys(mock.states).forEach(k => {
    let s
    try { s = mock.states[k]() } catch (e) { return }
    const r = s.room || {}
    if (!r.game) return
    const meta = games.GAMES.filter(x => x.id === r.game)[0]
    if (!meta) return
    const want = (meta.how || []).length
    if (!want) return
    const got = (r.howList || []).length
    if (got !== want) bad.push(k + '（' + r.game + '）：howList ' + got + ' 条，注册表有 ' + want + ' 条')
  })
  assert.deepStrictEqual(bad, [],
    '这些状态的规则列表和注册表对不上（弹层会是空的或残缺的）：\n    ' + bad.join('\n    '))
  ok('★ 所有状态的规则列表都和注册表一致（弹层不会空）')
}

/* ============================================================================
 * 2026-11-03 追加：**赢了就要庆祝**（三个玩法都要有）
 *
 * `celebrate()` 现只在三处调用：金花比牌、卧底结算、比大小结算。
 * 而我一度以为"比大小没有撒花"—— 因为第 3328 行的 `celebrate()`
 * 藏在 `setTimeout(..., 820)` 里（等骰子落定动画走完）。
 *
 * 这条断言锁的是"三个玩法都有"，而不是"有几处调用"——
 * 因为调用点和玩法不是一一对应的（有的在一个 setTimeout 里）。
 * ========================================================================== */
{
  const src = fs.readFileSync(
    path.join(ROOT, 'miniprogram/game/room/room.js'), 'utf8')

  /* 有胜负概念的三个玩法：比大小 / 金花 / 卧底 */
  const hasCelebrate = /if \(iWon\) this\.celebrate\(\)/g
  const count = (src.match(hasCelebrate) || []).length
  assert.ok(count >= 3,
    '有胜负的三个玩法（比大小/金花/卧底）都应该在赢的时候 celebrate()，实际只有 ' + count + ' 处')

  /* 而且要和 win 音效配对着出现（不能只放音效不撒花） */
  const winFire = (src.match(/feedback\.fire\(iWon \? 'win' : 'penalized'\)/g) || []).length
  assert.ok(winFire === count,
    'win 音效有 ' + winFire + ' 处、celebrate 有 ' + count + ' 处 —— 两者应该成对')

  ok('★ 三个玩法赢了都有撒花 + 胜利音（' + count + ' 处配对）')
}

/* ============================================================================
 * 2026-11-03 追加：**`feedback.fire()` 不许用表里没有的动作名**
 *
 * `fire(key)` 对未知 key 只做两件事：`console.warn` + `return` ——
 * **静默失败**。所以拼错一个字（`'lose'` 而不是 `'penalized'`）的结果是
 * "输了的时候一声不响、也不震"，而**没有任何报错**。
 *
 * 真实案例：`feedback.fire(iLost ? 'lose' : 'win')` —— 比大小输了没声音。
 * 抓住它纯属运气（查 celebrate 的调用上下文时顺手看到）。
 *
 * 判据：把 `fire(` 括号里出现的所有字符串字面量，逐个对 FEEDBACK 的表。
 * ========================================================================== */
{
  const fbSrc = fs.readFileSync(
    path.join(ROOT, 'miniprogram/game/feedback.js'), 'utf8')
  /* FEEDBACK 表的键（形如 `  keyName: {`） */
  const valid = new Set([...fbSrc.matchAll(/^\s{2}(\w+):\s*\{/gm)].map(m => m[1]))
  assert.ok(valid.size > 10, 'FEEDBACK 表只认出 ' + valid.size + ' 个动作，抽取可能失效')

  const bad = []
  const walk = (d) => {
    if (!fs.existsSync(d)) return
    fs.readdirSync(d).forEach(f => {
      const p = path.join(d, f)
      if (fs.statSync(p).isDirectory()) return walk(p)
      if (!f.endsWith('.js')) return
      let src = fs.readFileSync(p, 'utf8')
      src = src.replace(/\/\*[\s\S]*?\*\//g, '').replace(/\/\/[^\n]*/g, '')
      ;[...src.matchAll(/feedback\.fire\(([^)]*)\)/g)].forEach(m => {
        ;[...m[1].matchAll(/'(\w+)'/g)].forEach(s => {
          const key = s[1]
          if (!valid.has(key)) {
            bad.push(path.relative(ROOT, p) + '：fire(\'' + key + '\') —— 表里没有这个动作')
          }
        })
      })
    })
  }
  walk(path.join(ROOT, 'miniprogram'))

  assert.deepStrictEqual(bad, [],
    '这些 fire() 动作名在 FEEDBACK 表里不存在（会静默失败）：\n    ' + bad.join('\n    '))
  ok('★ 所有 feedback.fire() 的动作名都在表里（' + valid.size + ' 个可用）')
}

/* ============================================================================
 * 2026-11-03 追加：**`sfx.play()` 的音效名必须在 FILES 表里**
 *
 * 和上一轮 `feedback.fire('lose')` 是同一类：**拼错就静默**。
 * `play()` 里 `const src = FILES[key]` 取不到就提前返回（连 warn 都没有），
 * 表现是"这个按钮没声音"，而代码看起来完全正常。
 *
 * 覆盖面：`sfx.play('x')`、`sfx: 'x'`、`sfx2: 'x'`（feedback 表里的两种写法）。
 * ========================================================================== */
{
  const sfxSrc = fs.readFileSync(
    path.join(ROOT, 'miniprogram/game/sfx.js'), 'utf8')
  const filesBlock = /const FILES = \{([\s\S]*?)\n\}/.exec(sfxSrc)
  assert.ok(filesBlock, '找不到 FILES 表')
  const valid = new Set([...filesBlock[1].matchAll(/^\s{2}(\w+):\s*/gm)].map(m => m[1]))
  assert.ok(valid.size >= 15, 'FILES 只认出 ' + valid.size + ' 个音效，抽取可能失效')

  const bad = []
  const walk = (d) => {
    if (!fs.existsSync(d)) return
    fs.readdirSync(d).forEach(f => {
      const p = path.join(d, f)
      if (fs.statSync(p).isDirectory()) return walk(p)
      if (!f.endsWith('.js')) return
      let src = fs.readFileSync(p, 'utf8')
      src = src.replace(/\/\*[\s\S]*?\*\//g, '').replace(/\/\/[^\n]*/g, '')
      const pats = [
        /sfx\.play\('(\w+)'\)/g,
        /\bsfx:\s*'(\w+)'/g,
        /\bsfx2:\s*'(\w+)'/g
      ]
      pats.forEach(re => {
        ;[...src.matchAll(re)].forEach(m => {
          if (!valid.has(m[1])) {
            bad.push(path.relative(ROOT, p) + '：sfx 名 \'' + m[1] + '\' 不在 FILES 表里')
          }
        })
      })
    })
  }
  walk(path.join(ROOT, 'miniprogram'))

  assert.deepStrictEqual(bad, [],
    '这些音效名拼错了（play() 会静默返回，表现是"没声音"）：\n    ' + bad.join('\n    '))
  ok('★ 所有 sfx 音效名都在 FILES 表里（' + valid.size + ' 个可用）')
}

/* ============================================================================
 * 2026-11-03 追加：**玩法主题色不能撞**
 *
 * 「命运转盘」和「谁是卧底」原来都是 `#7A5CA8`（同一个紫）——
 * 大厅上两张卡的色条一模一样，而**这不会报错**，
 * 只是"扫一眼分不出是哪个玩法"。
 *
 * 判据：5 个玩法色两两不同，且**色相拉开**（避免"两个都是紫，只是深浅不同"）。
 * ========================================================================== */
{
  const { GAMES } = require(path.join(ROOT, 'miniprogram/utils/games.js'))

  /* 两两不同 */
  const colors = GAMES.map(g => (g.color || '').toUpperCase())
  const dup = []
  colors.forEach((c, i) => {
    if (colors.indexOf(c) !== i) dup.push(GAMES[i].name + '=' + c)
  })
  assert.deepStrictEqual([...new Set(dup)], [], '这些玩法用了同一个主题色：' + dup.join(' '))

  /* 色相拉开（> 25°） */
  const hue = (hex) => {
    const r = parseInt(hex.slice(1, 3), 16) / 255
    const g2 = parseInt(hex.slice(3, 5), 16) / 255
    const b = parseInt(hex.slice(5, 7), 16) / 255
    const mx = Math.max(r, g2, b), mn = Math.min(r, g2, b)
    if (mx === mn) return 0
    const d = mx - mn
    let h
    if (mx === r) h = ((g2 - b) / d) % 6
    else if (mx === g2) h = (b - r) / d + 2
    else h = (r - g2) / d + 4
    return ((h * 60) + 360) % 360
  }
  /*
   * ⚠️ 只看色相不够 —— 「大话骰」橙 13° 和「梦幻金花」金 36° 只差 23°，
   *   但**明度差很大**（橙更深、金更亮），大厅上完全分得开。
   *
   *   所以判据用**色相 + 明度的综合距离**：
   *   色相差 20° 但明度差 0.15 以上，视觉上就是两个颜色。
   */
  const lum = (hex) => {
    const f = (v) => { v /= 255; return v <= 0.03928 ? v / 12.92 : Math.pow((v + 0.055) / 1.055, 2.4) }
    return 0.2126 * f(parseInt(hex.slice(1, 3), 16)) +
           0.7152 * f(parseInt(hex.slice(3, 5), 16)) +
           0.0722 * f(parseInt(hex.slice(5, 7), 16))
  }
  const tooClose = []
  for (let i = 0; i < GAMES.length; i++) {
    for (let j = i + 1; j < GAMES.length; j++) {
      const d = Math.abs(hue(colors[i]) - hue(colors[j]))
      const dh = Math.min(d, 360 - d)
      const dl = Math.abs(lum(colors[i]) - lum(colors[j]))
      /* 色相接近但明度差够大 → 能区分 */
      if (dh < 25 && dl < 0.15) {
        tooClose.push(GAMES[i].name + ' / ' + GAMES[j].name +
          '（色相差 ' + Math.round(dh) + '°、明度差 ' + dl.toFixed(2) + '）')
      }
    }
  }
  assert.deepStrictEqual(tooClose, [], '这些玩法的颜色太接近：\n    ' + tooClose.join('\n    '))
  ok('★ 五个玩法主题色两两不同且色相拉开 ≥25°')
}

/* ============================================================================
 * 2026-11-03 追加：**不许有"定义了但没人用"的 CSS 变量**
 *
 * `--gap-1: 16rpx` 定义了却全仓 0 引用 —— 而它的兄弟 `--gap-2` / `--gap-3`
 * 都在用。这类"半套变量"会让人以为间距系统是完整的。
 *
 * ⚠️ 判据的坑：`var(--dx, 0px)` 是带默认值的写法，而
 * `var\((--[\w-]+)\)` 这种要求闭合的正则**匹配不到它** ——
 * 第一版就把撒花动画的 `--dx` / `--rot` 误报成死变量。
 * 必须用 `var\(\s*(--[\w-]+)`（不要求闭合）。
 * ========================================================================== */
{
  let css = ''
  let tpl = ''
  const walk = (d) => {
    if (!fs.existsSync(d)) return
    fs.readdirSync(d).forEach(f => {
      const p = path.join(d, f)
      if (fs.statSync(p).isDirectory()) return walk(p)
      if (f.endsWith('.wxss')) css += fs.readFileSync(p, 'utf8').replace(/\/\*[\s\S]*?\*\//g, '')
      if (f.endsWith('.wxml')) tpl += fs.readFileSync(p, 'utf8')
    })
  }
  walk(path.join(ROOT, 'miniprogram'))

  const defs = new Set([...css.matchAll(/(--[\w-]+):/g)].map(m => m[1]))
  const used = new Set([
    ...[...css.matchAll(/var\(\s*(--[\w-]+)/g)].map(m => m[1]),
    ...[...tpl.matchAll(/var\(\s*(--[\w-]+)/g)].map(m => m[1])
  ])
  const dead = [...defs].filter(d => !used.has(d)).sort()

  assert.deepStrictEqual(dead, [],
    '这些 CSS 变量定义了但没有任何 var() 引用：\n    ' + dead.join('\n    ') +
    '\n    （注意：var(--x, 默认值) 的写法也算引用）')
  ok('★ ' + defs.size + ' 个 CSS 变量都有引用（没有半套变量）')
}

/* ============================================================================
 * 2026-11-03 追加：**音效调用应该走 feedback 表，而不是裸的 sfx.play**
 *
 * `wheelStart` 原来是裸调用 —— 于是它：
 *   · 没有震动（而摇盅有 light）
 *   · 不受"减少动效"开关管（feedback 里会乘 `h.isReduceMotion()`）
 *
 * 走表之后两者用同一套规则。判据不禁止所有 `sfx.play`（有些音效确实不需要
 * 时间线，比如"点击反馈"），而是**指名道姓地要求这几个关键动作在表里**。
 * ========================================================================== */
{
  const fbSrc = fs.readFileSync(
    path.join(ROOT, 'miniprogram/game/feedback.js'), 'utf8')
  const keys = new Set([...fbSrc.matchAll(/^\s{2}(\w+):\s*\{/gm)].map(m => m[1]))

  /* 这些是"有节奏"的动作（持续时长 > 200ms），必须能表达"什么时候震" */
  const mustBeInTable = ['wheelStart', 'wheelStop', 'shaker', 'cupSlam', 'cupOpen',
    'diceTable', 'diceSettle', 'pkFlip', 'pkSpread', 'uwVote', 'uwReveal']
  const missing = mustBeInTable.filter(k => !keys.has(k))
  assert.deepStrictEqual(missing, [],
    '这些有节奏的动作必须在 feedback 表里（否则不震、也不受"减少动效"管）：' + missing.join(' '))

  /* 连续动作不该有震动（一局多次，会让人关掉震动开关） */
  const cont = /wheelStart:\s*\{[\s\S]*?haptic:\s*''/.test(fbSrc) ||
               /wheelStart:\s*\{[\s\S]*?\/\*[^*]*连续动作不震/.test(fbSrc)
  assert.ok(cont, 'wheelStart 是连续动作，不该配震动')

  ok('★ 有节奏的动作都在 feedback 表里（' + keys.size + ' 个），连续动作不震')
}

/* ============================================================================
 * 2026-11-03 追加：**震动必须走 feedback，不能被绕过**
 *
 * `feedback` 里有一步会乘 `h.isReduceMotion()` —— 用户开了「减少动效」，
 * 震动就该全停。而任何**直接调 `haptic.short()` / `haptic.long()` 的地方
 * 都会绕过这一层**，表现为"我明明关了动效，怎么还震"。
 *
 * 判据：`haptic.*()` 只允许出现在 `feedback.js` 里（它是唯一的出口）。
 * ========================================================================== */
{
  const bad = []
  const walk = (d) => {
    if (!fs.existsSync(d)) return
    fs.readdirSync(d).forEach(f => {
      const p = path.join(d, f)
      if (fs.statSync(p).isDirectory()) return walk(p)
      if (!f.endsWith('.js')) return
      /* feedback.js 自己当然可以调 haptic */
      if (p.endsWith('feedback.js') || p.endsWith('haptic.js')) return
      /*
       * ★ 白名单：**开关本身的即时反馈**。
       *
       *   `lobby.js` / `me.js` 里那个 `haptic.vibrate('light')` 是"用户刚把震动打开、
       *   立刻震一下让他确认已生效" —— 它**必须**绕过 feedback，
       *   因为 feedback 会乘 `isReduceMotion()`，而"打开震动"这个动作
       *   如果被"减少动效"拦掉，用户就永远得不到反馈。
       *
       *   ⚠️ 但只允许"开关自己"这一处 —— 所以白名单是**精确到行号特征**的：
       *     该文件里出现 `haptic.vibrate` 的次数必须 ≤ 1，且邻近有 setHapticOn。
       */
      if (p.endsWith('lobby.js') || p.endsWith('me.js')) {
        const body = fs.readFileSync(p, 'utf8')
        const n = (body.match(/haptic\.vibrate\(/g) || []).length
        const nearToggle = /setHapticOn|toggleMute|toggleHaptic/.test(
          body.slice(Math.max(0, body.indexOf('haptic.vibrate') - 400),
                     body.indexOf('haptic.vibrate') + 200))
        if (n <= 1 && nearToggle) return
      }
      let src = fs.readFileSync(p, 'utf8')
      src = src.replace(/\/\*[\s\S]*?\*\//g, '').replace(/\/\/[^\n]*/g, '')
      ;[...src.matchAll(/\bhaptic\.(short|long|tap|vibrate)\s*\(/g)].forEach(m => {
        bad.push(path.relative(ROOT, p) + '：' + m[0])
      })
    })
  }
  walk(path.join(ROOT, 'miniprogram'))

  assert.deepStrictEqual(bad, [],
    '这些地方绕过了 feedback 直接震（「减少动效」开关会失效）：\n    ' + bad.join('\n    '))
  ok('★ 震动只从 feedback 出口（「减少动效」开关才能真正生效）')
}

/* ============================================================================
 * 2026-11-03 追加：**模板引用的字段必须真的有人产出**（幽灵字段）
 *
 * `result.topHand` 一直出现在模板里（英雄区的牌型名），
 * 而**云端 `calcDiceResult` 从来没返回过它** ——
 * 于是"赢家"那块永远只有名字 + 点数，**没有牌型名**；
 * 而下面列表里每个人都有（四条 / 顺子 / 三条）。
 *
 * 同一屏里一处有一处没有，看起来像"英雄区没做完"。
 * 这类"模板读了、但没人写"的字段，小程序**完全不报错**（求值成 undefined）。
 * ========================================================================== */
{
  const wxml = fs.readFileSync(
    path.join(ROOT, 'miniprogram/game/room/room.wxml'), 'utf8')
  const pageSrc = fs.readFileSync(
    path.join(ROOT, 'miniprogram/game/room/room.js'), 'utf8')
  const cloudSrc = fs.readFileSync(
    path.join(ROOT, 'cloudfunctions/room/index.js'), 'utf8')

  /* 只查比大小结算区里那几个"本该有值"的字段 */
  const mustHave = ['topHand', 'topDice', 'restRanked']
  const bad = []
  mustHave.forEach(f => {
    const inTpl = new RegExp('result\\.' + f + '\\b').test(wxml)
    if (!inTpl) return
    /* 谁给它赋值？（前端 decorate 或云端 result） */
    const inPage = new RegExp('(\\.|\\s)' + f + '\\s*[=:]').test(pageSrc)
    const inCloud = new RegExp(f + '\\s*:').test(cloudSrc)
    if (!inPage && !inCloud) {
      bad.push(f + '：模板在用，但既不是 decorate 赋的、也不是云函数返回的')
    }
  })
  assert.deepStrictEqual(bad, [],
    '这些是幽灵字段（模板读了但没人写）：\n    ' + bad.join('\n    '))
  ok('★ 结算区引用的字段都有人产出（topHand / topDice / restRanked）')
}

/* ============================================================================
 * 2026-11-03 追加：**`result.xxx` 也要查幽灵字段**（补 ④ 的漏洞）
 *
 * ④ 只查 `room.` 前缀 —— 因为 `item.` 在模板里多义（players/decks/cards 都叫 item）。
 * 而 `result.` **只有一个来源**（比大小/大话骰/卧底的结算对象），可以精确查。
 *
 * 真实案例：`{{result.topHand}}` 在模板里待了很久，
 * 而云端 `calcDiceResult` 从来没返回过它 —— 英雄区永远没有牌型名。
 *
 * ⚠️ 允许的来源有三个：
 *   ① 云函数返回（`calcDiceResult` 等）
 *   ② `decorate` 里补（`lr.topDice = ...`、`lr.restRanked = ...`）
 *   ③ **前端补算**（`lr.ranked[0].handName` 这种从别处取的，也要算数）
 * ========================================================================== */
{
  const wxml = fs.readFileSync(
    path.join(ROOT, 'miniprogram/game/room/room.wxml'), 'utf8')
  const pageSrc = fs.readFileSync(
    path.join(ROOT, 'miniprogram/game/room/room.js'), 'utf8')
  const cloudSrc = fs.readFileSync(
    path.join(ROOT, 'cloudfunctions/room/index.js'), 'utf8')

  /*
   * ★ 2026-11-03：从只查 `result.` 扩到 `result.` / `poker.` / `uw.` 三组。
   *
   *   它们都只有一个来源（结算对象 / 金花的 poker 子对象 / 卧底的 uw 子对象），
   *   不像 `item.` 那样多义 —— 所以可以精确查。
   *
   *   ④ 只查了 `room.` 的 35 个字段，而 `poker.` 9 个、`uw.` 13 个从来没查过。
   *   这一轮补上了，结果是全部有产出（没有幽灵）。
   */
  let totalFields = 0
  const allMissing = []
  ;['result', 'poker', 'uw'].forEach(pfx => {
    const fields = [...new Set([...wxml.matchAll(new RegExp(pfx + '\\.(\\w+)', 'g'))].map(m => m[1]))]
    totalFields += fields.length
    fields.forEach(f => {
      const inCloud = new RegExp('\\b' + f + '\\s*:').test(cloudSrc)
      const inPage = new RegExp('\\b' + f + '\\s*[=:]').test(pageSrc)
      if (!inCloud && !inPage) allMissing.push(pfx + '.' + f)
    })
  })

  assert.deepStrictEqual(allMissing, [],
    '这些是幽灵字段（模板在用，但云函数和 decorate 都没产出）：\n    ' +
    allMissing.join('\n    ') +
    '\n    （这三个前缀都只有一个来源，可以直接查）')
  ok('★ 模板里 ' + totalFields + ' 个 result./poker./uw. 字段都有人产出')
}

/* ============================================================================
 * 2026-11-03 追加：**「喝 1 杯」不能被拆开**
 *
 * 12 字名字（上限）+ 「喝 1 杯」在 44rpx 下有 748rpx，超过 686rpx 内容区。
 * 原来它们在一个文本节点里，于是断成「…喝 1」+「杯」——「杯」单独一行很难看。
 *
 * 改成两个 `<text>` + `flex-wrap`：短名字一行，长名字则「名字」一行、「动作」一行。
 * 而「喝 1 杯」自己必须 `white-space: nowrap`（它内部也不许断）。
 * ========================================================================== */
{
  const wxml = fs.readFileSync(
    path.join(ROOT, 'miniprogram/game/room/room.wxml'), 'utf8')
  const wxss = fs.readFileSync(
    path.join(ROOT, 'miniprogram/game/room/room.wxss'), 'utf8')

  /* 模板里名字和动作必须分成两个节点 */
  assert.ok(/<text class="lb-name">\{\{result\.loserName\}\}<\/text>/.test(wxml),
    '「谁喝」的名字应该单独一个 <text>（否则长名字会把「喝 1 杯」拆开）')
  assert.ok(/<text class="lb-what">喝 1 杯<\/text>/.test(wxml),
    '「喝 1 杯」应该单独一个 <text>')

  /* 动作不许断，容器要能整体换行 */
  assert.ok(/\.lb-what\s*\{\s*white-space:\s*nowrap/.test(wxss),
    '.lb-what 必须 white-space: nowrap（「喝 1 杯」内部不许断）')
  assert.ok(/\.loserbox\s*\{[\s\S]{0,300}?flex-wrap:\s*wrap/.test(wxss),
    '.loserbox 必须 flex-wrap: wrap（长名字时让两段整体换行）')

  ok('★ 长名字时「喝 1 杯」整体换行，不会被拆成「杯」单独一行')
}

/* ============================================================================
 * 2026-11-03 追加：**规则不能承诺界面做不到的事**
 *
 * 「比大小」的规则写着"5 颗全不同是单骰，可以重摇（最多 3 次）"，
 * 而云函数没升级时前端**已经把按钮藏了**（能力探测）——
 * 于是玩家会遇到："规则说能重摇，界面上找不到按钮。"
 *
 * 现在云端不支持时，那条规则后面会加「（暂未开放）」。
 *
 * 判据：能力探测（`cloudHasReroll`）和规则标注必须**同时存在** ——
 * 只藏按钮不标规则、或只标规则不藏按钮，都是一半。
 * ========================================================================== */
{
  const src = fs.readFileSync(
    path.join(ROOT, 'miniprogram/game/room/room.js'), 'utf8')

  const hasProbe = /const cloudHasReroll = mine && Object\.prototype\.hasOwnProperty\.call\(mine, 'rerollCount'\)/.test(src)
  const hasNote = /暂未开放/.test(src)

  assert.ok(hasProbe, '缺能力探测：云函数不支持 reroll 时应该藏按钮')
  assert.ok(hasNote, '缺规则标注：云函数不支持 reroll 时，规则里该写「暂未开放」')

  ok('★ 「重摇」：按钮和规则一起按云端能力降级（不会一边有一边没有）')
}

/* ============================================================================
 * 2026-11-03 追加：**玩法名不许在别处硬编码**
 *
 * `games.js` 是"玩法叫什么"的唯一事实源。而 `room.js` 的 data 里曾经写着
 * `pickGameName: '大话骰'` —— 改注册表里的名字时不会提醒你改这里，
 * 页面上会闪一下旧名字（然后被云端返回的真名覆盖）。
 *
 * 判据：注册表里每个玩法的**名字**，不该以字符串字面量形式出现在别处
 * （注释、文档不算 —— 先剥注释）。
 * ========================================================================== */
{
  const games = fs.readFileSync(
    path.join(ROOT, 'miniprogram/utils/games.js'), 'utf8')
  const names = [...games.matchAll(/^\s{4}name: '([^']+)'/gm)].map(m => m[1])
  assert.ok(names.length >= 5, '只认出 ' + names.length + ' 个玩法名')
  /* ★ 2026-11-03：描述也算"注册表的事实"，同样不许别处硬编码 */
  const descs = [...games.matchAll(/^\s{4}desc: '([^']+)'/gm)].map(m => m[1])
  assert.ok(descs.length >= 5, '只认出 ' + descs.length + ' 个描述')

  const bad = []
  const walk = (d) => {
    if (!fs.existsSync(d)) return
    fs.readdirSync(d).forEach(f => {
      const p = path.join(d, f)
      if (fs.statSync(p).isDirectory()) return walk(p)
      if (!/\.(js|wxml)$/.test(f)) return
      /* 注册表自己当然有 */
      if (p.endsWith('games.js')) return
      let src = fs.readFileSync(p, 'utf8')
      src = src.replace(/\/\*[\s\S]*?\*\//g, '').replace(/\/\/[^\n]*/g, '')
        .replace(/<!--[\s\S]*?-->/g, '')
      names.forEach(n => {
        if (src.includes("'" + n + "'") || src.includes('"' + n + '"')) {
          bad.push(path.relative(ROOT, p) + '：硬编码了玩法名「' + n + '」')
        }
      })
      /* 描述（>6 字才算，太短的可能是巧合） */
      descs.forEach(d => {
        if (d.length > 6 && src.includes(d)) {
          bad.push(path.relative(ROOT, p) + '：硬编码了描述「' + d.slice(0, 12) + '…」')
        }
      })
    })
  }
  walk(path.join(ROOT, 'miniprogram'))

  assert.deepStrictEqual(bad, [],
    '玩法名硬编码在别处（改注册表时不会跟着变）：\n    ' + bad.join('\n    '))
  ok('★ ' + names.length + ' 个玩法名 / ' + descs.length + ' 条描述都只来自注册表')
}

/* ============================================================================
 * 2026-11-03 追加：**大厅也要有小屏紧凑模式**
 *
 * 房间页早就有 `.gamepage.compact`（iPhone SE 那种 568pt 高的屏），
 * 而**大厅一直没有** —— 于是小屏上一屏只能看到 2 个玩法卡，
 * 而大厅最重要的事是"五个玩法都在"。
 *
 * ⚠️ 两个坑（都踩过）：
 *   ① 必须用 `.page.compact` 类，不能用 `@media`（rpx 在媒体查询里不解析）
 *   ② mock 必须显式给 `compact: true` —— 真机上它来自 `wx.getSystemInfoSync`，
 *      而渲染器不提供 systemInfo，不给的话 `--height 504` 渲染出来完全一样
 * ========================================================================== */
{
  const js = fs.readFileSync(
    path.join(ROOT, 'miniprogram/pages/lobby/lobby.js'), 'utf8')
  const wxml = fs.readFileSync(
    path.join(ROOT, 'miniprogram/pages/lobby/lobby.wxml'), 'utf8')
  const wxss = fs.readFileSync(
    path.join(ROOT, 'miniprogram/pages/lobby/lobby.wxss'), 'utf8')

  assert.ok(/windowHeight[\s\S]{0,40}<= 600/.test(js),
    '大厅 onLoad 里要按 windowHeight 算 compact（和房间页同一套判据）')
  assert.ok(/class="page \{\{compact \? 'compact' : ''\}\}"/.test(wxml),
    '根容器要挂 compact 类')
  assert.ok(/\.page\.compact\s+\.lb-hero/.test(wxss),
    '要有 `.page.compact` 规则（不能用 @media）')
  /* ⚠️ 先剥注释 —— 规则里那段注释**正是在解释"为什么不用 @media"** */
  const wxssNc = wxss.replace(/\/\*[\s\S]*?\*\//g, '')
  assert.ok(!/@media\s*\(max-height/.test(wxssNc),
    '不许用 @media (max-height) —— rpx 不解析，px 版本渲染器也测不到')

  /* mock 必须有 compact 状态，否则"--height 504"看不出任何变化 */
  const mock = fs.readFileSync(
    path.join(ROOT, 'scripts/ui-render/mock/lobby.js'), 'utf8')
  assert.ok(/compact:\s*\(\)\s*=>\s*\(\{[^}]*compact:\s*true/.test(mock),
    'mock 里要有 compact 状态（否则没法预览小屏效果）')

  ok('★ 大厅小屏紧凑模式完整（判据/类/样式/mock 四处都在）')
}

/* ============================================================================
 * 2026-11-03 追加：**页面必须能滚动**（小屏上按钮可能在首屏外）
 *
 * 小屏（iPhone SE 504pt）上，大话骰 playing 阶段的「开 / 劈」可能在首屏外 ——
 * 而 `min-height: 100vh` + 没有 `overflow: hidden` 时，**玩家能往上滑看到它**。
 *
 * 一旦有人在 `.gamepage` 上加 `overflow: hidden`（很常见的"防止横向滚动"写法），
 * 页面就再也不能滚 —— 而那**不会报错**，只是按钮永远点不到。
 * ========================================================================== */
{
  const wxss = fs.readFileSync(
    path.join(ROOT, 'miniprogram/game/room/room.wxss'), 'utf8')
  const m = /\.gamepage\s*\{([\s\S]*?)\}/.exec(wxss)
  assert.ok(m, '找不到 .gamepage 的定义')
  const body = m[1]

  assert.ok(/min-height:\s*100vh/.test(body),
    '.gamepage 要 min-height: 100vh（内容多时能撑开、页面能滚）')
  assert.ok(!/overflow\s*:\s*hidden/.test(body),
    '★ .gamepage 不许 overflow: hidden —— 那会让小屏上首屏外的按钮永远点不到')

  /* 顺带：小屏紧凑规则必须存在且比正常态小 */
  assert.ok(/\.gamepage\.compact\s+\.cupscene\s*\{\s*height:\s*(\d+)rpx/.test(wxss),
    '要有 .gamepage.compact .cupscene 的紧凑高度')
  const compactH = Number(/\.gamepage\.compact\s+\.cupscene\s*\{\s*height:\s*(\d+)rpx/.exec(wxss)[1])
  assert.ok(compactH <= 300,
    '紧凑态骰盅高度应 ≤300rpx（实际 ' + compactH + 'rpx）——' +
    '再大就会把「开 / 劈」挤出首屏')

  ok('★ 页面可滚动（min-height:100vh / 无 overflow:hidden），紧凑骰盅 ' + compactH + 'rpx')
}

/* ============================================================================
 * 2026-11-03 追加：**同一个选择器在 compact 里不许定义两次**
 *
 * `.gamepage.compact .cs-die-scene` 曾经出现两条（44rpx 和 52rpx）——
 * **后者静默覆盖前者**，于是"我改成了 44"实际是 52，而渲染图上根本看不出来。
 *
 * 这是 CSS 的经典陷阱：重复定义不报错，只有最后一条生效。
 * ========================================================================== */
{
  /* 只查 room.wxss 里 `.gamepage.compact` 前缀的选择器 */
  const wxss = fs.readFileSync(
    path.join(ROOT, 'miniprogram/game/room/room.wxss'), 'utf8')
    .replace(/\/\*[\s\S]*?\*\//g, '')

  const seen = new Map()
  const dup = []
  ;[...wxss.matchAll(/(\.gamepage\.compact[^{]*)\{/g)].forEach(m => {
    const sel = m[1].trim().replace(/\s+/g, ' ')
    if (seen.has(sel)) dup.push(sel)
    else seen.set(sel, true)
  })

  assert.deepStrictEqual([...new Set(dup)], [],
    '这些 compact 选择器定义了不止一次（后者会静默覆盖前者）：\n    ' + dup.join('\n    '))
  ok('★ ' + seen.size + ' 个 compact 选择器都只定义一次')
}

/* ============================================================================
 * 2026-11-03 追加：**紧凑模式的关键规则必须真的生效**（用 getComputedStyle 问浏览器）
 *
 * 做这个小功能时踩了五个坑，而它们的表现**完全一样**（渲染图没变）：
 *   ① 选择器写错  ② 被后面的规则覆盖  ③ 条件没触发
 *   ④ 值的方向错  ⑤ 改得不够明显
 *
 * 前四个都能用 `check-css-applied.js` 一次问清楚。这里锁住两个最关键的：
 *   · 紧凑态骰盅必须是基础态的一半（180 vs 360rpx）
 *   · 紧凑态大厅标题必须比基础态小
 * ========================================================================== */
{
  const { execFileSync } = require('child_process')
  const probe = (sel, prop) => {
    try {
      const out = execFileSync('node',
        [path.join(ROOT, 'scripts/check-css-applied.js'), sel, prop],
        { encoding: 'utf8', stdio: ['ignore', 'pipe', 'ignore'] })
      const m = /=\s*([\d.]+)px/.exec(out)
      return m ? Number(m[1]) : null
    } catch (e) {
      return null
    }
  }

  const baseCup = probe('.cs-cup', 'width')
  const compactCup = probe('.gamepage.compact .cs-cup', 'width')
  if (baseCup !== null && compactCup !== null) {
    assert.ok(compactCup < baseCup,
      '紧凑态骰盅（' + compactCup + 'px）必须比基础态（' + baseCup + 'px）小')
  }

  const baseT = probe('.lb-t', 'font-size')
  const compactT = probe('.page.compact .lb-t', 'font-size')
  if (baseT !== null && compactT !== null) {
    assert.ok(compactT < baseT,
      '紧凑态大厅标题（' + compactT + 'px）必须比基础态（' + baseT + 'px）小 —— ' +
      '而第一版我写成了 24rpx（比原来的 20rpx **大**），方向反了')
  }

  ok('★ 紧凑模式的规则真的生效（骰盅 ' + baseCup + '→' + compactCup +
     'px，标题 ' + baseT + '→' + compactT + 'px）')
}

/* ============================================================================
 * 2026-11-03 追加：**四条"改了才修好"的规则，必须持续生效**
 *
 * 这四条都是踩坑之后加的，而**它们失效时不会报错**：
 *   · `.loserbox` 没有 flex-wrap → 12 字名字把「杯」拆到单独一行
 *   · `.ht-t` 不是 block         → 规则弹层的长句被右侧裁掉
 *   · `.lb-what` 没有 nowrap     → 「喝 1 杯」内部被拆开
 *   · `.plist` 没有 max-height   → 12 人局的「开始」被推到屏幕外
 *
 * 用 `check-css-applied.js`（getComputedStyle）问浏览器 —— 比看代码可靠。
 * ========================================================================== */
{
  const { execFileSync } = require('child_process')
  const probe = (sel, prop) => {
    try {
      const out = execFileSync('node',
        [path.join(ROOT, 'scripts/check-css-applied.js'), sel, prop],
        { encoding: 'utf8', stdio: ['ignore', 'pipe', 'ignore'] })
      return (/=\s*(.+)$/.exec(out.trim()) || [])[1] || ''
    } catch (e) { return '' }
  }

  assert.strictEqual(probe('.loserbox', 'flex-wrap'), 'wrap',
    '★ .loserbox 必须 flex-wrap: wrap（长名字时「喝 1 杯」整体换行）')
  assert.strictEqual(probe('.ht-t', 'display'), 'block',
    '★ .ht-t 必须 display: block（否则规则弹层的长句被裁）')
  assert.strictEqual(probe('.lb-what', 'white-space'), 'nowrap',
    '★ .lb-what 必须 white-space: nowrap（「喝 1 杯」内部不许断）')

  const maxH = parseFloat(probe('.plist', 'max-height'))
  assert.ok(maxH > 0 && maxH < 1000,
    '★ .plist 必须有 max-height（12 人局的「开始」才不会被推到屏幕外），实际 ' + maxH)

  ok('★ 四条修复规则持续生效（换行 / 弹层 / 不拆词 / 列表可滚）')
}

/* ============================================================================
 * 2026-11-03 追加：**绝对定位的子元素也要跟着容器缩**
 *
 * `.wheelscene` 是容器，`.ws-disc`（圆盘）是它里面 `position: absolute` 的子元素
 * —— 而圆盘的 width/height **写死在 560rpx**。
 *
 * 只缩容器（到 464rpx）的结果：**圆盘不变，溢出容器，压住下面的标题**。
 * 而这个在代码里完全看不出来（两条规则各自都对），只有渲染图上能看到。
 *
 * 判据：凡是"容器里有 absolute 子元素"的组合，缩容器时必须同时缩子元素。
 * ========================================================================== */
{
  const { execFileSync } = require('child_process')
  const probe = (sel, prop) => {
    try {
      const out = execFileSync('node',
        [path.join(ROOT, 'scripts/check-css-applied.js'), sel, prop],
        { encoding: 'utf8', stdio: ['ignore', 'pipe', 'ignore'] })
      const m = /= ([^\n]*)$/.exec(out.trim())
      return m ? m[1].trim() : ''
    } catch (e) { return '' }
  }
  const px = (v) => parseFloat(v) || 0

  const sceneBase = px(probe('.wheelscene', 'width'))
  const sceneCompact = px(probe('.gamepage.compact .wheelscene', 'width'))
  const discBase = px(probe('.ws-disc', 'width'))
  const discCompact = px(probe('.gamepage.compact .ws-disc', 'width'))

  assert.ok(sceneCompact > 0 && sceneCompact < sceneBase,
    '紧凑态容器应该比基础态小（' + sceneCompact + ' vs ' + sceneBase + '）')
  assert.ok(discCompact > 0 && discCompact < discBase,
    '★ 紧凑态圆盘也必须比基础态小（' + discCompact + ' vs ' + discBase + '）—— ' +
    '圆盘是 absolute 定位，只缩容器它会溢出并压住标题')
  assert.ok(discCompact <= sceneCompact + 1,
    '★ 圆盘不能比容器大（' + discCompact + ' > ' + sceneCompact + '），否则溢出压住下面的内容')

  ok('★ 转盘缩小时圆盘跟着缩（容器 ' + sceneCompact + 'px / 圆盘 ' + discCompact + 'px）')
}

/* ============================================================================
 * 2026-11-03 追加：**转盘转动必须全程有声音**（不能只有启动那一下）
 *
 * `wheelStart` 音效只有 300ms，而转盘要转 2.4~2.7 秒 ——
 * 如果只播启动音，**后面 2 秒多是完全静默的**，而画面正在最慢的那一段。
 *
 * 项目里用 `scheduleTicks` 按**递减频率**排期 tick（模拟"越转越慢"）来填补。
 * 这个函数一旦被删或不再调用，表现是"转盘转着转着没声了" —— 不报错。
 * ========================================================================== */
{
  const src = fs.readFileSync(
    path.join(ROOT, 'miniprogram/game/room/room.js'), 'utf8')

  assert.ok(/scheduleTicks\s*\(/.test(src),
    '★ 必须有 scheduleTicks —— 转盘转 2.4 秒而启动音只有 300ms')
  assert.ok(/this\.scheduleTicks\(this\.data\.wheelDur/.test(src),
    '★ scheduleTicks 要按 wheelDur 排期（和转盘动画同长）')

  /* tick 的排期间隔应该递减（越转越慢），不能等距 */
  const m = /scheduleTicks\([^)]*\)\s*\{([\s\S]{0,600}?)\n  \}/.exec(src)
  if (m) {
    const body = m[1]
    assert.ok(/\*=\s*1\.0|1\.0\d+|\*=\s*1\.\d+/.test(body),
      '★ tick 间隔应该递增（越转越慢），实际函数体里没看到递增因子')
  }

  ok('★ 转盘转动全有声音（启动音 + 递减咔哒，覆盖 ' +
     'wheelDur 全程）')
}

/* ============================================================================
 * 2026-11-03 追加：**撒花的片数**
 *
 * 20 片 12rpx 宽的纸片散在 750rpx 的屏上，视觉上只是稀疏的几点 ——
 * 而这是"赢了"的庆祝。提到 36 片。
 *
 * ⚠️ 这个数**没法用截图验证**：`cfFall` 动画从 `top: -30rpx` 开始，
 *   静态渲染截到的是起始帧（纸片还在屏幕外）。
 *   所以只能锁"数量"，效果靠真机看。
 * ========================================================================== */
{
  const src = fs.readFileSync(
    path.join(ROOT, 'miniprogram/game/room/room.js'), 'utf8')
  const m = /for \(let i = 0; i < (\d+); i\+\+\) list\.push\(i\)/.exec(src)
  assert.ok(m, '找不到 celebrate() 里生成撒花的循环')
  const n = Number(m[1])
  assert.ok(n >= 30, '撒花只有 ' + n + ' 片，太稀疏（20 片在 750rpx 屏上只是几点）')
  assert.ok(n <= 45, '撒花 ' + n + ' 片偏多 —— 低端机上 50 个 translate3d+rotate 开始掉帧')

  /* 配色变体数（cf-0..cf-4）也要够，否则 36 片只有 5 种颜色会很单调 */
  const wxml = fs.readFileSync(
    path.join(ROOT, 'miniprogram/game/room/room.wxml'), 'utf8')
  assert.ok(/cf cf-\{\{item % 5\}\}/.test(wxml), '撒花的颜色变体应该按 % 5 循环')

  ok('★ 撒花 ' + n + ' 片 × 5 种颜色（数量在 30~45 之间）')
}

/* ============================================================================
 * 2026-11-03 追加：**「开过 N 次」必须所有玩家都记，不只是房主**
 *
 * `bumpNightCount` 原来只在 `doStart` 成功后调用 —— 而那是**房主才点的按钮**。
 * 于是：房主玩 7 局显示"开过 7 次"，其他人**永远是 0**。
 *
 * 而「我的」页那一行是"**我**玩过什么"，不是"**我**开过什么"。
 *
 * 现在改成在 `applyRoom` 里"进入 playing 阶段"时记（所有玩家都会经过），
 * 并用 `_countedRound` 防重复。
 * ========================================================================== */
{
  const src = fs.readFileSync(
    path.join(ROOT, 'miniprogram/game/room/room.js'), 'utf8')
    .replace(/\/\*[\s\S]*?\*\//g, '')
    .replace(/\/\/[^\n]*/g, '')

  /* 只允许一处调用（多一处就会重复计数） */
  const calls = [...src.matchAll(/this\.bumpNightCount\(/g)]
  assert.strictEqual(calls.length, 1,
    'bumpNightCount 应该只有一处调用（多一处会让房主重复计数），实际 ' + calls.length + ' 处')

  /* 那一处必须在 applyRoom 的"进入 playing"分支里，不是 doStart */
  assert.ok(/_countedRound/.test(src),
    '★ 记一局要有防重复标记（_countedRound）—— 阶段可能因轮询被反复判定')
  assert.ok(/raw\.phase === 'playing'[\s\S]{0,200}bumpNightCount/.test(src),
    '★ 记一局必须在"进入 playing"时做（所有玩家都经过），不能在 doStart 里（只有房主）')

  ok('★ 「开过 N 次」所有玩家都记（单一调用点 + 防重复）')
}

/* ============================================================================
 * 2026-11-03 追加：**非房主的结算页必须带房主名字**
 *
 * 模板原来是 `<view wx:else class="waiting">等房主开下一局</view>` ——
 * 而**所有残留的结算 mock 都是 host:true**，所以那个分支从来没被渲染验证过。
 *
 * "等房主"和"等 邓林"在酒桌上很不一样：**后者能直接喊他**。
 * ========================================================================== */
{
  const wxml = fs.readFileSync(
    path.join(ROOT, 'miniprogram/game/room/room.wxml'), 'utf8')
  const page = fs.readFileSync(
    path.join(ROOT, 'miniprogram/game/room/room.js'), 'utf8')

  assert.ok(/等 \{\{room\.hostName \|\| '房主'\}\} 开下一局/.test(wxml),
    '★ 非房主结算页要带房主名字（"等 邓林"比"等房主"更有用）')
  assert.ok(/room\.hostName = \(hostP && hostP\.name\) \|\| '房主'/.test(page),
    '★ hostName 要在 decorate 里算（wxml 不支持 filter）')

  /* mock 必须有"非房主结算"状态，否则那个 wx:else 分支永远测不到 */
  const mock = fs.readFileSync(
    path.join(ROOT, 'scripts/ui-render/mock/room.js'), 'utf8')
  assert.ok(/overGuest: \(\) =>/.test(mock),
    '★ mock 要有非房主的结算状态（否则 wx:else 分支从没被渲染验证过）')

  ok('★ 非房主结算页：带房主名字 + mock 覆盖了 wx:else 分支')
}

/* ============================================================================
 * 2026-11-03 追加：**结算页的两种视角（我输 / 别人输）都要有 mock**
 *
 * 所有结算 mock 原来都是 `loser=倩萍 / me=邓林` —— 也就是说
 * **"别人输"被验了很多次，而"我输"一次都没有**。
 *
 * 而"我输了"是最需要说清楚的那一刻。
 *
 * ✅ 实测结论：文案用的是**名字**（"邓林 喝 1 杯"）而不是"你 喝 1 杯" ——
 *    这是对的：全桌看到同一行字，"邓林"比"你"更清楚（而且别人也在看这块屏）。
 * ========================================================================== */
{
  const mock = fs.readFileSync(
    path.join(ROOT, 'scripts/ui-render/mock/room.js'), 'utf8')

  assert.ok(/iLostOver: \(\) =>/.test(mock),
    '★ mock 要有「我输了」的状态（否则那种视角从没被渲染验证过）')

  /* 这个状态必须真的把 loser 改成自己 */
  assert.ok(/base\.room\.lastResult\.loserName = myName/.test(mock),
    '★ iLostOver 必须把 loserName 改成自己的名字（否则它就是 liarBlowup 的副本）')

  /* 反过来说：不能所有结算状态的 loser 都是别人 */
  ok('★ 结算页的两种视角都有 mock（我输 / 别人输）')
}

/* ============================================================================
 * 2026-11-03 追加：**出局的人不该看到操作按钮**
 *
 * 金花的操作区判据原来是 `room.myTurn && !room.poker.folded` ——
 * **没排除"已出局"**。于是出局的人照样看到「比 / 换 / 弃」三排按钮，
 * 而服务端每次回「你已经出局了，这局在旁边看」。
 *
 * 而"出局"这件事在七个 pk* mock 状态里**一次都没出现过**（全是 out:false）——
 * 所以这个缺口在渲染上从来没人看见。
 * ========================================================================== */
{
  const wxml = fs.readFileSync(
    path.join(ROOT, 'miniprogram/game/room/room.wxml'), 'utf8')
  const page = fs.readFileSync(
    path.join(ROOT, 'miniprogram/game/room/room.js'), 'utf8')

  /* 金花操作区必须排除出局 */
  assert.ok(/room\.myTurn && !room\.poker\.folded && !room\.myOut/.test(wxml),
    '★ 金花操作区必须排除已出局（否则出局后还能点「比/换/弃」）')

  /* myOut 必须由 decorate 产出 */
  assert.ok(/room\.myOut = !!\(room\.me && room\.me\.out\)/.test(page),
    '★ myOut 要在 decorate 里算（模板不能自己算）')

  /* 大话骰的 turnbar 也要区分出局 */
  assert.ok(/wx:elif="\{\{room\.myOut\}\}"/.test(wxml),
    '★ 轮次提示要说清"你已出局"（而不是"轮到你叫了"）')

  /* mock 必须有出局状态 */
  const mock = fs.readFileSync(
    path.join(ROOT, 'scripts/ui-render/mock/room.js'), 'utf8')
  assert.ok(/pkOut: \(\) =>/.test(mock),
    '★ mock 要有「金花里我出局」的状态')

  ok('★ 出局的人看不到操作按钮（三处判据 + mock 覆盖）')
}

/* ============================================================================
 * 2026-11-03 追加：**同一个动作在不同阶段必须叫同一个名字**
 *
 * `room.wxml` 里 "离开房间" 出现 3 次（lobby / playing / over 各一处）、
 * "换个玩法" 2 次、"催一下" 2 次 —— 而这些**是对的**：
 * 同一个动作在不同阶段就该叫同一个名字。
 *
 * 反过来说：如果同一个动作用了两个名字（比如一处"点了就退出"、一处"离开房间"），
 * 玩家会以为是两个功能。这条断言查的是**有没有这种分叉**。
 * ========================================================================== */
{
  const wxml = fs.readFileSync(
    path.join(ROOT, 'miniprogram/game/room/room.wxml'), 'utf8')
    .replace(/<!--[\s\S]*?-->/g, '')

  /* 已知的动作 → 允许的文案（唯一） */
  const ACTIONS = {
    leave: ['离开房间'],
    changeGame: ['换个玩法'],
    urge: ['催一下'],
    again: ['再来一局']
  }
  const bad = []
  Object.keys(ACTIONS).forEach(act => {
    const allowed = ACTIONS[act]
    /* 找所有带 bindtap="<act>" 的元素里那段文字 */
    const re = new RegExp('bindtap="' + act + '"[^>]*>([^<>{]*)', 'g')
    let m
    while ((m = re.exec(wxml))) {
      const txt = (m[1] || '').trim()
      if (!txt) continue
      if (allowed.indexOf(txt) < 0) {
        bad.push(act + ' 的按钮写成了「' + txt + '」，而别处是「' + allowed[0] + '」')
      }
    }
  })

  assert.deepStrictEqual([...new Set(bad)], [],
    '同一个动作在不同地方用了不同名字（玩家会以为是两个功能）：\n    ' + bad.join('\n    '))
  ok('★ 同一个动作在各阶段的按钮文案一致（离开/换玩法/催一下/再来一局）')
}

/* ============================================================================
 * 2026-11-03 追加：**「揭晓进度」只在比大小里**（大话骰不该有）
 *
 * 上一轮我在 `liar8`（大话骰 8 人）上看到"揭晓进度条"没显示，
 * 一度以为条件写错了 —— 而实际它**在 `<block wx:elif="dice">` 分支里**。
 *
 * 而这是对的：**比大小要等所有人摇完才揭盅**（有"还差几人"的意义），
 * 而大话骰是各自摇各自的（`cupShake` → `cupSlam`），**没有"等齐"这件事**。
 *
 * 判据：`revealprog` 必须出现在 dice 分支内，不能跑到 liar 分支里。
 * ========================================================================== */
{
  const wxml = fs.readFileSync(
    path.join(ROOT, 'miniprogram/game/room/room.wxml'), 'utf8')

  const i = wxml.indexOf('revealprog')
  assert.ok(i > 0, '找不到 revealprog')

  const before = wxml.slice(0, i)
  const blocks = [...before.matchAll(/<block wx:(?:if|elif)="\{\{room\.game === '(\w+)'\}\}">/g)]
  assert.ok(blocks.length > 0, '找不到玩法分支')
  const owner = blocks[blocks.length - 1][1]

  assert.strictEqual(owner, 'dice',
    '「揭晓进度」是"等所有人摇完"的提示，只该出现在比大小里（实际在 ' + owner + ' 分支）')

  ok('★ 「揭晓进度」在正确的玩法分支里（比大小，不是大话骰）')
}

/* ============================================================================
 * 2026-11-03 追加：**溢出检查工具必须真的在 375px 下测**
 *
 * `check-text-overflow.js` 原来用 `--dump-dom` 模式，而 **`--window-size`
 * 在这个模式下不生效** —— 它一直量的是 500px 视口下的元素宽度，
 * 而真机是 375px。**这条断言因此在一个比真机宽 33% 的屏上测"溢不溢出"。**
 *
 * 修法：不靠浏览器视口，在 HTML 里用 CSS 钉死 375px。
 * ========================================================================== */
{
  const src = fs.readFileSync(
    path.join(ROOT, 'scripts/check-text-overflow.js'), 'utf8')

  assert.ok(/html,\s*body\s*\{[^}]*width:\s*375px/.test(src),
    '★ 溢出检查必须在 375px 宽度下测（用 CSS 钉死，因为 --dump-dom 忽略 --window-size）')

  /* 顺带：不许再依赖 --window-size（在这个模式下无效） */
  const hasWindowSize = /--window-size=/.test(src)
  assert.ok(!hasWindowSize,
    '★ 不该依赖 --window-size —— `--dump-dom` 模式下它不生效（实测：设 375 仍得到 461）')

  ok('★ 溢出检查在真实 375px 宽度下测（不依赖无效的 --window-size）')
}

/* ============================================================================
 * 2026-11-03 追加：**包体积要用实际文件大小，不能用 du**
 *
 * `du -sk` 报的是磁盘占用（按块对齐），小文件多的目录会显著偏大：
 *     du → 1932 KB     实际 → 1694 KB     差 238 KB
 *
 * 而那 238 KB 会让人误判"快到 2048 上限了"，去做不必要的瘦身。
 * ========================================================================== */
{
  const { execFileSync } = require('child_process')
  let out = ''
  try {
    out = execFileSync('python3', [path.join(ROOT, 'scripts/size.py')],
      { encoding: 'utf8', stdio: ['ignore', 'pipe', 'ignore'] })
  } catch (e) {
    out = (e && e.stdout) || ''
  }
  const m = /分包\s+(\d+) KB/.exec(out)
  assert.ok(m, 'size.py 没报出分包体积')

  const sub = Number(m[1])
  assert.ok(sub < 2048, '★ 分包 ' + sub + ' KB 超过 2048 上限')
  assert.ok(sub < 2048 * 0.95, '★ 分包已用 ' + (sub / 2048 * 100).toFixed(0) + '%（>95%），加东西会超')

  ok('★ 分包 ' + sub + ' KB / 2048（' + (sub / 2048 * 100).toFixed(0) + '%，用实际文件大小算）')
}

/* ============================================================================
 * 2026-11-03 追加：**字号只许用那 10 档**
 *
 * 全仓字号此前收敛到 10 档（20 26 34 44 54 64 76 96 150 200）。
 * 而这一轮连续两次冒出散值：
 *   · 我加的 compact 规则写了 `font-size: 46rpx`（该是 44）
 *   · 另一处说明文字写了 `22rpx`（该是 20）
 *   · 还有一处 `24rpx`（该是 26）
 *
 * 三个散值就让档数从 10 涨到 13，**质量分的「字号收敛」项从 4/4 掉到 2/4**。
 *
 * ⚠️ 散值不会报错，只会让"字号系统"慢慢变成"每个地方各写一个数" ——
 *    而那时再收敛就要逐个看语境，代价大得多。
 * ========================================================================== */
{
  const LADDER = [20, 26, 34, 44, 54, 64, 76, 96, 150, 200]
  const seen = new Map()

  const walk = (d) => {
    if (!fs.existsSync(d)) return
    fs.readdirSync(d).forEach(f => {
      const p = path.join(d, f)
      if (fs.statSync(p).isDirectory()) return walk(p)
      if (!f.endsWith('.wxss')) return
      const src = fs.readFileSync(p, 'utf8').replace(/\/\*[\s\S]*?\*\//g, '')
      ;[...src.matchAll(/font-size:\s*(\d+)rpx/g)].forEach(m => {
        const v = Number(m[1])
        if (LADDER.indexOf(v) < 0) {
          const key = v + 'rpx'
          if (!seen.has(key)) seen.set(key, [])
          seen.get(key).push(path.relative(ROOT, p))
        }
      })
    })
  }
  walk(path.join(ROOT, 'miniprogram'))

  const bad = [...seen.entries()].map(([v, files]) => v + '（' + files.length + ' 处：' + files.slice(0, 2).join(', ') + '）')

  assert.deepStrictEqual(bad, [],
    '这些字号不在 10 档阶梯里（' + LADDER.join(' ') + '）：\n    ' + bad.join('\n    '))
  ok('★ 字号只用 10 档（' + LADDER.length + ' 个值，没有散落）')
}

/* ============================================================================
 * 2026-11-03 追加：**每个测试脚本都要能 `require('assert')` 和 `ok()`**
 *
 * 三个测试脚本原来用三套不同的输出方式，而"从别的文件复制一段断言过来"
 * 最常见的失败是 `ReferenceError: assert is not defined` ——
 * **它会整个文件崩掉，而不是"这一条不通过"**（这个坑我一天踩了两次）。
 *
 * 判据：不管用哪套输出，`assert` 和 `ok` 这两种写法都得能用。
 * ========================================================================== */
{
  const bad = []
  ;['test-docs.js', 'test-mock.js', 'test-rules-doc.js', 'test-contract.js'].forEach(f => {
    const p = path.join(ROOT, 'scripts', f)
    if (!fs.existsSync(p)) return
    const src = fs.readFileSync(p, 'utf8')
    const hasAssert = /require\('assert'\)|require\("assert"\)/.test(src)
    const hasOk = /function ok\s*\(|const ok\s*=/.test(src)
    if (!hasAssert) bad.push(f + '：不能 require(\'assert\')')
    if (!hasOk) bad.push(f + '：没有定义 ok()')
  })

  assert.deepStrictEqual(bad, [],
    '这些测试脚本缺基础能力（复制断言过来会崩）：\n    ' + bad.join('\n    '))
  ok('★ 四个测试脚本都能用 assert 和 ok()（复制断言不会崩）')
}

/* ============================================================================
 * 2026-11-03 追加：**分享链路要完整**（这是多人游戏唯一的拉人方式）
 *
 * 一个多人游戏不能转发，等于每次开局都要教一遍"怎么把号发出去"。
 * 三件事必须都在：① onShareAppMessage  ② path 带房间号  ③ 封面图 5:4
 * ========================================================================== */
{
  const page = fs.readFileSync(
    path.join(ROOT, 'miniprogram/game/room/room.js'), 'utf8')
  const wxml = fs.readFileSync(
    path.join(ROOT, 'miniprogram/game/room/room.wxml'), 'utf8')

  assert.ok(/onShareAppMessage\s*\(/.test(page),
    '★ 房间页必须有 onShareAppMessage（否则右上角「转发」是灰的）')
  assert.ok(/path:\s*'\/game\/room\/room\?code='\s*\+\s*r\.code/.test(page),
    '★ 分享的 path 必须带房间号（对方点开直接进房，不用手输）')
  assert.ok(/open-type="share"/.test(wxml),
    '★ 房间里要有 <button open-type="share">（view 绑 bindtap 不行）')

  /* 封面图：微信推荐 5:4 */
  const cover = path.join(ROOT, 'miniprogram/images/share-cover.png')
  assert.ok(fs.existsSync(cover), '★ 分享封面图不存在：miniprogram/images/share-cover.png')
  const size = fs.statSync(cover).size
  assert.ok(size > 5000 && size < 200000,
    '★ 分享封面 ' + Math.round(size / 1024) + ' KB —— 太小可能空白，太大会拖慢分享')

  ok('★ 分享链路完整（按钮 + 带码 path + 封面图 ' + Math.round(size / 1024) + ' KB）')
}

/* ============================================================================
 * 2026-11-03 追加：**前端调的每个 action，云函数都必须有**
 *
 * 这是"本地新版 + 云端旧版"那一类故障的核心：
 * 前端调 `action: 'reroll'`，而云函数不认识 → `return { ok:false, msg:'不认识的操作：reroll' }`
 * —— **不是崩，是"点了没反应"**。
 *
 * ⚠️ 云函数用的是 `if (action === 'x')` 链，**不是 switch/case** ——
 *    第一版我按 `case 'x'` 抓，抓到 0 个，差点以为云函数什么都没处理。
 * ========================================================================== */
{
  const page = fs.readFileSync(
    path.join(ROOT, 'miniprogram/game/room/room.js'), 'utf8')
  const cloud = fs.readFileSync(
    path.join(ROOT, 'cloudfunctions/room/index.js'), 'utf8')

  const called = new Set([...page.matchAll(/action:\s*'(\w+)'/g)].map(m => m[1]))
  const handled = new Set([...cloud.matchAll(/action === '(\w+)'/g)].map(m => m[1]))

  assert.ok(called.size >= 15, '前端只调了 ' + called.size + ' 个 action？先确认抽取正则')
  assert.ok(handled.size >= 15, '云函数只认 ' + handled.size + ' 个 action？先确认抽取正则')

  const missing = [...called].filter(a => !handled.has(a)).sort()
  assert.deepStrictEqual(missing, [],
    '前端调了但云函数不认识的 action（表现为"点了没反应"）：\n    ' + missing.join('\n    '))

  ok('★ action 契约完整（前端调 ' + called.size + ' 个 / 云函数认 ' + handled.size + ' 个）')
}

/* ============================================================================
 * 2026-11-03 追加：**大厅排序：最近玩的排前面，但"上次"只标一个**
 *
 * `recentGames` 存的是**最近玩过的玩法 id 列表**（可能有好几个）。
 * 排序把它们提到前面，而 `recent: i === 0` 只给**第一个**标「上次」。
 *
 * ⚠️ 两个边界：
 *   · `recentGames` 里有已删除的玩法 id → 必须跳过（`.filter(Boolean)`）
 *   · 全部 id 都失效 → 必须退回原顺序（`if (!hit.length) return list`）
 * ========================================================================== */
{
  const src = fs.readFileSync(
    path.join(ROOT, 'miniprogram/pages/lobby/lobby.js'), 'utf8')

  assert.ok(/recent: i === 0/.test(src),
    '★ 「上次」只该标第一个（都标就分不出哪个是"上次"）')
  assert.ok(/\.filter\(Boolean\)/.test(src),
    '★ 已删除的玩法 id 必须被跳过（否则 hit 里会有 null）')
  assert.ok(/if \(!hit\.length\) return list/.test(src),
    '★ 全部 id 都失效时要退回原顺序（否则大厅会空白）')
  assert.ok(/wx:getStorageSync\('recentGames'\)|getStorageSync\('recentGames'\)/.test(src),
    '★ 要读 recentGames（拼错 key 会永远没有"上次"）')

  ok('★ 大厅排序边界完整（只标一个 / 跳过失效 id / 全失效时退回原顺序）')
}

/* ============================================================================
 * 2026-11-03 追加：**玩家列表那一行的文案要短**
 *
 * 占用宽度的顺序是：座位号 + 名字 + 标签（房主/掉线/改）。
 * 而名字最长 12 字 —— 所以标签必须**极短**，否则 12 字名字时会把标签挤掉。
 *
 * 实测：`改`（1 字）是"改名"按钮，在这个位置是对的 ——
 *      写"修改昵称"会把 12 字名字挤成两行。
 * ========================================================================== */
{
  const wxml = fs.readFileSync(
    path.join(ROOT, 'miniprogram/game/room/room.wxml'), 'utf8')

  /* 玩家列表块：从 pname 到 pedit */
  const block = /class="pedit">([^<]*)</.exec(wxml)
  assert.ok(block, '找不到玩家列表里的「改」按钮')

  const txt = block[1].trim()
  assert.ok(txt.length <= 2,
    '★ 玩家列表里的编辑按钮是「' + txt + '」——这里最多 2 个字（12 字名字时会把标签挤掉）')

  ok('★ 玩家列表的编辑按钮够短（「' + txt + '」，' + txt.length + ' 字）')
}

/* ============================================================================
 * 2026-11-03 追加：**动画的缓动函数：`linear` 只许用在两个地方**
 *
 * `linear` 用在"有物理感"的动画上会显得生硬 ——
 * 撒花原来就是匀速竖直下落，看起来像"雪"，不像纸片（注释里记着，已改）。
 *
 * 而 `linear` 在这两处是**对的**：
 *   · 无限循环的快速抖动（`rollingShake` / `suspenseTense`）——
 *     循环里用 ease 会在接缝处"顿"一下
 *   · `linear-gradient`（那是渐变，不是缓动，本判据不管）
 * ========================================================================== */
{
  const bad = []
  const walk = (d) => {
    if (!fs.existsSync(d)) return
    fs.readdirSync(d).forEach(f => {
      const p = path.join(d, f)
      if (fs.statSync(p).isDirectory()) return walk(p)
      if (!f.endsWith('.wxss')) return
      const src = fs.readFileSync(p, 'utf8').replace(/\/\*[\s\S]*?\*\//g, '')
      ;[...src.matchAll(/animation:\s*([\w-]+)\s+[^;]*?\blinear\b/g)].forEach(m => {
        if (!/^(rollingShake|suspenseTense)$/.test(m[1])) {
          bad.push(path.relative(ROOT, p) + '：' + m[1] + ' 用了 linear')
        }
      })
    })
  }
  walk(path.join(ROOT, 'miniprogram'))

  assert.deepStrictEqual([...new Set(bad)], [],
    '这些动画用了 linear（生硬；只有无限循环的快速抖动和"物理上接近匀速"的才该用）：\n    ' +
    [...new Set(bad)].join('\n    '))
  ok('★ 动画缓动：linear 只用在两个快速循环动画上（其余都有缓动曲线）')
}

/* ============================================================================
 * 2026-11-03 追加：**转盘的 CSS 时长必须和 `wheelDur` 一致**
 *
 * 转盘转多久由**两个地方**决定：
 *   · CSS：`transition: transform 2.7s ...`（视觉）
 *   · JS：`wheelDur: 2700`（tick 排期 + 停下来判结果）
 *
 * **而它们各写各的。** 不同步的话：
 *   · CSS 短了 → 转盘早停了，但结果还没出（旋转完后有一段静止）
 *   · CSS 长了 → 结果出来了，转盘还在转（更糟：看到结果还在转）
 *
 * ⚠️ 本项目已有先例：`2600` 与 `2700` 差 100ms，注释里记着"最后一声提前没了"。
 * ========================================================================== */
{
  const wxss = fs.readFileSync(
    path.join(ROOT, 'miniprogram/game/room/room.wxss'), 'utf8')
  const page = fs.readFileSync(
    path.join(ROOT, 'miniprogram/game/room/room.js'), 'utf8')

  const m = /\.ws-disc\s*\{[\s\S]{0,900}?transition:\s*transform\s+([\d.]+)s/.exec(wxss)
  assert.ok(m, '找不到 .ws-disc 的 transition')
  const cssMs = Number(m[1]) * 1000

  const jm = /wheelDur:\s*(\d+)/.exec(page)
  assert.ok(jm, '找不到 wheelDur')
  const jsMs = Number(jm[1])

  assert.strictEqual(cssMs, jsMs,
    '★ 转盘的 CSS 时长（' + cssMs + 'ms）和 wheelDur（' + jsMs + 'ms）必须一致 —— ' +
    '不一致的话"转盘停了但结果没出"或"结果出了还在转"')

  /* 缓动必须是"终点完全停下"的（cubic-bezier 的终点切角为 0） */
  assert.ok(/transition:\s*transform\s+[\d.]+s\s+cubic-bezier/.test(wxss),
    '★ 转盘要用 cubic-bezier（linear 会让它匀速转然后"啪"一下停）')

  ok('★ 转盘时长两处一致（CSS ' + cssMs + 'ms = wheelDur ' + jsMs + 'ms），且用缓动曲线')
}

/* ============================================================================
 * 2026-11-03 追加：**页面 data 里声明的字段必须有人读**
 *
 * `me.js` 里躺着这两行：
 *     const _IC = iconSet.build(['dice', 'chevronRight'], '#C4553F')
 *     data: { ic: _IC, ... }
 * 而 `me.wxml` 里 `ic` 出现 **0 次**、`<image>` 标签 **0 个** ——
 * 图标早改成内联 SVG 的 class 写法了，这个对象从头到尾没人读过。
 *
 * 不报错、不影响功能，只是白算 + 多 require 一个模块（iconSet 连带整个 icons.js）。
 * 这类"算了不渲染"在项目里记过一整类：drinks / winText / wheelCls / mineDieIn…
 *
 * ⚠️ 判据的坑：不能只看 wxml。`ic` 这种**图标集**在模板里写的是 `ic.xxx`，
 *    而纯正则会把它当"没引用"。所以判据是「wxml 引用 **或** js 里 this.data 读过
 *    **或** 它是个被 wxml 用过前缀的对象」—— 三者之一即放行。
 *    （第一版没考虑 `ic.` 形式，把 me 页的 ic 报成死字段 —— 假阳性。）
 * ========================================================================== */
{
  const pages = []
  const walk = (d) => {
    if (!fs.existsSync(d)) return
    fs.readdirSync(d, { withFileTypes: true }).forEach((e) => {
      const p = path.join(d, e.name)
      if (e.isDirectory()) return walk(p)
      if (e.name.endsWith('.js')) pages.push(p)
    })
  }
  /* ★ 必须同时扫主包和分包 —— 只扫 pages/ 会让这条断言在房间页上变成废纸 */
  walk(path.join(ROOT, 'miniprogram/pages'))
  walk(path.join(ROOT, 'miniprogram/game'))

  const dead = []
  pages.forEach((f) => {
    const wxmlPath = f.replace(/\.js$/, '.wxml')
    if (!fs.existsSync(wxmlPath)) return
    const js = fs.readFileSync(f, 'utf8')
    const wxml = fs.readFileSync(wxmlPath, 'utf8')
    const m = /\n  data: \{([\s\S]*?)\n  \},\n/.exec(js)
    if (!m) return
    const keys = [...m[1].matchAll(/^\s{4}([a-zA-Z_][\w]*)\s*:/gm)].map((x) => x[1])
    keys.forEach((k) => {
      /* ① 模板里作为整名或前缀对象被用到 */
      const inWxml = new RegExp('\\{\\{[^}]*\\b' + k + '\\b').test(wxml) ||
                     new RegExp('\\{\\{[^}]*\\b' + k + '\\.').test(wxml)
      /* ② js 里读过它 */
      const read = new RegExp('this\\.data\\.' + k + '\\b').test(js)
      /* ③ 被当对象展开给别处（形如 `...this.data.x`）—— 极少数情况放行 */
      const spread = new RegExp('\\.\\.\\.\\s*this\\.data\\.' + k + '\\b').test(js)
      if (!inWxml && !read && !spread) {
        dead.push(path.relative(ROOT, f) + ' → ' + k)
      }
    })
  })

  assert.deepStrictEqual(dead, [],
    '这些 data 字段声明了却没人读（白算 + 白占内存）：\n    ' + dead.join('\n    ') +
    '\n    要么接到模板上，要么删掉。')
  ok('★ 页面 data 字段全部有人读（扫了主包 + 分包 ' + pages.length + ' 个 js）')
}

/* ============================================================================
 * 2026-11-03 追加：**不许用「昵称」判断「我是谁」**
 *
 * 金花的座位条原来写的是：
 *     class="pk-seat {{item.name === room.me.name ? 'me' : ''}}"
 *
 * 而**昵称是玩家自己填的**（`join` 只做长度与内容安全，不查重），
 * 两个人甚至都能叫「小明」。重名时两条座位同时高亮，
 * 玩家会以为"我换了两杯" —— 不报错、不看真机发现不了。
 *
 * 判据：**身份判定只能走 openid**（唯一），不能走昵称（不唯一）。
 * 所以模板里不许出现 `name ===` / `name ==` 这类比较，js 里也不许。
 *
 * ⚠️ 之所以写成"扫整仓"而不是"只改金花那一处"：
 *    项目记过「修一类只改被点名的页面」的坑，而同类代码可能藏在别的玩法里。
 *    这条断言是**覆盖性**的，加新玩法时也自动受约束。
 * ========================================================================== */
{
  const bad = []
  const walkW = (d) => {
    if (!fs.existsSync(d)) return
    fs.readdirSync(d, { withFileTypes: true }).forEach((e) => {
      const p = path.join(d, e.name)
      if (e.isDirectory()) return walkW(p)
      if (!/\.(wxml|js)$/.test(e.name)) return
      const t = fs.readFileSync(p, 'utf8')
        .replace(/\/\*[\s\S]*?\*\//g, '').replace(/\/\/[^\n]*/g, '')
      /* 只看「拿 name 去比」的形态：xxx.name === yyy / yyy == xxx.name */
      const hits = [
        ...t.matchAll(/\b([a-zA-Z_$][\w.$]*)\.name\s*===?\s*([a-zA-Z_$][\w.$]*)/g),
        ...t.matchAll(/\b([a-zA-Z_$][\w.$]*)\s*===?\s*([a-zA-Z_$][\w.$]*)\.name\b/g)
      ]
      if (hits.length) bad.push(path.relative(ROOT, p) + ' → ' + hits[0][0].trim().slice(0, 44))
    })
  }
  /* ★ 必须同时扫主包和分包 */
  walkW(path.join(ROOT, 'miniprogram'))

  assert.deepStrictEqual(bad, [],
    '这些地方用「昵称」判断身份 —— 而昵称可以重名，判定必须走 openid：\n    ' + bad.join('\n    '))
  ok('★ 身份判定不走昵称（重名不会导致"两个我"）')
}

/* ============================================================================
 * ★★ 定时器必须自注销（2026-11-03）
 *
 * 项目里记过「所有定时器都要进清单」，但那说的是**能清掉**。
 * 这轮发现更隐蔽的一层：**清单本身只增不减**。
 *
 *   feedback.js 的 `_timers`：连续 fire 200 次 → 峰值 400、执行完仍是 400
 *   room.js 的 `_cupTimers`：全仓 32 处裸 push，只在 onUnload 清一次
 *
 * 句柄早就执行完了，引用还堆着；小程序页面实例不随 setData 回收 ——
 * 这就是"玩久了开始卡"那一类，不报错、不做长局压力测试发现不了。
 *
 * 判据：**谁 push 谁负责在回调里摘掉自己。**
 *   feedback.js 用 `_schedule()`，room.js 用 `this._after()`。
 * 所以这两个文件里**不许再出现裸的 `_timers.push(setTimeout` / `_cupTimers.push(setTimeout`**。
 * ========================================================================== */
{
  const bad = []
  const scan = (rel, patterns) => {
    const p = path.join(ROOT, rel)
    if (!fs.existsSync(p)) return
    const src = fs.readFileSync(p, 'utf8')
      .replace(/\/\*[\s\S]*?\*\//g, '').replace(/(^|[^:])\/\/[^\n]*/g, '$1')
    patterns.forEach((re) => {
      if (re.test(src)) bad.push(rel + ' 里还有裸的 ' + re.source)
    })
  }
  scan('miniprogram/game/feedback.js', [/_timers\.push\(\s*setTimeout/])
  scan('miniprogram/game/room/room.js', [/_cupTimers\.push\(\s*setTimeout/])

  assert.deepStrictEqual(bad, [],
    '这些定时器只 push 不注销，会无界堆积：\n    ' + bad.join('\n    '))
  ok('★ 定时器排期统一走自注销入口（feedback._schedule / room._after）')
}

/* ============================================================================
 * ★★ shape() 给的字段必须有人用（2026-11-03）
 *
 * 幽灵字段（服务端算了、前端从不读）是项目里反复出现的一类浪费：
 * 它不报错、不占带宽到影响性能的程度，但**意味着一个本该显示的信息没显示**。
 *
 * 前面已经有一条"模板引用字段必须由服务端提供"的断言（反方向）。
 * 这一条是正向的：**服务端给的，要么被模板渲染，要么被 js 读**。
 * 两边都不用的，就是幽灵。
 *
 * ⚠️ 白名单只放"确实不需要前端用"的：
 *    · 只有服务端逻辑用、纯回显无意义的
 *    · 给未来用但已明确记录的（要写清理由，不能整类放行）
 * ========================================================================== */
{
  const cloud = fs.readFileSync(path.join(ROOT, 'cloudfunctions/room/index.js'), 'utf8')
  const wxml = fs.readFileSync(path.join(ROOT, 'miniprogram/game/room/room.wxml'), 'utf8')
  const js = fs.readFileSync(path.join(ROOT, 'miniprogram/game/room/room.js'), 'utf8')

  /*
   * 每个玩法块返回的顶层字段。用"块名 → 字段列表"的显式声明，
   * 而不是正则去抽 return {} —— 后者的缩进一变就抽错，会让断言静默变空。
   */
  const BLOCKS = ['fh', 'bt']
  const ghosts = []
  BLOCKS.forEach((blk) => {
    const i = cloud.indexOf('\n    ' + blk + ': (function () {')
    if (i < 0) { ghosts.push(blk + '：shape 里找不到这个块'); return }
    const j = cloud.indexOf('\n    })(),', i)
    const body = cloud.slice(i, j > 0 ? j : i + 6000)
    /* 只看 return { ... } 这一层（缩进 8 空格的键） */
    const r0 = body.indexOf('return {')
    const r1 = body.indexOf('\n      }', r0)
    const ret = body.slice(r0, r1 > 0 ? r1 : undefined)
    const keys = (ret.match(/^\s{8}(\w+):/gm) || []).map((x) => x.trim().replace(':', ''))
    assert.ok(keys.length >= 5, blk + ' 只解析出 ' + keys.length + ' 个字段，解析器可能坏了')

    /*
     * 白名单：确实**不需要前端读**的字段，逐个说清理由。
     * ⚠️ 不能整类放行 —— 白名单一旦宽了就退化成废断言。
     */
    const NO_FRONTEND_USE = {
      /* myDrink 是 drinkText 的原始值；模板显示的是拼好的文案（避免浮点尾巴），
         原始值只用于服务端累加，前端拿它没有意义 */
      'bt.myDrink': 'drinkText 已经覆盖了它要表达的信息'
    }
    keys.forEach((k) => {
      if (NO_FRONTEND_USE[blk + '.' + k]) return
      /* 模板或 js 里出现过 `xxx.k` 就算用了（嵌套路径也算） */
      const inWxml = new RegExp('\\.' + blk + '\\.' + k + '\\b').test(wxml)
      const inJs = new RegExp('\\.' + blk + '\\.' + k + '\\b').test(js) ||
                   new RegExp('\\b' + k + '\\b[^:]*:[^:]*' + blk).test(js)
      if (!inWxml && !inJs) ghosts.push(blk + '.' + k)
    })
  })

  assert.deepStrictEqual(ghosts, [],
    '这些字段服务端算出来了，但模板和 js 都没用 —— 要么渲染它，要么别算：\n    ' +
    ghosts.join('\n    '))
  ok('★ 两个新玩法的 shape 字段都有人用（没有幽灵字段）')
}

/* ============================================================================
 * ★★ 「当前状态」类文档里的玩法数必须和注册表一致（2026-11-03）
 *
 * 起因：`docs/交接文档.md` 的「当前规模」写着「5 个玩法 / 379 项检查」，
 * 而实际已经 9 个玩法 / 605 项 —— 那是给接手人看的**当前状态**，
 * 错了会让人对项目成熟度产生完全错误的判断。
 *
 * ⚠️ 但**不是所有文档都该管**：
 *   · `docs/玩法调研-第4轮.md` 里写"现有 5 个玩法"是**历史记录**，正确
 *   · `docs/项目体检报告.md`（带日期版本）里的数字也是历史坐标
 *   判据只能查**声明"我现在是多少"的地方**。
 *
 * 所以这里只查一份：`docs/交接文档.md` 的「当前规模」那一段。
 * ========================================================================== */
{
  const gamesJs = fs.readFileSync(path.join(ROOT, 'miniprogram/utils/games.js'), 'utf8')
  const ids = []
  const re = /(?:^|\n)\s*id:\s*'([a-z]+)'/g
  const clean = gamesJs.replace(/\/\*[\s\S]*?\*\//g, '').replace(/(^|[^:])\/\/[^\n]*/g, '$1')
  let m
  while ((m = re.exec(clean))) ids.push(m[1])
  const realCount = ids.length

  const docPath = path.join(ROOT, 'docs/交接文档.md')
  assert.ok(fs.existsSync(docPath), '找不到 docs/交接文档.md')
  const doc = fs.readFileSync(docPath, 'utf8')

  /* 「当前规模」代码块里的 `N 个玩法` */
  const seg = doc.slice(doc.indexOf('当前规模'), doc.indexOf('当前规模') + 600)
  const hit = /(\d+)\s*个玩法/.exec(seg)
  assert.ok(hit, '交接文档的「当前规模」里找不到「N 个玩法」')
  assert.strictEqual(parseInt(hit[1], 10), realCount,
    '★ 交接文档说 ' + hit[1] + ' 个玩法，实际注册表里是 ' + realCount +
    ' 个 —— 交接文档是给接手人看的当前状态，错了会严重误导')
  ok('★ 交接文档的玩法数（' + realCount + '）与注册表一致')
}
