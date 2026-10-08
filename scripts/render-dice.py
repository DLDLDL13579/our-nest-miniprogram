#!/usr/bin/env python3
"""
render-dice.py —— 用光线步进渲染照片级骰子

============ 为什么自己写渲染器 ============

前面试过四种 CSS 方案，全部失败：
  ① 三块矩形拼立体      → 不是透视投影，像"盒子上盖了块案板"
  ② clip-path 平行四边形 → 几何对了但面是锐边，没圆角
  ③ 真 3D 立方体         → 棱和角做不出圆角（CSS 3D 的面在数学上是锐边）
  ④ 等轴测 skew          → skew 会连带扭曲圆角，圆角永远不对

根本原因：CSS 的变换都是**仿射变换**，它们会连带扭曲圆角。
在 CSS 里做真实圆角立方体，数学上无解。

所以改用**真正的 3D 渲染**：用 SDF（有符号距离场）描述几何，
光线步进求交，法线由梯度算出，再按物理光照着色。

这样：
  · 圆角立方体是**数学精确**的（rounded box SDF）
  · 点数是**真实的球形凹陷**（球体布尔减），不是画上去的圆
  · 光照有主光 + 补光 + 边缘光 + 环境遮蔽（AO）
  · 输出带透明通道的 PNG，可直接当游戏素材

============ 用法 ============
    python3 scripts/render-dice.py            # 渲染 6 个面
    python3 scripts/render-dice.py --size 512 # 指定分辨率
"""
import os
import sys
import math
import argparse
import numpy as np
from PIL import Image

# ============================================================
# 骰子几何参数（按真实骰子的比例）
# ============================================================
EDGE = 1.0                      # 边长（归一化）
CORNER_R = 0.13                 # 圆角半径 ≈ 边长 13%（真实骰子 10~15%）
PIP_R = 0.075                   # 点数球半径
PIP_DEPTH = 0.030               # 点数球心沉入表面的深度（越小凹坑越浅）
PIP_INSET = 0.245               # 点数离面边缘的距离（比例）

# 点数在 3×3 网格上的位置（和真实骰子一致）
PIP_LAYOUT = {
    1: [(1, 1)],
    2: [(0, 0), (2, 2)],
    3: [(0, 0), (1, 1), (2, 2)],
    4: [(0, 0), (0, 2), (2, 0), (2, 2)],
    5: [(0, 0), (0, 2), (1, 1), (2, 0), (2, 2)],
    6: [(0, 0), (0, 2), (1, 0), (1, 2), (2, 0), (2, 2)],
}

# 骰子各面的点数（对面和为 7 是真实骰子的标准）
# 坐标：+Z 前, -Z 后, +Y 上, -Y 下, +X 右, -X 左
FACE_VALUE = {
    (0, 0, 1): 1,    # 前
    (0, 0, -1): 6,   # 后
    (0, 1, 0): 2,    # 上
    (0, -1, 0): 5,   # 下
    (1, 0, 0): 3,    # 右
    (-1, 0, 0): 4,   # 左
}


def sdf_rounded_box(p, b, r):
    """
    圆角立方体的有符号距离。
    p: 采样点 (..., 3)
    b: 半边长（标量或 (3,)）
    r: 圆角半径
    返回: 到表面的距离（内部为负）
    """
    q = np.abs(p) - b + r
    outside = np.linalg.norm(np.maximum(q, 0.0), axis=-1)
    inside = np.minimum(np.max(q, axis=-1), 0.0)
    return outside + inside - r


def sdf_sphere(p, c, r):
    return np.linalg.norm(p - c, axis=-1) - r


def pip_positions_on_face(normal, value, half):
    """
    算出某个面上所有点数的球心（略微沉入表面，形成凹陷）。

    真实骰子的点是**钻出来的球缺**，不是画上去的圆 ——
    这是"看起来真"的关键：凹陷的边缘有受光，底部有阴影。
    """
    n = np.array(normal, dtype=np.float64)
    # 面上两个切向轴
    if abs(n[2]) > 0.5:
        u = np.array([1.0, 0.0, 0.0]); v = np.array([0.0, 1.0, 0.0])
    elif abs(n[1]) > 0.5:
        u = np.array([1.0, 0.0, 0.0]); v = np.array([0.0, 0.0, 1.0])
    else:
        u = np.array([0.0, 1.0, 0.0]); v = np.array([0.0, 0.0, 1.0])

    step = PIP_INSET
    centers = []
    for (gx, gy) in PIP_LAYOUT[value]:
        # 网格坐标 0/1/2 → -step / 0 / +step
        a = (gx - 1) * step
        b_ = (gy - 1) * step
        # 球心沉入表面 PIP_DEPTH，这样球缺的开口在表面上
        c = n * (half - PIP_DEPTH) + u * a + v * b_
        centers.append(c)
    return centers


