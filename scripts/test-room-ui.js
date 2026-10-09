/**
 * test-room-ui.js —— 房间页「状态机」的静态断言
 *
 * ============ 为什么需要它 ============
 *
 * test-room.js 测的是**云函数**（逻辑对不对），
 * 但用户遇到的 bug 绝大多数在**页面**上：转盘点不动、摇盅没反应、
 * 新一局还是上一局的骰子……这些都是"页面本地状态没跟上服务端"。
 *
 * 云函数全绿 ≠ 游戏能玩。这一组专门盯页面状态机。
 *
 * ============ 三个真实事故（都是本文件要防的） ============
 *
 * ① 「转盘无法转」—— `doStart` 里写死 `stage:'playing'`，
 *    而服务端 start 返回的是 `phase:'countdown'`。
 *    房主于是停在"看着像开始了、其实还没开始"的状态，
 *    点转盘 → 服务端回「这局还没开始」；1.5 秒后又被轮询拽回倒计时界面。
 *    → 规则：**phase → stage 只能有一个出口**（stageOf），
 *      任何地方都不准再手写 'playing'/'countdown' 的三元表达式。
 *
 * ② 「新一局还是上一局的骰子」—— 局内状态（骰子/是否摇过/是否偷看过）
 *    散在十几个 setData 里靠"某个条件恰好成立"重置，漏一处就出鬼，
 *    而且**不报错**。
 *    → 规则：新一局必须走**唯一入口** resetRound()，且它清掉的字段要齐全。
 *
 * ③ 「轮到谁了」看不见 —— 玩家只能靠乱点 + 被拒来猜。
 *    → 规则：turn / myTurn / turnName 必须由 refresh 统一算出来，
 *      并且**参与 roomChanged 比较**（否则轮到我了界面不刷新，
 *      提示停在上一轮，比不做还糟）。
 *
 * 跑法：node scripts/test-room-ui.js
 */
const fs = require('fs')
const path = require('path')
const assert = require('assert')

const ROOT = path.join(__dirname, '..')
const JS = path.join(ROOT, 'miniprogram/pages/game/room/room.js')
const WXML = path.join(ROOT, 'miniprogram/pages/game/room/room.wxml')
const WXSS = path.join(ROOT, 'miniprogram/pages/game/room/room.wxss')

let n = 0
function ok(msg) { n++; console.log('  ✓ ' + msg) }

