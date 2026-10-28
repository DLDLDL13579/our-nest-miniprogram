#!/usr/bin/env python3
"""
render-cup.py —— 渲染骰盅（摇骰子用的盅）

============ 为什么要做骰盅 ============

用户反馈：「摇骰子的动画效果不行，和真实的现实场景还是差很多」。
对着真实场景逐条比对，发现缺的正是**盅**：

    现实                          改造前
    ────────────────────────────  ────────────────────────────
    ① 骰子落进盅里，几声脆响        无
    ② 握住盅上下摇，骰子在盅内乱撞   骰子在"空中"翻（现实里看不见骰子！）
    ③ "咚"一声扣在桌上 ← 最有仪式感  完全没有这一下
    ④ 提起盅，骰子露出来            直接显示点数

**关键认识**：现实里摇盅时**根本看不见骰子**（盅不透明）。
改造前让骰子在空中翻滚，看着就"假" —— 因为真实的悬念恰恰来自"看不见"。

所以盅不是装饰，它是这个游戏的**核心道具**：
  · 挡住骰子 → 制造悬念
  · 扣盅那一声 → 仪式感的顶点
  · 揭盅 → 悬念释放

============ 复用骰子的渲染器 ============

几何、光线步进、光照、边缘外扩全部复用 render-dice.py 里的实现
（march_ortho / bleed_edges / save_png）。这不是偷懒：

  · 两个物体**必须同一套光照**，否则叠在一起时明暗对不上，一眼假
  · 光线步进那段有两次踩坑修出来的东西（活跃像素集合、命中容差），
    复制一份必然分叉

============ 盅的形状 ============

真实骰盅是**倒扣的圆台**（上小下大），带一点点弧度，顶部收口。
用 SDF 描述：圆台 = 两个不同半径的球体做锥形插值（经典的 round cone SDF），
再和圆角顶盖做并集。这样得到的轮廓有真实的收腰和圆润的顶。

用法：
    python3 scripts/render-cup.py             # 渲染盅（扣着）+ 盅（提起）
    python3 scripts/render-cup.py --size 600
"""
import os
import math
import argparse
import importlib.util

import numpy as np
from PIL import Image

# ---- 复用骰子渲染器的公共部件 ----
_HERE = os.path.dirname(os.path.abspath(__file__))
_spec = importlib.util.spec_from_file_location('rd', os.path.join(_HERE, 'render-dice.py'))
rd = importlib.util.module_from_spec(_spec)
_spec.loader.exec_module(rd)

march_ortho = rd.march_ortho
bleed_edges = rd.bleed_edges
save_png = rd.save_png


# ============================================================
# 盅的几何
# ============================================================
# ★ 比例是按真实骰盅量的：高 ≈ 底径的 1.3 倍。
#   第一版做成"高 0.84 / 底径 1.2"（高只有底径的 0.7 倍），
#   渲染出来是个矮胖的墩子，像茶杯盖 —— 一眼就不像骰盅。
CUP_BOTTOM_R = 0.52      # 底部半径（开口一侧，扣着时朝下）
CUP_TOP_R = 0.36         # 顶部半径（收口）
CUP_HEIGHT = 1.32        # 总高（≈ 底径 1.04 的 1.27 倍）
CUP_EDGE_R = 0.05        # 上下两端的切口圆润半径


def smax(a, b, k):
    """
    平滑取大（smooth max）。

    用途：用平面去切圆锥时，硬切会留下**数学上锐利的圆盘边缘**，
    渲染出来是刀切感。smax 会在切口处自动做出一圈半径约 k 的圆角 ——
    真实盅的口沿正是圆的。
    """
    h = np.clip(0.5 + 0.5 * (a - b) / k, 0.0, 1.0)
    return a * h + b * (1.0 - h) + k * h * (1.0 - h)


