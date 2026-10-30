# ui-render mock 编写规则

> 这个目录是**离线渲染器的假数据**。渲染器不跑 JS，只拿这里的对象去套 wxml + wxss。
> 所以 mock 的质量直接决定"截图能不能信"。

## 三条铁律（都是踩出来的）

### ① 只能用**真实存在**的字段

mock 里写了一个服务端根本不返回的字段，渲染截图会**看起来完全正常**，
而真机上那块是空的 —— **假数据会盖住真 bug**。

真实案例：`poker.last.byText` 在 mock 里有、服务端从来没有 →
比牌记录那三张牌在真机上一直是空的，藏了好几轮。

现在有断言（test-contract ④·mock）盯着：mock 的 poker.last 里每个 key
都必须能在服务端或前端源码里找到来源。

### ② 页面级变量要放在 **data()** 里，不是 pkRoom()

模板里的 `{{cupSrc}}`、`{{cupIcon}}` 读的是**页面 data**，
不是 `room.cupSrc`。放错层级的默认值**和没放一样**，而且看起来"已经补过了"，更难发现。

现在默认值统一在 `module.exports.data()` 里给（cupSrc / cupCls / diceShown /
wheelGradient / wheelDeg 等），45 个状态自动继承。

真实案例：为了一个破图，我四次给**单个状态**补 cupSrc，每次下一个状态又忘。

### ③ 图片源必须有默认值

```xml
<image src="/game/images/cup/{{cupSrc}}.png" />
```

`cupSrc` 为 undefined 时路径变成 `/game/images/cup/.png` →
**破图，且不报错**。同理 `wheelGradient` 缺了会导致"转盘是空的"。

## 加新状态时检查这三条

1. 用到的字段名，先在 `cloudfunctions/room/index.js` 或 `room.js` 里搜一遍
2. 页面级变量（不在 `room.` 下面的）→ 看 `data()` 有没有
3. 所有 `src="/game/images/..."` 里的插值 → 确认有默认值

## 状态名必须存在

`render-ui.js` 现在会在状态名不存在时**报错并列出全部可用名**。
之前是静默回退到 base 大厅 —— 我因此白看了好几张"金花状态"截图，它们其实是大厅。
