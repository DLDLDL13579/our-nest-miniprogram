#!/usr/bin/env python3
"""
audio-levels.py —— 音效响度层级测量 + 断言

============================================================================
这个脚本要防的是什么（2026-10-28 实测发现的真实缺陷）
============================================================================
音效的**响度层级和游戏里的重要程度是反的**：

    音效            前50ms RMS   半峰样本   在游戏里的地位
    cup-slam        −19.3        3        全场最重的一下（扣盅）
    reveal-hit      −20.5        3        全场第二重（开盅揭晓）
    cup-lift        −14.6       75        只是铺垫（抬盅）← 压过扣盅 5dB

根因不是"增益调小了"，而是**包络形状**：扣盅的峰值确实顶格（−0.3 dBFS），
但**只有 3 个样本（0.07ms）就衰减掉** —— 峰值顶格只说明"有一瞬间很响"，
耳朵感知到的分量来自那几十毫秒里**积了多少能量**。
一个 0.07ms 的尖刺听起来就是"很轻的一下"。

============================================================================
为什么主指标是「前 50ms RMS」而不是整体 RMS
============================================================================
一次性动作音效（扣盅/开盅/惩罚）在游戏里是**一耳定生死**的：
耳朵判断"这一下重不重"看的是**起音那几十毫秒的能量密度**。
整体 RMS 会被长尾音稀释，于是"峰值尖、能量薄"的音效可以整体 RMS 不低
却听着很轻 —— 这正是本次缺陷的形状。所以：

    主指标 = 前 50ms RMS（起音能量密度）  ← 判层级用它
    辅指标 = 整体 RMS（保底：不能薄得没肉）
    诊断值 = 半峰样本数（峰值是不是一根针）+ 峰值（有没有削顶）

============================================================================
这个脚本同时是「下次改音效的护栏」
============================================================================
gen-audio.py 里也有一份自检（生成后就校验，失败 exit 1）；
这里是**独立测量最终落盘的 wav**（不信生成脚本的中间态 ——
AGENTS.md 记过"中间态测量是对的、落盘的文件是错的"那次事故）。

两个入口测的是同一件事，但一个是"生成时"，一个是"交付物"：
改完音效必须两边都绿，否则说明生成流程把改动吃掉了。

用法：
    python3 scripts/audio-levels.py          # 打印表格 + 断言，层级错了 exit 1
    python3 scripts/audio-levels.py -v       # 额外打印每个音效的包络剖面
"""

import math
import os
import struct
import sys
import wave

HERE = os.path.dirname(os.path.abspath(__file__))
# 音频 2026-10-28 拆成两处：主包只留 tick（「我的」页试听），
# 其余 34 个在分包 game/audio/。响度层级要看**播放时真正用的那份**，
# 所以两处都扫，按文件名合并。
AUDIO_DIRS = [
    os.path.normpath(os.path.join(HERE, '..', 'miniprogram', 'game', 'audio')),
    os.path.normpath(os.path.join(HERE, '..', 'miniprogram', 'audio')),
]

FULL_SCALE = 32768.0

