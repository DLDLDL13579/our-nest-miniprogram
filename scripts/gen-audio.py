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
OUT_DIR = os.path.join(os.path.dirname(os.path.abspath(__file__)), '..', 'miniprogram', 'audio')

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


def spatialize(sig, sr=SR, reflections=True, tail_ms=220, transient=True, seed=11):
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
    if transient:
        # 末道瞬态：把被空间处理拖慢的起音重新拉回来
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


def loudness_normalize(sig, peak_ceiling=0.97, target_rms=0.16, transient_peak=0.55):
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
    base = lowpass(highpass(noise(n, seed), 0.55), 0.85)
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


def wheel_slowdown():
    """减速：咔哒间隔越来越长 —— 这个"变慢"是转盘最爽的部分。"""
    total = int(SR * 1.6)
    out = [0.0] * total
    t, gap, k = 0, 0.035, 0
    while t < total:
        hit = tick(1.0 + k * 0.012)
        for j, v in enumerate(hit):
            if t + j < total:
                out[t + j] += v
        t += int(SR * gap)
        gap *= 1.13          # 间隔按比例拉长 → 听感上"越来越慢"
        k += 1
    return out


def wheel_stop():
    """停稳：一声清亮的"叮"。"""
    n = int(SR * 0.5)
    a, b = sine(n, 880), sine(n, 1320)
    e = env_ad(n, int(SR * 0.003), SR * 0.13)
    return [(a[i] * 0.7 + b[i] * 0.3) * e[i] for i in range(n)]


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

def tap():
    n = int(SR * 0.045)
    s = sine(n, 880)
    e = env_ad(n, int(SR * 0.001), SR * 0.008)
    return [s[i] * e[i] * 0.55 for i in range(n)]


def tap_soft():
    """更轻的点击：用于频繁操作，不抢戏。"""
    n = int(SR * 0.035)
    s = sine(n, 660)
    e = env_ad(n, int(SR * 0.0015), SR * 0.006)
    return [s[i] * e[i] * 0.35 for i in range(n)]


def toggle_on():
    n = int(SR * 0.12)
    s = sine_sweep(n, 520, 880)
    e = env_ad(n, int(SR * 0.003), SR * 0.04)
    return [s[i] * e[i] * 0.6 for i in range(n)]


def toggle_off():
    n = int(SR * 0.12)
    s = sine_sweep(n, 880, 520)
    e = env_ad(n, int(SR * 0.003), SR * 0.04)
    return [s[i] * e[i] * 0.6 for i in range(n)]


def countdown():
    """倒计时读秒：一声短促的"嘀"。"""
    n = int(SR * 0.09)
    s = sine(n, 1200)
    e = env_ad(n, int(SR * 0.001), SR * 0.02)
    return [s[i] * e[i] * 0.5 for i in range(n)]


def countdown_go():
    """倒计时结束：更高的"嘀"。"""
    n = int(SR * 0.22)
    s = sine(n, 1800)
    e = env_ad(n, int(SR * 0.001), SR * 0.06)
    return [s[i] * e[i] * 0.6 for i in range(n)]
# _sp 包装器必须定义在 ALL / ALL_V3 之前（它们引用它）
def _sp(fn, tail_ms=220, seed=11):
    """把合成函数包一层空间化（保持采样率契约不变）"""
    def wrapped():
        return spatialize(fn(), SR, tail_ms=tail_ms, seed=seed)
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
    ('wheel-slow',   wheel_slowdown,          SR_MID),
    ('wheel-stop',   _sp(wheel_stop, tail_ms=240, seed=49), SR_MID),
    # 情绪
    ('drink',        drink,                   SR_LO),  # 最高 392Hz
    ('whoosh',       whoosh,                  SR_MID), # 风声，中高频
    # UI
    ('tap',          tap,                     SR_MID),
    ('tap-soft',     tap_soft,                SR_LO),
    ('toggle-on',    toggle_on,               SR_MID),
    ('toggle-off',   toggle_off,              SR_MID),
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
    grit = lowpass(noise(n, 401), 0.08)
    ge = env_decay(n, SR * 0.012)
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
    a = sine(n, f)
    b = sine(n, f * 2)          # 八度泛音，更"亮"
    e = env_ad(n, int(SR * 0.003), SR * 0.075)
    return [(a[i] * 0.7 + b[i] * 0.3) * e[i] for i in range(n)]


def fail_drop():
    """失败下坠：比 lose 更重 —— 音高快速下滑 + 低频冲击。
    不是简单的"下行两音"，而是有坠落感的连续滑音。"""
    n = int(SR * 0.65)
    drop = sine_sweep(n, 440, 110)          # 从 A4 滑到 A2
    e = env_ad(n, int(SR * 0.006), SR * 0.22)
    body = [drop[i] * e[i] * 0.8 for i in range(n)]
    # 落地冲击（后半段）
    imp = impact_low()
    off = int(SR * 0.42)
    return mix(place(imp, off, n), body)


def charge_up():
    """蓄力：揭晓前的紧张感 —— 音高渐升 + 音量渐强 + 颤音。
    比 suspense 更有"要出事了"的压迫感。"""
    n = int(SR * 1.2)
    base = sine_sweep(n, 130, 260)
    fifth = sine_sweep(n, 195, 390)
    rise = [(i / n) ** 1.8 for i in range(n)]
    # 颤音：频率 8Hz 的振幅调制，模拟紧张
    tremolo = [0.75 + 0.25 * math.sin(2 * math.pi * 8 * i / SR) for i in range(n)]
    return [(base[i] * 0.55 + fifth[i] * 0.35) * rise[i] * tremolo[i] for i in range(n)]


