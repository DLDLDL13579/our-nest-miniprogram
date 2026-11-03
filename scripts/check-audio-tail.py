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

"""

★ 2026-11-03 补两个漏洞（都是"断言看着在工作，其实漏了一半"）：

① **原来只扫分包 `game/audio/`，漏掉主包 `audio/`。**
   主包里躺着 `tick.wav`（「我的」页试听用的那个），它一样会在扬声器上放，
   一样能爆音 —— 而它从来没被这条断言看过。

② **5% 的阈值太宽，把真实的爆音放过去了。**
   `tick-2` 对齐响度后末帧是 403，相对峰值 2.4% —— 低于 5%，静默通过。
   而 403 在 16bit 下约 -38dBFS，从那里一步跳到 0 是听得见的「嗒」。
   阈值收到 **1%**，并且报告里带绝对值和 dBFS ——
   否则"2.4%"读起来像是无关紧要。
"""

MP = os.path.join(os.path.dirname(__file__), '..', 'miniprogram')
AUDIO_FILES = []
for _d in (os.path.join(MP, 'game', 'audio'), os.path.join(MP, 'audio')):
    AUDIO_FILES.extend(glob.glob(os.path.join(_d, '*.wav')))

for p in sorted(AUDIO_FILES):
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
    if last > 0.01:
        bad.append('%s：末帧 %d / %d = %.1f%% 峰值（约 %.0f dBFS）—— 结尾没淡到 0，会"咔"一声'
                   % (name, abs(data[-1]), peak, last * 100,
                      20 * np.log10(max(1.0, abs(data[-1])) / 32768)))

if bad:
    print('  ✗ 这些音效结尾有爆音风险：')
    for b in bad:
        print('    ' + b)
    sys.exit(1)

print('  ✓ %d 个音效的末帧都已淡到 0（扫了主包 + 分包全部 wav）' % checked)
