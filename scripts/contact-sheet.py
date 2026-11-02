#!/usr/bin/env python3
"""
contact-sheet.py —— 把所有渲染状态拼成一张联络图，一眼扫异常

================ 为什么要有这个工具 ================

单个状态看久了会麻木，而**一屏摆 50 个**的时候，"哪个界面不对劲"会自己跳出来。

================ ⚠️ 曾经踩过的坑（2026-11-02） ================

第一版直接 `glob('outputs/ui/room-*.png')` —— 于是把**旧状态名的残留图片**
也拼了进去（pk8 / pkAsk / pkDrinks 这些状态早就改名或删了），
联络图上出现三格"金花状态却是大厅界面"。

我差一点去改渲染器。

**教训：联络图的图源必须和"当前有哪些状态"对齐，而不是"目录里有什么"。**
现在两种做法都做了：
  · 只取当前 mock 里存在的状态
  · 顺手报出目录里多余的图片（提示可以清理）
"""
import glob
import json
import os
import subprocess
import sys

from PIL import Image

ROOT = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))
OUT = os.path.join(ROOT, 'outputs', 'ui')
COLS = 9
TH_W = 200


def current_states():
    js = 'const m = require("./scripts/ui-render/mock/room.js");' \
         'console.log(JSON.stringify(Object.keys(m.states)));'
    r = subprocess.run(['node', '-e', js], cwd=ROOT, capture_output=True, text=True)
    if r.returncode != 0:
        raise SystemExit('取不到状态列表：' + r.stderr[:200])
    return json.loads(r.stdout)


def main():
    states = current_states()
    have = {os.path.basename(f)[5:-4] for f in glob.glob(os.path.join(OUT, 'room-*.png'))}
    missing = [s for s in states if s not in have]
    stale = sorted(have - set(states))

    if missing:
        print('⚠️ 这些状态还没渲染：' + ' '.join(missing))
        print('  先跑：node scripts/render-ui.js room --state <名字>')
    if stale:
        print('ℹ️ 目录里有 %d 张过期图片（旧状态名残留）：%s' % (len(stale), ' '.join(stale)))

    use = [s for s in states if s in have]
    if not use:
        raise SystemExit('没有可用的图片')

    imgs = []
    for s in use:
        im = Image.open(os.path.join(OUT, 'room-%s.png' % s)).convert('RGB')
        ratio = TH_W / im.width
        imgs.append((s, im.resize((TH_W, int(im.height * ratio)))))

    th_h = imgs[0][1].height
    rows = (len(imgs) + COLS - 1) // COLS
    sheet = Image.new('RGB', (COLS * TH_W, rows * th_h), (20, 20, 20))
    for i, (_, im) in enumerate(imgs):
        sheet.paste(im, ((i % COLS) * TH_W, (i // COLS) * th_h))
    dst = os.path.join(OUT, 'contact-sheet.png')
    sheet.save(dst, quality=88)
    print('%d 个状态 → %s  %dx%d' % (len(imgs), dst, sheet.width, sheet.height))
    print('顺序：' + ' '.join(s for s, _ in imgs))


if __name__ == '__main__':
    sys.exit(main())