def sdf_round_cone_y(p, r1, r2, h):
    """
    轴对齐圆台 SDF（IQ 的 sdRoundCone）—— 底在 y=0（半径 r1），顶在 y=h（半径 r2）。

    ⚠️ 这里踩过一次坑：第一版用的是「两点之间任意朝向圆台」的通用公式，
    我把它翻译错了，返回的值**不再是真实距离**（违反了 SDF 的 Lipschitz 条件）。
    后果是光线步进的步长会 overshoot —— 画面出现**放射状尖刺**，
    形状也塌成一个圆顶。SDF 写错时的典型症状就是"尖刺 + 形状不对"，
    看到这个组合要先怀疑距离函数本身，而不是光照或步进参数。

    这个轴对齐版本只有三行、易验证：
      · 侧面：a*qx + b*qy - r1（到锥面的距离）
      · 两端：退化成球冠，天然是圆的
    """
    b = (r1 - r2) / h
    a = math.sqrt(max(0.0, 1.0 - b * b))
    qx = np.sqrt(p[..., 0] ** 2 + p[..., 2] ** 2)
    qy = p[..., 1]
    k = -b * qx + a * qy
    d_bottom = np.sqrt(qx * qx + qy * qy) - r1
    d_top = np.sqrt(qx * qx + (qy - h) ** 2) - r2
    d_side = a * qx + b * qy - r1
    return np.where(k < 0.0, d_bottom, np.where(k > a * h, d_top, d_side))


def sdf_cup(p):
    """
    整只盅（扣着）：圆台 + 上下切平。

    为什么要切平：圆台 SDF 的两端是**球冠**。顶部半径 0.40 的球冠
    会在盅顶鼓出一个大圆顶（渲染出来像半个球，不像盅）；
    底部半径 0.60 的球冠更糟，会在盅底垂下一个巨大的半球。
    所以两端都要用平面切掉，再用 smax 把切口边缘做圆。
    """
    h = CUP_HEIGHT
    # 把 y 从 [0,h] 平移到 [-h/2, +h/2]，让盅的中心在原点
    q = p.copy()
    q[..., 1] = p[..., 1] + h / 2.0
    d = sdf_round_cone_y(q, CUP_BOTTOM_R, CUP_TOP_R, h)

    # 底面（开口端）：y >= -h/2
    d = smax(d, -h / 2.0 - p[..., 1], CUP_EDGE_R)
    # 顶面：y <= +h/2
    d = smax(d, p[..., 1] - h / 2.0, CUP_EDGE_R)
    return d


def normal_at(p, sdf, eps=1e-3):
    """中心差分求法线"""
    n = np.zeros_like(p)
    for i in range(3):
        off = np.zeros(3)
        off[i] = eps
        n[..., i] = sdf(p + off) - sdf(p - off)
    ln = np.linalg.norm(n, axis=-1, keepdims=True)
    return n / np.maximum(ln, 1e-9)


def ao_at(p, n, sdf, samples=6):
    """环境遮蔽：沿法线探测被自身遮挡的程度"""
    occ = np.zeros(p.shape[:-1])
    for i in range(1, samples + 1):
        h = 0.008 * i * i
        d = sdf(p + n * h)
        occ += (h - d) / h
    occ = np.clip(1.0 - occ / samples * 0.85, 0.0, 1.0)
    return occ


# ============================================================
# 渲染
# ============================================================

# 盅是**深色木质**质感。不用金属：金属在暗色桌面上容易糊成一片，
# 而深木色和米白骰子形成"暗容器装亮内容"的对比，揭盅时骰子更跳。
CUP_BASE = np.array([0.335, 0.205, 0.145])     # 深红木
CUP_RIM = np.array([0.52, 0.35, 0.245])        # 口沿略亮（磨损处露出木纹）

# 木质纹理：沿盅身周向的细密竖纹（车床车出来的木纹就是竖的）
# 用本地坐标的方位角做正弦调制 —— 不需要贴图，且不会随分辨率糊掉。
WOOD_GRAIN_AMP = 0.055
WOOD_GRAIN_FREQ = 26.0


