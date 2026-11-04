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
# ★ 2026-11-03：字号判据的两轮修正 —— 这条很值得记。
#
#   第一轮：判据是 ≤16，而**实际正好 16 档** → 「刚好不报警」等于没有判据。
#   第二轮：收到 12 档、判据也改成 ≤12 → **又卡在边界**（同一个错误犯了两次）。
#   第三轮：实际收到 **10 档**，判据保持 ≤12 —— 这才有真正的 2 档余量：
#          · 加 1~2 个字号不会报警（合理波动）
#          · 加到第 3 个就报（真的失控了）
#
#   **判据不是"卡住当前值"，是"卡住当前值 + 一点余量"。**
#   卡死当前值会让每次微调都报警，而完全不留余量会让它变成摆设。
add('视觉一致性', '字号收敛（≤12 档）', 4, 4 if len(sizes) <= 12 else 2,
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
# ★★ 2026-11-04：体积评分改用 **size-real.py 的估算口径**，不再用原始字节。
#
#   起因很荒谬：给「换个玩法」布局修了段 1.5KB 的注释，质量分从 40 掉到 38
#   —— 只因为原始大小刚好卡在 1900 KB 阈值上，注释把它推了过去。
#   而**注释在上传时会被剥离**（size-real.py 就是干这个的），
#   惩罚注释等于惩罚"把设计理由写清楚"。
#
#   这是「分配与查找必须同一判据」的又一例：size-real.py 早已写着
#   「原始大小已超 90%，但估算值仍在安全区 —— 不要因此牺牲画质」，
#   而评分工具还在用原始字节判，两个工具口径不一致。
#
#   判据：评分和体积报告必须读同一个数 —— **估算上传后的占用**。
#   阈值按真实上限：估算 < 85% 满分（还有约 300 KB 余量，够加素材），
#   < 95% 给一半，再高 0 分。85% 不是「快满了」，是「该留意了」。
# size-real.py 带连字符，不能普通 import —— 按路径加载，两处共用同一份实现
import importlib.util  # noqa: E402
_spec = importlib.util.spec_from_file_location(
    'size_real', os.path.join(ROOT, 'scripts', 'size-real.py'))
_size_real = importlib.util.module_from_spec(_spec)
_spec.loader.exec_module(_size_real)
strip_js, strip_css, strip_wxml = (_size_real.strip_js, _size_real.strip_css,
                                  _size_real.strip_wxml)

def _est_bytes(root):
    raw = est = 0
    for d, _, files in os.walk(root):
        for f in files:
            p = os.path.join(d, f)
            size = os.path.getsize(p)
            raw += size
            ext = os.path.splitext(f)[1].lower()
            if ext in ('.js', '.wxss', '.wxml'):
                try:
                    src = open(p, encoding='utf-8').read()
                except Exception:
                    est += size
                else:
                    est += len((strip_js(src) if ext == '.js' else
                                strip_css(src) if ext == '.wxss' else
                                strip_wxml(src)).encode('utf-8'))
            else:
                est += size
    return raw, est

_mp = os.path.join(ROOT, 'miniprogram')
# _est_bytes 已经逐文件剥过注释/空白，直接就是分包的估算字节数 ——
# 不要再乘全局压缩率（那是 size-real.py 为省事用的近似，乘两次会低估）。
_raw_game, game_est_bytes = _est_bytes(os.path.join(_mp, 'game'))
game_est_kb = int(game_est_bytes / 1024)
pct = game_est_kb / 2048 * 100
add('性能', '分包体积（估算上传后，限额 2048KB）', 4,
    4 if pct < 85 else (2 if pct < 95 else 0), '%d KB 占 %.0f%%' % (game_est_kb, pct))

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
