#!/usr/bin/env node
/**
 * check-text-overflow.js —— 用 getComputedStyle 验证「长文本会不会溢出容器」
 *
 * ============ 为什么不用截图 ============
 *
 * 2026-11-03 修「规则弹层的文字被右侧裁切」时：
 *   · 我给 `.ht-t` 加了 `display: block; min-width: 0; word-break: break-word`
 *   · 重新渲染后**图片字节数完全没变**（302005 → 302005）
 *   · 于是我以为"改没生效"，准备去查渲染器
 *
 * 而 `verify-compact.js` 的注释早就写过：
 *   同一份 HTML，`getComputedStyle` 说规则生效，而 `--screenshot` 拍出来像没生效。
 *   **截图对 display / 重排类的规则不可信。**
 *
 * 这个脚本就是那个结论的复用：直接问浏览器"有没有溢出"。
 *
 * ============ 用法 ============
 *   改完涉及长文本的 wxss 后跑一次。`scrollW == width` 就是没溢出。
 */
const fs = require('fs');
const path = require('path');
const os = require('os');
const { execFileSync } = require('child_process');
const CHROME = '/Applications/Google Chrome.app/Contents/MacOS/Google Chrome';
const ROOT = '/Users/meihaoshidai/Downloads/邓林work/个人项目/小程序';

let css = fs.readFileSync(path.join(ROOT, 'miniprogram/game/room/room.wxss'), 'utf8');
css = css.replace(/\/\*[\s\S]*?\*\//g, '');
css = css.replace(/(\d+(?:\.\d+)?)rpx/g, (_, n) => (Number(n) / 2) + 'px');

const html = `<!DOCTYPE html><html><head><meta charset="utf-8"><style>${css}</style></head>
<body><div class="ht-list"><div class="ht-item"><span class="ht-n">3</span><span class="ht-t">往上叫 = 数量加一，或者数量不变、点数更大（三个四 → 四个四 或 三个五）</span></div></div>
<script>
const el = document.querySelector('.ht-t');
const cs = getComputedStyle(el);
document.title = 'display=' + cs.display + ' minWidth=' + cs.minWidth + ' wordBreak=' + cs.wordBreak + ' width=' + el.getBoundingClientRect().width.toFixed(1) + ' scrollW=' + el.scrollWidth;
</script></body></html>`;

const tmp = path.join(os.tmpdir(), 'ht-check.html');
fs.writeFileSync(tmp, html);
const dom = execFileSync(CHROME, ['--headless=new', '--disable-gpu', '--no-sandbox',
  '--virtual-time-budget=1500', '--dump-dom', 'file://' + tmp], { encoding: 'utf8' });
const m = /<title>([^<]*)<\/title>/.exec(dom);
const info = m ? m[1] : '';

if (!info) {
  console.log('  ✗ 没取到 getComputedStyle 结果')
  process.exit(1)
}

const width = /width=([\d.]+)/.exec(info)
const scrollW = /scrollW=([\d.]+)/.exec(info)
const overflow = width && scrollW && Number(scrollW[1]) > Number(width[1]) + 1

console.log('  ' + info)
if (overflow) {
  console.log('  ✗ 长文本溢出容器（scrollW ' + scrollW[1] + ' > width ' + width[1] + '）')
  process.exit(1)
}
console.log('  ✓ 规则弹层的长文本不溢出（display=' +
  (/display=(\S+)/.exec(info) || [])[1] + '，scrollW == width）')
