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

import importlib.util

import numpy as np
import soundfile as sf
from scipy.signal import resample_poly

ROOT = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))

# ★ 2026-10-29：输出目录改成**分包**。
#
# 音频在 2026-10-28 随房间页一起搬进 miniprogram/game/（分包），
# 而这里一直还写着 miniprogram/audio（主包）——
# 于是跑这个脚本改音效，产物落在主包、游戏读的是分包，**改了等于没改**，
# 而且不报错（只会觉得"怎么调完没变化"）。
# 现场证据：miniprogram/audio/ 里躺着一个 836 字节的 tick.wav（03:16 的产物）。
#
# 注意 tick.wav 是特例：me 页（主包页面）要用它试听，所以额外复制一份到主包
# —— 这与 gen-audio.py 的处理一致（见那边的 shutil.copyfile）。
OUT_DIR = os.path.join(ROOT, 'miniprogram', 'game', 'audio')
MAIN_AUDIO_DIR = os.path.join(ROOT, 'miniprogram', 'audio')
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
    dict(dst='cup-shake',        src='dieShuffle3.ogg', seconds=1.05, sr=44100, rms=-22.0,
         note='摇盅 1 秒（feedback.cupShake 的 animMs=1050）'),
    dict(dst='shaker-metal',     src='dieShuffle3.ogg', seconds=0.90, sr=44100, rms=-24.0,
         note='金属盅摇动（大话骰开局那一下）'),
    dict(dst='dice-tumble-wood', src='dieShuffle3.ogg', seconds=1.00, sr=22050, rms=-21.0,
         note='骰子翻滚（比大小用）'),
    dict(dst='dice-into-cup',    src='diceThrow1.ogg', seconds=0.45, sr=44100, fifty=-20.0,
         note='骰子入盅（起音 24ms）'),
    # ★ 骰子落定的多采样变体（2026-10-30）：一局要响十几次，
    #   只靠 playbackRate ±4% 变调是"同一个声音变声"，而这是三份不同录音。
    #   参数与主文件保持一致（同样的裁切长度/响度目标），只换素材。
    # ★★ 2026-11-02：主文件原来只有合成版 —— 而 2/3 变体已经是真实录音，
    #   意味着一局 5 颗骰子里，前几颗是合成的"嗒"、后面是真实的"嗒"，
    #   **同一种声音在一屏里出现两种音色**。
    #   dieThrow1 起音 34ms（导入时会按能量裁掉前面的静默，等效起音 0）。
    dict(dst='dice-settle',      src='dieThrow1.ogg', seconds=0.30, sr=44100, fifty=-19.0, allow_down_db=5.0,
         note='逐颗落定 · 主文件（与 2/3 变体同源，音色统一）'),
    dict(dst='dice-settle-2',    src='dieThrow2.ogg',  seconds=0.30, sr=44100, fifty=-11.0,
         note='逐颗落定（起音 3ms，一局十几下必须克制）'),
    dict(dst='dice-settle-3',    src='dieThrow3.ogg',  seconds=0.30, sr=44100, fifty=-17.5,
         note='逐颗落定 · 变体 3'),
    dict(dst='dice-on-table',    src='diceThrow3.ogg', seconds=0.42, sr=44100, fifty=-18.0,
         note='揭盅后骰子在桌上滚两下（起音 12ms）'),
    # ---------- 高频 UI：用 Kenney Interface Sounds 的真实录音（2026-11-02）----------
    # ★★ 为什么这几个必须换：tap / tap-soft / tick 是**一局点几十次**的声音。
    #    合成版是短促的噪声脉冲，单听还行，连点十几下就是"电子滴滴声"。
    dict(dst='tap',        src='click_001.ogg', seconds=0.10, sr=44100, fifty=-13.0,
         note='点击反馈（起音 1ms，一局几十次）'),
    # ★ 2026-11-02：原来用 click_004（10ms）—— 太短了，量化误差占比过大，
    #   实测 DC 偏置 278（判据 50），开局会"噗"一声。
    #   换成 click_001（100ms）并压低 5dB：同样是真实的点击声，但能量铺得更开。
    dict(dst='tap-soft',   src='click_001.ogg', seconds=0.10, sr=44100, fifty=-18.0,
         note='轻点击（选牌/换牌）'),
    dict(dst='tick',       src='click_003.ogg', seconds=0.07, sr=44100, fifty=-14.0,
         note='转盘咔哒（一局几十次，间隔 34ms 起）'),
    dict(dst='toggle-on',  src='switch_002.ogg', seconds=0.30, sr=44100, fifty=-15.0,
         note='开关打开（起音 1ms）'),
    dict(dst='cup-slam',   src='impactMetal_heavy_000.ogg', seconds=0.55, sr=44100, fifty=-11.0,
         note='扣盅：金属盅砸在桌上（低频 85%，全场最重的一下）'),
    # ★ 2026-11-02：fifty 从 -12.5 调到 -15.0。
    #   换成真实录音之后，`bong_001` 的前 50ms 能量天然比合成版高，
    #   实测 -12.78 —— **比扣盅（-13.81）还响**，层级反了。
    #   而「扣盅是全场最重的一下」是这个游戏的声音骨架，不能让揭盅压过去。
    dict(dst='reveal-hit', src='bong_001.ogg', seconds=0.70, sr=44100, fifty=-18.3,
         note='揭盅：一声真实的「当」（起音 1ms）'),
    dict(dst='glass-clink', src='impactGlass_heavy_001.ogg', seconds=0.55, sr=44100, fifty=-13.0,
         note='碰杯（罚酒/干杯那一刻）'),
    # ---------- 其余真实物理事件（2026-11-02 第三批）----------
    # 判据：**现实里真实存在的声音**就该用录音；
    #       纯情绪/氛围（combo、fail-drop、confetti、whoosh）留合成 ——
    #       现实中没有"连击音"这种东西，硬做录音反而假。
    dict(dst='dice-shake',  src='dieShuffle2.ogg', seconds=1.05, sr=44100, rms=-22.0,
         note='摇骰（比大小那一下，和 cup-shake 同源不同段）'),
    # ★ 2026-11-02：「抬盅」是**持续动作**（手伸过去、抓住、抬起来），
    #   起音那一下本来就很轻 —— 用「前 50ms」衡量它是不对的，
    #   真实录音的 dieGrab2 起音在 178ms。改用整体 RMS 定标。
    dict(dst='cup-lift',    src='dieGrab2.ogg', seconds=0.83, sr=44100, rms=-24.0,
         note='抬盅（揭开前的最后一刻）'),
    dict(dst='countdown',   src='click_002.ogg', seconds=0.06, sr=44100, fifty=-15.0,
         note='读秒「嗒」（3-2 各一声）'),
    dict(dst='countdown-go', src='switch_001.ogg', seconds=0.40, sr=44100, fifty=-13.0,
         note='读秒收尾「开始」（真实开关的落定感）'),
    dict(dst='toggle-off',  src='switch_001.ogg', seconds=0.30, sr=44100, fifty=-17.0,
         note='开关关闭'),
    dict(dst='tick-2',      src='click_005.ogg', seconds=0.06, sr=44100, fifty=-14.0,
         note='转盘咔哒 · 变体 2'),
    dict(dst='tick-3',      src='click_002.ogg', seconds=0.06, sr=44100, fifty=-16.0,
         note='转盘咔哒 · 变体 3'),
    # ---------- 低频冲击层（2026-11-02）----------
    # `impactLow` 不单独出现：它叠在 `diceOnTable` 和揭盅的中段，
    # 作用就是"给撞击加一层低频体"。所以它必须是**真实的木头重击**，
    # 而不是合成的正弦包络 —— 后者听起来是"嗡"不是"砸"。
    dict(dst='impact-low', src='impactWood_heavy_000.ogg', seconds=0.34, sr=22050, fifty=-13.0,
         note='低频冲击层（真实木头重击，低频 99%）'),
    # ---------- 纸牌 ----------
    dict(dst='card-deal',        src='cardPlace1.ogg', seconds=0.32, sr=44100, fifty=-20.0,
         note='发牌（起音 31ms、前 50ms −16.6，整包里最跟手的一张）'),
    dict(dst='card-flip',        src='cardSlide2.ogg', seconds=0.28, sr=44100, fifty=-21.0,
         note='翻牌（起音 9ms，按住看牌那一刻）'),
    dict(dst='card-spread',      src='cardShove4.ogg', seconds=0.55, sr=44100, fifty=-18.0,
         note='摊牌：几张牌一起拍在桌上（起音 22ms）'),
    # ---------- 筹码 ----------
    dict(dst='chip-bet',         src='chipsStack4.ogg', seconds=0.30, sr=44100, fifty=-18.0,
         note='投票落定（一颗子放进碗里，起音 5ms）'),
]


