#!/usr/bin/env python3
"""
check-branch-owner.py —— 查「玩法专属的字段/动作有没有跑错分支」

============ 为什么需要这个 ============

2026-11-03 的教训：`revealprog`（揭晓进度条）看起来"条件满足却没渲染"，
查了半天发现它**在 `<block wx:elif="dice">` 分支里**，而我在大话骰状态上看它。

**`wx:if` 的缩进在代码里，在运行时会变成"互斥的路径"。**

============ ⚠️ 这个脚本第一版是错的 ============

第一版按 `<block wx:elif="{{room.game === 'x'}}">` 切分，然后"最后一段"延伸到文件末尾 ——
于是**结算区（`stage === 'over'`）的内容全被算进了最后一个玩法分支（wheel）**，
报出 `uw-reveal 属于 undercover 却出现在 wheel` 这种假阳性。

**正确做法：玩法分支必须在下一个 `stage === '...'` 处结束。**

这条记在这里，因为"按开始标签切分、忘了结束条件"是解析模板类脚本的通病。
"""
import os
import re
import sys

ROOT = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))
WXML = os.path.join(ROOT, 'miniprogram/game/room/room.wxml')

# 玩法 → 只属于它的字段/动作
# ⚠️ 这里的名字必须是**模板里真实存在的** ——
#   第一版我写了 doPkVs / uwWord / uw-talk，而它们根本不在 wxml 里（误报三条）。
OWNERSHIP = {
    'wheel': ['wheelGradient', 'wheelDeg', 'wheelscene', 'doSpin', 'ws-disc'],
    'dice': ['canReroll', 'revealprog', 'doRoll'],
    'poker': ['pk-flip', 'myKnown', 'pkVs', 'pkSwap', 'pkFold'],
    'undercover': ['uwVote', 'uwSay'],
    'liar': ['doBid', 'doOpen', 'doPi'],
}


def main():
    s = open(WXML, encoding='utf-8').read()

    # 玩法分支的起点
    marks = [(m.start(), m.group(1)) for m in
             re.finditer(r'<block wx:(?:if|elif)="\{\{room\.game === \'(\w+)\'\}\}">', s)]
    # 每个玩法的"下一个区块"起点（结算区 / 其他 stage）
    stage_marks = [(m.start(), m.group(1)) for m in
                   re.finditer(r'<block wx:elif="\{\{stage === \'(\w+)\'\}\}">', s)]

    segs = {}
    for idx, (pos, game) in enumerate(marks):
        # 结束点：下一个玩法分支 或 下一个 stage 区块，取更近的那个
        ends = [p for p, _ in marks[idx + 1:]] + [p for p, _ in stage_marks if p > pos]
        # 也考虑同层的 </block> —— 但这里用"下一个标记"已经够了
        end = min(ends) if ends else len(s)
        segs.setdefault(game, '')
        segs[game] += s[pos:end]

    problems = []
    for game, fields in OWNERSHIP.items():
        for f in fields:
            owners = [g for g, body in segs.items() if f in body]
            if not owners:
                problems.append('%s（属于 %s）不在任何玩法分支里' % (f, game))
            elif game not in owners:
                problems.append('%s（属于 %s）却出现在 %s 分支' % (f, game, ' / '.join(owners)))

    if problems:
        print('  ⚠️ 分支归属可疑：')
        for p in problems:
            print('    ' + p)
        return 1

    print('  ✓ %d 个玩法专属字段/动作都在正确的分支里' % sum(len(v) for v in OWNERSHIP.values()))
    return 0


if __name__ == '__main__':
    raise SystemExit(main())
