/**
 * verify-1.5.2.js —— 核对云端跑的是不是刚部署的 1.5.2 代码
 *
 * 为什么必须这样验：CLI 的 deploy 返回 success 只代表「上传成功」，
 * 不代表运行时调到的就是新版本（可能没生效、可能调错环境）。
 * 唯一可信的做法是在小程序运行时里真调一次云端函数，看返回结构。
 *
 * 只查本次改动的四个点：
 *   ① home.moments[].thumbs      存在且是数组（否则列表还在加载原图）
 *   ② chronicle.list[].items[].thumbs  同上
 *   ③ chronicle.onThisDay 不再有 q 字段
 *   ④ chronicle day 的 mine/partner 是数组（不是对象）
 */
const automator = require('miniprogram-automator')
const path = require('path')

;(async () => {
  const mini = await automator.launch({
    cliPath: '/Applications/wechatwebdevtools.app/Contents/MacOS/cli',
    projectPath: path.join(__dirname, '..'),
    timeout: 90000
  })
  console.log('✓ 已连上运行时\n')

  let pass = 0, fail = 0
  const ok = m => { pass++; console.log('  ✓ ' + m) }
  const no = m => { fail++; console.log('  ✗ ' + m) }

  /* ---------- ① home ---------- */
  console.log('── ① 首页聚合 home ──')
  const home = await mini.evaluate(async () => {
    try {
      const r = (await wx.cloud.callFunction({ name: 'home', data: {} })).result
      if (!r.ok) return { ok: false, code: r.code, msg: r.msg }
      const m = (r.moments || [])[0]
      return {
        ok: true,
        total: r.total,
        count: (r.moments || []).length,
        hasThumbs: m ? ('thumbs' in m) : null,
        thumbsIsArray: m ? Array.isArray(m.thumbs) : null,
        thumbsLen: m ? (m.thumbs || []).length : null,
        photosLen: m ? (m.photos || []).length : null,
        keys: m ? Object.keys(m).join(',') : '(没有记录)'
      }
    } catch (e) { return { ok: false, err: String(e.errMsg || e.message).slice(0, 200) } }
  })
  console.log('  ', JSON.stringify(home))
  if (!home.ok) {
    no('home 调用失败：' + (home.err || home.msg))
  } else if (home.hasThumbs === null) {
    console.log('  ⚠ 云端还没有任何记录，thumbs 字段无从验证（去小程序里记一条带照片的再看）')
  } else if (home.thumbsIsArray) {
    ok(`home.moments[].thumbs 存在且是数组（len=${home.thumbsLen}, photos=${home.photosLen}）`)
    if (home.photosLen > 0 && home.thumbsLen === 0) {
      console.log('  ⚠ 这条记录有原图但缩略图为空 —— 属于老数据，前端会回退用原图（符合预期）')
    }
  } else {
    no('★ home 没有返回 thumbs —— 云端还是旧版！')
  }

  /* ---------- ② chronicle list ---------- */
  console.log('\n── ② 编年史 chronicle.list ──')
  const cl = await mini.evaluate(async () => {
    try {
      const r = (await wx.cloud.callFunction({ name: 'chronicle', data: { action: 'list', size: 10 } })).result
      if (!r.ok) return { ok: false, code: r.code, msg: r.msg }
      const it = (r.list || [])[0] && (r.list[0].items || [])[0]
      return {
        ok: true,
        days: (r.list || []).length,
        hasThumbs: it ? ('thumbs' in it) : null,
        thumbsIsArray: it ? Array.isArray(it.thumbs) : null,
        itemKeys: it ? Object.keys(it).join(',') : '(没有记录)',
        onThisDayKeys: r.onThisDay ? Object.keys(r.onThisDay).join(',') : '(无那年今日)',
        onThisDayHasQ: r.onThisDay ? ('q' in r.onThisDay) : null
      }
    } catch (e) { return { ok: false, err: String(e.errMsg || e.message).slice(0, 200) } }
  })
  console.log('  ', JSON.stringify(cl))
  if (!cl.ok) {
    no('chronicle 调用失败：' + (cl.err || cl.msg))
  } else {
    if (cl.hasThumbs === null) console.log('  ⚠ 无记录，thumbs 无从验证')
    else if (cl.thumbsIsArray) ok('chronicle.list[].items[].thumbs 存在且是数组')
    else no('★ chronicle 没有返回 thumbs —— 云端还是旧版！')

    /* ---------- ③ onThisDay 不该再有 q ---------- */
    if (cl.onThisDayHasQ === null) console.log('  ⚠ 没有「那年今日」数据，q 字段无从验证')
    else if (cl.onThisDayHasQ === false) ok('onThisDay 已不含 q 字段（幽灵字段已清）')
    else no('★ onThisDay 仍返回 q —— 云端还是旧版')
  }

  /* ---------- ④ chronicle day ---------- */
  console.log('\n── ③ 某天详情 chronicle.day ──')
  const day = await mini.evaluate(async () => {
    try {
      const r0 = (await wx.cloud.callFunction({ name: 'chronicle', data: { action: 'list', size: 1 } })).result
      const d = (r0.list || [])[0] && r0.list[0].date
      if (!d) return { ok: false, msg: '没有任何记录，无法取某天详情' }
      const r = (await wx.cloud.callFunction({ name: 'chronicle', data: { action: 'day', date: d } })).result
      return {
        ok: true, date: d,
        mineIsArray: Array.isArray(r.mine),
        partnerIsArray: Array.isArray(r.partner),
        hasQ: 'q' in r,
        keys: Object.keys(r).join(',')
      }
    } catch (e) { return { ok: false, err: String(e.errMsg || e.message).slice(0, 200) } }
  })
  console.log('  ', JSON.stringify(day))
  if (!day.ok) {
    console.log('  ⚠ ' + (day.msg || day.err))
  } else {
    if (day.mineIsArray && day.partnerIsArray) ok('day 的 mine / partner 都是数组（前端 wx:for 可用）')
    else no('★ day 的 mine/partner 不是数组 —— 云端还是旧版')
    if (day.hasQ === false) ok('day 详情已不含 q 字段')
    else no('★ day 仍返回 q')
  }

  await mini.disconnect()
  console.log(`\n${'='.repeat(52)}`)
  console.log(`  云端 1.5.2 验证：${pass} 项通过${fail ? '，' + fail + ' 项失败 ✗' : '，0 项失败 ✓'}`)
  console.log(`${'='.repeat(52)}\n`)
  process.exit(fail ? 1 : 0)
})().catch(e => { console.error('✗', e.message); process.exit(1) })
