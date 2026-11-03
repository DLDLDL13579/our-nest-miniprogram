#!/usr/bin/env python3
"""
size.py —— 报包体积（**实际文件大小**，不是磁盘占用）

============ 为什么不用 du ============

`du -sk miniprogram/game` 报的是**磁盘占用**（按块对齐，每个文件都向上取整到 4KB）。
小文件多的目录会**显著偏大**：

    du -sk   → 1932 KB
    实际大小 → 1694 KB     ← 差 238 KB，而后者才是小程序算的数

而那 238 KB 的差会让人误判"快到 2048 上限了"，去做不必要的瘦身。
"""
import os
import sys


def size_of(d):
    return sum(os.path.getsize(os.path.join(dp, f))
               for dp, _, fs in os.walk(d) for f in fs)


def main():
    root = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))
    game = os.path.join(root, 'miniprogram', 'game')
    main_pkg = size_of(os.path.join(root, 'miniprogram'))
    sub = size_of(game) if os.path.isdir(game) else 0

    print('  分包 %4.0f KB / 2048  (%.0f%%)' % (sub / 1024, sub / 1024 / 2048 * 100))
    print('  主包 %4.0f KB' % ((main_pkg - sub) / 1024))

    if sub / 1024 > 2048 * 0.9:
        print('  ⚠️ 分包已用 90% 以上')
        return 1
    return 0


if __name__ == '__main__':
    sys.exit(main())
