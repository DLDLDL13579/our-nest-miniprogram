#!/usr/bin/env bash
# 换 AppID 后的一键部署。用法：
#   ./scripts/deploy.sh <新AppID> <云环境ID>
# 例：./scripts/deploy.sh wx1234567890abcdef xiaowo-3g8a1b2c3
#
# 前置：新 AppID 必须已在微信开发者工具里「开通云开发」并建好一个环境
#       （建环境这一步 CLI 没有对应命令，只能在工具界面点一下，一次性）
set -e
cd "$(dirname "$0")/.."

APPID="$1"
ENV="$2"
CLI="/Applications/wechatwebdevtools.app/Contents/MacOS/cli"
P="$(pwd)"

if [ -z "$APPID" ] || [ -z "$ENV" ]; then
  echo "用法：./scripts/deploy.sh <AppID> <环境ID>"
  echo "  环境ID 在 云开发控制台 左上角，形如 xiaowo-3g8a1b2c3"
  exit 1
fi

echo "═══ 1/5 写入 AppID ═══"
python3 - "$APPID" << 'PY'
import io, json, sys
p = 'project.config.json'
d = json.loads(io.open(p, encoding='utf-8').read())
old = d['appid']
d['appid'] = sys.argv[1]
io.open(p, 'w', encoding='utf-8').write(json.dumps(d, ensure_ascii=False, indent=2) + "\n")
print(f"  {old} → {sys.argv[1]}")
PY

echo "═══ 2/5 写入云环境 ID ═══"
python3 - "$ENV" << 'PY'
import io, re, sys
p = 'miniprogram/config.js'
s = io.open(p, encoding='utf-8').read()
s = re.sub(r"env: '[^']*'", "env: '" + sys.argv[1] + "'", s, count=1)
io.open(p, 'w', encoding='utf-8').write(s)
print(f"  miniprogram/config.js → env = {sys.argv[1]}")
PY

echo "═══ 3/5 同步 derive.js（三处必须一致）═══"
bash scripts/sync-derive.sh

echo "═══ 4/5 部署云函数（云端安装依赖）═══"
for fn in pair daily moments chronicle wishes initdb bootstrap answer home capsule reminds; do
  echo "  → $fn"
  "$CLI" cloud functions deploy \
    --project "$P" --env "$ENV" \
    --names "$fn" --paths "$P/cloudfunctions/$fn" \
    --remote-npm-install true 2>&1 \
    | grep -vE 'DeprecationWarning|trace-deprecation|IDE server' | grep -E '✔|✖|error|成功|失败' | head -4
done

echo "═══ 5/5 建库（不用手工跑，bootstrap 会代跑）═══"
cat << 'MANUAL'
  小程序启动时会先调 bootstrap 云函数，由它在云端替你调 initdb
  （CLI 没有 invoke 命令，所以必须借云函数互相调用）。
  返回里会列出 11 个集合已建、20 道题已灌入。

  想手工跑也行：
    开发者工具左侧 → cloudfunctions/initdb → 右键
    → 「云端测试」→ 参数留空 {} → 运行
MANUAL

cat << 'EOF'

════════════════════════════════════════════════════════
最后一步在微信后台手工点（CLI 做不到）：

  管理 → 版本管理 → 开发版本 → 找到刚上传的版本 → 选为体验版本

然后「体验版本」区块会出现二维码，发给倩萍即可。

（旧文档里提到的 answers 唯一索引已经不需要了 ——
  answers 是旧版「每日一题」的表，那个形态已被否掉，
  前端答题页早就删了，这条索引建不建都不影响。）
════════════════════════════════════════════════════════
EOF
