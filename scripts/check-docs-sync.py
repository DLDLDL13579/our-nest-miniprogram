"""
检查「新功能有没有进验收清单」—— 用"代码里有的关键概念"去对照文档。

这类漂移不会报错：功能做完了、测试全绿、但**上线前没人知道要验它**。
"""
import os
import re

ROOT = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))

# 概念 → (代码里的证据片段, 文档里应该出现的词)
CONCEPTS = [
    ('比大小的牌型系统', 'miniprogram/utils/dicerank.js', ['FULL_HOUSE', 'STRAIGHT'],
     'docs/真机验收清单.md', ['牌型', '葫芦']),
    ('单骰重摇', 'cloudfunctions/room/index.js', ["action === 'reroll'"],
     'docs/真机验收清单.md', ['单骰', '重摇']),
    ('围骰/全围分级', 'cloudfunctions/room/liarCount.js', ['cnt += 2'],
     'docs/真机验收清单.md', ['全围', '7 个']),
    ('起叫 1.5 倍', 'miniprogram/utils/liarRules.js', ['Math.ceil(p * 1.5)'],
     'docs/真机验收清单.md', ['起叫', '1.5']),
]

bad = []
for name, code_file, code_keys, doc_file, doc_keys in CONCEPTS:
    code = open(os.path.join(ROOT, code_file), encoding='utf-8').read()
    doc_path = os.path.join(ROOT, doc_file)
    doc = open(doc_path, encoding='utf-8').read() if os.path.exists(doc_path) else ''
    has_code = all(k in code for k in code_keys)
    has_doc = all(k in doc for k in doc_keys)
    if has_code and not has_doc:
        bad.append('%s：代码里有，但 %s 没提到（%s）'
                   % (name, doc_file, ' / '.join(doc_keys)))

if bad:
    print('✗ 新功能没进验收清单 %d 处：' % len(bad))
    for b in bad:
        print('    · ' + b)
    raise SystemExit(1)
print('  ✓ %d 个新功能都在验收清单里（%s）'
      % (len(CONCEPTS), '牌型/单骰重摇/围骰分级/起叫'))
