#!/usr/bin/env bash
# 一次跑完所有云函数逻辑测试。改完代码先跑这个，再部署。
set -e
cd "$(dirname "$0")/.."
echo "═══ 1/5 核心链路（配对 / 双盲解锁 / 想你了）═══"
node scripts/mock-test.js
echo "═══ 2/5 编年史 + 想去去过 ═══"
node scripts/test-chronicle.js
echo "═══ 3/5 时间胶囊（未到期不得泄露正文）═══"
node scripts/test-capsule.js
echo "═══ 4/5 要记得的事（日期滚动与提前量）═══"
node scripts/test-reminds.js
echo "═══ 5/5 字段契约（缩略图 / 死绑定 / 幽灵字段）═══"
node scripts/test-contract.js
