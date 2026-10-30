# 真机验证用例

用 `node .tooling/probe.js --file .tooling/cases/<名字>.js` 跑。
需要开发者工具的自动化端口（`cli auto --project <p> --auto-port 9420`）。

**共同约束**（踩过的坑）：

- **一次 evaluate 只做一件事**。跑 5 局要塞进一次 evaluate → `timeout waiting for automator response`。
  实测 8 秒的 evaluate 没问题，60 秒的不行。
- **tabBar 页用 `switchTab`**，`navigateTo` 会静默失败（`currentPage().path` 还是上一页）。
- **选择器必须 grep 真实类名**，写错只会返回 0 个元素，和"产品真没有"一模一样。
- **固定 `sleep` 要换成轮询到条件成立**（`e2e-ui.js` 就因为赌 `sleep(3200)` 而偶发失败）。

## 用例

| 文件 | 验什么 | 期望 |
|---|---|---|
| `liar-full.js` | 大话骰：偷看 → 点叫法 | `liarReady=true`、24 个叫法、**点「3个1」后 bid 精确是 `{n:3,face:1}`** |
| `dice-streak.js` | 比大小连玩 3 局 | 每局都 `phase=over`，骰子各不同 |
| `poker-streak.js` | 金花连玩 2 局 | 换牌有效；**第二局喝量从 0.5 重新开始** |
| `offline-lobby.js` | 上线态（`soloTest:false`）五玩法 | 四个显示「叫 N 个人来」，转盘显示「开始（1 人）」 |
| `wheel-full.js` | 转盘完整流程 | 主按钮「开始（1 人）」→ 开局 → 转出真实结果 |

## 2026-10-30 的实测结果

```
liar-full      stage=playing 骰子=0 → 偷看 liarReady=true → 24 个叫法
               → 点「3个1」bid={n:3,face:1}   ✓
dice-streak    [5,5,4,6,3] / [6,2,6,6,1] / [1,1,6,5,3]   ✓
poker-streak   ♥J→♣K 喝0.5 / ♥3→♦10 喝0.5（第二局重置）✓
offline-lobby  liar/dice/poker 叫1人 · undercover 叫2人 · wheel「开始（1人）」✓
wheel-full     wheelText="你喝"，像素验证距指针 4.1°       ✓
```
