/**
 * test-race.js —— **并发**写操作不能互相覆盖（2026-10-30）
 *
 * 真实场景：比大小开局，几个人几乎同时点「摇骰」。每个请求都是
 *   读房间 → 把自己的 dice 塞进 players → 整体覆盖写回
 * 云函数之间没有共享内存，两个请求会读到**同一个旧快照**，后写的把先写的冲掉。
 *
 * 后果不是"少一个骰子"这么轻：丢骰子的人让"全员摇完"永远不成立 →
 * **这局永远结束不了**（卡在 playing，谁都没法再推进）。
 *
 * 这个测试的关键是**给 mock 加网络延迟**（每个 get/update 各 2ms）——
 * 没有延迟，JS 单线程会让两个请求自然串行，竞态窗口根本不存在，测了等于没测。
 *
 * 跑法：node scripts/test-race.js
 */
const path = require('path')
const assert = require('assert')
const Module = require('module')
const store = { rooms: [] }
let seq = 0
const nextId = () => 'r' + (++seq)
const sleep = ms => new Promise(r => setTimeout(r, ms))

function match(doc, q) { return Object.keys(q).every(k => {
  const c = q[k]
  if (c && c.__op === 'gt') return Number(doc[k]) > Number(c.v)
  if (c && c.__op === 'lt') return Number(doc[k]) < Number(c.v)
  return doc[k] === c
}) }
function collection(name) {
  const rows = () => (store[name] = store[name] || [])
  return {
    where(q) { return {
      _n: null, limit(n){ this._n=n; return this }, orderBy(){ return this }, field(){ return this },
      async get(){ await sleep(2); let o = rows().filter(d=>match(d,q)); if(this._n) o=o.slice(0,this._n); return { data: JSON.parse(JSON.stringify(o)) } },
      async count(){ return { total: rows().filter(d=>match(d,q)).length } },
      async remove(){ return { stats:{} } },
      async update({data}){ await sleep(2); let n=0; rows().filter(d=>match(d,q)).forEach(d=>{
        n++
        Object.keys(data).forEach(k => {
          const v = data[k]
          if (v && v.__op === 'set') d[k] = v.v
          else if (v && v.__op === 'push') d[k] = (d[k]||[]).concat(v.v)
          else d[k] = v
        })
      }); return { stats: { updated: n } } }
    } },
    doc(id) { return {
      async get(){ await sleep(2); const d=rows().filter(x=>x._id===id)[0]; return { data: d?JSON.parse(JSON.stringify(d)):undefined } },
      async update({data}){ await sleep(2); const d=rows().filter(x=>x._id===id)[0]; if(!d) throw new Error('no doc'); Object.keys(data).forEach(k=>{ const v=data[k]; if(v&&v.__op==='set') d[k]=v.v; else if(v&&v.__op==='push') d[k]=(d[k]||[]).concat(v.v); else d[k]=v }); return { stats:{updated:1} } },
      async remove(){ return { stats:{removed:1} } }
    } },
    async add({data}){ const d=Object.assign({_id:nextId()},data); rows().push(d); return {_id:d._id} },
    async count(){ return { total: rows().length } }
  }
}
let OPENID=''
const mock = {
  init(){}, DYNAMIC_CURRENT_ENV:'mock',
  database(){ return { collection, command: { gt:v=>({__op:'gt',v}), lt:v=>({__op:'lt',v}), neq:v=>({__op:'neq',v}), and:(...a)=>({__op:'and',v:a}), push:v=>({__op:'push',v}), set:v=>({__op:'set',v}) }, async createCollection(n){ store[n]=store[n]||[]; return true } } },
  getWXContext(){ return { OPENID } },
  openapi: { security: { async msgSecCheck(){ return { errCode:0, result:{suggest:'pass'} } } } }
}
const orig = Module._load
Module._load = function (req, parent, isMain) {
  if (req === 'wx-server-sdk') return mock
  return orig.apply(this, arguments)
}
const room = require(path.resolve(__dirname, "..", "cloudfunctions/room/index.js"))
const A='a', B='b'
;(async () => {
  OPENID=A
  const c = await room.main({ action:'create', name:'甲', game:'dice' })
  OPENID=B
  await room.main({ action:'join', code:c.room.code, name:'乙' })
  OPENID=A
  await room.main({ action:'start', id:c.room.id })
  store.rooms[0].countdownEnd = Date.now()-100
  await room.main({ action:'status', id:c.room.id })
  // ★ 两人几乎同时摇
  OPENID=A; const pA = room.main({ action:'roll', id:c.room.id })
  OPENID=B; const pB = room.main({ action:'roll', id:c.room.id })
  const [rA, rB] = await Promise.all([pA, pB])
  assert.ok(rA && rA.ok, 'A 摇骰应成功：' + ((rA && rA.msg) || ''))
  assert.ok(rB && rB.ok, 'B 摇骰应成功：' + ((rB && rB.msg) || ''))
  const r = store.rooms[0]
  const diceA = (r.players[0] || {}).dice || []
  const diceB = (r.players[1] || {}).dice || []
  console.log('  甲的骰子: ' + JSON.stringify(diceA))
  console.log('  乙的骰子: ' + JSON.stringify(diceB))
  console.log('  phase: ' + r.phase)
  assert.strictEqual(diceA.length, 5, '★ 甲的骰子不能被乙的写入冲掉（并发覆盖）')
  assert.strictEqual(diceB.length, 5, '★ 乙的骰子要在')
  assert.strictEqual(r.phase, 'over',
    '★ 两人都摇完后这局必须结束 —— 丢骰子会让"全员摇完"永远不成立，卡死在 playing')
  console.log('\n  ✓ 并发摇骰：两人的骰子都在，且局正常结束\n')

  /* ============ ② 卧底：两人同时投票，两票都要在 ============ */
  /*
   * 与摇骰同一类问题：votes 是"读快照 → 追加 → 覆盖写"，
   * 同时投票会只剩一票 → "全员投完"永远不成立 → 卡死在投票页。
   * 卧底至少要 3 人（soloMin=2，但三人局才测得出"投完结算"）。
   */
  console.log('  ── 并发投票 ──')
  OPENID = A
  const uc = await room.main({ action: 'create', name: '卧底甲', game: 'undercover' })
  assert.ok(uc.ok && uc.room, '准备：建卧底房应成功：' + (uc.msg || ''))
  const uId = uc.room.id
  OPENID = B
  assert.ok((await room.main({ action: 'join', code: uc.room.code, name: '卧底乙' })).ok, '准备：乙加入')
  OPENID = 'c'
  assert.ok((await room.main({ action: 'join', code: uc.room.code, name: '卧底丙' })).ok, '准备：丙加入')
  OPENID = A
  assert.ok((await room.main({ action: 'start', id: uId })).ok, '准备：开局')
  /* ⚠️ 不能写 store.rooms[0]：那是上一段（dice 房）的房间 —— 拨错房间的
     countdownEnd，卧底房就一直停在 countdown，后面 uwSay 报"这局还没开始"。 */
  store.rooms.filter(x => x._id === uId)[0].countdownEnd = Date.now() - 100
  await room.main({ action: 'status', id: uId })
  assert.ok((await room.main({ action: 'uwSay', id: uId })).ok, '准备：进入投票环节')

  /* 乙和丙几乎同时投甲 */
  const aOid = (store.rooms.filter(x => x._id === uId)[0].players.filter(p => p.name === '卧底甲')[0] || {}).openid
  OPENID = B
  const vB = room.main({ action: 'uwVote', id: uId, target: aOid })
  OPENID = 'c'
  const vC = room.main({ action: 'uwVote', id: uId, target: aOid })
  const [rB2, rC2] = await Promise.all([vB, vC])
  const roomAfter = store.rooms.filter(x => x._id === uId)[0]
  console.log('  乙返回: ' + JSON.stringify({ ok: rB2 && rB2.ok, msg: (rB2 && rB2.msg) || '' }))
  console.log('  丙返回: ' + JSON.stringify({ ok: rC2 && rC2.ok, msg: (rC2 && rC2.msg) || '' }))
  const votesNow = (roomAfter.votes || []).length
  console.log('  已收票数: ' + votesNow + ' / 3 | uwStep: ' + roomAfter.uwStep)
  assert.strictEqual(votesNow, 2,
    '★ 两人同时投票，两票都必须记下来（只剩一票会让"全员投完"永远不成立、卡死在投票页）')

  /* 第三个人再投 → 应立刻结算（"全员投完自动开票"这条不能因为并发而失效） */
  OPENID = A
  const vA2 = await room.main({ action: 'uwVote', id: uId, target: 'c' })
  const after2 = store.rooms.filter(x => x._id === uId)[0]
  console.log('  第三人投票 → uwStep: ' + after2.uwStep)
  assert.ok(vA2 && (vA2.ok || /不能投自己/.test(vA2.msg || '')), '第三人投票应被受理：' + ((vA2 && vA2.msg) || ''))
  console.log('\n  ✓ 并发投票：两票都在（未凑齐不误结算），凑齐后正常开票\n')
})().catch(e => {
  console.error('\n  ✗ 断言失败：', e.message, '\n')
  process.exit(1)
})