def _load_spatialize():
    """
    复用 gen-audio.py 里的 spatialize（早期反射 + 房间尾巴 + 末道锐化）。

    ★ 为什么不重写一份：那是同一套物理模型，两份实现迟早会不一致 ——
      而"同一件事两个出口"正是这个项目反复吃亏的地方。
      合成音效和真实录音必须过**同一套**空间处理，才会听起来在同一个房间里。
    """
    try:
        spec = importlib.util.spec_from_file_location(
            'genaudio', os.path.join(ROOT, 'scripts', 'gen-audio.py'))
        mod = importlib.util.module_from_spec(spec)
        spec.loader.exec_module(mod)
        return mod.spatialize
    except Exception as e:
        print('⚠️ 加载 spatialize 失败（本批不做空间化）：', e)
        return None


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


def normalize(x, sr, target_db, mode='fifty', max_gain_db=MAX_GAIN_DB, limit=True,
              allow_down_db=0.0):
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
        # ★ 2026-11-02：加一个**受控的降幅**（默认仍然不降）。
        #   原来一律 return，导致"真实录音比目标响"时无法压下来 ——
        #   而「逐颗落定」恰好需要压（一局响十几次，必须克制）。
        #   `allow_down_db` 是每个条目显式声明"最多能降多少"，不是全局放开。
        cap_down = allow_down_db
        if need >= -abs(cap_down):
            return x
        gain = max(need, -abs(cap_down))
    else:
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

    # ============ 空间化 ============
    #
    # ★★ 2026-10-28 补上。此前**只有合成音效过空间化**（gen-audio.py 的
    #   spatialize：早期反射 + 房间尾巴 + 末道锐化），真实录音是直接进的包。
    #   结果就是：画面里骰盅明明在"一个房间"里，声音却是贴着耳朵的 ——
    #   单独听不明显，和合成音效混着放（同一局里两种都有）就会听出来。
    #
    #   "廉价感的根因是只有直达声"这条在 AGENTS.md 里记过，
    #   而它同样适用于真实录音：真实录音也有直达声和空间感之分。
    sp = _load_spatialize()
    if sp:
        # ★ 只加**早期反射**，不加房间尾巴（tail_ms=0）。
        #   实测加 160ms 尾巴的代价：11 个音效体积 236KB → 321KB（+85KB），
        #   而 RMS 被尾巴稀释掉 8~10dB —— 为了房间感牺牲了体积和响度，
        #   不划算。早期反射（几十毫秒内的几次回声）才是在房间里的感知来源，
        #   尾巴只是尾巴。
        tail = one.get('tail_ms', 0)
        seed = one.get('seed', 11)
        # spatialize 内部是纯 Python list 运算，回来要转回 ndarray
        # ★★ 2026-11-02：**关掉瞬态锐化**（final_sharpen / transient）。
        #
        #   `sharpen_transient` 是给**合成音**设计的 —— 合成音的起音天生软
        #   （正弦渐入），需要人为加一层高频脉冲才"扎"。
        #
        #   而真实录音的起音本来就是锐的。再锐化一次的结果，实测在 `cup-slam` 上：
        #     低频占比 80.4% → **68.8%**，>6kHz 0% → **5.8%**
        #   也就是把"一个金属盅砸在桌上的闷响"，改成了"啪"的一声脆响 ——
        #   **方向正好相反**。扣盅要的是沉，不是脆。
        d = np.asarray(
            sp(d, sr_out, tail_ms=tail, seed=seed,
               transient=False, final_sharpen=False),
            dtype=np.float64)

    if one.get('rms') is not None:
        d = normalize(d, sr_out, one['rms'], mode='rms',
                      allow_down_db=one.get('allow_down_db', 0.0))
    else:
        d = normalize(d, sr_out, one['fifty'], mode='fifty',
                      allow_down_db=one.get('allow_down_db', 0.0))

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
        # ★★★ 2026-11-02：**在 int16 域再消一次直流**。
        #
        #   上面第 374 行已经在浮点域减了均值，但那不够 —— `PCM_16` 的量化
        #   是"向零截断"，会重新引入 -0.5 LSB 的偏移。对 1 秒的音效无所谓，
        #   对 **10ms 的极短音**（tick-2 / countdown）就致命：
        #   实测 tick-2 的 DC 偏置 698（判据 50），播放时会"噗"一声。
        #
        #   做法：先按 int16 量化一遍，把整数的均值减掉，再写回去。
        q = np.round(d * 32767.0)
        q = np.clip(q, -32768, 32767)
        q = q - int(np.round(np.mean(q)))
        # 消直流会把峰值整体抬起来一点（减掉均值 = 平移波形）——
        # 所以这里要再压一次，否则 tick-2 这种满幅短音会顶到 -0.16 dBFS
        qp = float(np.max(np.abs(q)))
        if qp > PEAK_CEIL * 32767:
            q = q * (PEAK_CEIL * 32767 / qp)
        q = np.clip(q, -32768, 32767)
        sf.write(dst, (q / 32767.0).astype(np.float32), sr_out, subtype='PCM_16')

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
    ap.add_argument('--only', default='',
                    help='只处理这些音效（逗号分隔的 dst 名）——'
                         '调整个别音效的采样率时用，避免把所有文件都重写一遍（diff 无法审）')
    args = ap.parse_args()
    only = [x.strip() for x in args.only.split(',') if x.strip()]

    if not os.path.isdir(args.src):
        print('找不到素材目录：' + args.src)
        print('素材来自 Kenney Casino Audio (CC0)：https://kenney.nl/assets/casino-audio')
        sys.exit(2)

    print(f'素材目录: {args.src}')
    print(f'输出目录: {os.path.relpath(OUT_DIR, ROOT)}')
    print(f'{"目标":18s} {"时长":>5s} {"采样率":>6s} {"峰值":>6s} {"整体RMS":>7s} {"前50ms":>6s} {"体积":>6s}')
    total = 0
    chosen = [x for x in MAP if (not only or x['dst'] in only)]
    if only:
        missing_names = [n for n in only if not any(x['dst'] == n for x in MAP)]
        if missing_names:
            print('  ⚠ 这些名字不在 MAP 里：' + ', '.join(missing_names))
    for one in chosen:
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
