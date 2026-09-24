/**
 * 图片上传：一次上传，同时产出「缩略图」和「原图」
 *
 * 为什么必须这么做：
 *   手机拍的照片动辄 3~5MB。列表里如果直接加载原图，
 *   首页一屏 2 张就是 10MB 流量 —— 这才是"使用中反应慢"的真凶，
 *   比云函数调用慢得多。
 *
 * 做法：上传前先压缩出一个小图，两张一起传：
 *   moments/{ts}.jpg        原图 —— 点开看大图时才加载
 *   moments/{ts}_thumb.jpg  缩略图 —— 列表里只加载它（几十 KB）
 *
 * 为什么不用「云存储 URL 加参数」那条路：
 *   fileID（cloud://...）不能拼图片处理参数，必须先换成 https 临时链接，
 *   而换链接是异步的、每张一次请求 —— 列表里 10 张图就是 10 次额外往返，
 *   反而更慢。存的时候就分开存，列表里直接用 fileID，零额外请求。
 */
const THUMB_WIDTH = 400      // 列表显示宽度约 300rpx，400px 足够清晰
const THUMB_QUALITY = 70

/** 压出一张缩略图，返回临时路径 */
function compress(filePath) {
  return new Promise((resolve) => {
    if (!wx.compressImage) return resolve(filePath)   // 老基础库，退回原图
    wx.compressImage({
      src: filePath,
      quality: THUMB_QUALITY,
      compressedWidth: THUMB_WIDTH,
      success: (res) => resolve(res.tempFilePath || filePath),
      fail: () => resolve(filePath)                   // 压缩失败就用原图，别阻断上传
    })
  })
}

function uploadOne(filePath, cloudPath) {
  return new Promise((resolve, reject) => {
    wx.cloud.uploadFile({
      cloudPath,
      filePath,
      success: (r) => resolve(r.fileID),
      fail: reject
    })
  })
}

/**
 * 上传一张图，返回 { full, thumb }
 * 调用方把 full 和 thumb 都存进数据库，列表用 thumb、点开用 full。
 */
async function uploadWithThumb(tempFilePath, prefix) {
  const ext = (tempFilePath.split('.').pop() || 'jpg').toLowerCase()
  const base = prefix + '/' + Date.now() + '-' + Math.floor(Math.random() * 1e6)
  const fullPath = base + '.' + ext
  const thumbPath = base + '_thumb.' + ext

  const full = await uploadOne(tempFilePath, fullPath)

  /* 缩略图失败不算整体失败 —— 退回用原图当缩略图，功能不受影响 */
  let thumb = full
  try {
    const small = await compress(tempFilePath)
    if (small && small !== tempFilePath) {
      thumb = await uploadOne(small, thumbPath)
    } else {
      thumb = full
    }
  } catch (e) {
    thumb = full
  }

  return { full, thumb }
}

module.exports = { uploadWithThumb }