const src = fs.readFileSync(JS, 'utf8')
const tpl = fs.readFileSync(WXML, 'utf8')
const css = fs.readFileSync(WXSS, 'utf8')
/* 剥掉注释再扫代码 —— 否则注释里写的反例会被当成真代码 */
const code = src.replace(/\/\*[\s\S]*?\*\//g, '').replace(/(^|[^:])\/\/[^\n]*/g, '$1')

;(() => {
  /* ============ ① phase → stage 只能有一个出口 ============ */
  console.log('\n=== ① 服务端 phase → 页面 stage：只能有一个出口 ===')

  assert.ok(/function stageOf\s*\(/.test(code),
    '★ 找不到 stageOf() —— phase→stage 的映射必须抽成一个函数，' +
    '否则又会出现"某处写死 playing"的事故')
  ok('存在统一的 stageOf() 映射函数')

  /* 抽出来直接跑：四种 phase 必须各有正确结果 */
  const m = /function stageOf\s*\([^)]*\)\s*\{([\s\S]*?)\n\}/.exec(code)
  assert.ok(m, 'stageOf 函数体抽不出来')
  const stageOf = new Function('phase', m[1])
  assert.strictEqual(stageOf('lobby'), 'lobby')
  assert.strictEqual(stageOf('countdown'), 'countdown')
  assert.strictEqual(stageOf('playing'), 'playing')
  assert.strictEqual(stageOf('over'), 'over')
  /* 未知 phase 不能崩、也不能停在中间态 */
  assert.strictEqual(stageOf(undefined), 'over')
  ok('stageOf 对 lobby/countdown/playing/over 及未知值都有确定结果')

  /*
   * ★ 核心：除了 entry/over 这两个**本地**状态，
   *   "来自服务端的阶段"不准再手写字符串。
   *   entry 是"还没进房间"、over 是"结算"，都不由 phase 推导，可以写死；
   *   lobby/countdown/playing 必须走 stageOf。
   */
  const hardcoded = []
  code.split('\n').forEach((line, i) => {
    const mm = /stage:\s*'([a-z]+)'/.exec(line)
    if (!mm) return
    const v = mm[1]
    if (v === 'entry' || v === 'over') return          // 本地状态，允许
    hardcoded.push(`第 ${i + 1} 行 → stage: '${v}'`)
  })
  assert.deepStrictEqual(hardcoded, [],
    '★ 这些地方手写了来自服务端的阶段（必须改用 stageOf(phase)）：\n    ' +
    hardcoded.join('\n    ') +
    '\n    手写会和服务端不同步 —— doStart 写死 playing 就是「转盘无法转」的根因')
  ok('没有手写 lobby/countdown/playing（全部走 stageOf）')

  /* ============ ② 新一局必须走唯一入口，且字段齐全 ============ */
  console.log('\n=== ② 新一局重置：唯一入口 + 字段齐全 ===')

  assert.ok(/resetRound\s*\(\s*\)\s*\{/.test(code), '★ 找不到 resetRound()')
  const rr = /resetRound\s*\(\s*\)\s*\{([\s\S]*?)\n  \}/.exec(code)
  assert.ok(rr, 'resetRound 函数体抽不出来')
  const body = rr[1]

  /* 这些字段必须被清 —— 少一个就是一类"上一局残留"的鬼 bug */
  const mustReset = {
    myDice: '上一局的骰子点数',
    myRolled: '上一局的"已摇过"（不清就永远摇不了）',
    liarReady: '上一局的"偷看过"（不清就能不偷看直接叫）',
    diceShown: '骰子可见性',
    rolling: '摇盅中标志（不清按钮会一直转）',
    cupCls: '盅的动画类',
    cupHint: '盅的提示语',
    result: '上一局的结算'
  }
  const missing = Object.keys(mustReset).filter(k => !new RegExp('\\b' + k + '\\s*:').test(body))
  assert.deepStrictEqual(missing, [],
    '★ resetRound 漏了这些字段（新一局会带着上一局的状态）：\n    ' +
    missing.map(k => k + ' —— ' + mustReset[k]).join('\n    '))
  ok(`resetRound 清掉了全部 ${Object.keys(mustReset).length} 个局内字段`)

  /* 必须在 countdown 时调用（这是"新一局开始"的唯一确定信号） */
  const cdBlock = /room\.phase === 'countdown'[\s\S]{0,400}?resetRound\s*\(\s*\)/.test(code)
  assert.ok(cdBlock,
    '★ resetRound 没有在 phase 进入 countdown 时调用 —— ' +
    '新一局的状态就不会重置（表现：骰子是上一局的、按钮点不动）')
  ok('进入 countdown 时调用 resetRound（新一局的确定信号）')

  /* ============ ③ 轮次提示：算出来 + 参与比较 ============ */
  console.log('\n=== ③ 轮次提示：算出来，且必须参与 roomChanged 比较 ===')

  assert.ok(/room\.myTurn\s*=/.test(code), '★ 没有计算 myTurn —— 玩家不知道轮没轮到自己')
  assert.ok(/room\.turnName\s*=/.test(code), '★ 没有计算 turnName —— 只显示"等别人"等于没说')
  ok('refresh 里算出了 myTurn / turnName')

  const cmp = /roomChanged\s*\(\s*prev\s*,\s*room\s*\)\s*\{([\s\S]*?)\n  \}/.exec(code)
  assert.ok(cmp, 'roomChanged 函数体抽不出来')
  const cmpBody = cmp[1]
  for (const f of ['myTurn', 'turnName', 'waitingCount', 'waitingNames']) {
    assert.ok(new RegExp('prev\\.' + f + '\\s*!==\\s*room\\.' + f).test(cmpBody),
      `★ roomChanged 没有比较 ${f} —— ` +
      '它的变化不会触发 setData，界面会停在旧值' +
      '（比如轮到自己了却还显示"等别人"，比不显示还糟）')
  }
  ok('myTurn / turnName / waitingCount / waitingNames 都参与变化比较')

  /* ============ ④ 模板：叫骰区不能被整块藏起来 ============ */
  console.log('\n=== ④ 模板：入口必须常显，不能上锁 ===')

  /*
   * ★ 判据要精确：**不能用 liarReady 包住"叫一个"那一段**。
   *
   * ⚠️ 第一版写成"模板里不许出现 wx:if={{liarReady}}" —— 误报了：
   *    liarReady 现在合法地用在**引导卡**上（没偷看就显示提示），
   *    真正要禁的是"用它把叫骰区整块藏掉"。
   *    所以判据改成：从"叫一个"这个标题往前找最近的 wx:if，
   *    如果那个条件里带 liarReady，才是出问题。
   */
  const bidHead = tpl.indexOf('叫一个')
  assert.ok(bidHead > 0, '模板里找不到「叫一个」区块')
  const before = tpl.slice(0, bidHead)
  const lastIf = before.lastIndexOf('wx:if=')
  const lastElif = before.lastIndexOf('wx:elif=')
  const lastCond = Math.max(lastIf, lastElif)
  assert.ok(lastCond > 0, '「叫一个」前面应该有阶段判断（stage === playing）')
  /* 取这条 wx:if/elif 的完整表达式 */
  const condText = before.slice(lastCond, before.indexOf('>', lastCond))
  assert.ok(!/liarReady/.test(condText),
    '★ 「叫一个」区块被 liarReady 挡住了：' + condText.trim() + '\n' +
    '    没偷看过的玩家会看不到任何叫骰按钮 —— 这就是「大话骰无法喊骰」的根因。\n' +
    '    正确做法是引导（显示按钮 + 说明为什么不能点），不是藏起来。')
  ok('「叫一个」区块没有被 liarReady 挡住（入口常显）')

  /* 叫骰按钮必须在，且带"锁定"态而不是被隐藏 */
  assert.ok(/wx:for="\{\{room\.options\}\}"/.test(tpl),
    '★ 模板里没有渲染 room.options 的叫骰按钮')
  assert.ok(/class="optbtn[^"]*\{\{/.test(tpl),
    '★ 叫骰按钮没有动态 class —— 无法表达"现在还不能点"')
  ok('叫骰按钮常显，并用动态 class 表达可用/锁定')

  /* 三种状态都要有引导文案 */
  for (const [pat, what] of [
    [/liarReady/, '没偷看时的引导'],
    [/room\.myTurn/, '轮次提示'],
    [/room\.turnName/, '等谁叫']
  ]) {
    assert.ok(pat.test(tpl), `模板里缺少「${what}」`)
  }
  ok('模板里有：没偷看的引导 + 轮次提示 + 等谁叫')

  /* ============ ⑤ 模板引用的字段必须在 js 里真的算出来 ============ */
  console.log('\n=== ⑤ 模板引用的状态字段必须有出处 ===')

  /*
   * ⚠️ 第一版把字段名**硬编码**在测试里 —— 那样测的是"我列的那几个"，
   *    而不是"模板真正用到的"。往模板里加个 {{room.ghostField}}
   *    照样通过（反向验证时发现的）。现在改成**从模板里抽**。
   *
   * 只查"前端算出来的派生字段"：room.* 里除了服务端 shape() 返回的那些，
   * 其余（options / myTurn / turnName / waitingCount / waitingNames）
   * 必须由页面自己赋值，否则渲染恒空。
   */
  const derived = new Set()
  for (const mm of tpl.matchAll(/\{\{\s*room\.([a-zA-Z][\w]*)/g)) derived.add(mm[1])
  /* 服务端 shape() 真正返回的字段（前端直接用，不需要自己算） */
  const fromServer = new Set([
    'id', 'code', 'game', 'phase', 'host', 'me', 'players', 'count',
    'countdownMs', 'turn', 'round', 'bid', 'lastResult', 'streaks', 'spin', 'updatedAt'
  ])
  const mustCompute = [...derived].filter(f => !fromServer.has(f))
  assert.ok(mustCompute.length >= 4,
    `模板里只用到 ${mustCompute.length} 个派生字段，` +
    '预期至少有 options/myTurn/turnName/waiting* —— 抽取逻辑可能失效了')
  const noSource = mustCompute.filter(f =>
    !new RegExp('room\\.' + f + '\\s*=').test(code))
  assert.deepStrictEqual(noSource, [],
    '★ 模板用了这些字段，但 js 里没有任何 `room.xxx =` 赋值（渲染恒空）：\n    ' +
    noSource.map(f => 'room.' + f).join('\n    '))
  ok(`模板用的 ${mustCompute.length} 个派生字段都有赋值来源（${mustCompute.join(' / ')}）`)

  /* ============ ⑥ 动态 class 必须有样式 ============ */
  console.log('\n=== ⑥ 动态 class 必须有 CSS 定义 ===')

  /* 从模板里抓 {{... ? 'a' : 'b'}} 形式的类名，逐个查 wxss */
  const dyn = new Set()
  for (const mm of tpl.matchAll(/class="([^"]*\{\{[^"]*)"/g)) {
    for (const lit of mm[1].matchAll(/'([a-zA-Z][\w-]*)'/g)) dyn.add(lit[1])
  }
  const missingCss = [...dyn].filter(c => {
    /* 词边界：.waitingX 不该被当成 .waiting 命中 */
    const re = new RegExp('\\.' + c.replace(/[-]/g, '\\-') + '(?![\\w-])')
    return !re.test(css) && !re.test(fs.readFileSync(path.join(ROOT, 'miniprogram/app.wxss'), 'utf8'))
  })
  assert.deepStrictEqual(missingCss, [],
    '★ 模板里的动态 class 没有 CSS 定义（样式静默失效）：\n    ' +
    missingCss.join('\n    '))
  ok(`动态 class ${dyn.size} 个全部有样式定义`)

  console.log(`\n${'='.repeat(58)}`)
  console.log(`  房间页状态机：全部 ${n} 项断言通过`)
  console.log(`${'='.repeat(58)}\n`)
})()

process.on('uncaughtException', (e) => {
  console.error('\n  ✗ 断言失败：', e.message, '\n')
  process.exit(1)
})
