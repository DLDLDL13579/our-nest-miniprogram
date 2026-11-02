#!/usr/bin/env python3
"""
游戏音效库 v2 —— 扩充版（22 个音效）

v1 只有 8 个，实际做游戏时发现不够：
摇骰子需要"滚动→碰撞→落定→开盅"四个层次，
转盘需要"启动→持续咔哒→减速→揭晓"，
酒桌游戏还需要"倒酒、碰杯、输了、赢了"这些情绪音。

设计原则（都基于真实物理直觉，不是随便加 beep）：
  · 骰子碰撞 = 宽带噪声 + 高通（塑料感）+ 极短起音（1.2ms）
  · 骰子滚动 = 噪声 + 一阶低通 + 慢衰减（摩擦感）
  · 开盅     = 明亮上扬双音（根音+五度），带气声起手
  · 转盘咔哒 = 方波脉冲，18ms（机械感的关键是"极短"）
  · 中奖     = 四音上行琶音（大调 = 好事）
  · 输了     = 下行两音（小调 = 遗憾，但不刺耳）
  · 碰杯     = 两个高频正弦 + 快速衰减（玻璃感）
  · 倒酒     = 带通噪声 + 音高渐升（液体注入的"咕嘟"感）

输出：16-bit PCM WAV，单声道 22050Hz
"""
import math
import os
import random
import struct
import wave

SR = 22050
# ★ 2026-10-28：音效 2026-10-28 拆进了分包（主包只留 tick 给「我的」页试听）。
#   这个脚本原来还往主包写 —— 分包改造时漏改了，一跑就把 35 个音效
#   全生成回主包（主包从 228KB 涨回 800KB+）。
#   现在输出到分包，tick 在 main 里单独复制回主包。
OUT_DIR = os.path.join(os.path.dirname(os.path.abspath(__file__)), '..', 'miniprogram', 'game', 'audio')
MAIN_AUDIO_DIR = os.path.join(os.path.dirname(os.path.abspath(__file__)), '..', 'miniprogram', 'audio')

# 体积控制：按音效的最高有效频率挑输出采样率。
#
# 原理（奈奎斯特）：采样率只要 >= 最高频率的 2 倍就不会丢信息。
#   · 骰子/转盘/碰杯这类"脆"的声音，高频到 4~5kHz → 需要 11025Hz
#   · 纯低频类（suspense/drink/lose 主频 < 500Hz）→ 8000Hz 足够
#
# 为什么值得做：WAV 未压缩，体积 = 采样率 × 时长。
# 全部用 22050Hz 是 530KB，按需降下来约 260KB ——
# 游戏音效必须打进主包（云存储首次下载有延迟，"即点即响"的手感就没了），
# 而主包只有 2MB，省下来的都是余地。
SR_HI = 22050   # 高频内容（脆响、宽带噪声）
SR_MID = 11025  # 常规
SR_LO = 8000    # 纯低频


def resample(sig, src_sr, dst_sr):
    """线性插值降采样。音效不需要抗混叠滤波器 —— 先低通再抽会更干净，
    但这些素材本来就没有超过 dst_sr/2 的能量，直接插值就够。"""
    if dst_sr >= src_sr:
        return sig, src_sr
    n_out = int(len(sig) * dst_sr / src_sr)
    out = []
    for i in range(n_out):
        pos = i * src_sr / dst_sr
        i0 = int(pos)
        i1 = min(i0 + 1, len(sig) - 1)
        frac = pos - i0
        out.append(sig[i0] * (1 - frac) + sig[i1] * frac)
    return out, dst_sr


# ---------------- 基础工具 ----------------

def env_decay(n, tau):
    return [math.exp(-i / tau) for i in range(n)]


def soft_limit(sig, knee=0.62, ceiling=0.95):
    """
    软限幅 —— 把"一根针"的尖峰压下去，把峰值预算让给能量体。

    ★ 2026-11-02：撞击类音效的峰值常是 1~2 个采样点的尖刺。
      峰值归一化会按那个尖刺把整体缩得很小 —— 结果是
      「半峰样本 = 1」（一根针）、整体 RMS 太低，听着"没肉"。
      手机扬声器还原不了尖刺，它只认能量。

    knee 以下原样通过（保住瞬态形状），knee 以上按 tanh 压平。
    撞击声轻微削波反而更结实 —— 商业游戏音效几乎都过限幅器。
    """
    out = []
    span = ceiling - knee
    for x in sig:
        a = abs(x)
        if a <= knee:
            out.append(x)
        else:
            y = knee + span * math.tanh((a - knee) / span)
            out.append(y if x > 0 else -y)
    return out


def env_ad(n, attack, tau):
    """起音 + 指数衰减。撞击声需要极短起音，否则听起来"软"。"""
    out = []
    for i in range(n):
        a = min(1.0, i / max(1, attack))
        out.append(a * math.exp(-max(0, i - attack) / tau))
    return out


def noise(n, seed=None):
    rnd = random.Random(seed)
    return [rnd.uniform(-1, 1) for _ in range(n)]


def lowpass(sig, alpha):
    out, prev = [], 0.0
    for x in sig:
        prev = prev + alpha * (x - prev)
        out.append(prev)
    return out


def highpass(sig, alpha):
    out, pi, po = [], 0.0, 0.0
    for x in sig:
        po = alpha * (po + x - pi)
        pi = x
        out.append(po)
    return out


def bandpass(sig, lo, hi):
    return lowpass(highpass(sig, hi), lo)


def sine(n, freq, sr=SR, phase=0.0):
    return [math.sin(2 * math.pi * freq * i / sr + phase) for i in range(n)]


def sine_sweep(n, f0, f1, sr=SR):
    """扫频：用于"咕嘟"、警笛、机械加速这类效果。"""
    out, ph = [], 0.0
    for i in range(n):
        f = f0 + (f1 - f0) * (i / max(1, n - 1))
        ph += 2 * math.pi * f / sr
        out.append(math.sin(ph))
    return out


def square(n, freq, sr=SR, duty=0.5):
    out = []
    for i in range(n):
        ph = (i * freq / sr) % 1.0
        out.append(1.0 if ph < duty else -1.0)
    return out


def mix(*tracks):
    if not tracks:
        return []
    L = max(len(t) for t in tracks)
    out = [0.0] * L
    for t in tracks:
        for i, v in enumerate(t):
            out[i] += v
    return out


def gain(sig, g):
    return [x * g for x in sig]


def concat(*parts):
    out = []
    for p in parts:
        out.extend(p)
    return out


def place(sig, offset, total):
    out = [0.0] * total
    for i, v in enumerate(sig):
        if 0 <= offset + i < total:
            out[offset + i] += v
    return out


def normalize(sig, peak=0.92):
    m = max((abs(x) for x in sig), default=0.0)
    if m < 1e-9:
        return sig
    k = peak / m
    return [x * k for x in sig]


