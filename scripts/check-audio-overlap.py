#!/usr/bin/env python3
"""
check-audio-overlap.py —— 检查"音效时间线有没有叠在一起"

================ 为什么需要 ================

用户报「声音混乱，没卡在点上」。查了三轮才定位到根因是**密度/重叠**：
一个音效还没播完，下一个就起来了，听感糊成一片。

而这类问题**只能靠量**：
  · 读代码看不出（每个 setTimeout 单独看都对）
  · 断言很难写（时间线散在各个方法里）

所以做成一个可以随时跑的表：把每个音效的**实测时长**和**调度时刻**对一遍，
超了就报。

================ 用法 ================

    python3 scripts/check-audio-overlap.py

改了任何时间线（setTimeout 延迟）之后跑一次。
"""
import os
import re
import sys
import wave

ROOT = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))
AUDIO_DIRS = [os.path.join(ROOT, 'miniprogram/game/audio'),
              os.path.join(ROOT, 'miniprogram/audio')]


def dur(name):
    """音效的实测时长（秒）；找不到返回 None。"""
    for d in AUDIO_DIRS:
        f = os.path.join(d, name + '.wav')
        if os.path.exists(f):
            with wave.open(f) as w:
                return w.getnframes() / w.getframerate()
    return None


# 需要人工维护的"时间线"：每条 = (动作名, [(音效, 起点ms), ...])
# 只列**同一动作内**会连续触发的那些 —— 跨动作的间隔本来就大，不用查。
TIMELINES = [
    ('大话骰开盅', [
        ('reveal-hit', 0),
        ('confetti', 1080),     # win（输是 fail-drop 0.93s，更短，按长的算）
        ('gulp', 2300),
    ]),
    ('比大小揭盅', [
        ('reveal-hit', 640),
        ('confetti', 1750),
    ]),
    ('转盘转动', [
        ('wheel-start', 0),
        ('tick', 34),           # 连续咔哒，本来就是密排，跳过
    ]),
]


def main():
    print('音效时间线重叠检查\n')
    bad = []
    for label, seq in TIMELINES:
        # tick 是连续咔哒，本身就是密排，不算重叠
        if any(n == 'tick' for n, _ in seq):
            print(f'  – {label}: 含连续 tick，跳过')
            continue
        print(f'  · {label}:')
        for i, (name, at) in enumerate(seq):
            d = dur(name)
            if d is None:
                print(f'    ? {name}: 找不到音频文件')
                continue
            end = at + d * 1000
            print(f'      {name:12} 起 {at:5}ms  时长 {d:.2f}s → 到 {end:.0f}ms')
            if i + 1 < len(seq):
                nxt_name, nxt_at = seq[i + 1]
                if nxt_at < end:
                    bad.append(f'{label}: {name} 还没播完({end:.0f}ms) 就起了 {nxt_name}({nxt_at}ms)'
                               f'，重叠 {end - nxt_at:.0f}ms')
    print()
    if bad:
        print('✗ 有重叠（听感会糊成一片）:')
        for b in bad:
            print('  · ' + b)
        return 1
    print('✓ 无重叠：每个音效都播完才起下一个')
    return 0


if __name__ == '__main__':
    sys.exit(main())
