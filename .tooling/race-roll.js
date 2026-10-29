/* 验证并发摇骰是否丢骰子：让 mock 有真实网络延迟，两个玩家同时摇 */
const path = require('path')
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
  console.log('A 返回:', JSON.stringify(rA && {ok:rA.ok, msg:rA.msg, diag:rA._diag}))
  console.log('B 返回:', JSON.stringify(rB && {ok:rB.ok, msg:rB.msg, diag:rB._diag}))
  const r = store.rooms[0]
  console.log('players:', JSON.stringify((r.players||[]).map(p=>({name:p.name, dice:p.dice}))))
  console.log('甲的骰子:', JSON.stringify(r.players[0].dice))
  console.log('乙的骰子:', JSON.stringify(r.players[1].dice))
  console.log('phase:', r.phase)
  const lost = !r.players[0].dice || !r.players[0].dice.length
  console.log(lost ? '✗ 甲的骰子丢了（并发覆盖）' : '✓ 两个人都保住了骰子')
})()
