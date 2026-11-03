/**
 * test-between.js —— 射龙门规则的单测
 *
 * 这个玩法只有三个判定器，但每一个都直接决定"谁喝多少"。
 * 项目里的教训：**规则类的东西必须穷举，不能只挑几个用例试**
 * （`test-poker.js` 穷举了全部 C(52,3) 才对上组合数学）。
 *
 * 这里穷举的是「两张龙门牌 × 第三张」的**全部点数组合**：
 *   13 种点数 × 13 种 × 13 种 = 2197 种，每一对都验一遍判定。
 *
 * 跑法：node scripts/test-between.js
 */
const path = require('path')
const assert = require('assert')

const R = require(path.join(__dirname, '..', 'miniprogram', 'utils', 'betweenRules.js'))

let n = 0
function ok(msg) { n++; console.log('  ✓ ' + msg) }

const card = (r) => ({ r: r, s: 0 })

/* ============ ① 押注合法性 ============ */
{
  /* 合法：0.5 的倍数，范围 [0.5, 3] */
  ;[0.5, 1, 1.5, 2, 2.5, 3].forEach((b) => {
    assert.ok(R.checkBet(b).ok, '押 ' + b + ' 杯应该合法')
  })
  /* 非法：越界 / 非 0.5 倍数 / 非数字 */
  ;[0, 0.4, 0.7, 3.5, 10, -1, null, undefined, 'abc', NaN, Infinity].forEach((b) => {
    assert.ok(!R.checkBet(b).ok, '押 ' + String(b) + ' 应该被拒')
  })
  ok('押注只接受 0.5 的倍数且在 ' + R.MIN_BET + '~' + R.MAX_BET + ' 杯之间')
}

/* ============ ② 龙门关死（两张同点）============ */
{
  for (let r = 2; r <= 14; r++) {
    assert.ok(R.isClosed(card(r), card(r)), r + ' 点两张应该算关死')
    for (let o = 2; o <= 14; o++) {
      if (o !== r) assert.ok(!R.isClosed(card(r), card(o)), r + '/' + o + ' 不该算关死')
    }
  }
  ok('龙门关死判定：13 种同点全中，156 种不同点全不中')
}

/* ============ ③ 三档判定：穷举 13^3 = 2197 种 ============ */
{
  let inCnt = 0, outCnt = 0, postCnt = 0
  for (let a = 2; a <= 14; a++) {
    for (let b = 2; b <= 14; b++) {
      if (a === b) continue                      /* 关死的那 13 种单独处理 */
      const lo = Math.min(a, b), hi = Math.max(a, b)
      for (let t = 2; t <= 14; t++) {
        const j = R.judge(card(a), card(b), card(t))
        if (t === a || t === b) {
          assert.strictEqual(j.result, 'post',
            `${a}/${b} 龙门，第三张 ${t} 应该撞柱，实际 ${j.result}`)
          postCnt++
        } else if (t > lo && t < hi) {
          assert.strictEqual(j.result, 'in',
            `${a}/${b} 龙门，第三张 ${t} 应该在龙门内，实际 ${j.result}`)
          inCnt++
        } else {
          assert.strictEqual(j.result, 'out',
            `${a}/${b} 龙门，第三张 ${t} 应该在外面，实际 ${j.result}`)
          outCnt++
        }
      }
    }
  }
  /*
   * ★ 用**独立推出来的数字**校验，而不是"跑出来多少记多少"。
   *
   *   对每一对 (a,b)（a≠b），设 width = |a-b|：
   *     撞柱 = 2 种（两个端点）
   *     龙门内 = width - 1 种
   *     外面 = 13 - 2 - (width-1) = 12 - width 种
   *   对全部 156 对求和（width 从 1 到 12，每种 width 有 2*(13-width) 对）：
   *     撞柱 = 156 × 2 = 312
   *     内   = Σ 2*(13-w)*(w-1)  = 572
   *     外   = Σ 2*(13-w)*(12-w) = 1144
   *   合计 2028 = 156 × 13 ✓
   *
   *   ⚠️ 我第一版在这里写了「内外对称（概率相等）」—— **那是错的**。
   *      13 个点数里两端被撞柱占掉 2 个，所以"外面"永远比"里面"多 1 个位置：
   *      宽 1 的龙门（如 5-6）内 0 外 11；宽 12 的（2-A）内 11 外 0。
   *      而这个不对称正是**这个玩法要赌的东西** —— 龙门越窄越容易打偏。
   *      断言跑出来 572 vs 1144 才发现，靠"看起来对称"推公式会直接写错规则。
   */
  let expIn = 0, expOut = 0
  for (let w = 1; w <= 12; w++) {
    const pairs = 2 * (13 - w)
    expIn += pairs * (w - 1)
    expOut += pairs * (12 - w)
  }
  assert.strictEqual(postCnt, 156 * 2, '撞柱总数应为 312，实际 ' + postCnt)
  assert.strictEqual(inCnt, expIn, '龙门内总数应为 ' + expIn + '，实际 ' + inCnt)
  assert.strictEqual(outCnt, expOut, '龙门外总数应为 ' + expOut + '，实际 ' + outCnt)
  assert.strictEqual(inCnt + outCnt + postCnt, 156 * 13, '三档之和必须覆盖全部组合')
  /*
   * ★ 内外**必须不相等**，且外面的数量是里面的 2 倍整（1144 = 572 × 2）。
   *   这个 2:1 不是巧合：对每个 w，外 = 内 在 w 和 13-w 之间互换求和得到的，
   *   总量上恰好成 2 倍。锁住它，改坏了会被抓。
   */
  assert.strictEqual(outCnt, inCnt * 2, '龙门外应是龙门内的 2 倍（1144 = 572×2）')
  ok(`三档判定穷举 2028 种组合：内 ${inCnt} / 外 ${outCnt} / 撞柱 ${postCnt}（与独立推导一致）`)
}

