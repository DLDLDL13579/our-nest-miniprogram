#!/usr/bin/env node
/**
 * probe.js —— 通用真机探针：启动 automator，用真实云端跑一段操作，打印结果
 *
 * ============ 为什么合并 ============
 *
 * 之前为了定位具体 bug，一个症状写一个探针：
 *   probe-create.js   create 耗时分布
 *   probe-swap.js     云端连续换手牌
 *   probe-swap-ui.js  真前端连续点换牌
 * 每个都是"启动 automator + evaluate 一段"的同一个壳，只是中间那段不同。
 * 于是每次查新问题都要复制一份壳 —— 而且**壳本身也踩过坑**
 * （必须先 navigateTo 才能用 wx.cloud、必须一次 evaluate 里做完所有云调用，
 *   否则会 timeout waiting for automator response）。
 *
 * 现在：壳在这里维护一次，具体查什么用 --script 传进去。
 *
 * ============ 用法 ============
 *
 *   node .tooling/probe.js --script swap        # 连续换手牌（云端）
 *   node .tooling/probe.js --script create      # create 分段耗时
 *   node .tooling/probe.js --script cipline     # 换手牌（真实前端点击链路）
 *   node .tooling/probe.js --file my-case.js    # 自定义：导出 function(mini, sleep)
 *
 * ⚠️ 跑完记得关 IDE（脚本 finally 里会 mini.close()，
 *    但 IDE 进程本身还要 `cli quit --project`）。
 */
const path = require('path')
const automator = require('miniprogram-automator')

const ROOT = path.resolve(__dirname, '..')
const CLI = '/Applications/wechatwebdevtools.app/Contents/MacOS/cli'
const sleep = ms => new Promise(r => setTimeout(r, ms))

/* ---------------- 内置用例 ---------------- */
const CASES = {
  /* 云端：连续三次换手牌，看服务端是否每次成功、喝量是否累计 */
  swap: async (mini) => {
    await gotoMe(mini)
    return mini.evaluate(function () {
      const api = (data) => wx.cloud.callFunction({ name: 'room', data }).then(r => r.result)
      return (async () => {
        const log = []
        const cr = await api({ action: 'create', name: '探针', game: 'poker' })
        if (!cr.ok) return { err: 'create 失败: ' + JSON.stringify(cr) }
        const id = cr.room.id
        await api({ action: 'start', id, solo: true })
        for (let i = 0; i < 6; i++) {
          await new Promise(r => setTimeout(r, 1200))
          const st = await api({ action: 'status', id })
          if (st.room && st.room.phase === 'playing') break
        }
        for (let i = 1; i <= 3; i++) {
          const r = await api({ action: 'pkAct', act: 'swapMine', id })
          const p = r.room && r.room.poker
          log.push('第' + i + '次 ok=' + !!r.ok + ' 喝=' + (p && p.myDrink) +
                   ' 明牌=' + (p && p.myKnownText) + (r.msg ? ' msg=' + r.msg : ''))
          await new Promise(r2 => setTimeout(r2, 400))
        }
        return { log }
      })()
    })
  },

  /* 云端：create 的分段耗时（pickCode / add / shape） */
  create: async (mini) => {
    await gotoMe(mini)
    return mini.evaluate(function () {
      const api = (d) => wx.cloud.callFunction({ name: 'room', data: d }).then(r => r.result)
      return (async () => {
        const out = []
        for (let i = 0; i < 3; i++) {
          const t0 = Date.now()
          const r = await api({ action: 'create', name: '探针' + i, game: 'liar', debug: true })
          out.push('总 ' + (Date.now() - t0) + 'ms' +
                   (r._t ? ' | pick ' + r._t.pick + ' add ' + r._t.add + ' shape ' + r._t.shape : ''))
        }
        return { log: out }
      })()
    })
  },

  /* 真前端：连续点两次「换手牌」，验证界面有没有真的刷新 */
  cipline: async (mini) => {
    await gotoMe(mini)
    const code = await mini.evaluate(function () {
      const api = (d) => wx.cloud.callFunction({ name: 'room', data: d }).then(r => r.result)
      return (async () => {
        const cr = await api({ action: 'create', name: '前端探针', game: 'poker' })
        if (!cr.ok) return ''
        await api({ action: 'start', id: cr.room.id, solo: true })
        return cr.room.code
      })()
    })
    if (!code) return { err: '建房失败' }
    await mini.navigateTo('/game/room/room?code=' + code)
    let p, d
    for (let i = 0; i < 8; i++) {
      await sleep(1200)
      p = await mini.currentPage(); d = await p.data()
      if (d.stage === 'playing') break
    }
    const log = []
    for (let round = 1; round <= 2; round++) {
      const btns = await p.$$('.pk-swap')
      if (btns.length < 2) { log.push('第' + round + '次：找不到换牌按钮'); break }
      await btns[1].tap(); await sleep(700)
      p = await mini.currentPage()
      const yes = await p.$('.pkask-btn.yes')
      if (!yes) { log.push('第' + round + '次：没有确认卡'); break }
      await yes.tap(); await sleep(3000)
      p = await mini.currentPage(); d = await p.data()
      log.push('第' + round + '次 界面喝=' + (d.room && d.room.poker && d.room.poker.drinkText))
    }
    return { log }
  }
}

/* 先 navigateTo 到「我的」—— 直接 evaluate 会报 Cloud API isn't enabled */
async function gotoMe(mini) {
  await sleep(6000)
  await mini.navigateTo('/pages/me/me').catch(() => {})
  await sleep(1500)
}

/* ---------------- 主流程 ---------------- */
;(async () => {
  const argv = process.argv.slice(2)
  /* ⚠️ 必须判 indexOf >= 0 —— 直接用 -1+1=0 会把 argv[0] 当成文件名 */
  const si = argv.indexOf('--script')
  const fi = argv.indexOf('--file')
  const name = si >= 0 ? argv[si + 1] : null
  const file = fi >= 0 ? argv[fi + 1] : null
  let run = CASES[name]
  if (file) {
    const mod = require(path.resolve(file))
    run = typeof mod === 'function' ? mod : mod.run
  }
  if (!run) {
    console.error('用法: node .tooling/probe.js --script <' + Object.keys(CASES).join('|') + '>')
    console.error('  或: node .tooling/probe.js --file <你的用例.js>')
    process.exit(2)
  }
  const mini = await automator.launch({ cliPath: CLI, projectPath: ROOT, timeout: 120000 })
  try {
    const out = await run(mini, sleep)
    if (out && out.err) console.error('✗ ' + out.err)
    else if (out && out.log) out.log.forEach(l => console.log('  ' + l))
    else console.log(JSON.stringify(out, null, 2))
  } finally {
    await mini.close().catch(() => {})
  }
})().catch(e => { console.error('失败:', e.message); process.exit(1) })
