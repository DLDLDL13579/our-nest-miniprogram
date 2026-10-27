#!/usr/bin/env bash
# 一次跑完所有测试。改完代码先跑这个，再部署。
# 2026-10-27：转成纯酒桌游戏后，情侣功能那 5 组测试随功能一起删除；
#             新增「玩法注册表一致性」断言（见 test-contract.js ⑧）。
set -e
cd "$(dirname "$0")/.."

echo "═══ 1/7 牌型算法（穷举 22100 手，对组合数学）═══"
node scripts/test-poker.js

echo "═══ 2/7 游戏逻辑（转盘前后端一致 / 摇盅五步流程）═══"
node scripts/test-game.js

echo "═══ 3/7 多人房间（房间码 / 骰子隔离 / 房主转移）═══"
node scripts/test-room.js

echo "═══ 4/7 骰盅几何（偷看时骰子必须真的露得出来）═══"
node scripts/test-cup-geometry.js

echo "═══ 5/7 房间页状态机（phase→stage 唯一出口 / 新一局重置）═══"
node scripts/test-room-ui.js

echo "═══ 6/7 反馈时间轴 + 错误反馈（音画同步 / 不许静默吞错）═══"
node scripts/test-feedback.js
node scripts/test-error-feedback.js

echo "═══ 7/7 字段契约（图标尺寸 / 死绑定 / 幽灵字段 / 玩法注册表）═══"
node scripts/test-contract.js
