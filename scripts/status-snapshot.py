#!/usr/bin/env python3
"""
status-snapshot.py —— 一眼看清"现在到哪了"

================ 两个曾经算错的数字（2026-11-02）================

① **版本号**：正则 `version:\\s*'([\\d.]+)'` 匹配到了**注释里**的一句
   「原来硬编码在 me.js 里，写着 `version: '3.7.4'`」，于是快照显示 3.7.4，
   而真实版本是 3.19.3。
   → 修法：先剥掉注释再匹配。

② **分包体积**：原来用 `du -sk`，那是**磁盘块占用**
   （每个文件按 4KB 对齐，几十个小音频浪费极多）——
   算出来 1892 KB，而文件实际只有 1589 KB。
   → 修法：按真实字节数累加。

   这件事的后果不是"数字不好看"，而是**我一直以为余量只剩 220KB，
   实际有 459KB** —— 差点因此对音频降采样（而那会伤音质）。
"""
import os
import re
import subprocess

ROOT = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))


def run(cmd):
    r = subprocess.run(cmd, cwd=ROOT, capture_output=True, text=True, timeout=900)
    return r.stdout + r.stderr


def strip_comments(src):
    src = re.sub(r'/\*[\s\S]*?\*/', '', src)
    src = re.sub(r'//[^\n]*', '', src)
    return src


def main():
    print('=' * 62)
    print('酒桌小程序 · 状态快照')
    print('=' * 62)

    cfg = strip_comments(open(os.path.join(ROOT, 'miniprogram/config.js'),
                              encoding='utf-8').read())
    m = re.search(r"^\s*version:\s*'([\d.]+)'", cfg, re.M)
    print('\n版本：%s' % (m.group(1) if m else '?'))

    out = run(['bash', 'scripts/test-all.sh'])
    print('测试：%d 项通过' % out.count('✓'))

    out = run(['python3', 'scripts/quality-score.py'])
    m = re.search(r'总分 (\d+) / (\d+)', out)
    if m:
        print('质量分：%s / %s' % (m.group(1), m.group(2)))

    size = 0
    for d, _, fs in os.walk(os.path.join(ROOT, 'miniprogram', 'game')):
        for f in fs:
            size += os.path.getsize(os.path.join(d, f))
    kb = size / 1024
    print('分包体积：%.0f KB / 2048（余量 %.0f KB）' % (kb, 2048 - kb))

    out = run(['python3', 'scripts/audio-pierce.py'])
    print('音频穿透力：%s' % ('✓ 通过' if '全部通过' in out else '✗ 有问题'))
    out = run(['python3', 'scripts/check-docs-sync.py'])
    print('验收清单同步：%s' % ('✓ 通过' if '都在验收清单里' in out else '✗ 有新功能没进清单'))

    print('\n文档（docs/）：')
    d = os.path.join(ROOT, 'docs')
    for f in sorted(os.listdir(d)):
        if f.endswith('.md'):
            lines = sum(1 for _ in open(os.path.join(d, f), encoding='utf-8'))
            print('  %-26s %4d 行' % (f, lines))


if __name__ == '__main__':
    main()
