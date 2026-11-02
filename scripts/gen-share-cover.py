#!/usr/bin/env python3
"""
生成转发封面图（微信小程序分享卡片 5:4，500x400）。

为什么需要：`onShareAppMessage` 不带 imageUrl 时，微信会截取页面首屏当封面 ——
在群聊里那通常是一堆文字，辨识度极低。
一张专门做的封面能让"这是个什么小程序"在一眼内说清。

素材全部来自仓库里已有的骰子渲染图（scripts/render-dice.py 的产物），
不引外部图片 —— 保证风格一致、离线可重建。
"""
import os
from PIL import Image, ImageDraw, ImageFont, ImageFilter

ROOT = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))
IMG = os.path.join(ROOT, 'miniprogram', 'images')
# ★ 2026-10-30：骰子和牌面在**分包**里（2026-10-28 拆包时移过去的），
#   而这个脚本还按主包的 images/ 找 —— 跑起来直接 FileNotFoundError。
GAME_IMG = os.path.join(ROOT, 'miniprogram', 'game', 'images')
OUT = os.path.join(IMG, 'share-cover.png')

W, H = 500, 400

# ---- 颜色（与小程序主题一致：深褐夜色 + 麦金）----
BG_TOP = (62, 46, 40)
BG_BOT = (28, 21, 18)
GOLD = (232, 179, 60)
CREAM = (246, 231, 195)


def gradient(w, h, c1, c2):
    img = Image.new('RGB', (w, h), c1)
    d = ImageDraw.Draw(img)
    for y in range(h):
        t = y / max(1, h - 1)
        # 轻微 gamma：中间偏亮，避免上下过渡太"线性"
        t = t ** 0.92
        c = tuple(int(c1[i] + (c2[i] - c1[i]) * t) for i in range(3))
        d.line([(0, y), (w, y)], fill=c)
    return img


def radial_glow(w, h, color, cx, cy, radius, alpha=110):
    """径向光晕 —— 让深色背景不死板。"""
    layer = Image.new('L', (w, h), 0)
    d = ImageDraw.Draw(layer)
    steps = 42
    for i in range(steps, 0, -1):
        r = radius * i / steps
        a = int(alpha * (1 - i / steps) ** 1.6)
        d.ellipse([cx - r, cy - r, cx + r, cy + r], fill=a)
    layer = layer.filter(ImageFilter.GaussianBlur(18))
    tint = Image.new('RGB', (w, h), color)
    return tint, layer


def load_die(n, size):
    p = os.path.join(GAME_IMG, 'dice', f'dice-{n}.png')
    im = Image.open(p).convert('RGBA')
    w, h = im.size
    k = size / max(w, h)
    return im.resize((max(1, int(w * k)), max(1, int(h * k))), Image.LANCZOS)


# ---- 中文字体：必须**探测**，不能假设路径 ----
#
# ★ 踩过的坑：第一版硬编码 `/System/Library/Fonts/PingFang.ttc` ——
#   这台机器上**根本没有这个文件**（PingFang 在别的位置/别的形态），
#   `ImageFont.truetype` 抛异常后被 try/except 吞掉、退化成 load_default()，
#   而默认字体不含中文字形 → 整张封面的中文全是方块。
#   **异常被吞 + 有 fallback = 静默失败**，而它的产物看上去"有图有字"。
#
# 所以：按候选列表探测，并用 getmask 验证**真的能画出中文**；
# 全都不行就抛错，绝不用默认字体凑合。
FONT_CANDIDATES = [
    ('/System/Library/Fonts/Hiragino Sans GB.ttc', [0, 1]),
    ('/System/Library/Fonts/STHeiti Medium.ttc', [0]),
    ('/System/Library/Fonts/Supplemental/Songti.ttc', [0, 1]),
    ('/Library/Fonts/Arial Unicode.ttf', [0]),
    ('/System/Library/Fonts/PingFang.ttc', [0, 1]),
]


def pick_font(size):
    """返回一个**确实能渲染中文**的字体；找不到就抛错。"""
    for path, idxs in FONT_CANDIDATES:
        if not os.path.exists(path):
            continue
        for idx in idxs:
            try:
                f = ImageFont.truetype(path, size, index=idx)
            except Exception:
                continue
            # 关键验证：能不能真的画出"酒"字（有非零 bbox）
            box = f.getmask('酒桌').getbbox()
            if box and box[2] > 0:
                return f
    raise RuntimeError(
        '找不到能渲染中文的字体（试过：%s）—— 不允许退化成默认字体，'
        '那会渲染成一堆方块而不报错' % ', '.join(p for p, _ in FONT_CANDIDATES))


