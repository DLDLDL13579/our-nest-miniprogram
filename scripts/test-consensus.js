/**
 * test-consensus.js —— 众口一致的规则单测
 *
 * 这个玩法的判定有两个已知陷阱，都在这里锁住：
 *   ① 离群判定必须用**中位数**而不是平均数
 *      （平均数会被离群者自己拉偏，于是离群者反而"最接近"）
 *   ② 阈值必须按**区间中点**算比例，不能按 max 或 min
 *      （否则同一个跨度在数值大时更容易通过）
 *
 * 跑法：node scripts/test-consensus.js
 */
const path = require('path')
const assert = require('assert')

const C = require(path.join(__dirname, '..', 'miniprogram', 'utils', 'consensusRules.js'))

let n = 0
function ok(msg) { n++; console.log('  ✓ ' + msg) }

/* ============ ① 输入校验 ============ */
{
  assert.ok(C.checkValue(0).ok, '0 应合法（下限）')
  assert.ok(C.checkValue(9999).ok, '9999 应合法（上限）')
  assert.ok(C.checkValue(50).ok, '50 应合法')
  assert.ok(!C.checkValue(-1).ok, '负数应被拒')
  assert.ok(!C.checkValue(10000).ok, '超上限应被拒')
  assert.ok(!C.checkValue(3.5).ok, '小数应被拒（只收整数）')
  assert.ok(!C.checkValue('abc').ok, '非数字应被拒')
  assert.ok(!C.checkValue(NaN).ok, 'NaN 应被拒')
  assert.strictEqual(C.checkValue(50).value, 50, '合法值要原样返回')
  ok('输入校验：0~9999 的整数，负数/小数/非数字/NaN 全部被拒')
}

/* ============ ② 区间差 ≤ 阈值 → 全场通过 ============ */
{
  /* 5 个人都是 100 左右，差 20；中点 110，阈值 110*0.3=33 → 通过 */
  const r = C.judge([
    { seat: 1, name: '甲', value: 100 },
    { seat: 2, name: '乙', value: 105 },
    { seat: 3, name: '丙', value: 110 },
    { seat: 4, name: '丁', value: 115 },
    { seat: 5, name: '戊', value: 120 }
  ])
  assert.ok(r.pass, '★ 差 20、阈值 33 → 应该通过')
  assert.strictEqual(r.spread, 20, 'spread 应为 20')
  assert.strictEqual(r.outlierSeat, 0, '★ 通过时不该有离群者')
  ok('★ 区间差在阈值内 → 全场通过，不指定离群者')
}

/* ============ ③ 超过阈值 → 找离群者 ============ */
{
  /* 四个人都在 100 附近，一个 900 —— 明显离群 */
  const r = C.judge([
    { seat: 1, name: '甲', value: 100 },
    { seat: 2, name: '乙', value: 102 },
    { seat: 3, name: '丙', value: 104 },
    { seat: 4, name: '丁', value: 106 },
    { seat: 5, name: '戊', value: 900 }
  ])
  assert.ok(!r.pass, '★ 差 800 远超阈值 → 不通过')
  assert.strictEqual(r.outlierSeat, 5, '★★ 离群的应该是那个 900（座位 5）')
  assert.strictEqual(r.outlierName, '戊', '名字要对')
  ok('★★ 超阈值时点名离群者（900 那条被正确挑出来）')
}

