#!/usr/bin/env bash
# 一次跑完所有测试。改完代码先跑这个，再部署。
set -e
cd "$(dirname "$0")/.."
echo "═══ 1/7 核心链路（配对 / 随手记 / 内容安全）═══"
node scripts/mock-test.js
echo "═══ 2/7 编年史 + 想去去过 ═══"
node scripts/test-chronicle.js
echo "═══ 3/7 时间胶囊（未到期不得泄露正文）═══"
node scripts/test-capsule.js
echo "═══ 4/7 要记得的事（日期滚动与提前量）═══"
node scripts/test-reminds.js
echo "═══ 5/7 情绪·冷静期（双盲 / deadline / 不锁人）═══"
node scripts/test-mood.js
echo "═══ 6/7 游戏逻辑（转盘判定 / 大话骰计数）═══"
node scripts/test-game.js
echo "═══ 7/7 字段契约（缩略图 / 死绑定 / 幽灵字段）═══"
node scripts/test-contract.js