def sdf_dice(p, half, faces):
    """
    整颗骰子：圆角立方体 减去 所有点数球。
    faces: [(normal, value), ...] 要显示点数的面
    """
    d = sdf_rounded_box(p, half, CORNER_R)
    for normal, value in faces:
        for c in pip_positions_on_face(normal, value, half):
            ds = sdf_sphere(p, c, PIP_R)
            # 布尔减：从立方体里挖掉球
            d = np.maximum(d, -ds)
    return d


def sdf_dice_smooth(p, half, faces, k=0.02):
    """
    点数与面的交界处做平滑过渡（smooth subtraction）。
    真实骰子钻孔的边缘有一点点倒角，不是绝对锐利的。
    """
    d = sdf_rounded_box(p, half, CORNER_R)
    for normal, value in faces:
        for c in pip_positions_on_face(normal, value, half):
            ds = sdf_sphere(p, c, PIP_R)
            # smooth max(a, b)，其中 a = 立方体距离、b = -球距离
            #
            # ⚠️ 这里曾经写成 (a + b)，是错的 —— 必须用 (a - b)。
            # 用 (a+b) 时，只要 |b| > a（背面那些看不见的点数球恰好是这种情况），
            # h 就被钳到 1，函数直接返回球的距离（约 -3.37），
            # 于是「立方体外部」被判成「内部」：光线第一步就"命中"，t 停在 0，
            # 渲染出的整张图 alpha 全 0 —— 看起来像渲染器没跑，其实是跑了但全错。
            a, b = d, -ds
            h = np.clip(0.5 - 0.5 * (a - b) / k, 0.0, 1.0)
            d = a * (1 - h) + b * h + k * h * (1 - h)
    return d


def normal_at(p, half, faces, eps=1e-3):
    """用中心差分求法线"""
    n = np.zeros_like(p)
    for i in range(3):
        off = np.zeros(3); off[i] = eps
        n[..., i] = (sdf_dice_smooth(p + off, half, faces) -
                     sdf_dice_smooth(p - off, half, faces))
    ln = np.linalg.norm(n, axis=-1, keepdims=True)
    return n / np.maximum(ln, 1e-9)


def ao_at(p, n, half, faces, samples=6):
    """
    环境遮蔽：沿法线方向做几次探测，看有多少被自身挡住。
    这是"真实感"的关键 —— 点数的凹陷里应该比平面暗。
    """
    occ = np.zeros(p.shape[:-1])
    for i in range(1, samples + 1):
        h = 0.008 * i * i
        d = sdf_dice_smooth(p + n * h, half, faces)
        occ += (h - d) / h
    occ = np.clip(1.0 - occ / samples * 0.85, 0.0, 1.0)
    return occ


def march_ortho(sdf_world, size, ss, extent=0.95, cam_z=3.0, t_max=4.5,
                eps_hit=1.2e-3, eps_step=8e-4, max_iter=96):
    """
    正交投影下的光线步进（相机在 +Z 远处，光线沿 -Z）。

    抽成通用函数是为了让骰盅（render-cup.py）复用同一套求交逻辑 ——
    这段代码里有两次踩坑修出来的东西（活跃像素集合、命中判定的容差），
    复制一份必然会分叉，到时候两个物体的边缘行为就不一致了。

    sdf_world(p) 接收 (N,3) 的世界坐标点，返回 (N,) 距离。

    返回 (ox, oy, t, hit, W, H)：
      ox/oy  每个像素的射线起点 x/y（世界坐标，一维长度 W*H）
      t      命中参数（相机到交点沿 -Z 的距离）
      hit    是否命中（一维布尔）
    """
    W = H = size * ss
    xs = np.linspace(-extent, extent, W)
    ys = np.linspace(extent, -extent, H)
    gx, gy = np.meshgrid(xs, ys)
    ox = gx.ravel()
    oy = gy.ravel()

    # ★ 性能要点（这两条原来是 bug，单面渲染要 229 秒）：
    #   ① 原退出条件是 hit.all() —— 但物体只占画面一部分，
    #      背景像素永远不会命中，这个条件**永远为假**，于是循环一次不落地全跑完；
    #   ② 已命中 / 已逃逸的像素之后每轮还在重复求值。
    # 现在每轮只对「仍活跃」的像素求值，活跃集合空掉就退出。
    t = np.zeros(H * W)
    hit = np.zeros(H * W, dtype=bool)
    active = np.ones(H * W, dtype=bool)

    for _ in range(max_iter):
        if not active.any():
            break
        idx = np.flatnonzero(active)
        p_w = np.stack([ox[idx], oy[idx], cam_z - t[idx]], axis=-1)
        d = sdf_world(p_w)

        landed = d < eps_hit
        if landed.any():
            hit[idx[landed]] = True
        step = np.maximum(d, eps_step)
        step[landed] = 0.0            # 已落定的不再前进，保住交点 t
        t[idx] += step
        active[idx] = ~landed & (t[idx] <= t_max)

    return ox, oy, t, hit, W, H


