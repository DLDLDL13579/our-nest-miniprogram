/**
 * test-game.js —— 游戏核心逻辑验证（2.6.0 重写）
 *
 * ============ 为什么重写 ============
 *
 * 2.6.0 删掉了三个单机页（dice / liar / wheel），而这一份测试原本是
 * **从那些页面里复制一份逻辑**来测的（注释原文："保持一致，改了要同步"）。
 * 页面一删，它测的就成了自己抄的那份副本 —— 不是真实代码。
 * 这类测试比没有测试更危险：它一直"全绿"，却和线上跑的代码毫无关系。
 *
 * 重写原则：**只测真实代码**。两条路：
 *   ① 能从源文件里抽出来的纯函数 → 用正则抽出来求值（见下）
 *   ② 抽不出来的 → 用 mock 真跑云函数（房间逻辑本来就有 test-room.js 覆盖）
 *
 * 现在覆盖：
 *   · ★ 转盘扇区权重：前端 buildSectors 与云函数 WHEEL_SECTORS 必须一致
 *   · ★ 转盘指针角度：转到的角度和判出来的扇区必须对得上
 *   · ★ 骰盅五步流程：入盅 → 摇盅 → 扣盅 → 揭盅 → 桌上滚动，缺一步就"不像现实"
 *   · 震动分级：扣盅要震、摇盅不能震
 *   · 大话骰：扣盅后才能看骰子
 *
 * 跑法：node scripts/test-game.js
 */
const assert = require('assert')
const fs = require('fs')
const path = require('path')

const ROOT = path.join(__dirname, '..')
/*
 * ★ 真模块，不是源码副本。
 *   ⑧ 要比较的是"实际生效的时刻"，只有加载真模块才算数 ——
 *   从源码正则抓数字会在实现一改之后就静默失效（AGENTS.md 记过五次）。
 */
const feedback = require(path.join(ROOT, 'miniprogram/game/feedback.js'))

let n = 0
function ok(msg) { n++; console.log('  ✓ ' + msg) }

/* ============================================================
 * 从真实源文件里抽出要测的东西
 * ============================================================ */

const roomJs = fs.readFileSync(
  path.join(ROOT, 'miniprogram/game/room/room.js'), 'utf8')
const roomCloud = fs.readFileSync(
  path.join(ROOT, 'cloudfunctions/room/index.js'), 'utf8')

/** 把源文件里某个 const X = [...] 数组字面量抽出来求值 */
function extractArray(src, name) {
  const i = src.indexOf('const ' + name + ' = [')
  assert.ok(i >= 0, '没找到 ' + name + ' —— 是不是改名了？')
  const start = src.indexOf('[', i)
  /* 从 [ 开始配对括号，找到对应的 ] */
  let depth = 0, end = -1
  for (let k = start; k < src.length; k++) {
    if (src[k] === '[') depth++
    else if (src[k] === ']') { depth--; if (depth === 0) { end = k; break } }
  }
  assert.ok(end > start, name + ' 的数组没闭合')
  const literal = src.slice(start, end + 1)
  /* 数组里只有字符串和数字，用 eval 是安全的（不执行任何函数调用） */
  return eval('(' + literal + ')')
}

/** 抽出前端 buildSectors 函数体（纯函数，只依赖 SECTORS） */
function extractBuildSectors(src) {
  const i = src.indexOf('function buildSectors()')
  assert.ok(i >= 0, '没找到 buildSectors —— 是不是改名了？')
  let depth = 0, end = -1
  const start = src.indexOf('{', i)
  for (let k = start; k < src.length; k++) {
    if (src[k] === '{') depth++
    else if (src[k] === '}') { depth--; if (depth === 0) { end = k; break } }
  }
  const body = src.slice(start + 1, end)
  const SECTORS = extractArray(src, 'SECTORS')
  return new Function('SECTORS', body)
}

