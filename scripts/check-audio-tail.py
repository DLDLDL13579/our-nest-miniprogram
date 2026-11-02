#!/usr/bin/env python3
"""
check-audio-tail.py —— 检查音效**结尾有没有爆音**

============ 判据是什么 ============

爆音的成因是"最后一帧突然从某个非零值跳到 0"（或反之）——
所以判据是**末帧的绝对值相对峰值**，不是"尾部能量"。

⚠️ 我第一版判的是"尾部 50ms 能量 < 20%"，结果报出三个"问题"：
     charge-up 45%   countdown-go 28.7%   toggle-off 25.5%
而它们的**末帧都是 0.0%** —— 完全干净。

**能量高不等于爆音**：
  · `charge-up` 是上升音，本来就在峰值附近结束（设计如此）
  · `countdown-go` 是"叮"，余音本来就强

真正的爆音是"末帧不为零" —— 而 `fade_edges(ms=1.2)` 已经在生成时处理了。

★ 判据：**"听起来会不会咔"取决于「最后一帧到 0 的跳变」，不是「尾部有多响」。**
"""
import glob
import os
import sys

import numpy as np
import wave

bad = []
checked = 0

for p in sorted(glob.glob(os.path.join(os.path.dirname(__file__), '..',
                                        'miniprogram', 'game', 'audio', '*.wav'))):
    name = os.path.basename(p)[:-4]
    with wave.open(p) as w:
        n = w.getnframes()
        data = np.frombuffer(w.readframes(n), dtype=np.int16).astype(float)
        if w.getnchannels() == 2:
            data = data.reshape(-1, 2).mean(axis=1)
    peak = np.max(np.abs(data)) if len(data) else 0
    if not peak:
        continue
    checked += 1
    last = abs(data[-1]) / peak
    if last > 0.05:
        bad.append('%s：末帧 %.1f%% 峰值（结尾没淡到 0，会"咔"一声）' % (name, last * 100))

if bad:
    print('  ✗ 这些音效结尾有爆音风险：')
    for b in bad:
        print('    ' + b)
    sys.exit(1)

print('  ✓ %d 个音效的末帧都已淡到 0（没有爆音）' % checked)
