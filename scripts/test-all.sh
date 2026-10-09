#!/usr/bin/env bash
# 一次跑完所有测试。改完代码先跑这个，再部署。
set -e
cd "$(dirname "$0")/.."
echo "═══ 1/10 核心链路（配对 / 随手记 / 内容安全）═══"
node scripts/mock-test.js
echo "═══ 2/10 编年史 + 想去去过 ═══"
node scripts/test-chronicle.js
echo "═══ 3/10 时间胶囊（未到期不得泄露正文）═══"
node scripts/test-capsule.js
echo "═══ 4/10 要记得的事（日期滚动与提前量）═══"
node scripts/test-reminds.js
echo "═══ 5/10 情绪·冷静期（双盲 / deadline / 不锁人）═══"
node scripts/test-mood.js
echo "═══ 6/10 游戏逻辑（转盘前后端一致 / 摇盅五步流程）═══"
node scripts/test-game.js
echo "═══ 7/10 多人房间（房间码 / 骰子隔离 / 房主转移）═══"
node scripts/test-room.js
echo "═══ 8/11 骰盅几何（偷看时骰子必须真的露得出来）═══"
node scripts/test-cup-geometry.js
echo "═══ 9/11 房间页状态机（phase→stage 唯一出口 / 新一局重置）═══"
node scripts/test-room-ui.js
echo "═══ 10/11 反馈时间轴（音画同步 / 震动分级 / 降级）═══"
node scripts/test-feedback.js
echo "═══ 11/11 字段契约（require 路径 / 缩略图 / 死绑定 / 幽灵字段）═══"
node scripts/test-contract.js
