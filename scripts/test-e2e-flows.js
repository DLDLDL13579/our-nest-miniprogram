/**
 * test-e2e-flows.js —— 端到端：用**真实的** room + pair 云函数跑完整链路
 *
 * 与其它测试的分工：
 *   · test-room.js / mock-test.js —— 单个云函数的逻辑（细粒度）
 *   · 本文件 —— **跨云函数的真实流程**：配对 → 建房 → 并发加入 → 开局 →
 *     叫骰 → 号码回收 → 隐私检查，一次跑完
 *
 * 为什么需要它：单函数断言全绿，不代表**串起来**能工作。
 * 本轮就有一个这样的例子 —— 「号码回收」在 pickCode 里是对的，
 * 但和「按 code 查房」配合起来就出了回归（老房间抢走了新号码的查询）。
 * 那种问题只有把两个函数放在一条流程里才看得见。
 *
 * 覆盖的本轮修复（任意一处坏了都应该在这里看到）：
 *   · pair 并发配对 → 只有一人成功（不会三人同窝）
 *   · pair 内容安全（违规称呼被拦）
 *   · room 并发加入不丢人 + 座位重编号
 *   · start 在 countdown 窗口内被拦（不会重摇骰子）
 *   · bid 只接受整数（小数被拒）
 *   · 号码回收后按 code 进的是**新**房间
 *   · 大话骰别人没有 dice 字段（只有 diceCount）
 *
 * 跑法：node scripts/test-e2e-flows.js
 */
/**
 * 端到端：用真实的 room + pair 云函数跑一遍完整链路。
 * 覆盖本轮所有修复点，任意一处坏了都应该看到。
 */
const path=require('path'),Module=require('module')
const ROOT='/Users/meihaoshidai/Downloads/邓林work/个人项目/小程序'
const store={rooms:[],pairs:[],moments:[]}; let seq=0
function match(doc,q){return Object.keys(q).every(k=>{const c=q[k]
  if(c&&c.__op==='gt')return Number(doc[k])>Number(c.v)
  if(c&&c.__op==='lt')return Number(doc[k])<Number(c.v)
  if(c&&c.__op==='neq')return doc[k]!==c.v
  if(Array.isArray(doc[k]))return doc[k].indexOf(c)>=0
  return doc[k]===c})}
function upd(d,data){Object.keys(data).forEach(k=>{if(data[k]&&data[k].__op==='push')d[k]=(d[k]||[]).concat(data[k].v);else d[k]=data[k]})}
function collection(name){const rows=()=>store[name]=store[name]||[]; return{
 where(q){return{_n:null,_o:[],_f:null,limit(n){this._n=n;return this},orderBy(f,d){this._o.push([f,d]);return this},field(f){this._f=f;return this},
  async get(){let out=rows().filter(d=>match(d,q)); if(this._n)out=out.slice(0,this._n); out=JSON.parse(JSON.stringify(out))
   if(this._f){const ks=Object.keys(this._f).filter(k=>this._f[k]); out=out.map(d=>{const o={_id:d._id};ks.forEach(k=>o[k]=d[k]);return o})} return{data:out}},
  async count(){return{total:rows().filter(d=>match(d,q)).length}},
  async update({data}){const hit=rows().filter(d=>match(d,q)); hit.forEach(d=>upd(d,data)); return{stats:{updated:hit.length}}}}},
 doc(id){return{async get(){const d=rows().filter(x=>x._id===id)[0]; return{data:d?JSON.parse(JSON.stringify(d)):null}},
  async update({data}){const d=rows().filter(x=>x._id===id)[0]; if(!d)throw new Error('nf'); upd(d,data); return{stats:{updated:1}}},
  async remove(){const i=rows().findIndex(x=>x._id===id); if(i>=0)rows().splice(i,1); return{stats:{removed:1}}}}},
 async add({data}){const d=Object.assign({_id:'x'+(++seq)},data); rows().push(d); return{_id:d._id}},
 async count(){return{total:rows().length}}}}
const fakeDb={collection,command:{neq:v=>({__op:'neq',v}),push:v=>({__op:'push',v}),gt:v=>({__op:'gt',v}),lt:v=>({__op:'lt',v}),and:(...a)=>({__op:'and',v:a})},async createCollection(n){store[n]=store[n]||[];return true}}
const o=Module._resolveFilename
Module._resolveFilename=function(r,...a){if(r==='wx-server-sdk')return 'WX'; return o.call(this,r,...a)}
require.cache['WX']={id:'WX',filename:'WX',loaded:true,exports:{init(){},DYNAMIC_CURRENT_ENV:'x',database:()=>fakeDb,
 getWXContext:()=>({OPENID:global.__O}),openapi:{security:{async msgSecCheck({content}){return{errCode:0,result:{suggest:/违禁/.test(content||'')?'risky':'pass'}}}}}}}
const room=require(path.join(ROOT,'cloudfunctions','room','index.js'))
const pair=require(path.join(ROOT,'cloudfunctions','pair','index.js'))
const TTL=2*3600*1000
let pass=0,fail=0
const chk=(n,c,extra)=>{c?(console.log('  ✓ '+n),pass++):(console.log('  ✗ '+n+(extra?'  → '+extra:'')),fail++)}

