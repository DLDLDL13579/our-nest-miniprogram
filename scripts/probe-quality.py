#!/usr/bin/env python3
"""
probe-quality.py —— **验证质量分工具本身会不会报警**

============ 为什么需要这个 ============

AGENTS.md 里记着一条元问题：

> 我对被测代码要求反向验证，却对自己造的工具从不设防。

`quality-score.py` 给出"40/40"这个数字 —— 而**没人验证过它会不会变红**。
一个永远给满分的评分脚本，和没有评分脚本是一样的。

这个脚本用"故意改坏 → 看它报不报 → 立刻恢复"的方式抽查几项。

============ 第一次跑就踩到一个坑（但坑不在这边）============

抽查"字号"时只加了 1 个新档位（47rpx），判据**没有报** ——
我第一反应是"工具失效了"。

而**实际是它能正常工作**：字号从 10 档变 11 档，而阈值是 ≤12 ——
**上一轮我特意留的 2 档余量在按设计工作**。

要真的触发，得加 3 个不同档位。

★ 判据：**"没报警"不等于"判据失效" —— 先算一遍"该不该报"。**
  这和 AGENTS.md 里那条「"断言没报"不等于"断言废了"，先归因再下结论」
  是完全同一个错误，只是对象从断言换成了评分工具。
"""
import os
import shutil
import subprocess
import tempfile

ROOT = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))
WXSS = os.path.join(ROOT, 'miniprogram/game/room/room.wxss')

PROBES = [
    ('字号收敛', WXSS,
     '\n.ps1 { font-size: 47rpx }\n.ps2 { font-size: 51rpx }\n.ps3 { font-size: 58rpx }\n',
     '字号'),
    ('圆角不成灾', WXSS,
     '\n.pr1 { border-radius: 33rpx }\n.pr2 { border-radius: 37rpx }\n',
     '圆角'),
]


def run_score():
    r = subprocess.run(['python3', 'scripts/quality-score.py'], cwd=ROOT,
                       capture_output=True, text=True)
    return r.stdout


def main():
    ok = True
    for name, path, inject, keyword in PROBES:
        bak = path + '.probe-bak'
        shutil.copy(path, bak)
        try:
            with open(path, 'a', encoding='utf-8') as f:
                f.write(inject)
            out = run_score()
            red = [l for l in out.split('\n') if keyword in l and ('△' in l or '✗' in l)]
            if red:
                print('  ✓ %-8s 改坏后确实报警：%s' % (name, red[0].strip()[:40]))
            else:
                print('  ✗ %-8s 改坏了但没报警 —— 这条判据可能是废的' % name)
                ok = False
        finally:
            shutil.move(bak, path)
    return 0 if ok else 1


if __name__ == '__main__':
    raise SystemExit(main())
