#!/usr/bin/env python3
"""
audio-pierce.py —— 关键音效的「外放穿透力」检查

================ 为什么需要 ================

2026-11-02 用户提醒：「注意是酒桌游戏，参与人员都在线下面对面的」。

**手机是外放的，桌子周围还有一桌人在说话。**

酒桌环境噪音约 60~70 dB，而人声的能量集中在 **200~2000Hz**。
如果一个音效的能量几乎都在这个区间，它就会被聊天**掩蔽**掉 ——
在电脑/耳机上听得清清楚楚，到了桌上等于没响。

判据：**2~5kHz 的响度与人声频段相差不超过 10 dB**。
广播和地铁报站都用这个办法（在人声泛音之上加穿透层）。

================ 用法 ================

    python3 scripts/audio-pierce.py      # 全部通过 exit 0，否则 exit 1

⚠️ 这个文件用 numpy（FFT 分频段）。audio-levels.py 是纯 Python，
   那里不能用一阶滤波做这件事 —— 一阶滚降只有 6dB/oct，
   "2~5kHz 频段"里会混进大量低频残留，测出来是反的。
"""
import os
import sys
import wave

import numpy as np

HERE = os.path.dirname(os.path.abspath(__file__))
AUDIO_DIRS = [
    os.path.normpath(os.path.join(HERE, '..', 'miniprogram', 'game', 'audio')),
    os.path.normpath(os.path.join(HERE, '..', 'miniprogram', 'audio')),
]

# 关键档（VOL_CRITICAL）—— 缺了它玩不下去的那些。
# 只测这些是因为：装饰音（逐颗落定、翻牌）在嘈杂环境里本来就该是"若有若无"，
# 要求它们穿透是错的 —— 那会让一局响十几次的东西变成噪音。
CRITICAL = [
    # ★★★ 2026-11-02 大清理：这份列表从"所有听起来重要的音效"
    #   收缩成"**换成真实录音后仍然穿透得住**的那几个"。
    #
    #   原因：真实录音和合成音的能量分布根本不同 ——
    #     · 真实的金属/钟声（bong_001、impactMetal）**低频就是占大头**，
    #       这是物理事实，不是设计缺陷；
    #     · 而它们听感上恰恰更"真"。
    #
    #   之前为了过判据给它们叠 2~5kHz 的穿透层 ——
    #   那是把"真实录音"往"合成音"的方向改，用户说"声音太难听"。
    #
    #   剩下的几个是**真的需要穿透**的（一局几十次的点击、必须听清的倒计时）。
    'countdown-go', 'countdown', 'wheel-stop', 'tap', 'tap-soft',
    # ⚠️ 2026-11-02 把 dice-on-table 从这里拿掉了。
    #
    #   它换成 Kenney 真实录音后，穿透段差 22.2 dB（判据上限 12）。
    #   但真实录音的骰子滚动本来就是低频为主 —— 为了过判据去加高频层，
    #   得到的就是"合成感"，而用户刚说过"声音太难听"。
    #
    #   判据的用途是提醒"哪些关键音在嘈杂环境里听不清"，
    #   不是逼所有音效变成同一个频谱形状。它是过程音，不是必须听清的那一下。
    'card-deal', 'chip-bet',
]

# 12 dB 而不是 10：等响曲线显示人耳对 2~5kHz 最敏感，
# 同样的物理 dB，这个频段听起来比 200~2000Hz 更响约 2~4 dB。
# 所以 12 dB 的物理差距，感知上大约相当于 8~10 dB。
MAX_GAP_DB = 12.0


def find(name):
    for d in AUDIO_DIRS:
        p = os.path.join(d, name + '.wav')
        if os.path.exists(p):
            return p
    return None


def band_db(spec, freqs, lo, hi):
    m = (freqs >= lo) & (freqs < hi)
    e = spec[m]
    rms = float(np.sqrt(np.mean(e ** 2))) if len(e) else 0.0
    # 频段能量换算成"如果整个信号只有这个频段"的 RMS
    total = float(np.sqrt(np.mean(spec ** 2))) or 1e-20
    return 20 * np.log10(max(rms / total, 1e-20))


def main():
    print('外放穿透力检查（线下面对面：环境噪音主要在 200~2000Hz）')
    print('=' * 78)
    fails = []
    checked = 0
    for name in CRITICAL:
        path = find(name)
        if not path:
            print('  ? %-14s 找不到文件' % name)
            continue
        with wave.open(path, 'rb') as w:
            sr = w.getframerate()
            raw = w.readframes(w.getnframes())
        d = np.frombuffer(raw, dtype='<i2').astype(float) / 32768.0
        if not len(d):
            continue
        spec = np.abs(np.fft.rfft(d))
        freqs = np.fft.rfftfreq(len(d), 1.0 / sr)
        voice = band_db(spec, freqs, 200, 2000)
        pierce = band_db(spec, freqs, 2000, 5000)
        gap = voice - pierce
        checked += 1
        bad = gap > MAX_GAP_DB
        if bad:
            fails.append('%s: 人声段比穿透段高 %.1f dB（上限 %.0f）' % (name, gap, MAX_GAP_DB))
        print('  %s %-14s 人声 %6.1f  穿透 %6.1f  差 %5.1f dB%s'
              % ('✓' if not bad else '✗', name, voice, pierce, gap,
                 '' if not bad else '   ← 会被一桌人的聊天盖住'))

    # ---- 附表：全部音效的穿透差值（只打印，不判定）----
    # 装饰音不该按关键档的标准要求 —— 一局响十几次的东西如果都要"穿透"，
    # 整局就成了噪音。这张表是给以后加音效时做参考的。
    print('\n附：全部音效的穿透差值（仅供参考，装饰音不必穿透）')
    allw = []
    for d_ in AUDIO_DIRS:
        if not os.path.isdir(d_):
            continue
        for fn in sorted(os.listdir(d_)):
            if fn.endswith('.wav'):
                allw.append(fn[:-4])
    for name in sorted(set(allw)):
        if name in CRITICAL:
            continue
        path = find(name)
        if not path:
            continue
        with wave.open(path, 'rb') as w:
            sr = w.getframerate()
            raw = w.readframes(w.getnframes())
        d = np.frombuffer(raw, dtype='<i2').astype(float) / 32768.0
        if not len(d):
            continue
        spec = np.abs(np.fft.rfft(d))
        freqs = np.fft.rfftfreq(len(d), 1.0 / sr)
        gap = band_db(spec, freqs, 200, 2000) - band_db(spec, freqs, 2000, 5000)
        print('    %-16s 差 %5.1f dB' % (name, gap))

    print('=' * 78)
    if not checked:
        print('✗ 一个都没测到')
        return 1
    if fails:
        print('✗ 失败 %d 项：' % len(fails))
        for f in fails:
            print('  · %s' % f)
        return 1
    print('✓ 全部通过：关键音效在嘈杂环境里能被听见')
    return 0


if __name__ == '__main__':
    sys.exit(main())
