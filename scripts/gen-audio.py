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


def fade_edges(sig, ms=4):
    n = min(int(SR * ms / 1000), len(sig) // 2)
    out = list(sig)
    for i in range(n):
        k = i / n
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


def write_wav(name, sig, out_sr=None):
    """写 WAV。out_sr 给定时先降采样 —— 体积 = 采样率 × 时长，降一半省一半。"""
    os.makedirs(OUT_DIR, exist_ok=True)
    path = os.path.join(OUT_DIR, name + '.wav')
    if out_sr and out_sr < SR:
        sig, sr_use = resample(sig, SR, out_sr)
    else:
        sr_use = SR
    sig = fade_edges(normalize(sig))
    with wave.open(path, 'w') as w:
        w.setnchannels(1)
        w.setsampwidth(2)
        w.setframerate(sr_use)
        w.writeframes(b''.join(
            struct.pack('<h', max(-32768, min(32767, int(v * 32767)))) for v in sig))
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
    ('dice-hit',     lambda: dice_hit(1.0),  SR_HI),   # 脆响，高频到 5kHz
    ('dice-shake',   lambda: dice_shake(1.2), SR_HI),  # 宽带噪声
    ('dice-roll',    dice_roll,               SR_MID), # 摩擦声，中频为主
    ('dice-settle',  _sp(dice_settle, tail_ms=180, seed=45), SR_MID),
    ('dice-open',    _sp(dice_open, tail_ms=280, seed=47), SR_MID),
    ('dice-fanfare', dice_land_fanfare,       SR_LO),  # 最高 659Hz
    # 转盘
    ('tick',         lambda: tick(),          SR_HI),  # 机械咔哒，极高频
    ('wheel-start',  wheel_start,             SR_LO),  # 扫频 180→420Hz
    ('wheel-loop',   wheel_spin_loop,         SR_MID),
    ('wheel-slow',   wheel_slowdown,          SR_HI),  # 一串咔哒
    ('wheel-stop',   _sp(wheel_stop, tail_ms=240, seed=49), SR_MID),
    # 情绪
    ('win',          win,                     SR_MID), # 最高 1047Hz
    ('lose',         lose,                    SR_LO),  # 最高 440Hz
    ('drink',        drink,                   SR_LO),  # 最高 392Hz
    ('clink',        _sp(clink, tail_ms=260, seed=41), SR_HI),  # 玻璃，高频到 4.4kHz
    ('pour',         _sp(pour, tail_ms=260, seed=43), SR_MID), # 液体，带宽较宽
    ('suspense',     suspense,                SR_LO),  # 110/165Hz
    ('reveal',       reveal,                  SR_MID), # 最高 1568Hz
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