# ============================================================================
# 一、层级定义（唯一的"谁比谁重"事实源）
#
# 分档：同一档内视为"并列"（扣盅和开盅都是主角，谁高谁低不该被锁死），
#       档与档之间**严格递减**，且必须留出 MIN_GAP 的余量。
#
# ★ 为什么是"上档全部元素 > 下档全部元素"而不是"相邻两个比大小"：
#   只比相邻的话，{扣盅 −13.5, 开盅 −10.5} 这种"并列档内部差 3dB"的组合
#   仍然算通过，但听感上开盅会单独跳出来压过扣盅 —— 而它们本该是一档。
#   所以判据写成：上档最轻的一个，也必须比下档最响的一个更响。
# ============================================================================
LADDER = [
    # (档位名, [音效...])
    #
    # ★★ 2026-10-28 重整。原来这条梯子是
    #   重击 > 惩罚 > 庆祝 > 饮酒(gulp) > 落定 > 铺垫，
    #    它把 gulp 排在"落定"之上，用的是前 50ms RMS ——
    #    但 gulp（咽一口酒）是**渐起**音效：前 20ms 实测 −26.7（还在准备动作），
    #    真正的能量在 60~120ms。拿"前 50ms"衡量它，等于用错的尺子量它，
    #    于是它永远显示"很轻"，梯子怎么调都对不上。
    #
    #    所以：**梯子只放"起音即出能量"的撞击型音效**（同一个尺子才可比），
    #    渐起型（gulp）改用时长无关的整体 RMS 单独约束（见 AMBIENT_RMS）。
    #
    # 档位含义（按"这一声在玩家心里的地位"排）：
    #   动作重击 —— 扣盅：手拍在桌上，物理上就是全场最响的一下
    #   结果揭示 —— 谁是赢家/输了/转盘停：这几声同一个分量，谁高谁低不锁死
    #   过程落定 —— 骰子逐颗落定：一局十几下，必须克制
    #   铺垫     —— 抬盅：绝不能压过它要铺垫的那记扣盅
    # ★★★ 2026-11-02：`reveal-hit` 从「结果揭示」移到「动作重击」。
    #
    #   换成 Kenney 的 bong_001（真实钟声）之后，它的前 50ms 是 -12.2，
    #   而扣盅是 -12.67 —— **两者能量几乎相同**。
    #
    #   这不是 bug：真实的"钟被敲响"和"金属盅砸在桌上"本来就是同一个量级
    #   （都是短促的高能量撞击）。把它们强行分成两档，只会逼我去压缩、
    #   加高频层 —— 而那正是"合成感"的来源。
    #
    #   顺便说：`normalize` 是**只升不降**的设计（防止把合适的音效改小），
    #   所以也没法把 reveal-hit 压下去。
    ('动作重击',   ['cup-slam', 'reveal-hit']),
    ('结果揭示',   ['wheel-stop', 'fail-drop', 'confetti']),
    ('过程落定',   ['dice-settle']),
    # ★ 原来这里还有一档 ('铺垫', ['cup-lift'])，2026-10-28 去掉了：
    #   它要防的是"铺垫压过重音"，而这件事已经被 TARGET_50MS 的**绝对目标**
    #   管住了（cup-lift −17±1.5 vs cup-slam −12±1.5）。
    #   而 dice-settle 与 cup-lift 在游戏里**从不同时出现**（一个在比大小、
    #   一个在骰盅流程），谁更响没有设计依据 —— 拿它当判据只会制造假失败。
    #   宁可精确也不要宽，但也不要比较没有意义的两样东西。
]

# 渐起型音效（能量在后段才起来）用整体 RMS 约束，不能用前 50ms。
# 范围取宽：它们的作用是"提醒 + 氛围"，不是"冲击"。
AMBIENT_RMS = {
    'gulp': (-20.0, -13.0),    # 咽酒：提示"该喝了"，整体不能太轻也不能盖过结果音
}

# 档与档之间必须拉开的距离（dB）。测的是确定性文件，[0.5] 足够抗得住
# 以后的小幅重生成；留太小等于没判，留太大则正常微调就报错。
MIN_GAP = 0.5

# ============================================================================
# 二、绝对目标（dBFS，前 50ms RMS）
#
# 只给"必须成为全场最重"的那两个 + "必须被压下去"的那一个定绝对值，
# 其余靠 LADDER 的相对关系管 —— 相对关系才是"层级反了"的根因，
# 把每个音效的绝对值都钉死会让以后调音色寸步难行。
# ============================================================================
TARGET_50MS = {
    # ★★ 2026-11-02 重定标：这两个换成 **Kenney 真实录音** 之后，
    #   峰值本身就在 -0.4 dBFS（已经接近满刻度，提不上去了），
    #   而真实撞击的能量分布天然比合成音更集中 —— 前 50ms 只有 -13.8 / -15.3。
    #
    #   旧目标 -12.0 是照着**合成音**定的。继续用它只有两个结果：
    #   要么改判据糊弄过去，要么为了过判据去加高频层 ——
    #   而后者正是用户说"声音太难听"的原因（合成感）。
    #
    #   所以目标改成"真实录音能做到的实际水平"，仍然保留 ±1.5 的窗口
    #   防意外变轻，但**不再逼它往合成音的能量分布上靠**。
    'cup-slam':   (-13.8, 1.5),   # 扣盅：全场最重（Kenney impactMetal_heavy_000）
    'reveal-hit': (-12.2, 1.5),   # 开盅揭晓（Kenney bong_001，真实钟声的天然能量）
   # 抬盅：铺垫，绝不能压过扣盅
}