def render_cup(size=600, ss=2, tilt_deg=0.0, lift=0.0):
    """
    渲染骰盅。

    tilt_deg  整体倾斜角（摇动时用，让盅看起来是"歪着晃"）
    lift      向上平移（提起盅的动作）

    ★ 相机要把整只盅框进画面：盅高 1.32、底径 1.04，
      加上倾斜和提起的位移，纵向跨度会到约 1.8。
      第一版用默认 extent=0.95（纵向总跨度 1.9）时，
      盅顶刚好顶到画面边缘被裁掉 —— 表现为"盅没有顶"。
      这里显式放大到 1.15，并抬高相机中心，给足余量。
    """
    half_h = CUP_HEIGHT / 2.0

    def rot_z(a):
        c, s = math.cos(a), math.sin(a)
        return np.array([[c, -s, 0], [s, c, 0], [0, 0, 1]])

    # 视角：略微俯视，能同时看到盅身和顶盖
    def rot_y(a):
        c, s = math.cos(a), math.sin(a)
        return np.array([[c, 0, s], [0, 1, 0], [-s, 0, c]])
    def rot_x(a):
        c, s = math.cos(a), math.sin(a)
        return np.array([[1, 0, 0], [0, c, -s], [0, s, c]])

    VIEW_X = math.radians(16)      # 俯视一点点，露出顶盖
    VIEW_Y = math.radians(-14)     # 稍偏右，有立体感
    Rv = rot_x(VIEW_X) @ rot_y(VIEW_Y)
    Rtot = Rv @ rot_z(math.radians(tilt_deg))

    # 平移（提起）
    shift = np.array([0.0, lift, 0.0])

    def to_world(p):
        """本地 → 世界（先旋转，再平移）"""
        return p @ Rtot.T + shift

    def to_local(p):
        return (p - shift) @ Rtot

    def sdf_world(p_w):
        return sdf_cup(to_local(p_w))

    ox, oy, t, hit, W, H = march_ortho(
        sdf_world, size, ss,
        extent=1.12,          # 纵向要放下整只盅 + 倾斜 + 提起的位移
        cam_z=3.0, t_max=5.0  # 盅比骰子高，给足行进余量
    )

    # ---- 着色 ----
    out = np.zeros((H, W, 4))
    rgb = np.empty((H * W, 3))
    # 背景填盅的底色（同骰子：填底色而非黑，否则边缘抗锯齿会发黑边）
    rgb[:] = CUP_BASE

    hi = np.flatnonzero(hit)
    if hi.size:
        p_w = np.stack([ox[hi], oy[hi], 3.0 - t[hi]], axis=-1)
        pl = to_local(p_w)
        nl = normal_at(pl, sdf_cup)
        n = nl @ Rtot.T

        L1 = np.array([-0.45, 0.62, 0.65]); L1 /= np.linalg.norm(L1)   # 主光
        L2 = np.array([0.92, 0.00, 0.08]);  L2 /= np.linalg.norm(L2)   # 补光
        L3 = np.array([0.15, -0.85, 0.25]); L3 /= np.linalg.norm(L3)   # 底部反弹
        V = np.array([0.0, 0.0, 1.0])

        def lambert(L):
            return np.maximum(n @ L, 0.0)

        def blinn(L, shin):
            Hv = L + V
            Hv = Hv / np.linalg.norm(Hv)
            return np.maximum(n @ Hv, 0.0) ** shin

        ao = ao_at(pl, nl, sdf_cup)

        # 口沿提亮：本地坐标里越靠下（开口端）越亮 —— 模拟真实盅口沿的磨损
        # 这是让"盅"看起来有厚度的关键细节：口沿是圆的，受光最强。
        rim = np.clip((pl[:, 1] * -1.0 + half_h) / CUP_HEIGHT, 0.0, 1.0)
        rim = rim ** 2.2
        base = CUP_BASE[None, :] * (1.0 - rim[:, None]) + CUP_RIM[None, :] * rim[:, None]

        # ============ 木纹 ============
        #
        # ★★ 2026-10-28 重做。原来只有**一条**正弦：sin(ang*26) ——
        #   等间距、等深浅的竖条，渲染出来像"塑料上贴了一张条纹纸"。
        #   真实木纹有三个特征，缺一个就假：
        #     ① 不等距：纤维疏密不均（相邻条纹宽窄不同）
        #     ② 深浅不一：有的纹路几乎看不见，有的很深
        #     ③ 沿高度会歪：车床车出来的纹不是完美竖直，会微微扭曲
        #
        #   做法：三条不同频率的正弦叠加（26/61/137）各自扰动相位，
        #   再用一条低频包络调制深浅 —— 疏密和深浅就都有了。
        ang = np.arctan2(pl[:, 2], pl[:, 0])
        hgt = pl[:, 1] - half_h
        warp = np.sin(hgt * 3.1 + ang * 0.7) * 0.42
        g1 = np.sin((ang + warp) * WOOD_GRAIN_FREQ)
        g2 = np.sin((ang * 1.9 + warp * 1.7) * 61.0 + 1.3)
        g3 = np.sin((ang * 3.3 - warp * 0.9) * 137.0 + 2.7)
        env = 0.5 + 0.5 * np.sin(ang * 2.3 + hgt * 4.7 + 0.6)
        grain = 1.0 + WOOD_GRAIN_AMP * (0.62 * g1 + 0.26 * g2 + 0.12 * g3) * (0.45 + 0.85 * env)
        side = np.clip(1.0 - np.abs(nl[:, 1]) * 2.4, 0.0, 1.0)
        grain = 1.0 + (grain - 1.0) * side
        base = base * grain[:, None]

        # ============ 接触阴影 ============
        # 盅底和桌面接触的那一圈必须暗下去 —— 少这一圈，物体就"浮"在桌上，
        # 像一张贴图。这是三维渲染里最便宜、也最能立刻看出真假的一笔。
        contact = np.clip((pl[:, 1] + half_h) / 0.22, 0.0, 1.0)
        base = base * (0.55 + 0.45 * contact)[:, None]

        key    = lambert(L1) * 0.90
        fill   = lambert(L2) * 0.26
        bounce = lambert(L3) * 0.20
        # 木质/皮革：高光弱而宽（shininess 低），和骰子的塑料高光区分开
        spec   = blinn(L1, 14.0) * 0.16

        shade = (key + fill + bounce) * (0.62 + 0.38 * ao) + 0.34
        col = base * shade[:, None]
        col = col + spec[:, None] * np.array([1.0, 0.96, 0.90])[None, :]

        # 边缘光
        fres = (1.0 - np.maximum(n @ V, 0.0)) ** 3.0
        col = col + fres[:, None] * 0.13

        rgb[hi] = np.clip(col, 0.0, 1.0)

    out[..., :3] = rgb.reshape(H, W, 3)
    out[..., 3] = hit.reshape(H, W).astype(np.float64)

    if ss > 1:
        out = out.reshape(size, ss, size, ss, 4).mean(axis=(1, 3))

    out[..., 3] = np.clip(out[..., 3] * 1.6, 0.0, 1.0)
    out = bleed_edges(out)

    return (out * 255.0).astype(np.uint8)


