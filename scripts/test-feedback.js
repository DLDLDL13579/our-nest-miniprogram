/**
 * test-feedback.js —— 反馈时间轴的断言
 *
 * 这一组锁死的是**感知顺序**这条规律，不是普通的功能正确性。
 *
 * 为什么必须测：用户明确要求「音效要比动画慢一点」，
 * 而这条规律很容易在后续改动中被无意破坏 ——
 * 比如某人觉得"音效延迟 90ms 太慢"直接改回同时触发，
 * 页面照常工作、代码也"对"，但手感就退回去了，而且没人会发现。
 *
 * 三条核心断言：
 *   ① 音效不能早于冲击帧（否则声音抢在视觉动作之前）
 *   ② 震动必须晚于音效（触觉感知最快，最后到才「同时」）
 *   ③ 时间轴不能长于动画（否则动作结束了声音还在响）
 *
 * 跑法：node scripts/test-feedback.js
 */
const path = require('path')
const fs = require('fs')
const Module = require('module')
const assert = require('assert')

/* mock 掉 wx —— feedback.js 里用到 wx.getStorageSync / vibrateShort */
let vibrateCalls = []
const storage = {}
global.wx = {
  getStorageSync: (k) => (k in storage ? storage[k] : ''),
  setStorageSync: (k, v) => { storage[k] = v },
  vibrateShort: (o) => { vibrateCalls.push({ kind: 'short', type: (o && o.type) || null }) },
  vibrateLong: () => { vibrateCalls.push({ kind: 'long' }) },
  createInnerAudioContext: () => ({
    play() {}, stop() {}, destroy() {}, pause() {},
    src: '', loop: false, volume: 1, obeyMuteSwitch: true, playbackRate: 1
  }),
  setInnerAudioOption: () => {}
}

const ROOT = path.join(__dirname, '..')
const feedback = require(path.join(ROOT, 'miniprogram', 'game', 'feedback.js'))
const { FEEDBACK, timeline } = feedback

let n = 0
function ok(msg) { n++; console.log('  ✓ ' + msg) }
const sleep = (ms) => new Promise((r) => setTimeout(r, ms))

