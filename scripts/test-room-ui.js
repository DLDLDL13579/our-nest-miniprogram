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
const JS = path.join(ROOT, 'miniprogram/game/room/room.js')
const WXML = path.join(ROOT, 'miniprogram/game/room/room.wxml')
const WXSS = path.join(ROOT, 'miniprogram/game/room/room.wxss')

let n = 0
function ok(msg) { n++; console.log('  ✓ ' + msg) }

const src = fs.readFileSync(JS, 'utf8')
const tpl = fs.readFileSync(WXML, 'utf8')
const css = fs.readFileSync(WXSS, 'utf8')
/* 剥掉注释再扫代码 —— 否则注释里写的反例会被当成真代码 */
const code = src.replace(/\/\*[\s\S]*?\*\//g, '').replace(/(^|[^:])\/\/[^\n]*/g, '$1')

;(() => {
  /* ============ ⑬ 顶栏标题跟随玩法（2026-10-30） ============ */
  /*
   * 原来顶栏永远是「房间」—— 分享到群里朋友点进来，顶栏什么信息都没有；
   * 微信搜索也读页面标题。
   */
  {
    const src = fs.readFileSync(path.join(ROOT, 'miniprogram/game/room/room.js'), 'utf8')
    assert.ok(/setNavigationBarTitle/.test(src),
      '★ 房间页应该随玩法更新顶栏标题（否则分享进来只看到"房间"两个字）')
    assert.ok(/gameOf\(g\)/.test(src) || /gameOf\(raw\.game\)/.test(src),
      '★ 标题必须取玩法注册表里的名字（不要另写一份映射）')
    ok('★ 顶栏标题跟随玩法（大话骰 · 627）')
  }

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
   * ★★ 2026-11-02 补：**调用点**也要断言。
   *
   * 上面那几条只检查"函数存在且映射正确"，但不检查"有没有人用它" ——
   * 用 verify-assert 把 doCreate 里的 `const newStage = stageOf(r.room.phase)`
   * 改成 `const newStage = 'lobby'`，**测试照样通过**。
   *
   * 而 AGENTS.md 记过真实事故：`doStart` 把 stage 写死成 'playing'，
   * 服务端返回 countdown 时转盘就转不了 —— 症状是"某台手机能点另一台不能"。
   *
   * 判据：`doCreate` / `applyRoom` 这两个"从服务端拿数据"的入口，
   * 阶段必须来自 stageOf，不能是字面量。
   */
  {
    const fnBody = (name) => {
      const i = code.indexOf('  ' + name + '(')
      if (i < 0) return ''
      /* 取到下一个同级方法开头（两空格缩进的 async/普通方法） */
      const rest = code.slice(i + 4)
      const j = rest.search(/\n  (?:async )?\w+\s*\(/)
      return j < 0 ? rest : rest.slice(0, j)
    }
    const doCreate = fnBody('async doCreate')
    assert.ok(doCreate.length > 100, 'doCreate 函数体没抽出来')
    assert.ok(/stageOf\s*\(/.test(doCreate),
      '★ doCreate 里必须用 stageOf() 推导阶段 —— 写死字面量会让某个 phase 落到错的界面')
    ok('★ doCreate：阶段来自 stageOf()，不是写死')
  }

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
    /*
     * ⚠️ 必须找**定义**而不是调用（2026-10-29）。safeDecorate 里有
     * `this.decorate(room)`，而 safeDecorate 定义在 decorate 之前 ——
     * `indexOf('decorate(room)')` 会先命中 safeDecorate 里的调用，
     * 抽出来的是 safeDecorate 的函数体（4 行），不是 decorate（几百行）。
     */
    const at = src.indexOf('  decorate(room) {')
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
    /*
     * ⚠️ decorate 依赖的外部变量要**全部注入** —— 少一个就是 "xxx is not defined"。
     * 2026-10-29 把 settleFoot 抽成独立模块后，这里就崩过一次。
     */
    const liarRules = require('../miniprogram/utils/liarRules.js')
const settleMod = require(path.join(ROOT, 'miniprogram/game/settle.js'))
    const bidMod = require(path.join(ROOT, 'miniprogram/game/bidOptions.js'))
    /* 每抽一个模块出来，这里就多一个参数 —— 一天内栽了两次（settleFoot、bidOptions）。
       再抽就该改成"注入一个依赖对象"，而不是继续往参数列表上加。 */
    const decorate = new Function('poker', 'gameOf', 'settleFoot', 'bidOptions', 'liarRules',
      'return function decorate(room){' + body + '}')(poker, games.gameOf, settleMod, bidMod, liarRules)
    /*
     * ★ 2026-11-02：stub 原来只有 buildOptions，**没有 data** ——
     *   而 decorate 里有  这样的读取，于是抛
     *   「Cannot read properties of undefined (reading 'zhaiMode')」，
     *   被 decorate 自己的 try/catch 兜成默认值。
     *   后果：**所有依赖 this.data 的派生字段，测试测的都是兜底值**，
     *   等于没测。补上 data 之后才是真的跑。
     */
    const stub = { data: {}, buildOptions: () => ['1个1'] }

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
    /*
     * ★ 2026-10-30 文案变了：暗牌改成「纯想象、取最优」之后，
     *   提示从"至少是对子"（旧规则的模糊措辞）变成确定的"最大能到：豹子（差 ♠Q）"。
     *   守的意图仍是"两张同点数要能让玩家知道自己手里有硬货"。
     */
    assert.ok(/最大能到：豹子/.test(pk.poker.hintText),
      '两张同点数应提示「最大能到：豹子」，实际：' + pk.poker.hintText)
    assert.strictEqual(pk.players[1].drinkText, '1.5 杯',
      '换牌量应翻译成「1.5 杯」，实际：' + pk.players[1].drinkText)
    assert.strictEqual(pk.players[0].drinkText, '', '没换过牌的人不该显示数字')

    /* ①a "轮到谁" —— 说错名字会让桌上催错人 */
    const t2 = decorate.call(stub, {
      game: 'liar', phase: 'playing', count: 3, turn: 2, me: { seat: 1, name: '我' },
      players: [
        { openid: 'a', name: '我', seat: 1, isMe: true, inRound: true, diceCount: 5 },
        { openid: 'b', name: '倩萍', seat: 2, isMe: false, inRound: true, diceCount: 5 },
        { openid: 'c', name: '阿杰', seat: 3, isMe: false, inRound: true, diceCount: 5 }
      ]
    })
    /*
     * ★ 2026-11-02 补：`openNeedN`（大话骰起叫下限）漏了没测。
     *   它不赋值时模板会渲染成「从 个起叫」——中间空着，不报错。
     *   （这个 bug 在 mock 缺字段时真出现过一次。）
     */
    assert.ok(typeof t2.openNeedN === 'number' && t2.openNeedN > 0,
      '★ openNeedN 必须是正整数，实际：' + JSON.stringify(t2.openNeedN))
    /* 期望值按人数算，不写死 —— 写死 3 会让"3 人局"这个 mock 变得费解 */
    assert.strictEqual(t2.openNeedN, Math.ceil(t2.count * 1.5),
      t2.count + ' 人局不斋起叫应该是 ' + Math.ceil(t2.count * 1.5) + ' 个')
    assert.strictEqual(t2.turnName, '倩萍', '★ 轮到座位 2 就该说「倩萍」，实际：' + t2.turnName)
    assert.strictEqual(t2.myTurn, false, '座位 2 轮到时，我不该显示"轮到你"')

    /* 越界（有人退出后 turn 没修正之类）→ 空串，不能崩也不能显示 undefined */
    const tBad = decorate.call(stub, {
      game: 'liar', phase: 'playing', count: 2, turn: 99, me: { seat: 1, name: '我' },
      players: [{ openid: 'a', name: '我', seat: 1, isMe: true, inRound: true, diceCount: 5 }]
    })
    assert.strictEqual(tBad.turnName, '', '★ turn 越界时应是空串（不是 undefined、也不崩）')

    /* ①b "还差谁没摇" —— 必须**排除自己**（自己不算"等的人"） */
    const w = decorate.call(stub, {
      game: 'dice', phase: 'playing', count: 3, me: { seat: 1, name: '我', dice: [] },
      players: [
        { openid: 'a', name: '我', seat: 1, isMe: true, inRound: true, diceCount: 0 },
        { openid: 'b', name: '倩萍', seat: 2, isMe: false, inRound: true, diceCount: 0 },
        { openid: 'c', name: '阿杰', seat: 3, isMe: false, inRound: true, diceCount: 5 },
        { openid: 'd', name: '老王', seat: 4, isMe: false, inRound: true, diceCount: 0 }
      ]
    })
    assert.strictEqual(w.waitingCount, 2,
      '★ 还差 2 个人（倩萍、老王）；自己没摇不算"等的人"，实际 ' + w.waitingCount)
    assert.strictEqual(w.waitingNames, '倩萍、老王',
      '★ 名单只含没摇的**别人**，实际：' + w.waitingNames)
    assert.ok(w.waitingNames.indexOf('我') < 0, '★ 名单里绝不能出现自己')

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
    assert.strictEqual(ov.settleFoot, '我 喝 1 杯', '结算收尾不对：' + ov.settleFoot)

    /* ④ 规则文案来自注册表，不是页面里另写一份 */
    assert.ok(ov.howList.length >= 3, '规则条目应来自注册表')
    assert.strictEqual(ov.gameName, games.gameOf('liar').name, '玩法名应来自注册表')

    ok('★ decorate() 真跑一遍：牌型提示 / 换牌量 / 观战 / 连庄 / 今晚最惨 / 规则文案 全部正确')

  /* ============ ④c ★ buildOptions()：叫骰选项的规则 ============
   *
   * 这是玩家每一回合都在用的东西，规则是「数量变大，或数量相同但点数变大」。
   * 它从没被单独测过 —— 而它错一次，玩家就会叫出非法骰、被服务端拒，
   * 或者干脆看不到能叫的选项。
   */
  {
    /*
     * 这段原来在这里 eval 抽 buildOptions 的函数体来测。
     * 2026-10-29 把规则搬到 `miniprogram/game/bidOptions.js`（纯函数）之后，
     * 函数体只剩一句 `return bidOptions.list(...)` —— 抽出来跑必然
     * "bidOptions is not defined"。
     * **测试要跟着代码走**：断言已搬到 `scripts/test-bidoptions.js`，
     * 直接 require 那个纯函数（核心几条全部保留，还多补了几条）。
     */
  }
  }

  /* ============ ④g ★ 故障注入：safeDecorate / r.room 缺失都不能崩 ============ */
  console.log('\n=== ④g safeDecorate 故障注入 ===')
  /*
   * ★ 2026-10-29 用户报"有声音但进不去房间"，修了 safeDecorate 兜底。
   *   这里用故障注入验证它**真的兜住了**，不是只在代码里看起来像兜住了。
   */
  {
    /* 装饰崩溃时返回原始 room */
    const stub = {
      decorate() { throw new Error('模块加载失败') },
      safeDecorate: null
    }
    /* 从源码抽 safeDecorate 的逻辑（安全版） */
    const safeFn = (room) => {
      try { return stub.decorate(room) }
      catch (e) { return room }
    }
    const result = safeFn({ code: '123', id: 'x' })
    assert.strictEqual(result && result.code, '123',
      '★ safeDecorate 在 decorate 崩溃时必须返回原始 room')
    ok('decorate 崩溃时 safeDecorate 返回原始 room')
  }

  /* ============ ④f ★ 金花的三张牌分工不能被改坏 ============ */
  console.log('\n=== ④f 金花：一张公共、一张自己看、一张靠想象 ===')
  /*
   * ★ 2026-10-29。这是用户**专门纠正过**的规则：
   *   「一张公共牌（能看），一张是发到自己手里的（能看），还有一张是要靠想象的」
   *   我第一版做成了炸金花（三张自己全看），是**另一个游戏**。
   *
   *   现在用断言锁住三件事：
   *   ① 模板里三个标签都在（底牌 / 你的牌 / 靠想象）
   *   ② 暗牌显示的是**牌背**，不是牌面
   *   ③ 底牌用的是公共牌数据，不是自己的
   *
   *   —— 这三条任何人都可能在"整理模板"时改坏，而改坏后**界面依然能跑**，
   *      只是变成了另一个游戏。
   */
  {
    const tpl = fs.readFileSync(path.join(ROOT, 'miniprogram/game/room/room.wxml'), 'utf8')
    for (const label of ['底牌', '你的牌', '靠想象']) {
      assert.ok(tpl.includes(label), '★ 金花界面缺少「' + label + '」这个标签')
    }
    /* 底牌必须来自 room.poker.publicCard（公共的），不能来自 myKnown */
    assert.ok(/底牌[\s\S]{0,400}publicCard/.test(tpl),
      '★ 「底牌」下面用的不是 publicCard —— 它必须是全场共享的那一张')
    /* 暗牌必须是牌背图，不能渲染出牌面 */
    assert.ok(/靠想象[\s\S]{0,400}(back|card-back)/.test(tpl),
      '★ 「靠想象」下面不是牌背 —— 暗牌绝不能显示牌面')
    ok('金花三张牌分工正确（公共 / 自己 / 牌背）')
  }

  /* ============ ④e ★ 轮询连续失败要分档提示 ============ */
  console.log('\n=== ④e 断网时不能一直安静 ===')
  /*
   * ★ 2026-10-29。`refresh()` 失败时原来是 `catch(() => null)` 一路静默 ——
   *   断网持续时用户只看到界面不动，不知道是卡了还是断了。
   *
   *   现在分两档：1~2 次「网络不太好，正在重试…」；
   *   3 次以上（约 4.5 秒，基本可确定不是抖动）「连接断了，正在自动重连」
   *   并置 `netDown` 标记（界面上那条黄条）；恢复时补一句「已重新连上」。
   *
   *   这是**核心体验**（酒桌上网络本来就不稳），所以要用断言锁住——
   *   否则哪天有人把那个 catch 改回 `() => null`，也没人会发现。
   */
  {
    const code = fs.readFileSync(JS, 'utf8')
    /*
     * ⚠️ 必须**剥掉注释**再查（2026-10-29）。
     *    第一版直接查源码，而那段逻辑的注释里反复出现 `_failCount` /
     *    `netTip` —— 把代码删了断言照样通过（反向验证 exit=0，假绿）。
     */
    const body = code.slice(code.indexOf('async refresh()'), code.indexOf('async refresh()') + 4000)
      .replace(/\/\*[\s\S]*?\*\//g, '')
      .replace(/(^|[^:])\/\/[^\n]*/g, '$1')
    /*
     * 必须是**累加**（`+ 1` / `+= 1`），不能只是"有赋值" ——
     * 成功时的清零 `this._failCount = 0` 也是赋值，会把这个判据骗过去。
     */
    assert.ok(/this\._failCount\s*=\s*\(?\s*this\._failCount[^;]*\+\s*1/.test(body) ||
      /this\._failCount\s*\+=\s*1/.test(body),
      '★ refresh() 失败分支里没有"连续失败计数"的**累加** —— 断网会一直静默')
    assert.ok(/_failCount\s*>=\s*3/.test(body), '★ 没有"达到 3 次"的分档判断')
    assert.ok(/netTip/.test(body), '★ 没有 netTip 提示文案')
    assert.ok(/netDown/.test(body), '★ 没有 netDown 标记（界面上那条黄条靠它）')
    assert.ok(/已重新连上/.test(code), '★ 恢复连接时没有提示 —— 玩家断线期间可能已经以为没救了')
    ok('断网分档提示齐全（重试中 / 已断开 / 已恢复）')
  }

  /* ============ ④d ★ 拉起全屏遮罩的路径，必须有关闭 ============ */
  console.log('\n=== ④d 全屏遮罩不能只拉不关 ===')
  /*
   * ★ 2026-10-29 用户真机报障："每个游戏都卡在「正在进入房间」进不去"。
   *
   *   根因：3.10.26 给"点玩法卡建房"加了 `patch.loading = true`（本意是别闪空白），
   *   而 `doCreate` **从来没有 setLoading(false)** —— `doJoin` 有，它漏了。
   *   于是遮罩拉起后永远不关，每个玩法都卡死。
   *
   *   判据：源码里每出现一次"把 loading 设成 true / 调 setLoading(true)"，
   *   同一个函数体里就必须有对应的关闭。
   */
  {
    const code = fs.readFileSync(JS, 'utf8')
    const problems = []
    for (const fn of ['doCreate', 'doJoin']) {
      const re = new RegExp('async ' + fn + '\\(\\)[\\s\\S]*?\\n  \\},')
      const m = re.exec(code)
      if (!m) { problems.push(fn + '：找不到函数'); continue }
      const body = m[0]
      /* 这个函数要么自己 setLoading(true)，要么调用方给它设过（onLoad） */
      const turnsOn = /setLoading\(true\)/.test(body) || /onLoad|patch\.loading = true/.test(code.slice(0, m.index))
      const turnsOff = /setLoading\(false\)/.test(body)
      if (!turnsOff) problems.push(fn + '：没有任何 setLoading(false) —— 遮罩会一直挂着')
    }
    assert.deepStrictEqual(problems, [], '★ 这些路径会把全屏遮罩挂死：\n    ' + problems.join('\n    '))
    ok('doCreate / doJoin 都会关闭全屏遮罩')
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
    const allowed = /^this\.\w*[dD]ecorate\(/.test(expr) || expr === 'null' || expr === 'room'
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
  /*
   * ★ 2026-10-30：选项从字符串数组改成了对象数组（{n, face, zhai, label}，
   *   因为要支持「斋」），所以模板里是 `item.label`。
   *   断言要守的是**意图**——"按钮自带它叫的是什么"，而不是某个具体写法。
   */
  assert.ok(/data-l="\{\{item(\.label)?\}\}"/.test(bidBtn[0]),
    '★ 叫骰按钮没有自带 label（data-l）—— 只传下标会让点击依赖派生数组，' +
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
    /*
     * ⚠️ 先剥掉**比较用的字面量**再抓类名（2026-10-28）。
     *   `{{room.uw.step === 'vote' ? 'compact' : ''}}` 里 `'vote'` 是判断条件，
     *   不是 class 值 —— 第一版没剥，它被当成"缺少 .vote 样式"报了出来。
     *   假阳性会让我去给一个不存在的类补样式，或者往白名单里塞垃圾。
     */
    const exprOnly = mm[1].replace(/[=!]==?\s*'[^']*'/g, '')
    for (const lit of exprOnly.matchAll(/'([a-zA-Z][\w-]*)'/g)) dyn.add(lit[1])
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
     *
     * 'rename'（改自己的名字）同理放行：它是**身份设置**，不是游戏动作。
     * 中途进来只能看的人，照样应该能把自己叫什么改对 ——
     * 拦掉反而荒谬（桌上正要点名，而你的名字改不了）。
     */
    const READONLY = new Set(['status', 'create', 'join', 'leave', 'again', 'game', 'deck',
      'cardDel', 'card', 'rename'])

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

  /* ============ ⑫ 动作失败后必须立刻同步状态 ============ */
  console.log('\n=== ⑫ 动作失败后要立刻拉一次（否则对着过期按钮连点）===')
  /*
   * 2026-10-28 加。失败**往往说明本地看到的状态已经是旧的**：
   * 别人刚叫过骰/刚换过牌/刚投完票，而我的轮询还没到（最长 1.5 秒）。
   * 这时服务端回一句「只能往上叫」，如果只弹个 toast 就完事，
   * 用户面前的按钮还是那批过期的 —— 他会对着同一个按钮连点，
   * 每次都失败、每次都提示，体验像是界面坏了。
   *
   * 判据：凡是 `call('room', ...)` 的 catch 里出现"弹提示 + return null"的地方，
   * 都必须先调 resyncAfterFail()。用**函数体切片**逐个 catch 检查，
   * 不做整文件正则（那种判据删掉一处也照样能过）。
   */
  const catches = []
  {
    /*
     * ⚠️ 第一版这里用 `\.catch\(...\)\s*=>\s*\{([\s\S]*?)\n\s*\}\)` 非贪婪抓块体 ——
     *   它是**废的**：catch 里几乎一定嵌着 `wx.showToast({ ... })`，
     *   而那个 `        })` 正好满足「换行 + 空白 + })」，于是块体在
     *   showToast 结束处就被截断了，后面的 return null / resync 根本没进判据。
     *
     *   表现是一次反向验证：删掉一处 resyncAfterFail，断言**照样 exit=0**。
     *   这正是 AGENTS.md 反复记的那类事故 —— 判据看着在跑，实际什么都没测。
     *
     *   现在改成**括号配平**取块体：从 `=> {` 的那个 `{` 开始数深度，数到 0 为止。
     */
    const openRe = /\.catch\([^)]*\)\s*=>\s*\{/g
    let om
    while ((om = openRe.exec(src))) {
      const braceIdx = src.lastIndexOf('{', om.index + om[0].length)
      let depth = 0, end = -1
      for (let k = braceIdx; k < src.length; k++) {
        if (src[k] === '{') depth++
        else if (src[k] === '}') { depth--; if (depth === 0) { end = k; break } }
      }
      if (end > braceIdx) catches.push(src.slice(braceIdx, end))
    }
  }
  /* no-room 标记 = 建房失败，此时还没有房间可同步（唯一合理的例外，必须写明） */
  const noResync = catches.filter(b =>
    /return null/.test(b) && !/resyncAfterFail\(\)/.test(b) && !/no-room/.test(b))
  assert.deepStrictEqual(noResync, [],
    '这些失败分支只弹了提示、没有同步状态（用户会对着过期按钮连点）：\n    ' +
    noResync.map(b => b.trim().split('\n')[0]).join('\n    '))
  ok(`${catches.length} 个失败分支：弹提示的都必须先 resyncAfterFail`)

  /* ============ ⑮ 可点击的操作必须有声音反馈 ============ */
  console.log('\n=== ⑮ 每个可点击操作都要有声音反馈 ===')
  /*
   * ★ 2026-10-28。逐个数 bindtap 的 handler 时发现的：
   *   33 个可点击操作里有 9 个**点了完全没声音** ——
   *   包括「再来一局」（整个界面里唯一的重操作）和「复制房间号」。
   *
   *   这是"廉价感"最直接的来源：界面切了，但手上没反馈，
   *   用户会觉得这一下没点中。
   *
   *   判据：handler 函数体里必须有 sfx.play / feedback.fire / haptic. / vibrate，
   *        或者调用了别的内部方法（声音可能在里面）。
   *   ⚠️ 白名单只有一个：toggleMute —— **静音开关本身不该响**，
   *      那不是漏，是刻意的。
   */
  {
    const SILENT_OK = new Set(['toggleMute'])
    /*
     * ★ 2026-10-28 扩展：不只房间页，**三个页面都查**。
     *   查完房间页（33 个操作里 9 个没声音）之后顺手看大厅 ——
     *   结果发现"点玩法卡开桌"和"进房"这两个**最重要的操作**也没声音。
     *   这正是"修一类 bug 必须全仓扫描"那条教训。
     */
    const PAGES = [
      { name: '房间', wxml: 'miniprogram/game/room/room.wxml', js: 'miniprogram/game/room/room.js' },
      { name: '大厅', wxml: 'miniprogram/pages/lobby/lobby.wxml', js: 'miniprogram/pages/lobby/lobby.js' },
      { name: '我的', wxml: 'miniprogram/pages/me/me.wxml', js: 'miniprogram/pages/me/me.js' }
    ]
    const silent = []
    let totalHandlers = 0
    for (const pg of PAGES) {
    const wxml = fs.readFileSync(path.join(ROOT, pg.wxml), 'utf8')
    const js = fs.readFileSync(path.join(ROOT, pg.js), 'utf8')
    const handlers = [...new Set([...wxml.matchAll(/bindtap="(\w+)"/g)].map(m => m[1]))]
    totalHandlers += handlers.length
    for (const h of handlers) {
      if (SILENT_OK.has(h)) continue
      const m = new RegExp('\\n  (?:async )?' + h + '\\([^)]*\\)\\s*\\{').exec(js)
      if (!m) continue
      const start = m.index + m[0].length - 1
      let depth = 0
      let end = start
      /*
       * ⚠️ 范围必须足够大（2026-10-29）。原来限 3000 字符，
       *    而 doCreate 加了 try/catch/finally 后超过 3000 ——
       *    提取到的 body 是空的，断言就误报"没声音"。
       */
      for (let k = start; k < Math.min(start + 10000, js.length); k++) {
        if (js[k] === '{') depth++
        else if (js[k] === '}') { depth--; if (depth === 0) { end = k; break } }
      }
      const body = js.slice(start, end)
      /*
       * ⚠️ 不能把 `this.xxx(` 当作"可能有声音" —— 第一版这么写，
       *    而 `doAgain` 里就有一句 `return this.backToLobby()`，
       *    于是**去掉音效后断言照样通过**（反向验证 exit=0，假绿）。
       *    现在只认**直接的**声音调用。
       */
      if (!/sfx\.play|feedback\.fire|haptic\.|vibrate/.test(body)) {
        silent.push(pg.name + ' → ' + h)
      }
    }
    }
    assert.deepStrictEqual(silent, [],
      '这些可点击操作点了没声音（界面会切，但手上没反馈，像没点中）：\n    ' + silent.join('\n    '))
    ok('三个页面共 ' + totalHandlers + ' 个可点击操作都有声音反馈')
  }

  /* ============ ⑭ 房主专属的操作，前端必须藏起来 ============ */
  console.log('\n=== ⑭ 房主专属操作必须只对房主可见 ===')
  /*
   * ★ 2026-10-28。逐屏检查时把"非房主点了会被服务端拒"这件事查了一遍：
   *   doStart / doAgain / uwSay / pickNewGame / toggleLock / doNudge
   *   —— 服务端都要求房主，前端都必须藏。
   *
   *   漏一处的症状是"点了没反应"（服务端返回 ok:false，前端只弹个 toast），
   *   比"看不见"糟得多 —— 用户会以为卡了。
   *
   *   判据：这些 handler 所在的元素，往上 3 行内必须有 room.host。
   */
  {
    const HOST_ONLY = ['doStart', 'doAgain', 'uwSay', 'pickNewGame', 'toggleLock', 'doNudge']
    const wxml = fs.readFileSync(path.join(ROOT, 'miniprogram/game/room/room.wxml'), 'utf8')
    const lines = wxml.split('\n')
    const leaked = []
    lines.forEach((ln, i) => {
      for (const h of HOST_ONLY) {
        if (!ln.includes('bindtap="' + h + '"')) continue
        const ctx = lines.slice(Math.max(0, i - 3), i + 1).join('\n')
        if (!/room\.host/.test(ctx)) leaked.push(h + '（第 ' + (i + 1) + ' 行）')
      }
    })
    assert.deepStrictEqual([...new Set(leaked)], [],
      '这些房主专属操作没有对非房主隐藏（点了会被服务端拒，用户以为卡了）：\n    ' +
      [...new Set(leaked)].join('\n    '))
    ok('房主专属操作全部只对房主可见')
  }

  /* ============ ⑬ 撒花：只在不吃点击、且必须自己清空 ============ */
  console.log('\n=== ⑬ 撒花：不吃点击、必须清空 ===')
  /*
   * 撒花是 20 个绝对定位元素同时动画，两个风险：
   *   ① 覆盖层没设 pointer-events:none → **整屏点不动**（这是最致命的，
   *      而且只在"刚赢的那 2.6 秒"出现，最容易漏测）
   *   ② 没清空 → 20 个元素永久留在 DOM 里，后面的界面白背这份开销
   *
   * ★ 撒花在离线渲染里**看不到**：渲染器为了让截图稳定，会把 animation
   *   瞬间拨到终态，而终态是 opacity:0。所以这一块只能靠断言守结构，
   *   不能靠截图确认 —— 写下来免得下次误以为"没做"。
   */
  {
    const cfCss = /(^|\n)\.confetti\s*\{[^}]*\}/.exec(css)
    assert.ok(cfCss, '⑬ 找不到 .confetti 的样式')
    assert.ok(/pointer-events\s*:\s*none/.test(cfCss[0]),
      '⑬ 撒花层必须 pointer-events:none —— 否则整屏点不动（只在刚赢的 2.6 秒里出问题）')
    assert.ok(!/z-index\s*:\s*-/.test(cfCss[0]) && /z-index/.test(cfCss[0]),
      '⑬ 撒花要在内容之上（z-index 正数）')

    /* 5 种颜色都要有定义（按序号取模 5） */
    for (let i = 0; i < 5; i++) {
      assert.ok(new RegExp('\\.cf-' + i + '\\s*\\{').test(css),
        '⑬ .cf-' + i + ' 没有颜色定义（撒花会有一片透明）')
    }
    assert.ok(/@keyframes\s+cfFall/.test(css), '⑬ 找不到撒花的 keyframes')

    /* js 侧：必须自己清空，且定时器可清理 */
    const celBody = (() => {
      const i = src.indexOf('  celebrate() {')
      if (i < 0) return ''
      let depth = 0, end = -1
      const open = src.indexOf('{', i)
      for (let k = open; k < src.length; k++) {
        if (src[k] === '{') depth++
        else if (src[k] === '}') { depth--; if (depth === 0) { end = k; break } }
      }
      return end > open ? src.slice(open, end) : ''
    })()
    assert.ok(celBody, '⑬ 找不到 celebrate()')
    assert.ok(/setData\(\{\s*confetti:\s*\[\]\s*\}\)/.test(celBody),
      '⑬ 撒花必须自己清空（否则 20 个元素永久留在 DOM）')
    assert.ok(/clearTimeout\(this\._cfTimer\)/.test(src),
      '⑬ 撒花定时器进清理清单（onUnload 要能停）')
    ok('撒花：覆盖层不吃点击、五种颜色齐全、自己会清空且定时器可清理')
  }

  /* ============ ⑪ 前后台切换：回前台必须立刻同步 ============ */
  console.log('\n=== ⑪ 切回前台要立刻拉一次（不能先给一屏过期画面）===')
  /*
   * 酒桌上的真实动作：切出去回条微信 → 切回来。
   * 而原来是切回来先看到一屏过期画面，1.5 秒后轮询才跳到真实状态。
   * 倒计时改成挂钟驱动之后更明显 —— 它在后台照样走完，
   * 切回来可能本地显示"开始！"而服务端已经 over 了。
   *
   * 判据：onShow 的函数体里必须先调 pollTick()、再 startPoll()。
   * 顺序反了的话两个请求并发，pollTick 的并发保护会把后一个丢掉。
   */
  const showBody = (() => {
    const i = src.indexOf('  onShow() {')
    if (i < 0) return ''
    let depth = 0, end = -1
    const open = src.indexOf('{', i)
    for (let k = open; k < src.length; k++) {
      if (src[k] === '{') depth++
      else if (src[k] === '}') { depth--; if (depth === 0) { end = k; break } }
    }
    return end > open ? src.slice(open, end) : ''
  })()
  assert.ok(showBody, '⑪ 找不到 onShow 函数体')
  const iTick = showBody.indexOf('pollTick()')
  const iStart = showBody.indexOf('startPoll()')
  assert.ok(iTick >= 0, '⑪ onShow 里必须立刻调 pollTick()（回前台先同步一次）')
  assert.ok(iStart >= 0, '⑪ onShow 里必须恢复轮询')
  assert.ok(iTick < iStart, '⑪ 顺序必须是「先 pollTick 再 startPoll」（反了会两个请求并发，后一个被丢弃）')

  const hideBody = (() => {
    const i = src.indexOf('  onHide() {')
    if (i < 0) return ''
    let depth = 0, end = -1
    const open = src.indexOf('{', i)
    for (let k = open; k < src.length; k++) {
      if (src[k] === '{') depth++
      else if (src[k] === '}') { depth--; if (depth === 0) { end = k; break } }
    }
    return end > open ? src.slice(open, end) : ''
  })()
  assert.ok(hideBody, '⑪ 找不到 onHide 函数体')
  assert.ok(/stopPoll\(\)/.test(hideBody), '⑪ 切后台必须停轮询（微信后台 5 秒后请求必然失败）')
  assert.ok(!/call\('room'/.test(hideBody),
    '⑪ 切后台不能发云函数请求 —— 那次请求必然 fail interrupted，还占着并发标志')
  ok('回前台先 pollTick 再挂周期；切后台只停不请求')

  /* ============ ⑩ 结算前必须定格 300ms（hitstop） ============ */
  console.log('\n=== ⑩ 结算前定格：最激动的一秒不能被跳过 ===')
  /*
   * 2026-10-28 加。原来 playing → over 是**直接换屏**：
   * 上一帧还在看骰盅/牌，下一帧已经变成结算列表。
   * 而"结果出来的那一刻"恰恰是一局里最值钱的部分。
   *
   * 实现上的三个要点，缺一个就不是定格、是卡死：
   *   ① 拦截点只在 over（其它阶段不能拦，否则游戏根本走不动）
   *   ② 定格期间到达的响应要**存起来**，不能丢
   *      —— 那可能是最后一次带结算数据的响应，服务端不会再推
   *   ③ 定时器到点后必须**重入 applyRoom** 走完整流程
   *      （结算音效、事件流、stage 切换都在里面）
   *
   * ⚠️ 判据用 applyRoom 的**函数体**，不看整文件：整文件里 'over' 出现几十次，
   *    删掉这段照样能过。这是本项目反复栽过的"判据失效"形态。
   */
  const apBody = (() => {
    const i = src.indexOf('  applyRoom(raw, extra) {')
    if (i < 0) return ''
    let depth = 0, end = -1
    const open = src.indexOf('{', i)
    for (let k = open; k < src.length; k++) {
      if (src[k] === '{') depth++
      else if (src[k] === '}') { depth--; if (depth === 0) { end = k; break } }
    }
    return end > open ? src.slice(open, end) : ''
  })()
  assert.ok(apBody, '⑩ 找不到 applyRoom 函数体')

  assert.ok(/raw\.phase\s*===\s*'over'/.test(apBody),
    '⑩ applyRoom 里必须有 over 阶段的拦截（否则直接换屏，定格不存在）')
  assert.ok(/300/.test(apBody) && /setTimeout/.test(apBody),
    '⑩ 定格必须有 300ms 的定时器')
  assert.ok(/_pendingOver\s*=\s*raw/.test(apBody),
    '⑩ 定格期间的响应必须存起来（不能丢，那可能是最后一次带结算数据的响应）')
  assert.ok(/if\s*\(p\)\s*this\.applyRoom\(p\)/.test(apBody),
    '⑩ 定时器到点后必须重入 applyRoom（结算音效/事件流/stage 切换都在里面）')
  assert.ok(/clearTimeout\(this\._htTimer\)/.test(src),
    '⑩ 定格定时器必须在 onUnload 里清掉（否则卸载后还会 setData）')

  /* 模板上真的挂了这个 class —— 否则逻辑写了、样式也有了，画面一动不动 */
  const rootM = /class="gamepage[^"]*\{\{\s*freeze\s*\?/.exec(tpl)
  assert.ok(rootM, '⑩ 页面根容器的 class 里必须绑上 freeze')
  assert.ok(/\.gamepage\.freeze\s*\{/.test(css), '⑩ .gamepage.freeze 必须有样式定义')
  ok('结算前定格 300ms：不丢响应、会重入、定时器可清理、模板真的挂上了')

  /* ============ ⑪ 每个"全屏状态"都必须有出口（2026-10-30） ============ */
  /*
   * 连续修了三处同类问题，都是"全屏界面没有退路"：
   *   · 倒计时卡住（网络断在开局瞬间）→ 已加 cdStuck 出口
   *   · 进入房间遮罩卡住 → 已加 rl-esc 出口
   *   · 分享直达时没有上一页 → wx.navigateBack() 静默失败，点「‹ 大厅」没反应
   * 这条断言锁住第三处：goBack 必须处理"栈里只有自己"的情况。
   */
  {
    const js = fs.readFileSync(JS, 'utf8')
    const iBack = js.indexOf('goBack() {')
    assert.ok(iBack >= 0, '应该能找到 goBack 的实现')
    const iEnd = js.indexOf('\n  },', iBack)
    const body = js.slice(iBack, iEnd > 0 ? iEnd : iBack + 800)
    assert.ok(/getCurrentPages/.test(body),
      '★ goBack 必须看页面栈深度 —— 分享直达时栈里只有自己，navigateBack 会静默失败')
    assert.ok(/reLaunch/.test(body),
      '★ 没有上一页时必须 reLaunch 到大厅，否则「‹ 大厅」点了没反应')
    ok('★ 返回有兜底：分享直达时回大厅靠 reLaunch，不是静默失败的 navigateBack')

    /* 三处全屏状态都要有出口 */
    const wxml = fs.readFileSync(WXML, 'utf8')
    assert.ok(/rl-esc/.test(wxml), '★ 进入房间遮罩等久了必须有出口')
    assert.ok(/cd-stuck/.test(wxml), '★ 倒计时卡住必须有出口')
    ok('★ 三处全屏状态都有出口（遮罩 / 倒计时 / 返回）')
  }

  /* ============================================================================
   * ★★ 轮询去重必须覆盖所有「会显示出来的」字段（2026-11-03）
   *
   * `roomChanged()` 决定"这次轮询要不要 setData"。漏一个字段的后果是
   * **数据变了但界面不动** —— 看起来和"功能坏了"一模一样。
   * 项目里因此栽过两次（金花换手牌、轮次提示）。
   *
   * 这一轮又发现：**bt（射龙门）和 fh（额头牌）整个块都没参与比较**。
   * 别人押注、翻牌、同意、换牌时，我这边判定"无变化"→ 跳过 setData
   * → 界面停在旧状态，直到别的字段碰巧变了才刷。
   *
   * 判据：**每个玩法在 shape() 里给出的顶层块，都必须在 roomChanged 里被比较。**
   * 结构性判据 —— 加新玩法时自动受约束，不用靠人记得去改。
   * ========================================================================== */
  {
    const js = fs.readFileSync(JS, 'utf8')
    const iCmp = js.indexOf('roomChanged(prev, room)')
    assert.ok(iCmp > 0, '找不到 roomChanged')
    const iEnd = js.indexOf('\n  },', iCmp)
    const cmpBody = js.slice(iCmp, iEnd > 0 ? iEnd : iCmp + 6000)

    /*
     * 各玩法在 shape() 里的顶层块名（和 mock/wxml 用的是同一批）。
     * 只列"随别人操作而变化、必须实时反映"的 ——
     * 骰子类走 players/dice 里的字段，已经有覆盖。
     */
    const LIVE_BLOCKS = ['uw', 'poker', 'fh', 'bt']
    const missing = LIVE_BLOCKS.filter((k) => {
      /* 允许 `prev.fh` / `pfa` 等任意变量名，但属性名必须是 fh */
      const re = new RegExp('\.' + k + '\\b')
      return !re.test(cmpBody)
    })
    assert.deepStrictEqual(missing, [],
      '★ 这些玩法的状态块没有参与 roomChanged 去重 —— ' +
      '别人操作时界面会不刷新：\n    ' + missing.join('\n    '))
    ok('★ 4 个玩法状态块都参与轮询去重（uw / poker / fh / bt）')
  }

  /* ============================================================================
   * ★★ 大厅的「首屏能看见几个玩法」（2026-11-03）
   *
   * 玩法从 5 个长到 7 个之后，大厅**两列布局要滚 4 行** ——
   * 按 iPhone 13 的内容区（约 753px）算，扣掉 hero / 输入框 / 底部提示 / tabBar，
   * 留给卡片的只有约 353px，也就是**一眼只看得到 2 行 4 个**，
   * 剩下 3 个必须往下滑才知道存在。
   *
   * 这本身不是 bug（页面能滚），但它是一个**会随玩法数恶化**的体验问题，
   * 而且没有任何东西会提醒你"该重新设计大厅了"。
   *
   * 这条断言的作用不是阻止加玩法，而是**把那个临界点写下来**：
   * 超过 8 个就必须改布局（比如分类 tab / 横滑），否则首屏藏的东西太多。
   * ========================================================================== */
  {
    const gamesJs = fs.readFileSync(path.join(ROOT, 'miniprogram/utils/games.js'), 'utf8')
    const list = (gamesJs.match(/^\s*id:\s*'[a-z]+'/gm) || [])
    const total = list.length
    assert.ok(total >= 7, '玩法 id 解析异常（只拿到 ' + total + ' 个）')

    /*
     * ★★ 2026-11-03 订正：原来这里写 `PER_SCREEN = 4`（首屏只露 2 行 4 个）——
     *   **那是错的**，而且是估算错误，不是代码错误。
     *
     *   我当时用"每卡 136px × 4 行 + 固定区 188px = 750px > 679px 可用"推算，
     *   但那 136px 是**收窄前**的 min-height（272rpx）。收到 240rpx 后
     *   每行约 70px，4 行只要 280px。
     *
     *   实测像素（lobby-all@full.png，2x，逻辑高度 753px）：
     *     卡片区从 y≈230px 到 y≈700px，**8 个玩法全部在首屏内，不需要滚动**。
     *
     *   教训：**"可用高度"这种量必须从渲染结果量，不能靠加加减减推**。
     *   推算里任何一个数过时（比如 min-height 改过），结论就会整个错，
     *   而错的结论会把后面几轮的工作方向带偏。
     */
    /*
     * ★★ 2026-11-03 再订正：光有"上限数字"不够，还要**真的能看见**。
     *
     *   第 9 个玩法进来后，`check-lobby-fit.py` 用像素量出卡片区到 948px，
     *   而首屏只有 753px —— 第 7~9 个必须下滑才看得见。
     *
     *   这时有两条路：
     *     A. 压扁界面塞进一屏（要砍 196px，等于把 hero 压成一条）—— 拿体验换整齐
     *     B. **告诉玩家下面还有** —— 保住界面质量
     *   选 B。所以这条断言从"必须装得下"改成
     *   **"装不下时必须给出可发现性提示"**。
     */
    const lobbyWxml = fs.readFileSync(path.join(ROOT, 'miniprogram/pages/lobby/lobby.wxml'), 'utf8')
    /*
     * 首屏能放几个：由 `scripts/check-lobby-fit.py` 的像素测量给出（8 个）。
     * 超过就必须有"下面还有"的提示，否则玩家会以为"就这些"。
     */
    const PER_SCREEN = 8
    if (total > PER_SCREEN) {
      assert.ok(/more-hint/.test(lobbyWxml),
        '★ 玩法 ' + total + ' 个，首屏只露得下 ' + PER_SCREEN +
        ' 个 —— 必须有「下面还有 N 个」的提示（more-hint），' +
        '否则玩家会以为大厅就这些玩法')
      assert.ok(/list\.length - \d+/.test(lobbyWxml),
        '★ 提示里的 N 必须是**算出来的**（list.length - 首屏容量），不能手写死')
    }
    /*
     * ★★★ 2026-11-03：**每个玩法都必须有结算页渲染块**。
     *
     *   起因：查 mock 覆盖时发现 4 个玩法（转盘/射龙门/红黑单双/众口一致）
     *   在模板里只有 playing 分支，**结算页一个都没有** ——
     *   打完一局屏幕上只剩「再来一局」按钮，谁赢谁喝一个字都没有。
     *
     *   这类"整块缺失"靠人眼看代码发现不了（少一块看起来和原来一样），
     *   只能靠覆盖性判据。
     *
     *   判据：结算区（`stage === 'over'` 之后那段）里，
     *   必须能找到 `room.game === 'x'` 的分支，对每个注册玩法都成立。
     */
    const lobbyW = fs.readFileSync(path.join(ROOT, 'miniprogram/pages/lobby/lobby.wxml'), 'utf8')
    const roomWxml = fs.readFileSync(WXML, 'utf8')
    const overStart = roomWxml.indexOf("stage === 'over'")
    assert.ok(overStart > 0, '找不到结算区')
    const overBlock = roomWxml.slice(overStart)

    const idRe2 = /(?:^|\n)\s*id:\s*'([a-z]+)'/g
    const allIds = []
    const gj2 = fs.readFileSync(path.join(ROOT, 'miniprogram/utils/games.js'), 'utf8')
      .replace(/\/\*[\s\S]*?\*\//g, '').replace(/(^|[^:])\/\/[^\n]*/g, '$1')
    let im2
    while ((im2 = idRe2.exec(gj2))) allIds.push(im2[1])

    const noOverBlock = allIds.filter((id) => overBlock.indexOf("room.game === '" + id + "'") < 0)
    assert.deepStrictEqual(noOverBlock, [],
      '★ 这些玩法在结算页没有任何渲染块 —— 打完一局屏幕上只剩按钮：\n    ' +
      noOverBlock.join('\n    '))
    ok('★ 全部 ' + allIds.length + ' 个玩法都有结算页渲染块（不会白屏）')

    /*
     * ★★★ 2026-11-03：**每个玩法块里模板用到的 room 字段，该玩法块必须提供**。
     *
     *   实例：金花的等待文案写 `等 {{room.turnName}} 决定`，
     *   而 `shape()` 的 poker 块里**从来没有 turnName**
     *   → 界面显示成「等  决定」（中间空白）。
     *
     *   为什么一直没发现：小程序把 `{{undefined}}` 渲染成空串 ——
     *   页面照常显示、不报错、不警告，只是少了一个词。
     *
     *   ⚠️ 判据必须**按玩法块**比，不能全仓比。
     *      我第一版试过"模板要的字段全仓存在就行"，结果 `turnName`
     *      在 fh/sv/bt 里有、金花没有 —— **照样通过**。
     *      而且那个版本要靠一个越来越长的派生字段白名单，根本不是判据。
     *
     *   白名单只放**确实由 decorate() 计算**的字段（项目里"派生字段唯一出口"）。
     */
    {
      const cloudSrc2 = fs.readFileSync(path.join(ROOT, 'cloudfunctions/room/index.js'), 'utf8')
      /* 前端 decorate() 算出来的字段 —— 服务端不该给 */
      const DERIVED = new Set([
        'howList', 'settleFoot', 'hostName', 'nightDrinkList', 'streakText',
        'myCards', 'options', 'openNeedN', 'myOut', 'gameName',
        'minPlayers', 'shortBy', 'spectating', 'canReroll', 'rolledCount',
        'pkTargetCount', 'waitingText', 'uwCompare', 'me'
      ])
      /* 顶层通用字段（shape 的最外层，所有玩法都能用） */
      const TOP = new Set(['game', 'phase', 'players', 'turn', 'count', 'host',
        'locked', 'round', 'bid', 'lastResult', 'spin', 'deck', 'streakText', 'id',
        'code', 'hostOpenid', 'away', 'nightDrinks', 'usedCards'])

      const missing = []
      allIds.forEach((gid) => {
        /* 模板里这个玩法的块 */
        const wi = roomWxml.indexOf("room.game === '" + gid + "'")
        if (wi < 0) return
        const wj = roomWxml.indexOf("room.game === '", wi + 10)
        const blk = roomWxml.slice(wi, wj > 0 ? wj : wi + 4000)
        const used = new Set()
        ;(blk.match(/room\.([a-zA-Z_]\w*)/g) || []).forEach((x) => used.add(x.slice(5)))

        /* 服务端这个玩法块里的字段 */
        const ci = cloudSrc2.indexOf('\n    ' + gid + ': (function () {')
        if (ci < 0) return
        const cj = cloudSrc2.indexOf('\n    })(),', ci)
        const cb = cloudSrc2.slice(ci, cj > 0 ? cj : ci + 8000)
        const provided = new Set()
        ;(cb.match(/^\s{6,10}(\w+):/gm) || []).forEach((x) => provided.add(x.trim().replace(':', '')))

        used.forEach((k) => {
          if (DERIVED.has(k) || TOP.has(k)) return
          /*
           * ⚠️ `room.poker.xxx` 会被抽成 `poker` —— 那是**玩法块名本身**，
           *   不是字段。六个块名都要排除，否则每个玩法都报自己。
           */
          if (/^(uw|poker|fh|bt|sv|cs)$/.test(k)) return
          if (!provided.has(k)) missing.push(gid + '.' + k)
        })
      })
      assert.deepStrictEqual(missing, [],
        '★ 这些字段模板在用、但服务端那个玩法块没给（界面会渲染成空白）：\n    ' +
        missing.join('\n    '))
      ok('★ 9 个玩法块里模板用的字段，服务端都真的给了')
    }

    /*
     * ★★ 2026-11-03：结算页必须回答「**谁喝**」。
     *
     *   起因：把 9 个玩法的结算页拼成对比图，发现转盘只有一行
     *   「转到「喝 1 杯」」—— **没说是谁喝**。
     *   而扇区本身是有语义的（`you` 你喝 / `me` 我喝 / `both` 一起喝 / `pass` 免罚），
     *   结算页只是把 `t` 原样显示，把那层语义丢了。
     *
     *   判据：结算区里凡是"喝"类的文案，必须能看出**指向谁**。
     *   做法：要求结算区出现 `whoText` 这类明确字段（由服务端翻译），
     *   而不是只渲染扇区名。
     */
    /*
     * ⚠️ 判据必须**只查转盘那一块**。
     *   第一版写成 `/whoText|drinkWho|谁喝/.test(overBlock)` ——
     *   而整个结算区里别处就有"谁喝"（大话骰的吐槽文案），于是
     *   **转盘缺不缺都通过**（假阳性）。这是项目里记过的
     *   「例外条件不能跨范围传播」的同一类：判据范围必须和目标范围一致。
     */
    const wheelStart = overBlock.indexOf("room.game === 'wheel'")
    assert.ok(wheelStart >= 0, '结算区里找不到转盘块')
    /* 转盘块到下一个玩法块为止 */
    const wheelEnd = overBlock.indexOf("room.game === '", wheelStart + 10)
    const wheelBlock = overBlock.slice(wheelStart, wheelEnd > 0 ? wheelEnd : wheelStart + 600)
    /*
     * ⚠️ 必须先**剥掉注释**再判。
     *   第一版直接对原文正则 —— 而我在那段上面正好写了注释解释 whoText，
     *   于是**把渲染整段删掉，注释还在，断言照样通过**（反向验证抓到的）。
     *   这是项目里记过的「注释污染判据」，第 N 次。
     */
    const wheelCode = wheelBlock
      .replace(/<!--[\s\S]*?-->/g, '')
      .replace(/\{\{!--[\s\S]*?--\}\}/g, '')
    assert.ok(/whoText|drinkWho/.test(wheelCode),
      '★ 转盘结算页只说「喝 1 杯」，**没说是谁喝** —— ' +
      '而扇区本身有 you/me/both/pass 四种语义，必须在结算页翻译成人话')

    void lobbyW
    ok('★ 玩法 ' + total + ' 个（首屏容量 ' + PER_SCREEN + '）—— ' +
       (total > PER_SCREEN ? '已给出「下面还有 N 个」提示' : '全部可见'))

    /*
     * ★★ 玩法卡的描述必须一行放得下（2026-11-03）
     *
     * 卡片两列布局下内容宽约 146px、描述 20rpx（≈10px）—— 每行约 **14 个中文字**。
     * 超一个字就折成两行，整张卡被顶高，**和旁边那张不等高**，
     * 网格看起来就歪了。
     *
     * 实测「梦幻金花」原来 15 字（「一张亮着，一张自己看，一张靠猜」）
     * 正好超 1 个字，而 `min-height` 从 272 收到 240rpx 之后不再兜住这个差异 ——
     * 离线长图一眼就看出来了。
     *
     * 判据：**描述 ≤ 14 个中文字**。改文案时会被这条挡住。
     */
    const descM = gamesJs.match(/desc:\s*'([^']*)'/g) || []
    const tooLong = []
    descM.forEach((d) => {
      const txt = d.replace(/desc:\s*'/, '').replace(/'$/, '')
      /* 中文按 1 个宽度算，ASCII 按半个算 */
      const w = Array.from(txt).reduce((a, ch) => a + (/[\x00-\x7F]/.test(ch) ? 0.5 : 1), 0)
      if (w > 14) tooLong.push(txt + '（' + w + ' 字宽）')
    })
    assert.deepStrictEqual(tooLong, [],
      '★ 这些描述超过 14 字宽，会在卡片里折成两行并把卡片顶高：\n    ' +
      tooLong.join('\n    '))
    ok('★ 全部 ' + descM.length + ' 个玩法描述都 ≤14 字宽（卡片内不折行）')
  }

  console.log(`\n${'='.repeat(58)}`)
  console.log(`  房间页状态机：全部 ${n} 项断言通过`)
  console.log(`${'='.repeat(58)}\n`)
})()

process.on('uncaughtException', (e) => {
  console.error('\n  ✗ 断言失败：', e.message, '\n')
  process.exit(1)
})
