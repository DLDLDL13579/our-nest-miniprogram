#!/usr/bin/env bash
# 一条命令看项目健康度。改完代码、部署前跑一次。
#
# 为什么单独一个脚本：改完之后要核对的散在五六处 ——
# 测试过没过、版本号是多少、包多大、云函数是不是最新、测试开关关没关。
# 一个个查既慢又容易漏（漏掉"云函数没部署"就是线上跑旧代码）。
set -e
cd "$(dirname "$0")/.."

GIT="git"
# 本机的 git 环境注入了不完整的 GIT_CONFIG_COUNT，不摘掉任何 git 命令都报错
unset GIT_CONFIG_COUNT GIT_CONFIG_VALUE_0 GIT_CONFIG_VALUE_1 2>/dev/null || true

echo "════════════════════════════════════════════════════════════"
echo "  酒桌 · 健康检查"
echo "════════════════════════════════════════════════════════════"

# ---------- ① 版本 ----------
VER=$(node -e "console.log(require('./miniprogram/config.js').version)")
echo ""
echo "① 版本：v$VER"

# ---------- ①b 版本号有没有跟着改 ----------
# ★ 2026-10-28：版本号收敛到 config.js 一处之后，**没人去改那一处** ——
#   一口气做了 18 个 3.9.x 的功能，config.js 还停在 3.9.78。
#   单一来源只解决了"两处不一致"，没解决"忘了改"。
# ⚠️ 原来的正则是 `3\.9\.[0-9]+` —— 写死了 3.9.x。升到 3.10 之后**永远匹配不到**，
#    于是"版本号落后"这条从 3.10.0 起就没报过。改成通用的 x.y.z。
LASTV=$($GIT log -1 --format=%s 2>/dev/null | grep -oE '[0-9]+\.[0-9]+\.[0-9]+' | head -1 || true)
if [ -n "$LASTV" ] && [ "v$LASTV" != "v$VER" ]; then
  echo "   ⚠️ 版本号落后：config.js 是 $VER，最近提交写的是 $LASTV"
fi

# ---------- ② 测试 ----------
echo ""
echo "② 测试"
if bash scripts/test-all.sh >/tmp/health-test.log 2>&1; then
  N=$(grep -c "✓" /tmp/health-test.log || echo 0)
  echo "   ✓ 全绿（$N 项）"
  # ★ README 里写的断言数也会过时（和版本号同一类问题）——顺手指出来
  RMS=$(grep -oE '[0-9]+ 项' README.md 2>/dev/null | head -1 | grep -oE '[0-9]+' || echo '')
  if [ -n "$RMS" ] && [ "$RMS" != "$N" ]; then
    echo "   ⚠️ README 写的是 $RMS 项，实际 $N 项"
  fi
else
  echo "   ✗ 有失败 —— 看 /tmp/health-test.log"
  tail -20 /tmp/health-test.log
  exit 1
fi

# ---------- ③ 包体积 ----------
echo ""
echo "③ 包体积"
MAIN=$(du -sk miniprogram | cut -f1)
SUB=$(du -sk miniprogram/game 2>/dev/null | cut -f1 || echo 0)
echo "   整体 ${MAIN}KB（其中分包 game ${SUB}KB，主包约 $((MAIN - SUB))KB）"
# ⚠️ 原来只打印一行、不退出 —— 真超限了脚本照样"通过"。
if [ "$((MAIN - SUB))" -gt 2048 ]; then
  echo "   ✗ 主包超过 2MB 限制"
  exit 1
fi

# ---------- ④ 云函数：本地改了但没部署？ ----------
echo ""
echo "④ 云函数"
for d in cloudfunctions/*/; do
  name=$(basename "$d")
  # 本地最后一次改动 vs 最后一次提交时间 —— 只能提示，不能确证（CLI 没有 invoke）
  dirty=$($GIT status --porcelain "$d" 2>/dev/null | wc -l | tr -d ' ')
  if [ "$dirty" -gt 0 ]; then
    echo "   ⚠️ $name：本地有未提交改动 —— 部署前记得确认"
  else
    echo "   · $name：本地干净（是否已部署要你自己确认，CLI 查不到）"
  fi
done

# ---------- ⑤ 测试开关 ----------
echo ""
echo "⑤ 测试开关"
if grep -q "soloTest: true" miniprogram/config.js; then
  echo "   ⚠️ soloTest = true —— 现在一个人也能开局；**正式上线前改成 false**"
else
  echo "   ✓ soloTest 已关闭"
fi

# ---------- ⑥ 前后端共享模块一致 ----------
echo ""
echo "⑥ 共享模块"
# ⚠️ 这里原来也是跑 `sync-derive.sh`（写文件）再报"一致" —— 和 check.sh 第 4 项
#    是同一个空检查。现在改成只读比对（同一个脚本，两处共用）。
node scripts/check-sync.js

# ---------- ⑦ 音频（2026-10-30 用户报「声音混乱」后加的） ----------
echo ""
echo "⑦ 音频"
# 两组检查，都是这轮为了定位「声音混乱」才做的：
#   audio-levels.py        响度层级 / 直流偏置 / 削波
#   check-audio-overlap.py 音效时长 vs 调度间隔（叠在一起就糊）
if python3 scripts/audio-levels.py >/tmp/health-audio.log 2>&1; then
  echo "   ✓ 响度层级 / 直流 / 削波 全部达标"
else
  echo "   ✗ 音频指标不达标 —— 看 /tmp/health-audio.log"
  grep -E "✗|超标" /tmp/health-audio.log | head -5
fi
if python3 scripts/check-audio-overlap.py >/tmp/health-ov.log 2>&1; then
  echo "   ✓ 音效时间线无重叠"
else
  echo "   ✗ 音效有重叠（听感会糊）—— 看 /tmp/health-ov.log"
fi

echo ""
echo "════════════════════════════════════════════════════════════"
echo "  提示：CLI 查不到云端版本。改过 cloudfunctions/ 就重新 deploy 一次。"
echo "════════════════════════════════════════════════════════════"
