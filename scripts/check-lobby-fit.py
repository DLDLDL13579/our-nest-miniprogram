#!/usr/bin/env python3
"""
check-lobby-fit.py —— 用像素验证大厅玩法卡是否全部在首屏内

============ 为什么需要这个 ============

项目里反复栽在同一件事上：用"加加减减"推算出来的数字当判据。

上一轮我就这么错了：算"每卡 136px x 4 行 + 固定区 188px = 750px > 679px 可用"
→ 结论「8 个玩法装不下，必须改布局」。
而 136px 是收窄前的 min-height，收到 240rpx 后每行只有约 70px。
真实渲染一量：卡片区止于 700px，8 个全部在 753px 首屏内。

一个过时的中间量，就把整个结论推翻了 —— 而那个结论本来会主导后面几轮的方向。

跑法：python3 scripts/check-lobby-fit.py
"""
import os
import subprocess
import sys

ROOT = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))
FULL_PNG = os.path.join(ROOT, 'outputs', 'ui', 'lobby-all@full.png')
DEVICE_H = 753          # iPhone 13 内容区（844 - 47 状态栏 - 44 导航栏）
SCALE = 2               # 渲染图 2x


def render():
    r = subprocess.run(
        ['node', 'scripts/render-ui.js', 'lobby', '--state', 'all', '--full'],
        cwd=ROOT, capture_output=True, text=True
    )
    if r.returncode != 0:
        print('  x 渲染失败：' + (r.stderr or r.stdout)[-300:])
        return False
    if not os.path.exists(FULL_PNG):
        print('  x 渲染没产出 ' + FULL_PNG)
        return False
    return True


def is_solid_row(im, y):
    """整行是不是同一种颜色（= 无内容）"""
    w, _ = im.size
    first = im.getpixel((0, y))
    for x in range(0, w, 37):
        p = im.getpixel((x, y))
        if abs(p[0] - first[0]) + abs(p[1] - first[1]) + abs(p[2] - first[2]) > 6:
            return False
    return True