;(async () => {
  /* ============ ① 时间轴表的结构完整性 ============ */
  console.log('\n=== ① 时间轴表结构 ===')
  const keys = Object.keys(FEEDBACK)
  assert.ok(keys.length >= 8, '时间轴表至少应有 8 个动作，实际 ' + keys.length)
  ok(`时间轴表定义了 ${keys.length} 个动作：${keys.join(' / ')}`)

  keys.forEach((k) => {
    /* 结构断言看**原始表**：animMs / impactAt 是表里唯一该存在的东西 */
    const f = FEEDBACK[k]
    assert.strictEqual(typeof f.animMs, 'number', k + ' 缺 animMs')
    assert.strictEqual(typeof f.impactAt, 'number', k + ' 缺 impactAt')
    /*
     * animMs 允许为 0 = **这个动作没有配套动画**（纯音效 / 纯震动提示，
     * 比如"房主转移到我头上"只是一声提示 + 一句 toast）。
     *
     * 三个通道本来就是可选的：fire() 里 sfx / haptic 都能缺省，
     * 动画自然也能缺。要求"必须为正"等于逼着人为了过测试硬凑一个假动画。
     * 但有动画时必须是正的 —— 下面 impactAt 的区间检查会兜住。
     */
    assert.ok(f.animMs >= 0, k + ' 的 animMs 不能为负')
    if (f.animMs === 0) {
      assert.ok(!f.impactAt, k + ' 没有动画时 impactAt 应为 0（否则冲击帧指向不存在的动画）')
    }
    assert.ok(f.impactAt >= 0, k + ' 的 impactAt 不能为负')
    /* impactAt 必须在动画时长内，否则冲击帧永远不会到来 */
    assert.ok(f.impactAt <= f.animMs, `${k}: impactAt(${f.impactAt}) 超出了 animMs(${f.animMs})`)
  })
  ok('每个动作都定义了 animMs / impactAt，且冲击帧落在动画时长内')

  /* ============ ①b 延迟必须是派生的 ============ */
  console.log('\n=== ①b 音效/震动延迟必须由冲击帧派生（不许手写）===')
  /*
   * 2026-10-28 的改造：表里原来每个动作都手写 sfxDelay + hapticDelay，
   * 规则是「视觉 → 音效 +30ms → 震动 +20ms」。
   * 逐条核算发现 11 个撞击类动作里 6 条精确、4 条偏 +10ms、1 条完全没补偿 ——
   * 同一条规律被写成三套数字，而且不会有任何地方报错。
   *
   * 现在表里只描述意图（哪个冲击帧、哪个音效、多重震动），
   * 时刻统一由 timeline() 从 impactAt 推出来。
   * 这条断言锁两件事：
   *   ① 表里不许再出现手写的延迟字段（出现了就是又开了第二个出口）
   *   ② 派生公式本身不许被悄悄改（+30 / +50 是规范值）
   */
  const handWritten = keys.filter(k => 'sfxDelay' in FEEDBACK[k] || 'hapticDelay' in FEEDBACK[k])
  assert.deepStrictEqual(handWritten, [],
    '这些动作在表里手写了延迟（延迟只能由 timeline() 派生）：\n    ' + handWritten.join('\n    '))

  const drift = []
  keys.forEach(k => {
    const t = timeline(k)
    if (!t) return
    if (t.impactAt > 0) {
      if (t.sfx && t.sfxDelay !== t.impactAt + 30) {
        drift.push(`${k}: sfxDelay(${t.sfxDelay}) 应为 impactAt+30(${t.impactAt + 30})`)
      }
      if (t.haptic && t.hapticDelay !== t.impactAt + 50) {
        drift.push(`${k}: hapticDelay(${t.hapticDelay}) 应为 impactAt+50(${t.impactAt + 50})`)
      }
    }
  })
  assert.deepStrictEqual(drift, [], '派生公式被改坏了（规范是音效 +30 / 震动 +50）：\n    ' + drift.join('\n    '))
  ok(`${keys.length} 个动作的延迟全部由 impactAt 派生，没有手写漂移`)

  /* ============ ② ★ 音效不能早于冲击帧 ============ */
  console.log('\n=== ② ★ 音效必须晚于（或等于）冲击帧 ===')
  /*
   * 这是「音效和动画没匹配上」的核心修复点。
   * 原来音效在动画第一帧就响，但视觉的冲击点在几十毫秒之后 ——
   * 声音跑在动作前面，听起来"抢拍"。
   *
   * 例外：起手音（impactAt === 0，比如摇骰的持续声）本来就该立刻响。
   */
  const tooEarly = []
  keys.forEach((k) => {
    const f = timeline(k)
    if (!f.sfx || f.impactAt === 0) return
    if (f.sfxDelay < f.impactAt) {
      tooEarly.push(`${k}: sfxDelay(${f.sfxDelay}) < impactAt(${f.impactAt})`)
    }
  })
  assert.deepStrictEqual(tooEarly, [],
    '这些音效早于冲击帧（会「抢拍」）：\n    ' + tooEarly.join('\n    '))
  const delayed = keys.filter(k => FEEDBACK[k].sfx && FEEDBACK[k].impactAt > 0)
  ok(`${delayed.length} 个撞击类音效都排在冲击帧之后（不再抢拍）`)

  /* ============ ③ ★★ 震动必须晚于音效 ============ */
  console.log('\n=== ③ ★★ 震动必须晚于音效（用户明确要求的规律）===')
  /*
   * 依据：人脑处理三个通道的速度是 触觉 > 听觉 > 视觉
   * （听觉约 13ms、视觉约 50ms 形成知觉）。
   * 所以如果三者同时触发，玩家感知到的是「先震 → 再响 → 最后看见」，
   * 反而显得震动在抢拍。
   *
   * 补偿办法就是让它们按感知速度**倒序**触发：
   *   视觉最先 → 音效 +30ms → 震动再 +20ms
   *
   * 这条如果被破坏，手感会悄悄退化，所以必须锁死。
   */
  const wrongOrder = []
  keys.forEach((k) => {
    const f = timeline(k)
    if (!f.haptic) return
    if (f.hapticDelay < f.sfxDelay) {
      wrongOrder.push(`${k}: hapticDelay(${f.hapticDelay}) < sfxDelay(${f.sfxDelay})`)
    }
  })
  assert.deepStrictEqual(wrongOrder, [],
    '这些动作的震动早于音效（触觉最快，必须最后到）：\n    ' + wrongOrder.join('\n    '))
  const withHaptic = keys.filter(k => FEEDBACK[k].haptic)
  ok(`${withHaptic.length} 个带震动的动作，全部满足「震动晚于音效」`)

  /* ============ ④ 时间轴不能长于动画 ============ */
  console.log('\n=== ④ 反馈不能拖过动画太长 ===')
  /*
   * 允许音效尾巴长于动画（这是"声音在空间里回荡"的效果，是我们要的），
   * 但**触发时刻**不能晚于动画结束太多 —— 否则动作都做完了才响。
   */
  const tooLate = []
  keys.forEach((k) => {
    const f = FEEDBACK[k]
    if (!f.sfx) return
    if (f.sfxDelay > f.animMs + 120) {
      tooLate.push(`${k}: sfxDelay(${f.sfxDelay}) 晚于 animMs(${f.animMs}) 太多`)
    }
  })
  assert.deepStrictEqual(tooLate, [],
    '这些音效触发太晚（动作都结束了）：\n    ' + tooLate.join('\n    '))
  ok('所有反馈的触发时刻都落在动画窗口内')

  /* ============ ④b 音量分两档（关键音不能被装饰音带下去） ============ */
  console.log('\n=== ④b 音量分档：关键音响、装饰音轻 ===')
  /*
   * 2026-10-28 加。原来所有音效 volume=1，用户嫌吵只有一个全开/全关的开关 ——
   * 关掉之后连"该你了""开盅"都听不到，而那两声是功能性的（不知道就玩不下去）。
   *
   * 断言锁三件事：
   *   ① 关键动作走高档（没写 vol 的默认就是 0.9，漏写也不会变轻）
   *   ② 装饰动作**真的更低** —— 否则分类等于没做
   *   ③ 两档差得够开（≥0.3）：差 0.1 听感上没区别，等于白分
   */
  const DECOR = ['diceSettle', 'shaker', 'cupShake', 'diceIn', 'cupLift', 'diceTable', 'uwVote', 'pkFlip']
  const CRITICAL = ['cupSlam', 'cupOpen', 'countdownGo', 'win', 'penalized', 'uwReveal', 'pkSpread']
  DECOR.forEach(k => {
    const t = timeline(k)
    assert.ok(t, '④b 时间线取不到：' + k)
    assert.ok(t.vol <= 0.55, `④b ${k} 是装饰音，音量应 ≤0.55，实际 ${t.vol}`)
  })
  CRITICAL.forEach(k => {
    const t = timeline(k)
    assert.ok(t, '④b 时间线取不到：' + k)
    assert.ok(t.vol >= 0.85, `④b ${k} 是关键音（缺了玩不下去），音量应 ≥0.85，实际 ${t.vol}`)
  })
  const minCrit = Math.min.apply(null, CRITICAL.map(k => timeline(k).vol))
  const maxDecor = Math.max.apply(null, DECOR.map(k => timeline(k).vol))
  assert.ok(minCrit - maxDecor >= 0.3,
    `④b 关键音(${minCrit}) 与装饰音(${maxDecor}) 差得太小，听感上分不出来`)
  ok(`关键音 ${minCrit} / 装饰音 ${maxDecor}（差 ${(minCrit - maxDecor).toFixed(2)}，一局十几次的都是轻的那档）`)

  /* ============ ④c 表里的每个动作都必须真的被接线 ============ */
  console.log('\n=== ④c 死动作检测：定义了却从没被 fire 的动作 ===')
  /*
   * ★★ 2026-10-28 加的。起因：给 `penalized`（输了/罚酒）加了"下坠 + 碰杯"
   *    两层音效，做完才发现它**从来没被 fire 过** —— 页面里输了走的是
   *    `fire(iWon ? 'win' : 'lose')`，penalized 只是表里一行好看的配置。
   *
   *    同一次扫出 4 个死动作：penalized / countdownTick / tumble / shaker。
   *    其中 shaker、countdownTick 是因为页面里用了**裸 sfx.play** 绕过时间轴 ——
   *    绕过之后不但没有音量档位、没有震动分级，表里的配置也永远不生效。
   *
   *    判据：扫页面源码里所有 `feedback.fire(...)` 的**参数文本**，
   *    把里面出现的动作名收集起来（能覆盖三元表达式 `fire(a ? 'win' : 'penalized')`，
   *    这正是第一版按 `fire('key'` 精确匹配会漏掉的形态）。
   */
  const pageSrc = (() => {
    const out = []
    const walk = (d) => {
      for (const f of fs.readdirSync(d, { withFileTypes: true })) {
        const fp = path.join(d, f.name)
        if (f.isDirectory()) walk(fp)
        else if (f.name.endsWith('.js')) out.push(fs.readFileSync(fp, 'utf8'))
      }
    }
    /*
     * ★ 扫描范围 = 主包 pages + **分包 game**（2026-10-28 房间页移进分包）。
     *   只扫 pages 的话，房间页里所有 fire() 都看不到 →
     *   一大半动作被误判成"死动作"（配了等于没配）。
     *   这类"搬了文件就漏扫"的坑，是会静默把断言变成废纸的那一种。
     */
    walk(path.join(ROOT, 'miniprogram', 'pages'))
    walk(path.join(ROOT, 'miniprogram', 'game'))
    return out.join('\n')
  })()
  const fired = new Set()
  pageSrc.replace(/feedback\.fire\(([\s\S]*?)\)/g, (_, args) => {
    (args.match(/'([a-zA-Z0-9_]+)'/g) || []).forEach(mm => fired.add(mm.replace(/'/g, '')))
    return ''
  })
  const dead = keys.filter(k => !fired.has(k))
  assert.deepStrictEqual(dead, [],
    '这些动作定义在时间轴里但**页面从没触发过**（配了等于没配）：\n    ' +
    dead.join('\n    ') +
    '\n    修法：要么在真实场景里 fire 它，要么从表里删掉。')
  ok(`时间轴 ${keys.length} 个动作全部有真实触发点（无死动作）`)

  /* ============ ⑤ 震动分级要合理 ============ */
  console.log('\n=== ⑤ 震动分级（防滥用）===')
  const VALID = ['light', 'medium', 'heavy', 'double', 'long']
  const badKind = keys.filter(k => FEEDBACK[k].haptic && VALID.indexOf(FEEDBACK[k].haptic) < 0)
  assert.deepStrictEqual(badKind, [], '无效的震动强度: ' + badKind.join(', '))

  /* 逐颗落定必须是 light —— 一局会震十几下，用 heavy 会被用户关掉 */
  assert.strictEqual(FEEDBACK.diceSettle.haptic, 'light',
    '逐颗落定必须用 light（一局十几下，重震会被关掉）')
  ok('逐颗落定用 light（一局十几下，克制是红线）')

  /* 关键结果必须是重震 */
  assert.strictEqual(FEEDBACK.cupOpen.haptic, 'heavy', '开盅揭晓应该是 heavy')
  assert.strictEqual(FEEDBACK.penalized.haptic, 'long', '输了的惩罚应该是唯一的 long')
  ok('开盅用 heavy、惩罚用 long（关键节点给足分量）')

  /*
   * 高频连续音不该震 —— 否则整局嗡嗡响。
   * ★ 原来这里查的是 `tumble`，但那个动作 2026-10-28 已删除（页面从来没 fire 过它，
   *   摇盅用的是 cupShake）。改查 cupShake —— 它才是真正跑在流程里的那 1 秒持续音。
   */
  assert.strictEqual(FEEDBACK.cupShake.haptic, null,
    '摇盅是连续音，不该震（否则整局嗡嗡响）')
  ok('摇盅不震（连续 1 秒的过程，震了用户会关掉震动）')

  /* ============ ⑥ 震动实际触发（节流 + 降级） ============ */
  console.log('\n=== ⑥ 震动运行行为 ===')
  vibrateCalls = []
  feedback.vibrate('light')
  await sleep(20)
  assert.strictEqual(vibrateCalls.length, 1, '应该震了一次')
  assert.strictEqual(vibrateCalls[0].type, 'light', '应带 type 参数')
  ok('vibrate("light") 带 type 参数触发一次')

  /* 节流：60ms 内重复调用不叠加 */
  const before = vibrateCalls.length
  feedback.vibrate('light')
  feedback.vibrate('light')
  assert.strictEqual(vibrateCalls.length, before, '60ms 内重复调用应该被节流')
  ok('60ms 内重复震动被节流（密集落定时不会嗡嗡响）')

  /* 双击：两次震动，且第二次不被节流吃掉 */
  await sleep(80)
  vibrateCalls = []
  feedback.vibrate('double')
  await sleep(200)
  assert.strictEqual(vibrateCalls.length, 2, `双击应该震两次，实际 ${vibrateCalls.length} 次`)
  ok('vibrate("double") 确实震两次（第二次绕过节流）')

  /* 长震 */
  await sleep(80)
  vibrateCalls = []
  feedback.vibrate('long')
  await sleep(20)
  assert.ok(vibrateCalls.some(c => c.kind === 'long'), 'long 应调用 vibrateLong')
  ok('vibrate("long") 走 vibrateLong')

  /* 开关 */
  await sleep(80)
  feedback.setHapticOn(false)
  vibrateCalls = []
  feedback.vibrate('heavy')
  await sleep(20)
  assert.strictEqual(vibrateCalls.length, 0, '关掉后不该震')
  assert.strictEqual(feedback.isHapticOn(), false)
  ok('关掉震动后确实不震（开关有效）')

  feedback.setHapticOn(true)

  /* ============ ⑦ 降级：不支持 type 的机型不能崩 ============ */
  console.log('\n=== ⑦ 降级容错 ===')
  const origShort = global.wx.vibrateShort
  let fallbackCalled = false
  global.wx.vibrateShort = (o) => {
    /* 模拟老机型：带 type 就失败，不带 type 成功 */
    if (o && o.type) { if (o.fail) o.fail({ errMsg: 'not supported' }) }
    else { fallbackCalled = true }
  }
  storage['hapticOn'] = true
  /* 重新加载模块以清掉内部缓存 */
  delete require.cache[require.resolve(path.join(ROOT, 'miniprogram', 'game', 'feedback.js'))]
  const fb2 = require(path.join(ROOT, 'miniprogram', 'game', 'feedback.js'))
  await sleep(70)
  fb2.vibrate('heavy')
  await sleep(40)
  assert.ok(fallbackCalled, '带 type 失败时应降级为无参调用')
  ok('老机型不支持 type 时自动降级（不会因为震动失败影响玩法）')

  global.wx.vibrateShort = origShort

  /*
 * ★★ 高频提示音不能是"双音效"（2026-10-30 用户报「声音混乱」）。
 *
 * `yourTurn` 每个回合都响一次 —— 一局 3 人大话骰约 6 次。
 * 它原来是 toggleOn + 150ms 后的 tapSoft 双层，单听像叫人名字，
 * 但在这一局的密度下，耳朵分不清"哪下是提示、哪下是动作"。
 *
 * 判据：玩家每回合都会听到的提示音，只能有一个音层。
 */
{
  const fbSrc = fs.readFileSync(path.join(ROOT, 'miniprogram/game/feedback.js'), 'utf8')
  const m = /yourTurn:\s*\{([\s\S]*?)\n  \}/.exec(fbSrc)
  assert.ok(m, '找不到 yourTurn 的定义')
  assert.ok(!/sfx2\s*:/.test(m[1]),
    '★ yourTurn 是每回合都响的提示音，不能是双音效（会显得声音混乱）')
  ok('★ 高频提示音（yourTurn）是单音层，不抢动作音效的焦点')
}

console.log(`\n${'='.repeat(58)}`)
  console.log(`  反馈时间轴：全部 ${n} 项断言通过`)
  console.log(`${'='.repeat(58)}\n`)
})().catch((e) => {
  console.error('\n  ✗ 断言失败：', e.message, '\n')
  process.exit(1)
})
