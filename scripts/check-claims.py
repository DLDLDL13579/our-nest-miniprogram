#!/usr/bin/env python3
"""
check-claims.py —— 检查「注释里声称有断言」的地方，断言是否真的存在

============ 为什么需要这个 ============

2026-11-03 的教训：`decks.js` 里写着
「收录标准里最容易违反的一条是两副牌里出现同一道题（给断言用）」——
而全仓**没有任何去重断言**。注释说"给断言用"，那个断言不存在。

同一天，`feedback.js` 写着「这个决定有断言锁着（test-game.js ⑦）」——
那条**确实存在**。

两者看起来一模一样，只有查过才知道差别。
所以这个脚本把"注释里的断言承诺"抽出来，逐个去找。

============ 判据 ============

注释里出现 `断言` / `锁着` / `会被断言` 等词时，最好带上**文件名或编号**：
  · 带文件名的（`test-game.js ⑦`）→ 直接去那个文件找
  · 不带文件名的 → 报"无法定位"，提示补上出处
"""
import os
import re
import sys

ROOT = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))
SRC = os.path.join(ROOT, 'miniprogram')
SCRIPTS = os.path.join(ROOT, 'scripts')

CLAIM = re.compile(r'(有断言|断言锁|断言守着|会被断言|给断言用)')

def py_files(d, ext):
    out = []
    for base, _, files in os.walk(d):
        for f in files:
            if f.endswith(ext):
                out.append(os.path.join(base, f))
    return out

def main():
    test_src = ''
    for p in py_files(SCRIPTS, '.js'):
        if '/test-' in p or '\\test-' in p:
            test_src += open(p, encoding='utf-8').read()

    problems = []
    for p in py_files(SRC, '.js'):
        try:
            lines = open(p, encoding='utf-8').read().split('\n')
        except Exception:
            continue
        for i, l in enumerate(lines):
            if not CLAIM.search(l):
                continue
            # 找这句话附近提到的测试文件名
            ctx = '\n'.join(lines[max(0, i - 6):i + 7])
            m = re.search(r'(test-[\w-]+\.js)', ctx)
            rel = os.path.relpath(p, ROOT)
            if m:
                # 只检查"那个测试文件存在且非空"
                tf = os.path.join(SCRIPTS, m.group(1))
                if not os.path.exists(tf):
                    problems.append('%s:%d 提到 %s，但那个文件不存在' % (rel, i + 1, m.group(1)))
                else:
                    print('  ✓ %s:%d → %s 存在' % (rel, i + 1, m.group(1)))
            else:
                problems.append('%s:%d 说"有断言"但没写是哪个测试（无法定位）' % (rel, i + 1))

    if problems:
        print('')
        for x in problems:
            print('  ⚠️ ' + x)
        print('')
        print('  （这些"承诺"需要补上出处：注释里写清是哪个文件的哪一项）')
        return 1

    print('  ✓ 注释里的断言承诺都指得出出处')
    return 0

if __name__ == '__main__':
    raise SystemExit(main())
