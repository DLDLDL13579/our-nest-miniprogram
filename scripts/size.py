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

    # ★★ 2026-11-04：上面这两个数是**源码原始大小**，而上传时 js/wxss/wxml
    # 会被编译压缩 —— 所以它是**上界**，不是真实占用。
    # 实测（scripts/size-real.py）：原始 1900 KB → 估算上传后 1496 KB（73%）。
    # ⚠️ 这个「上界」已经误导过我一次：按 93% 判断「余量只剩 148 KB，先做体积优化」，
    # 差点因此去压画质。真实余量其实有 550 KB 左右。
    if sub / 1024 > 2048 * 0.9:
        print('  ℹ️ 分包原始大小已超 90%（源码口径）。真实占用看：python3 scripts/size-real.py')
    return 0


if __name__ == '__main__':
    sys.exit(main())
