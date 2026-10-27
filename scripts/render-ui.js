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
const { parseWxml, render, getWarnings } = require('./ui-render/wxml.js')

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

  // rpx → px
  css = css.replace(/(-?\d*\.?\d+)rpx/g, (_, n) => {
    const px = Number(n) * 0.5
    return (Math.round(px * 100) / 100) + 'px'
  })

  // 根选择器
  css = css.replace(/(^|\})\s*page\s*\{/g, '$1 body {')

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
  room: { path: 'pages/room/room', title: '房间' },
  me: { path: 'pages/me/me', title: '我的', tab: 'pages/me/me' }
}

function renderPage(key, { state = 'default', outDir = OUT, width = 375 } = {}) {
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

  const html = shell({
    pageTitle: conf.title,
    css,
    inner,
    tabbar: conf.tab ? tabbarHtml(conf.tab) : ''
  })

  fs.mkdirSync(outDir, { recursive: true })
  const name = key + (state === 'default' ? '' : '-' + state)
  const htmlFile = path.join(outDir, name + '.html')
  const pngFile = path.join(outDir, name + '.png')
  fs.writeFileSync(htmlFile, html)

  const h = mock.__height || 1400
  execFileSync(CHROME, [
    '--headless=new', '--disable-gpu', '--no-sandbox', '--hide-scrollbars',
    '--force-device-scale-factor=2',
    '--screenshot=' + pngFile,
    '--window-size=' + width + ',' + h,
    'file://' + htmlFile
  ], { stdio: 'ignore', timeout: 60000 })

  const w = getWarnings()
  return { key, state, png: pngFile, html: htmlFile, warnings: w.slice() }
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
  const keys = args.filter((a, i) => !a.startsWith('--') &&
    !(i > 0 && /^--/.test(args[i - 1])))
  const targets = keys.length ? keys : Object.keys(PAGES)

  let ok = 0
  for (const k of targets) {
    const list = states || [state]
    for (const s of list) {
      try {
        const r = renderPage(k, { state: s })
        const warn = r.warnings.length ? `  ⚠ ${r.warnings.length} 个表达式失败` : ''
        console.log(`  ✓ ${k}${s === 'default' ? '' : '/' + s} → ${path.relative(ROOT, r.png)}${warn}`)
        if (r.warnings.length) r.warnings.slice(0, 3).forEach(w => console.log('      ' + w))
        ok++
      } catch (e) {
        console.log(`  ✗ ${k}${s === 'default' ? '' : '/' + s}: ${e.message}`)
      }
    }
  }
  console.log(`\n共渲染 ${ok} 张 → outputs/ui/`)
}
