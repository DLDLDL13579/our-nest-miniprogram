#!/usr/bin/env node
/**
 * check-css-applied.js —— 确认「某条 CSS 规则**真的生效了**」
 *
 * ============ 为什么需要这个 ============
 *
 * 2026-11-03 做小屏紧凑模式时，同一个功能上踩了 **五个**坑，
 * 而它们的表现**完全一样**：改了 CSS，渲染图没变。
 *
 *   ① 选择器写错（class 名猜成 lb-title，实际是 lb-t）
 *   ② 被更后面的同名规则覆盖（.cs-die-scene 写了两次）
 *   ③ 那条规则的条件没触发（mock 缺 compact 字段）
 *   ④ 值的方向错（想缩小却写大了）
 *   ⑤ 改了但没到"看得见"的程度（骰盅 430→340，按钮还在首屏外）
 *
 * 前四个都能用这个脚本一次问清楚：**给选择器 + 属性，问浏览器实际值是多少**。
 *
 * ============ 用法 ============
 *   node scripts/check-css-applied.js '.page.compact .lb-hero' 'padding-top'
 *   node scripts/check-css-applied.js '.gamepage.compact .cs-cup' 'width'
 *
 * 输出：实际计算值。如果它等于你期望的值 → 规则生效了；
 *       如果不等 → 去看是 ① ② ③ ④ 哪一个。
 */
const fs = require('fs')
const os = require('os')
const path = require('path')
const { execFileSync } = require('child_process')

const CHROME = '/Applications/Google Chrome.app/Contents/MacOS/Google Chrome'
const ROOT = path.dirname(__dirname)

function wxssToCss() {
  /* 所有 wxss 拼起来，rpx 换成 px（750rpx = 375px，1rpx = 0.5px） */
  let css = ''
  const walk = (d) => {
    if (!fs.existsSync(d)) return
    fs.readdirSync(d).forEach(f => {
      const p = path.join(d, f)
      if (fs.statSync(p).isDirectory()) return walk(p)
      if (f.endsWith('.wxss')) css += fs.readFileSync(p, 'utf8') + '\n'
    })
  }
  walk(path.join(ROOT, 'miniprogram'))
  return css
    .replace(/\/\*[\s\S]*?\*\//g, '')
    .replace(/(\d+(?:\.\d+)?)rpx/g, (_, n) => (Number(n) / 2) + 'px')
    .replace(/(^|\})\s*page\s*\{/g, '$1 body {')
}

function main() {
  const [selector, prop] = process.argv.slice(2)
  if (!selector || !prop) {
    console.error('用法: node scripts/check-css-applied.js <选择器> <属性名>')
    process.exit(2)
  }

  const css = wxssToCss()
  /*
   * 构造最小 DOM —— 只支持 class 选择器。
   *
   * ⚠️ 关键：**空格前的一段（复合选择器）必须放在同一个元素上**。
   *   `.gamepage.compact .cs-cup` 里 `gamepage` 和 `compact` 是**同一个 div** 的
   *   两个 class；而第一版把它们拆成父子两层 → 规则完全不匹配 → 工具报出基础值
   *   （180px 而不是 90px），而我差点以为是 CSS 没写对。
   */
  const groups = selector.split(/\s+/).map(g =>
    [...g.matchAll(/\.([\w-]+)/g)].map(m => m[1]).filter(Boolean))
  if (!groups.length || groups.some(g => !g.length)) {
    console.error('只支持 class 选择器（形如 .a.b .c）')
    process.exit(2)
  }
  let dom = ''
  let close = ''
  groups.forEach(g => {
    dom += `<div class="${g.join(' ')}">`
    close = '</div>' + close
  })
  dom += '<span class="probe-leaf">probe</span>' + close

  const html = `<!DOCTYPE html><html><head><meta charset="utf-8"><style>${css}
body { margin: 0 } .probe-leaf { display: block }
</style></head><body>${dom}
<script>
const el = document.querySelector('.probe-leaf').parentElement;
const cs = getComputedStyle(el);
document.title = 'VALUE=' + cs.getPropertyValue('${prop}');
</script></body></html>`

  const tmp = path.join(os.tmpdir(), 'css-applied.html')
  fs.writeFileSync(tmp, html)
  const out = execFileSync(CHROME, ['--headless=new', '--disable-gpu', '--no-sandbox',
    '--virtual-time-budget=1200', '--dump-dom', 'file://' + tmp],
    { encoding: 'utf8', stdio: ['ignore', 'pipe', 'ignore'] })
  const m = /<title>VALUE=([^<]*)<\/title>/.exec(out)
  if (!m) {
    console.error('✗ 没取到计算值')
    process.exit(1)
  }
  console.log(selector + ' → ' + prop + ' = ' + (m[1] || '(空)'))
}

main()
