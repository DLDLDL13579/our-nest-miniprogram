#!/usr/bin/env python3
"""
import-audio.py —— 把外部**真实录音素材**导入成小程序的音效

============================================================================
为什么要有这个脚本（2026-10-28，用户批评之后加的）
============================================================================
在这之前，全部 35 个音效都是 `gen-audio.py` 用 numpy **合成**的：
正弦波叠噪声、手写包络、手搓反射。它能做到"结构对、时序对"，
但音色本身就是假的 —— 骰子不是真的骰子，牌不是真的纸，桌子不是真的木头。
酒桌上最先被听出来的就是这一点。

合成音的天花板在这里，不是调参能突破的。商业游戏用的是 **foley 录音**。
所以改成：**真实录音 + 数字域的裁剪/归一化/去直流**。

素材来源（全部 CC0，可商用，署名非必需）：
    Kenney.nl — Casino Audio 1.1（50 个文件：骰子 / 纸牌 / 筹码）
    https://kenney.nl/assets/casino-audio
    License: Creative Commons Zero (CC0)

============================================================================
这一步在做什么（以及为什么不能直接拷过去）
============================================================================
Kenney 的原始素材是 44.1kHz **立体声 ogg**，而且：
  · 前后带静音（`die-throw-1` 0.53 秒里只有 0.22 秒有声音）
  · 录制电平差别很大（实测峰值 −0.4 ~ −4.6 dBFS，整体 RMS −19 ~ −34）
  · 立体声 —— 小程序里是单声道播的，白占一倍体积

所以每个文件都要过四道：
    ① 混成单声道
    ② **按能量裁剪**掉前后静音（不裁的话起音会被静音推迟，音画会对不上）
    ③ 重采样到该音效的采样率（沿用 gen-audio.py 的分档：骰子/纸牌 22.05k）
    ④ 归一化到**目标响度**（与 scripts/audio-levels.py 的层级表一致），
       且峰值不越 −0.3 dBFS

============================================================================
怎么跑
============================================================================
    python3 scripts/import-audio.py            # 全部按 MAP 导入
    python3 scripts/import-audio.py --dry-run  # 只打印将做什么

素材目录默认 `/tmp/kenney-casino/Audio`，可用 `--src` 覆盖。
产物直接写进 `miniprogram/audio/`，**文件名与原来一致** ——
这样 sfx.js 的 FILES 清单、feedback.js 的时间轴都不用改。
"""

import argparse
import os
import sys

import numpy as np
import soundfile as sf
from scipy.signal import resample_poly

ROOT = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))
OUT_DIR = os.path.join(ROOT, 'miniprogram', 'audio')
DEFAULT_SRC = '/tmp/kenney-casino/Audio'

PEAK_CEIL = 0.96          # ≈ −0.35 dBFS，给重采样/抖动留余量