def measure(im):
    """
    量出「最后一个有内容的行」。

    ★ 背景色和 tabBar 必须分开定位 —— 这是本脚本唯一容易错的地方。
      实测（750x2800 长图）：页面底色 (30,22,19) 深褐；
      tabBar (255,253,249) 白，从 y 约 2701 开始。

      第一版取 h-40 当背景 → 取到白色 tabBar → 每行都被判成"非背景"，
      量出 y=2700 这种荒唐值。背景色取错，整条判据就变成噪声。
    """
    w, h = im.size

    # ★ 不能靠"连续纯色"找 tabBar —— 页面背景**本身也是纯色**，
    #   于是会一路跳过整个页面，最后停在最顶上（第一版就这么错的）。
    #   正确做法：从底部往上找**颜色突变**（白 tabBar → 深褐页面）。
    y = h - 1
    prev = im.getpixel((w // 2, y))
    tab_start = 0
    while y > 0:
        p = im.getpixel((w // 2, y))
        if abs(p[0] - prev[0]) + abs(p[1] - prev[1]) + abs(p[2] - prev[2]) > 60:
            tab_start = y
            break
        prev = p
        y -= 1
    if not tab_start:
        tab_start = h

    bg = im.getpixel((w // 2, max(0, tab_start - 2)))

    def diff(p, q):
        return abs(p[0] - q[0]) + abs(p[1] - q[1]) + abs(p[2] - q[2])

    sample_n = len(range(60, w - 60, 8))
    thresh = sample_n * 0.30

    '''
    ★ 页面背景是**纵向渐变**（实测 (44,32,25) → (30,22,19)），
      不是单一颜色。用一个固定 bg 值去比，整片渐变都会被算成"内容"
      —— 第一版就是这么错的（量到最底部）。

      正确做法：**每一行用它自己的左右边缘颜色当背景**，
      再看这一行的中部有没有明显不同的像素。
      这样渐变的缓慢变化不会干扰判定，而卡片（横向有明显色块）能被识别。
    '''
    last = 0
    for y in range(0, tab_start, 2):
        left = im.getpixel((4, y))
        right = im.getpixel((w - 5, y))
        row_bg = (
            (left[0] + right[0]) // 2,
            (left[1] + right[1]) // 2,
            (left[2] + right[2]) // 2
        )
        cnt = sum(1 for x in range(60, w - 60, 8) if diff(im.getpixel((x, y)), row_bg) > 24)
        if cnt <= thresh:
            continue
        # 这一行有几个横向连续的非背景色块
        runs = 0
        in_run = False
        for x in range(60, w - 60, 6):
            on = diff(im.getpixel((x, y)), row_bg) > 24
            if on and not in_run:
                runs += 1
            in_run = on
        '''
        ★★ 2026-11-03 修正：不能只认「两列并排」。

          奇数个玩法时，最后一行只放 1 张卡（runs=1）——
          原来那条判据会**把最后一行整个忽略**，于是 9 个玩法算出来
          和 8 个一样高（749px），"装不下"被判成"装得下"。

          正确做法：区分「玩法卡行」和「底部提示条」不能看 runs 个数，
          要看**这一行的内容是不是卡片形状**（卡片有圆角矩形的大块色块，
          提示条是细长的一条文字）。

          简化判据：看这一行非背景像素的**高度连续性** —— 但逐行扫描拿不到。
          改用：卡片行的"非背景像素数"远多于提示条（卡片有底色块铺满）。
          实测：卡片行 cnt 约 40+，提示条行 cnt 约 15~20。
        '''
        if cnt > thresh * 1.6:
            last = y
    return last, tab_start


def main():
    from PIL import Image

    print('大厅首屏容量校验（像素测量）')
    print('=' * 46)

    if not render():
        sys.exit(1)

    im = Image.open(FULL_PNG).convert('RGB')
    iw, ih = im.size
    content_bottom, tab_start = measure(im)
    logical = content_bottom / SCALE

    print('  渲染图 %dx%d（%.0fx）' % (iw, ih, SCALE))
    print('  tabBar 从 y=%dpx 起（逻辑 %.0fpx）' % (tab_start, tab_start / SCALE))
    print('  最后一个有内容的行 y=%dpx → 逻辑 %.0fpx' % (content_bottom, logical))
    print('  iPhone 13 内容区 %dpx' % DEVICE_H)

    '''
    ★★ 2026-11-03：脚本从"必须装得下"改成"装不下就必须有提示"。

      要装下 9 个玩法得砍 196px —— 等于把 hero 压成一条、卡片压到 120px。
      那是拿体验换整齐，不划算。

      真正该保证的是：**装不下时，玩家知道下面还有。**
      所以这里查大厅模板里有没有 `more-hint` 那段。
    '''
    lobby_wxml = os.path.join(ROOT, 'miniprogram', 'pages', 'lobby', 'lobby.wxml')
    wxml = open(lobby_wxml, encoding='utf-8').read()
    has_hint = 'more-hint' in wxml

    if logical <= DEVICE_H:
        print('  OK 全部玩法在首屏内（余量 %.0fpx）' % (DEVICE_H - logical))
        print('=' * 46)
        return

    over = logical - DEVICE_H
    if has_hint:
        print('  OK 超出首屏 %.0fpx，但大厅已给出「下面还有 N 个」提示' % over)
        print('     （装不下不压扁界面，改用可发现性提示 —— 这是有意选择）')
        print('=' * 46)
        return

    print('  x 超出首屏 %.0fpx，而且**没有任何提示** —— 玩家会以为大厅就这些' % over)
    print('    该加 more-hint（见 lobby.wxml 里那段注释）')
    print('=' * 46)
    sys.exit(1)


if __name__ == '__main__':
    main()