def render_dice(value, size=512, ss=2):
    """
    渲染骰子的一个朝向：正面朝上的是 value。

    返回 RGBA 的 numpy 数组。
    """
    # 让 value 转到 +Z（正面）
    # 每个值的旋转：把该值的轴转到 +Z
    AXIS_OF_VALUE = {v: n for n, v in FACE_VALUE.items()}
    target = np.array(AXIS_OF_VALUE[value], dtype=np.float64)

    # 构造旋转：把 target 转到 (0,0,1)
    z = np.array([0.0, 0.0, 1.0])
    if np.allclose(target, z):
        R = np.eye(3)
    elif np.allclose(target, -z):
        R = np.array([[-1.0, 0, 0], [0, 1, 0], [0, 0, -1]])   # 绕 Y 转 180°
    else:
        axis = np.cross(target, z)
        axis = axis / np.linalg.norm(axis)
        ang = math.acos(np.clip(np.dot(target, z), -1, 1))
        K = np.array([[0, -axis[2], axis[1]],
                      [axis[2], 0, -axis[0]],
                      [-axis[1], axis[0], 0]])
        R = np.eye(3) + math.sin(ang) * K + (1 - math.cos(ang)) * (K @ K)

    # 再叠加一个观察视角：从右上前方看，让三个面都露出来
    # （先绕 Y 转，再绕 X 转）
    def rot_y(a):
        c, s = math.cos(a), math.sin(a)
        return np.array([[c, 0, s], [0, 1, 0], [-s, 0, c]])
    def rot_x(a):
        c, s = math.cos(a), math.sin(a)
        return np.array([[1, 0, 0], [0, c, -s], [0, s, c]])

    VIEW_Y = math.radians(-27)      # 向右转，露出右面
    VIEW_X = math.radians(24)       # 向下看，露出顶面
    Rv = rot_x(VIEW_X) @ rot_y(VIEW_Y)

    Rtotal = Rv @ R

    half = EDGE / 2.0

    # ---- 只保留朝向相机的 3 个面 ----
    #
    # 这是一个**精确等价**的优化，不是近似：被剔除的那 3 个面的点数球
    # 完全埋在立方体内部（球心在 z = -(half-PIP_DEPTH)，半径 PIP_R，
    # 最远只到 |z| ≈ 0.54），而可见表面在 |z| ≈ 0.5 的另一侧 ——
    # 两者相距 0.95 以上，远大于球半径 0.082。
    #
    # 对立方体外部的任意点 p，布尔减 max(d, -sphere(p)) 只有在 p 落在球内
    # 时才可能大于 d；而可见表面附近的点离那些球很远，永远不在球内。
    # 所以剔除它们不改变任何一个可见像素的取值。
    #
    # 收益：每次 SDF 求值的球数 21 → 6（约 3.5 倍）。
    vis_faces = []
    for n_local, val in FACE_VALUE.items():
        n_world = Rtotal @ np.array(n_local, dtype=np.float64)
        if n_world[2] > 0.05:            # 世界坐标下法线朝向相机（+Z）
            vis_faces.append((n_local, val))

    # 把采样点变换到骰子的本地坐标系
    Rinv = Rtotal.T
    def to_local(p_world):
        return p_world @ Rinv.T

    def sdf_world(p_world):
        return sdf_dice_smooth(to_local(p_world), half, vis_faces)

    ox, oy, t, hit, W, H = march_ortho(sdf_world, size, ss)

    # ---- 着色 ----
    #
    # 只对命中的像素求法线和 AO（各要 6 次 SDF 求值），
    # 背景像素占画面一半以上，对它们算这些是纯浪费。
    out = np.zeros((H, W, 4))
    rgb = np.empty((H * W, 3))
    # 背景填骰子底色而不是黑：下采样后轮廓像素的 alpha 在 0~1 之间，
    # 若底色是黑，边缘会糊出一圈灰边（"发黑"），填底色则自然渐隐。
    rgb[:] = np.array([0.945, 0.915, 0.855])

    hi = np.flatnonzero(hit)
    if hi.size:
        p_w = np.stack([ox[hi], oy[hi], 3.0 - t[hi]], axis=-1)
        pl = to_local(p_w)
        nl = normal_at(pl, half, vis_faces)
        n = nl @ Rtotal.T                      # 法线转回世界坐标

        # 光照（世界坐标下，光从左上前方来）
        L1 = np.array([-0.45, 0.62, 0.65]); L1 /= np.linalg.norm(L1)   # 主光
        # 补光放在**右侧偏后**，别正对右面 —— 否则右面会被补光照得比正面还亮，
        # 层次就反了（第一版实测右面 183 > 正面 172，就是这个原因）。
        L2 = np.array([0.92, 0.00, 0.08]);  L2 /= np.linalg.norm(L2)   # 补光
        L3 = np.array([0.15, -0.85, 0.25]); L3 /= np.linalg.norm(L3)   # 底部反弹光
        V = np.array([0.0, 0.0, 1.0])                                   # 视线

        def lambert(L):
            return np.maximum(n @ L, 0.0)

        def blinn(L, shin):
            Hv = L + V
            Hv = Hv / np.linalg.norm(Hv)
            return np.maximum(n @ Hv, 0.0) ** shin

        # 骨白材质（略带暖调，不是纯白）
        base_bone = np.array([0.945, 0.915, 0.855])
        # ---- 点数坑内填深色 ----
        #
        # 为什么必须填色：坑壁受光会在凹陷周围形成一圈亮环，坑内若与表面同色，
        # 人眼会把它读成「凸起的白珍珠」而不是「凹坑」—— 这是光照歧义，
        # 同一种明暗分布既能解释成凹也能解释成凸。
        # 真实骰子的点数是填色的，填色同时消除歧义，
        # 也让小尺寸下点数可读（游戏里骰子只显示约 95px，纯凹坑在那个尺寸下会糊成一片）。
        # 注意容差：命中点落在**洞壁上**时，它恰好在球面上，ds ≈ 0。
        # 若判 ds < 0 会因数值误差漏掉一半内壁，所以要带一点正容差。
        # 平面上远离洞的点 ds 是明显的正值（>0.3），不会被误判。
        pip_dark = np.zeros(pl.shape[0], dtype=bool)
        for n_local, val in vis_faces:
            for c in pip_positions_on_face(n_local, val, half):
                ds = np.linalg.norm(pl - c[None, :], axis=-1) - PIP_R
                pip_dark |= ds < 1.5e-3

        # 深棕（不用纯黑：纯黑在暖光下发死，和骨白材质不搭）
        base_pip = np.array([0.145, 0.125, 0.115])
        base = np.where(pip_dark[:, None], base_pip[None, :], base_bone[None, :])

        ao = ao_at(pl, nl, half, vis_faces)

        # ---- 光照配比 ----
        #
        # ★ 这些系数是按「实测三个面的亮度」标定出来的，不是拍脑袋填的。
        #   标定脚本见提交说明：低分辨率渲染 + 分区取亮度 + 网格搜索。
        #
        # 第一版是 key .95 / fill .30 / bounce .16 / 环境 .10，渲染后实测：
        #   顶面 236、正面 151、右面 108
        # 两个问题：
        #   ① 暗面 108 太黑 —— 白色塑料骰子的暗面约 150，
        #      压到 108 会让整颗骰子"发灰发脏"，像旧骰子而不是干净骨白。
        #   ② 补光方位不对 —— 它正对着右面，一旦调大就把右面照得比正面还亮，
        #      明暗层次整个反过来。
        #
        # 现在这组实测：顶面 249 / 正面 201 / 右面 160，
        # 层次是「亮面 > 中间面 > 暗面」，与真实室内光下的骰子一致。
        key    = lambert(L1) * 0.90
        fill   = lambert(L2) * 0.26
        bounce = lambert(L3) * 0.20
        spec   = blinn(L1, 42.0) * 0.38
        # 坑内抑制高光与边缘光：否则坑底会出现一个亮点，
        # 又把它读回「凸起」—— 高光是凸面才有的特征。
        not_pip = (~pip_dark).astype(np.float64)
        spec = spec * (0.18 + 0.82 * not_pip)

        # 环境光 0.34：暗面亮度的主要来源。
        # AO 也不再乘满（只占 38%）—— 完全乘上去会把凹陷处压成黑块。
        shade = (key + fill + bounce) * (0.62 + 0.38 * ao) + 0.34
        col = base * shade[:, None]
        col = col + spec[:, None] * np.array([1.0, 0.99, 0.96])[None, :]

        # 边缘光：轮廓上的一圈微亮，让骰子从背景里"浮"出来
        fres = (1.0 - np.maximum(n @ V, 0.0)) ** 3.0
        col = col + (fres * not_pip)[:, None] * 0.10

        rgb[hi] = np.clip(col, 0.0, 1.0)

    out[..., :3] = rgb.reshape(H, W, 3)
    out[..., 3] = hit.reshape(H, W).astype(np.float64)

    # 下采样（超采样抗锯齿）
    if ss > 1:
        out = out.reshape(size, ss, size, ss, 4).mean(axis=(1, 3))

    # 未命中的地方 alpha 归零
    out[..., 3] = np.clip(out[..., 3] * 1.6, 0.0, 1.0)

    # ---- alpha 边缘颜色外扩（bleed）----
    #
    # ★ 这一步不是可选的装饰，是消除「暗表面旁边的亮描边」的关键。
    #
    # 问题：未命中的背景像素我填的是**统一骨白**。骰子底部/右侧这些
    # 本来就暗的面，其边缘抗锯齿像素会按比例混入骨白 ——
    # 于是在深色桌面上，暗面旁边就出现一圈**发白的描边**（放大看是锯齿白边）。
    #
    # 正确做法：让每个半透明像素的 RGB 取**离它最近的真实表面颜色**，
    # alpha 保持不变。这样边缘混出去的也是该处的颜色，描边自然消失。
    # 这是图像合成里的标准处理（premultiplied 边界外扩）。
    out = bleed_edges(out)

    return (out * 255.0).astype(np.uint8)