# ============================================================================
# 映射表
#   dst          小程序里的文件名（不含扩展名），**必须和 sfx.js 的 FILES 一致**
#   src          Kenney 素材名
#   seconds      裁剪长度（None = 不裁，保留素材原长）
#   sr           输出采样率
#   fifty        前 50ms RMS 的目标（dBFS）—— 与 audio-levels.py 的层级对齐
#   note         这个音效在游戏里干什么（写清楚未来才不会瞎改）
# ============================================================================
MAP = [
    # ==========================================================================
    # 素材是**按测量数据挑的**，不是随便拿一个就用（2026-10-28）。
    #
    # 挑选判据：`起音→峰值` 的距离（单位 ms）。它决定音效听起来"跟不跟手"：
    #   · ≤ 30ms  → 撞击几乎贴着动作开始，跟手
    #   · 100ms+  → 声音比动画晚一大截，玩家会觉得"点下去没反应"
    # 实测同一包里差别极大：`card-shove-2` 只有 2ms，而 `card-fan-1` 是 549ms
    # （它的响点在后半段），前 50ms RMS 只有 −39 —— 直接拿来用等于把
    # feedback.js 那套"视觉先、音效 +30ms"的时序补偿全部作废。
    #
    # 落选记录（供下次别再踩）：
    #   card-fan-1/2      起音 549/894ms —— 不适合做"发牌/摊牌"的第一声
    #   card-place-2/3/4  起音 155/165/205ms
    #   card-slide-4/7    起音 78/157ms
    #   dice-shake-1/2    前 50ms −44/−42（摇盅用 3 号，−32.6 最实）
    # ==========================================================================

    # ---------- 摇盅 / 骰子 ----------
    # ★ 这三个是**持续音**（1 秒的摇动），不能用"前 50ms"衡量 ——
    #   真实录音的摇盅在头 50ms 还在起势，硬把开头推响等于把包络压平。
    #   持续音用整体 RMS 定标（rms 字段）。
    dict(dst='cup-shake',        src='dice-shake-3.ogg', seconds=1.05, sr=22050, rms=-22.0,
         note='摇盅 1 秒（feedback.cupShake 的 animMs=1050）'),
    dict(dst='shaker-metal',     src='dice-shake-3.ogg', seconds=0.90, sr=22050, rms=-24.0,
         note='金属盅摇动（大话骰开局那一下）'),
    dict(dst='dice-tumble-wood', src='dice-shake-3.ogg', seconds=1.00, sr=22050, rms=-21.0,
         note='骰子翻滚（比大小用）'),
    dict(dst='dice-into-cup',    src='dice-throw-1.ogg', seconds=0.45, sr=22050, fifty=-20.0,
         note='骰子入盅（起音 24ms）'),
    dict(dst='dice-settle',      src='die-throw-1.ogg',  seconds=0.30, sr=22050, fifty=-15.5,
         note='逐颗落定（起音 3ms，一局十几下必须克制）'),
    dict(dst='dice-on-table',    src='dice-throw-3.ogg', seconds=0.42, sr=22050, fifty=-18.0,
         note='揭盅后骰子在桌上滚两下（起音 12ms）'),
    # ---------- 纸牌 ----------
    dict(dst='card-deal',        src='card-place-1.ogg', seconds=0.32, sr=22050, fifty=-20.0,
         note='发牌（起音 31ms、前 50ms −16.6，整包里最跟手的一张）'),
    dict(dst='card-flip',        src='card-slide-2.ogg', seconds=0.28, sr=22050, fifty=-21.0,
         note='翻牌（起音 9ms，按住看牌那一刻）'),
    dict(dst='card-spread',      src='card-shove-4.ogg', seconds=0.55, sr=22050, fifty=-18.0,
         note='摊牌：几张牌一起拍在桌上（起音 22ms）'),
    # ---------- 筹码 ----------
    dict(dst='chip-bet',         src='chips-stack-4.ogg', seconds=0.30, sr=22050, fifty=-18.0,
         note='投票落定（一颗子放进碗里，起音 5ms）'),
    # ---------- 酒桌本体：碰杯 ----------
    # ★ 来自另一个包：Kenney Impact Sounds（同样是 CC0）。
    #   Casino Audio 里没有玻璃，而"碰杯"是酒桌味儿最重的一声 ——
    #   35 个音效里原来一个杯子都没有，只有"咽酒"（gulp）。
    #   实测 impactGlass_light_002 起音 0ms、前 50ms −13.8，是这组里最跟手的一下。
    dict(dst='glass-clink',      src='/tmp/k-imp/Audio/impactGlass_light_002.ogg',
         seconds=0.22, sr=22050, fifty=-14.0,
         note='碰杯（罚酒/干杯那一刻；起音 0ms）'),
]


