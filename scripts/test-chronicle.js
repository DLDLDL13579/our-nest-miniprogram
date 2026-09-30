/** 编年史 + 想去去过的逻辑验证：复用 mock-test 的内存 SDK */
const path=require('path')
const Module=require('module')
const assert=require('assert')

const store={pairs:[],questions:[],answers:[],pings:[],wishes:[],moments:[]}
let seq=0
const nextId=()=>'id'+(++seq)
function neq(v){return {__op:'neq',v}}
function pushv(v){return {__op:'push',v}}
const command={neq,push:pushv}
function match(doc,q){return Object.keys(q).every(k=>{const c=q[k]
  if(c&&c.__op==='neq')return doc[k]!==c.v
  if(Array.isArray(doc[k]))return doc[k].indexOf(c)>=0
  return doc[k]===c})}

function collection(name){
  const rows=()=>(store[name]=store[name]||[])
  return {
    where(q){const cond=q;const api={_n:null,_sel:null,_o:[],
      limit(n){this._n=n;return this}, field(s){this._sel=s;return this},
      orderBy(f,d){this._o.push([f,d]);return this},
      skip(n){this._s=n;return this},
      async get(){let out=rows().filter(d=>match(d,cond))
        for(let i=this._o.length-1;i>=0;i--){const[f,dir]=this._o[i]
          out=out.slice().sort((a,b)=>{const x=a[f],y=b[f]
            if(x===y)return 0; return (x>y?1:-1)*(dir==='desc'?-1:1)})}
        if(this._s)out=out.slice(this._s)
        if(this._n)out=out.slice(0,this._n)
        out=out.map(d=>{const c=Object.assign({},d)
          if(this._sel)Object.keys(c).forEach(k=>{if(!(k in this._sel)||this._sel[k]===false)delete c[k]})
          return c})
        return {data:out}},
      async count(){return {total:rows().filter(d=>match(d,cond)).length}}}
      return api},
    doc(id){return {
      async get(){return {data:rows().filter(x=>x._id===id)[0]}},
      async update({data}){const d=rows().filter(x=>x._id===id)[0]
        Object.keys(data).forEach(k=>{if(data[k]&&data[k].__op==='push')d[k]=(d[k]||[]).concat(data[k].v);else d[k]=data[k]})
        return {stats:{updated:1}}},
      async remove(){const i=rows().findIndex(x=>x._id===id);if(i>=0)rows().splice(i,1);return{stats:{removed:1}}}}},
    async add({data}){const d=Object.assign({_id:nextId()},data);rows().push(d);return {_id:d._id}},
    async count(){return {total:rows().length}},
    /* 聚合链：只实现 chronicle.stats 用到的三个阶段（match/group/count）。
       真聚合在数据库端跑，这里等价地在内存里做同样的事 ——
       目的是让「天数不再受 limit(1000) 限制」这条改动能被断言覆盖。 */
    aggregate(){
      const stages=[]
      const api={
        match(c){stages.push(['match',c]);return api},
        group(g){stages.push(['group',g]);return api},
        count(f){stages.push(['count',f]);return api},
        async end(){
          let cur=rows().slice()
          for(const [op,arg] of stages){
            if(op==='match')cur=cur.filter(d=>match(d,arg))
            else if(op==='group'){
              const key=String(arg._id||'').replace(/^\$/,'')
              const seen=new Set()
              cur=cur.filter(d=>{const v=d[key]
                if(seen.has(v))return false;seen.add(v);return true})
            }
            else if(op==='count'){cur=[{[arg||'n']:cur.length}]}
          }
          return {list:cur}
        }
      }
      return api
    }
  }
}
let OPENID=''
const mock={init(){},DYNAMIC_CURRENT_ENV:'mock',database(){return{collection,command,async createCollection(n){store[n]=store[n]||[];return true}}},
  getWXContext(){return{OPENID}},openapi:{security:{async msgSecCheck(){return{errCode:0,result:{suggest:'pass'}}}}}}
const ROOT=path.join(__dirname,'..')
const orig=Module._load; Module._load=function(r){if(r==='wx-server-sdk')return mock;return orig.apply(this,arguments)}

const pair=require(path.join(ROOT,'cloudfunctions','pair','index.js'))
const chronicle=require(path.join(ROOT,'cloudfunctions','chronicle','index.js'))
const wishes=require(path.join(ROOT,'cloudfunctions','wishes','index.js'))
const moments=require(path.join(ROOT,'cloudfunctions','moments','index.js'))
const initdb=require(path.join(ROOT,'cloudfunctions','initdb','index.js'))

const D='oid_deng',Q='oid_qp'
let n=0; const ok=m=>{n++;console.log('  ✓ '+m)}

