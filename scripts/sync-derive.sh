#!/usr/bin/env bash
# 前后端共享文件的同步器。
#
# 背景：云函数独立打包，**不能跨目录 require**（打包时会漏掉父目录的文件），
# 所以前端要用的纯数据模块，云端必须有一份拷贝。
# 拷贝靠脚本保证一致，不靠人记 —— 改完源文件跑一次就行。
#
# 为什么「自动发现」而不是硬编码路径：
#   原来这里写死了两处（miniprogram/utils + daily），后来 home / chronicle / reminds
#   也各自拷了一份，脚本没跟着长 —— 结果 home 和 chronicle 一直停在旧版，
#   少了 clampDay（每月 31 号在小月会静默进位成下月 1 号）。
#   现在扫全目录，以后新增云函数自动纳入，不会再漏。
#
# 2026-10-27（转纯酒桌游戏）：
#   · derive.js 随情侣功能一起退役，已删除
#   · 新增 games.js（玩法注册表）—— 大厅、房间、服务端校验共用同一份真相
#   · decks.js（题卡库）继续保留
set -e
cd "$(dirname "$0")/.."

# 用法：sync_one <源文件> <目标 glob 描述>
sync_one() {
  local src="$1"; shift
  local label="$1"; shift
  local targets
  targets=$(ls "$@" 2>/dev/null || true)
  if [ -z "$targets" ]; then
# ★ 2026-10-30：新模块第一次同步时目标文件还不存在，`ls` 展开为空 →
# 原来直接"没有拷贝需要同步"跳过了 —— **新文件永远同步不上去**。
# 现在：目标是明确路径（不含通配）且父目录存在时，直接创建。
# （含通配的保持原行为：那种写法本身就意味着"给已存在的拷贝"。）
    local made=0
    for t in "$@"; do
      case "$t" in
        \**) : ;;
        *) if [ -d "$(dirname "$t")" ] && [ ! -e "$t" ]; then
             cp "$src" "$t"
             echo "  新建 → $t"
             made=1
           fi ;;
      esac
    done
    if [ "$made" = "0" ]; then
      echo "  $label：没有拷贝需要同步"
    fi
    return
  fi
  local n=0
  for f in $targets; do
    n=$((n + 1))
    if ! diff -q "$src" "$f" >/dev/null 2>&1; then
      cp "$src" "$f"
      echo "  同步 → $f"
    else
      echo "  已一致 $f"
    fi
  done
  echo "  $label $((n + 1)) 处一致 ✓（1 个源 + $n 份拷贝）"
}

echo "── 共享模块 ──"
sync_one miniprogram/utils/games.js "games.js" cloudfunctions/*/games.js
sync_one miniprogram/utils/decks.js "decks.js" cloudfunctions/*/decks.js
sync_one miniprogram/utils/words.js "words.js" cloudfunctions/*/words.js
sync_one miniprogram/utils/poker.js "poker.js" cloudfunctions/*/poker.js
# 2026-10-28：比大小的结算规则抽成纯函数 —— 内联在 roll 分支里的规则根本没法单测
sync_one miniprogram/utils/dicerank.js "dicerank.js" cloudfunctions/*/dicerank.js
# 2026-10-30：大话骰叫骰规则（斋/起叫档/破斋）—— 前端生成选项、服务端校验，必须同一份
sync_one miniprogram/utils/liarRules.js "liarRules.js" cloudfunctions/room/liarRules.js
# ★ 2026-11-03：射龙门的判定器（第 7 个玩法）。它同样是"纯函数 + 云端要一份拷贝"，
#   不加进来就会变成：前端按新规则判、云端按旧规则判 —— 而**两边都不报错**。
sync_one miniprogram/utils/betweenRules.js "betweenRules.js" cloudfunctions/room/betweenRules.js
sync_one miniprogram/utils/sieveRules.js "sieveRules.js" cloudfunctions/room/sieveRules.js
sync_one miniprogram/utils/consensusRules.js "consensusRules.js" cloudfunctions/room/consensusRules.js