def bleed_edges(rgba, rounds=4):
    """
    把不透明像素的颜色向外扩散到半透明/透明像素上，alpha 不变。

    为什么需要：边缘抗锯齿像素的颜色是"表面色与背景色按 alpha 混合"的结果。
    如果背景填的是统一亮色（骨白），那么**暗面**的边缘就会带上一层亮色，
    合成到深色桌面上时表现为一圈发白的描边（放大看是锯齿白边）。

    做法：迭代地把"已有确定颜色的像素"向 8 邻域里"alpha 更低"的像素扩散。
    只改 RGB，不动 alpha —— 所以不会让骰子变大，只是把边缘的颜色填对。
    """
    rgb = rgba[..., :3].copy()
    a = rgba[..., 3]
    known = a >= 0.999                      # 完全不透明的像素：颜色是可信的
    if not known.any():
        return rgba

    # 未确定的像素：alpha 低（含完全透明）。它们需要借颜色。
    unknown = ~known
    for _ in range(rounds):
        if not unknown.any():
            break
        # 8 邻域平均，只取"已确定"的邻居
        acc = np.zeros_like(rgb)
        cnt = np.zeros(a.shape)
        for dy in (-1, 0, 1):
            for dx in (-1, 0, 1):
                if dy == 0 and dx == 0:
                    continue
                src = np.roll(np.roll(rgb, dy, axis=0), dx, axis=1)
                m = np.roll(np.roll(known, dy, axis=0), dx, axis=1)
                # roll 会环绕，把越界的行/列剔掉
                if dy == 1:   m[0, :] = False
                if dy == -1:  m[-1, :] = False
                if dx == 1:   m[:, 0] = False
                if dx == -1:  m[:, -1] = False
                acc += src * m[..., None]
                cnt += m
        got = unknown & (cnt > 0)
        if not got.any():
            break
        rgb[got] = acc[got] / cnt[got][..., None]
        known = known | got
        unknown = ~known

    out = rgba.copy()
    out[..., :3] = rgb
    return out


