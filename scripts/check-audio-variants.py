#!/usr/bin/env python3
"""
check-audio-variants.py —— 同一音效的多个变体，响度必须一致

============ 为什么需要这条 ============

`tick` / `tick-2` / `tick-3` 是转盘咔哒的三个变体，代码里轮播使用。
`sfx.js` 里写着这样一句承诺：

    「三份的 RMS 已对齐到同一值（-16.9dBFS），不会一下轻一下响。」

而 2026-11-03 实测：tick -18.6 / tick-2 -13.6 / tick-3 -20.0 dBFS
**最大差 6.4 dB**（约 2 倍响度）。

转盘一圈要响 40 次咔哒，其中 1/3 落在 tick-2 上 ——
玩家听到的效果是「咔哒声每隔两三下就突然变响一次」。
这不会报错、不影响任何功能，只会让人觉得"这游戏声音没调好"。

============ 根因（值得记） ============

三个变体在 `import-audio.py` 里各自配了 `fifty=` 目标（-14 / -14 / -16），
而**前 50ms 能量**这个口径，对 10ms 的短音来说就等于整体 RMS ——
但它们来自三个不同的 Kenney 源文件（click_003 / click_005 / click_002），
起音形状差别很大，同样的 `fifty` 目标达不到同样的最终 RMS。

教训：**「同一个功能的一组变体」要用同一个标定量，而不是各自定一个目标值。**
三份各自"看起来合理"的 -14 / -14 / -16，合起来就是 6.4dB 的落差。

============ 判据 ============

对每一组变体，算各自的整体 RMS（dBFS），
**最大与最小之差必须 ≤ 1.0 dB**（人耳在短音上能分辨约 1dB）。

1.0 dB 这个阈值不是拍的：转盘咔哒是**高频短音**，
人耳对它的响度变化比对低频敏感，1dB 已经能听出"这一下重了"。
而 0.5dB 又太紧 —— 不同源文件的包络形状不同，硬压到 0.5 会削掉音色差异
（而音色差异正是我们做三个变体的原因）。1.0 是"听得出一致、又保得住差异"的分界。
"""
import glob
import math
import os
import struct
import sys
import wave

ROOT = os.path.join(os.path.dirname(os.path.abspath(__file__)), '..')
MP = os.path.join(ROOT, 'miniprogram')
TOLERANCE_DB = 1.0

# 变体组：组名 → 成员（文件名不带 .wav）
GROUPS = {
    'tick（转盘咔哒，一局响 40 次）': ['tick', 'tick-2', 'tick-3'],
    'dice-settle（骰子逐颗落定）': ['dice-settle', 'dice-settle-2', 'dice-settle-3'],
}


def find(name):
    """在分包和主包里找这个 wav（tick.wav 在主包，其余在分包）。"""
    for d in (os.path.join(MP, 'game', 'audio'), os.path.join(MP, 'audio')):
        p = os.path.join(d, name + '.wav')
        if os.path.exists(p):
            return p
    return None


def rms_dbfs(path):
    with wave.open(path, 'rb') as w:
        n = w.getnframes()
        raw = w.readframes(n)
        ch = w.getnchannels()
    d = struct.unpack('<%dh' % (n * ch), raw)
    if not d:
        return -99.0
    r = math.sqrt(sum(float(x) * x for x in d) / len(d))
    return 20 * math.log10(max(r, 1e-9) / 32768)


def main():
    bad = []
    rows = []
    for group, members in GROUPS.items():
        stats = []
        for m in members:
            p = find(m)
            if not p:
                rows.append((group, m, None, '文件不存在'))
                bad.append('%s：找不到 %s.wav' % (group, m))
                continue
            db = rms_dbfs(p)
            stats.append((m, db))
            rows.append((group, m, db, ''))
        if len(stats) < 2:
            continue
        mx = max(s[1] for s in stats)
        mn = min(s[1] for s in stats)
        diff = mx - mn
        if diff > TOLERANCE_DB:
            detail = '，'.join('%s %.1f' % (n, d) for n, d in stats)
            bad.append('%s：最大差 %.1f dB（阈值 %.1f）—— %s'
                       % (group, diff, TOLERANCE_DB, detail))

    print('变体响度一致性（同一组内 RMS 差必须 ≤ %.1f dB）' % TOLERANCE_DB)
    print('-' * 72)
    for group, name, db, note in rows:
        val = '  —  ' if db is None else '%6.1f' % db
        print('  %-14s %s dBFS  %s' % (name, val, note))

    if bad:
        print('\n  ✗ 变体之间响度不一致（转盘咔哒会忽轻忽重）：')
        for b in bad:
            print('    ' + b)
        print('\n  修法：按主文件（tick.wav）的 RMS 给其余变体做等增益缩放，')
        print('        然后**补 1.2ms 末帧淡出**（缩放会破坏原来的淡出）。')
        return 1

    print('\n  ✓ 各组变体响度一致')
    return 0


if __name__ == '__main__':
    sys.exit(main())