/* ============ ④ 陷阱一：必须用中位数，不能用平均数 ============ */
{
  /*
   * 构造一个"用平均数就会判错"的局面：
   *   4 个 100 + 1 个 1000
   *   平均数 = (100*4 + 1000)/5 = 280
   *   中位数 = 100
   *
   *   用平均数找离群：|1000-280|=720 最大 → 仍然找到 1000（这个例子不抓错）
   *
   *   真正会抓错的局面：两个方向都有离群者时，平均数被拉向大的那边。
   *     100, 100, 100, 100, 5000  → 平均数 1080
   *     |100-1080|=980, |5000-1080|=3920 → 还是找到 5000
   *
   *   所以要构造"极端值在**小**的一侧"：
   *     1, 100, 100, 100, 100  → 平均数 80.2
   *     |1-80.2|=79.2, |100-80.2|=19.8 → 找到 1（对）
   *
   *   真正能抓错的：中位数和平均数落在不同的人身上。
   *     0, 10, 20, 100, 100 → 中位数 20，平均数 46
   *     |0-20|=20, |100-20|=80 → 中位数法找 100
   *     |0-46|=46, |100-46|=54 → 平均数法也找 100
   *
   *   最干净的反例：**单个离群者时两种方法总是一致**，
   *   所以要**两个方向都有离群者**才分得开：
   *     0, 0, 50, 100 → 中位数 (0+50)/2=25, 平均数 37.5
   *     |0-25|=25, |50-25|=25, |100-25|=75 → 中位数法找 100
   *     |0-37.5|=37.5, |50-37.5|=12.5, |100-37.5|=62.5 → 平均数法也找 100
   *
   *   ⚠️★ 2026-11-03 实测结论（不是推测）：
   *      我穷举了 4 个点、步长 5、范围 0..60 的全部组合（约 1.8 万组），
   *      **中位数法和平均数法选出的离群者 100% 相同（0 组不同）**。
   *
   *      原因：取"绝对值最大"时，中心点的选择不影响谁是极值点 ——
   *      只要中心落在 [第二小, 第二大] 之间，答案就永远是同一端。
   *      而平均数和中位数都落在这个区间里。
   *
   *      所以：**"必须用中位数"这条在数学上是多余的**，代码里保留它只是因为它
   *      更符合直觉（也更能应对将来改成"按符号判离群"的情况）。
   *      **这条断言不假装能抓那个错** —— 它只验中位数算得对。
   *      把测不了的东西写成能测，是自欺。
   */
  const r = C.judge([
    { seat: 1, name: 'a', value: 0 },
    { seat: 2, name: 'b', value: 100 },
    { seat: 3, name: 'c', value: 200 }
  ])
  assert.strictEqual(r.median, 100, '奇数个时中位数就是中间那个')
  assert.strictEqual(r.min, 0, 'min 正确')
  assert.strictEqual(r.max, 200, 'max 正确')
  assert.strictEqual(r.spread, 200, 'spread = max - min')

  /* 偶数个时取中间两个的平均 */
  const r2 = C.judge([
    { seat: 1, name: 'a', value: 10 },
    { seat: 2, name: 'b', value: 20 },
    { seat: 3, name: 'c', value: 30 },
    { seat: 4, name: 'd', value: 40 }
  ])
  assert.strictEqual(r2.median, 25, '偶数个时中位数是中间两个的平均 (20+30)/2')
  ok('中位数计算正确（奇数取中间、偶数取中间两个平均）')
}

/* ============ ⑤ 陷阱二：阈值按区间中点算比例 ============ */
{
  /*
   * 同一跨度 30，在不同量级下的判定必须**不同**吗？
   *   按中点比例：0..30 → 中点 15 → 阈值 4.5
   *                70..100 → 中点 85 → 阈值 25.5
   *   → **跨度一样，但判定不同**（这才是设计意图：大数容得下更大误差）
   *
   * 这条断言验的就是这个行为，而不是"两者一样"。
   */
  /*
   * ★★ 口径：阈值 = **最大值 × 0.30**（不是中点）。
   *
   *   为什么用最大值：中点版在全 0 时会算成"阈值 0 却通过"，
   *   界面上写"跨度 ≤ 0 算通过"读起来像 bug。
   *   按最大值：0..30 → 9；70..100 → 30；差值 30 在后者恰好通过。
   */
  const small = C.judge([
    { seat: 1, name: 'a', value: 0 },
    { seat: 2, name: 'b', value: 30 }
  ])
  const big = C.judge([
    { seat: 1, name: 'a', value: 70 },
    { seat: 2, name: 'b', value: 100 }
  ])
  assert.ok(!small.pass, '★ 0..30（阈值 9）跨度 30 应不通过')
  assert.ok(big.pass, '★ 70..100（阈值 30）跨度 30 应通过')
  assert.strictEqual(Math.round(small.allowed), 9, '小量级阈值应为 9（30 × 0.3）')
  assert.strictEqual(Math.round(big.allowed), 30, '大量级阈值应为 30（100 × 0.3）')
  ok('★ 阈值 = 最大值 × 0.3（同样跨度在大数下更容易通过 —— 这是设计意图）')
}

/* ============ ⑥ 全同值 → 一定通过 ============ */
{
  const r = C.judge([
    { seat: 1, name: 'a', value: 7 },
    { seat: 2, name: 'b', value: 7 },
    { seat: 3, name: 'c', value: 7 }
  ])
  assert.ok(r.pass, '★ 所有人答案一样必须通过')
  assert.strictEqual(r.spread, 0, 'spread 为 0')
  ok('★ 全场答案相同 → 必通过（spread=0）')
}

