#!/bin/bash
# 部署云函数 + 生成预览二维码（一条命令搞定）
#
# 前置：微信开发者工具里已扫码登录（CLI 无法代替这一步，报 code 10）
# 用法：bash scripts/preview.sh
set -u
CLI="/Applications/wechatwebdevtools.app/Contents/MacOS/cli"
PROJ="$(cd "$(dirname "$0")/.." && pwd)"
ENV="cloudbase-d4goh1zdtc8eb9708"
QR="$PROJ/outputs/preview-qr.jpg"

echo "═══ 1/2 部署云函数 ═══"
for fn in room initdb bootstrap; do
  echo "── $fn ──"
  "$CLI" cloud functions deploy \
    --project "$PROJ" --env "$ENV" \
    --names "$fn" --paths "$PROJ/cloudfunctions/$fn" \
    --remote-npm-install true 2>&1 | grep -vE "DeprecationWarning|trace-deprecation|^$"
done

echo
echo "═══ 2/2 生成预览二维码 ═══"
mkdir -p "$PROJ/outputs"
"$CLI" preview --project "$PROJ" --qr-output "$QR" --qr-format image 2>&1 \
  | grep -vE "DeprecationWarning|trace-deprecation|^$"

echo
if [ -f "$QR" ]; then
  echo "✓ 二维码：$QR"
else
  echo "✗ 没有生成二维码 —— 看上面 CLI 的报错（多为登录态过期 code 10）"
  exit 1
fi