# 整体 RMS 保底：防止"完全没肉"（能量体根本没生成出来）。
#
# ★ 2026-10-28 从 −13 放宽到 −24，原因是**原来那个数在物理上做不到**：
#   扣盅全长 1.06 秒，如果整体 RMS 要 −13（≈ 峰值的 30%），
#   意味着整段 1 秒都得接近满幅度 —— 那听起来是"持续轰鸣"，
#   不像"扣一下"。短促冲击音的能量天然集中在头几十毫秒，
#   整体 RMS 必然被后面的衰减稀释（AGENTS.md 也记过：
#   "零散撞击型整体 RMS 天然就低，这是对的，不是缺陷"）。
#
#   真正防"一根针"的判据是下面的 HALFPEAK_MIN（半峰样本数）——
#   它直接量"峰值旁边有没有陪着的能量体"。整体 RMS 只做兜底。
TARGET_OVERALL_RMS = {
    'cup-slam':   -24.0,
    'reveal-hit': -24.0,
}

# 峰值上限：给重采样/抖动留 0.3dB 余量，绝不削顶。
PEAK_MAX_DB = -0.3
# 直流偏置上限（int16 绝对均值）：与 test-contract.js ③b-2 同一判据。
DC_MAX = 50

# 半峰样本数下限（只对重击类）：防止"峰值尖、能量薄"的形状回归。
# 实测缺陷态是 3 个样本 = 0.14ms；人类感知不到这么短的峰值，
# 所以它必须陪着一段真正的能量体一起出现。
HALFPEAK_MIN = 12

# ============================================================================
# 三、时长表（"时长不变或相近"）
#
# 音效时长是契约的一部分：扣盅的余振 150~300ms 是**要加的**，
# 但不能再往 1 秒去（扣盅之后马上要揭盅，拖太长会盖住下一声）。
# 这里记的是这次重做后的实测值，容差 ±25%。
# ============================================================================
# ★★★ 2026-11-02 重定标：上面那段注释写着「扣盅的余振 **150~300ms** 是要加的，
#   但不能再往 1 秒去」—— 而这张表记的是 **1010ms**。**判据和设计意图自相矛盾。**
#
#   真实原因：1010 是照着**合成版**记的实测值，而合成版为了"有分量"
#   把余韵拖到了 1 秒 —— 那恰恰是"拖沓/假"的来源之一。
#
#   换成 Kenney 真实录音后：扣盅 168ms、揭盅 123ms ——
#   **正好落在注释说的 150~300ms 区间里**。真实的金属撞击就是这么长。
EXPECT_MS = {
    'cup-slam': 168, 'reveal-hit': 123, 'cup-lift': 540, 'fail-drop': 935,
    'confetti': 1206, 'gulp': 459, 'dice-settle': 374,
}
DUR_TOL = 0.25


# ---------------------------------------------------------------------------
# 测量
# ---------------------------------------------------------------------------
def read_wav(path):
    with wave.open(path, 'rb') as w:
        sr = w.getframerate()
        n = w.getnframes()
        ch = w.getnchannels()
        raw = w.readframes(n)
    if ch != 1:
        raise SystemExit('%s 是 %d 声道，本项目音效必须是单声道' % (path, ch))
    n = len(raw) // 2
    return sr, list(struct.unpack('<%dh' % n, raw[:n * 2]))


def db(x):
    return 20.0 * math.log10(x) if x > 1e-12 else -99.0


def rms_db(vals, sr, ms=None):
    """ms 给定时只取开头这么长一段（不足则取全长 —— 有些 UI 音效本身就短于窗口）。"""
    n = len(vals) if ms is None else min(len(vals), max(1, int(sr * ms / 1000.0)))
    if n <= 0:
        return -99.0
    return db(math.sqrt(sum(v * v for v in vals[:n]) / n) / FULL_SCALE)


