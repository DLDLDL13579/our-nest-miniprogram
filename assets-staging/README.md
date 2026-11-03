# 暂存资源区（未接入包）

这里的文件**不会打进小程序包**，也不能留在 `miniprogram/` 下 ——
因为项目有一条断言：包里任何图片都必须被引用，否则就是白占体积。

放这里的是"素材已备好、玩法还没接完"的东西。
接入玩法时把它们移回 `miniprogram/game/images/`，引用上即可，断言自然会通过。

## 当前内容

| 目录 | 内容 | 状态 |
|---|---|---|
| `dice-red/` | 6 张红色骰子图，49.6 KB | 红黑单双大小的前两条规则要用。规则/测试已完成，玩法接入未做 |

生成方式：
```bash
python3 scripts/render-dice.py --body red --out assets-staging/dice-red --size 240
```