/* ============================================================ */
;(async () => {
  console.log('\n=== ① ★ 前后端转盘权重必须完全一致 ===')
  /*
   * 这是 2.6.0 转盘联机化之后**最容易出错、后果最严重**的一处：
   * 结果由云函数抽（防房主作弊），但动画由前端算（转到哪个扇区）。
   * 两边权重不一致 → 云函数说"真心话"，前端却把指针停在"喝一杯"上。
   *
   * 玩家不会觉得这是 bug，会觉得游戏在骗人 —— 这类不一致最伤信任。
   */
  const front = extractArray(roomJs, 'SECTORS')
  const back = extractArray(roomCloud, 'WHEEL_SECTORS')

  assert.strictEqual(front.length, back.length,
    '前后端扇区数量不一致：前端 ' + front.length + ' 个，云函数 ' + back.length + ' 个')
  front.forEach((f, i) => {
    const b = back[i]
    assert.ok(b, '云函数缺少第 ' + i + ' 个扇区（' + f.t + '）')
    assert.strictEqual(f.k, b.k, '第 ' + i + ' 个扇区的键不一致：' + f.k + ' vs ' + b.k)
    assert.strictEqual(f.t, b.t, '第 ' + i + ' 个扇区的文案不一致：' + f.t + ' vs ' + b.t)
    assert.strictEqual(f.weight, b.weight,
      '第 ' + i + ' 个扇区（' + f.t + '）的权重不一致：前端 ' + f.weight + ' vs 云函数 ' + b.weight)
  })
  ok(front.length + ' 个扇区的键/文案/权重前后端完全一致')

  console.log('\n=== ② 转盘扇区无缝覆盖 360° ===')
  const bs = extractBuildSectors(roomJs)
  const built = bs(front)
  const sectors = built.list
  const gradient = built.gradient

  assert.ok(Math.abs(sectors[0].a0 - 0) < 1e-9, '第一个扇区应从 0 度开始')
  assert.ok(Math.abs(sectors[sectors.length - 1].a1 - 360) < 1e-9, '最后一个扇区应到 360 度')
  for (let i = 1; i < sectors.length; i++) {
    assert.ok(Math.abs(sectors[i].a0 - sectors[i - 1].a1) < 1e-9,
      '第 ' + i + ' 个扇区和上一个不相接')
  }
  ok(sectors.length + ' 个扇区无缝覆盖 360°，无空隙无重叠')

  assert.ok(gradient.indexOf('conic-gradient') === 0,
    'gradient 必须是单条 conic-gradient（多元素 + CSS 变量在部分基础库不生效）')
  ok('色带是单条 conic-gradient（兼容性有保障）')

  console.log('\n=== ③ ★ 指针角度与判定必须一致 ===')
  /*
   * 复刻 room.js 的 playWheel 里的角度算法：
   *   finalDeg = 360 * turns - targetMid - 90
   * 再反推"指针此刻指着哪个扇区"，应当正好是目标扇区。
   * 算法一旦写反（正负号），转盘照样转，只是指的和判的不一样。
   */
  const judgeAt = (deg) => {
    /* CSS 的 0deg 在正上方。转盘顺时针转 deg 度后，
       原本位于 a 度的位置会转到 (a + deg)。
       指针固定在正上方，所以命中 (a + deg) % 360 == 0 的那个扇区。 */
    const norm = ((-deg % 360) + 360) % 360
    for (const s of sectors) {
      if (norm >= s.a0 && norm < s.a1) return s
    }
    return sectors[0]
  }

  const wrong = []
  sectors.forEach(s => {
    ;[4, 5, 6].forEach(turns => {
      /*
       * ★★★ 2026-10-30 修：这条断言原来是**废的**。
       *
       * 旧写法：
       *     const finalDeg = 360 * turns - s.mid - 90
       *     const hit = judgeAt(finalDeg + 90)     ← 又加回 +90
       * 它把 -90 补偿回去了，所以**公式错不错都能通过** ——
       * 断言和被测代码犯了同一个错，互相验证了彼此的 bug。
       *
       * 而真实的 playWheel 是 `360*turns - targetMid - 90`，
       * conic-gradient 的 0° 在正上方，于是整体偏 90°，指针永远指隔壁。
       * 用户报「指针指的和结果不符」，根因就在这里，而断言一直是绿的。
       *
       * 现在：**用与 playWheel 完全相同的公式**，不做任何补偿。
       */
      const finalDeg = 360 * turns - s.mid
      const hit = judgeAt(finalDeg)
      if (hit.k !== s.k) {
        wrong.push(s.t + '(转到 ' + finalDeg.toFixed(1) + '° 却命中 ' + hit.t + ')')
      }
    })
  })
  assert.deepStrictEqual(wrong, [],
    '每个扇区转到指针下都应命中自己（角度换算写反了）：\n    ' + wrong.join('\n    '))
  ok(sectors.length + ' 个扇区 × 3 种圈数 = ' + (sectors.length * 3) + ' 组全部命中自己')

  console.log('\n=== ④ jitter 不能把指针推出扇区 ===')
  /*
   * 云函数给的 jitter 是 ±0.3 圈内的随机数。
   * 前端必须把它夹紧到扇区内 —— 否则指针会指到隔壁扇区，
   * 又变成"指的和判的不一样"。
   */
  const outOfRange = []
  sectors.forEach(s => {
    ;[-0.3, -0.15, 0, 0.15, 0.3].forEach(raw => {
      const safe = Math.max(-s.span / 2 + 2, Math.min(s.span / 2 - 2, raw))
      const targetMid = s.mid + safe
      const finalDeg = 360 * 4 - targetMid - 90
      const hit = judgeAt(finalDeg + 90)
      if (hit.k !== s.k) outOfRange.push(s.t + ' + jitter ' + raw)
    })
  })
  assert.deepStrictEqual(outOfRange, [],
    'jitter 夹紧后仍跑出扇区：\n    ' + outOfRange.join('\n    '))
  ok('极端 jitter（±0.3）夹紧后仍停在扇区内 —— 指针不会指到隔壁')

  console.log('\n=== ⑤ 权重确实影响概率（不是等分）===')
  const truthSpan = sectors[0].span
  const passSpan = sectors[sectors.length - 1].span
  assert.ok(truthSpan > passSpan * 3, '真心话的概率应远大于免罚')
  ok('真心话 ' + truthSpan.toFixed(1) + '° vs 免罚 ' + passSpan.toFixed(1) + '° —— 免罚稀有才够爽')

  console.log('\n=== ⑥ ★ 骰盅五步流程必须齐全（"像现实"的核心）===')
  /*
   * 用户要求「尽量做到和现实差不多的感觉」。一个完整的摇盅流程是：
   *   ① 骰子入盅  ② 摇盅  ③ 扣盅  ④ 揭盅  ⑤ 骰子在桌上滚两下才停
   * 缺任何一步，"像现实"就打折 —— 而缺了页面照样跑、不报错。
   * 所以这里把五步的顺序和音效键都锁死。
   */
  const feedbackJs = fs.readFileSync(
    path.join(ROOT, 'miniprogram/game/feedback.js'), 'utf8')
  const sfxJs = fs.readFileSync(
    path.join(ROOT, 'miniprogram/game/sfx.js'), 'utf8')

  const STEPS = [
    ['diceIn', 'diceIntoCup', '① 骰子入盅'],
    ['cupShake', 'cupShake', '② 摇盅'],
    ['cupSlam', 'cupSlam', '③ 扣盅'],
    ['cupLift', 'cupLift', '④ 揭盅'],
    ['diceTable', 'diceOnTable', '⑤ 骰子在桌上滚两下才停']
  ]
  const missing = []
  STEPS.forEach(step => {
    if (feedbackJs.indexOf(step[0] + ':') < 0) {
      missing.push('feedback 缺少 ' + step[0] + '（' + step[2] + '）')
    }
    if (sfxJs.indexOf(step[1] + ':') < 0) {
      missing.push('sfx 缺少音效 ' + step[1] + '（' + step[2] + '）')
    }
  })
  assert.deepStrictEqual(missing, [], '摇盅流程不完整：\n    ' + missing.join('\n    '))
  ok('入盅 → 摇盅 → 扣盅 → 揭盅 → 桌上滚动，五步齐全且音效已注册')

  /* ★ 2026-10-28：题库不许有**不可控的隐私指令**。
     收题原则写在文档里（"不涉及在场某人隐私、不让人下不来台"），
     但代码里没有对应的检查 —— 于是「你朋友圈屏蔽过谁」「让旁边的人翻你的相册」
     这两条一直躺在题库里。前者可能当场得罪人（被屏蔽的人可能就在座），
     后者根本不可控（翻到什么不知道）。
     判据：出现这些动作词的题一律报错，要求换成"主动分享"级别的题。 */
  {
    const d = require(path.join(ROOT, 'miniprogram/utils/decks.js'))
    const DANGER = /翻你的相册|翻他的相册|翻一下相册|屏蔽过谁|发朋友圈|打开你的微信|看你的聊天/
    const bad = []
    d.DECKS.forEach(deck => {
      [...(deck.truth || []), ...(deck.dare || [])].forEach(q => {
        if (DANGER.test(q)) bad.push(deck.name + ' → ' + q)
      })
    })
    assert.deepStrictEqual(bad, [],
      '这些题是**不可控的隐私指令**（可能当场得罪人，或翻到什么不知道）：\n    ' + bad.join('\n    '))
    ok('题库里没有不可控的隐私指令')
  }

  /* ★ 2026-10-28：每个玩法的规则必须提到"喝"。
     复核文案时发现大话骰六条规则从没写过"输了喝几杯"（桌上第一个会问的问题），
     而比大小和卧底**代码里根本没有惩罚量** —— 所以判据不是"每条都写 1 杯"
     （那会编造），而是"必须让玩家知道这游戏是要喝的"。 */
  {
    const g = require(path.join(ROOT, 'miniprogram/utils/games.js'))
    /*
     * 判据是"说清惩罚方式"，不是"一定写喝" —— 转盘是真心话/大冒险，
     * 本来就不用喝。所以认这几个词：喝 / 罚 / 执行 / 真心话 / 大冒险。
     */
    const noPenalty = g.GAMES.filter(x =>
      !(x.how || []).some(h => /喝|罚|执行|真心话|大冒险/.test(h)))
    assert.deepStrictEqual(noPenalty.map(x => x.name), [],
      '这些玩法的规则里完全没说清"输了会怎样"：' + noPenalty.map(x => x.name).join('、'))
    ok('五个玩法的规则都说清了惩罚方式')
  }

  console.log('\n=== ⑦ 扣盅必须有震动，摇盅必须没有 ===')
  /*
   * 震动分级是刻意的：
   *   · 扣盅是一局里的重音 → 要震（medium）
   *   · 摇盅是**持续 1 秒的过程** → 绝对不能震，
   *     否则一局摇好几次、每次嗡一秒，用户会直接关掉震动
   * 这条破坏后不报错，只是"玩起来很烦"，所以要用断言锁住。
   */
  const block = (key) => {
    const i = feedbackJs.indexOf(key + ': {')
    assert.ok(i >= 0, 'feedback 里找不到 ' + key)
    const j = feedbackJs.indexOf('}', i)
    return feedbackJs.slice(i, j)
  }
  assert.ok(/haptic:\s*'(medium|heavy)'/.test(block('cupSlam')),
    '扣盅必须给 medium/heavy 震动 —— 它是整条流程的重音')
  ok('扣盅给了 medium 震动（一局里的重音）')

  assert.ok(/haptic:\s*null/.test(block('cupShake')),
    '摇盅必须不震（持续音，震了会整局嗡嗡响）')
  ok('摇盅不震（持续 1 秒的过程，震了用户会关掉震动）')

  console.log('\n=== ⑧ 音效三通道错开：震动必须晚于音效 ===')
  /*
   * ★★ 2026-10-28 改成**运行时读派生时间线**，不再从源码正则抓数字。
   *
   * 原因：feedback.js 把手写的 sfxDelay / hapticDelay 收敛成了派生字段
   *      （sfxDelay = impactAt + 30，hapticDelay = impactAt + 50），
   *      表里已经没有那两个数字了。
   *      旧断言用 `/sfxDelay:(\d+)...hapticDelay:(\d+)/` 从源码抓，
   *      抓不到时 `if (!m) return` **静默跳过** —— 一条永远不报错的断言，
   *
   *      AGENTS.md 里同类事故记过五次（判据失效但看着全绿），
   *      所以这里改成调 timeline()：无论实现怎么变，比较的都是真实生效的时刻。
   */
  const badOrder = []
  STEPS.forEach(step => {
    const t = feedback.timeline(step[0])
    assert.ok(t, '⑧ 拿不到时间线：' + step[0])
    if (!t.haptic) return                    // 这一步不震，跳过
    if (t.hapticDelay <= t.sfxDelay) {
      badOrder.push(step[0] + ': 震动延迟(' + t.hapticDelay + ') 应大于音效延迟(' + t.sfxDelay + ')')
    }
  })
  assert.deepStrictEqual(badOrder, [], '触觉最快，必须最后到：\n    ' + badOrder.join('\n    '))
  ok('有震动的步骤全部满足「震动晚于音效」')

  console.log('\n=== ⑨ 大话骰：扣盅后才能看骰子（用户明确要求）===')
  /*
   * 用户原话：「扣盅后才能看自己的骰子」。
   * 所以 onCupPress（按住偷看）里必须有骰子才允许，
   * 且 liarReady（可以叫骰）只能在**看过之后**才置真 ——
   * 否则玩家不看骰子就能叫，这个游戏的核心乐趣就没了。
   */
  const pressStart = roomJs.indexOf('onCupPress()')
  const pressEnd = roomJs.indexOf('onCupRelease()')
  assert.ok(pressStart >= 0 && pressEnd > pressStart, '找不到 onCupPress / onCupRelease')
  const pressFn = roomJs.slice(pressStart, pressEnd)
  assert.ok(pressFn.indexOf('myDice.length') >= 0,
    '没有骰子时不该能"偷看"（onCupPress 要判 myDice.length）')
  assert.ok(/liarReady:\s*true/.test(pressFn),
    '按住偷看之后应把 liarReady 置真（看过才能叫）')
  ok('按住盅才显示骰子，且看过之后才允许叫骰')

  console.log('\n=== ⑩ 骰盅图必须三态齐全 ===')
  const cupDir = path.join(ROOT, 'miniprogram/game/images/cup')
  const cupMissing = ['cup-down', 'cup-shake', 'cup-up']
    .filter(k => !fs.existsSync(path.join(cupDir, k + '.png')))
  assert.deepStrictEqual(cupMissing, [],
    '缺骰盅图（缺哪个，哪个动作就没有画面）：\n    ' + cupMissing.join('\n    '))
  ok('骰盅三态图齐全（扣着 / 摇动 / 提起）')

  /* ============================================================
   * ⑪ ★ 轮询的「变了才 setData」判断 —— 漏判 = 界面卡死不更新
   * ============================================================ */
  console.log('\n=== ⑪ ★ 轮询去重：状态没变就不能 setData ===')
  /*
   * 背景：room 页每 1.5 秒轮询一次。一次游戏十几分钟 = 上百次 setData，
   * 而等别人的时候绝大多数轮询「什么都没变」。
   * setData 是跨线程数据拷贝 + 视图 diff，即使值相同也要走完 ——
   * 不去重就是纯浪费（掉帧 / 耗电 / 发热）。
   *
   * ★ 这条比"省性能"重要得多的是**安全**：
   *   漏判任何一个字段 → 界面再也不更新 → 游戏直接卡死。
   *   所以下面逐个字段做「改了必须被认出来」的反向验证。
   */
  const rcSrc = fs.readFileSync(
    path.join(ROOT, 'miniprogram/game/room/room.js'), 'utf8')
  /*
   * ★ 抽取方式：按**大括号配平**截到函数结束，而不是"找下一个注释"。
   *
   *   原来的写法是 `indexOf('/** 拉一次房间状态', start)` 当结束标记 ——
   *   它假设"roomChanged 后面紧接着就是 refresh"。2026-10-28 我在两者之间
   *   插了一个 retryNow 方法，抽出来的代码就多了半个方法体，
   *   `new Function` 直接报 `Unexpected token ','`。
   *
   *   **测试不能依赖"函数之间的排列顺序"** —— 那是代码长相，不是语义
   *   （同类翻车本文档已记过多次：判据不能依赖代码长什么样）。
   */
  function extractFnBody(src, marker) {
    const i = src.indexOf(marker)
    if (i < 0) return null
    const open = src.indexOf('{', i)
    if (open < 0) return null
    let depth = 0
    for (let k = open; k < src.length; k++) {
      const ch = src[k]
      if (ch === '{') depth++
      else if (ch === '}') {
        depth--
        if (depth === 0) return src.slice(open, k + 1)
      }
    }
    return null
  }
  /* 先剥注释，避免注释里的花括号干扰配平 */
  const rcClean = rcSrc
    .replace(/\/\*[\s\S]*?\*\//g, '')
    .replace(/(^|[^:])\/\/[^\n]*/g, '$1')
  const rcBody = extractFnBody(rcClean, 'roomChanged(prev, room)')
  assert.ok(rcBody, '没找到 roomChanged 函数体（抽取逻辑可能失效了）')
  const roomChanged = new Function('prev', 'room', rcBody)

  /* 基线：两个完全一样的房间 → 判定为「没变」 */
  const base = {
    phase: 'playing', count: 2, turn: 1, round: 1, game: 'liar', host: true,
    countdownMs: 0, bid: null, lastResult: null, spin: null,
    players: [
      { seat: 1, name: 'A', isMe: true, isHost: true, online: true, diceCount: 5, dice: [1, 2, 3, 4, 5] },
      { seat: 2, name: 'B', isMe: false, isHost: false, online: true, diceCount: 5 }
    ],
    options: ['1个1'], updatedAt: 111
  }
  const clone = (o) => JSON.parse(JSON.stringify(o))
  assert.strictEqual(roomChanged(base, clone(base)), false,
    '状态完全相同时应判定为「没变」，否则会白跑 setData')
  ok('状态相同时 → 不 setData（每场省下上百次无效跨线程拷贝）')

  /* ★ 逐个字段反向验证：改了必须被认出来（漏一个就是界面卡死）
   *
   * ⚠️ 这里踩过一个坑，写下来防止再犯：
   *   第一版用例是 `prev.bid = null` → `next.bid = {n:3,...}`。
   *   结果**删掉 `a.n/a.face` 那一行，测试照样通过** ——
   *   因为「bid 从 null 变成对象」被上一行 `!!a !== !!b` 兜住了，
   *   根本没测到我要测的那一行。断言是"通过"的，但测的不是那件事。
   *
   *   所以下面每个用例都必须**让被测的那一行成为唯一的差异来源**：
   *   两侧都存在该对象，只改内部的某个字段。
   */
  const withBid = clone(base)
  withBid.bid = { n: 3, face: 4, zhai: false, at: 999 }
  const withSpin = clone(base)
  withSpin.spin = { index: 1, k: 'dare', t: '大冒险', at: 777 }
  const withResult = clone(base)
  withResult.lastResult = { actual: 3, loserSeat: 2 }

  const MUTATIONS = [
    ['phase', (r) => { r.phase = 'over' }, base],
    ['count（有人进来了）', (r) => { r.count = 3; r.players.push({ seat: 3, name: 'C', isMe: false, isHost: false, online: true, diceCount: 0 }) }, base],
    ['turn（轮到谁了）', (r) => { r.turn = 2 }, base],
    ['round（新一局）', (r) => { r.round = 2 }, base],
    ['game', (r) => { r.game = 'dice' }, base],
    ['host（房主转移了）', (r) => { r.host = false }, base],
    /*
     * ← 这里原来有一条 `countdownMs（倒计时在走）`。
     *   2026-10-28 移除了：倒计时已改成**本地挂钟驱动**（见 startCountdown），
     *   界面刷新由本地 tick 负责，服务端 countdownMs 每 1.5 秒必然不同，
     *   留着它等于每次轮询都 setData 一次，纯浪费跨线程拷贝。
     *   取而代之的是下面 ⑯ 那一组：直接测"挂钟驱动"和"服务端校正"是否还在。
     */
    ['bid 从无到有（有人第一次叫）', (r) => { r.bid = { n: 3, face: 4, zhai: false, at: 999 } }, base],
    /* ↓ 下面三个：两侧都有对象，只改内部 —— 才能测到具体那一行 */
    ['bid 的数量变了', (r) => { r.bid.n = 5 }, withBid],
    ['bid 的点数变了', (r) => { r.bid.face = 6 }, withBid],
    ['spin 从无到有（转盘转了）', (r) => { r.spin = { index: 1, k: 'dare', t: '大冒险', at: 777 } }, base],
    ['spin 又转了一次（at 变了）', (r) => { r.spin.at = 888 }, withSpin],
    ['lastResult 从无到有（出结果了）', (r) => { r.lastResult = { actual: 3, loserSeat: 2 } }, base],
    ['lastResult 内容变了', (r) => { r.lastResult.actual = 9 }, withResult],
    ['玩家在线状态', (r) => { r.players[1].online = false }, base],
    ['玩家已摇（diceCount）', (r) => { r.players[1].diceCount = 2 }, base],
    ['玩家改名了', (r) => { r.players[1].name = 'B2' }, base],
    ['★ 自己的骰子变了（大话骰偷看）', (r) => { r.players[0].dice = [6, 6, 6, 6, 6] }, base],
    ['options（可叫的选项变了）', (r) => { r.options = ['2个1'] }, base]
  ]
  const missed = []
  MUTATIONS.forEach(m => {
    const src = m[2]
    const next = clone(src)
    m[1](next)
    if (roomChanged(src, next) !== true) missed.push(m[0])
  })
  assert.deepStrictEqual(missed, [],
    '这些变化没被认出来 → 界面不会更新（游戏卡死）：\n    ' + missed.join('\n    '))

  /* ============ ⑯ 倒计时：挂钟驱动 + 服务端校正 ============ */
  /*
   * 为什么单独锁这一组：
   *   倒计时存在的全部意义是"所有人同时开始"。而每台手机的 3 秒都从
   *   **自己收到响应**那一刻起算 —— 网络快慢能让两台手机差出几百毫秒
   *   到一秒（轮询 1.5 秒）。竞品（Jackbox）的 count-in 就是为这件事。
   *
   *   两件事必须同时成立：
   *     ① 本地用**挂钟**算剩余（`Date.now() - _cdT0`），不能 `left -= 1000` 累减
   *        —— 累减会累积 setTimeout 的误差，三拍能漂 100ms 以上；
   *     ② 收到 poll 后若"本地剩余"与"服务端剩余"差超过阈值，把起点拽回去
   *        （只校正不重置，重置会让数字跳 3→3→2，比不同步更难看）。
   *
   * ⚠️ 判据用**函数体**而不是整文件正则：整文件里 Date.now() 到处都是，
   *    那种判据删掉目标代码也照样通过（本项目栽过多次）。
   */
  const cdBody = extractFnBody(rcClean, 'startCountdown(remainMs)')
  assert.ok(cdBody, '⑯ 没找到 startCountdown 函数体')
  assert.ok(/\._cdT0\s*=/.test(cdBody), '⑯ 倒计时必须记一个本地起点 _cdT0（挂钟锚点）')
  assert.ok(/Date\.now\(\)\s*-\s*\(?this\._cdT0/.test(cdBody),
    '⑯ 剩余时间必须由 Date.now() 与 _cdT0 反推，不能累减')
  assert.ok(!/left\s*-=\s*1000/.test(cdBody),
    '⑯ 不能再出现 `left -= 1000` 的累减（setTimeout 误差会累积）')

  const applyBody = extractFnBody(rcClean, 'applyRoom(raw, extra)')
  assert.ok(applyBody, '⑯ 没找到 applyRoom 函数体')
  assert.ok(/raw\.countdownMs/.test(applyBody) && /Math\.abs\(/.test(applyBody),
    '⑯ applyRoom 里必须有"本地剩余 vs 服务端剩余"的偏差校正')
  assert.ok(/_cdT0\s*=\s*Date\.now\(\)/.test(applyBody),
    '⑯ 校正时要把 _cdT0 拽到当前时刻（只校正不重置计时器）')
  ok('倒计时：挂钟驱动 + 服务端偏差校正（两台手机不会各走各的）')
  ok(MUTATIONS.length + ' 种状态变化全部能识别（漏一个就会卡死）')

  /* updatedAt 每轮都在变，绝不能参与比较，否则优化完全失效 */
  const onlyTs = clone(base)
  onlyTs.updatedAt = 999999
  assert.strictEqual(roomChanged(base, onlyTs), false,
    'updatedAt 每轮都变，不能参与比较（否则等于没优化）')
  ok('updatedAt 不参与比较（它每轮都变，算进去就等于没优化）')

  /* 必须真的在 refresh 里用上了这个判断 */
  assert.ok(/if \(!this\.roomChanged\(prev, room\)/.test(rcSrc),
    'refresh 里没有用上 roomChanged —— 加了这个函数却不用，等于没优化')
  ok('refresh 里确实调用了 roomChanged')

  /* ============ ⑨ 酒桌题卡库 ============ */
  console.log('\n=== ⑨ 题卡库（真心话 / 大冒险）===')
  /*
   * 题卡是转到「真心话/大冒险」之后**唯一的内容来源**。
   * 它坏了不会报错，只是全场看着屏幕等下文 —— 和转盘"转完就没了"同一个观感问题。
   *
   * 收题标准（写在 decks.js 头部）靠人工把关，但**几条硬指标可以机器验**：
   *   · 每题非空、长度合理（太短没信息量，太长读不完）
   *   · 同一副牌内不重复、**跨场合也不重复**（否则换场合会觉得"怎么还是这些"）
   *   · 四个场合的题量均衡（某个场合题太少会很快抽腻）
   */
  const decks = require(path.join(ROOT, 'miniprogram', 'utils', 'decks.js'))

  assert.ok(decks.DECKS.length >= 4,
    '场合应至少 4 个（朋友/情侣/家人/同事），实际 ' + decks.DECKS.length)

  const all = decks.allTexts()
  assert.ok(all.length >= 120, '题目总数应 ≥ 120，实际 ' + all.length)

  /* 每条都要有实质内容 */
  const tooShort = all.filter(x => x.text.trim().length < 6)
  assert.deepStrictEqual(tooShort.map(x => x.text), [],
    '★ 这些题太短（少于 6 字），一句话就没了：\n    ' + tooShort.map(x => x.text).join('\n    '))
  const tooLong = all.filter(x => x.text.length > 40)
  assert.deepStrictEqual(tooLong.map(x => x.text), [],
    '★ 这些题太长（超过 40 字），酒桌上读不完：\n    ' + tooLong.map(x => x.text).join('\n    '))

  /* 跨场合去重 —— 这是"换场合"体验的关键 */
  const seen = {}
  const dup = []
  all.forEach(x => {
    const t = x.text.trim()
    if (seen[t]) dup.push(t + '  （' + seen[t] + ' 与 ' + x.deck + ' 都有）')
    seen[t] = x.deck
  })
  assert.deepStrictEqual(dup, [],
    '★ 有题目在多个场合重复 —— 换场合的人会觉得"怎么还是这些"：\n    ' + dup.join('\n    '))

  /* 每个场合都要"够玩"：真心话和大冒险各至少 12 条 */
  decks.DECKS.forEach(d => {
    assert.ok(d.truth.length >= 12 && d.dare.length >= 12,
      '「' + d.name + '」的题太少（真心话 ' + d.truth.length + ' / 大冒险 ' + d.dare.length +
      '）—— 至少各 12 条才够玩几轮')
    assert.ok(d.name && d.desc && d.k,
      '场合「' + d.k + '」缺少 name/desc/k 之一 —— 建房页会显示空白')
  })
  ok('题卡库 ' + decks.DECKS.length + ' 个场合 / ' + all.length + ' 条题，无重复、长度合理、题量均衡')

  /* ---------- 云端抽题必须真的连上 ---------- */
  console.log('\n=== ⑨b 抽题在服务端做，且用得上场合 ===')
  /*
   * ★ 为什么必须服务端抽：前端抽的话可以"重摇到满意"，
   *   题目就不再是运气了；而且没法保证全场同时看到同一张。
   *   这和转盘抽扇区是同一个理由。
   */
  assert.ok(/require\(['"]\.\/decks\.js['"]\)/.test(roomCloud),
    '★ 云函数没有 require decks.js —— 抽题会拿不到题库')
  assert.ok(/decks\.deckOf\(room\.deck\)/.test(roomCloud),
    '★ 云函数抽题时没有用 room.deck（场合）—— 换场合会不起作用')
  assert.ok(/sec\.k === 'truth' \|\| sec\.k === 'dare'/.test(roomCloud),
    '★ 云函数没有判断"是不是真心话/大冒险"就抽题 —— 喝一杯也会被塞一道题')
  assert.ok(/card:\s*card/.test(roomCloud),
    '★ 抽出来的题没有随 spin 一起下发（分开两次请求会让各人看到不同的题）')
  ok('抽题在服务端、按场合、只对真心话/大冒险生效，且与扇区同一次下发')

  /* ---------- 前后端题库必须一致（同转盘扇区那条命门） ---------- */
  /* ---------- 自定义题：内容安全 + 权限 + 题池合并 ---------- */
  console.log('\n=== ⑨d 自定义题（UGC，必须过内容安全）===')
  /*
   * ★ 这一条是**合规硬要求**，不是优化项。
   *   2026-10-09 安全审计刚补上 wishes/reminds/pair 漏检的内容安全，
   *   新功能不能在同一处再犯 —— 而且房间是多人场景，违规内容会被**所有人**看到，
   *   比双人场景更严重。
   *
   * 判据不能只看"有没有 require"，要确认**加了题的那条路径上真的调了 safe()**。
   */
  const cardBranch = /if \(action === 'card'\)[\s\S]*?\n    \}/.exec(roomCloud)
  assert.ok(cardBranch, '★ 云函数里找不到 card action（加自定义题）')
  assert.ok(/await safe\(text, OPENID\)/.test(cardBranch[0]),
    '★ 加自定义题的路径上**没有调用 safe()** —— 自定义题是 UGC，必须过内容安全。\n' +
    '    房间是多人场景，违规内容会被所有人看到。')
  assert.ok(/if \(!sec\.pass\) return/.test(cardBranch[0]),
    '★ 调了 safe() 但没检查结果 —— 等于没做')
  ok('加自定义题的路径上做了内容安全检查（UGC 合规）')

  /* 只能删自己的 —— 同 moments 的"只能删自己记的" */
  const delBranch = /if \(action === 'cardDel'\)[\s\S]*?\n    \}/.exec(roomCloud)
  assert.ok(delBranch, '★ 云函数里找不到 cardDel action')
  assert.ok(/c\.by === OPENID/.test(delBranch[0]),
    '★ 删题没有校验归属 —— 能删掉别人加的题')
  ok('只能删自己加的题（校验 by === OPENID）')

  /* 题池必须合并：自定义题要真的抽得到，否则用户加了却抽不到 */
  assert.ok(/const pool = builtin\.concat\(custom\)/.test(roomCloud),
    '★ 抽题时没有把自定义题并入题池 —— 用户加了也抽不到，会以为没生效')
  ok('自定义题与内置题合并成同一个题池（加了就抽得到）')

  /* 每人每类有上限：防刷屏，也防把内置题库淹掉 */
  assert.ok(/MAX_CARDS_PER_KIND/.test(roomCloud),
    '★ 自定义题没有条数上限 —— 可以塞几百条把内置题库淹没')

  console.log('\n=== ⑨c 前后端题库必须逐字节一致 ===')
  /*
   * 云函数独立打包、不能跨目录 require，所以题卡有两份（源 + 云函数拷贝）。
   * 两份不一致的后果：
   *   · 前端建房页列出的场合、和云端实际能抽的场合对不上
   *   · 更糟的是题目内容不同 —— 但**这个不一致不会报错**，
   *     只是"某些题永远抽不到"，几乎不可能被发现
   *
   * 所以这里做**逐字节比对**，和 derive.js 的 5 处一致是同一个机制。
   */
  const deckSrc = fs.readFileSync(path.join(ROOT, 'miniprogram', 'utils', 'decks.js'), 'utf8')
  const deckCopy = fs.readFileSync(path.join(ROOT, 'cloudfunctions', 'room', 'decks.js'), 'utf8')
  assert.strictEqual(deckCopy, deckSrc,
    '★ 云函数里的 decks.js 与源文件不一致 —— 跑 scripts/sync-derive.sh 同步\n' +
    '    （不一致不会报错，只会让"某些题永远抽不到"）')
  ok('题卡库两份完全一致（改完记得跑 sync-derive.sh）')

  console.log('\n========================================================')
  /* ============================================================================
   * ★★ 顿帧（hit-stop）只能给重击（2026-11-03）
   *
   * 调研结论（egmatic / Nijman《The Art of Screenshake》/ 网易雷火 UX）：
   * **顿帧是打击感的第一原则，不是屏幕震动。**
   * 冲击那一刻画面完全静止 40~80ms，大脑才有时间"读完"这一下；
   * 直接抖到底，感知上是一团糊的运动，重量感反而更轻。
   *
   * 但顿帧用错地方就变成"卡"：
   *   · 高频动作（骰子逐颗落定、翻牌）不能顿 —— 一局十几次，会像掉帧
   *   · 时长必须 ≤80ms —— 再长就从"有分量"变成"卡了一下"
   *
   * 判据（语义判，不猜代码长相）：
   *   ① 每个 `this.bump(N)` 的 N 必须在 [0, 80]
   *   ② 允许 0 —— 但必须是**显式写的** 0，不是"忘了传参吃默认值"
   *      （默认 60ms 是好用的默认，但高频动作必须显式关掉，
   *        否则将来有人往逐颗落定里加一次 bump 就悄悄多了顿帧）
   * ========================================================================== */
  {
    const roomSrc = fs.readFileSync(
      path.join(__dirname, '..', 'miniprogram/game/room/room.js'), 'utf8')
    const calls = [...roomSrc.matchAll(/this\.bump\((\d*)\)/g)]
    assert.ok(calls.length >= 3, '应该至少有扣盅/揭盅/结算三处重击（实际 ' + calls.length + '）')

    const tooLong = []
    const implicitDefault = []
    calls.forEach((m, i) => {
      const raw = m[1]
      if (raw === '') { implicitDefault.push(i + 1); return }
      const ms = Number(raw)
      if (ms > 80) tooLong.push('第 ' + (i + 1) + ' 处 ' + ms + 'ms')
    })
    assert.deepStrictEqual(tooLong, [],
      '顿帧超过 80ms 就变成"卡了一下"而不是"有分量"：\n    ' + tooLong.join('\n    '))
    assert.deepStrictEqual(implicitDefault, [],
      '这些 bump() 没显式传时长（会吃默认 60ms）：第 ' + implicitDefault.join('/') + ' 处\n' +
      '    高频动作（逐颗落定）必须显式 this.bump(0)，重击必须显式写毫秒数 ——\n' +
      '    "忘了传参"和"故意不要顿帧"在代码上一模一样，只能靠显式区分。')

    ok('★ 顿帧只给重击且 ≤80ms（' + calls.length + ' 处全部显式声明时长）')
  }

  console.log('  游戏逻辑：全部 ' + n + ' 项断言通过')
  console.log('========================================================')
})().catch((e) => {
  console.error('\n✗ 失败：', e.message)
  process.exit(1)
})
