#!/usr/bin/env node
/**
 * render-ui.js —— 把真实页面渲染成图片（无头 Chrome，不占屏幕、不抢焦点）
 *
 * 用法：
 *   node scripts/render-ui.js                 # 渲染全部页面
 *   node scripts/render-ui.js index           # 只渲染首页
 *   node scripts/render-ui.js index --state empty   # 指定状态（见 mock 里的 states）
 *   node scripts/render-ui.js --all --scale 2
 *
 * 产物：outputs/ui/<页面>-<状态>.png
 *
 * ★ 为什么要有这个工具
 *   用户明确禁止打开微信开发者工具（硬约束），而「审查界面」必须有眼睛。
 *   这里读的是**仓库里真实的 .wxml / .wxss / app.wxss**，不是手抄的副本。
 *   改完代码重跑一次，就能做前后对比 —— 这是本轮所有视觉结论的依据。
 *
 * ★ 已知近似（不影响布局判断，但结论要按此打折）
 *   · rpx 按 375pt 屏换算成 px（1rpx = 0.5px）
 *   · 没有小程序的原生导航栏 / tabBar（用 HTML 简写近似）
 *   · image 的 mode 映射成 object-fit
 *   · 字体用系统 PingFang SC，和 iOS 真机一致
 */

const fs = require('fs')
const path = require('path')
const { execFileSync } = require('child_process')
const { parseWxml, render, getWarnings, takePhCss } = require('./ui-render/wxml.js')

const ROOT = path.resolve(__dirname, '..')
const MP = path.join(ROOT, 'miniprogram')
const OUT = path.join(ROOT, 'outputs', 'ui')
const CHROME = '/Applications/Google Chrome.app/Contents/MacOS/Google Chrome'

/* ---------------- CSS ---------------- */

/**
 * wxss → css：
 *   · rpx → px（按 375 宽）
 *   · `page {` → `body {`（小程序的 page 就是根容器）
 *   · `@import` 展开
 */
/**
 * rpx → px。
 *
 * ★ 必须对**最终整份 CSS** 再跑一次：图内样式、以及渲染期才生成的规则
 *   （placeholder-style）都不经过 wxssToCss，第一版就漏了它们 ——
 *   `28rpx` 在浏览器里是无效单位被忽略，placeholder 于是用了继承字号，
 *   截图上是"字被拉大"，很容易误判成设计问题。
 */
function convertRpx(css) {
  return css.replace(/(-?\d*\.?\d+)rpx/g, (_, n) => {
    const px = Number(n) * 0.5
    return (Math.round(px * 100) / 100) + 'px'
  })
}