def save_png(rgba, path, colors=64):
    """
    存 PNG。alpha 必须保留（骰子要叠在绒布桌面上）。

    ---- 为什么要调色板量化 ----
    直接存 RGBA 无损 PNG，6 张共 240 KB —— 对小程序包（主包上限 2 MB）偏重。
    骰子是**平滑的骨白渐变 + 深色点数**，色域其实很窄，量化到 64 色后
    实测平均色差 0.55/255（肉眼不可辨），体积降到 148 KB。

    为什么不直接用 WebP（同样质量只要 41 KB）：
    小程序 image 组件对 WebP 的支持依赖基础库与系统版本，
    万一不显示就是**骰子整个消失**——这是游戏的主角元素，不值得赌。
    PNG 是全平台无条件支持的格式。

    ★ 量化必须在这里做（而不是事后手工压一遍）：
    否则「脚本重新渲染」和「仓库里的图」就不是同一份产物，
    下次谁跑一次脚本就会把体积悄悄打回 240 KB。
    """
    im = Image.fromarray(rgba, 'RGBA')
    if colors and colors < 256:
        alpha = im.getchannel('A')
        # 只对 RGB 量化，alpha 单独保留 —— 否则半透明边缘会被量化成一圈色块
        q = im.convert('RGB').quantize(colors=colors, method=Image.MEDIANCUT)
        im = q.convert('RGBA')
        im.putalpha(alpha)
    im.save(path, optimize=True, compress_level=9)