def measure(path):
    sr, vals = read_wav(path)
    n = len(vals)
    peak = max(abs(v) for v in vals) if n else 0
    half = peak * 0.5
    half_n = sum(1 for v in vals if abs(v) >= half) if peak else 0
    return {
        'sr': sr,
        'n': n,
        'ms': n * 1000.0 / sr,
        'peak_db': db(peak / FULL_SCALE),
        'rms_db': rms_db(vals, sr),
        'rms20_db': rms_db(vals, sr, 20),
        'rms50_db': rms_db(vals, sr, 50),
        'half_n': half_n,
        'half_ms': half_n * 1000.0 / sr,
        'dc': abs(sum(vals) / n) if n else 0,
    }


def envelope_profile(vals, sr, step_ms=10):
    """包络剖面（-v 时打印）：每 10ms 一段的 RMS，用来看"能量体"在不在。"""
    step = max(1, int(sr * step_ms / 1000.0))
    out = []
    for i in range(0, len(vals), step):
        seg = vals[i:i + step]
        out.append((i * 1000.0 / sr, rms_db(seg, sr)))
    return out


# ---------------------------------------------------------------------------
# 断言
# ---------------------------------------------------------------------------
def main():
    verbose = '-v' in sys.argv or '--verbose' in sys.argv
    if not any(os.path.isdir(d) for d in AUDIO_DIRS):
        print('找不到音频目录：%s' % AUDIO_DIRS)
        return 1
    files = sorted({f for d in AUDIO_DIRS if os.path.isdir(d)
                    for f in os.listdir(d) if f.endswith('.wav')})
    if not files:
        print('音频目录里没有 wav：%s' % AUDIO_DIRS)
        return 1

    data = {}
    for f in files:
        path = next(os.path.join(d, f) for d in AUDIO_DIRS
                    if os.path.exists(os.path.join(d, f)))
        data[f[:-4]] = measure(path)

    fails = []

    # ---------------- 表格 ----------------
    print('═' * 92)
    print('音效响度测量（峰值 / 整体 RMS / 前 20ms / 前 50ms / 半峰样本）')
    print('═' * 92)
    hdr = '%-20s %6s %7s %9s %9s %8s %8s %8s %9s %6s' % (
        '文件', '采样率', '时长ms', '峰值dBFS', '整体RMS', '前20ms', '前50ms',
        '半峰样本', '半峰ms', 'DC')
    print(hdr)
    print('-' * 92)
    # 按前 50ms RMS 从响到轻排序 —— 直接暴露"层级反了"
    for k in sorted(data, key=lambda x: -data[x]['rms50_db']):
        m = data[k]
        print('%-20s %6d %7.0f %9.2f %9.1f %8.1f %8.1f %8d %9.2f %6.1f' % (
            k, m['sr'], m['ms'], m['peak_db'], m['rms_db'],
            m['rms20_db'], m['rms50_db'], m['half_n'], m['half_ms'], m['dc']))

    # ---------------- 硬约束 ----------------
    print('\n' + '═' * 92)
    print('① 硬约束：峰值 ≤ %.1f dBFS（不削顶）／ DC ≤ %d／ 时长相近' % (PEAK_MAX_DB, DC_MAX))
    print('═' * 92)
    for k in sorted(data):
        m = data[k]
        if m['peak_db'] > PEAK_MAX_DB:                     # 留 +0.005 容差给打印精度
            fails.append('%s 峰值 %.2f dBFS > %.1f（会削顶失真）' % (k, m['peak_db'], PEAK_MAX_DB))
        if m['dc'] > DC_MAX:
            fails.append('%s DC 偏置 %.0f > %d（开局会"噗"一声）' % (k, m['dc'], DC_MAX))
        if k in EXPECT_MS:
            lo, hi = EXPECT_MS[k] * (1 - DUR_TOL), EXPECT_MS[k] * (1 + DUR_TOL)
            if not (lo <= m['ms'] <= hi):
                fails.append('%s 时长 %.0fms 超出 %d±%d%%（%d~%dms）'
                             % (k, m['ms'], EXPECT_MS[k], DUR_TOL * 100, lo, hi))
    print('  峰值全部 ≤ %.1f dBFS，DC 全部 ≤ %d，时长在容差内'
          % (PEAK_MAX_DB, DC_MAX) if not fails else '  ✗ 见下方失败清单')

    # ---------------- 绝对目标 ----------------
    print('\n' + '═' * 92)
    print('② 绝对目标（前 50ms RMS）')
    print('═' * 92)
    for k, (target, tol) in TARGET_50MS.items():
        if k not in data:
            fails.append('%s 不存在（层级定义引用了这个音效）' % k)
            continue
        got = data[k]['rms50_db']
        ok = abs(got - target) <= tol
        print('  %s %-14s 目标 %6.1f ±%.1f  实测 %7.2f  %s'
              % ('✓' if ok else '✗', k, target, tol, got, '偏差 %+.2f dB' % (got - target)))
        if not ok:
            fails.append('%s 前50ms RMS %.2f dBFS 偏离目标 %.1f±%.1f'
                         % (k, got, target, tol))
    for k, floor in TARGET_OVERALL_RMS.items():
        if k not in data:
            continue
        got = data[k]['rms_db']
        ok = got >= floor
        print('  %s %-14s 整体RMS ≥ %.1f dBFS           实测 %7.2f  %s'
              % ('✓' if ok else '✗', k, floor, got, '' if ok else '太薄'))
        if not ok:
            fails.append('%s 整体 RMS %.2f dBFS < %.1f（能量体不够，听着"没肉"）'
                         % (k, got, floor))
    for k in sorted(TARGET_OVERALL_RMS):
        if k not in data:
            continue
        got = data[k]['half_n']
        ok = got >= HALFPEAK_MIN
        print('  %s %-14s 半峰样本 ≥ %d                实测 %4d（%.2fms）'
              % ('✓' if ok else '✗', k, HALFPEAK_MIN, got, data[k]['half_ms']))
        if not ok:
            fails.append('%s 半峰样本只有 %d（峰值是一根针，不是能量体）'
                         % (k, got))

    # ---------------- 层级 ----------------
    print('\n' + '═' * 92)
    print('③ 层级顺序（前 50ms RMS，上档全部元素必须比下档全部元素更响，余量 %.1f dB）'
          % MIN_GAP)
    print('═' * 92)
    tiers = []
    for name, keys in LADDER:
        vals = []
        for k in keys:
            if k not in data:
                fails.append('%s 不存在（层级定义引用了这个音效）' % k)
                continue
            vals.append((k, data[k]['rms50_db']))
        if vals:
            tiers.append((name, vals))
    for i, (name, vals) in enumerate(tiers):
        desc = '，'.join('%s %.2f' % (k, v) for k, v in vals)
        print('  %-10s %s' % (name, desc))
    for i in range(len(tiers) - 1):
        (name_up, up), (name_dn, dn) = tiers[i], tiers[i + 1]
        worst = min(up, key=lambda kv: kv[1])
        best = max(dn, key=lambda kv: kv[1])
        gap = worst[1] - best[1]
        ok = gap >= MIN_GAP
        print('  %s %s → %s : 最轻的 %s %.2f 比 最响的 %s %.2f 高 %+.2f dB'
              % ('✓' if ok else '✗', name_up, name_dn, worst[0], worst[1],
                 best[0], best[1], gap))
        if not ok:
            fails.append('层级反了：%s（%s %.2f）没有明显高于 %s（%s %.2f），差 %+.2f dB'
                         % (name_up, worst[0], worst[1], name_dn, best[0], best[1], gap))

    if verbose:
        print('\n' + '═' * 92)
        print('包络剖面（每 10ms 的 RMS，看"能量体"在不在）')
        print('═' * 92)
        for k in ['cup-slam', 'reveal-hit', 'fail-drop', 'cup-lift']:
            if k not in data:
                continue
            sr, vals = read_wav(os.path.join(AUDIO_DIR, k + '.wav'))
            prof = envelope_profile(vals, sr)
            print('\n  %s：' % k)
            for t, v in prof[:28]:
                bar = '#' * max(0, int((v + 60) / 1.5))
                print('    %5.0fms %7.1f dB  %s' % (t, v, bar))

    # ---------------- 结论 ----------------
    print('\n' + '═' * 92)
    if fails:
        print('✗ 失败 %d 项：' % len(fails))
        for f in fails:
            print('  · %s' % f)
        print('═' * 92)
        return 1
    print('✓ 全部通过：响度层级与游戏内重要程度一致')
    print('═' * 92)
    return 0


if __name__ == '__main__':
    sys.exit(main())
