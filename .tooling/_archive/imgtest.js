/** 验证：云存储 fileID 能否走图片处理参数（缩略图） */
const automator = require('miniprogram-automator')
const path = require('path')
;(async () => {
  const mini = await automator.launch({
    cliPath: '/Applications/wechatwebdevtools.app/Contents/MacOS/cli',
    projectPath: path.join(__dirname, '..'), timeout: 90000
  })
  console.log('✓ 已连上')

  const r = await mini.evaluate(`(async function(){
    var out = {};
    // 拿一条有照片的记录
    var list = await new Promise(function(res){ wx.cloud.callFunction({name:'moments',data:{action:'list',size:10},success:function(x){res(x.result)}}) });
    var withPhoto = (list.list||[]).filter(function(m){ return m.photos && m.photos.length });
    out.有照片的记录数 = withPhoto.length;
    if (!withPhoto.length) { out.msg = '库里还没有带照片的记录，无法测'; return out; }
    var fid = withPhoto[0].photos[0];
    out.fileID前缀 = fid.slice(0, 30);
    // 换 HTTPS 临时链接
    var urls = await new Promise(function(res){ wx.cloud.getTempFileURL({ fileList:[fid], success:function(x){res(x.fileList)}, fail:function(e){res([{err:e}])} }) });
    out.临时链接OK = !!(urls[0] && urls[0].tempFileURL);
    if (urls[0] && urls[0].tempFileURL) out.https前缀 = urls[0].tempFileURL.slice(0, 60);
    return out;
  })()`)
  console.log(JSON.stringify(r, null, 2))
  await mini.disconnect()
})().catch(e => { console.error('✗', e.message); process.exit(1) })
