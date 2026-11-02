#!/usr/bin/env python3
"""
生成两个 tick 变体（转盘咔哒）。

为什么单独一个脚本、不改进 gen-audio.py：
  gen-audio.py 的主流程会**先删光 game/audio 下所有 wav 再重生成**，
  跑一次会把 import-audio.py 导入的 44.1kHz 真实录音全冲掉。
  所以变体只能单独生成，产物直接落到 game/audio。

变体的做法不是"调音高"（那和 playbackRate 抖动一样），而是**换波形参数**：
  · tick-2：1330Hz + 占空比 0.42 + 稍长衰减 → 更"闷"
  · tick-3：1470Hz + 占空比 0.58 + 更短衰减 → 更"脆"
三份轮播时，耳朵听到的是"指针划过不同的格子"，而不是"同一个声音变调"。
"""
import os, wave
import numpy as np

ROOT = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))
OUT = os.path.join(ROOT, 'miniprogram', 'game', 'audio')
SR = 22050
N = int(SR * 0.018)


def square(n, freq, duty):
    t = np.arange(n) / SR
    ph = (t * freq) % 1.0
    return np.where(ph < duty, 1.0, -1.0)


def env_ad(n, attack_s, tau_s):
    """起音 + **指数**衰减（照抄 gen-audio.py 的同名函数）。

    第一版写成了"前 70% 满幅、最后 30% 线性降"——那不是敲击，是"方波块"：
    半峰样本 324（14.69ms），而原版 tick 只有 61（2.77ms），
    整体 RMS 比主文件响 7.4dB。撞击声的"短促"全靠指数尾巴。
    """
    attack = max(1, int(SR * attack_s))
    tau = max(1.0, SR * tau_s)
    i = np.arange(n)
    a = np.clip(i / attack, 0.0, 1.0)
    return a * np.exp(-np.maximum(0, i - attack) / tau)


def read_stats(path):
    with wave.open(path, 'rb') as w:
        d = np.frombuffer(w.readframes(w.getnframes()), dtype='<i2').astype(np.float64) / 32767.0
    return np.max(np.abs(d)), np.sqrt(np.mean(d ** 2))


def make(freq, duty, tau_s, target_rms):
    s = square(N, freq, duty) * env_ad(N, 0.0004, tau_s) * 0.5
    # ★ 必须去直流（2026-10-30，被 audio-levels 拦下的）：
    #   方波占空比不是 50% 时，正半周和负半周宽度不等 -> 天然带直流偏置
    #   （实测 tick-2 DC=1882、tick-3 DC=2124，而阈值是 50）。
    #   DC 偏置会让每次播放"噗"一声（扬声器被推到一边再弹回）。
    s = s - np.mean(s)
    # 按 **RMS** 对齐而不是峰值：人耳对响度的感知接近 RMS，
    # 按峰值对齐会让"尾巴长的那份"听起来更响（实测差过 7.4dB）。
    cur_rms = np.sqrt(np.mean(s ** 2)) or 1e-9
    s = s / cur_rms * target_rms
    # 峰值保护：对齐后若超过 0.95 就整体缩小（宁可轻一点也不削波）
    pk = np.max(np.abs(s))
    if pk > 0.95:
        s *= 0.95 / pk
    return np.clip(s, -1.0, 1.0)


def write(path, s):
    d = (s * 32767.0).astype('<i2')
    with wave.open(path, 'wb') as w:
        w.setnchannels(1)
        w.setsampwidth(2)
        w.setframerate(SR)
        w.writeframes(d.tobytes())
    print(f'  → {os.path.basename(path)}  {len(d)} 采样  {len(d) * 2} 字节')


def main():
    """
    ⚠️ 2026-11-02：`tick` 已经换成 Kenney 的真实录音（click_003），
    而本脚本生成的是**合成的** 1330Hz / 1470Hz 脉冲变体 ——
    跑它会把这个音效的三个变体变成"合成 + 真实"混搭。

    所以默认**不生成**，要用显式 `--force` 才跑：

        python3 scripts/gen-tick-variants.py --force

    （保留它是因为变体机制本身还有用：如果要换一套新的真实录音，
      这里可以改成"基于真实 tick 做音高/衰减变化"而不是重新合成。）
    """
    import sys as _sys
    if '--force' not in _sys.argv:
        print('跳过：tick 系列现在是真实录音，跑本脚本会把变体换回合成音。')
        print('      确实要重新生成请加 --force')
        return

    main_tick = os.path.join(OUT, 'tick.wav')
    if not os.path.exists(main_tick):
        raise SystemExit('找不到 tick.wav')
    peak, rms = read_stats(main_tick)
    print(f'主 tick 峰值 {peak:.3f} / RMS {rms:.4f}（变体按同 RMS 对齐）')
    # 占空比和频率是"音色"，tau 是"尾长"—— 三个维度都略不同才像不同录音
    write(os.path.join(OUT, 'tick-2.wav'), make(1330, 0.42, 0.0030, rms))
    write(os.path.join(OUT, 'tick-3.wav'), make(1470, 0.58, 0.0020, rms))


if __name__ == '__main__':
    main()
