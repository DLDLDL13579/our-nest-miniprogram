# scripts 索引

> 这个目录是**给机器跑的**。给人看的文档在 `docs/`，给 AI 的判据在根目录 `AGENTS.md`。

## 一、回归入口（最常跑）

| 脚本 | 干什么 |
|---|---|
| **`test-all.sh`** | 全部回归：14 组 348 项断言 + 并发 + 压测。**改完代码先跑这个** |
| **`check.sh`** | 一致性检查：共享模块同步、action 契约、测试开关。比 test-all 快 |
| **`health.sh`** | 上面两个 + 云端版本核对，一条命令看整体健康 |

> `test-all.sh` 覆盖 26 个 `test-*.js`，**没有孤儿**（写过就一定会跑）。

## 二、测试（被 test-all 调度，一般不单独跑）

按主题分：

| 组 | 文件 |
|---|---|
| 玩法规则 | `test-poker.js`（穷举 22100 手）、`test-liarcount.js`、`test-bidoptions.js`、`test-settle.js`、`test-loser.js` |
| 房间逻辑 | `test-room.js`（最大，127 项）、`test-flows.js`（完整一局）、`test-race.js`（并发）、`test-stress.js`（压测） |
| 前端状态 | `test-room-ui.js`、`test-room-changed.js`、`test-firsthint.js`、`test-me.js` |
| 工程契约 | `test-contract.js`（字段/绑定/样式）、`test-assets.js`（图片存在）、`test-docs.js` |
| 音画反馈 | `test-feedback.js`、`test-pitch.js`、`test-pool.js`、`test-toast.js`、`test-errlog.js`、`test-error-feedback.js` |
| 其他 | `test-game.js`（转盘前后端一致）、`test-cup-geometry.js`（骰盅几何）、`test-recent*.js` |

## 三、离线生成（素材与验证）

| 脚本 | 产物 |
|---|---|
| **`render-ui.js`** | wxml+wxss → PNG（无头 Chrome）。`--state` 选 mock 状态 |
| `render-dice.py` / `render-cup.py` | SDF 光线步进渲染骰子/骰盅（产物已提交，一般不用重跑） |
| `gen-audio.py` | 合成音效（低频类） |
| `import-audio.py` | 把 Kenney CC0 真实录音导入成 44.1kHz WAV（`--only` 只跑指定几个） |
| `gen-share-cover.py` | 分享卡片封面 |
| **`audio-levels.py`** | 音频指标检查（响度层级 / DC / 削波） |
| `contact-sheet.py` | 把某页全部渲染状态拼成联系表 |
| **`verify-assert.py`** | 反向验证：改坏代码 → 跑测试 → 恢复。**判断一条断言是不是废的** |

## 四、运维

| 脚本 | 干什么 |
|---|---|
| `deploy.sh` | 部署全部云函数（自动扫描 `cloudfunctions/*/`） |
| `sync-derive.sh` | 把 `miniprogram/utils/*.js` 同步到云端拷贝 |
| `preview.sh` / `see.sh` | 生成预览码 / 打开页面看效果 |

## 五、真机验证（需要 IDE，不在 test-all 里）

在 `../.tooling/` 下：

| 脚本 | 用途 |
|---|---|
| `e2e-ui.js` | **UI 点击链路 24 步**（建房/开局/叫骰/摇骰/弃牌/复制房间号/分享直达） |
| `diag.js` | 验证「复制诊断信息」产出完整内容 |
| `perf.js` | 性能画像（首屏 / 建房 / 分包预加载对照） |
| `probe-create.js` | create 分段计时（pick / add / shape） |
| `repro-all.js` / `repro-bid.js` | 全玩法真机跑 / 字段级复现 |
| `probe-room-cloud.js` | 云端版本核对 |
| `race-roll.js` | 并发摇骰的原始复现脚本 |
| `flow-sheet.py` / `flow-trans.py` | 生成"体验流程"和"过渡场景"两张拼图 |

⚠️ 跑完 `.tooling` 下的脚本**记得 `cli quit`**（它会拉起 Electron 进程，用户明确要求别在他电脑上留 GUI）。

## 加脚本的规矩

1. **测试一律叫 `test-*.js` 并接进 `test-all.sh`** —— 不接入的测试等于没写
2. **一次性探针放 `.tooling/`**，别放这里
3. 写之前先看这份索引，避免和已有的重复（这个项目在文档层踩过一次：多写了一份和「两分钟自测」重复的验证卡）
