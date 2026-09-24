#!/usr/bin/env bash
# derive.js 是全工程唯一的时间算法源。云函数各自独立打包、不能跨目录 require，
# 所以每个用到它的云函数都必须留一份拷贝 —— 用这个脚本保证拷贝永远和源一致，不靠人记。
#
# 为什么改成「自动发现」而不是硬编码路径：
#   原来这里写死了两处（miniprogram/utils + daily），但后来 home / chronicle / reminds
#   也各自拷了一份，脚本没跟着长 —— 结果 home 和 chronicle 一直停在旧版，
#   少了 clampDay（每月 31 号在小月会静默进位成下月 1 号）。
#   现在扫全目录，以后新增云函数自动纳入，不会再漏。
set -e
cd "$(dirname "$0")/.."
SRC=prototype/derive.js

# SRC 本身不参与比对；其余所有拷贝都必须和它逐字节一致
targets=$(ls miniprogram/utils/derive.js cloudfunctions/*/derive.js 2>/dev/null || true)

n=0
for f in $targets; do
  [ "$f" = "$SRC" ] && continue
  n=$((n + 1))
  if ! diff -q "$SRC" "$f" >/dev/null 2>&1; then
    cp "$SRC" "$f"
    echo "  同步 → $f"
  else
    echo "  已一致 $f"
  fi
done

echo "derive.js $((n + 1)) 处一致 ✓（1 个源 + $n 份拷贝）"
