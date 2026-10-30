from PIL import Image, ImageDraw, ImageFont
import os
ROOT='/Users/meihaoshidai/Downloads/邓林work/个人项目/小程序'
UI=os.path.join(ROOT,'outputs','ui')
items=[('lobby.png','① 大厅：5 张玩法卡一屏放下'),('room-liarPlay.png','② 大话骰：轮到你了'),
       ('room-diceWin.png','③ 比大小：赢家独占、撒花'),('room-pkOver.png','④ 金花：摊牌结算'),
       ('room-uwTalk.png','⑤ 卧底：描述 + 谁会投票'),('room-wheelCard.png','⑥ 转盘：转到真心话')]
def font(sz):
    for p,i in [('/System/Library/Fonts/Hiragino Sans GB.ttc',0),('/System/Library/Fonts/STHeiti Medium.ttc',0)]:
        if os.path.exists(p): return ImageFont.truetype(p,sz,index=i)
    return ImageFont.load_default()
W=360; GAP=18; LBL=34; COLS=3
imgs=[]
for f,_ in items:
    im=Image.open(os.path.join(UI,f)).convert('RGB')
    r=W/im.width
    imgs.append(im.resize((W,int(im.height*r)),Image.LANCZOS))
H=max(i.height for i in imgs)
rows=(len(items)+COLS-1)//COLS
CW=W+GAP*2; CH=H+LBL+GAP*2
out=Image.new('RGB',(CW*COLS, CH*rows+GAP), (18,14,12))
d=ImageDraw.Draw(out); f1=font(19)
for k,(im,(_,cap)) in enumerate(zip(imgs,items)):
    cx=(k%COLS)*CW+GAP; cy=(k//COLS)*CH+GAP
    out.paste(im,(cx,cy))
    d.text((cx, cy+im.height+8), cap, fill=(240,200,120), font=f1)
p=os.path.join(ROOT,'outputs','体验流程.png'); out.save(p)
print(p, out.size)