function wxssToCss(file, seen = new Set()) {
  if (seen.has(file) || !fs.existsSync(file)) return ''
  seen.add(file)
  let css = fs.readFileSync(file, 'utf8')

  // 展开 @import（相对该文件）
  css = css.replace(/@import\s+["']([^"']+)["']\s*;?/g, (_, p) => {
    const abs = path.resolve(path.dirname(file), p)
    return wxssToCss(abs, seen)
  })

  // 注释留着无妨，但为了 HTML 干净先剥掉
  css = css.replace(/\/\*[\s\S]*?\*\//g, '')

  // rpx → px（统一交给 convertRpx，最后会对整份 CSS 再跑一次兜底）
  css = convertRpx(css)

  // 根选择器
  css = css.replace(/(^|\})\s*page\s*\{/g, '$1 body {')
  /*
   * ★★★ 2026-10-30：**选择器也要跟 TAG_MAP 一起改**。
   *
   * 渲染器把 wxml 的 `<view>` 输出成 `<div>`、`<text>` 输出成 `<span>`
   * （见 ui-render/wxml.js 的 TAG_MAP），但 wxss 里的选择器原样保留 ——
   * 于是 `view { box-sizing: border-box }` 这类规则**永远匹配不到任何元素**。
   *
   * 后果：`.sheet { width:100%; box-sizing:border-box }` 的 border-box 失效，
   * padding 把宽度撑出屏幕 → 所有弹层右侧溢出
   * （渲染图实测 cardPanelOpen 溢出 25%）。而真机上是对的。
   *
   * 这个 bug 让"弹层溢出"这个假象骗了我好几轮（我先怪过 app.wxss 没加载、
   * 又怪过父级 transform 让 fixed 退化，都不是）。
   */
  css = css.replace(/(^|[\s,>+~(])(view|text)(?=[\s,{:>+~.)])/g, (m, pre, tag) =>
    pre + (tag === 'view' ? 'div' : 'span'))

  return css
}

/* ---------------- 数据 ---------------- */

const icons = require(path.join(MP, 'utils', 'icons.js'))

/** 从 wxml 里自动收集 {{ic.xxx}} 用到的图标，生成真实 data URI */
function buildIcons(wxmlSrc, color) {
  const keys = new Set()
  wxmlSrc.replace(/\bic\.([a-zA-Z0-9_]+)/g, (_, k) => { keys.add(k); return '' })
  const ic = {}
  for (const k of keys) {
    if (!icons.PATHS[k]) { ic[k] = ''; continue }
    ic[k] = icons.dataUri(k, color || '#C4553F')
  }
  return ic
}

function loadMock(pageKey, stateName) {
  const f = path.join(__dirname, 'ui-render', 'mock', pageKey + '.js')
  if (!fs.existsSync(f)) return {}
  delete require.cache[require.resolve(f)]
  const m = require(f)
  const states = m.states || {}
  const base = typeof m.data === 'function' ? m.data() : (m.data || {})
  /*
   * ★★★ 2026-10-30：状态名不存在时**必须报错**，不能静默回退。
   *
   * 之前写 `states[stateName] || {}` —— 传错名字（比如 pkAsk / pkDrinks）
   * 会静默渲染成 base 大厅，看起来"渲染成功"，实际是**完全另一个界面**。
   * 我就这样白看了好几张"金花状态"的截图，它们其实是大厅。
   */
  if (stateName && !states[stateName]) {
    const known = Object.keys(states).sort().join(' ')
    console.error('✗ 没有这个状态: ' + stateName)
    console.error('  可用状态: ' + known)
    process.exit(1)
  }
  const extra = typeof states[stateName] === 'function' ? states[stateName]() : (states[stateName] || {})
  // 深合并一层够用
  const merged = Object.assign({}, base)
  for (const k of Object.keys(extra)) {
    const a = merged[k], b = extra[k]
    merged[k] = (a && b && typeof a === 'object' && typeof b === 'object' && !Array.isArray(a))
      ? Object.assign({}, a, b) : b
  }
  return merged
}

/* ---------------- HTML ---------------- */

const BASE_CSS = `
  html, body { margin:0; padding:0; }
  body { width:375px; min-height:100%; }
  /* 小程序里 <image> 未指定尺寸时按 320x240 的默认盒子渲染 ——
     这里照样给默认值，才能让「忘了写尺寸」的坑在截图上暴露出来 */
  img { display:inline-block; width:320px; height:240px; vertical-align:middle; }
  div { display:block; }
  input, textarea { font-family:inherit; font-size:inherit; border:none; outline:none; background:none; }
  input::placeholder, textarea::placeholder { color:#A39B90; }
  /*
   * ★ 动画必须"立即跑完"，否则截图拍到的是**初始态**。
   *
   * 本项目大量用 animation: x .5s ... backwards 做入场编排，
   * backwards 填充意味着 t=0 时元素就是 opacity:0 / translateY(...)。
   * 无头 Chrome 截图不等动画 → 拍出来整页空白
   *（第一版就是：只剩 hero 的色块底，一个字都没有）。
   *
   * 用 duration:0s + delay:0s 让动画瞬间到 100%，
   * 保留"最终态"，不改变任何布局结果。
   */
  *, *::before, *::after {
    animation-duration: .001s !important;
    animation-delay: 0s !important;
    animation-iteration-count: 1 !important;
    transition-duration: 0s !important;
  }
`

function shell({ pageTitle, css, inner, tabbar }) {
  return `<!doctype html><html lang="zh-CN"><head><meta charset="utf-8">
<meta name="viewport" content="width=375,initial-scale=1">
<style>${BASE_CSS}</style>
<style>${css}</style>
</head><body>
<!-- 小程序导航栏（简写近似） -->
<div style="height:44px;display:flex;align-items:center;justify-content:center;
            font-size:17px;font-weight:600;color:#2C2822;background:#F5F0EA;
            position:sticky;top:0;z-index:9">${pageTitle || '我们的小窝'}</div>
${inner}
${tabbar || ''}
</body></html>`
}

function tabbarHtml(active) {
  const items = [['大厅', 'pages/lobby/lobby'], ['我的', 'pages/me/me']]
  const cells = items.map(([t, p]) => {
    const on = p === active
    return `<div style="flex:1;text-align:center;font-size:11px;padding:10px 0;letter-spacing:1px;
      color:${on ? '#E0714F' : '#9A9188'};font-weight:${on ? '600' : '400'}">${t}</div>`
  }).join('')
  return `<div style="position:fixed;left:0;bottom:0;width:375px;height:50px;display:flex;
    background:#FFFDF9;border-top:1px solid #EDE6DC;z-index:20">${cells}</div>
    <div style="height:56px"></div>`
}

/* ---------------- 主流程 ---------------- */

const PAGES = {
  lobby: { path: 'pages/lobby/lobby', title: '酒桌', tab: 'pages/lobby/lobby' },
  room: { path: 'game/room/room', title: '房间' },
  me: { path: 'pages/me/me', title: '我的', tab: 'pages/me/me' }
}

/**
 * ★★ 画布高度必须等于**真机内容区高度**，否则"一屏放得下"这个结论是假的。
 *
 * 2026-10-28 发现：room mock 的 `__height` 一直是 1400px，
 * 而 iPhone 13 去掉状态栏 47 与导航栏 44 后内容区只有 **753px**。
 * 也就是说此前所有截图都是把屏幕拉长到 1.86 倍拍的 ——
 * 画面上半截空着，看着很舒展，真机上却要往下滚将近一屏。
 *
 * 这正是 AGENTS.md 反复记过的"测量工具本身没被验证过"：
 * 判据看着对，尺子是坏的。
 *
 * 现在默认按真机高度出图；要看完整超长页面用 `--full`。
 */
const DEVICE = { width: 375, height: 753 }   // iPhone 13：844 − 47（状态栏）− 44（导航栏）

function renderPage(key, { state = 'default', outDir = OUT, width = 0, height = 0, full = false } = {}) {
  const conf = PAGES[key]
  if (!conf) throw new Error('未知页面: ' + key)
  const base = path.join(MP, conf.path)
  const wxmlFile = base + '.wxml'
  const wxssFile = base + '.wxss'
  const wxmlSrc = fs.readFileSync(wxmlFile, 'utf8')

  const mock = loadMock(key, state)
  const data = Object.assign({}, mock)
  data.ic = Object.assign(buildIcons(wxmlSrc, '#C4553F'), mock.ic || {})
  // 页面 js 里的 data 是默认值，mock 没给的就用空默认，避免表达式报错
  const ast = parseWxml(wxmlSrc)
  const inner = render(ast, data)

  let css = ''
  css += wxssToCss(path.join(MP, 'app.wxss'))
  css += '\n' + wxssToCss(wxssFile)
  /* placeholder-style 是运行时生成的规则，必须在 render 之后取 */
  css += '\n' + takePhCss()
  /* 统一兜底：任何后加的规则也要完成 rpx → px */
  css = convertRpx(css)

  const html = shell({
    pageTitle: conf.title,
    css,
    inner,
    tabbar: conf.tab ? tabbarHtml(conf.tab) : ''
  })

  fs.mkdirSync(outDir, { recursive: true })
  const name = key + (state === 'default' ? '' : '-' + state)
  const htmlFile = path.join(outDir, name + '.html')
  const pngFile = path.join(outDir, (full ? name + '@full' : name) + '.png')
  fs.writeFileSync(htmlFile, html)

  const w = width || DEVICE.width
  const h = height || (full ? (mock.__height || 1400) : DEVICE.height)
  execFileSync(CHROME, [
    '--headless=new', '--disable-gpu', '--no-sandbox', '--hide-scrollbars',
    '--force-device-scale-factor=2',
    '--screenshot=' + pngFile,
    '--window-size=' + w + ',' + h,
    'file://' + htmlFile
  ], { stdio: 'ignore', timeout: 60000 })

  const warns = getWarnings()
  return { key, state, png: pngFile, html: htmlFile, width: w, height: h, warnings: warns.slice() }
}

module.exports = { renderPage, PAGES }

/* ---------------- CLI ---------------- */

if (require.main === module) {
  const args = process.argv.slice(2)
  const state = (() => {
    const i = args.indexOf('--state')
    return i >= 0 ? args[i + 1] : 'default'
  })()
  const states = (() => {
    const i = args.indexOf('--states')
    return i >= 0 ? args[i + 1].split(',') : null
  })()
  const height = (() => {
    const i = args.indexOf('--height')
    return i >= 0 ? Number(args[i + 1]) : 0
  })()
  const full = args.includes('--full')
  const keys = args.filter((a, i) => !a.startsWith('--') &&
    !(i > 0 && /^--/.test(args[i - 1])))
  const targets = keys.length ? keys : Object.keys(PAGES)

  let ok = 0
  for (const k of targets) {
    const list = states || [state]
    for (const s of list) {
      try {
        const r = renderPage(k, { state: s, full, height })
        const warn = r.warnings.length ? `  ⚠ ${r.warnings.length} 个表达式失败` : ''
        console.log(`  ✓ ${k}${s === 'default' ? '' : '/' + s} → ${path.relative(ROOT, r.png)}` +
          `  (${r.width}×${r.height})${warn}`)
        if (r.warnings.length) r.warnings.slice(0, 3).forEach(w => console.log('      ' + w))
        ok++
      } catch (e) {
        console.log(`  ✗ ${k}${s === 'default' ? '' : '/' + s}: ${e.message}`)
      }
    }
  }
  console.log(`\n共渲染 ${ok} 张 → outputs/ui/`)
}