;(async()=>{
  await initdb.main()
  OPENID=D; const c=await pair.main({action:'create'})
  OPENID=Q; const j=await pair.main({action:'join',code:c.code})
  OPENID=D; await pair.main({action:'set',anniversary:'2024-03-26'})
  const pid=j.pair.pairId
  ok('配对 + 设定在一起的日子')

  console.log('\n=== 编年史：空态 ===')
  const e=await chronicle.main({action:'list'})
  assert.strictEqual(e.ok,true); assert.strictEqual(e.list.length,0)
  assert.ok(e.milestones.length>=5,'里程碑应现算出来')
  ok(`空编年史返回 ${e.milestones.length} 个里程碑（现算，非查库）`)

  console.log('\n=== 记两条（随手记，不再是每日打卡）===')
  for(const day of ['2026-09-20','2026-09-21']){
    OPENID=D
    await moments.main({action:'add',text:'邓林在'+day+'记的事',mood:'daily'})
    // 直接改日期为指定天，模拟不同日期记录
    const last=store.moments[store.moments.length-1]
    last.date=day; last.createdAt=day+' 20:00'
    OPENID=Q
    await moments.main({action:'add',text:'倩萍在'+day+'记的事',mood:'happy'})
    const last2=store.moments[store.moments.length-1]
    last2.date=day; last2.createdAt=day+' 21:00'
  }
  OPENID=D
  const l=await chronicle.main({action:'list'})
  assert.strictEqual(l.list.length,2,'两天都该出现')
  assert.strictEqual(l.list[0].items.length,2,'同一天两条并成一条记录')
  assert.ok(l.list[0].items[0].at,'每条都要有时间')
  ok(`2 天归成 2 组，每组含 2 条记录`)
  ok(`组内第一条：「${l.list[0].items[0].text.slice(0,14)}…」`)

  console.log('\n=== 一个人记的也该出现（这正是从打卡改随手记的关键）===')
  OPENID=D
  await moments.main({action:'add',text:'只有我一个人记的一条',mood:'daily'})
  const lastM=store.moments[store.moments.length-1]
  lastM.date='2026-09-22'; lastM.createdAt='2026-09-22 22:00'
  const l2=await chronicle.main({action:'list'})
  assert.strictEqual(l2.list.length,3,'一个人记的那天也该出现在编年史')
  ok('单人记录也进编年史（旧版要求两人都答才显示，那是打卡逻辑）')

  const s=await chronicle.main({action:'stats'})
  assert.strictEqual(s.fullDays,3); assert.strictEqual(s.totalAnswers,5)
  ok(`统计：记录了 ${s.fullDays} 天 / 总条数 ${s.totalAnswers}`)

  /* ★ 回归：记录超过 1000 条时，天数不能算少。
     旧实现是 field({date:true}).limit(1000) 然后本地去重 ——
     limit 是硬上限，第 1001 条之后的天数会被静默丢掉，
     不报错、只是数字不对。改成数据库端聚合后与条数无关。 */
  console.log('\n=== ★ 超过 1000 条记录时天数仍然准确（旧实现的静默 bug）===')
  const pid0 = store.pairs[0]._id
  const before = store.moments.length
  for (let i = 0; i < 1200; i++) {
    /* 造 1200 条，其中每 100 条换一个新日期 —— 共 12 个新日期 */
    const day = '2027-' + String(1 + Math.floor(i / 100)).padStart(2, '0') + '-15'
    store.moments.push({
      _id: 'bulk' + i, pairId: pid0, by: D, text: '批量' + i,
      photos: [], thumbs: [], mood: 'daily', date: day,
      at: day + ' 10:00', createdAt: day + ' 10:00'
    })
  }
  const s2 = await chronicle.main({ action: 'stats' })
  assert.strictEqual(s2.totalAnswers, before + 1200, '总条数应统计到全部 1200 条')
  assert.strictEqual(s2.fullDays, 3 + 12, '★ 天数应含 12 个新日期（旧实现会因 limit(1000) 算少）')
  ok(`★ 1213 条记录 / ${s2.fullDays} 天 —— 聚合不受 limit(1000) 影响（旧实现只能数到 1000 条）`)

  /* 清掉批量数据，不影响后续用例 */
  store.moments = store.moments.filter(m => String(m._id).indexOf('bulk') !== 0)

  console.log('\n=== 某天详情 ===')
  const dd=await chronicle.main({action:'day',date:'2026-09-21'})
  assert.ok(dd.mine.length && dd.partner.length)
  ok(`详情页取到双方记录（我 ${dd.mine.length} 条 / 她 ${dd.partner.length} 条）`)

  console.log('\n=== 想去·去过 ===')
  OPENID=D
  const a1=await wishes.main({action:'add',text:'一起去菜市场买菜做饭'})
  assert.ok(a1.ok)
  const w1=await wishes.main({action:'list'})
  assert.strictEqual(w1.total,1); assert.strictEqual(w1.todoCount,1); assert.strictEqual(w1.doneCount,0)
  ok('新增一件，进度 0/1')

  console.log('\n=== 不拍照不许点亮 ===')
  const bad=await wishes.main({action:'done',id:a1.id})
  assert.strictEqual(bad.ok,false)
  ok('无照片被拒：「'+bad.msg.slice(0,20)+'…」')

  const good=await wishes.main({action:'done',id:a1.id,photo:'cloud://x/wishes/1.jpg',place:'成都'})
  assert.ok(good.ok)
  const w2=await wishes.main({action:'list'})
  assert.strictEqual(w2.doneCount,1)
  assert.ok(w2.list[0].doneAt,'完成日期应自动盖上')
  ok(`点亮成功，自动盖日期 ${w2.list[0].doneAt} · 地点 成都`)

  console.log('\n=== 越权检查 ===')
  store.pairs.push({_id:'other_pair',members:['x','y'],inviteActive:false,inviteCode:'',names:{},anniversary:'',createdAt:'',pairedAt:''})
  const alien={_id:'alien_wish',pairId:'other_pair',text:'别人家的',done:false}
  store.wishes.push(alien)
  const steal=await wishes.main({action:'done',id:'alien_wish',photo:'cloud://x/y.jpg'})
  assert.strictEqual(steal.ok,false)
  ok('别人的愿望点不亮：「'+steal.msg+'」')

  console.log(`\n${'='.repeat(56)}\n  编年史 + 想去去过：全部 ${n} 项断言通过\n${'='.repeat(56)}\n`)
})().catch(e=>{console.error('\n  ✗ 失败：',e.message,'\n',e.stack.split('\n')[1]);process.exit(1)})