def fade_edges(sig, ms=1.2):
    """
    首尾淡入淡出，消除采样端点的突变（突变 = 播放时"咔"的爆音）。

    ⚠️ 这里踩过一个坑：淡入淡出的**长度必须极短**。
       第一版是 4ms 线性淡入，而「骰子入盅」这类音效的**第一声撞击就在第 0ms** ——
       4ms 淡入正好把最响的那一下削掉 27%（实测峰值 0.97 → 0.708），
       撞击声变得"很轻"。这类音效（起音即峰值）整体都被削弱。

    所以做了两件事：
      ① 淡入淡出缩短到 1.2ms —— 只够消掉端点突变，不影响任何有效内容
      ② 曲线改成**平方**（k²）而不是线性 —— 平方曲线在同样的 1.2ms 内
         上升得更快，等于"几乎不削峰"
    """
    n = min(max(1, int(SR * ms / 1000)), len(sig) // 4)
    out = list(sig)
    for i in range(n):
        k = (i / n) ** 2
        out[i] *= k
        out[-1 - i] *= k
    return out


def early_reflections(sig, sr=SR, count=4, first_ms=18, decay=0.55, spread_ms=11, seed=31):
    """
    早期反射 —— 让声音「发生在房间里」而不是「贴在脸上」。

    原理：真实房间里，直达声之后 20~60ms 会到达几次墙面反射。
    人脑靠这些反射判断「这个声音在多远、多大的空间」。
    合成音效之所以显得廉价，最主要的原因就是**只有直达声**——
    听起来像「在耳朵里响」，而不是「在桌子上响」。

    实测参考：声音反射需要延迟 20~30ms 才被大脑感知为**独立**的声源；
    更短的间隔会融合成「音色」的一部分（这正是我们要的——
    让它变成空间感而不是回声）。

    count     反射次数（3~5 次够用，再多只增加体积）
    first_ms  第一次反射的延迟（太短会糊，太长会变成回声）
    decay     每次反射的衰减系数
    spread_ms 反射之间的间隔增量（模拟房间不规则）
    """
    rnd = random.Random(seed)
    n = len(sig)
    out = list(sig)
    delay = first_ms / 1000.0
    g = 1.0
    for i in range(count):
        g *= decay * rnd.uniform(0.85, 1.15)
        off = int(delay * sr)
        if off >= n:
            break
        # 反射比直达声更「闷」（高频被墙面吸收）—— 这是空间感的关键细节
        # ★ 同时压低幅度：最初版本反射增益接近直達声，实测把包络峰值
        #   从 4.6ms 推到 31.8ms —— 听感上变成「呼」而不是「咔」，
        #   空间感没换来，反而把瞬态毁了。
        #   真实房间的早期反射比直达声低 6~12dB（约 0.25~0.5 倍），
        #   而且必须保持这条「反射永远弱于直达声」的纪律。
        refl = lowpass(sig, 0.35 + 0.1 * i)
        for j in range(n - off):
            out[j + off] += refl[j] * g * 0.34
        delay += spread_ms / 1000.0 * rnd.uniform(0.7, 1.3)
    return out


def room_tail(sig, sr=SR, ms=260, decay=3.2, seed=37, hp=0.25):
    """
    混响尾巴 —— 声音「消散在空间里」的那一段。

    这是「高级感」最直接的来源：真实物理事件里，
    声音总是比视觉动作**多留一会儿**。动画 200ms 就结束了，
    但撞击的余韵还在房间墙上反射几百毫秒。

    做法：把声音本身当作激励，过一遍近似指数的衰减噪声卷积。
    比真正做卷积混响便宜得多，听感上足够。
    """
    rnd = random.Random(seed)
    n_tail = int(sr * ms / 1000.0)
    if n_tail <= 0:
        return list(sig)
    n = len(sig)
    total = n + n_tail
    out = [0.0] * total

    # 尾巴：从原信号尾端抽一段做激励源，避免尾巴是「凭空的噪声」
    tap_len = min(n, int(sr * 0.05))
    src = sig[n - tap_len:] if tap_len > 0 else [1.0]

    for j in range(n_tail):
        t = j / n_tail
        # 指数衰减
        g = math.exp(-decay * t)
        # 每 3~9ms 抽一个「反射颗粒」
        k = rnd.randrange(tap_len)
        out[n + j] += src[k] * g * 0.45
    # 尾巴要闷（高频先衰减完）
    tail = lowpass(out[n:], 0.22)
    # 去掉低频嗡鸣，避免尾巴听起来像「隆隆」
    tail = highpass(tail, hp)
    for j in range(n_tail):
        out[n + j] = tail[j]
    # 直达声原样保留
    for j in range(n):
        out[j] = sig[j]
    return out


def sharpen_transient(sig, sr=SR, ms=1.2, boost=1.0):
    """
    锐化瞬态 —— 起音那一下要「扎」。

    实测参考：锐利的瞬态听起来「近」，柔化的瞬态听起来「远」。
    合成音效常见毛病是起音太软（我原来用 1.5~4ms），
    听起来像「呼」而不是「啪」。

    做法：找出起音位置，在极短窗口内加一层高频脉冲。
    """
    n = len(sig)
    k = max(1, int(sr * ms / 1000.0))
    if k >= n:
        return list(sig)
    out = list(sig)
    # 找能量最大点作为起音位置。
    # ★ 搜索范围必须够宽：原本只看前 20ms，但空间化（反射+尾巴）
    #   会把包络峰值推后 —— 实测轮盘停稳的峰值被推到 31.7ms，
    #   超出搜索窗口，于是「末道瞬态」完全没生效（改了却没变化）。
    #   现在搜到 80ms，覆盖空间处理后的位移。
    search_win = min(n, int(sr * 0.08))
    peak = 0
    best = -1
    for i in range(search_win):
        if abs(sig[i]) > best:
            best = abs(sig[i]); peak = i
    if best <= 1e-9:
        return out
    # 在起音处叠一层衰减极快的高频
    for j in range(k):
        if peak + j >= n: break
        env = math.exp(-6.5 * j / k)
        # 高频脉冲用交替符号模拟（近似宽带）
        pulse = (1.0 if j % 2 == 0 else -1.0) * env * boost * best
        out[peak + j] += pulse * 0.5
    # ★★ 锐化**不能顺手把峰值放大**（2026-10-28 实测出来的）。
    #
    #   上面那层脉冲是**加**在信号上的，幅度还是按峰值 best 算的，
    #   于是锐化后峰值本身就涨了 1.5 倍；而 spatialize 里会锐化**两次**
    #   （本体一次、空间处理后补一次 boost=1.4），累计放大到约 2.5 倍。
    #
    #   对"起音就是全部"的短音（tap / 骰子落定）没问题；
    #   但对**重击型**（扣盅、开盅）是灾难：它们的分量来自 150ms 的低频体，
    #   峰值被凭空抬高 8 dB 之后，loudness_normalize 为了不削顶只能整体缩下去
    #   —— 实测扣盅半峰样本从 523 掉到 4（= 峰值成了一根 0.18ms 的针），
    #   前 50ms RMS 从 0.3 掉到 −15.7，听感就是"啪一下，很轻"。
    #
    #   锐化真正起作用的机制是**起音变陡**（能量更集中在头 1ms），
    #   不是"更响"。所以允许峰值最多涨 15%（保留那点"扎"），其余压回来。
    after = max((abs(x) for x in out), default=0.0)
    cap = best * 1.15
    if after > cap > 0:
        kk = cap / after
        out = [x * kk for x in out]
    return out


def air_layer(sig, sr=SR, mix=0.16, seed=53):
    """
    空气层 —— 极轻的高频「沙」，给声音一点「在场感」。
    只在起音附近，太长会变成噪声。
    """
    n = len(sig)
    k = min(n, int(sr * 0.05))
    if k <= 0:
        return list(sig)
    out = list(sig)
    a = highpass(noise(k, seed), 0.62)
    for j in range(k):
        env = math.exp(-4.0 * j / k)
        out[j] += a[j] * env * mix
    return out


def spatialize(sig, sr=SR, reflections=True, tail_ms=220, transient=True,
               seed=11, final_sharpen=True):
    """
    一站式「空间化」：瞬态 → 反射 → 尾巴 → **再锐化一次**。

    顺序有讲究：
      ① 先锐化起音（声音的「本体」）
      ② 叠反射（空间）
      ③ 加尾巴（消散）
      ④ **最后再锐化一次** —— 这一步是实测补上的：
         反射和尾巴会抬高信号的"平均电平"，把包络峰值往后推，
         实测轮盘停稳的起音被拖到 31.7ms（听起来是"呼"不是"咔"）。
         在最后补一道瞬态，能把峰值重新拉回前几毫秒。
    """
    out = list(sig)
    if transient:
        out = sharpen_transient(out, sr)
    if reflections:
        out = early_reflections(out, sr, seed=seed)
    if tail_ms and tail_ms > 0:
        out = room_tail(out, sr, ms=tail_ms, seed=seed + 7)
    if transient and final_sharpen:
        # 末道瞬态：把被空间处理拖慢的起音重新拉回来
        #
        # ⚠️ 但**重击型音效必须关掉它**（cup-slam / reveal-hit，2026-10-28 实测）。
        #   这一道的用途是"起音被反射和尾巴推后了，把它拉回来"——
        #   它假设能量主要在起音那一下（转盘停稳、骰子落定）。
        #   而重击型的分量在 150ms 的低频体里：再叠一道瞬态，峰值又被抬高，
        #   归一化只能整体缩下去，**体被压成一根针**。
        #   实测扣盅：半峰样本 161 → 4，前 50ms RMS 反而掉了 3.3 dB。
        out = sharpen_transient(out, sr, ms=1.6, boost=1.4)
    return out


def remove_dc(sig):
    """
    去掉直流偏置（一阶高通，20Hz 截止）。

    ★ 为什么必须做：
      直流偏置是整个信号的平均值不为 0。带偏置的音频播放时，
      喇叭要做"多推/多拉一下"的位移去平衡这段偏移 ——
      听感上就是**开头"噗"的一下低频冲击**，非常廉价。
      高通滤波让信号从 0 开始、以 0 结束，不存在这种位移。

    实测（修复前）：9 个音效直流偏置超标，最重 countdown-urgent
    达 1.53% 满量程 —— 一开机就是一声闷响。

    为什么放在 write_wav 里统一做：
      合成时叠加噪声/正弦的过程中很容易累积偏置（尤其低通滤波之后），
      逐个函数去修必然遗漏。**在最后出口统一阻断**是唯一可靠的做法。
    """
    if not sig:
        return sig
    n = len(sig)
    # ① 减均值：让直流**严格为 0**（零延迟、零残留）。
    #    只靠高通是不够的 —— 高通有建立时间，
    #    实测 110ms 的短音效里还会残留一大片低频台阶（DC 仍有 0.51% 满量程）。
    mean = sum(sig) / n
    sig = [x - mean for x in sig]
    # ② 一阶高通：去掉极低频的"台阶感"，让包络真正回到 0
    #    y[n] = x[n] - x[n-1] + a*y[n-1]，a ≈ 0.9945 对应 20Hz@22.05k
    a = 0.9945
    y = [0.0] * n
    prev_x = 0.0
    prev_y = 0.0
    for i, x in enumerate(sig):
        cur = x - prev_x + a * prev_y
        y[i] = cur
        prev_x = x
        prev_y = cur
    # 高通会压低整体电平，重新定标回原来的峰值，避免"变轻"
    m0 = max((abs(v) for v in sig), default=0.0)
    m1 = max((abs(v) for v in y), default=0.0)
    if m0 > 1e-9 and m1 > 1e-9:
        k = m0 / m1
        y = [v * k for v in y]
    return y


def _transient_peaks(sig, win_ms=10, top_n=3):
    """
    取「撞击峰值」：按 10ms 分窗，收集各窗峰值，返回最高的几个。

    用来判断「零散撞击型」音效的**单次撞击**够不够响 ——
    这类音效整体 RMS 天然偏低（大部分时间是静音），
    只看 RMS 会误判成"本来就轻、不能动"。
    """
    win = max(1, int(SR * win_ms / 1000))
    peaks = []
    for i in range(0, len(sig) - win, win):
        peaks.append(max(abs(x) for x in sig[i:i + win]))
    if not peaks:
        return []
    peaks.sort(reverse=True)
    return peaks[:top_n]


def loudness_normalize(sig, peak_ceiling=0.965, target_rms=0.16, transient_peak=0.55):
    """
    ★ 响度归一化：**尽量推到目标响度，但不削顶**。

    ============ 为什么不能只用峰值定标 ============
    原来的 `normalize(peak=0.92)` 只管峰值。但实测发现 19 个音效的
    峰均比高达 1000~1800（能量全压在极短的瞬态上），
    结果是**峰值 92% 而 RMS 只有峰值的 1%~3%**。

    在游戏里音效是混着播的（摇盅声 + 扣盅声 + 背景），
    RMS 这么低 = "听着很薄、很轻、被盖过" —— 这是廉价感的一大来源。

    ============ 为什么不能只用 RMS 定标 ============
    直接把 RMS 拉到固定目标值，多数音效会**削顶**（超过满量程）→ 严重失真。

    ============ 所以是"能推多高推多高" ============
      ① 按目标响度放大
      ② 如果峰值超了 ceiling（会有削顶失真），**按峰值回退**
      ③ 回退后的实际响度 = min(目标响度, 不削顶所能达到的最大响度)

    效果：
      · 峰值有余量的短促音效（dice-into-cup / tap-soft 这类）
        → 被推到接近满量程，响度显著提升且不失真
      · 已经是高密度的长音效（cup-settle 这类）
        → 保持原样，不会因为硬推而失真

    之前留 0.92 的"安全余量"也是浪费：短音效的峰值本来就远低于满量程，
    留那么多余量等于白白让它变轻。现在放宽到 0.97。

    ⚠️ 0.97 → **0.965（=−0.31 dBFS）**：0.97 对应 −0.26 dBFS，
      比"峰值 ≤ −0.3 dBFS"的验收线还高 0.04 dB（lib 侧任何后处理都会越界）。
       0.965 正好落在 −0.31，留出这条线。全表因此整体降 0.045 dB —— 听不出来。
    """
    if not sig:
        return sig
    rms = math.sqrt(sum(x * x for x in sig) / len(sig))
    if rms < 1e-9:
        return sig
    # ★ 只提升、不下调 —— 归一化最容易踩的坑
    #   第一版是「把 RMS 拉到固定目标」，结果 tick 原始 RMS 0.16
    #   已经高于我定的 0.085，公式算出 k=0.53 → **反而被调小一半**，
    #   峰值从 50% 掉到 26%，音效变轻了。
    #   归一化只能向上：本来就够响的一律不动。
    if rms >= target_rms:
        # ★ 整体 RMS 够响**不代表听得清**。
        #   有一类音效是「零散几声撞击」——入盅的几声脆响、骰子在桌上滚两下。
        #   它们大部分时间是静音，整体 RMS 天然就低（这是对的），
        #   但如果**撞击本身**的峰值也很低，就会"听着很轻、很薄"，
        #   混播时完全被盖过。
        #   实测：dice-into-cup 的 RMS 有 1.6%（并不低），
        #   但单次撞击峰值只有 28% —— 光看 RMS 会误判成"本来就轻"。
        #
        #   所以对这类音效补一道：**按撞击峰值定标**（分窗峰值近似）。
        hits = _transient_peaks(sig)
        if hits and max(hits) < transient_peak:
            k = transient_peak / max(hits)
            if max(abs(x) for x in sig) * k <= peak_ceiling:
                sig = [x * k for x in sig]
        # ★★ 这条分支原来**完全不看峰值** —— 它在 2026-10-28 重做扣盅时炸过：
        #   它默认"RMS 已经够响的音效，峰值一定没超 ceiling"，理由是原来的
        #   音效要么是零散撞击（峰值高、RMS 低），要么是稳态旋律（峰值低）。
        #   但"叠大量低频能量体"的重击型**两条都不属于**：原始峰值 1.9、
        #   原始 RMS 也超过 target —— 于是它原样返回，quantize 的钳位把
        #   峰值削平成一条直线（实测 f50 从 −12 变成 −5.6，听着是"破音"
        #   而不是"重"）。
        #   → 峰值上限必须在这条分支也执行。ceiling 是**契约**，不是某个分支的优化。
        pk = max(abs(x) for x in sig)
        if pk > peak_ceiling:
            sig = [x * (peak_ceiling / pk) for x in sig]
        return sig
    scaled = [x * (target_rms / rms) for x in sig]
    pk = max(abs(x) for x in scaled)
    if pk > peak_ceiling:
        # 推上去会削顶 → 回退到刚好不超 ceiling（宁可轻一点也不失真）
        scaled = [x * (peak_ceiling / pk) for x in scaled]
    return scaled


def quantize(sig):
    """
    浮点 → int16，**并在整数域去直流**。

    ★ 这里有个必须踩过一次的坑（数字音频的经典陷阱）：
      浮点域已经把直流去干净了，但 `int(v * 32767)` 是**向零截断**，
      它给每个样本引入约 -0.5 LSB 的系统性偏置。
      实测：浮点 DC 只有 -0.009（可忽略），转成 int16 后 DC 变成 **-306**，
      占满量程 0.94% —— 喇叭照样要"多推一下去平衡"，听感上就是开头"噗"的一声。

      **四舍五入也救不了**：实测 `round()` 和 `int()` 得到的 DC 完全一样
      （因为偏置来自量化的非线性，不是舍入方向）。

      唯一可靠的办法：**量化之后再减一次整数均值**。
      这必须在 int 域做（浮点域减均值对已经量化好的整数没有意义）。
    """
    ints = [max(-32768, min(32767, int(v * 32767))) for v in sig]
    if not ints:
        return ints
    dc = int(round(sum(ints) / len(ints)))
    if dc:
        ints = [max(-32768, min(32767, x - dc)) for x in ints]
    return ints


def write_wav(name, sig, out_sr=None):
    """写 WAV。out_sr 给定时先降采样 —— 体积 = 采样率 × 时长，降一半省一半。"""
    os.makedirs(OUT_DIR, exist_ok=True)
    path = os.path.join(OUT_DIR, name + '.wav')
    if out_sr and out_sr < SR:
        sig, sr_use = resample(sig, SR, out_sr)
    else:
        sr_use = SR
    # ★ 顺序很重要：先响度定标 → 混音对齐 → 去直流 → 淡入淡出 → **量化**
    #   ① 响度要在最前：它决定整体电平，后面的高通会削掉一部分，
    #      所以要在削之前就定到目标响度
    #   ② ★★ 混音对齐必须**在 loudness_normalize 之后**：
    #      loudness_normalize 的逻辑是"只提升不下调"，如果先降后归一，
    #      会被它原样推回去（实测 charge-up 降到 -17 后又回到 -9.6）。
    #      这个 bug 的特征很隐蔽：**中间态测量是对的，落盘的文件是错的** ——
    #      所以验证必须测最终 wav，不能只看函数返回值。
    #   ③ 量化必须最后：整数域去均值只能在 int16 上做
    sig = loudness_normalize(sig)
    if name in LOUDNESS_FIX:
        sig = match_short_term(sig, LOUDNESS_FIX[name], sr_use)
    sig = remove_dc(sig)
    sig = fade_edges(sig)
    # ★ 收尾再钳一次峰值（2026-10-28）。
    #   remove_dc 是**整段平移**（减去均值），它会把正负两端的绝对峰值拉开 ——
    #   一段均值偏负的信号在去直流之后，正峰可能被顶到 ceiling 之上。
    #   实测 dice-tumble-wood 就是这样越界到 −0.23 dBFS（线是 −0.3）。
    #   缩 0.7% 听不出来，但"绝不削顶"是契约，必须在落盘前保证。
    pk = max((abs(x) for x in sig), default=0.0)
    if pk > 0.96:
        sig = [x * (0.96 / pk) for x in sig]
    ints = quantize(sig)
    with wave.open(path, 'w') as w:
        w.setnchannels(1)
        w.setsampwidth(2)
        w.setframerate(sr_use)
        w.writeframes(b''.join(struct.pack('<h', v) for v in ints))
    print(f'  ✓ {name+".wav":<22} {os.path.getsize(path)/1024:>6.1f} KB  '
          f'{len(sig)/sr_use:.2f}s  {sr_use}Hz')


# ============================================================
# 骰子组
# ============================================================

def dice_hit(strength=1.0, seed=1):
    """单次碰撞：塑料骰子撞木桌。"""
    n = int(SR * 0.055)
    # ★ 2026-11-02「线下面对面」：噪声层从 1930~2988Hz 推到 2526~3335Hz。
    #   原来的频段有一半压在 2000Hz 以下 —— 那是人声区，会被一桌人聊天掩蔽。
    #   实测 dice-on-table 的人声段比穿透段高 15.6 dB（判据上限 12）。
    #   骰子的"塑料撞木桌"本来就有大量 3kHz 附近的成分，往上推不会变得不自然。
    base = lowpass(highpass(noise(n, seed), 0.72), 0.95)
    e = env_ad(n, int(SR * 0.0012), SR * 0.010)
    sig = [base[i] * e[i] * strength for i in range(n)]
    thump = sine(n, 180, phase=0.3)
    te = env_decay(n, SR * 0.006)
    return [sig[i] + thump[i] * te[i] * 0.35 * strength for i in range(n)]


def dice_shake(seconds=1.2, seed=7, density=1.0):
    """摇动：多次不规则碰撞 + 低频滚动。

    注意累加方式：用 in-place 叠加而不是每次重建整个列表 ——
    重建是 O(n²)，1.2 秒的音效在纯 Python 里要跑十几秒。
    """
    total = int(SR * seconds)
    rnd = random.Random(seed)
    out = [0.0] * total
    t, i = 0, 0
    while t < total:
        gap = int(SR * rnd.uniform(0.028, 0.075) / density)
        strength = 0.35 + 0.65 * (1 - t / total)
        hit = dice_hit(strength, seed=seed + i)
        for j, v in enumerate(hit):
            if t + j < total:
                out[t + j] += v
        t += max(1, gap)
        i += 1
    roll = lowpass(noise(total, seed + 99), 0.06)
    re_ = [1.0 - 0.5 * (k / total) for k in range(total)]
    return [out[k] + roll[k] * 0.30 * re_[k] for k in range(total)]


def dice_roll():
    """滚动：骰子在桌面滚动的摩擦声（比 shake 更连续、更低频）。"""
    n = int(SR * 0.7)
    base = lowpass(noise(n, 31), 0.12)
    e = [math.sin(math.pi * i / n) ** 0.6 for i in range(n)]  # 中间最响
    out = [base[i] * e[i] * 0.55 for i in range(n)]
    # 叠几个间隔越来越长的碰撞，模拟"越滚越慢"
    t, k = int(SR * 0.05), 0
    while t < n:
        hit = dice_hit(0.5 - k * 0.05, seed=200 + k)
        for j, v in enumerate(hit):
            if t + j < n:
                out[t + j] += v
        t += int(SR * (0.09 + k * 0.045))
        k += 1
    return out


def dice_settle():
    """
    落定：骰子停下的"定音"。

    重写过一次。原来是一根 660Hz 纯正弦 + 3ms 起音，实测起音 21ms ——
    听起来是"哔"而不是"嗒"，这是"廉价感"的直接来源。

    问题在于：**纯正弦没有宽带成分**。
    真实的撞击声之所以"扎"，是因为它有极短的宽带瞬态（木质碰撞的
    "咔"来自 1~3ms 内跨越很宽频率的能量爆发）。

    现在：宽带噪声做瞬态（0.5ms 起音）+ 木质腔体做音色 + 低频垫重量。
    """
    n = int(SR * 0.20)
    # ① 宽带瞬态：这是"扎"的来源，起音压到 0.5ms
    click = lowpass(noise(n, 42), 0.72)
    ce = env_ad(n, max(1, int(SR * 0.0005)), SR * 0.006)
    # ② 木质腔体：低频为主（木头的音色在中低频，不是 660Hz 那种"铃"）
    body = sine(n, 320)
    body2 = sine(n, 470)          # 非整数倍 → 木头的钝感
    be = env_ad(n, int(SR * 0.001), SR * 0.038)
    # ③ 低频垫一点重量
    thud = lowpass(noise(n, 43), 0.05)
    te = env_decay(n, SR * 0.018)

    out = [click[i] * ce[i] * 0.95
           + (body[i] * 0.6 + body2[i] * 0.35) * be[i] * 0.7
           + thud[i] * te[i] * 0.5
           for i in range(n)]
    return out


def dice_open():
    """开盅：揭晓，明亮上扬 + 气声起手。"""
    n = int(SR * 0.42)
    a, b = sine(n, 523.25), sine(n, 783.99)
    e = env_ad(n, int(SR * 0.004), SR * 0.10)
    tone = [(a[i] * 0.6 + b[i] * 0.4) * e[i] for i in range(n)]
    nn = int(SR * 0.05)
    air = highpass(noise(nn, 5), 0.7)
    ae = env_decay(nn, SR * 0.012)
    air = [air[i] * ae[i] * 0.28 for i in range(nn)]
    return mix(place(air, 0, n), tone)


def dice_land_fanfare():
    """骰子落定后的"揭晓感"——三音上行琶音。

    参数调过一轮：原来 step=0.07s 太密，三个音挤在一起，
    最后一段的主频被前两个音的余音盖住（实测第 2、3 段都测出 656Hz）。
    现在拉长到 0.11s、并让每个音只保留 0.22s 主体，让三个音听得清是"上行"。
    """
    notes = [392.00, 523.25, 659.25]  # G4 C5 E5
    step = int(SR * 0.11)
    note_len = int(SR * 0.22)
    total = step * (len(notes) - 1) + note_len
    out = [0.0] * total
    for i, f in enumerate(notes):
        s = sine(note_len, f)
        e = env_ad(note_len, int(SR * 0.005), SR * 0.07)
        off = step * i
        for j in range(note_len):
            if off + j < total:
                out[off + j] += s[j] * e[j] * 0.6
    return out


# ============================================================
# 转盘组
# ============================================================

def tick(pitch=1.0):
    """咔哒：指针划过格子。极短是关键。"""
    n = int(SR * 0.018)
    sq = square(n, 1400 * pitch)
    e = env_ad(n, int(SR * 0.0004), SR * 0.0035)
    return [sq[i] * e[i] * 0.5 for i in range(n)]


def wheel_start():
    """转盘启动：一个上滑的"嗡"。"""
    n = int(SR * 0.30)
    s = sine_sweep(n, 180, 420)
    e = env_ad(n, int(SR * 0.02), SR * 0.16)
    return [s[i] * e[i] * 0.6 for i in range(n)]


def wheel_spin_loop():
    """转盘持续旋转：低频嗡鸣，可循环播放。"""
    n = int(SR * 1.0)
    base = lowpass(noise(n, 77), 0.05)
    hum = sine(n, 92)
    # 首尾对齐（整数周期）避免循环时的接缝爆音
    cycles = round(92 * n / SR)
    hum = sine(n, cycles * SR / n)
    out = [base[i] * 0.25 + hum[i] * 0.22 for i in range(n)]
    return out


# wheel-slow（转盘慢转）已于 2026-10-28 删除：全仓零引用的死音效，
# 34KB 白占体积。若以后转盘玩法需要"转盘慢下来"的过程音，
# 重新写这里并把文件加进 ALL_V3 与 sfx.js 的 FILES 清单。

def wheel_stop():
    """
    停稳：一声清亮的"叮"。

    ★★★ 2026-11-02「线下面对面」重写。
    原来只有 880 + 1320Hz 两根**纯正弦** —— 两个频率都落在人声频段
    (200~2000Hz)，实测 2~5kHz 比人声段低 **37.5 dB**。

    也就是说：这个"转盘停稳"最关键的一下，**在酒桌上被一聊天就没了**。
    （电脑/耳机上听得好好的，所以一直没发现。）

    真实的铃/钟有**非整数倍**泛音（2.76x / 5.40x / 8.93x 是钟形体的经典比例），
    补上它们有两个好处：
      · 音色从"电子音"变成"金属铃"
      · 2.76x 和 5.40x 正好落在 2~5kHz 的穿透段
    """
    n = int(SR * 0.5)
    # 基频 880 + 泛音：倍数, 相对音量
    PARTS = [(1.00, 0.62), (1.50, 0.22), (2.76, 0.30), (5.40, 0.13)]
    buf = [0.0] * n
    for mult, amp in PARTS:
        # 高次泛音衰减更快（真实敲击里高频先消失）
        tau = SR * (0.13 if mult <= 1.5 else 0.075)
        env = env_ad(n, int(SR * 0.003), tau)
        tone = sine(n, 880 * mult)
        for i in range(n):
            buf[i] += tone[i] * env[i] * amp
    pk = max(1e-9, max(abs(x) for x in buf))
    return [x / pk * 0.92 for x in buf]


# ============================================================
# 情绪音（酒桌游戏的核心）
# ============================================================

def win():
    """赢了：四音上行琶音（大调）。"""
    notes = [523.25, 659.25, 783.99, 1046.50]
    step = int(SR * 0.09)
    total = step * (len(notes) - 1) + int(SR * 0.30)
    out = [0.0] * total
    for i, f in enumerate(notes):
        n = int(SR * (0.30 if i == len(notes) - 1 else 0.16))
        s = sine(n, f)
        e = env_ad(n, int(SR * 0.006), SR * (0.10 if i == len(notes) - 1 else 0.05))
        off = step * i
        for j in range(n):
            if off + j < total:
                out[off + j] += s[j] * e[j]
    return out


def lose():
    """输了：下行两音（小调，遗憾但不刺耳）。"""
    n1 = int(SR * 0.20)
    a = sine(n1, 440.0)
    e1 = env_ad(n1, int(SR * 0.006), SR * 0.07)
    p1 = [a[i] * e1[i] for i in range(n1)]
    n2 = int(SR * 0.38)
    b = sine(n2, 311.13)     # 降E，小调色彩
    e2 = env_ad(n2, int(SR * 0.006), SR * 0.13)
    p2 = [b[i] * e2[i] for i in range(n2)]
    return concat(p1, p2)


def drink():
    """喝一杯：和 lose 同族，但更"认命"一点（更长、更低）。"""
    n1 = int(SR * 0.24)
    a = sine(n1, 392.0)
    e1 = env_ad(n1, int(SR * 0.008), SR * 0.09)
    p1 = [a[i] * e1[i] for i in range(n1)]
    n2 = int(SR * 0.46)
    b = sine(n2, 261.63)
    e2 = env_ad(n2, int(SR * 0.008), SR * 0.16)
    p2 = [b[i] * e2[i] for i in range(n2)]
    return concat(p1, p2)


def clink():
    """碰杯：玻璃感 —— 两个高频正弦 + 快速衰减 + 一点噪声起手。"""
    n = int(SR * 0.45)
    a, b, c = sine(n, 2100), sine(n, 3170), sine(n, 4400)
    e = env_ad(n, int(SR * 0.0008), SR * 0.055)
    tone = [(a[i] * 0.5 + b[i] * 0.3 + c[i] * 0.2) * e[i] for i in range(n)]
    nn = int(SR * 0.008)
    tickn = [highpass(noise(nn, 9), 0.8)[i] * env_decay(nn, SR * 0.002)[i] * 0.4 for i in range(nn)]
    return mix(place(tickn, 0, n), tone)


def pour():
    """倒酒：液体注入的"咕嘟" —— 用扫频 + 带通噪声。"""
    n = int(SR * 1.1)
    gurgle = sine_sweep(n, 240, 420)
    e = [math.sin(math.pi * i / n) ** 0.8 for i in range(n)]
    body = [gurgle[i] * e[i] * 0.5 for i in range(n)]
    liq = bandpass(noise(n, 55), 0.10, 0.45)
    # 液体声有起伏（不是平稳噪声）
    ripple = [0.6 + 0.4 * math.sin(2 * math.pi * 7 * i / SR) for i in range(n)]
    liq = [liq[i] * e[i] * ripple[i] * 0.5 for i in range(n)]
    return mix(body, liq)


def suspense():
    """悬念：低音渐强，用在揭晓前。"""
    n = int(SR * 0.9)
    base = sine(n, 110)
    fifth = sine(n, 165)
    rise = [(i / n) ** 1.5 for i in range(n)]
    return [(base[i] * 0.5 + fifth[i] * 0.3) * rise[i] for i in range(n)]


def reveal():
    """揭晓：一记明亮的"当"（比 win 短，用作强调）。"""
    n = int(SR * 0.6)
    a, b = sine(n, 1046.50), sine(n, 1567.98)
    e = env_ad(n, int(SR * 0.002), SR * 0.14)
    return [(a[i] * 0.6 + b[i] * 0.4) * e[i] for i in range(n)]


def whoosh():
    """过场：快速扫过的风声，用于页面切换/翻牌。"""
    n = int(SR * 0.35)
    base = highpass(noise(n, 13), 0.25)
    e = [math.sin(math.pi * i / n) ** 1.2 for i in range(n)]
    sweep = lowpass(base, 0.3)
    return [sweep[i] * e[i] * 0.7 for i in range(n)]


# ============================================================
# 通用 UI 音
# ============================================================

def click(n, hp=0.28, lp=0.95, thump=0.18, thump_f=170):
    """
    真实敲击声的物理模型 —— **这是「声音一般」的根治**（2026-11-02）。

    ============ 为什么原来的不行 ============

    原来 tap / tap_soft 是 `sine(n, 880)` / `sine(n, 660)` —— **纯正弦波**。
    纯正弦只有一个频率成分，听感就是「滴」的电子音（beep）。

    实测能量分布：95.9% 挤在 500~2000Hz，**2000Hz 以上只有 0.4%**。
    而人耳对 3~5kHz 最敏感（等响曲线），"清脆"这个感觉完全来自高频。

    → **没有高频 = 听起来闷、廉价、像玩具。** 这是物理原因，不是调音量能解决的。

    ============ 真实敲击声由三部分组成 ============

    ① **噪声瞬态**（1~3ms）：宽带噪声，这是"咔"的来源。
       纯音永远做不出"咔"，因为它没有随机性。
    ② **带通滤波**：把噪声限制在 2~6kHz —— 人耳最敏感的"脆"频段。
       砍掉 2kHz 以下（那是"闷"），砍掉最尖的（那是"刺"）。
    ③ **低频共振**（可选）：一声很轻的 170Hz 短衰减，给"嗒"一个实体感。
       没有它，纯高频听起来像"塑料片"，不像"敲在东西上"。

    ============ 参数 ============

    hp / lp 是滤波器的 alpha 系数（不是频率）：
        fc ≈ alpha × sr / (2π)   → 0.28 ≈ 2kHz，0.95 ≈ 6.7kHz
    thump 是低频共振的相对量（0 = 只要高频，像敲玻璃）。
    """
    nz = bandpass(noise(n, seed=hash((hp, lp)) & 0xffff), lp, hp)
    peak = max(1e-9, max(abs(x) for x in nz))
    nz = [x / peak for x in nz]

    """瞬态包络：攻击 0.5ms（几乎瞬时）+ 指数衰减 ~9ms。
       起音必须比人耳的分辨极限还短，否则听起来是"嘶"不是"咔"。"""
    e = env_ad(n, max(1, int(SR * 0.0005)), SR * 0.009)

    body = sine(n, thump_f) if thump > 0 else [0.0] * n
    be = env_ad(n, max(1, int(SR * 0.001)), SR * 0.016)

    return [nz[i] * e[i] + body[i] * thump * be[i] for i in range(n)]


def tap():
    """点的反馈。40ms，带明显的高频瞬态 —— 要"嗒"得清脆。"""
    n = int(SR * 0.040)
    s = click(n, hp=0.30, lp=0.95, thump=0.22, thump_f=185)
    return [x * 0.62 for x in s]


def tap_soft():
    """更轻的点击（37 处在用）。故意比 tap 更短更轻，但**同样要有高频** ——
    否则频繁点起来会听到一片"嘟嘟"的闷响。"""
    n = int(SR * 0.030)
    s = click(n, hp=0.34, lp=0.92, thump=0.12, thump_f=200)
    # ⚠️ 这里的音量**不决定最终响度** —— write_wav 里的 loudness_normalize
    #    只提升不下调，会把系数吃掉。要更轻只能改 LOUDNESS_FIX 表。
    return [x * 0.40 for x in s]


def toggle_on():
    """
    开关拨到 ON（2026-11-02 重做）。

    原来是 `sine_sweep(520→880)` —— **纯扫频正弦 = 电子蜂鸣**。
    而真实开关的声音是**塑料/金属拨片咔一下**：极短的宽带瞬态 + 一点点机身共鸣。

    实测改前：2kHz 以上能量 0%，频谱质心 664Hz（闷）。
    """
    n = int(SR * 0.075)
    # 主体：开关的"咔"（带通到 1.6~6kHz）
    body = click(n, hp=0.23, lp=0.95, thump=0.30, thump_f=150)
    # 收尾：一声很轻的上扬（拨到位的感觉），量只有主体的 18%
    tail = [sine(n, 760)[i] * math.exp(-i / (SR * 0.020)) * 0.18 for i in range(n)]
    return [body[i] + tail[i] for i in range(n)]


def toggle_off():
    """开关拨到 OFF：同形状但尾音下沉（760 → 520），方向感是"关"。"""
    n = int(SR * 0.075)
    body = click(n, hp=0.23, lp=0.95, thump=0.30, thump_f=140)
    tail = [sine(n, 520)[i] * math.exp(-i / (SR * 0.020)) * 0.18 for i in range(n)]
    return [body[i] + tail[i] for i in range(n)]


def _harmonic(n, f0, parts=(1.0, 0.32, 0.13)):
    """
    带谐波的单音（2026-11-02）。

    ★ 为什么不能用纯正弦：纯正弦只有一个频率成分，人耳立刻判为"电子音"。
      真实的"嘀"（电子表/微波炉/木鱼）都有 2~3 个泛音 ——
      这是"贵"和"廉价"的分界，不是音色偏好。
    """
    out = [0.0] * n
    for k, amp in enumerate(parts, start=1):
        s = sine(n, f0 * k)
        for i in range(n):
            out[i] += s[i] * amp
    pk = max(1e-9, max(abs(x) for x in out))
    return [x / pk for x in out]


def countdown():
    """倒计时读秒：一声短促的"嘀"，带泛音所以不刺耳也不电子。"""
    n = int(SR * 0.09)
    s = _harmonic(n, 1200)
    e = env_ad(n, int(SR * 0.001), SR * 0.02)
    return [s[i] * e[i] * 0.5 for i in range(n)]


def countdown_go():
    """倒计时结束：更高的"嘀"，泛音更足（听感更"厚"、更有落点）。"""
    n = int(SR * 0.22)
    s = _harmonic(n, 1800, parts=(1.0, 0.40, 0.18, 0.07))
    e = env_ad(n, int(SR * 0.001), SR * 0.06)
    return [s[i] * e[i] * 0.6 for i in range(n)]
# _sp 包装器必须定义在 ALL / ALL_V3 之前（它们引用它）
def _sp(fn, tail_ms=220, seed=11, final_sharpen=True):
    """把合成函数包一层空间化（保持采样率契约不变）"""
    def wrapped():
        return spatialize(fn(), SR, tail_ms=tail_ms, seed=seed,
                          final_sharpen=final_sharpen)
    return wrapped




# ============================================================

ALL = [
    # (文件名, 生成函数, 输出采样率)
    # 采样率按各自最高有效频率定 —— 脆响/噪声用 HI，纯低频用 LO
    # 骰子
    ('dice-settle',  _sp(dice_settle, tail_ms=180, seed=45), SR_MID),
    # 转盘
    ('tick',         lambda: tick(),          SR_HI),  # 机械咔哒，极高频
    ('wheel-start',  wheel_start,             SR_LO),  # 扫频 180→420Hz
    # wheel-slow 从 SR_HI 降到 SR_MID：实测高频能量比只有 0.563（tick 才有 0.509 但它只有 18ms），
    # 这一串咔哒的本体是中频撞击，降采样率听感无损、体积减半（原 68.9 KB → 约 34 KB）
    ('wheel-stop',   _sp(wheel_stop, tail_ms=240, seed=49), SR_HI),   # 2026-11-02：2~5kHz 泛音要 22050 才存得下
    # 情绪
    ('drink',        drink,                   SR_LO),  # 最高 392Hz
    ('whoosh',       whoosh,                  SR_MID), # 风声，中高频
    # UI
    # ★ 2026-11-02：采样率从 SR_MID(11025) / SR_LO(8000) 提到 SR_HI(22050)。
    #
    # 这是「声音一般」的**第二个物理原因**：
    #   SR_LO = 8000Hz → Nyquist 只有 4000Hz → 根本存不下 2~6kHz 的高频
    # 所以不管怎么调合成公式，这两个音都不可能有"清脆"的成分。
    # 实测它们 2000Hz 以上的能量是 0.4%（tap-soft）/ 0.1%（countdown-go）。
    #
    # 提到 22050Hz 后 Nyquist = 11kHz，2~6kHz 的脆响频段完全够。
    # 代价：文件从 0.5KB 涨到约 2KB —— 这两个加起来不到 5KB，可以忽略。
    ('tap',          tap,                     SR_HI),
    ('tap-soft',     tap_soft,                SR_HI),
    # ★ toggle 也走 22050：它的"咔"主体是宽带瞬态，11025 的 Nyquist(5.5k)
    #   会把最脆的那一段切掉。
    ('toggle-on',    toggle_on,               SR_HI),
    ('toggle-off',   toggle_off,              SR_HI),
    ('countdown',    countdown,               SR_MID),
    ('countdown-go', countdown_go,            SR_MID),
]


# ============================================================
# v3 补充：腾讯工作室级音效设计
#
# 之前的音效都是"单个声音"，但商业游戏的音效是**分层**的：
# 一个事件由 2~4 层叠出来 —— 主体 + 质感层 + 低频冲击 + 空间尾音。
# 单独听每一层都很单薄，叠起来才有"分量"。
#
# 另外补几个真实游戏必备但之前漏掉的声音：
#   · 倒计时最后三秒的急促感
#   · 连击（连续成功时的音高递增）
#   · 失败的下坠感（不是简单下行两音）
#   · 揭晓前的"蓄力"（呼吸声 + 心跳）
# ============================================================

def impact_low():
    """低频冲击层：给"重"的动作垫底（骰盅砸桌、转盘停稳）。
    纯低频正弦 + 极快衰减，只有 60ms，但少了它就"没重量"。"""
    n = int(SR * 0.12)
    base = sine_sweep(n, 90, 45)
    e = env_ad(n, int(SR * 0.002), SR * 0.028)
    # 叠一点噪声做"撞击质感"
    #
    # ★ 2026-11-02：这一层原来 100% 是低频（实测手机频段 -37.8 dBFS，
    #   比低频低 17 dB）—— 而手机小扬声器 300Hz 以下几乎不响应，
    #   等于在手机上完全听不见，只剩 reveal-hit 一层撑场面。
    #   把带通从"极低通 0.08（约 280Hz）"提到 0.30（约 1kHz），
    #   让它自带手机能出的"身体"，同时保留 90→45Hz 的扫频给重量感。
    grit = lowpass(noise(n, 401), 0.08)
    ge = env_decay(n, SR * 0.012)
    # ⚠️ 试过把它改成带通（0.42/0.055）来补手机频段 —— 实测更差
    #   （phone -37.8 → -40.7）。原因：这个音效只有 120ms，
    #   而低频 base 是 120ms 的持续正弦，能量密度远高于 12ms 的噪声瞬态。
    #   它的定位就是垫底的低频层，手机上的存在感由 reveal-hit 提供。
    return [base[i] * e[i] * 0.9 + grit[i] * ge[i] * 0.35 for i in range(n)]


def shaker_metal():
    """金属骰盅摇动 —— 比木头骰子更亮、带金属共振。
    真实酒桌常用不锈钢盅，声音比骰子本身更响。"""
    total = int(SR * 1.3)
    rnd = random.Random(911)
    out = [0.0] * total
    t = 0
    # 碰撞间隔必须**大于**单次衰减时间，否则每次撞击的尾巴糊在一起，
    # 能量叠加成平缓的"呼" —— 实测这样合成出来检测到 0 个碰撞峰值，
    # 听起来完全不像在摇盅（"廉价感"的典型症状）。
    #   · 衰减 14ms → 7ms（撞击要脆，余响别拖）
    #   · 间隔 22~60ms → 28~85ms（两次撞击之间回到接近静音）
    #   · 每次响度有起伏（真实摇晃不是每下一样响）
    while t < total:
        gap = int(SR * rnd.uniform(0.028, 0.085))
        n = int(SR * 0.06)
        f = rnd.uniform(2600, 4400)
        ring = sine(n, f)
        ring2 = sine(n, f * 1.47)      # 非整数倍 → 金属的不谐和感
        e = env_ad(n, max(1, int(SR * 0.0004)), SR * 0.007)
        amp = (0.45 + 0.55 * (1 - t / total)) * rnd.uniform(0.75, 1.15)
        hit = [(ring[j] * 0.6 + ring2[j] * 0.4) * e[j] * amp for j in range(n)]
        for j, v in enumerate(hit):
            if t + j < total:
                out[t + j] += v
        t += max(1, gap)
    # 低频"盅体共鸣"（压低，别盖过撞击的颗粒感）
    body = lowpass(noise(total, 912), 0.035)
    be = [1.0 - 0.4 * (k / total) for k in range(total)]
    return [out[k] + body[k] * be[k] * 0.16 for k in range(total)]


def combo_up(step=0):
    """连击音：每次音高更高 —— 连续成功时的正反馈。
    step 0/1/2/3 对应第 1/2/3/4 连击。"""
    base_freqs = [659.25, 783.99, 987.77, 1174.66]   # E5 G5 B5 D6
    f = base_freqs[min(step, len(base_freqs) - 1)]
    n = int(SR * 0.28)
    # ★ 2026-11-02：原来只有基频 + 八度泛音（659~2350Hz），
    #   实测 2kHz 以上能量 0~30%，听起来是"电子音"。
    #   真实的乐器/铃声有 3~5 个非整数倍泛音 —— 加上之后立刻"亮"。
    a = _harmonic(n, f, parts=(1.0, 0.42, 0.22, 0.10, 0.05))
    e = env_ad(n, int(SR * 0.003), SR * 0.075)
    return [a[i] * e[i] for i in range(n)]


def fail_drop():
    """失败下坠：比 lose 更重 —— 音高快速下滑 + 低频冲击。
    不是简单的"下行两音"，而是有坠落感的连续滑音。"""
    n = int(SR * 0.65)
    drop = sine_sweep(n, 440, 110)          # 从 A4 滑到 A2
    e = env_ad(n, int(SR * 0.006), SR * 0.22)
    body = [drop[i] * e[i] * 0.8 for i in range(n)]
    # ★ 2026-11-02：纯扫频正弦下坠 = "电子警报"，没有"掉下去"的实感。
    #   加一层**逐渐变暗的噪声**（坠落时空气擦过的声音）——
    #   它是真实世界里"下坠"的听感来源，而正弦永远做不出。
    nz = noise(n, seed=77)
    nz = lowpass(highpass(nz, 0.06), 0.30)   # 带通到 400~2000Hz 的"呼"
    # 噪声包络：前段轻、中段最强（速度最快）、末段收
    ne = env_ad(n, int(SR * 0.10), SR * 0.20)
    body = [body[i] + nz[i] * ne[i] * 0.35 for i in range(n)]
    # 落地冲击（后半段）
    imp = impact_low()
    off = int(SR * 0.42)
    return mix(place(imp, off, n), body)


def charge_up():
    """蓄力：揭晓前的紧张感 —— 音高渐升 + 音量渐强 + 颤音。
    比 suspense 更有"要出事了"的压迫感。"""
    n = int(SR * 1.2)
    # ★★★ 2026-11-02「线下面对面」：原来的基频 130~260Hz、五度 195~390Hz ——
    #   **全部在 400Hz 以下**，实测穿透段比人声段低 **73.4 dB**。
    #   也就是说"开盅前的蓄力"在酒桌上根本听不见，只剩一个"什么都没发生"的等待。
    #
    #   修法不是把基频抬高（那会变成尖啸），而是：
    #     · 基频保持（那是"紧张"的物理来源，低频才压人）
    #     · **每个音都配一层八度+十二度的泛音**，让它在 2~5kHz 也有东西
    #   真实的弦乐/管乐紧张感就是这么来的 —— 基频定调，泛音定"存在感"。
    base = sine_sweep(n, 130, 260)
    fifth = sine_sweep(n, 195, 390)
    # 泛音层：跟随基频等比升高（音高渐升的感觉一致）
    oct2 = sine_sweep(n, 520, 1040)      # 两个八度
    oct3 = sine_sweep(n, 1040, 2080)     # 三个八度（进人声上沿）
    oct4 = sine_sweep(n, 2080, 3800)     # 四个八度（穿透段）
    rise = [(i / n) ** 1.8 for i in range(n)]
    # 颤音：频率 8Hz 的振幅调制，模拟紧张
    tremolo = [0.75 + 0.25 * math.sin(2 * math.pi * 8 * i / SR) for i in range(n)]
    return [(base[i] * 0.55 + fifth[i] * 0.35
             + oct2[i] * 0.12 + oct3[i] * 0.08 + oct4[i] * 0.05)
            * rise[i] * tremolo[i] for i in range(n)]


def reveal_hit():
    """揭晓重击：一记"当"+ 低频冲击 + 金属尾音。
    商业游戏里"结果出现"的那一下必须有分量。

    ★★ 2026-10-28 实测修正：它是**全场第二重**的一下，但前 50ms RMS 只有 −18.8，
    比"咽一口酒"（−15.6）和"失败下坠"（−8.3）都轻 —— 因果反了。
    和高频明亮层、金属尾音相比，它**缺一层低频体**：
    现实里"当"的那一下，胸腔是跟着震的，那部分能量在 60~120Hz 且持续 150ms 以上。
    补上之后 loudness_normalize 才有东西可推（否则峰值顶格、整体太薄，推不动）。"""
    n = int(SR * 0.85)
    # 高频明亮层
    a = sine(n, 1046.50)
    b = sine(n, 1567.98)
    e1 = env_ad(n, int(SR * 0.0015), SR * 0.16)
    # ★ 2026-11-02 手机频段补偿：0.30/0.18 → 0.62/0.40（原来低频把中频压没了）
    bright = [(a[i] * 0.62 + b[i] * 0.40) * e1[i] for i in range(n)]
    # 低频冲击
    imp = impact_low()
    # 低频体：两个非整数倍的低频叠在一起，衰减 150ms（"轰"的那一层）
    lowA = sine(n, 62)
    lowB = sine(n, 93)
    eL = env_ad(n, int(SR * 0.003), SR * 0.150)
    low = [(lowA[i] * 0.72 + lowB[i] * 0.46) * eL[i] for i in range(n)]   # 1.10/0.70 → 0.72/0.46
    # 金属尾音（不谐和泛音 → 像铜锣；90ms → 130ms 让它有余响）
    ring = sine(n, 2093)
    ring2 = sine(n, 3140)
    e2 = env_decay(n, SR * 0.130)
    metal = [(ring[i] * 0.18 + ring2[i] * 0.1) * e2[i] for i in range(n)]
    # ★★★ 2026-11-02「线下面对面」：加一层 2~4kHz 的穿透音。
    #
    #   酒桌上手机是外放的，环境噪音 60~70 dB 主要在 **200~2000Hz**（人声）。
    #   而这一声原来只有 2.1% 的能量在 2~5kHz —— 也就是说
    #   **一桌人在聊天时，"开始/揭盅"会被直接盖住**。
    #
    #   广播和地铁报站都用同一个办法：在 2~4kHz 加穿透层
    #   （人声泛音之上，掩蔽最小）。这里加的是"当"的金属光泽，
    #   音量很轻（不改变音色），但在嘈杂环境里能被听见。
    #   ⚠️ bandpass(sig, lo, hi) 的签名是 lowpass(highpass(sig, hi), lo) ——
    #      第一个参数是**低通**系数、第二个是**高通**系数，容易写反。
    #      alpha ≈ 2πf/sr：2000Hz → 0.57，3500Hz → 1.0
    pierce = bandpass(noise(n, 733), 1.0, 0.57)
    pe = env_ad(n, max(1, int(SR * 0.001)), SR * 0.055)
    ppk = max(1e-9, max(abs(x) for x in pierce))
    pierce = [x / ppk for x in pierce]

    # ★ 2026-11-02：同 cup-slam —— 过 soft_limit 才有"能量体"。
    #   实测这一声原本 92.6% 能量在 300Hz 以下（手机听不到），
    #   且整体 RMS -28.3 太薄、半峰样本只有 2（峰值是一根针）。
    #   已把 bright 提到 0.62/0.40、low 降到 0.72/0.46 做手机频段补偿。
    out = mix(bright, place(imp, 0, n), metal, low)
    # 穿透层只在起音后 80ms 内——再长就变成"嘶"了
    out = [out[i] + pierce[i] * pe[i] * 1.35 for i in range(n)]
    return soft_limit(out)


def countdown_urgent():
    """倒计时最后三秒：比普通读秒更急促、音更高。
    心理上制造"来不及了"的紧迫。"""
    n = int(SR * 0.11)
    a = sine(n, 1600)
    b = square(n, 1600, duty=0.3)
    e = env_ad(n, int(SR * 0.0006), SR * 0.018)
    return [(a[i] * 0.6 + b[i] * 0.25) * e[i] for i in range(n)]


def dice_tumble_wood():
    """木质骰子翻滚 —— 和 shaker_metal 形成质感对比。

    两者必须听感明显不同，否则"摇骰子"和"大话骰"听起来是同一个游戏：
      · 金属盅：高频正弦 + 不谐和泛音（清脆、有余响）
      · 木质骰：宽带噪声重低通 + 低频腔体共鸣（闷、短促、无余响）

    第一版只是给 dice_hit 加了道低通，结果和金属只差 400Hz，区分不出来。
    现在从合成方式上就分开：不用 dice_hit，直接用重低通的噪声做主体。
    """
    total = int(SR * 1.0)
    rnd = random.Random(313)
    out = [0.0] * total
    t = 0
    while t < total:
        gap = int(SR * rnd.uniform(0.035, 0.085))
        n = int(SR * 0.05)
        # 主体：宽带噪声**两次**低通 → 木头的"钝"撞击。
        # 单次低通不够：极短起音（1.5ms）自己就会产生高频冲击，
        # 实测谱重心仍有 2800Hz，和金属分不开。二阶低通 + 放缓起音才压得住。
        base = lowpass(lowpass(noise(n, 500 + t % 97), 0.06), 0.06)
        e = env_ad(n, int(SR * 0.004), SR * 0.010)
        # 腔体共鸣：低频，给一点"咚"
        body = sine(n, 140 + rnd.uniform(-20, 20), phase=0.4)
        be = env_decay(n, SR * 0.007)
        amp = 0.5 + 0.5 * (1 - t / total)
        for j in range(n):
            if t + j < total:
                out[t + j] += (base[j] * e[j] * 0.9 + body[j] * be[j] * 0.3) * amp
        t += max(1, gap)
    # 桌面摩擦：极低频
    roll = lowpass(noise(total, 314), 0.05)
    re_ = [1.0 - 0.5 * (k / total) for k in range(total)]
    return [out[k] + roll[k] * re_[k] * 0.3 for k in range(total)]


def chip_bet():
    """筹码/下注声 —— 酒桌游戏的氛围音。
    多个短促高频点击叠在一起（像把筹码推上桌）。"""
    total = int(SR * 0.35)
    out = [0.0] * total
    rnd = random.Random(777)
    t = 0
    while t < total - int(SR * 0.04):
        n = int(SR * 0.04)
        f = rnd.uniform(2800, 3600)
        s = sine(n, f)
        e = env_ad(n, int(SR * 0.0005), SR * 0.007)
        for j in range(n):
            if t + j < total:
                out[t + j] += s[j] * e[j] * 0.45
        t += int(SR * rnd.uniform(0.03, 0.06))
    return out


def gulp():
    """咽酒声 —— "喝一杯"的具象化。
    用带通噪声 + 音高起伏模拟吞咽。"""
    n = int(SR * 0.5)
    # 咽酒是低频事件：带通下移到 0.06~0.22（原来 0.14~0.4 太亮，像"嘶嘶"不像"咕咚"）
    base = bandpass(noise(n, 555), 0.06, 0.22)
    # 再叠一层低频"喉音"，让它有厚度
    throat = lowpass(noise(n, 556), 0.035)
    # 三次"咕咚"起伏
    gulp_env = []
    for i in range(n):
        t = i / n
        v = 0.5 + 0.5 * abs(math.sin(2 * math.pi * 2.5 * t))
        gulp_env.append(v * math.sin(math.pi * t) ** 0.5)
    return [base[i] * gulp_env[i] * 0.6 + throat[i] * gulp_env[i] * 0.5 for i in range(n)]


def confetti():
    """撒花/庆祝：一串快速上行的小音符 + 噪声"沙沙"。
    用在"赢了"的瞬间，比纯琶音更有画面感。"""
    total = int(SR * 0.9)
    out = [0.0] * total
    rnd = random.Random(2024)
    # 快速上行的短音（像彩色纸屑炸开）
    for k in range(9):
        f = 523.25 * (1.12 ** k)
        n = int(SR * 0.1)
        s = sine(n, f)
        e = env_ad(n, int(SR * 0.001), SR * 0.02)
        off = int(SR * 0.045 * k)
        for j in range(n):
            if off + j < total:
                out[off + j] += s[j] * e[j] * 0.4
    # 沙沙噪声（纸屑飘落）
    sh = highpass(noise(total, 2025), 0.5)
    se = [math.sin(math.pi * i / total) ** 0.7 for i in range(total)]
    return [out[i] + sh[i] * se[i] * 0.22 for i in range(total)]


# ============================================================
# v4 骰盅组 —— 让摇骰子"像现实"
#
# 用户反馈：「摇骰子的动画效果和真实场景差很多」。
# 对着真实场景拆解，一个完整的摇盅流程是这样的：
#
#     ① 骰子入盅      几声散乱的脆响（骰子掉进盅里，弹几下）
#     ② 摇盅          骰子在盅内壁乱撞 —— **持续、不规则、有起伏**
#     ③ 扣盅  ← ★      "咚"一声闷响，盅砸在桌上。整条流程最有仪式感的一下
#     ④ 揭盅          提起盅时的一声轻响 + 骰子在桌上再滚两下
#
# 改造前只有 ②（dice-tumble-wood，且是一次性播放），③ 完全没有。
# 而 ③ 恰恰是"真实现场"和"电子游戏"差别最大的地方。
# ============================================================

def dice_into_cup():
    """
    ① 骰子入盅：骰子掉进盅里，弹几下。
    特征：3~4 声**间隔逐渐变短、响度逐渐变小**的脆响
    （第一次掉得最高最响，之后每次弹起高度递减 —— 这是真实物理）。
    """
    total = int(SR * 0.62)
    out = [0.0] * total
    rnd = random.Random(3301)
    t = 0.0
    # 弹跳高度按几何级数衰减：0.55 → 0.33 → 0.20 → 0.12
    amp = 0.95
    gap = 0.115
    k = 0
    while t < total / SR and amp > 0.06:
        hit = dice_hit(amp, seed=3300 + k)
        off = int(SR * t)
        for j, v in enumerate(hit):
            if off + j < total:
                out[off + j] += v
        amp *= 0.58
        gap *= 0.72          # 间隔越来越短
        t += gap
        k += 1
    # 盅体的低频共鸣（骰子落在木盅里，盅会"嗡"一下）
    body = lowpass(noise(total, 3302), 0.03)
    be = env_decay(total, SR * 0.10)
    return [out[i] + body[i] * be[i] * 0.22 for i in range(total)]


def cup_shake(seconds=1.05):
    """
    ② 摇盅：骰子在盅内壁乱撞。

    和 shaker-metal 的区别（这是刻意的，不是重复）：
      · 木盅的声音**闷**、没有金属的不谐和泛音 → 用低通把高频压掉
      · 摇动是**手的往复动作**，所以响度有周期性起伏（约 3.5Hz，即手摇的频率）
      · 撞的是盅壁不是桌面，衰减更快、没有桌面共鸣

    ★ 关键：响度起伏必须叠上去。第一版做成了"均匀的密集撞击"，
    听起来像下雨而不像摇盅 —— 因为真实的摇动是**有节奏的往复**。
    """
    total = int(SR * seconds)
    rnd = random.Random(771)
    out = [0.0] * total
    t = 0
    # 碰撞间隔必须大于衰减时间，否则尾巴糊成一片（踩过的坑，见 shaker_metal）
    while t < total:
        gap = int(SR * rnd.uniform(0.024, 0.062))
        n = int(SR * 0.05)
        # 木盅：低沉的"叩"，主频 380~760Hz（比金属盅低一个八度多）
        f = rnd.uniform(380, 760)
        ring = sine(n, f)
        ring2 = sine(n, f * 1.63)
        e = env_ad(n, max(1, int(SR * 0.0006)), SR * 0.009)
        amp = rnd.uniform(0.7, 1.1)
        hit = [(ring[j] * 0.7 + ring2[j] * 0.3) * e[j] * amp for j in range(n)]
        for j, v in enumerate(hit):
            if t + j < total:
                out[t + j] += v
        t += max(1, gap)

    # ★ 手摇的周期起伏：3.5Hz 正弦，谷值压到 0.45
    # 没有这一层，"摇"就变成了"倒" —— 这是最像/最不像的分界线
    for i in range(total):
        ph = i / SR
        swing = 0.45 + 0.55 * (0.5 + 0.5 * math.sin(2 * math.pi * 3.5 * ph))
        out[i] *= swing

    # 木盅内腔的低频共鸣
    body = lowpass(noise(total, 772), 0.028)
    return [out[i] + body[i] * 0.14 for i in range(total)]


def grainize(seconds, seed, density_hz=900, grain_ms=1.8, amp_jitter=0.55, seed_body=None):
    """
    颗粒化摩擦声 —— 纸牌/布料/砂纸这类声音的正确做法。

    ★ 为什么不能直接用 bandpass(noise())：
      连续带通噪声听起来像"合成器的沙沙声"，因为它每一刻的能量都一样。
      真实摩擦是**无数个微小接触点**的叠加 —— 每一刻接触的点数、角度、
      压力都在变，所以能量是**起伏的、颗粒状的**。

      这是纸牌音效"像不像"的分水岭。做法：
        · 每 grain_ms 放一个极短脉冲（噪声 × 快速衰减包络）
        · 脉冲幅度随机起伏（接触点多少不同）
        · 再叠一层很轻的连续噪声作底（完全离散会显得"电子"）
    """
    n = int(SR * seconds)
    out = [0.0] * n
    rng = random.Random(seed)
    step = max(1, int(SR * grain_ms / 1000.0))
    i = 0
    k = 0
    while i < n:
        amp = 1.0 - amp_jitter * rng.random()
        glen = min(step * 2, n - i)
        g = noise(glen, seed + 1000 + k)
        ge = env_ad(glen, max(1, int(SR * 0.0004)), SR * 0.006)
        for j in range(glen):
            out[i + j] += g[j] * ge[j] * amp
        i += step
        k += 1
    # 很轻的连续底噪（把颗粒"粘"起来）
    body = noise(n, seed_body or (seed + 7))
    for j in range(n):
        out[j] = out[j] * 0.85 + body[j] * 0.15
    # 整体包络：摩擦是"起快、收慢"
    env = env_ad(n, max(1, int(SR * 0.004)), SR * 0.035)
    return [out[j] * env[j] for j in range(n)]



# ============================================================
# v5.2 混音平衡（2026-10-28）
#
# ★ 为什么需要：所有音效都做了峰值归一化（峰值 ≈0.97），
#   但**感知响度**跨度有 20.6 dB —— 听起来就是"有的震耳、有的听不见"。
#   实测最刺眼的 5 处：
#     咽酒 drink      -5.5 dB  ← 比摊牌还响 17 dB，喧宾夺主
#     摊牌 card-spread -23.2 dB ← 全场焦点反而最轻之一
#     入盅 dice-into-cup -26.2 dB ← 摇盅第一步几乎听不见
#     蓄力 charge-up  -9.2 dB  ← 氛围音成了全场最响
#
# ★ 只修这 5 处，**不做全局重排**。
#   AGENTS.md 记过"归一化只能向上不能向下"的教训 —— 一刀切拉平会
#   把本来有层次的设计改坏。这里每一处改动都有明确的语义理由。
#
# 指标用「100ms 窗口的最大 RMS」而不是全局 RMS：
#   全局 RMS 会把"尖峰 + 长静音"判得很轻，但耳朵不是这么听的。
# ============================================================

def short_term_db(sig, sr=None, win_ms=100):
    """100ms 窗口的最大 RMS（dBFS）—— 感知响度的近似。

    ⚠️ sr 必须传该音效**自己的采样率**：音效有 8000/11025/22050 三档，
       用全局 SR 算窗口会算错窗口长度（第一个版本就错在这，导致测量值乱跳）。
    """
    sr = sr or SR
    n = len(sig)
    w = max(1, int(sr * win_ms / 1000.0))
    if n <= w:
        rms = math.sqrt(sum(x * x for x in sig) / max(1, n))
        return 20 * math.log10(rms) if rms > 0 else -99.0
    best = 0.0
    step = max(1, w // 4)
    for i in range(0, n - w + 1, step):
        seg = sig[i:i + w]
        r = math.sqrt(sum(x * x for x in seg) / w)
        if r > best:
            best = r
    return 20 * math.log10(best) if best > 0 else -99.0


def match_short_term(sig, target_db, sr=None):
    """把短时峰值响度对齐到目标值。

    ⚠️ 只用于**向下调**。向上调会被峰值保护吃掉（峰值已接近 0.97），
       结果是"越调越轻" —— 实测 dice-into-cup 想要 +6 dB，实际变成 -26 dB。
    """
    cur = short_term_db(sig, sr)
    if cur <= -98:
        return sig
    k = 10 ** ((target_db - cur) / 20.0)
    out = [x * k for x in sig]
    peak = max((abs(x) for x in out), default=0)
    if peak > 0.97:
        out = [x * (0.97 / peak) for x in out]
    return out


# 文件 → 目标短时峰值响度（dBFS）。**只做向下调**。
#
# ⚠️ 这里一开始列了 5 个，其中两个（dice-into-cup / card-spread）是向上调，
#    被峰值保护吃掉、反而更轻了。复核后确认：这两个**本来就不该单独调响** ——
#    它们都是组合音的一部分：
#      · 摊牌 = card-spread(-23) 紧跟 reveal-hit(-20)，整体由后者主导
#      · 入盅 = dice-into-cup(-26) 紧跟摇盅(-18)，前者只是"开场轻响"
#    单独看响度低是**设计意图**，不是失衡。差点因为错误的指标改坏它们。
LOUDNESS_FIX = {
    # ★ 2026-11-02：过了 soft_limit 之后 RMS 上来了，前 50ms 冲到 -9.1（目标 -12）
    'cup-slam':   -11.6,
    # 揭盅是结果音，不能比扣盅（动作重击）还响 —— 过了 soft_limit 之后它冲到了 -11
    'reveal-hit': -14.2,
    'drink':      -14.0,   # 咽酒：氛围，本来 -5.5 比摊牌还响 17 dB，喧宾夺主
    # cup-lift（揭盅铺垫）：2026-10-28 实测前 50ms RMS −9.9，
    # 比它要铺垫的那记扣盅（−17）响 7 dB —— 铺垫压住了重音。
    # ★ 只改生成函数里的混音音量是**没用的**：loudness_normalize 会把它
    #   推回 target_rms（实测把 0.55 降到 0.26，落盘的 RMS 一点没变）。
    #   这类"要更轻"只能走这张**只做向下调**的表。
    'cup-lift':   -19.0,
    # ★★ 2026-10-28 层级校准：下面这几个的"前 50ms RMS"原来都高于扣盅/揭晓，
    #   于是**过程音压过了重击**（实测 fail-drop −8.0、combo −8.0、wheel-stop −7.4，
    #   而扣盅 −10.9、揭晓 −12.1）。听感是"输了很响、扣盅很轻"，因果反了。
    #   数字是按「100ms 窗口最大 RMS」这个口径给的（本函数用 short_term_db），
    #   与前 50ms RMS 差 −1 ~ −2 dB。
    'fail-drop':  -13.2,   # 惩罚下坠：结果的情绪音，不该压过动作重击
    'combo-1':    -14.9,   # 连击：好消息提示，同理
    'combo-2':    -14.9,
    'combo-3':    -14.9,
    'combo-4':    -14.9,
    'wheel-stop': -13.0,   # 转盘停稳：转盘玩法的高潮，但全局看是"结果音"档
    'charge-up':  -17.0,   # 蓄力：氛围铺垫，不是主角
    # ★ 2026-11-02：tap 家族改成"噪声瞬态 + 带通"之后，能量分布从
    #   中频 96% 变成高频 90% —— **高频在等响曲线上更响**，同样的 RMS
    #   听起来会响 3~4 dB。而这四个是**全项目最高频听到**的音效
    #   （tap-soft 37 处、tap 7 处、toggle 4 处），不压就是"嚓嚓嚓"。
    #   ⚠️ 目标值要按"短音被 100ms 窗口稀释"补偿：
    #      tap 只有 40ms → 短时响度比实际低约 4 dB
    #      tap-soft 30ms → 低约 5 dB
    #      所以 target 要比想要的实际值**再低 4~5 dB**。
    #   目标实际值：tap ≈ -17、tap-soft ≈ -18（和改前的 -17.2 / -18.1 持平）。
    'tap':        -16.5,
    'tap-soft':   -17.5,
    # 读秒是**提示**，不是事件 —— 原来 -13.5 比过程落定(-18.7)还响 5dB。
    # 连读 3 下会显得吵。压到 -16.5。
    # （"开始"那一拍 countdown-go 保持 -10.5，它是真正的落点，和扣盅同级。）
    'countdown':  -16.5,
}

# ============================================================
# v5 纸牌组（2026-10-27）—— 梦幻金花用
#
# 为什么必须单独做：这一组的音色和骰子/转盘**完全不同**。
#   骰子是硬木撞桌面（有低频"咚"），纸牌是**薄片擦桌面**（几乎没有低频）。
#   拿骰子音效代替牌声，一听就"厚重得不像纸"。
#
# 纸牌声音的物理特征：
#   · 没有低频 —— 一张 30g 的纸片不会让桌子响
#   · 主能量在 2k~8kHz，是"纸纤维擦过硬桌面"的沙沙 + 落下的"嗒"
#   · 时长短（80~200ms），衰减极快
# ============================================================

def card_deal():
    """
    发牌：纸牌从手边滑出去，落在桌面。

    ★ v5.1 改用**颗粒化摩擦**（grainize）——
      第一版用 bandpass(noise()) 直接做，听着像"合成器沙沙"，
      因为连续噪声每一刻能量都一样。真实纸牌滑过桌面是无数纤维
      接触点的断续叠加，能量是起伏的。
    """
    n = int(SR * 0.22)
    # 滑动：颗粒化摩擦，主频偏高（纸是薄而硬的）
    slide = grainize(0.22, 7101, density_hz=780, grain_ms=1.6)
    slide = bandpass(slide, 0.26, 0.90)
    out = [slide[i] * 0.55 for i in range(min(n, len(slide)))]
    while len(out) < n:
        out.append(0.0)
    # 落桌："嗒" —— 极短的高频冲击（这个必须有，纸牌落桌是明确的点）
    tap_n = int(SR * 0.045)
    hit = highpass(noise(tap_n, 7102), 0.62)
    he = env_ad(tap_n, max(1, int(SR * 0.0006)), SR * 0.010)
    off = int(SR * 0.092)
    for j, v in enumerate(hit):
        if off + j < n:
            out[off + j] += v * he[j] * 0.80
    return out


def card_flip():
    """
    翻牌：手指一弹把牌翻过来。
    比发牌更脆更短 —— 摩擦少、冲击集中，而且"翻"有一个上扬的尾巴。
    """
    n = int(SR * 0.145)
    fric = grainize(0.10, 7201, density_hz=1100, grain_ms=1.2)
    fric = highpass(bandpass(fric, 0.42, 0.96), 0.18)
    out = [0.0] * n
    for i in range(min(n, len(fric))):
        out[i] = fric[i] * 0.62
    # 翻过来拍到桌面
    tap_n = int(SR * 0.040)
    hit = highpass(noise(tap_n, 7202), 0.60)
    he = env_ad(tap_n, max(1, int(SR * 0.0005)), SR * 0.009)
    off = int(SR * 0.052)
    for j, v in enumerate(hit):
        if off + j < n:
            out[off + j] += v * he[j] * 0.86
    return out


def card_spread():
    """
    摊牌：几张牌一起拍在桌上（比牌那一刻）。
    三张牌在 0~41ms 内相继落下 —— 听感上是一声厚的，不是三声。
    每张牌自己的摩擦仍然是颗粒化的。
    """
    n = int(SR * 0.30)
    out = [0.0] * n
    for k, (delay_ms, amp, seed) in enumerate([(0, 0.95, 7301), (22, 0.72, 7302), (41, 0.58, 7303)]):
        off = int(SR * delay_ms / 1000.0)
        seg = grainize(0.10, seed, density_hz=950, grain_ms=1.4)
        seg = bandpass(seg, 0.32, 0.92)
        for j in range(min(len(seg), n - off)):
            out[off + j] += seg[j] * amp * 0.52
        tap_n = int(SR * 0.035)
        hit = highpass(noise(tap_n, seed + 50), 0.58)
        he = env_ad(tap_n, max(1, int(SR * 0.0005)), SR * 0.008)
        for j in range(tap_n):
            if off + j < n:
                out[off + j] += hit[j] * he[j] * amp * 0.85
    # ★★ 2026-10-28 补一层"桌面体"：
    #   原来这份只有 0~41ms 的高频"嗒"，实测半峰样本 1 个（0.05ms）——
    #   峰值是一根针，前 50ms RMS −20.6，比"抬盅"（−15.3）还轻 5 dB。
    #   而它是金花摊牌那一刻的主音。真实里几张牌拍到实木桌上，
    #   会带起桌面的低频共鸣（120~200Hz，衰减 60~90ms）。
    body_n = n
    b1 = sine(body_n, 132)
    b2 = sine(body_n, 187)
    be = env_ad(body_n, int(SR * 0.0015), SR * 0.070)
    for i in range(body_n):
        out[i] += (b1[i] * 0.30 + b2[i] * 0.18) * be[i] * 0.55
    return out


DHIT_GAIN = 6.0   # 手机频段补偿层的量（迭代调出来的）


def cup_slam():
    """
    ③ 扣盅 —— ★ 整个流程最有仪式感的一下。

    真实扣盅的声音构成（拆开看）：
      · 盅口沿撞桌面：**宽而闷**的一击，能量集中在 120~300Hz
        （不是骰子那种"脆"，因为木盅口径大、接触面大）
      · 桌面被砸的"咚"：60~90Hz 的极低频，这一层给"重"
      · 盅内骰子被震得跳一下：紧随其后的一两声轻响（★★ 细节）
      · 尾音：木头的短共鸣，很快消失

    ★ 最后那条"骰子在盅里被震得跳一下"是真实的物理，
    加上它立刻就有了"里面有东西"的实感 —— 空盅扣下去是没有这一下的。
    """
    n = int(SR * 0.80)
    # ① 口沿撞桌面：宽带噪声 + 快速衰减（"啪"的木质感）
    knock = lowpass(highpass(noise(n, 881), 0.25), 0.45)
    ke = env_ad(n, max(1, int(SR * 0.0008)), SR * 0.020)
    # ② 桌面的低频"咚"：起音稍慢（桌面是弹性体，不是硬碰硬）
    #
    # ★★ 2026-10-28 实测修正：这是**全场最重的一下**，但它的能量只有 0.07ms。
    #   峰均比高到 loudness_normalize 完全推不动（按 RMS 放大 4.2 倍会削顶，
    #   回退后整体响度又回到原样）—— 也就是说"调增益"对它是无效的，
    #   必须**加能量体**：让这声"咚"在 150ms 里持续，而不是 45ms 就消失。
    #   实测改前 前50ms RMS −17.0、半峰样本 3；改后见 scripts/audio-levels.py。
    thud = sine(n, 72)
    thud2 = sine(n, 108)          # 非整数倍 → 木桌的钝
    te = env_ad(n, int(SR * 0.0025), SR * 0.150)
    # ②b 桌面本身的极低频体（55Hz）：现实里扣一下桌子，胸口是有感的
    low = sine(n, 55)
    le = env_ad(n, int(SR * 0.004), SR * 0.180)
    # ③ 木盅腔体共鸣（30ms → 75ms：盅是个空腔，余振本来就比实木长）
    body = sine(n, 196)
    be = env_decay(n, SR * 0.075)

    # ★★★ 2026-11-02 为手机扬声器加一层「盅沿撞桌面」。
    #
    #   实测这一声的频谱：低频 −24.9 dBFS，而 300~4000Hz 只有 **−52.9 dBFS**
    #   —— 相差 28 dB。手机小扬声器在 300Hz 以下几乎不响应，
    #   所以「扣盅」这个全场最重的一下，在手机上**基本是听不见的**
    #   （电脑/耳机上是"咚"，手机上是"噗"）。
    #
    #   只把原来那层 knock 调大是不够的：它只有 20ms，能量占比怎么算都很低。
    #   这里加一层**独立**的、手机频段的实体撞击：
    #     带通 600~2600Hz（人耳最敏感、手机扬声器最能出的区间）
    #     包络 55ms（够长到能被听见，够短到还是"啪"不是"嘶"）
    #   ★ 包络从 45ms 拉到 130ms：**短瞬态只有"啪"没有"肉"**，
    #     而 audio-levels 的判据是「整体 RMS ≥ -24」+「半峰样本 ≥ 12」——
    #     拉长之后这一层本身就成了"能量体"，且完全落在手机能出的频段里。
    dhit = bandpass(noise(n, 977), 0.75, 0.17)
    dhe = env_ad(n, max(1, int(SR * 0.0008)), SR * 0.130)
    dpeak = max(1e-9, max(abs(x) for x in dhit))
    dhit = [x / dpeak for x in dhit]

    # ★★★ 2026-11-02 为手机扬声器重混：中频层 0.42 → 1.10。
    #   实测这一声 **99.8% 能量在 300Hz 以下**，而手机小扬声器在 300Hz 以下
    #   几乎不响应 —— 「扣盅」这个全场最重的一下，在手机上基本听不见
    #   （电脑/耳机上是"咚"，手机上是"噗"）。
    #   系数差就是原因：中频 knock 0.42 vs 低频 thud 1.95。
    #   ★ 低频给体量，中高频给**可听性** —— 只做低频等于在手机上没做。
    out = [knock[i] * ke[i] * 1.10
           + dhit[i] * dhe[i] * DHIT_GAIN
           + (thud[i] * 0.95 + thud2[i] * 0.60) * te[i] * 1.55   # 1.95→1.55：降一点给中频让峰值，但不能太低（能量体靠它）
           + low[i] * le[i] * 1.15
           + body[i] * be[i] * 0.90
           for i in range(n)]

    # ④ 盅内骰子被震得跳一下（延迟 55ms，两声轻响）
    for k, (delay_ms, amp) in enumerate([(55, 0.34), (108, 0.18)]):
        off = int(SR * delay_ms / 1000.0)
        hit = dice_hit(amp, seed=882 + k)
        for j, v in enumerate(hit):
            if off + j < n:
                out[off + j] += v
    return soft_limit(out)


def cup_lift():
    """
    ④ 揭盅：把盅提起来。
    特征：一个**上扬的摩擦声**（盅口沿离开桌面时的轻微吸附感）
    + 木盅离开桌面后腔体变空、尾音变亮。
    这一声要轻 —— 主角是马上要露出来的骰子，不是盅本身。
    """
    n = int(SR * 0.42)
    # 摩擦/吸附：带通噪声，音高略上扬
    fric = bandpass(noise(n, 991), 0.18, 0.62)
    fe = env_ad(n, int(SR * 0.006), SR * 0.075)
    # 上扬的气声（"提起来"的方向感）
    air = highpass(noise(n, 992), 0.55)
    ae = env_ad(n, int(SR * 0.012), SR * 0.055)
    # ★★ 2026-10-28 实测：这一声原来是 0.55 / 0.20 混音，前 50ms RMS −9.8，
    #   比它要铺垫的那记扣盅（−17.0）**响 7 dB** —— 铺垫压住了重音，
    #   听感是"抬起来很响、砸下去很轻"。降一半左右。
    out = [fric[i] * fe[i] * 0.26 + air[i] * ae[i] * 0.08 for i in range(n)]
    return out


def dice_on_table():
    """
    ⑤ 骰子落在桌面上滚两下才停。

    为什么单独做一个：揭盅之后骰子是"已经停好"的，
    但现实里它们会**再滚一小段**才停住 —— 缺这一下，
    揭盅就显得"太干脆"，像贴图切换而不是物理。
    间隔按 1.35 倍递增（越滚越慢），响度递减。
    """
    total = int(SR * 0.75)
    out = [0.0] * total
    t = 0.0
    amp = 0.85
    gap = 0.055
    k = 0
    while t < total / SR and amp > 0.08:
        hit = dice_hit(amp, seed=5500 + k)
        off = int(SR * t)
        for j, v in enumerate(hit):
            if off + j < total:
                out[off + j] += v
        amp *= 0.62
        gap *= 1.35          # 越滚越慢 —— 这是"停下来"的听感来源
        t += gap
        k += 1
    # 极轻的桌面摩擦底噪
    rub = lowpass(noise(total, 5501), 0.05)
    re_ = [1.0 - 0.6 * (i / total) for i in range(total)]
    return [out[i] + rub[i] * re_[i] * 0.16 for i in range(total)]


# ==== v3 音效清单（必须放在所有函数定义之后）====
# ============================================================
# 空间化包装：把 v3 的关键音效过一遍「瞬态 → 反射 → 尾巴」
#
# 为什么只处理这几个：它们是「有物理实体」的声音
# （骰子撞桌子、转盘停住、开盅），本来就该有房间感。
# UI 音（tap/toggle）不该有尾巴 —— 界面点击没有物理空间，
# 加了反而显得拖沓。
# ============================================================

def ambient_room():
    """房间底噪：4 秒可循环的极低音量环境声（调研第 10 条）。

    为什么不做 BGM：酒桌上大家在说话，一段有旋律的曲子会和聊天抢。
    而"绝对安静"又不像真实的房间 —— Jackbox 给每个游戏都配了专属曲目，
    我们做不到，但可以做到"有一层底噪"。

    做法：白噪声过两级一阶低通（砍掉高频的"嘶"），叠一层很慢的振幅起伏
    （模拟远处人声的嗡嗡）。归一化到峰值的 8% —— 低到"关掉才知道刚才有"。
    首尾各 250ms 淡入淡出，否则循环接缝处会听到"咔"。

    ⚠️ 这个文件是**纯标准库**（math/random/struct/wave），没有 numpy ——
       第一版我按 numpy 写，运行直接 NameError。要在本文件里加函数，
       只能用 list 和 for 循环。
    """
    sr = SR
    n = int(sr * 4.0)
    rng = random.Random(99)

    # 两级一阶低通：y += a * (x - y)
    #
    # ★★★ 2026-11-02 修：系数原来是按 **8000Hz** 折算的（0.06/0.16 ≈ 76/200Hz），
    #   但实际 SR 是 22050 —— 同样的系数，截止频率只有一半。
    #   实测生成出来的底噪**主频是 13~18Hz**，那是次声波，人耳根本听不到。
    #
    #   后果：这一层"环境感"等于没做 —— 用户说的"声音一般"里有一份是这个：
    #   房间是死的，没有空气感。
    #
    #   目标：能量落在 160~390Hz（有人在不远处说话、空调低频的那个频段）。
    #
    #   ⚠️ 系数必须按**生成时**的 sr 算（函数体内是全局 SR=22050），
    #      写盘时再降采样到 SR_LO(8000) —— 降采样不改变频率，
    #      只要目标频率 < 新 Nyquist(4000) 就对。
    #      系数 = f * 2π / SR：160Hz → 0.046   390Hz → 0.111
    #   ★★ 只做低通不够：白噪声过低通后能量**全堆在最低频**，
    #      实测主频仍是 41~59Hz（人耳对 60Hz 以下几乎不敏感）。
    #      要"房间的空气感"必须是**带通**：砍掉 100Hz 以下的隆隆，
    #      只留 120~500Hz —— 那才是"有人在不远处说话"的残留。
    #   一阶高通 + **三级**低通：
    #     一阶高通滚降只有 6dB/oct，砍不干净 100Hz 以下的隆隆；
    #     低通要三级才压得住 500Hz 以上的"嘶"（上一版两级，实测嘶声占 35%）。
    hp = 0.043          # 150Hz
    lp = 0.057          # 200Hz 附近开始滚降，三级叠加后 500Hz 处约 -18dB
    yh = 0.0
    prev_x = 0.0
    l1 = l2 = l3 = 0.0
    buf = []
    for _ in range(n):
        x = rng.gauss(0.0, 1.0)
        # 高通：**必须用输入的历史**（上一版误用了输出的历史 buf[-1]，等于没滤）
        yh = hp * (yh + x - prev_x)
        prev_x = x
        l1 += lp * (yh - l1)
        l2 += lp * (l1 - l2)
        l3 += lp * (l2 - l3)
        buf.append(l3)

    # 远处人声的缓慢起伏：两个不相干的低频正弦
    for i in range(n):
        t = i / sr
        env = 0.72 + 0.18 * math.sin(2 * math.pi * 0.31 * t) \
            + 0.10 * math.sin(2 * math.pi * 0.73 * t + 1.7)
        buf[i] *= env

    # 归一化到峰值的 8%
    peak = max(abs(v) for v in buf) or 1.0
    k = 0.08 / peak
    buf = [v * k for v in buf]

    # 循环接缝：首尾各 250ms 线性淡入淡出
    fade = int(sr * 0.25)
    for i in range(fade):
        buf[i] *= i / fade
        buf[n - 1 - i] *= i / fade
    return buf


ALL_V3 = [
    ('impact-low',        _sp(impact_low, tail_ms=120, seed=27), SR_LO),
    ('shaker-metal',      _sp(shaker_metal, tail_ms=260, seed=23), SR_HI),
    ('dice-tumble-wood',  _sp(dice_tumble_wood, tail_ms=200, seed=25), SR_HI),
    ('combo-1',           lambda: combo_up(0), SR_MID),
    ('combo-2',           lambda: combo_up(1), SR_MID),
    ('combo-3',           lambda: combo_up(2), SR_MID),
    ('combo-4',           lambda: combo_up(3), SR_MID),
    ('fail-drop',         _sp(fail_drop, tail_ms=280, seed=31), SR_HI),
    ('charge-up',         charge_up,         SR_MID),   # 2026-11-02：泛音要到 3.8kHz，8000Hz 存不下
    ('reveal-hit',        _sp(reveal_hit, tail_ms=200, seed=21, final_sharpen=False), SR_HI),
    ('countdown-urgent',  countdown_urgent,  SR_MID),
    ('chip-bet',          _sp(chip_bet, tail_ms=160, seed=33), SR_HI),
    ('gulp',              gulp,              SR_MID),
    ('confetti',          _sp(confetti, tail_ms=300, seed=29), SR_MID),
    # v4 骰盅组：让摇骰子像现实 —— 入盅 / 摇盅 / 扣盅 / 揭盅 / 桌上滚动
    ('dice-into-cup',     _sp(dice_into_cup, tail_ms=160, seed=61), SR_HI),
    ('cup-shake',         _sp(cup_shake, tail_ms=200, seed=63), SR_HI),
    ('cup-slam',          _sp(cup_slam, tail_ms=260, seed=65, final_sharpen=False), SR_HI),
    ('cup-lift',          _sp(cup_lift, tail_ms=140, seed=67), SR_MID),
    ('dice-on-table',     _sp(dice_on_table, tail_ms=180, seed=69), SR_HI),
    # v5 纸牌组：牌是薄片，反射比骰子短得多（tail 只要 90~140ms）
    ('card-deal',         _sp(card_deal, tail_ms=120, seed=71), SR_HI),
    ('card-flip',         _sp(card_flip, tail_ms=90, seed=73), SR_HI),
    ('card-spread',       _sp(card_spread, tail_ms=140, seed=75), SR_HI),
    # v6 环境底噪（调研第 10 条）
    ('ambient-room',      ambient_room,      SR_LO),
]


if __name__ == '__main__':
    print(f'输出: {os.path.normpath(OUT_DIR)}')
    print('按奈奎斯特定理为每个音效挑采样率（体积 = 采样率 × 时长）\n')
    # 清掉旧文件，避免改名后留下孤儿
    if os.path.isdir(OUT_DIR):
        for f in os.listdir(OUT_DIR):
            if f.endswith('.wav'):
                os.remove(os.path.join(OUT_DIR, f))
    all_specs = ALL + ALL_V3
    for name, fn, sr in all_specs:
        write_wav(name, fn(), sr)
    # tick 要留在主包（「我的」页的音效开关试听用）——
    # 分包可以引用主包，主包不能引用分包，所以这一个必须复制过去。
    src_tick = os.path.join(OUT_DIR, 'tick.wav')
    if os.path.exists(src_tick):
        os.makedirs(MAIN_AUDIO_DIR, exist_ok=True)
        import shutil
        shutil.copyfile(src_tick, os.path.join(MAIN_AUDIO_DIR, 'tick.wav'))
        print('  → tick.wav 复制回主包')

    files = [f for f in os.listdir(OUT_DIR) if f.endswith('.wav')]
    tot = sum(os.path.getsize(os.path.join(OUT_DIR, f)) for f in files)
    print(f'\n共 {len(files)} 个音效，合计 {tot/1024:.1f} KB')

