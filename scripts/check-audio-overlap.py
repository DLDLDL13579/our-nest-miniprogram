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


def _candidates(name):
    """音效 key 与文件名不一定同名：tapSoft → tap-soft.wav / tapSoft.wav 都要试。"""
    kebab = re.sub(r'(?<!^)(?=[A-Z])', '-', name).lower()
    return [name, kebab, name.lower(), kebab.replace('-', '')]


def dur(name):
    """音效的实测时长（秒）；找不到返回 None。"""
    for cand in _candidates(name):
        for d in AUDIO_DIRS:
            f = os.path.join(d, cand + '.wav')
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


def extract_from_code():
    """
    从 room.js 里自动提取"带延迟的音效调度"。

    ★ 为什么不让时间线硬编码在工具里（2026-10-30）：
      第一版是手写三条时间线 —— 只要有人新加一个 setTimeout + sfx.play，
      这个工具就**看不见**，等于又多一处没人查的重叠风险。
      改成从代码里抽，新加的音效调度自动进入检查范围。
    """
    room_js = os.path.join(ROOT, 'miniprogram/game/room/room.js')
    src = open(room_js, encoding='utf-8').read()
    out = []
    for m in re.finditer(r'setTimeout\(\s*\(\)\s*=>\s*', src):
        i = m.end()
        if src[i] != '{':
            j = src.find(',', i)
            seg = src[i:j]
            n = re.search(r',\s*(\d+)\s*\)', src[j:j + 30])
            hit = re.search(r"sfx\.play\('(\w+)'", seg)
            if n and hit:
                out.append((int(n.group(1)), hit.group(1)))
            continue
        depth, j = 0, i
        while j < len(src):
            if src[j] == '{':
                depth += 1
            elif src[j] == '}':
                depth -= 1
                if depth == 0:
                    break
            j += 1
        body = src[i:j + 1]
        n = re.search(r'\}\s*,\s*(\d+)\s*\)', src[j:j + 20])
        if not n:
            continue
        delay = int(n.group(1))
        for name in re.findall(r"sfx\.play\('(\w+)'", body):
            out.append((delay, name))
    return out


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
    # ---- 从代码自动提取（新加的调度也会进来） ----
    print('\n  从 room.js 自动提取的延迟音效:')
    code_hits = sorted(extract_from_code())
    for delay, name in code_hits:
        d = dur(name)
        tail = f'时长 {d:.2f}s → 到 {delay + d * 1000:.0f}ms' if d else '（找不到音频文件）'
        print(f'     +{delay:5}ms  {name:12} {tail}')
    # 相邻两条的间隔 < 前一条时长 → **提示**（不判失败）
    #
    # ⚠️ 这里只提示不判红：自动提取**分不清两次调度属于哪个动作**。
    #    发牌时连发两张（90/180ms）本来就该叠着，那是自然的"刷刷"；
    #    而开盅那三声叠在一起才是问题。
    #    所以：**同一条链**的重叠由上面手写的时间线判，跨动作的只提示。
    hints = []
    for i in range(len(code_hits) - 1):
        (d1, n1), (d2, n2) = code_hits[i], code_hits[i + 1]
        dur1 = dur(n1)
        if dur1 and d2 < d1 + dur1 * 1000:
            hints.append(f'{n1}(起 {d1}ms, 长 {dur1:.2f}s) 与 {n2}(起 {d2}ms) 相隔 '
                         f'{d2 - d1}ms —— 若属同一动作则重叠 {d1 + dur1 * 1000 - d2:.0f}ms')
    if hints:
        print('\n  提示（可能重叠，需人工判断是否同一动作）:')
        for h in hints:
            print('    · ' + h)

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
