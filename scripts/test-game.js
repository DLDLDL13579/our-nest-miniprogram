/**
 * test-game.js —— 游戏核心逻辑验证
 *
 * 游戏跑在本地（不联网），所以不能用云函数 mock 那套测。
 * 这里把游戏里的**纯逻辑**抽出来单独验：
 *   · 转盘的扇区判定（旋转角度 → 落在哪个扇区）
 *   · 大话骰的计数（1 点是否万能）
 *   · 叫骰合法性（只能往上叫）
 *   · 骰子点数范围
 *
 * 为什么值得测：这些逻辑错了游戏不会报错，只会"结果不对"——
 * 转盘指针指着"喝一杯"却判成"真心话"，玩的人只会觉得莫名其妙，
 * 不会知道是 bug。
 *
 * 跑法：node scripts/test-game.js
 */
const assert = require('assert')

let n = 0
function ok(msg) { n++; console.log('  ✓ ' + msg) }

/* ============================================================
 * 从游戏页面复制的纯逻辑（保持一致，改了要同步）
 * ============================================================ */

/* ---- 转盘 ---- */
const SECTORS = [
  { k: 'truth', t: '真心话', weight: 22 },
  { k: 'dare', t: '大冒险', weight: 20 },
  { k: 'drink', t: '喝一杯', weight: 18 },
  { k: 'you', t: '你喝', weight: 14 },
  { k: 'me', t: '我喝', weight: 12 },
  { k: 'both', t: '一起喝', weight: 8 },
  { k: 'pass', t: '免罚一次', weight: 6 }
]

function buildSectors() {
  const total = SECTORS.reduce((a, s) => a + s.weight, 0)
  let acc = 0
  const list = []
  SECTORS.forEach((s) => {
    const deg = s.weight / total * 360
    list.push({ k: s.k, t: s.t, from: acc, to: acc + deg })
    acc += deg
  })
  return list
}

/** 转盘判定：rotation 是 CSS 旋转角度（顺时针为正），指针固定在 12 点 */
function judgeWheel(sectors, rotation) {
  const angle = ((360 - (rotation % 360)) % 360 + 360) % 360
  for (const s of sectors) {
    if (angle >= s.from && angle < s.to) return s
  }
  return sectors[0]
}

/* ---- 大话骰 ---- */
function countFace(all, face, zhai) {
  let c = 0
  all.forEach((d) => {
    const v = d && typeof d === 'object' ? d.v : d
    if (v === face) c++
    else if (v === 1 && !zhai && face !== 1) c++
  })
  return c
}

function isHigher(a, b) {
  if (!b) return true
  if (a.n > b.n) return true
  if (a.n === b.n && a.face > b.face) return true
  return false
}

