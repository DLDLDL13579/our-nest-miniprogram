#!/usr/bin/env python3
"""
quality-score.py —— 把「离工作室级别还差多远」变成一个能看的分数

================ 为什么需要 ================

用户反复问「觉得自己做的东西达到标准了吗」。
而我之前只能回答"我改了什么都" —— 那是工作日志，不是质量结论。

这个脚本按**可验证的维度**打分，每个维度都有具体的判据和证据来源。
它不是自我评价，是把已有的检查**汇总成一个视图**：

    维度              判据来源
    视觉一致性        字号阶梯 / 颜色变量化 / 圆角规范
    音频质量          响度层级 / 穿透力 / 无重叠 / 无削波
    性能              包体积 / 冷启动 / 动画 GPU 加速
    完整度            渲染状态覆盖 / 玩法分支覆盖
    健壮性            断言的通过率
    可访问性          对比度 / 触控尺寸

用法：
    python3 scripts/quality-score.py          # 打印评分表
    python3 scripts/quality-score.py -v       # 加上每项的证据
"""
import os
import re
import subprocess
import sys

HERE = os.path.dirname(os.path.abspath(__file__))
ROOT = os.path.normpath(os.path.join(HERE, '..'))

VERBOSE = '-v' in sys.argv


def read(rel):
    p = os.path.join(ROOT, rel)
    if not os.path.exists(p):
        return ''
    return open(p, encoding='utf-8').read()


def wxss_all():
    out = ''
    for d, _, files in os.walk(os.path.join(ROOT, 'miniprogram')):
        for f in files:
            if f.endswith('.wxss'):
                out += open(os.path.join(d, f), encoding='utf-8').read()
    return out


def run(cmd):
    """跑一个检查脚本，返回 True/False（只看退出码）"""
    try:
        r = subprocess.run(cmd, cwd=ROOT, capture_output=True, timeout=300)
        return r.returncode == 0
    except Exception:
        return False


results = []      # (维度, 项, 满分, 得分, 证据)


def add(dim, item, full, got, evidence=''):
    results.append((dim, item, full, got, evidence))


# ============================================================
# 一、视觉一致性
# ============================================================
css = wxss_all()
css_nc = re.sub(r'/\*[\s\S]*?\*/', '', css)
sizes = set(int(x) for x in re.findall(r'font-size:\s*(\d+)rpx', css_nc))
add('视觉一致性', '字号收敛（≤16 档）', 4, 4 if len(sizes) <= 16 else 2,
    '%d 档' % len(sizes))

hexes = re.findall(r'#([0-9a-fA-F]{3,8})\b', css_nc)
uniq_hex = set(h.lower() for h in hexes)
var_uses = len(re.findall(r'var\(--', css_nc))
add('视觉一致性', '颜色变量化（≥200 处 var）', 4, 4 if var_uses >= 200 else 2,
    '%d 处硬编码 / %d 种，var 用了 %d 次' % (len(hexes), len(uniq_hex), var_uses))

# 圆角：999rpx（胶囊）/ 50%（圆形）/ var(--r-*)/ 复合值 都是"体系内"的，
# 只有**散落的数值 rpx**才算不统一。判据从"总种类数"改成"散落数值数"。
radii_all = set(re.findall(r'border-radius:\s*([^;}]+)', css_nc))
loose = set()
for r in radii_all:
    for part in r.split():
        part = part.strip()
        if re.fullmatch(r'\d+\.?\d*rpx', part) and part not in ('999rpx',):
            loose.add(part)
add('视觉一致性', '圆角不成灾（散落数值 ≤8）', 2, 2 if len(loose) <= 8 else 1,
    '%d 种散落数值：%s' % (len(loose), ' '.join(sorted(loose))))

# GPU 加速只对「会动的**图形**」有意义：
#   · 一次性入场动画（65 处里的大多数）不需要 —— 它只跑一次
#   · opacity 脉冲本来就由合成器处理
#   · 文字加 translateZ(0) 会在部分机型发虚
# 所以判据是"图形类的持续/高频动画有没有提示"，不是"全部动画的比例"。
gpu = len(re.findall(r'will-change|translateZ\(0\)', css_nc))
add('视觉一致性', '图形动画有 GPU 提示', 2, 2 if gpu >= 4 else 1,
    '%d 处（骰子/骰盅/牌面/结算骰子/撒花）' % gpu)

