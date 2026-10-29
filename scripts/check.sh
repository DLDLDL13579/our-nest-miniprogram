#!/usr/bin/env bash
# 部署前检查。这三项都是"能编译但会炸"的坑，踩过一次就别再踩第二次。
set -e
cd "$(dirname "$0")/.."

echo "═══ 1/5 语法 ───"
# ★ 用 find 而不是写死层级的 glob：
#   原来写的是 pages/*/*.js 和 pages/*/*/*.js 两条，页面结构调整后
#   第二层 glob 没有匹配 → node --check 拿到字面量路径 → 直接报 MODULE_NOT_FOUND。
#   （"没有文件" 和 "文件有语法错" 是两件事，不能混成一个失败。）
n_js=0
while IFS= read -r f; do
  node --check "$f" || { echo "  ✗ $f"; exit 1; }
  n_js=$((n_js + 1))
done < <(find cloudfunctions miniprogram -name '*.js' -not -path '*/node_modules/*' | sort)
echo "  ✓ $n_js 个 js 语法通过"

echo "═══ 2/5 WXML 标签配平（含 <br> 检查）───"
python3 - << 'PY'
import re, glob, sys
bad=0
for f in sorted(glob.glob('miniprogram/pages/**/*.wxml', recursive=True)):
    raw=open(f,encoding='utf-8').read()
    # ① 小程序不支持 <br>：编译器会报 "unexpected end tag: view"，且行号指向下一行
    for i,line in enumerate(raw.split('\n'),1):
        if re.search(r'<br\s*/?>', line):
            print(f'  ✗ {f}:{i} 用了 <br>，小程序不支持。改用 <view style="height:6rpx"></view> 或 white-space:pre-line')
            bad+=1
    # ② 标签配平
    s=re.sub(r'<!--.*?-->','',raw,flags=re.S)
    stack=[]
    for m in re.finditer(r'<(/?)([a-zA-Z][\w-]*)((?:[^>"\']|"[^"]*"|\'[^\']*\')*?)(/?)>', s):
        closing,name,selfclose=m.group(1),m.group(2),m.group(4)
        line=s[:m.start()].count('\n')+1
        if name in ('image','input','icon','import','include','wxs'): continue
        if selfclose: continue
        if closing:
            if not stack or stack[-1][0]!=name:
                print(f'  ✗ {f}:{line} </{name}> 不匹配'); bad+=1
            else: stack.pop()
        else: stack.append((name,line))
    for n,l in stack: print(f'  ✗ {f}:{l} <{n}> 未闭合'); bad+=1
print('  ✓ WXML 全部通过' if not bad else f'  共 {bad} 处问题')
sys.exit(1 if bad else 0)
PY

echo "═══ 3/5 app.json 页面文件齐全 ───"
node -e "
const fs=require('fs'),path=require('path');
const app=JSON.parse(fs.readFileSync('miniprogram/app.json','utf8'));
let bad=0;
app.pages.forEach(p=>['js','json','wxml'].forEach(e=>{
  const f=path.join('miniprogram',p+'.'+e);
  if(!fs.existsSync(f)){console.log('  ✗ 缺',f);bad++}
}));
app.tabBar.list.forEach(t=>{if(!app.pages.includes(t.pagePath)){console.log('  ✗ tabBar 指向未注册页',t.pagePath);bad++}});
if(bad) process.exit(1);
console.log('  ✓ '+app.pages.length+' 个页面齐全，tabBar 正常');
"

echo "═══ 4/5 前后端共享模块一致 ───"
# 只读比对（原来跑 sync 报"一致"，是空检查）；和 health.sh 共用同一个脚本
node scripts/check-sync.js

echo "═══ 5/5 前端调用的云函数 action 必须真实存在 ───"
# 独立脚本：原来用 node -e 嵌在 shell 里（转义脆、且只扫主包，子包扫不到就恒报 0 处）
node scripts/check-actions.js

echo "全部检查通过，可以部署 ✓"

echo "═══ 6/6 测试开关提醒 ═══"
if grep -q "soloTest: true" miniprogram/config.js; then
  echo "  ⚠️  config.js 里 soloTest = true：现在**一个人也能开局**。"
  echo "     验收完记得改成 false，否则正式版用户可以单人开始任何玩法。"
else
  echo "  ✓ soloTest 已关闭（人数按玩法下限拦）"
fi
