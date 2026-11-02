#!/usr/bin/env node
/**
 * verify-compact.js —— 验证「小屏紧凑布局」的规则真的生效
 *
 * ============ 为什么不用截图验证 ============
 *
 * 2026-11-02 想验 `.gamepage.compact` 的那批规则，用渲染器截图时发现：
 *
 *   · 同一份 HTML，`--dump-dom` + `getComputedStyle` 返回
 *       NOTE_DISPLAY=none  FLIP_W=59px      ← 规则生效
 *   · 而 `--screenshot` 拍出来的图里
 *       说明行还在、牌还是 68px             ← 像是没生效
 *
 *   加了 `--virtual-time-budget=800` 也没解决。
 *   **也就是说：截图这个测量方式，对"靠后声明/需要重新布局的规则"不可信。**
 *
 *   这正是 AGENTS.md 记过的"测量工具本身没被验证过"——
 *   而我这次是靠"图没变"才发现尺子有问题的。
 *
 * 所以改成**直接问浏览器**：把 HTML 喂给 Chrome，用 JS 读 computed style。
 * 它验的是"浏览器真正算出来的值"，不经过截图这一层。
 *
 * ============ 那之前的截图验证还算数吗 ============
 *
 * 算数。事后系统性复核过一遍：抽查「8 种头像色」「玩法卡 48.5%」「转盘配色」
 * 这些**之前靠截图判断过**的规则，用 getComputedStyle 读回来全部一致
 * （`.pav.s0` = rgb(199,117,117) = #C77575 等）。
 *
 * 也就是说**漏的是特定的那一类**：
 *   · 改 `display`（元素出现/消失）
 *   · 改 `width/height`（需要重新布局）
 *   · 且规则**声明位置靠后**（后代选择器叠加出来的那条）
 *
 * 而"改颜色 / 改字号 / 加边框"这些截图都如实反映。
 *
 * 判据：**截图能证明"样子对不对"，不能证明"这条规则有没有被应用"。**
 * 前者用眼睛，后者必须问浏览器。
 */
const { execFileSync } = require('child_process')
const fs = require('fs')
const path = require('path')

const ROOT = path.resolve(__dirname, '..')
const CHROME = '/Applications/Google Chrome.app/Contents/MacOS/Google Chrome'
const OUT = path.join(ROOT, 'outputs/ui')

/* 期望值：小屏时这些元素应该变成什么样 */
const EXPECT = [
  { sel: '.pk-note', prop: 'display', want: 'none', desc: '说明行隐藏' },
  { sel: '.pk-flip', prop: 'width', want: '59px', desc: '牌区缩小到 118rpx' },
  { sel: '.pk-side', prop: 'width', want: '59px', desc: '牌面同步缩小' }
]

function probe(htmlFile) {
  const html = fs.readFileSync(htmlFile, 'utf8')
  const sels = JSON.stringify(EXPECT.map(e => [e.sel, e.prop]))
  const inject = `<script>
    setTimeout(() => {
      const want = ${sels};
      const out = want.map(([sel, prop]) => {
        const el = document.querySelector(sel);
        return sel + '|' + prop + '|' +
          (el ? getComputedStyle(el)[prop] : 'NO_EL');
      });
      document.title = 'RESULT:' + out.join(';;');
    }, 300);
  </script>`
  const tmp = path.join(OUT, '__probe.html')
  fs.writeFileSync(tmp, html.replace('</body>', inject + '</body>'))
  let title = ''
  try {
    const dom = execFileSync(CHROME, ['--headless=new', '--disable-gpu', '--no-sandbox',
      '--virtual-time-budget=1500', '--dump-dom', 'file://' + tmp],
      { encoding: 'utf8', timeout: 60000, stdio: ['ignore', 'pipe', 'ignore'] })
    const m = /<title>RESULT:([^<]*)<\/title>/.exec(dom)
    title = m ? m[1] : ''
  } catch (e) {
    title = ''
  } finally {
    try { fs.unlinkSync(tmp) } catch (e) {}
  }
  return title
}

function main() {
  const f = path.join(OUT, 'room-compactPk.html')
  if (!fs.existsSync(f)) {
    console.error('先渲染一次：node scripts/render-ui.js room --state compactPk')
    process.exit(1)
  }
  const raw = probe(f)
  if (!raw) {
    console.error('✗ Chrome 没返回结果（可能是虚拟时间不够）')
    process.exit(1)
  }
  const got = {}
  raw.split(';;').forEach(t => {
    const [sel, prop, val] = t.split('|')
    got[sel + '.' + prop] = val
  })

  console.log('\n=== 小屏紧凑布局：直接问浏览器算出来的值 ===')
  let bad = 0
  EXPECT.forEach(e => {
    const key = e.sel + '.' + e.prop
    const actual = got[key]
    const ok = actual === e.want
    if (!ok) bad++
    console.log(`  ${ok ? '✓' : '✗'} ${e.desc.padEnd(22)} ${key} = ${actual}` +
      (ok ? '' : `（期望 ${e.want}）`))
  })
  console.log(bad ? `\n✗ ${bad} 项不符合` : '\n✓ 全部符合')
  process.exit(bad ? 1 : 0)
}

main()
