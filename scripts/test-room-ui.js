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
const JS = path.join(ROOT, 'miniprogram/pages/room/room.js')
const WXML = path.join(ROOT, 'miniprogram/pages/room/room.wxml')
const WXSS = path.join(ROOT, 'miniprogram/pages/room/room.wxss')

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

  /* ============ ④b ★ 真的跑一遍 decorate()，验证派生字段的值 ============
   *
   * ★ 为什么需要这条：`decorate()` 算出了十几个派生字段
   *   （options / myTurn / turnName / waitingCount / spectating / settleFoot /
   *    streakText / loserBoard / howList / hintText / drinkText …），
   *   但**从来没有任何测试真正执行过它**：
   *     · 离线渲染器不跑页面逻辑，只吃 mock 静态数据
   *     · ⑤ 只检查"有没有赋值"，不检查"赋的值对不对"
   *
   *   2026-10-28 就吃过这个亏：给金花加了 hintText，断言全绿、
   *   渲染器也画不出来（它不执行 decorate），只能靠人工看真机才可能发现。
   *
   * 做法：从源码抽出 decorate 的函数体，用桩 this 真跑一遍。
   */
  {
    const src = fs.readFileSync(JS, 'utf8')
    const at = src.indexOf('decorate(room)')
    assert.ok(at > 0, '找不到 decorate（抽取可能失效）')
    const open = src.indexOf('{', at)
    let depth = 0, end = -1
    for (let k = open; k < src.length; k++) {
      if (src[k] === '{') depth++
      else if (src[k] === '}') { depth--; if (depth === 0) { end = k; break } }
    }
    assert.ok(end > open, 'decorate 的括号没配平')
    const body = src.slice(open + 1, end)

    const poker = require(path.join(ROOT, 'miniprogram/utils/poker.js'))
    const games = require(path.join(ROOT, 'miniprogram/utils/games.js'))
    const decorate = new Function('poker', 'gameOf', 'return function decorate(room){' + body + '}')(poker, games.gameOf)
    const stub = { buildOptions: () => ['1个1'] }

    /* ① 金花牌型提示 + 换牌量 */
    const pk = decorate.call(stub, {
      game: 'poker', phase: 'playing', count: 2, me: { seat: 1, name: '我' },
      players: [
        { openid: 'a', name: '我', seat: 1, isMe: true, inRound: true, out: false, score: 0 },
        { openid: 'b', name: '他', seat: 2, isMe: false, inRound: true, out: false, score: 0 }
      ],
      poker: {
        publicCard: { r: 12, s: 0 }, myKnown: { r: 12, s: 2 },
        myDrink: 0, drinks: [{ name: '我', cups: 0 }, { name: '他', cups: 1.5 }]
      }
    })
    assert.strictEqual(pk.poker.hintText, '至少是对子',
      '两张同点数必须提示「至少是对子」，实际：' + pk.poker.hintText)
    assert.strictEqual(pk.players[1].drinkText, '1.5 杯',
      '换牌量应翻译成「1.5 杯」，实际：' + pk.players[1].drinkText)
    assert.strictEqual(pk.players[0].drinkText, '', '没换过牌的人不该显示数字')

    /* ② 观战判定 */
    const sp = decorate.call(stub, {
      game: 'liar', phase: 'playing', count: 2, me: { seat: 1, name: '我' },
      players: [
        { openid: 'a', name: '我', seat: 1, isMe: true, inRound: false, score: 0 },
        { openid: 'b', name: '他', seat: 2, isMe: false, inRound: true, score: 0 }
      ]
    })
    assert.strictEqual(sp.spectating, true, '中途加入的人 spectating 必须为 true')

    /* ③ 连庄 / 今晚最惨 / 结算收尾 */
    const ov = decorate.call(stub, {
      game: 'liar', phase: 'over', count: 3, me: { seat: 1, name: '我' },
      players: [
        { openid: 'a', name: '我', seat: 1, isMe: true, inRound: true, score: -3 },
        { openid: 'b', name: '他', seat: 2, isMe: false, inRound: true, score: 0 }
      ],
      streaks: { 2: 3 }, lastResult: { loserName: '我' }
    })
    assert.strictEqual(ov.streakText, '他 连赢 3 把', '连庄文字不对：' + ov.streakText)
    assert.strictEqual(ov.loserBoard, '我 今晚已经输了 3 局', '今晚最惨文字不对：' + ov.loserBoard)
    assert.strictEqual(ov.settleFoot, '我 喝一杯', '结算收尾不对：' + ov.settleFoot)

    /* ④ 规则文案来自注册表，不是页面里另写一份 */
    assert.ok(ov.howList.length >= 3, '规则条目应来自注册表')
    assert.strictEqual(ov.gameName, games.gameOf('liar').name, '玩法名应来自注册表')

    ok('★ decorate() 真跑一遍：牌型提示 / 换牌量 / 观战 / 连庄 / 今晚最惨 / 规则文案 全部正确')
  }

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
  /*
   * ★ 服务端返回的字段清单**从源码里抽**，不能硬编码。
   *
   * 这个清单原本是手写的。结果本轮给 shape() 加了 `deck`（题卡场合）之后，
   * 断言立刻报「模板用了 room.deck 但 js 里没有赋值」—— 而 deck 本来就是
   * 服务端字段、根本不需要前端算。**是清单没跟上，不是代码错。**
   *
   * 这正是 AGENTS.md 里记过的同一个坑（"幽灵字段断言把字段名硬编码在测试里"）。
   * 手写的清单会随着代码演进变成"假失败"，而假失败会让人去改本来正确的代码。
   *
   * 改成从 `cloudfunctions/room/index.js` 的 shape() 返回体里抽键名 ——
   * 加了字段自动纳入，不用记着来改测试。
   */
  const roomCloud = fs.readFileSync(
    path.join(ROOT, 'cloudfunctions/room/index.js'), 'utf8')
  const shapeBody = /function shape\(room, openid\)[\s\S]*?\n\}/.exec(roomCloud)
  assert.ok(shapeBody, '抽不出 shape() 的函数体 —— 抽取逻辑可能失效了')
  const fromServer = new Set(
    [...shapeBody[0].matchAll(/^\s{4}([a-zA-Z][\w]*):/gm)].map(m => m[1])
  )
  assert.ok(fromServer.has('id') && fromServer.has('phase') && fromServer.has('players'),
    'shape() 抽出的字段不全（应含 id/phase/players），实际：' + [...fromServer].join(','))
  assert.ok(fromServer.has('deck'),
    '★ shape() 里应该有 deck（题卡场合）—— 没有的话房间页拿不到当前场合')
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

  /*
   * ★★★ ⑥ 派生字段必须只有一个出口（2026-10-09 真实事故）
   *
   * 上面那条只查了"有没有 `room.xxx =` 赋值"，**查不出"赋值是不是每次都会跑"**。
   * 而本次「点击 2个3 没反应」恰恰是这么来的：
   *
   *   服务端 shape() **不返回** options/myTurn/turnName/waiting*（它们是前端算的），
   *   而页面里有 7 处 `this.setData({ room: r.room })` —— setData 对 room 是
   *   **整体替换**，每调一次就把这些派生字段抹成 undefined。
   *   于是：点一下 → 请求成功 → options 被抹掉 → 再点 → 取不到文本 → 裸 return
   *   → **完全没反应，连请求都不发、一句提示都没有**。
   *
   * 这和「转盘无法转」（stage 在 doStart 里被手写死）是**同一类错误**：
   *   同一份状态有多个写入出口，迟早不同步。
   *   stage 的解法是收敛到 stageOf()；派生字段的解法是收敛到 decorate()。
   *
   * 判据（两条，缺一不可）：
   *   ① 必须存在 decorate()，且它真的算了这些派生字段
   *   ② 所有 `setData({... room: <表达式> ...})` 里，<表达式> 只能有两种形态：
   *        · `this.decorate(...)`  —— 补全后写入
   *        · `null`                —— 清空（离开房间）
   *      出现裸的 `r.room` / `res.room` 就是漏网之鱼
   */
  console.log('\n=== ⑥ 派生字段只能有一个出口（decorate） ===')

  assert.ok(/decorate\s*\(\s*room\s*\)\s*\{/.test(code),
    '★ 找不到 decorate() —— 前端派生字段（options/myTurn/turnName/waiting*）' +
    '必须收敛到一个补全入口，否则某处 setData 会把它们抹掉')
  for (const f of mustCompute) {
    assert.ok(new RegExp('room\\.' + f + '\\s*=').test(
      (/decorate\s*\(\s*room\s*\)\s*\{([\s\S]*?)\n  \}/.exec(code) || ['', ''])[1]),
      `★ decorate() 里没有算 room.${f} —— 它会在每次写入后变成 undefined`)
  }
  ok(`decorate() 补齐了全部 ${mustCompute.length} 个派生字段`)

  /* 找出所有 `setData({ ... room: X ... })`，检查 X 的形态 */
  const badWrites = []
  for (const mm of code.matchAll(/setData\(\{[^}]*?\broom:\s*([^,}]+)/g)) {
    const expr = mm[1].trim()
    /* 允许：this.decorate(...) / null（清空）/ 变量（refresh 里已 decorate 过） */
    const allowed = /^this\.decorate\(/.test(expr) || expr === 'null' || expr === 'room'
    if (!allowed) {
      const line = code.slice(0, mm.index).split('\n').length
      badWrites.push(`第 ${line} 行附近  room: ${expr}`)
    }
  }
  assert.deepStrictEqual(badWrites, [],
    '★ 这些 setData 直接写入原始 room，会**抹掉前端派生字段**\n' +
    '    （options/myTurn/turnName/waiting* —— 服务端 shape() 不返回它们）：\n    ' +
    badWrites.join('\n    ') +
    '\n    症状：点一下能成功，之后按钮就"点了没反应"（取不到选项文本，静默 return）\n' +
    '    修法：改成 room: this.decorate(r.room)')
  ok('所有 setData 写 room 的路径都经过 decorate（无裸写入）')

  /*
   * ★ 叫骰按钮必须**自带选项文本**（data-l），不能只靠下标去查派生数组。
   *
   * 按下标取是"依赖派生状态"：派生数组为空 → 取到空串 → 静默失败；
   * 派生数组比视图层新一拍 → **取到另一个叫法**（点「2个3」叫出「2个4」），
   * 两者都不报错。把文本跟着按钮传，点击的含义就只由"用户看到的按钮"决定。
   */
  const bidBtn = /<view[^>]*data-i="\{\{index\}\}"[^>]*bindtap="doBid"/.exec(tpl)
  assert.ok(bidBtn, '找不到叫骰按钮')
  assert.ok(/data-l="\{\{item\}\}"/.test(bidBtn[0]),
    '★ 叫骰按钮没有 `data-l="{{item}}"` —— 只传下标会让点击依赖派生数组，' +
    '数组被抹掉时"点了没反应"，数组抢先更新时"叫错骰"（都不报错）')
  ok('叫骰按钮自带选项文本（data-l），点击不依赖派生数组')

  /* ============ ⑤b 回大厅只能有一个入口 ============ */
  console.log('\n=== ⑤b 「回大厅」只能有一个入口（再来一局 / 换玩法）===')
  /*
   * ★「再来一局」和「换个玩法」在服务端已合并成一个 action（清局内状态 → 回 lobby），
   *   前端也必须走同一个方法。否则两份 UI 更新逻辑必然有一份漏字段，
   *   而且**不报错** —— 表现是"换了玩法但界面还是旧的"，极难查。
   *
   * 这和本项目记过的两次事故是同一类：
   *   · `stage` 在 doStart 里被手写死 → 「转盘无法转」
   *   · 派生字段有 7 个出口 → 「点击叫骰没反应」
   *
   * 判据：**调用 `action: 'again'` 或 `action: 'game'` 的地方必须只有一处**。
   */
  /*
   * ⚠️ 这个判据我写错了**三版**，值得记下来（都是"用正则猜代码写法"）：
   *
   *   v1  数 `action:\s*'(again|game)'` 字面量
   *       → 统一入口写的是三元 `action: game ? 'game' : 'again'`，**匹配不到**
   *       → 数到 0 处，故意加一处后变成 1 处，仍 ≤1 → **假通过**
   *   v2  抓 `call('room', {...})` 的 action 表达式
   *       → 但统一入口把 payload 提成了**变量** `call('room', payload, ...)`，**还是匹配不到**
   *       → 正常代码数到 0 处 → **假失败**
   *   v3（本版）不猜写法，而是**从"哪个变量承载了 again/game"倒推**
   *
   * ★ 教训：判据不能依赖"代码长什么样"。要用**语义**判：
   *   凡是"构造出的 payload 里含 again/game 字样"的地方，必须只有一处。
   */
  const hallDefs = [...code.matchAll(/(?:const|let|var)\s+([A-Za-z_$][\w$]*)\s*=\s*\{[^}]*action:[^,}]*'(again|game)'/g)]
  assert.strictEqual(hallDefs.length, 1,
    '★ 构造「回大厅」请求的地方必须**恰好一处**（backToLobby 内），实际 ' + hallDefs.length + ' 处：\n    ' +
    hallDefs.map(m => '第 ' + code.slice(0, m.index).split('\n').length + ' 行  变量 ' + m[1]).join('\n    ') +
    '\n    两份清理逻辑必然有一份漏字段，而且不报错（表现是"换了玩法但界面是旧的"）')

  /*
   * 并且这个 payload 只能被传给 call('room', ...) 一次 ——
   * 否则可能出现"某处绕开 backToLobby 自己发请求"。
   */
  const hallVar = hallDefs[0][1]
  const uses = [...code.matchAll(new RegExp("call\\(\\s*'room'\\s*,\\s*" + hallVar + "\\b", 'g'))]
  assert.strictEqual(uses.length, 1,
    '★ 「回大厅」的 payload 变量 ' + hallVar + ' 被调用 ' + uses.length + ' 次（应为 1）')

  ok('「回大厅」只有一个服务端入口（backToLobby 统一封装 again/game）')

  /* 换玩法必须带上场合（换到转盘时用得到），否则转盘会退回默认题库 */
  assert.ok(/game === 'wheel'[\s\S]{0,80}deck/.test(code),
    '★ 换到转盘时没有带上题卡场合 —— 会退回默认题库，房主选的场合失效')
  ok('换到转盘时会带上题卡场合')

  /* 换玩法后 pickGame 要跟着切，否则再点"开一局"会用旧玩法 */
  assert.ok(/pickGame:\s*r\.game/.test(code),
    '★ 换玩法后没有同步 pickGame —— 再点"开一局"会用回旧玩法')
  ok('换玩法后建房的玩法选择会同步（不会用回旧玩法）')

  /* ============ ⑥ 动态 class 必须有样式 ============ */
  console.log('\n=== ⑥ 动态 class 必须有 CSS 定义 ===')

  /* 从模板里抓 {{... ? 'a' : 'b'}} 形式的类名，逐个查 wxss */
  const dyn = new Set()
  for (const mm of tpl.matchAll(/class="([^"]*\{\{[^"]*)"/g)) {
    for (const lit of mm[1].matchAll(/'([a-zA-Z][\w-]*)'/g)) dyn.add(lit[1])
  }
  /*
   * 确实不需要样式的类，用**显式白名单**放行 —— 不要放宽判据。
   * 放宽（比如"找不到就跳过"）等于把这条断言变成废的，那正是
   * AGENTS.md 里记过的「③e-2 主动跳过没定义的类」那个坑。
   *
   * 每一项都要写清"为什么不需要样式"：
   */
  const NO_STYLE_NEEDED = new Set([
    /* 题卡的"默认态"：颜色由 .cardbox 的默认样式给，
       只有 .dare 需要改色。所以 truth 这个字面量是**语义标记**，不是样式钩子。 */
    'truth'
  ])
  const missingCss = [...dyn].filter(c => {
    if (NO_STYLE_NEEDED.has(c)) return false
    /* 词边界：.waitingX 不该被当成 .waiting 命中 */
    const re = new RegExp('\\.' + c.replace(/[-]/g, '\\-') + '(?![\\w-])')
    return !re.test(css) && !re.test(fs.readFileSync(path.join(ROOT, 'miniprogram/app.wxss'), 'utf8'))
  })
  assert.deepStrictEqual(missingCss, [],
    '★ 模板里的动态 class 没有 CSS 定义（样式静默失效）：\n    ' +
    missingCss.join('\n    '))
  ok(`动态 class ${dyn.size} 个全部有样式定义`)

  /*
   * ⚠️ 这条断言的**固有边界**（2026-10-10 反向验证时确认，如实记录）：
   *
   *   它的判据是「这个类名在 wxss 里出现过」，**不是**「每种状态都有完整样式」。
   *   所以如果某个类有多条规则（例如 `.cardbox.dare::before` 管色条、
   *   `.cardbox.dare .cb-type` 管标签色），删掉其中一条，另一条仍会让正则命中，
   *   断言**测不出来**。
   *
   *   实测：删掉 `.cardbox.dare::before` 后断言照样通过。
   *
   *   它真正能抓的是「整个类没定义」——那是最常见、后果最重的一种
   *   （样式静默失效 / <image> 撑满容器）。
   *   "少写了一条规则"属于视觉问题，只能靠真机看或截图比对，静态断言做不到。
   *   **知道边界在哪，比假装它全能更有用。**
   */

  /* ============ ⑪ ★ 写操作的入口必须有观战守卫 ============
   *
   * 中途加入的人这一局只能看。服务端会拒，但那是**冷冰冰的错误**，
   * 玩家不知道"为什么只有我不行"。
   *
   * ★ 为什么必须用断言锁：守卫是在每个操作方法里逐个加的 ——
   *   加漏一个**不报错**，只是那个操作会绕过友好提示、直接吃服务端的拒绝。
   *   而"漏一个"正是逐个添加最容易发生的事（本项目栽过多次）。
   *
   * 判据：凡是 `call('room', { action: '<写操作>' })` 的方法，
   *      方法体里必须有 specGuard()。只读的（status）和入口流程
   *      （create/join/leave/again/game）不要求 —— 那时还没有 room 或本来就该允许。
   */
  {
    const src = fs.readFileSync(JS, 'utf8')
      .replace(/\/\*[\s\S]*?\*\//g, '')
      .replace(/(^|[^:])\/\/[^\n]*/g, '$1')
    /*
     * 'card'（加自定义题）刻意放行：那是往**题池**里加题，为下一局准备，
       不属于"这一局的动作" —— 旁观的人想出个题完全合理。
     */
    const READONLY = new Set(['status', 'create', 'join', 'leave', 'again', 'game', 'deck', 'cardDel', 'card'])

    // 抽方法体：从 "  async xxx(" 或 "  xxx(" 开始，按大括号配平
    const methods = []
    const re = /\n  (?:async )?([a-zA-Z_][\w]*)\s*\(([^)]*)\)\s*\{/g
    let m
    while ((m = re.exec(src))) {
      const open = src.indexOf('{', m.index + m[0].length - 1)
      if (open < 0) continue
      let depth = 0, end = -1
      for (let k = open; k < src.length; k++) {
        if (src[k] === '{') depth++
        else if (src[k] === '}') { depth--; if (depth === 0) { end = k; break } }
      }
      if (end < 0) continue
      methods.push({ name: m[1], body: src.slice(open, end + 1) })
    }

    const missing = []
    for (const md of methods) {
      const acts = Array.from(md.body.matchAll(/action\s*:\s*['"](\w+)['"]/g)).map(x => x[1])
      const writes = acts.filter(a => !READONLY.has(a))
      if (!writes.length) continue
      if (!/specGuard\s*\(/.test(md.body)) missing.push(md.name + '（' + writes.join(',') + '）')
    }
    assert.deepStrictEqual(missing, [],
      '★ 这些写操作方法没有观战守卫 —— 中途加入的人会绕过友好提示，直接吃服务端的拒绝：\n    ' +
      missing.join('\n    ') +
      '\n    修法：方法开头加 `if (!this.specGuard()) return`')
    ok(`写操作入口 ${methods.length ? '' : ''}全部有观战守卫`)
  }

  /* ============ ⑫ ★ 骰盅流程不能被非骰子玩法触发 ============
   *
   * 2026-10-28 的真实缺陷：`prev.phase !== room.phase` 里
   * `playing` 那一支**无条件**播 diceIn、1 秒后调 autoShake()（1 秒多摇盅声）。
   * 而卧底 / 金花 / 转盘根本没有骰盅 —— 玩卧底开局时会听到一阵哗啦啦摇骰子。
   *
   * ★ 为什么一直没被发现：**界面上完全看不出来**，只有耳朵能听见。
   *   这类"只有听觉暴露"的缺陷，静态断言是唯一可靠的防线。
   *
   * 判据：阶段变化块里只要出现骰盅专用调用（autoShake / diceIn / cupOpen / cupSrc），
   *      同一个块里就必须出现玩法判断（room.game === 'liar' / 'dice'）。
   */
  {
    const src = fs.readFileSync(JS, 'utf8')
      .replace(/\/\*[\s\S]*?\*\//g, '')
      .replace(/(^|[^:])\/\/[^\n]*/g, '$1')
    /*
     * ⚠️ 必须匹配**带大括号**的那一处。
     *    `indexOf('prev.phase !== room.phase')` 会先命中 roomChanged 里那行
     *    `if (prev.phase !== room.phase) return true`（单行、没有块），
     *    于是抽出来的是个空的 `{}` —— 所有检查都"通过"，断言形同虚设。
     *    （这是第三次栽在"用 indexOf 找代码"上：位置对了不代表形态对了。）
     */
    const gateRe = /prev\.phase\s*!==\s*room\.phase\s*\)\s*\{/g
    let hit = null, mm
    while ((mm = gateRe.exec(src))) {
      /* 取最后一个 —— refresh 里的那处才是我们要的阶段变化块 */
      hit = mm
    }
    assert.ok(hit, '找不到"阶段变化"的代码块（抽取可能失效）')
    const open = src.indexOf('{', hit.index)
    let depth = 0, end = -1
    for (let k = open; k < src.length; k++) {
      if (src[k] === '{') depth++
      else if (src[k] === '}') { depth--; if (depth === 0) { end = k; break } }
    }
    assert.ok(end > open, '阶段变化块的括号没配平')
    const block = src.slice(open, end + 1)

    /*
     * ⚠️ 判据必须按**位置**判，不能只判"块内出现过"。
     *    第一版就是"块里只要有 room.game === 'liar' 就算过" ——
     *    可 over 分支也有一处同样的判断，于是把 playing 那处的判断改成
     *    `if (true)` 之后**断言照样通过**（反向验证当场发现的假绿）。
     *
     * 现在的判据：**每一处**骰盅调用都必须出现在某个玩法判断**之后**。
     */
    const DICE_CALLS = ['autoShake', "fire('diceIn')", "fire('cupOpen')", 'cupSrc']
    const gateAt = block.search(/room\.game\s*===\s*'(?:liar|dice)'/)
    const unguarded = []
    for (const c of DICE_CALLS) {
      let from = 0
      while ((from = block.indexOf(c, from)) >= 0) {
        if (gateAt < 0 || from < gateAt) unguarded.push(c + ' @' + from)
        from += c.length
      }
    }
    assert.deepStrictEqual(unguarded, [],
      '★ 这些骰盅调用出现在玩法判断**之前**（或块里压根没有判断）—— ' +
      '卧底 / 金花 / 转盘开局会听到摇骰子的声音：\n    ' + unguarded.join('\n    ') +
      '\n    修法：用 `if (room.game === \'liar\' || room.game === \'dice\') { ... }` 包起来')
    ok('阶段变化的骰盅调用全部在玩法判断之后')
  }

  /* ============ ⑩ ★ 延迟回调里改 stage 必须有守卫 ============
   *
   * 2026-10-28 的真实竞态：比大小结算有一段
   *   `setTimeout(() => setData({ stage: 'over' }), 1500)`
   * 而 `leave()` 只 stopPoll()、**没清定时器**。
   * 于是"结算动画那 1.5 秒内退出房间"会留下一个待触发的回拨，
   * 触发时 room 已被置 null → stage 变 'over' 但 room 为空
   * → over 分支访问 room.game 得到 undefined → **白屏**。
   *
   * 这是「延迟回调期间的业务状态变化」，和 `_dead` 是**两件事**：
   *   页面还活着（_dead=false），但它描述的实体没了（room=null）。
   * 所以守卫必须同时看 `_dead` 和 `this.data.room`（或 `this.data.stage`）。
   */
  {
    // 抽出所有 setTimeout 回调体（按括号配平）
    const bodies = []
    const src = fs.readFileSync(JS, 'utf8')
      .replace(/\/\*[\s\S]*?\*\//g, '')
      .replace(/(^|[^:])\/\/[^\n]*/g, '$1')
    let idx = 0
    while ((idx = src.indexOf('setTimeout(', idx)) >= 0) {
      const open = src.indexOf('{', idx)
      if (open < 0) break
      let depth = 0, end = -1
      for (let k = open; k < src.length; k++) {
        if (src[k] === '{') depth++
        else if (src[k] === '}') { depth--; if (depth === 0) { end = k; break } }
      }
      if (end < 0) break
      bodies.push(src.slice(open, end + 1))
      idx = end
    }

    const unguarded = []
    for (const b of bodies) {
      if (!/\bstage\s*:/.test(b)) continue          // 不改 stage 的回调不归这条管
      const hasDead = /this\._dead/.test(b)
      const hasRoom = /this\.data\.room/.test(b)
      const hasStage = /this\.data\.stage/.test(b)
      if (!hasDead && !hasRoom && !hasStage) unguarded.push(b.replace(/\s+/g, ' ').slice(0, 90))
    }
    assert.deepStrictEqual(unguarded, [],
      '★ 这些延迟回调改了 stage，但没检查页面/房间是否还在 —— ' +
      '退出房间后定时器仍会触发，导致 stage 与 room 不同步（白屏）：\n    ' +
      unguarded.join('\n    ') +
      '\n    修法：回调开头加 `if (this._dead || !this.data.room) return`')
    ok(`延迟回调改 stage 的 ${bodies.filter(b => /\bstage\s*:/.test(b)).length} 处都有守卫`)
  }

  /* ============ ⑨ ★ 每个玩法都必须有 wxml 分支（不许用 wx:else 兜底）============
   *
   * 2026-10-27 的真实事故：
   *   玩法分支原来写成 `<block wx:if="liar">` / `wx:elif="dice"` /
   *   **`<block wx:else>`（转盘）**。前三个玩法时看不出问题 ——
   *   else 恰好只命中 wheel。
   *   一加第 4 个玩法「谁是卧底」，卧底局直接渲染成了**转盘**：
   *   屏幕上出现了转盘、题卡、转按钮，而"你的词"挤在下面。
   *
   *   `wx:else` 兜底的危害是通病：**新增成员时会静默落进兜底分支**，
   *   不报错、不警告，只是界面变成了别的东西。
   *
   * 判据（语义，不看代码长相）：
   *   从注册表读全部玩法 id，断言模板里每个都有 `room.game === '<id>'` 的分支。
   *   这样"加了玩法忘了写界面"会当场报错。
   */
  {
    const { GAMES } = require(path.join(ROOT, 'miniprogram', 'utils', 'games.js'))
    const tpl = fs.readFileSync(WXML, 'utf8').replace(/<!--[\s\S]*?-->/g, '')
    const missing = []
    for (const g of GAMES) {
      /*
       * ★ 判据必须是"出现在 wx:if / wx:elif **链**上"，不能只说"出现过"。
       *   第一版就写成了「模板里出现过就算有分支」——
       *   而结算区恰好也有 `room.game === 'undercover' && …`，
       *   于是把玩法分支故意改名成 undercoverXX 反向验证时**照样通过**。
       *   这是"判据只被目标改动影响"的又一次翻车（AGENTS.md 记过同类）。
       */
      const re = new RegExp('wx:(if|elif)="\\{\\{room\\.game\\s*===\\s*[\'"]' + g.id + '[\'"]\\}\\}"')
      if (!re.test(tpl)) missing.push(g.id + '（' + g.name + '）')
    }
    assert.deepStrictEqual(missing, [],
      '★ 这些玩法在 room.wxml 里没有渲染分支（大厅能看到，进去却是一片空白/别的玩法）：\n    ' +
      missing.join('\n    ') +
      '\n    修法：加一个 `<block wx:elif="{{room.game === \'<id>\'}}">`，' +
      '不要用 wx:else 兜底。')
    ok(`注册表 ${GAMES.length} 个玩法都有对应的界面分支（没有 else 兜底）`)
  }

  console.log(`\n${'='.repeat(58)}`)
  console.log(`  房间页状态机：全部 ${n} 项断言通过`)
  console.log(`${'='.repeat(58)}\n`)
})()

process.on('uncaughtException', (e) => {
  console.error('\n  ✗ 断言失败：', e.message, '\n')
  process.exit(1)
})
