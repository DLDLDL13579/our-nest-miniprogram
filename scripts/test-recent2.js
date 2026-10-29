const path=require('path'), assert=require('assert')
let store={recentGames:['poker','liar','wheel']}
let pageObj=null
global.Page=(o)=>{pageObj=o}
global.getApp=()=>({globalData:{bootAt:null}})
global.wx={getStorageSync:(k)=>store[k],setStorageSync:(k,v)=>{store[k]=v},removeStorageSync:(k)=>{delete store[k]},createInnerAudioContext:()=>({playbackRate:1,volume:1,play(){},stop(){},destroy(){},onEnded(){},onError(){},set src(v){this._s=v},get src(){return this._s}}),getSystemInfoSync:()=>({}),showToast:()=>{},navigateTo:()=>{}}
require(path.join(__dirname,'..','miniprogram/pages/lobby/lobby.js'))
const p=Object.assign(Object.create(pageObj),{data:JSON.parse(JSON.stringify(pageObj.data)),setData(x){Object.assign(this.data,x)}})
p.onShow()
const list=p.data.list
console.log('顺序:', list.map(g=>g.id).join(' → '))
console.log('标"上次"的:', list.filter(g=>g.recent).map(g=>g.id).join(',') || '(无)')
assert.deepStrictEqual(list.slice(0,3).map(g=>g.id), ['poker','liar','wheel'], '三个最近的应在最前')
assert.strictEqual(list.filter(g=>g.recent).length, 1, '★ 只有最新那个该标「上次」')
assert.strictEqual(list[0].recent, true, '最新的那个要标')
console.log('✓ 三个排前面、只有最新的标「上次」')
