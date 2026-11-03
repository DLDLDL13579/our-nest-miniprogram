/**
 * test-assets.js —— 有没有"躺在包里但没人用"的图片
 *
 * ============ 为什么需要它，以及第一版为什么是废的 ============
 *
 * 图片是包体积的大头。一张没人用的牌面就是 2KB，一副牌 52 张就是 100KB。
 *
 * 但第一版扫描**报出 58 个假阳性**：cup-up、card/c1-5 ……
 * 原因：路径是**插值拼出来的** ——
 *     src="/game/images/cup/{{diceCount > 0 ? 'cup-down' : 'cup-shake'}}.png"
 *     src="/game/images/card/c{{s}}-{{r}}.png"
 * 第一版按"整串路径出现在代码里"匹配，当然匹配不到。**差点删掉在用的资源。**
 *
 * 现在先把 `{{...}}` 归一成 `§`（通配），再去匹配"文件名 = 前缀 + 可变 + 后缀"。
 *
 * 跑法：node scripts/test-assets.js
 */
const fs = require('fs')
const path = require('path')

const ROOT = path.join(__dirname, '..')
const MP = path.join(ROOT, 'miniprogram')

/* 收集代码（插值归一成 §） */
let code = ''
;(function walk(d) {
  for (const f of fs.readdirSync(d, { withFileTypes: true })) {
    const fp = path.join(d, f.name)
    if (f.isDirectory()) { walk(fp); continue }
    if (!/\.(js|wxml)$/.test(f.name)) continue
    code += fs.readFileSync(fp, 'utf8').replace(/\{\{[\s\S]*?\}\}/g, '§')
  }
})(MP)

/*
 * ★★ 2026-11-03：**云函数里也可能出现包内图片路径**。
 *
 *   起因：红黑单双大小的骰子图片路径由 `shape()` 下发
 *   （因为模板里做三元拼接的目录名，契约断言解析不了、会误报"文件不存在"）。
 *   而这条孤儿图检测只扫 `miniprogram/` —— 于是那 6 张红色骰子
 *   被判成"包里没人引用"。
 *
 *   这是断言的**扫描范围**问题，不是"放宽判据"：
 *   云函数里出现的 `/game/images/xxx.png` 确实是在描述一个包内资源，
 *   扫它不会掩盖任何真实问题（拼错路径反而会被孤儿检测抓到）。
 *
 *   ⚠️ 只扫 cloudfunctions 下的 .js，且只取含 `/game/images/` 或 `/images/`
 *      字面量的行 —— 不把整个云端源码混进来（那会把别处的 `/` 也当路径）。
 */
;(function walkCloud(d) {
  if (!fs.existsSync(d)) return
  for (const f of fs.readdirSync(d, { withFileTypes: true })) {
    const fp = path.join(d, f.name)
    if (f.isDirectory()) { walkCloud(fp); continue }
    if (!f.name.endsWith('.js')) continue
    const src = fs.readFileSync(fp, 'utf8')
    /*
     * 云端是**拼接**出来的路径（`'/game/images/dice-red/dice-' + face + '.png'`），
     * 所以要按字符串字面量逐个抽，再自己拼成 § 模板。
     * 这里处理的是"含 game/images 前缀的那一段字面量"。
     */
    /*
     * 云端拼路径的形态是：'/game/images/dice-red/dice-' + c.face + '.png'
     * 也就是"前半段字面量 + 变量 + 后半段字面量"。
     * 这里直接按**整行**找这种形态，拼成 § 模板交给后面的匹配。
     */
    src.split('\n').forEach((line) => {
      const m = line.match(/'([^']*(?:\/game\/images|\/images)\/[^']*)'/)
      if (!m) return
      let tpl = m[1]
      /*
       * ★ 必须补成"带扩展名的完整模板"。
       *   下游的模板正则要求路径**以 .png 结尾**，
       *   而云端拼出来的前半段是 `.../dice-`（没有扩展名）——
       *   不补的话这条模板永远匹配不到任何文件（假阴性）。
       */
      if (!/\.(png|jpg|jpeg)$/.test(tpl)) tpl += '§.png'
      code += tpl + ' '
    })
  }
})(path.join(ROOT, 'cloudfunctions'))

/* 所有图片 */
const images = []
;(function walk(d) {
  for (const f of fs.readdirSync(d, { withFileTypes: true })) {
    const fp = path.join(d, f.name)
    if (f.isDirectory()) { walk(fp); continue }
    if (/\.(png|jpg|jpeg)$/.test(f.name)) images.push(fp)
  }
})(MP)

const used = (fp) => {
  const rel = path.relative(MP, fp).split(path.sep).join('/')
  /* ① 静态引用 */
  if (code.includes(rel) || code.includes('/' + rel)) return true
  /*
   * ② 动态拼接：把代码里所有"含 § 的路径模板"抽出来，当成通配模式去匹配。
   *
   * ⚠️ 这里改过两版：
   *   v1 按"整串出现在代码里"匹配 → 58 个动态路径全被误判成"没用到"。
   *   v2 用"字面前缀 + 可变段 + 字面后缀"拆分 → **只支持一个插值**，
   *      而 `c{{s}}-{{r}}.png` 有两个 § → 匹配不上，反而把在用的牌面报成孤儿。
   *   v3（这版）把 § 直接当通配符 `*` 做整串匹配，几个插值都无所谓。
   */
  const base = path.basename(fp)
  // 代码里所有"以图片扩展名结尾、且含 § 的路径片段"
  const tmplRe = /[A-Za-z0-9_/.§-]*§[A-Za-z0-9_/.§-]*\.(?:png|jpg|jpeg)/g
  let m
  while ((m = tmplRe.exec(code))) {
    /*
     * ⚠️ 必须拿**完整路径**去匹配，不能只取文件名 ——
     *    `cup/{{cupSrc}}.png` 只取文件名会变成 `§.png`，
     *    于是"匹配任意 png"，加一个孤儿图也报不出来（假阴性）。
     *    目录部分恰恰是这类模板唯一的约束。
     */
    let tpl = m[0]
    if (tpl.startsWith('/')) tpl = tpl.slice(1)     // /game/... → game/...
    if (!tpl.startsWith('game/') && !tpl.startsWith('images/')) {
      /* 模板不是从包根写起的（如只写了 `-{{r}}.png`），无法定位 → 跳过，宁可漏报 */
      continue
    }
    const re = new RegExp('^' + tpl.replace(/[.]/g, '\\.').replace(/§/g, '[^/]*') + '$')
    if (re.test(rel)) return true
  }
  return false
}

const unused = images.filter(f => !used(f))
if (unused.length) {
  console.log('✗ 这些图片在包里但没有任何地方引用（白占包体积）：')
  let kb = 0
  for (const f of unused) {
    const s = fs.statSync(f).size
    kb += s
    console.log(`    ${path.relative(ROOT, f)} (${Math.round(s / 1024)}KB)`)
  }
  console.log(`    合计约 ${Math.round(kb / 1024)}KB`)
  console.log('    ⚠️ 删之前先确认：路径会不会是**其他形式**拼出来的（变量、数组索引）')
  process.exit(1)
}
console.log(`✓ ${images.length} 张图片全部有引用（含插值拼路径）`)
