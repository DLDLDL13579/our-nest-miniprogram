#!/usr/bin/env python3
"""
render-cardback.py —— 生成暗金主题的扑克牌背

============ 为什么要自己画 ============
原牌背是 Kenney Board Game Pack（CC0）里的粉红菱形格。单看没问题，
但放进这个 App 的暗金酒桌主题里它**是唯一一块冷粉色**：
大厅、房间、结算全是 #2E1C17 的暗棕 + #E8B33C 的金，
中间突然一张粉红牌背，整体调性立刻掉一档。

而且它出现在两个最重要的位置：
  · 梦幻金花的「暗牌」（连自己都看不到的那张，全玩法核心）
  · 额头牌的「我的牌」（整个玩法就靠"这是牌背"来表达）
两处都是视觉焦点，配色不对就是"这 App 没做完"。

============ 为什么不用滤镜将就 ============
`filter: hue-rotate()` 之类在小程序各基础库上表现不一致，
一旦不支持就是**原色牌背**（静默降级，看不出是错）。
牌背是静态资源，直接画一张正确的更稳，也不占运行时代价。

============ 设计口径 ============
  · 底：深酒红 #341A16（比房间背景 #2E1C17 略暖，才不像"没加载出来"）
  · 纹：45° 菱形网格，金色 18%（近看是织纹，远看是暗底）
  · 中心：八瓣花饰 + 金色细环（赌场牌的"徽记"位置）
  · 边框：双线，外粗内细，内线更亮 —— 这是真实牌背面印花的样子

产物：miniprogram/game/images/card/back.png（160×214，8 色调色板 PNG）
"""
import os
import math
from PIL import Image, ImageDraw, ImageFilter

W, H = 160, 214          # 与牌面 160×214 完全一致（同尺寸才不会在列表里一大一小）
OUT = os.path.join(os.path.dirname(os.path.dirname(os.path.abspath(__file__))),
                   'miniprogram', 'game', 'images', 'card', 'back.png')

# 调色（全部取自 app.wxss 的主题色系）
BASE      = (52, 26, 22)
BASE_HI   = (74, 38, 31)
GOLD      = (232, 179, 60)
GOLD_DIM  = (150, 112, 40)
GOLD_SOFT = (196, 150, 62)


def lerp(a, b, t):
    return tuple(int(a[i] + (b[i] - a[i]) * t) for i in range(3))


def main():
    # ---------- 底：径向渐变（中心亮一点，像被灯照着）----------
    img = Image.new('RGB', (W, H), BASE)
    px = img.load()
    cx, cy = W / 2, H / 2
    maxd = math.hypot(cx, cy)
    for y in range(H):
        for x in range(W):
            d = math.hypot(x - cx, y - cy) / maxd
            # 中心 55% 亮的暖色 → 边缘回到基底
            t = max(0.0, 1.0 - d / 0.85)
            px[x, y] = lerp(BASE, BASE_HI, t * 0.9)

    d = ImageDraw.Draw(img, 'RGBA')

    # ---------- 网纹：45° 菱形（等价于两组垂直斜线）----------
    step = 11
    for k in range(-H, W + H, step):
        d.line([(k, 0), (k + H, H)], fill=GOLD + (30,), width=1)
        d.line([(k, 0), (k - H, H)], fill=GOLD + (30,), width=1)

    # 网格交点的小亮点 —— 让"织纹"有颗粒，而不是一片平纹
    for gy in range(0, H + step, step):
        for gx in range(0, W + step, step):
            d.ellipse([gx - 1, gy - 1, gx + 1, gy + 1], fill=GOLD + (34,))

    # ---------- 中心徽记 ----------
    R = 30
    d.ellipse([cx - R - 3, cy - R - 3, cx + R + 3, cy + R + 3],
              outline=GOLD_DIM + (150,), width=1)
    d.ellipse([cx - R, cy - R, cx + R, cy + R],
              outline=GOLD + (170,), width=2)

    # 八瓣花饰：每瓣是两条弧，比纯放射线更像印花
    for i in range(8):
        a = i * math.pi / 4
        for s in (-0.22, 0.22):
            aa = a + s
            x0 = cx + math.cos(aa) * 9
            y0 = cy + math.sin(aa) * 9
            x1 = cx + math.cos(aa) * (R - 4)
            y1 = cy + math.sin(aa) * (R - 4)
            d.line([(x0, y0), (x1, y1)], fill=GOLD_SOFT + (120,), width=1)
    # 花心
    d.ellipse([cx - 5, cy - 5, cx + 5, cy + 5], outline=GOLD + (200,), width=1)
    d.ellipse([cx - 2, cy - 2, cx + 2, cy + 2], fill=GOLD + (210,))

    # ---------- 四角小花 ----------
    for gx, gy in ((12, 12), (W - 12, 12), (12, H - 12), (W - 12, H - 12)):
        d.ellipse([gx - 4, gy - 4, gx + 4, gy + 4], outline=GOLD_DIM + (130,), width=1)
        d.point((gx, gy), fill=GOLD + (190,))

    # ---------- 边框：外粗内细 ----------
    d.rectangle([0, 0, W - 1, H - 1], outline=(26, 12, 10), width=1)
    d.rectangle([3, 3, W - 4, H - 4], outline=GOLD + (185,), width=2)
    d.rectangle([7, 7, W - 8, H - 8], outline=GOLD_DIM + (140,), width=1)

    # ---------- 极轻的内发光，让金色线条"陷进"布里 ----------
    glow = img.filter(ImageFilter.GaussianBlur(0.6))
    img = Image.blend(img, glow, 0.18)

    # ---------- 量化到 8 色调色板：体积从 ~30KB 降到 ~6KB ----------
    img = img.convert('P', palette=Image.ADAPTIVE, colors=8)
    img.save(OUT, optimize=True)

    size = os.path.getsize(OUT)
    print('  ✓ %s  %dx%d  %.1f KB' % (OUT, W, H, size / 1024))
    return OUT


if __name__ == '__main__':
    main()
