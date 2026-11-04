#!/usr/bin/env python3
"""
size-real.py —— 估算**上传后的真实包体积**（源码会被编译压缩，原始大小不是答案）

============ 为什么需要 ============

`size.py` 报的是**源码原始文件大小**，而微信上传时：
  · `.js`   被压缩（去注释、折叠空白、缩短局部变量名）
  · `.wxml` 编译成 JS 渲染函数
  · `.wxss` 压缩成 CSS
  · 图片/音频 **原样打包**（这是唯一不缩的部分）

于是 1900 KB 的源码里，很可能有 400+ KB 是注释和缩进 ——
**按原始大小判断"快满了"会让人去做不必要的瘦身，甚至牺牲画质。**

本项目已经为这个错付过代价：AGENTS.md 记着
「`du -sk` 报 1932 KB，实际文件大小 1694 KB —— 差 238 KB 会让人误判」。

现在再往前一步：**原始文件大小同样是高估**。

============ 这个脚本怎么估 ============

不做真正的编译器（那要么装工具、要么开 IDE），只用**保守的近似**：
  · JS   → 剥注释 + 折叠空白（不去 mangle，所以是**上界**）
  · WXSS → 剥注释 + 折叠空白
  · WXML → 剥注释 + 折叠空白
  · 其它 → 原样

输出两个数：
  · 原始（= size.py 的口径，**上界的上界**）
  · 估算上传后（**更接近真实，但仍偏保守**）

⚠️ 这只是估算，不是断言。真正的数字只有上传后才知道 ——
   而上传要开 IDE，本项目明令不主动开。所以用它来**避免过度悲观**，
   不拿它当"还剩多少"的精确依据。

跑法：python3 scripts/size-real.py
"""
import os
import re
import sys

ROOT = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))
MP = os.path.join(ROOT, 'miniprogram')
GAME = os.path.join(MP, 'game')


def walk(d):
    for dp, _, fs in os.walk(d):
        for f in fs:
            yield os.path.join(dp, f)


def strip_js(s):
    """剥注释 + 折叠空白（不去变量名 → 保守上界）"""
    s = re.sub(r'/\*[\s\S]*?\*/', '', s)
    s = re.sub(r'(^|[^:\\])//[^\n]*', r'\1', s)
    s = re.sub(r'\s+', ' ', s)
    return s


def strip_css(s):
    s = re.sub(r'/\*[\s\S]*?\*/', '', s)
    s = re.sub(r'\s+', ' ', s)
    s = re.sub(r'\s*([{};:,>])\s*', r'\1', s)
    return s


def strip_wxml(s):
    s = re.sub(r'<!--[\s\S]*?-->', '', s)
    s = re.sub(r'\s+', ' ', s)
    s = re.sub(r'>\s+<', '><', s)
    return s


def main():
    raw_total = est_total = 0
    rows = []
    for p in walk(MP):
        size = os.path.getsize(p)
        raw_total += size
        ext = os.path.splitext(p)[1].lower()
        if ext in ('.js', '.wxss', '.wxml'):
            try:
                src = open(p, encoding='utf-8').read()
            except Exception:
                est = size
            else:
                if ext == '.js':
                    est = len(strip_js(src).encode('utf-8'))
                elif ext == '.wxss':
                    est = len(strip_css(src).encode('utf-8'))
                else:
                    est = len(strip_wxml(src).encode('utf-8'))
                rows.append((p, size, est, ext))
        else:
            est = size
        est_total += est

    game_raw = sum(os.path.getsize(p) for p in walk(GAME)) if os.path.isdir(GAME) else 0
    # ★★ 2026-11-04：分包估算改为**逐文件压缩后求和**，不再用全局比例摊。
    #   全局比例里混着主包（主包文本多、压缩率高），会把分包估得偏小：
    #   实测全局比例法 73%，逐文件法 77% —— 差 4 个百分点 / 约 80 KB。
    #   每个文件实际会多大，就按它自己算。评分工具 quality-score.py 同口径。
    game_est = 0
    for p in walk(GAME):
        size = os.path.getsize(p)
        ext = os.path.splitext(p)[1].lower()
        if ext in ('.js', '.wxss', '.wxml'):
            try:
                src = open(p, encoding='utf-8').read()
            except Exception:
                game_est += size
            else:
                game_est += len((strip_js(src) if ext == '.js' else
                                 strip_css(src) if ext == '.wxss' else
                                 strip_wxml(src)).encode('utf-8'))
        else:
            game_est += size
    ratio = est_total / raw_total if raw_total else 1

    print('包体积估算（源码 → 估算上传后）')
    print('=' * 50)
    print('  原始      总 %4.0f KB   分包 %4.0f KB   主包 %4.0f KB'
          % (raw_total / 1024, game_raw / 1024, (raw_total - game_raw) / 1024))
    print('  估算上传  总 %4.0f KB   分包 %4.0f KB   主包 %4.0f KB'
          % (est_total / 1024, game_est / 1024, (est_total - game_est) / 1024))
    print('  文本压缩率 %.0f%%（只作用于 js/wxss/wxml）' % ((1 - ratio) * 100))
    print()

    # 最大的几个文本文件，看压缩空间集中在哪
    rows.sort(key=lambda r: -(r[1] - r[2]))
    print('  压缩收益最大的文本文件：')
    for p, r, e, ext in rows[:5]:
        print('    %-38s %6.0f → %6.0f KB' % (os.path.relpath(p, MP), r / 1024, e / 1024))
    print()

    pct = game_est / 1024 / 2048 * 100          # ⚠️ game_est 是**字节**，不换算成 KB 会算出 74808%
    print('  分包估算占用 %.0f%% / 2048 KB' % pct)
    if pct > 95:
        print('  ⚠️ 即使按估算也算紧，该做真正的资源瘦身')
        return 1
    if game_raw / 1024 > 2048 * 0.9:
        print('  ℹ️ 原始大小已超 90%%，但估算值仍在安全区 —— 不要因此牺牲画质')
    return 0


if __name__ == '__main__':
    sys.exit(main())
