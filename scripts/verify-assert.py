#!/usr/bin/env python3
"""
verify-assert.py —— 安全地做"反向验证"：故意改坏代码，看断言会不会报

================ 为什么需要这个工具 ================

这个项目里反复记着一条纪律：**断言必须反向验证过才可信** ——
"改坏了还照样通过"的断言比没有断言更危险（给虚假的信心）。

但我在手动做这件事时**犯了三次同一个错**：
用 `git checkout` 恢复文件，而它恢复的是**已提交版本** ——
于是**还没提交的修改**被一起冲掉，而我随后提交时没复查，
commit message 就成了不实描述（3.10.4 / 3.10.21 / 3.10.25 三次）。

这个工具把"备份 → 改坏 → 跑测试 → 恢复"做成一次原子操作：
无论测试怎么崩，`finally` 一定把文件原样写回去，
**不依赖 git，也不会碰工作区里其它未提交的改动**。

================ 用法 ================

    python3 scripts/verify-assert.py \\
      --file miniprogram/game/room/room.js \\
      --from "if (r && r.ok) {" \\
      --to   "if (false) {" \\
      --test scripts/test-room-ui.js

输出两种结论之一：
    ✓ 断言有效（改坏之后测试从 0 变 1）
    ✗ 断言是废的（改坏之后测试照样通过）

退出码：0 = 断言有效，1 = 断言无效或工具用错。
"""
import argparse
import subprocess
import sys
from pathlib import Path

ROOT = Path(__file__).resolve().parent.parent


def run_test(script):
    """跑测试，返回退出码。

    按扩展名选解释器：`.py` 用 python3，其余当 node 脚本。
    （响度层级是 `scripts/audio-levels.py`，不覆盖它的话
     "音频响度"那一类断言永远验不了。）
    """
    if script.endswith('.py'):
        cmd = 'python3 %s > /dev/null 2>&1' % script
    else:
        cmd = 'node %s > /dev/null 2>&1' % script
    p = subprocess.run(['bash', '-c', cmd], cwd=str(ROOT))
    return p.returncode


def main():
    ap = argparse.ArgumentParser(description='安全的反向验证：改坏 → 跑测试 → 恢复')
    ap.add_argument('--file', required=True, help='要改坏的文件（相对仓库根）')
    ap.add_argument('--from', dest='old', required=True, help='原文片段')
    ap.add_argument('--to', dest='new', required=True, help='替换成什么（通常是让逻辑失效）')
    ap.add_argument('--test', required=True, help='跑哪个测试脚本')
    ap.add_argument('--keep', action='store_true',
                    help='改坏后不恢复（调试用，正常不要加）')
    args = ap.parse_args()

    target = ROOT / args.file
    if not target.exists():
        print(f'✗ 文件不存在：{args.file}')
        return 1

    original = target.read_text(encoding='utf-8')
    if args.old not in original:
        print('✗ 原文片段没找到 —— 先确认它和文件里的写法完全一致（标点/缩进）')
        print('   提示：文案类改动最好按行号改，别靠记住整句。')
        return 1
    n_hit = original.count(args.old)
    if n_hit > 1:
        print(f'✗ 原文片段出现 {n_hit} 次 —— 拒绝继续。')
        print('   只替换第一处会让你验错对象（第一次栽在 `data-l` 上：')
        print('   第一次出现在**注释**里，改掉它对真正的按钮毫无影响，')
        print('   于是断言"照样通过"，看起来像断言废了 —— 其实是改错了地方）。')
        print('   请把片段加长到在文件里唯一（带上前后行），再跑一次。')
        return 1

    # ① 先确认"没改坏的时候测试是绿的"
    base = run_test(args.test)
    if base != 0:
        print(f'✗ 基线就是失败的（exit={base}）—— 先修好再谈反向验证')
        return 1

    try:
        # ② 改坏
        target.write_text(original.replace(args.old, args.new, 1), encoding='utf-8')
        bad = run_test(args.test)
    finally:
        # ③ 无论发生什么都要恢复
        if not args.keep:
            target.write_text(original, encoding='utf-8')

    if bad != 0:
        print(f'✓ 断言有效（基线 exit=0 → 改坏后 exit={bad}）')
        return 0
    print('✗ 断言是废的：改坏了它照样通过')
    print('   可能原因：① 这个改动不在断言的判据范围内')
    print('            ② 同一职责有多道防线（要全部拆掉才看得出来）')
    print('            ③ 断言读的是静态代码，看不到运行时的两帧空档')
    return 1


if __name__ == '__main__':
    sys.exit(main())