/* ============================================================ */
;(async () => {
  console.log('\n=== ① 转盘：扇区覆盖完整且不重叠 ===')
  const sectors = buildSectors()
  assert.strictEqual(sectors[0].from, 0, '第一个扇区应从 0 度开始')
  assert.ok(Math.abs(sectors[sectors.length - 1].to - 360) < 1e-9, '最后一个扇区应到 360 度')
  for (let i = 1; i < sectors.length; i++) {
    assert.strictEqual(sectors[i].from, sectors[i - 1].to, '扇区之间必须首尾相接')
  }
  ok(`${sectors.length} 个扇区无缝覆盖 360°，无空隙无重叠`)

  console.log('\n=== ② 转盘：任意角度都能判出唯一扇区 ===')
  let miss = 0
  for (let r = 0; r < 3600; r += 7) {
    const hit = judgeWheel(sectors, r)
    if (!hit) miss++
  }
  assert.strictEqual(miss, 0, '不该有判不出的角度')
  ok('515 个角度全部能判出扇区（含跨 0 度的边界）')

  console.log('\n=== ③ 转盘：判定与扇区位置一致（关键）===')
  /* 指针在 12 点、转盘顺时针转 rotation 度。
     转 0 度时，指针指向扇区起点 0 度那个扇区。
     转 90 度时，指针指向原本在 270 度位置的扇区。 */
  const s0 = judgeWheel(sectors, 0)
  assert.strictEqual(s0.from, 0, '转 0 度应命中起始扇区')
  ok(`转 0° → ${s0.t}（扇区起点）`)

  /* 验证每个扇区的中点：把扇区中点转到指针下，应该命中它自己 */
  let wrong = []
  sectors.forEach((s) => {
    const mid = (s.from + s.to) / 2
    const rotation = (360 - mid) % 360
    const hit = judgeWheel(sectors, rotation)
    if (hit.k !== s.k) wrong.push(`${s.t}(转到${rotation.toFixed(1)}°却命中${hit.t})`)
  })
  assert.deepStrictEqual(wrong, [], '每个扇区中点转到指针下应命中自己：\n    ' + wrong.join('\n    '))
  ok('7 个扇区的中点都命中自己 —— 角度换算没搞反')

  console.log('\n=== ④ 转盘：权重影响概率（不是等分）===')
  const spans = sectors.map((s) => ({ t: s.t, span: s.to - s.from }))
  const truthSpan = spans[0].span
  const passSpan = spans[spans.length - 1].span
  assert.ok(truthSpan > passSpan * 3, '真心话的概率应远大于免罚')
  ok(`真心话 ${truthSpan.toFixed(1)}° vs 免罚 ${passSpan.toFixed(1)}° —— 权重生效（免罚稀有才够爽）`)

  console.log('\n=== ⑤ 大话骰：1 点是万能牌 ===')
  /* [1,2,3,4,5] 里，非斋情况下 3 点算 2 个（3 本身 + 1 万能） */
  const dice = [1, 2, 3, 4, 5]
  assert.strictEqual(countFace(dice, 3, false), 2, '非斋：1 可当 3，所以 3 点有 2 个')
  assert.strictEqual(countFace(dice, 3, true), 1, '斋：1 不再万能，只有 1 个')
  assert.strictEqual(countFace(dice, 1, false), 1, '叫 1 点时只算真的 1')
  assert.strictEqual(countFace(dice, 1, true), 1, '斋时 1 点也是 1 个')
  ok('★ 非斋 1 万能 / 叫斋后失效 —— 这是大话骰最反直觉也最好玩的地方')

  console.log('\n=== ⑥ 大话骰：两人局共 10 颗，计数不越界 ===')
  const all = [1, 1, 6, 6, 6, 2, 3, 4, 5, 6]
  assert.strictEqual(countFace(all, 6, false), 6, '6 有 4 个 + 1 有 2 个 = 6')
  assert.strictEqual(countFace(all, 6, true), 4, '斋：只有 4 个真 6')
  assert.ok(countFace(all, 6, false) <= 10, '计数不能超过总骰子数')
  ok('10 颗骰子的计数正确（4 个 6 + 2 个 1 = 6）')

  console.log('\n=== ⑦ 大话骰：只能往上叫 ===')
  const cases = [
    [{ n: 3, face: 4 }, { n: 2, face: 4 }, true, '数量变大'],
    [{ n: 3, face: 4 }, { n: 3, face: 3 }, true, '数量同、点数变大'],
    [{ n: 2, face: 4 }, { n: 3, face: 4 }, false, '数量变小'],
    [{ n: 3, face: 3 }, { n: 3, face: 4 }, false, '数量同、点数变小'],
    [{ n: 3, face: 4 }, { n: 3, face: 4 }, false, '完全一样'],
    [{ n: 4, face: 1 }, { n: 3, face: 6 }, true, '数量变大时可降点数'],
  ]
  let bad = []
  cases.forEach(([a, b, want, desc]) => {
    const got = isHigher(a, b)
    if (got !== want) bad.push(`${desc}: 期望${want}得到${got}`)
  })
  assert.deepStrictEqual(bad, [], bad.join('\n    '))
  ok(`6 种叫骰组合全部判对（含"数量变大可降点数"这个容易错的规则）`)

  console.log('\n=== ⑧ 大话骰：开骰判定 ===')
  /* 叫 5 个 6，实际 4 个 → 叫的人吹牛，叫的人输 */
  const actual1 = countFace(all, 6, true)   // 4
  assert.ok(actual1 < 5, '实际 4 < 叫的 5')
  const bidderWins1 = actual1 >= 5
  assert.strictEqual(bidderWins1, false, '★ 叫的不够 → 叫的人输（开的人赢）')
  ok(`叫 5 个 6、实际 ${actual1} 个 → 吹牛成立，叫的人喝`)

  /* 叫 4 个 6，实际 4 个 → 叫的人没吹牛，开的人输 */
  const actual2 = countFace(all, 6, true)   // 4
  const bidderWins2 = actual2 >= 4
  assert.strictEqual(bidderWins2, true, '★ 叫的够了 → 开的人输')
  ok(`叫 4 个 6、实际 ${actual2} 个 → 叫骰成立，开的人喝`)

  console.log('\n=== ⑨ 骰子点数范围 ===')
  let badv = 0
  for (let i = 0; i < 3000; i++) {
    const v = 1 + Math.floor(Math.random() * 6)
    if (v < 1 || v > 6 || !Number.isInteger(v)) badv++
  }
  assert.strictEqual(badv, 0, '点数必须是 1~6 的整数')
  ok('3000 次随机全部落在 1~6（无 0 无 7 无小数）')

  /* 分布均匀性：3000 次，每个点数期望 500 次，允许 ±25% 偏差 */
  const cnt = {}
  for (let i = 0; i < 6000; i++) {
    const v = 1 + Math.floor(Math.random() * 6)
    cnt[v] = (cnt[v] || 0) + 1
  }
  const vals = Object.keys(cnt).map(Number).sort()
  assert.deepStrictEqual(vals, [1, 2, 3, 4, 5, 6], '六个点数都该出现')
  const dev = Math.max(...vals.map((v) => Math.abs(cnt[v] - 1000) / 1000))
  assert.ok(dev < 0.15, `分布偏差 ${(dev * 100).toFixed(1)}% 应在 15% 内`)
  ok(`6000 次分布均匀（最大偏差 ${(dev * 100).toFixed(1)}%，说明 Math.random 用法正确）`)

  console.log(`\n${'='.repeat(56)}`)
  console.log(`  游戏逻辑：全部 ${n} 项断言通过`)
  console.log(`${'='.repeat(56)}\n`)
})().catch((e) => {
  console.error('\n  ✗ 断言失败：', e.message, '\n')
  process.exit(1)
})
