#!/usr/bin/env bash
# 看一眼模拟器里的真实界面。用法：
#   ./scripts/see.sh                      # 截今日页
#   ./scripts/see.sh pages/write/write    # 截指定页
#   ./scripts/see.sh pages/index/index "记一笔"   # 跳转后点某个元素再截
set -e
cd "$(dirname "$0")/.."
PG="${1:-pages/index/index}"
TAP="${2:-}"
if [ -n "$TAP" ]; then
  node .tooling/shot.js --page "$PG" --tap "$TAP"
else
  node .tooling/shot.js --page "$PG"
fi
echo "截图在 outputs/ 里，用 open outputs/ 打开"
