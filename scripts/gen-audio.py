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
    """落定：骰子停下的"定音"。"""
    n = int(SR * 0.18)
    s = sine(n, 660)
    e = env_ad(n, int(SR * 0.003), SR * 0.045)
    base = [s[i] * e[i] for i in range(n)]
    return mix(place(dice_hit(0.6, seed=42), 0, n), base)


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


# ============================================================

ALL = [
    # (文件名, 生成函数, 输出采样率)
    # 采样率按各自最高有效频率定 —— 脆响/噪声用 HI，纯低频用 LO
    # 骰子
    ('dice-hit',     lambda: dice_hit(1.0),  SR_HI),   # 脆响，高频到 5kHz
    ('dice-shake',   lambda: dice_shake(1.2), SR_HI),  # 宽带噪声
    ('dice-roll',    dice_roll,               SR_MID), # 摩擦声，中频为主
    ('dice-settle',  dice_settle,             SR_MID),
    ('dice-open',    dice_open,               SR_MID),
    ('dice-fanfare', dice_land_fanfare,       SR_LO),  # 最高 659Hz
    # 转盘
    ('tick',         lambda: tick(),          SR_HI),  # 机械咔哒，极高频
    ('wheel-start',  wheel_start,             SR_LO),  # 扫频 180→420Hz
    ('wheel-loop',   wheel_spin_loop,         SR_MID),
    ('wheel-slow',   wheel_slowdown,          SR_HI),  # 一串咔哒
    ('wheel-stop',   wheel_stop,              SR_MID),
    # 情绪
    ('win',          win,                     SR_MID), # 最高 1047Hz
    ('lose',         lose,                    SR_LO),  # 最高 440Hz
    ('drink',        drink,                   SR_LO),  # 最高 392Hz
    ('clink',        clink,                   SR_HI),  # 玻璃，高频到 4.4kHz
    ('pour',         pour,                    SR_MID), # 液体，带宽较宽
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

if __name__ == '__main__':
    print(f'输出: {os.path.normpath(OUT_DIR)}')
    print('按奈奎斯特定理为每个音效挑采样率（体积 = 采样率 × 时长）\n')
    # 清掉旧文件，避免改名后留下孤儿
    if os.path.isdir(OUT_DIR):
        for f in os.listdir(OUT_DIR):
            if f.endswith('.wav'):
                os.remove(os.path.join(OUT_DIR, f))
    for name, fn, sr in ALL:
        write_wav(name, fn(), sr)
    files = [f for f in os.listdir(OUT_DIR) if f.endswith('.wav')]
    tot = sum(os.path.getsize(os.path.join(OUT_DIR, f)) for f in files)
    print(f'\n共 {len(files)} 个音效，合计 {tot/1024:.1f} KB')
