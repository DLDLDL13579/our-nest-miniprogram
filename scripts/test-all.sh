#!/usr/bin/env bash
# 一次跑完所有测试。改完代码先跑这个，再部署。
# 2026-10-27：转成纯酒桌游戏后，情侣功能那 5 组测试随功能一起删除；
#             新增「玩法注册表一致性」断言（见 test-contract.js ⑧）。
set -e
cd "$(dirname "$0")/.."

echo "═══ 1/9 牌型算法（穷举 22100 手，对组合数学）═══"
node scripts/test-poker.js

echo "═══ 2/9 游戏逻辑（转盘前后端一致 / 摇盅五步流程）═══"
node scripts/test-game.js

echo "═══ 3/9 多人房间（房间码 / 骰子隔离 / 房主转移）═══"
node scripts/test-room.js

echo "═══ 4/9 骰盅几何（偷看时骰子必须真的露得出来）═══"
node scripts/test-cup-geometry.js

echo "═══ 5/9 房间页状态机（phase→stage 唯一出口 / 新一局重置）═══"
node scripts/test-room-ui.js

# ★ 音效抖动：一局里同一音效播很多次，不能每次都完全一样（打点机感）
echo "═══ 6/9 反馈时间轴 + 错误反馈（音画同步 / 不许静默吞错）═══"
node scripts/test-pitch.js
node scripts/test-pool.js
node scripts/test-room-changed.js
node scripts/test-firsthint.js
node scripts/test-recent.js
node scripts/test-recent2.js
node scripts/test-me.js
node scripts/test-toast.js
node scripts/test-feedback.js
node scripts/test-error-feedback.js

echo "═══ 7/9 字段契约（图标尺寸 / 死绑定 / 幽灵字段 / 玩法注册表）═══"
node scripts/test-contract.js

# ★ 音效响度层级（2026-10-28 新增）。
#   为什么必须进 test-all：这一组的缺陷**只能靠测量发现**——
#   扣盅前 50ms RMS 从 −19 变成 −14 这件事，听感上是"好像轻了点"，
#   截图看不出来、断言不测就永远不知道。
#   它比 test-contract 的 DC/响度断言更细：那条只看"有没有直流/会不会太轻"，
#   这条看"**谁比谁响**是否符合游戏里的重要性顺序"。
echo "═══ 8/9 音效响度层级（扣盅/揭晓必须压过过程音与铺垫）═══"
python3 scripts/audio-levels.py

# ★ 五个玩法的完整一局（2026-10-28 新增）。
#   为什么单独一组：其他断言都是"某个零件的某个行为对不对"，
#   而这一组只问**一个正常玩家从开局点到结算会不会被卡住**。
#   加它的直接原因是那天发现单人开卧底会卡死在投票页 ——
#   每个零件都对（发词、计票、结算），但串起来走不完。
#   这类问题只有真的把一局跑完才会露出来。
echo "═══ 9/9 完整流程（五个玩法各跑一局到结算）═══"
node scripts/test-flows.js