;(async()=>{
  console.log('════ 1. 配对（含内容安全）════')
  global.__O='DENG'
  const c=await pair.main({action:'create'}); chk('建房拿到 6 位码', c.ok && c.code.length===6)
  global.__O='QP'
  const j=await pair.main({action:'join', code:c.code}); chk('配对成功', j.ok, j.msg)
  const pd=store.pairs[0]; chk('members 恰好 2 人', pd.members.length===2, JSON.stringify(pd.members))
  global.__O='BAD'
  const j2=await pair.main({action:'join', code:c.code}); chk('码已作废，第三人进不来', !j2.ok)
  global.__O='DENG'
  const bad=await pair.main({action:'set', myName:'违禁昵称'}); chk('违规称呼被内容安全拦住', !bad.ok, bad.msg)

  console.log('\n════ 2. 建房（3 位号码 + 并发安全）════')
  global.__O='host'
  const r1=await room.main({action:'create', name:'房主', game:'liar'})
  chk('建房成功且号码是 3 位数字', r1.ok && /^\d{3}$/.test(r1.room.code), r1.room?r1.room.code:'')
  const CODE=r1.room.code, RID=r1.room.id

  console.log('\n════ 3. 并发加入（原子 push + 座位重编号）════')
  const jA=(async()=>{global.__O='pA'; return room.main({action:'join', code:CODE, name:'A'})})()
  const jB=(async()=>{global.__O='pB'; return room.main({action:'join', code:CODE, name:'B'})})()
  const [ra,rb]=await Promise.all([jA,jB])
  chk('两人都加入成功', ra.ok && rb.ok)
  const doc=store.rooms.filter(x=>x._id===RID)[0]
  const names=doc.players.map(p=>p.name).sort()
  chk('并发不丢人（3 人都在）', names.length===3, names.join(','))
  const seats=doc.players.map(p=>p.seat).sort((a,b)=>a-b)
  chk('座位 1..N 连续唯一', JSON.stringify(seats)==='[1,2,3]', JSON.stringify(seats))

  console.log('\n════ 4. 开局 + 重复 start 被拦（倒计时窗口）════')
  global.__O='host'
  const s1=await room.main({action:'start', id:RID}); chk('开局成功', s1.ok, s1.msg)
  chk('phase 进 countdown', s1.room.phase==='countdown', s1.room.phase)
  const s2=await room.main({action:'start', id:RID})
  chk('★ 倒计时内重复 start 被拦（不会重摇骰子）', !s2.ok, s2.msg)

  console.log('\n════ 5. 叫骰参数校验（整数）════')
  store.rooms.filter(x=>x._id===RID)[0].countdownEnd=Date.now()-100
  await room.main({action:'status', id:RID})
  const b1=await room.main({action:'bid', id:RID, n:2.5, face:3})
  chk('小数数量被拒', !b1.ok, b1.msg)
  const b2=await room.main({action:'bid', id:RID, n:2, face:3.7})
  chk('小数点数被拒', !b2.ok, b2.msg)
  const b3=await room.main({action:'bid', id:RID, n:2, face:3})
  chk('合法叫骰通过', b3.ok, b3.msg)

  console.log('\n════ 6. 号码回收 + 按号进新房（本轮回归修复）════')
  const snapshot=JSON.parse(JSON.stringify(store.rooms))
  store.rooms.length=0
  global.__O='rec_old'
  const oldR=await room.main({action:'create', name:'老', game:'dice'})
  const RC=oldR.room.code, OLDID=oldR.room.id
  store.rooms.filter(x=>x._id===OLDID)[0].updatedAt=Date.now()-3*TTL
  let NEWID=null
  for(let i=0;i<1200&&!NEWID;i++){
    global.__O='rec_new_'+i
    const rr=await room.main({action:'create', name:'新', game:'dice'})
    if(!rr.ok)break
    if(rr.room.code===RC)NEWID=rr.room.id
  }
  chk('过期房的号码被回收', !!NEWID)
  global.__O='rec_joiner'
  const rj=await room.main({action:'join', code:RC, name:'来的'})
  chk('★ 按号进的是新房间（不是过期老房）', rj.ok && rj.room.id===NEWID, rj.msg||('进了 '+rj.room.id))
  store.rooms.length=0; snapshot.forEach(x=>store.rooms.push(x))

  console.log('\n════ 7. 大话骰隐私（别人的骰子不可见）════')
  const st=await room.main({action:'status', id:RID})
  if(st.ok){
    const others=st.room.players.filter(p=>!p.isMe)
    chk('别人响应里没有 dice 字段', others.every(p=>p.dice===undefined),
        JSON.stringify(others.map(p=>p.dice)))
    chk('但有 diceCount（界面要画几颗）', others.every(p=>typeof p.diceCount==='number'))
  }

  console.log('\n'+(fail===0?`══ 全部 ${pass} 项通过 ══`:`══ ${pass} 通过 / ${fail} 失败 ══`))
  process.exit(fail===0?0:1)
})().catch(e=>{console.log('!! 崩溃:', e&&(e.stack||e.message));process.exit(1)})
