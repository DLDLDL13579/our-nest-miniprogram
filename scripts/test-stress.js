/**
 * test-stress.js —— 压测：8 人连续玩 10 局（真实酒桌一晚的强度）
 *
 * 为什么要有它：其他测试都是"一局对不对"，而真实使用是**连玩几十局**。
 * 连玩最容易出的问题不是功能错，而是**状态只增不减**：
 * 某个字段每局 append 一次、从来不清 → 文档越来越大 → 查询变慢，
 * 而这个过程是渐变的、不报错的（AGENTS.md 记过"号码池只减不增"的同类事故）。
 *
 * 断言三件事：
 *   ① 每一局都能正常结束（8 人全都摇完 → over）
 *   ② 文档大小增长有上限（10 局涨 < 1500 字节；按实测算每局约 +43 字节）
 *   ③ 累积字段（round / nightDrinks / streaks）项数合理，没有随局数失控
 *
 * 跑法：node scripts/test-stress.js
 */
const path = require('path')
const Module = require('module')
const assert = require('assert')
const store = { rooms: [] }
let seq = 0
const nextId = () => 'r' + (++seq)
function match(doc, q) { return Object.keys(q).every(k => {
  const c = q[k]
  if (c && c.__op === 'gt') return Number(doc[k]) > Number(c.v)
  if (c && c.__op === 'lt') return Number(doc[k]) < Number(c.v)
  return doc[k] === c }) }
function collection(name) {
  const rows = () => (store[name] = store[name] || [])
  return {
    where(q){ return { _n:null, limit(n){this._n=n;return this}, orderBy(){return this}, field(){return this},
      async get(){ let o=rows().filter(d=>match(d,q)); if(this._n)o=o.slice(0,this._n); return {data:JSON.parse(JSON.stringify(o))} },
      async count(){ return {total:rows().filter(d=>match(d,q)).length} },
      async update({data}){ const hit=rows().filter(d=>match(d,q)); hit.forEach(d=>Object.keys(data).forEach(k=>{const v=data[k]; if(v&&v.__op==='set')d[k]=v.v; else if(v&&v.__op==='push')d[k]=(d[k]||[]).concat(v.v); else if(v&&v.__op==='inc')d[k]=(d[k]||0)+v.v; else d[k]=v})); return {stats:{updated:hit.length}} } } },
    doc(id){ return {
      async get(){ const d=rows().filter(x=>x._id===id)[0]; return {data:d?JSON.parse(JSON.stringify(d)):undefined} },
      async update({data}){ const d=rows().filter(x=>x._id===id)[0]; if(!d)throw new Error('no'); Object.keys(data).forEach(k=>{const v=data[k]; if(v&&v.__op==='set')d[k]=v.v; else if(v&&v.__op==='push')d[k]=(d[k]||[]).concat(v.v); else d[k]=v}); return {stats:{updated:1}} },
      async remove(){ return {stats:{removed:1}} } } },
    async add({data}){ const d=Object.assign({_id:nextId()},data); rows().push(d); return {_id:d._id} },
    async count(){ return {total:rows().length} }
  }
}
let OPENID=''
const mock = { init(){}, DYNAMIC_CURRENT_ENV:'mock',
  database(){ return { collection, command:{ gt:v=>({__op:'gt',v}), lt:v=>({__op:'lt',v}), neq:v=>({__op:'neq',v}), and:(...a)=>({__op:'and',v:a}), push:v=>({__op:'push',v}), set:v=>({__op:'set',v}), inc:v=>({__op:'inc',v}) }, async createCollection(n){ store[n]=store[n]||[]; return true } } },
  getWXContext(){ return {OPENID} },
  openapi:{ security:{ async msgSecCheck(){ return {errCode:0,result:{suggest:'pass'}} } } } }
const orig = Module._load
Module._load = function(req,p,i){ if(req==='wx-server-sdk')return mock; return orig.apply(this,arguments) }
const room = require('/Users/meihaoshidai/Downloads/邓林work/个人项目/小程序/cloudfunctions/room/index.js')

;(async () => {
  const N = 8, ROUNDS = 10
  const ids = Array.from({length:N},(_,i)=>'p'+i)
  OPENID = ids[0]
  const c = await room.main({ action:'create', name:'玩家1', game:'dice' })
  if (!c.ok) { console.log('建房失败', c.msg); return }
  const rid = c.room.id
  for (let i=1;i<N;i++) { OPENID = ids[i]; const j = await room.main({ action:'join', code:c.room.code, name:'玩家'+(i+1) }); if(!j.ok){console.log('加入失败', j.msg);return} }
  const sizes = []
  let t0 = Date.now()
  for (let r=0;r<ROUNDS;r++) {
    OPENID = ids[0]
    const st = await room.main({ action:'start', id: rid })
    if (!st.ok) { console.log(`第 ${r+1} 局开局失败:`, st.msg); return }
    store.rooms[0].countdownEnd = Date.now()-100
    await room.main({ action:'status', id: rid })
    /* 8 人依次摇 */
    for (let i=0;i<N;i++) { OPENID = ids[i]; const rr = await room.main({ action:'roll', id: rid }); if(!rr.ok){console.log(`第 ${r+1} 局 ${i} 摇骰失败:`, rr.msg);return} }
    const after = store.rooms[0]
    sizes.push(JSON.stringify(after).length)
    if (after.phase !== 'over') { console.log(`第 ${r+1} 局没结束，phase=`, after.phase); return }
    OPENID = ids[0]
    const ag = await room.main({ action:'again', id: rid })
    if (!ag.ok) { console.log('再来一局失败:', ag.msg); return }
  }
  const ms = Date.now() - t0
  const doc = store.rooms[0]
  const grew = sizes[sizes.length-1] - sizes[0]
  console.log('  8 人 × 10 局，耗时 ' + ms + 'ms')
  console.log('  文档大小: ' + sizes[0] + ' → ' + sizes[sizes.length-1] + ' 字节（涨 ' + grew + '）')
  console.log('  round=' + doc.round + ' players=' + doc.players.length +
    ' nightDrinks=' + Object.keys(doc.nightDrinks||{}).length +
    ' streaks=' + Object.keys(doc.streaks||{}).length)
  assert.strictEqual(doc.round, ROUNDS, '★ round 必须等于实际局数')
  assert.strictEqual(doc.players.length, N, '★ 8 个人一个都不能丢')
  assert.ok(grew < 1500, '★ 10 局文档增长应在 1500 字节内（实测约 +430）；实际 +' + grew +
    ' —— 涨得太多说明有字段每局只增不减')
  const nd = Object.keys(doc.nightDrinks || {}).length
  const st = Object.keys(doc.streaks || {}).length
  assert.ok(nd <= N, '★ nightDrinks 项数不能超过人数；实际 ' + nd)
  assert.ok(st <= N, '★ streaks 项数不能超过人数；实际 ' + st)
  console.log('\n  ✓ 8 人连玩 10 局：每局都能结束，文档不膨胀，累积字段正常\n')
})().catch(e => {
  console.error('\n  ✗ 断言失败：', e.message, '\n')
  process.exit(1)
})