def main():
    base = gradient(W, H, BG_TOP, BG_BOT)

    # 金色光晕（右上角，和房间页的 hero 同一套语言）
    tint, mask = radial_glow(W, H, GOLD, int(W * 0.82), int(H * 0.12), 240, 120)
    base = Image.composite(tint, base, mask.point(lambda v: int(v * 0.55)))

    # 三颗骰子：错落摆放 + 轻微旋转，像随手扔在桌上
    # （size / angle / x,y 都按 500x400 的画布调到视觉重心偏左）
    # 骰子集中在下方 —— 上方留给文字。
    # （第一版骰子压在副标题上，字被挡得看不清；这是渲染出来才发现的）
    dice_spec = [(6, 138, -13, 96, 214), (5, 152, 7, 214, 196), (3, 122, 20, 330, 236)]
    for n, size, angle, x, y in dice_spec:
        die = load_die(n, size).rotate(angle, resample=Image.BICUBIC, expand=True)
        # 投影：先画一层模糊的黑色轮廓，再贴骰子
        shadow = Image.new('RGBA', die.size, (0, 0, 0, 0))
        shadow.paste((0, 0, 0, 90), (0, 0), die.split()[3])
        shadow = shadow.filter(ImageFilter.GaussianBlur(9))
        base.paste(Image.new('RGB', shadow.size, (0, 0, 0)), (x + 8, y + 14), shadow)
        base.paste(die, (x, y), die.split()[3])

    # ★ 2026-10-30：加两张扑克牌，让封面能代表"5 个玩法"而不只是骰子。
    #   用新换的 CC0 蚀刻风牌面（c{s}-{r}.png），斜放在骰子右侧，
    #   和骰子形成"牌 + 骰"的组合 —— 这正是酒桌的两种核心道具。
    card_spec = [('c0-14', 108, -14, 336, 118), ('c1-12', 96, 12, 386, 178)]
    for name, w, angle, x, y in card_spec:
        cp = os.path.join(GAME_IMG, 'card', name + '.png')
        if not os.path.exists(cp):
            continue                      # 素材不在就跳过，不崩
        card = Image.open(cp).convert('RGBA')
        k = w / card.size[0]
        card = card.resize((w, int(card.size[1] * k)), Image.LANCZOS)
        card = card.rotate(angle, resample=Image.BICUBIC, expand=True)
        sh = Image.new('RGBA', card.size, (0, 0, 0, 0))
        sh.paste((0, 0, 0, 110), (0, 0), card.split()[3])
        sh = sh.filter(ImageFilter.GaussianBlur(8))
        base.paste(Image.new('RGB', sh.size, (0, 0, 0)), (x + 6, y + 12), sh)
        base.paste(card, (x, y), card.split()[3])

    d = ImageDraw.Draw(base)

    # ---- 文字 ----
    f_big = pick_font(62)
    f_sm = pick_font(23)
    f_xs = pick_font(17)

    d.text((44, 74), '酒桌', font=f_big, fill=CREAM)
    d.text((46, 152), '手机一起玩', font=f_sm, fill=(226, 202, 168))
    d.text((46, 186), '一个人开桌，其他人输号进来', font=f_xs, fill=(176, 158, 136))

    # 左上角一道金色细线（装饰，给画面一个"起笔"）
    d.line([(46, 52), (46, 106)], fill=GOLD, width=4)

    # 调色板量化（和骰子图同一套做法）：深色渐变要有足够色阶，否则出现色带。
    # 实测 96 色：体积 71.8 → 约 30 KB，色差肉眼不可辨。
    # 先存一份真彩做基准，量化后比一下峰值误差，超阈值就退回真彩（宁可大也不能出色带）。
    import io
    raw = io.BytesIO()
    base.save(raw, 'PNG')
    raw_size = len(raw.getvalue())
    q = base.convert('RGB').quantize(colors=96, method=Image.MEDIANCUT, dither=Image.FLOYDSTEINBERG)
    q.save(OUT, 'PNG', optimize=True)
    q_size = os.path.getsize(OUT)
    if q_size > raw_size:
        base.save(OUT, 'PNG', optimize=True)
        print('  （量化反而更大，已退回真彩）')
    print(f'✓ {OUT}  {os.path.getsize(OUT)/1024:.1f} KB  {W}x{H}  '
          f'（真彩 {raw_size/1024:.1f} KB → 量化 {q_size/1024:.1f} KB）')


if __name__ == '__main__':
    main()