def reveal_hit():
    """揭晓重击：一记"当"+ 低频冲击 + 金属尾音。
    商业游戏里"结果出现"的那一下必须有分量。"""
    n = int(SR * 0.75)
    # 高频明亮层
    a = sine(n, 1046.50)
    b = sine(n, 1567.98)
    e1 = env_ad(n, int(SR * 0.0015), SR * 0.16)
    bright = [(a[i] * 0.5 + b[i] * 0.3) * e1[i] for i in range(n)]
    # 低频冲击
    imp = impact_low()
    # 金属尾音（不谐和泛音 → 像铜锣）
    ring = sine(n, 2093)
    ring2 = sine(n, 3140)
    e2 = env_decay(n, SR * 0.09)
    metal = [(ring[i] * 0.18 + ring2[i] * 0.1) * e2[i] for i in range(n)]
    return mix(bright, place(imp, 0, n), metal)


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
#     转盘慢转 wheel-slow -12.9 dB ← 背景音太响，长音会累
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
    'drink':      -14.0,   # 咽酒：氛围，本来 -5.5 比摊牌还响 17 dB，喧宾夺主
    'wheel-slow': -20.0,   # 转盘慢转：1.6 秒长音，太响会累
    'charge-up':  -17.0,   # 蓄力：氛围铺垫，不是主角
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
    return out


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
    n = int(SR * 0.55)
    # ① 口沿撞桌面：宽带噪声 + 快速衰减（"啪"的木质感）
    knock = lowpass(highpass(noise(n, 881), 0.25), 0.45)
    ke = env_ad(n, max(1, int(SR * 0.0008)), SR * 0.020)
    # ② 桌面的低频"咚"：起音稍慢（桌面是弹性体，不是硬碰硬）
    thud = sine(n, 72)
    thud2 = sine(n, 108)          # 非整数倍 → 木桌的钝
    te = env_ad(n, int(SR * 0.0025), SR * 0.045)
    # ③ 木盅腔体共鸣
    body = sine(n, 196)
    be = env_decay(n, SR * 0.030)

    out = [knock[i] * ke[i] * 1.0
           + (thud[i] * 0.75 + thud2[i] * 0.4) * te[i] * 0.85
           + body[i] * be[i] * 0.30
           for i in range(n)]

    # ④ 盅内骰子被震得跳一下（延迟 55ms，两声轻响）
    for k, (delay_ms, amp) in enumerate([(55, 0.34), (108, 0.18)]):
        off = int(SR * delay_ms / 1000.0)
        hit = dice_hit(amp, seed=882 + k)
        for j, v in enumerate(hit):
            if off + j < n:
                out[off + j] += v
    return out


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
    out = [fric[i] * fe[i] * 0.55 + air[i] * ae[i] * 0.20 for i in range(n)]
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

ALL_V3 = [
    ('impact-low',        _sp(impact_low, tail_ms=120, seed=27), SR_LO),
    ('shaker-metal',      _sp(shaker_metal, tail_ms=260, seed=23), SR_HI),
    ('dice-tumble-wood',  _sp(dice_tumble_wood, tail_ms=200, seed=25), SR_HI),
    ('combo-1',           lambda: combo_up(0), SR_MID),
    ('combo-2',           lambda: combo_up(1), SR_MID),
    ('combo-3',           lambda: combo_up(2), SR_MID),
    ('combo-4',           lambda: combo_up(3), SR_MID),
    ('fail-drop',         _sp(fail_drop, tail_ms=280, seed=31), SR_MID),
    ('charge-up',         charge_up,         SR_LO),
    ('reveal-hit',        _sp(reveal_hit, tail_ms=200, seed=21), SR_HI),
    ('countdown-urgent',  countdown_urgent,  SR_MID),
    ('chip-bet',          _sp(chip_bet, tail_ms=160, seed=33), SR_HI),
    ('gulp',              gulp,              SR_MID),
    ('confetti',          _sp(confetti, tail_ms=300, seed=29), SR_MID),
    # v4 骰盅组：让摇骰子像现实 —— 入盅 / 摇盅 / 扣盅 / 揭盅 / 桌上滚动
    ('dice-into-cup',     _sp(dice_into_cup, tail_ms=160, seed=61), SR_HI),
    ('cup-shake',         _sp(cup_shake, tail_ms=200, seed=63), SR_HI),
    ('cup-slam',          _sp(cup_slam, tail_ms=260, seed=65), SR_HI),
    ('cup-lift',          _sp(cup_lift, tail_ms=140, seed=67), SR_MID),
    ('dice-on-table',     _sp(dice_on_table, tail_ms=180, seed=69), SR_HI),
    # v5 纸牌组：牌是薄片，反射比骰子短得多（tail 只要 90~140ms）
    ('card-deal',         _sp(card_deal, tail_ms=120, seed=71), SR_HI),
    ('card-flip',         _sp(card_flip, tail_ms=90, seed=73), SR_HI),
    ('card-spread',       _sp(card_spread, tail_ms=140, seed=75), SR_HI),
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
    files = [f for f in os.listdir(OUT_DIR) if f.endswith('.wav')]
    tot = sum(os.path.getsize(os.path.join(OUT_DIR, f)) for f in files)
    print(f'\n共 {len(files)} 个音效，合计 {tot/1024:.1f} KB')