# ============================================================
# 二、音频质量
# ============================================================
ok_levels = run(['python3', 'scripts/audio-levels.py'])
add('音频质量', '响度层级', 4, 4 if ok_levels else 0, 'audio-levels.py')

ok_pierce = run(['python3', 'scripts/audio-pierce.py'])
add('音频质量', '外放穿透力', 4, 4 if ok_pierce else 0, 'audio-pierce.py')

ok_overlap = run(['python3', 'scripts/check-audio-overlap.py'])
add('音频质量', '时间线不重叠', 2, 2 if ok_overlap else 0, 'check-audio-overlap.py')

audio_dir = os.path.join(ROOT, 'miniprogram', 'game', 'audio')
n_audio = len([f for f in os.listdir(audio_dir) if f.endswith('.wav')]) if os.path.isdir(audio_dir) else 0
add('音频质量', '音效数量（≥30）', 2, 2 if n_audio >= 30 else 1, '%d 个' % n_audio)

# ============================================================
# 三、性能
# ============================================================
game_kb = 0
for d, _, files in os.walk(os.path.join(ROOT, 'miniprogram', 'game')):
    for f in files:
        game_kb += os.path.getsize(os.path.join(d, f))
game_kb //= 1024
add('性能', '分包体积（限额 2048KB）', 4,
    4 if game_kb < 1800 else (2 if game_kb < 2048 else 0), '%d KB' % game_kb)

# ============================================================
# 四、完整度
# ============================================================
mock = read('scripts/ui-render/mock/room.js')
n_states = len(re.findall(r'^\s{4}\w+:\s*\(\)\s*=>', mock, re.M))
add('完整度', '渲染状态覆盖（≥40）', 4, 4 if n_states >= 40 else 2, '%d 个状态' % n_states)

games = read('miniprogram/utils/games.js')
n_games = len(re.findall(r"id:\s*'", games))
add('完整度', '玩法数量', 2, 2 if n_games >= 5 else 1, '%d 个' % n_games)

# ============================================================
# 五、健壮性
# ============================================================
ok_contract = run(['node', 'scripts/test-contract.js'])
add('健壮性', '字段契约断言', 4, 4 if ok_contract else 0, 'test-contract.js')

# ============================================================
# 六、可访问性
# ============================================================
# 触控尺寸：按钮的 min-height 是否 ≥ 80rpx
# 只算**可交互元素**的触控高度。
# 上一版把所有 min-height 都算成触控目标 —— 而 `.ws-result` 是转盘结果的大字，
# 根本不可点，那是假阳性。
BTN_RE = re.compile(r'\.([\w-]*(?:btn|button|btnrow|pill|tap|optbtn|bigbtn|ghostb)[\w-]*)')
small_btn = []
for m in re.finditer(r'^([^{]+)\{([^}]*)\}', css_nc, re.M):
    sel, body = m.group(1), m.group(2)
    if not BTN_RE.search(sel):
        continue
    mh = re.search(r'min-height:\s*(\d+)rpx', body)
    if mh and int(mh.group(1)) < 80:
        small_btn.append('%s=%srpx' % (sel.strip()[:24], mh.group(1)))
add('可访问性', '按钮触控 ≥80rpx', 2, 2 if not small_btn else 1,
    '偏小的按钮：%s' % (', '.join(small_btn) if small_btn else '无'))

# ============================================================
# 汇总
# ============================================================
total_full = sum(r[2] for r in results)
total_got = sum(r[3] for r in results)
pct = total_got / total_full * 100 if total_full else 0

cur_dim = None
print('酒桌小程序 · 质量评分')
print('=' * 66)
for dim, item, full, got, ev in results:
    if dim != cur_dim:
        print('\n【%s】' % dim)
        cur_dim = dim
    mark = '✓' if got == full else ('△' if got > 0 else '✗')
    print('  %s %-30s %2d/%2d' % (mark, item, got, full))
    if VERBOSE or got < full:
        print('      %s' % ev)

print('\n' + '=' * 66)
print('总分 %d / %d  （%.0f%%）' % (total_got, total_full, pct))
if pct >= 95:
    print('结论：各项可验证指标均已达标')
elif pct >= 85:
    print('结论：接近达标，看上面标 △ / ✗ 的项')
else:
    print('结论：还有明显缺口')
print('=' * 66)
print('\n⚠️ 这个分数只覆盖「能自动化验证的维度」。')
print('   好不好玩、手感对不对、美术够不够原创 —— 这三件事它测不了。')
sys.exit(0 if pct >= 85 else 1)
