/**
 * probe-cloud.js —— 核对「云端到底是什么版本」，不猜测。
 *
 * 做法：用 automator 进小程序运行时，直接调云端云函数。
 * 理由：CLI 只有 cloud functions deploy / list，没有 invoke，
 * 所以想知道云端跑的是不是本地这份代码，只能在运行时里调。
 *
 * 查四件事：
 *   1. 每个云函数能不能调通（404 = 没部署）
 *   2. capsule / reminds 的返回结构是否是新版（有没有新字段）
 *   3. 云端集合存不存在（capsules / reminds）
 *   4. initdb 报告建了几个集合
 */
const automator = require('miniprogram-automator')
const path = require('path')

const sleep = ms => new Promise(r => setTimeout(r, ms))

;(async () => {
  const mini = await automator.launch({
    cliPath: '/Applications/wechatwebdevtools.app/Contents/MacOS/cli',
    projectPath: path.join(__dirname, '..'),
    timeout: 90000
  })
  console.log('✓ 已连上运行时\n')

  // 1. 逐个探活
  const names = ['pair', 'daily', 'moments', 'chronicle', 'wishes', 'initdb',
    'bootstrap', 'answer', 'home', 'capsule', 'reminds']
  const alive = []
  for (const n of names) {
    const r = await mini.evaluate(async (name) => {
      try {
        const res = await wx.cloud.callFunction({ name, data: { action: 'list' } })
        return { ok: true, keys: Object.keys(res.result || {}).slice(0, 8).join(',') }
      } catch (e) {
        return { ok: false, err: String(e.errMsg || e.message || e).slice(0, 120) }
      }
    }, n)
    if (r.ok) { alive.push(n); console.log(`  ✓ ${n.padEnd(11)} → ${r.keys}`) }
    else console.log(`  ✗ ${n.padEnd(11)} → ${r.err}`)
  }

  // 2. capsule 是不是新版（新版返回 list + total + 未解锁不返回 text）
  console.log('\n── 时间胶囊 ──')
  const cap = await mini.evaluate(async () => {
    try {
      const r = (await wx.cloud.callFunction({ name: 'capsule', data: { action: 'list' } })).result
      const l = r.list || []
      return {
        ok: true, total: r.total, n: l.length,
        sample: l[0] ? Object.keys(l[0]).join(',') : '(空)',
        leaked: l.some(c => !c.unlocked && c.text)   // 未解锁却带正文 = 旧版或写错
      }
    } catch (e) { return { ok: false, err: String(e.errMsg || e.message).slice(0, 200) } }
  })
  console.log('  ', JSON.stringify(cap))
  if (cap.ok && cap.leaked) console.log('  ⚠ 未解锁的信返回了正文 —— 云端是旧版或逻辑错误')

  // 3. reminds 是不是新版（新版有 leadDays / inWindow / urgent）
  console.log('\n── 要记得的事 ──')
  const rem = await mini.evaluate(async () => {
    try {
      const r = (await wx.cloud.callFunction({ name: 'reminds', data: { action: 'list' } })).result
      const l = r.list || []
      return {
        ok: true, n: l.length,
        sample: l[0] ? Object.keys(l[0]).join(',') : '(空)',
        hasNewFields: l.length ? ('leadDays' in l[0]) && ('inWindow' in l[0]) : null
      }
    } catch (e) { return { ok: false, err: String(e.errMsg || e.message).slice(0, 200) } }
  })
  console.log('  ', JSON.stringify(rem))
  if (rem.ok && rem.hasNewFields === false) console.log('  ⚠ 缺少 leadDays/inWindow —— 云端是旧版')

  // 4. home 是否带 capsule/reminds 数据（1.4 聚合 + 1.5 扩展）
  console.log('\n── 首页聚合 home ──')
  const home = await mini.evaluate(async () => {
    try {
      const r = (await wx.cloud.callFunction({ name: 'home', data: {} })).result
      return { ok: true, keys: Object.keys(r).join(',') }
    } catch (e) { return { ok: false, err: String(e.errMsg || e.message).slice(0, 200) } }
  })
  console.log('  ', JSON.stringify(home))

  // 5. 云端集合
  console.log('\n── 云端集合 ──')
  const cols = await mini.evaluate(async () => {
    try {
      const db = wx.cloud.database()
      // 云函数端才能拿完整列表，小程序端只能逐个探：用 count 试
      const out = {}
      for (const c of ['pairs', 'moments', 'chronicle', 'wishes', 'capsules', 'reminds', 'pings', 'answers']) {
        try { const r = await db.collection(c).count(); out[c] = r.total }
        catch (e) { out[c] = '✗ ' + String(e.errMsg || e.message).slice(0, 60) }
      }
      return out
    } catch (e) { return { err: String(e.message).slice(0, 200) } }
  })
  console.log('  ', JSON.stringify(cols, null, 1))

  await mini.disconnect()
  console.log('\n✓ 探测完成，可调函数：' + alive.length + '/' + names.length)
})().catch(e => { console.error('✗', e.message); process.exit(1) })