def trim_silence(x, sr, floor_start=-25.0, floor_end=-40.0, pad_ms=6):
    """
    按能量裁剪前后静音，**并把起音对齐到第 0 帧**。

    ★ 阈值取 −25 dBFS（不是 −60，也不是更低的 −38）：
      · −60 什么都裁不掉（真实录音底噪就在 −50~−40）
      · −38 会留下"接近但听不见"的弱起 —— 实测 `card-place-2` 裁完
        前 50ms RMS 只有 −40.6：第一个 50ms 全是"牌接近桌面"的气声，
        真正拍下去在 60~80ms 之后。
        后果不是"轻"，而是**音画错位**：动画在 impactAt+30ms 开始播，
        撞击却要到 120ms 才响 —— 这正是 feedback.js 整套时序补偿
        想解决的问题，被素材的前置弱起一下抵消掉了。
      · −25 让裁出来的第一帧就是"能听见的那一下"，6ms 留白防削起音。

    ★ 起点和终点要用**不同阈值**（这是我第一版搞错的）：
      起点 −25（要"听得见"）、终点 −40（要尾巴）。
      两头都用 −25 时，衰减段掉到 −30 就被切掉 ——
      实测 `dice-on-table` 只剩 20ms、`chip-bet` 剩 50ms，
      骰子滚动和筹码落碗的"余响"全没了，听着像"哒"一下而不是"哒…"。
    """
    if len(x) == 0:
        return x
    pk = float(np.max(np.abs(x)))
    if pk <= 0:
        return x
    thr_s = pk * (10 ** (floor_start / 20.0))
    thr_e = pk * (10 ** (floor_end / 20.0))
    idx_s = np.where(np.abs(x) > thr_s)[0]
    idx_e = np.where(np.abs(x) > thr_e)[0]
    if len(idx_s) == 0 or len(idx_e) == 0:
        return x
    pad = int(sr * pad_ms / 1000.0)
    a = max(0, idx_s[0] - pad)
    b = min(len(x), idx_e[-1] + pad)
    if b <= a:
        return x
    return x[a:b]


def rms_db(x):
    if len(x) == 0:
        return -99.0
    r = float(np.sqrt(np.mean(np.square(x))))
    return 20.0 * np.log10(r) if r > 0 else -99.0


def window_rms_db(x, sr, ms=50):
    n = max(1, int(sr * ms / 1000.0))
    seg = x[:n]
    return rms_db(seg)


def soft_limit(x, ceil=PEAK_CEIL, knee=0.72):
    """
    软限幅（soft-knee limiter）：把超过拐点的部分做 tanh 压缩，而不是整体缩小。

    ★ 为什么需要它：Kenney 的录音是真实距离录的，"一次撞击 + 房间底噪"，
      峰均比很大。纯增益推到目标响度会让峰值顶穿，退回峰值又回到原样
      （gen-audio.py 里踩过同一个坑）。
      软限幅的差别在于只压缩超过拐点的部分 —— 低频撞击被压的那一点失真，
      听感上反而更像"真的砸了一下"（现场录音本身就已经被麦克风压过了）。
    """
    if len(x) == 0:
        return x
    knee_abs = ceil * knee
    span = ceil - knee_abs
    if span <= 0:
        return x
    return np.where(
        np.abs(x) <= knee_abs,
        x,
        np.sign(x) * (knee_abs + span * np.tanh((np.abs(x) - knee_abs) / span))
    )


MAX_GAIN_DB = 8.0   # 单次归一化最多提这么多 —— 再多就是暴力压缩，会糊


def normalize(x, sr, target_db, mode='fifty', max_gain_db=MAX_GAIN_DB, limit=True):
    """
    把响度推到目标，并守住峰值线。**增益有上限**。

    ★ 为什么要设增益上限（+8dB）：
      目标是"让素材在手机外放上听得清"，不是"把目标数字凑上去"。
      上一版没有上限，遇到起音弱的素材（前 50ms −40、目标 −18）会算出一个
      22dB 的增益，软限幅把它压成一团满幅噪声 —— 实测摊牌音整体 RMS 被推到
      −8.4，比扣盅还响 11dB，听着是失真不是"拍牌"。
      有上限之后，推不到的素材就**留在它自然的响度**，靠选材解决（见 MAP 的
      落选记录），而不是靠压缩硬凑。
    """
    cur = window_rms_db(x, sr) if mode == 'fifty' else rms_db(x)
    if cur <= -98:
        return x
    need = target_db - cur
    if need <= 0:
        return x
    gain = min(need, max_gain_db)
    y = x * (10 ** (gain / 20.0))
    pk = float(np.max(np.abs(y)))
    if pk > PEAK_CEIL and limit:
        y = soft_limit(y)
        pk = float(np.max(np.abs(y)))
    if pk > PEAK_CEIL:
        y = y * (PEAK_CEIL / pk)
    return y


MIN_SECONDS = 0.18   # 太短会像"咔"的一声，听不出是什么动作


