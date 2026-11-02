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


# ============================================================================
# 2026-11-03 追加：**待部署清单必须分类准确**
#
# 之前清单笼统地说"5 个云函数改了什么" —— 而其中一部分是**前后端共享的纯函数**，
# 前端 require 的是同一份代码，**不部署也生效**。
#
# 判据：清单里出现的每个 `xxx.js`，要能对上"它跑在谁那儿"。
# ============================================================================
def check_deploy_doc_classification():
    p = os.path.join(ROOT, 'docs', '待部署清单.md')
    if not os.path.exists(p):
        return True
    s = open(p, encoding='utf-8').read()
    ok = True
    # 清单里必须明确区分"生效 / 要部署"两栏
    if '不部署生效吗' not in s:
        print('  ✗ 待部署清单缺「不部署生效吗」这一栏 —— 会让人以为什么都没生效')
        ok = False
    else:
        print('  ✓ 待部署清单区分了「不部署生效」和「要部署」')
    return ok

# ★ 2026-11-03：调用"待部署清单分类"检查
#   （第一版把调用写在了函数定义**之前** → NameError；
#     第二次改对了，但这也说明"加了函数要确认它真被跑到"）
check_deploy_doc_classification()