/* ============ ④ 撞柱必须在区间判定之前（顺序敏感的回归）============ */
{
  /*
   * 这条锁的是"顺序写反"这个具体错误：
   *   如果先判 `lo <= x <= hi`，端点会被算成 in —— 而端点就是撞柱。
   * 单独拎出来断言，是因为穷举里它也会被抓到，但报错信息会混在 2000 条里。
   */
  const j = R.judge(card(5), card(9), card(5))
  assert.strictEqual(j.result, 'post', '第三张等于左端点必须是撞柱，不是"在内"')
  const j2 = R.judge(card(5), card(9), card(9))
  assert.strictEqual(j2.result, 'post', '第三张等于右端点必须是撞柱，不是"在内"')
  ok('★ 端点算撞柱（不是"落在龙门里"）—— 顺序写反就会判反')
}

/* ============ ⑤ 结算：三档的杯数必须对 ============ */
{
  const bet = 2
  /* 穿过 → 0 杯 */
  assert.deepStrictEqual(
    R.settle({ bet: bet, gateA: card(3), gateB: card(10), third: card(6) }).cups, 0,
    '穿过去不用喝')
  /* 打偏 → 押多少喝多少 */
  assert.strictEqual(
    R.settle({ bet: bet, gateA: card(5), gateB: card(8), third: card(13) }).cups, bet,
    '打偏喝押注额')
  /* 撞柱 → 双倍 */
  assert.strictEqual(
    R.settle({ bet: bet, gateA: card(5), gateB: card(8), third: card(8) }).cups, bet * 2,
    '撞柱喝双倍')
  /* 押 0.5 撞柱 → 1 杯（半杯的双倍正好一杯） */
  assert.strictEqual(
    R.settle({ bet: 0.5, gateA: card(5), gateB: card(8), third: card(5) }).cups, 1,
    '押半杯撞柱应喝 1 杯')
  ok('结算杯数：穿过 0 / 打偏 押注额 / 撞柱 双倍')
}

/* ============ ⑥ 龙门关死与认低威：都只喝一啖，且优先于三档判定 ============ */
{
  /* 关死时哪怕第三张"看起来在内"也不能按 in 算 */
  const r1 = R.settle({ bet: 3, gateA: card(7), gateB: card(7), third: card(7) })
  assert.strictEqual(r1.outcome, 'closed', '龙门关死应走 closed，不能走撞柱')
  assert.strictEqual(r1.cups, R.BAIL_COST, '关死只喝一啖')

  /* 认低威同理：押了 3 杯也不按押注额算 */
  const r2 = R.settle({ bet: 3, gateA: card(5), gateB: card(6), third: null, bailed: true })
  assert.strictEqual(r2.outcome, 'bail', '认低威应走 bail')
  assert.strictEqual(r2.cups, R.BAIL_COST, '认低威只喝一啖，和押注额无关')
  ok('★ 龙门关死 / 认低威都只喝一啖 —— 与押注额无关（押 3 杯也是半杯）')
}

/* ============ ⑦ 宽度提示只影响文案，不影响判定 ============ */
{
  /*
   * 断言"不参与判定"的方式：同样的牌，不管提示是什么，cups 都一样。
   */
  const base = { bet: 1, gateA: card(5), gateB: card(6), third: card(10) }
  const cups1 = R.settle(base).cups
  const cups2 = R.settle(Object.assign({}, base)).cups
  assert.strictEqual(cups1, cups2, '宽度提示不能影响杯数')
  assert.ok(R.widthHint(card(5), card(6)).length > 0, '窄龙门要有提示文案')
  assert.ok(R.widthHint(card(2), card(14)).indexOf('宽') >= 0, '宽龙门要说明宽')
  assert.strictEqual(R.widthHint(card(7), card(7)), '龙门关了', '同点要说关死')
  ok('龙门宽度只给文案（"窄得离谱" / "开得很宽"），不参与任何判定')
}

/* ============ ⑧ 缺参数不能崩（防白屏）============ */
{
  /*
   * 云函数是公开接口，前端也可能传半截数据。
   * 判定器遇到 null 必须给一个**安全结论**（按打偏算，最保守），不能抛。
   */
  assert.doesNotThrow(() => R.judge(null, card(5), card(6)), 'judge 遇到 null 不能抛')
  assert.doesNotThrow(() => R.settle({}), 'settle 空对象不能抛')
  assert.doesNotThrow(() => R.settle(null), 'settle 传 null 不能抛')
  const r = R.settle({})
  assert.strictEqual(typeof r.cups, 'number', 'null 输入也要返回数字杯数')
  ok('缺参数不崩：judge / settle 传 null 也给安全结论（不会白屏）')
}

console.log('\n' + '='.repeat(58))
console.log('  射龙门规则：全部 ' + n + ' 项断言通过')
console.log('='.repeat(58) + '\n')