def main():
    ap = argparse.ArgumentParser()
    # 默认 600：骰子占画布约 66%，600 × 0.66 ≈ 397px。
    # 游戏里骰子显示 266rpx ≈ 133pt，@3x 设备需要约 399 物理像素 —— 刚好够。
    ap.add_argument('--size', type=int, default=600)
    ap.add_argument('--ss', type=int, default=2)
    ap.add_argument('--out', default='miniprogram/images/dice')
    ap.add_argument('--no-trim', action='store_true',
                    help='保留画布留白，不裁剪到骰子包围盒')
    ap.add_argument('--colors', type=int, default=64,
                    help='调色板颜色数（默认 64，实测色差 0.55/255；256 = 不量化）')
    args = ap.parse_args()

    root = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))
    outdir = os.path.join(root, args.out)
    os.makedirs(outdir, exist_ok=True)

    print(f'渲染骰子 6 个面 → {os.path.relpath(outdir, root)}')
    print(f'  分辨率 {args.size}（超采样 {args.ss}x）')
    print(f'  圆角 {CORNER_R}（边长 13%）  点数半径 {PIP_R}  凹陷深度 {PIP_DEPTH}')
    print()

    # 先全部渲染到内存，再统一裁剪 —— 必须统一，
    # 否则每张图各自裁剪会得到不同尺寸，CSS 里没法用一个固定的宽高比。
    imgs = {v: render_dice(v, size=args.size, ss=args.ss) for v in range(1, 7)}

    if not args.no_trim:
        # 六张取并集包围盒。轮廓由立方体决定、点数都在内部，
        # 所以六张本来就该一致；取并集是防止某张多出一两个半透明像素。
        x0, y0 = args.size, args.size
        x1 = y1 = 0
        for a in imgs.values():
            ys, xs = np.where(a[..., 3] > 0)
            if xs.size == 0:
                continue
            x0, x1 = min(x0, int(xs.min())), max(x1, int(xs.max()))
            y0, y1 = min(y0, int(ys.min())), max(y1, int(ys.max()))
        # 留 2px 余量，免得把边缘那圈抗锯齿像素切掉
        pad = 2
        x0, y0 = max(0, x0 - pad), max(0, y0 - pad)
        x1, y1 = min(args.size - 1, x1 + pad), min(args.size - 1, y1 + pad)
        for v in imgs:
            imgs[v] = imgs[v][y0:y1 + 1, x0:x1 + 1]
        print(f'  裁剪到包围盒 x[{x0},{x1}] y[{y0},{y1}] → '
              f'{x1 - x0 + 1}×{y1 - y0 + 1}（原 {args.size}×{args.size}，'
              f'省掉 {(1 - (x1 - x0 + 1) * (y1 - y0 + 1) / args.size ** 2) * 100:.0f}% 空白像素）')
        print()

    total = 0
    for v in range(1, 7):
        p = os.path.join(outdir, f'dice-{v}.png')
        save_png(imgs[v], p, args.colors)
        sz = os.path.getsize(p)
        total += sz
        print(f'  ✓ dice-{v}.png  {sz/1024:>6.1f} KB  '
              f'({imgs[v].shape[1]}×{imgs[v].shape[0]})')

    print(f'\n共 6 张，合计 {total/1024:.1f} KB')


if __name__ == '__main__':
    main()
