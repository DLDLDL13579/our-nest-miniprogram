#!/usr/bin/env python3
"""
check-wheel-pixel.py —— 从**真机截图**验证转盘指针指对了

================ 为什么需要 ================

"转盘指的和结果不符"是用户报过的 bug，修过一次（偏 90°）。
而我后来看图时又误判了一次 —— **差点去改一个完全正确的功能**。

图是骗人的：
  · 扇区会旋转，文字也跟着转，"看起来指着"和"实际指着"不一样
  · 我盯着 12 点位置看，把「真心话」当成指针位置，而它其实在 163°

所以做成脚本：**用颜色质心算各扇区的实际方位角**，指针在 0°，最近的应该是抽中的那个。

================ 用法 ================

    # 先用 probe 截一张转完的图
    node .tooling/probe.js --file /tmp/v-wheeloff.js
    python3 scripts/check-wheel-pixel.py /tmp/real-shots/wheel-off.png 你喝

第二个参数是**期望的扇区名**（和图上文字一致）。
"""
import sys
import numpy as np
from PIL import Image

# 七个扇区的颜色（必须和 room.js 的 SECTORS 一致）
SECTORS = {
    '真心话': (0x9E, 0x40, 0x29),
    '大冒险': (0x3F, 0x5A, 0x7A),
    '喝一杯': (0x57, 0x3E, 0x7A),
    '你喝': (0x36, 0x65, 0x4C),
    '我喝': (0x8C, 0x62, 0x26),
    '一起喝': (0x7D, 0x35, 0x49),
    '免罚一次': (0x3F, 0x65, 0x79),
}


def analyze(path):
    im = np.asarray(Image.open(path).convert('RGB'), dtype=float)
    cent = {}
    for name, c in SECTORS.items():
        mask = (np.abs(im - np.array(c)).sum(axis=2) < 25)
        ys, xs = np.where(mask)
        if len(xs) < 100:
            continue
        cent[name] = (xs.mean(), ys.mean(), len(xs))
    if len(cent) < 5:
        return None, '只认出 %d 个扇区，图可能不是转完的状态' % len(cent)
    cx = np.mean([v[0] for v in cent.values()])
    cy = np.mean([v[1] for v in cent.values()])
    res = []
    for name, (x, y, _n) in cent.items():
        # 0° = 正上方，顺时针
        ang = (np.degrees(np.arctan2(x - cx, -(y - cy))) + 360) % 360
        # 与指针(0°)的角距
        d = min(ang, 360 - ang)
        res.append((d, ang, name))
    res.sort()
    return res, None


def main():
    if len(sys.argv) < 3:
        print(__doc__)
        return 2
    path, expect = sys.argv[1], sys.argv[2]
    res, err = analyze(path)
    if err:
        print('✗ ' + err)
        return 1
    print('从截图反推的各扇区方位角（指针在 0°）:\n')
    for d, ang, name in res:
        mark = '  ★' if name == expect else ''
        print('  %-6s %6.1f°  距指针 %5.1f°%s' % (name, ang, d, mark))
    top_d, top_ang, top_name = res[0]
    print()
    if top_name == expect:
        print('✓ 指针指的就是「%s」（距指针 %.1f°）—— 判定与画面一致' % (expect, top_d))
        return 0
    print('✗ 指针最接近的是「%s」，而结果写的是「%s」' % (top_name, expect))
    return 1


if __name__ == '__main__':
    sys.exit(main())
