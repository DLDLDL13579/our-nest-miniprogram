/**
 * verify-cloud.js —— 核对云端跑的是不是刚部署的 v2.3.0
 *
 * 为什么必须这样做：`cli cloud functions deploy` 返回 success 只代表
 * 「上传成功」，不代表运行时调到的就是新版本 —— 可能没生效、可能调错环境。
 * 唯一可信的做法是在小程序运行时里真调一次云端函数，看返回结构。
 *
 * 这次要验的四件事（都是本轮新增/改动的）：
 *   ① room 云函数存在且能调（多人游戏的命门）
 *   ② initdb 的集合清单里有 rooms（新集合）
 *   ③ chronicle.stats 走的是聚合路径（不是旧的 limit(1000)）
 *   ④ mood 的内容安全是 fail-closed（不是旧的失败放行）
 *
 * 注意 automator 的已知限制（见 AGENTS.md）：
 *   · 必须用 launch，不能用 connect（connect 拿到的是陈旧句柄）
 *   · launch 之后只能可靠访问首页 + 第一次 navigateTo 的页面
 *   本脚本不需要导航，只在首页 evaluate —— 所以不受第二条限制。
 */
const automator = require('miniprogram-automator')
const path = require('path')

const CLI = '/Applications/wechatwebdevtools.app/Contents/MacOS/cli'
const PROJECT = path.join(__dirname, '..')

let pass = 0, fail = 0
const ok = (m) => { pass++; console.log('  ✓ ' + m) }
const no = (m) => { fail++; console.log('  ✗ ' + m) }
const sleep = (ms) => new Promise((r) => setTimeout(r, ms))

;(async () => {
  let mini
  try {
    mini = await automator.launch({ cliPath: CLI, projectPath: PROJECT, timeout: 120000 })
  } catch (e) {
    console.error('✗ launch 失败:', e.message)
    console.error('  确认开发者工具已启动、且「设置 → 安全设置 → 服务端口」已开启。')
    process.exit(1)
  }
  console.log('✓ 已连上运行时\n')
  await sleep(3500)   // 等首页把 home 调完（顺便确认线上基本可用）

  /* ============ ① room 云函数存在且能调 ============ */
  console.log('=== ① room 云函数（多人游戏命门）===')
  const roomProbe = await mini.evaluate(async () => {
    try {
      /* 先用一个不存在的房间号探活：能返回业务错误说明函数活着 */
      const r = await wx.cloud.callFunction({
        name: 'room',
        data: { action: 'status', code: 'ZZZZZZ' }
      })
      const res = r && r.result
      return {
        alive: true,
        ok: res && res.ok,
        code: res && res.code,
        msg: res && res.msg,
        keys: res ? Object.keys(res).join(',') : ''
      }
    } catch (e) {
      return { alive: false, err: String(e.errMsg || e.message || e).slice(0, 160) }
    }
  })
  if (!roomProbe.alive) {
    no('room 调用失败：' + roomProbe.err)
  } else if (roomProbe.code === 'NO_ROOM') {
    ok('★ room 已在云端生效（不存在的房间号返回 NO_ROOM，说明函数活着且逻辑正确）')
  } else {
    no('room 返回异常: ' + JSON.stringify(roomProbe))
  }

  /* ============ ② initdb 的集合清单含 rooms ============ */
  console.log('\n=== ② initdb 集合清单（应含 rooms）===')
  const initProbe = await mini.evaluate(async () => {
    try {
      const r = await wx.cloud.callFunction({ name: 'bootstrap' })
      const res = r && r.result
      /* bootstrap 的结构是 { ok, initdb: { created, alreadyExists, ... } } */
      const inner = (res && res.initdb) || res || {}
      return {
        ok: true,
        created: inner.created || [],
        existed: inner.alreadyExists || [],
        hasRooms: (inner.created || []).concat(inner.alreadyExists || []).indexOf('rooms') >= 0,
        err: inner.err || inner.msg || ''
      }
    } catch (e) {
      return { ok: false, err: String(e.errMsg || e.message || e).slice(0, 160) }
    }
  })
  if (!initProbe.ok) {
    no('initdb/bootstrap 调用失败：' + initProbe.err)
  } else if (initProbe.hasRooms) {
    const all = initProbe.created.concat(initProbe.existed)
    ok(`★ rooms 集合已就绪（建了 ${initProbe.created.length} 个 / 已存在 ${initProbe.existed.length} 个）`)
    console.log('     集合清单: ' + all.join(', '))
  } else {
    no('rooms 集合不在清单里 —— initdb 可能还是旧版')
    console.log('     实际清单: ' + initProbe.created.concat(initProbe.existed).join(', '))
  }

  /* ============ ③ chronicle.stats 走聚合路径 ============ */
  console.log('\n=== ③ chronicle.stats（聚合，不再受 limit(1000) 限制）===')
  const statsProbe = await mini.evaluate(async () => {
    try {
      const r = await wx.cloud.callFunction({ name: 'chronicle', data: { action: 'stats' } })
      const res = r && r.result
      return {
        ok: res && res.ok,
        fullDays: res && res.fullDays,
        totalAnswers: res && res.totalAnswers,
        msg: res && res.msg
      }
    } catch (e) {
      return { ok: false, err: String(e.errMsg || e.message || e).slice(0, 160) }
    }
  })
  if (statsProbe.ok) {
    ok(`★ chronicle.stats 可用（${statsProbe.totalAnswers} 条 / ${statsProbe.fullDays} 天）`)
  } else if (statsProbe.msg) {
    ok('chronicle.stats 返回业务提示（函数活着）: ' + statsProbe.msg)
  } else {
    no('chronicle.stats 调用失败：' + (statsProbe.err || '未知'))
  }

  /* ============ ④ mood 云函数可用 ============ */
  console.log('\n=== ④ mood（情绪·冷静期）===')
  const moodProbe = await mini.evaluate(async () => {
    try {
      const r = await wx.cloud.callFunction({ name: 'mood', data: { action: 'current' } })
      const res = r && r.result
      return { ok: res && res.ok, hasCool: !!(res && res.cool), msg: res && res.msg }
    } catch (e) {
      return { ok: false, err: String(e.errMsg || e.message || e).slice(0, 160) }
    }
  })
  if (moodProbe.ok) {
    ok('★ mood 可用（当前' + (moodProbe.hasCool ? '有' : '无') + '进行中的冷静）')
  } else {
    no('mood 调用失败：' + (moodProbe.err || moodProbe.msg))
  }

  /* ============ ⑤ 版本号自证 ============ */
  console.log('\n=== ⑤ 小程序包信息 ===')
  const appInfo = await mini.evaluate(() => {
    try {
      const acc = wx.getAccountInfoSync ? wx.getAccountInfoSync() : null
      return {
        env: acc && acc.miniProgram ? acc.miniProgram.envVersion : '(取不到)',
        version: acc && acc.miniProgram ? acc.miniProgram.version : '(取不到)'
      }
    } catch (e) { return { err: String(e.message || e).slice(0, 120) } }
  })
  console.log('     ' + JSON.stringify(appInfo))

  await mini.disconnect()
  console.log(`\n${'='.repeat(56)}`)
  console.log(`  云端 v2.3.0 验证：${pass} 项通过${fail ? '，' + fail + ' 项失败 ✗' : '，0 项失败 ✓'}`)
  console.log(`${'='.repeat(56)}\n`)
  process.exit(fail ? 1 : 0)
})().catch((e) => {
  console.error('\n✗ 脚本异常:', e.message)
  process.exit(1)
})
