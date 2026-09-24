#!/usr/bin/env bash
# 一次跑完所有云函数逻辑测试。改完代码先跑这个，再部署。
set -e
cd "$(dirname "$0")/.."
echo "═══ 1/6 核心链路（配对 / 随手记 / 内容安全）═══"
node scripts/mock-test.js
echo "═══ 2/6 编年史 + 想去去过 ═══"
node scripts/test-chronicle.js
echo "═══ 3/6 时间胶囊（未到期不得泄露正文）═══"
node scripts/test-capsule.js
echo "═══ 4/6 要记得的事（日期滚动与提前量）═══"
node scripts/test-reminds.js
echo "═══ 5/6 情绪·冷静期（双盲 / deadline / 不锁人）═══"
node scripts/test-mood.js
echo "═══ 6/6 字段契约（缩略图 / 死绑定 / 幽灵字段）═══"
node scripts/test-contract.js