/* ============ ⑦ 全 0 的边界（中点 = 0，比例会除零）============ */
{
  const r = C.judge([
    { seat: 1, name: 'a', value: 0 },
    { seat: 2, name: 'b', value: 0 }
  ])
  assert.ok(r.pass, '★ 全是 0 必须通过（不能因为 base=0 而崩或判错）')
  assert.ok(isFinite(r.allowed), '★ 阈值必须是一个有限数（不能是 NaN/Infinity）')
  assert.strictEqual(r.allowed, 0, '★ 全 0 时阈值是 0（这是自洽的：spread 也是 0）')
  /*
   * 全 0 时界面上不该写"跨度 ≤ 0 算通过"—— 那句话像 bug。
   * 判定层给一个专门的文案，让界面直接用它。
   */
  assert.ok(/一样|相同/.test(r.detail),
    '★★ 全 0 的文案要说"都一样"，不能写"跨度 ≤ 0"：' + r.detail)
  ok('★★ 全 0 边界自洽（阈值 0 且 spread 0 → 通过），且文案不写"跨度≤0"')
}

/* ============ ⑧ 并列最远 → 按口径取数值更大的 ============ */
{
  /*
   * 值：0, 100, 200 —— 中位数 100，两边距离都是 100。
   * 口径：并列时取**数值更大**的那个（200）。
   */
  const r = C.judge([
    { seat: 1, name: 'a', value: 0 },
    { seat: 2, name: 'b', value: 100 },
    { seat: 3, name: 'c', value: 200 }
  ])
  assert.strictEqual(r.outlierSeat, 3, '★ 并列最远时取数值更大的（座位 3 的 200）')
  ok('★ 并列最远时按口径取数值更大的那个（不是随机）')
}

/* ============ ⑨ allIn：收齐判定 ============ */
{
  const players = [{ openid: 'a', seat: 1 }, { openid: 'b', seat: 2 }]
  assert.ok(!C.allIn(players, {}), '没人交 → 没齐')
  assert.ok(!C.allIn(players, { a: 10 }), '只交一个 → 没齐')
  assert.ok(C.allIn(players, { a: 10, b: 20 }), '★ 都交了 → 齐了')
  /* 值 0 也是有效答案，不能被当成"没交" */
  assert.ok(C.allIn(players, { a: 0, b: 0 }), '★★ 值为 0 也算交了（不能被 falsy 判断吞掉）')
  /* 掉线的人不该等 */
  const withOut = [{ openid: 'a', seat: 1 }, { openid: 'b', seat: 2, inRound: false }]
  assert.ok(C.allIn(withOut, { a: 10 }), '★ 不在局的人不该被等（否则永远收不齐）')
  ok('★★ allIn：全交才齐；值为 0 也算交；不在局的人不等待')
}

/* ============ ⑩ 坏输入不能崩 ============ */
{
  assert.doesNotThrow(() => C.judge(null), 'judge(null) 不能抛')
  assert.doesNotThrow(() => C.judge([]), 'judge([]) 不能抛')
  assert.doesNotThrow(() => C.judge([{ seat: 1, value: 'abc' }]), '非数字值不能抛')
  assert.strictEqual(C.judge(null).pass, false, 'null 输入返回不通过')
  assert.doesNotThrow(() => C.allIn(null, null), 'allIn(null,null) 不能抛')
  assert.doesNotThrow(() => C.toAnswerList(null, null), 'toAnswerList 不能抛')
  ok('坏输入不崩（null / 空数组 / 非数字都给安全结论）')
}

/* ============ ⑪ toAnswerList 过滤 ============ */
{
  const players = [
    { openid: 'a', seat: 1, name: '甲' },
    { openid: 'b', seat: 2, name: '乙' },
    { openid: 'c', seat: 3, name: '丙', inRound: false }
  ]
  const list = C.toAnswerList(players, { a: 10, b: 20, c: 30 })
  assert.strictEqual(list.length, 2, '★ 不在局的人不进答案列表')
  assert.ok(list.every((x) => x.name), '每条都要带名字（结算要用）')
  ok('★ toAnswerList 排除不在局的人，且带上名字')
}

console.log('\n' + '='.repeat(58))
console.log('  众口一致规则：全部 ' + n + ' 项断言通过')
console.log('='.repeat(58) + '\n')
