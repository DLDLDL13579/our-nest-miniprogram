#!/usr/bin/env python3
"""
把 outputs/ui/ 里某个页面的全部状态拼成一张联系表（contact sheet）。

为什么需要：逐张打开看太慢，而"整体扫一眼"恰恰能发现
**单个界面对比不出来**的问题（某个状态的某块内容缺失、某个按钮只在某状态出现）。
2026-10-28 就是靠它发现 loading 幕的遮罩只铺到 3/4 处。

用法：
    python3 scripts/contact-sheet.py room
    python3 scripts/contact-sheet.py lobby --cols 3
"""
import os
import sys
import time
import glob
from PIL import Image, ImageDraw, ImageFont

ROOT = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))
UI = os.path.join(ROOT, 'outputs', 'ui')


def pick_font(size):
    """探测能渲染中文的字体；找不到就抛错（不许静默退化成方块）。"""
    for path, idxs in [
        ('/System/Library/Fonts/Hiragino Sans GB.ttc', [0, 1]),
        ('/System/Library/Fonts/STHeiti Medium.ttc', [0]),
        ('/Library/Fonts/Arial Unicode.ttf', [0]),
    ]:
        if not os.path.exists(path):
            continue
        for idx in idxs:
            try:
                f = ImageFont.truetype(path, size, index=idx)
            except Exception:
                continue
            if f.getmask('房间').getbbox():
                return f
    raise RuntimeError('找不到能渲染中文的字体')


def main():
    page = sys.argv[1] if len(sys.argv) > 1 else 'room'
    cols = 6
    if '--cols' in sys.argv:
        cols = int(sys.argv[sys.argv.index('--cols') + 1])

    files = sorted(glob.glob(os.path.join(UI, f'{page}-*.png')))
    plain = os.path.join(UI, f'{page}.png')
    if os.path.exists(plain):
        files.append(plain)
    if not files:
        print(f'outputs/ui/ 里没有 {page} 的截图，先跑 render-ui.js')
        return 1

    TW = 190
    PAD, LBL = 8, 18
    thumbs = []
    for f in files:
        im = Image.open(f).convert('RGB')
        # 只取顶部一段：页面通常很长，缩略图不需要全部
        im = im.crop((0, 0, im.width, min(im.height, int(im.width * 1.9))))
        k = TW / im.width
        im = im.resize((TW, max(1, int(im.height * k))), Image.LANCZOS)
        name = os.path.basename(f).replace(f'{page}-', '').replace('.png', '') or 'default'
        # ⚠️ 这个目录里可能躺着**历史遗留的旧截图**（比如某次改版前的状态），
        # glob 会把它们一起拼进来 —— 2026-10-28 我差点把一张过期的空白图
        # 当成"大厅 dice 状态的 bug"。
        # 超过 1 小时的文件在标签上标记出来，避免看过期图下结论。
        age_h = (time.time() - os.path.getmtime(f)) / 3600
        if age_h > 1:
            name = '⏰' + name
        thumbs.append((name, im))

    rows = (len(thumbs) + cols - 1) // cols
    th = max(t[1].height for t in thumbs)
    W = cols * (TW + PAD) + PAD
    H = rows * (th + LBL + PAD) + PAD
    sheet = Image.new('RGB', (W, H), (18, 14, 12))
    d = ImageDraw.Draw(sheet)
    font = pick_font(13)

    for i, (name, im) in enumerate(thumbs):
        c, r = i % cols, i // cols
        x = PAD + c * (TW + PAD)
        y = PAD + r * (th + LBL + PAD)
        d.text((x, y), name[:16], font=font, fill=(230, 200, 150))
        sheet.paste(im, (x, y + LBL))

    out = os.path.join(UI, f'sheet-{page}.png')
    sheet.save(out, 'PNG', optimize=True)
    print(f'✓ {out}  {W}x{H}  {len(thumbs)} 个状态')
    return 0


if __name__ == '__main__':
    sys.exit(main())