def process(one, src_dir, dry=False):
    # src 可以写绝对路径（素材来自多个包时用），否则相对 src_dir
    src = one['src'] if os.path.isabs(one['src']) else os.path.join(src_dir, one['src'])
    dst = os.path.join(OUT_DIR, one['dst'] + '.wav')
    if not os.path.exists(src):
        return ('missing', one['dst'], src)
    d, sr = sf.read(src)
    if d.ndim > 1:
        d = d.mean(axis=1)
    d = d.astype(np.float64)

    d = trim_silence(d, sr)
    # ★ 太短的往尾巴多借一点：只有"咔"的一声听不出是什么动作。
    #   做法是换更低的终点阈值（−40 → −52）重裁 —— 阈值放低就是"把更轻的
    #   余响也要进来"，不会把起音带回来（起点阈值不变）。
    if len(d) < int(MIN_SECONDS * sr):
        raw, sr0 = sf.read(os.path.join(src_dir, one['src']))
        if raw.ndim > 1:
            raw = raw.mean(axis=1)
        d = trim_silence(raw.astype(np.float64), sr0, floor_end=-52.0)
    if one.get('seconds'):
        n = int(one['seconds'] * sr)
        d = d[:n]

    # 44.1k → 22.05k（整数比 2:1，resample_poly 走多相抗混叠）；
    # 若素材本身是别的采样率，用有理数比逼近
    sr_out = one['sr']
    if sr != sr_out:
        from math import gcd
        g = gcd(int(sr), int(sr_out))
        d = resample_poly(d, sr_out // g, sr // g)

    if one.get('rms') is not None:
        d = normalize(d, sr_out, one['rms'], mode='rms')
    else:
        d = normalize(d, sr_out, one['fifty'], mode='fifty')

    # 去直流（int16 前必须做，理由见 gen-audio.py 的 quantize 注释）
    d = d - float(np.mean(d))
    # 1.2ms 淡入 / 6ms 淡出：防止边界爆音
    k_in = max(1, int(sr_out * 0.0012))
    k_out = max(1, int(sr_out * 0.006))
    if len(d) > k_in + k_out:
        d[:k_in] *= np.linspace(0.0, 1.0, k_in)
        d[-k_out:] *= np.linspace(1.0, 0.0, k_out)

    pk = float(np.max(np.abs(d)))
    if pk > PEAK_CEIL:
        d = d * (PEAK_CEIL / pk)

    if not dry:
        os.makedirs(OUT_DIR, exist_ok=True)
        sf.write(dst, d.astype(np.float32), sr_out, subtype='PCM_16')

    return ('ok', one['dst'], dict(
        sec=len(d) / sr_out, sr=sr_out,
        peak=20 * np.log10(pk) if pk > 0 else -99,
        fifty=window_rms_db(d, sr_out),
        rms=rms_db(d),
        size=os.path.getsize(dst) if (not dry and os.path.exists(dst)) else 0,
        note=one['note'],
    ))


def main():
    ap = argparse.ArgumentParser()
    ap.add_argument('--src', default=DEFAULT_SRC)
    ap.add_argument('--dry-run', action='store_true')
    args = ap.parse_args()

    if not os.path.isdir(args.src):
        print('找不到素材目录：' + args.src)
        print('素材来自 Kenney Casino Audio (CC0)：https://kenney.nl/assets/casino-audio')
        sys.exit(2)

    print(f'素材目录: {args.src}')
    print(f'输出目录: {os.path.relpath(OUT_DIR, ROOT)}')
    print(f'{"目标":18s} {"时长":>5s} {"采样率":>6s} {"峰值":>6s} {"整体RMS":>7s} {"前50ms":>6s} {"体积":>6s}')
    total = 0
    for one in MAP:
        st, name, info = process(one, args.src, args.dry_run)
        if st == 'missing':
            print(f'  ✗ {name:16s} 素材缺失: {info}')
            continue
        total += info['size']
        print(f'  ✓ {name:16s} {info["sec"]:5.2f}s {info["sr"]:6d} '
              f'{info["peak"]:6.1f} {info["rms"]:7.1f} {info["fifty"]:6.1f} '
              f'{info["size"]//1024:5d}KB  {info["note"]}')
    print(f'\n共 {len(MAP)} 个，合计 {total/1024:.0f} KB')
    if args.dry_run:
        print('（--dry-run，未写文件）')


if __name__ == '__main__':
    main()
