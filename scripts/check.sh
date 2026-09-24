#!/usr/bin/env bash
# 部署前检查。这三项都是"能编译但会炸"的坑，踩过一次就别再踩第二次。
set -e
cd "$(dirname "$0")/.."

echo "═══ 1/4 语法 ───"
for f in cloudfunctions/*/index.js miniprogram/utils/*.js miniprogram/pages/*/*.js miniprogram/pages/*/*/*.js miniprogram/app.js miniprogram/config.js; do
  node --check "$f" || { echo "  ✗ $f"; exit 1; }
done
echo "  ✓ 所有 js 语法通过"

echo "═══ 2/4 WXML 标签配平（含 <br> 检查）───"
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

echo "═══ 3/4 app.json 页面文件齐全 ───"
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

echo "═══ 4/4 derive.js 三处一致 ───"
bash scripts/sync-derive.sh

echo
echo "全部检查通过，可以部署 ✓"