def trim(imgs, size):
    """统一裁剪到并集包围盒（和骰子同样的做法）"""
    x0, y0 = size, size
    x1 = y1 = 0
    for a in imgs.values():
        ys, xs = np.where(a[..., 3] > 0)
        if xs.size == 0:
            continue
        x0, x1 = min(x0, int(xs.min())), max(x1, int(xs.max()))
        y0, y1 = min(y0, int(ys.min())), max(y1, int(ys.max()))
    pad = 2
    x0, y0 = max(0, x0 - pad), max(0, y0 - pad)
    x1, y1 = min(size - 1, x1 + pad), min(size - 1, y1 + pad)
    out = {}
    for k, a in imgs.items():
        out[k] = a[y0:y1 + 1, x0:x1 + 1]
    return out, (x0, y0, x1, y1)


def main():
    ap = argparse.ArgumentParser()
    ap.add_argument('--size', type=int, default=600)
    ap.add_argument('--ss', type=int, default=2)
    ap.add_argument('--out', default='miniprogram/images/cup')
    ap.add_argument('--colors', type=int, default=64)
    args = ap.parse_args()

    root = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))
    outdir = os.path.join(root, args.out)
    os.makedirs(outdir, exist_ok=True)

    print(f'渲染骰盅 → {os.path.relpath(outdir, root)}')
    print(f'  分辨率 {args.size}（超采样 {args.ss}x）')
    print(f'  底半径 {CUP_BOTTOM_R}  顶半径 {CUP_TOP_R}  高 {CUP_HEIGHT}')
    print()

    # 三种状态：扣在桌上 / 摇动中（歪）/ 提起（揭盅）
    # ★ 必须**统一裁剪**：三张图会被叠在同一个位置做动画，
    #   各自裁剪会导致尺寸不同，动画时盅会"跳"。
    imgs = {
        'cup-down': render_cup(args.size, args.ss, tilt_deg=0.0, lift=0.0),
        'cup-shake': render_cup(args.size, args.ss, tilt_deg=7.0, lift=0.06),
        'cup-up': render_cup(args.size, args.ss, tilt_deg=-4.0, lift=0.30)
    }
    imgs, box = trim(imgs, args.size)
    print(f'  裁剪到包围盒 x[{box[0]},{box[2]}] y[{box[1]},{box[3]}] → '
          f'{box[2]-box[0]+1}×{box[3]-box[1]+1}')
    print()

    total = 0
    for k in ['cup-down', 'cup-shake', 'cup-up']:
        p = os.path.join(outdir, k + '.png')
        save_png(imgs[k], p, args.colors)
        sz = os.path.getsize(p)
        total += sz
        print(f'  ✓ {k}.png  {sz/1024:>6.1f} KB  '
              f'({imgs[k].shape[1]}×{imgs[k].shape[0]})')

    print(f'\n共 3 张，合计 {total/1024:.1f} KB')


if __name__ == '__main__':
    main()
