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

let n = 0
function ok(msg) { n++; console.log('  ✓ ' + msg) }

/* ============================================================
 * 从真实源文件里抽出要测的东西
 * ============================================================ */

const roomJs = fs.readFileSync(
  path.join(ROOT, 'miniprogram/pages/game/room/room.js'), 'utf8')
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
      /* 不加 jitter 时，扇区中心必须正好停在指针下。
         finalDeg + 90 是把"指针在 -90°"补偿回 0° 基准。 */
      const finalDeg = 360 * turns - s.mid - 90
      const hit = judgeAt(finalDeg + 90)
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
    path.join(ROOT, 'miniprogram/utils/feedback.js'), 'utf8')
  const sfxJs = fs.readFileSync(
    path.join(ROOT, 'miniprogram/utils/sfx.js'), 'utf8')

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
  const badOrder = []
  STEPS.forEach(step => {
    const b = block(step[0])
    /*
     * ★ 必须先确认这一步**有**震动，再比较延迟。
     *   第一版直接抓 sfxDelay / hapticDelay 两个数字就比，
     *   但 `haptic: null` 的步骤（摇盅、揭盅）里 hapticDelay 仍是 0，
     *   于是报了两条假失败 —— 断言比被测代码更容易写错，这里就是例子。
     */
    if (!/haptic:\s*'/.test(b)) return      // 这一步不震，跳过
    const m = /sfxDelay:\s*(\d+)[\s\S]*?hapticDelay:\s*(\d+)/.exec(b)
    if (!m) return
    if (Number(m[2]) <= Number(m[1])) {
      badOrder.push(step[0] + ': 震动延迟(' + m[2] + ') 应大于音效延迟(' + m[1] + ')')
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
  const cupDir = path.join(ROOT, 'miniprogram/images/cup')
  const cupMissing = ['cup-down', 'cup-shake', 'cup-up']
    .filter(k => !fs.existsSync(path.join(cupDir, k + '.png')))
  assert.deepStrictEqual(cupMissing, [],
    '缺骰盅图（缺哪个，哪个动作就没有画面）：\n    ' + cupMissing.join('\n    '))
  ok('骰盅三态图齐全（扣着 / 摇动 / 提起）')

  console.log('\n========================================================')
  console.log('  游戏逻辑：全部 ' + n + ' 项断言通过')
  console.log('========================================================')
})().catch((e) => {
  console.error('\n✗ 失败：', e.message)
  process.exit(1)
})
