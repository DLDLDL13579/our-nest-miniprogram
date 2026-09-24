/**
 * 隐私授权封装。
 *
 * 背景：app.json 里开了 __usePrivacyCheck__ 之后，
 *   调用 chooseMedia / chooseImage 这类接口前，用户必须先同意《用户隐私保护指引》。
 *   没处理的话接口会直接 fail，报错很含糊（只说 "fail"），
 *   排查时容易误以为是权限或路径问题。
 *
 * ★ 一个刻意的取舍：这里**不注册** wx.onNeedPrivacyAuthorization。
 *   注册它意味着"弹窗由我自己画"，而一旦自己画，
 *   很容易写成"用户还没点同意，代码先替他 agree 了" —— 那等于绕过授权，
 *   既不合规，也让用户失去了知情权。
 *   所以我们只用官方的 wx.requirePrivacyAuthorize，让微信弹它自己那套标准弹窗。
 */

/** 当前授权状态：'need'（需要弹窗）/ 'ok'（已同意）/ 'unknown'（判断不了） */
function check() {
  return new Promise((resolve) => {
    if (!wx.getPrivacySetting) return resolve('unknown')   // 低版本基础库没这个接口
    wx.getPrivacySetting({
      success: (res) => resolve(res.needAuthorization ? 'need' : 'ok'),
      fail: () => resolve('unknown')
    })
  })
}

/**
 * 确保已获得隐私授权。
 * 返回 true  → 可以继续调用隐私接口
 * 返回 false → 用户拒绝了，调用方应该停下来
 *
 * 容错策略：接口不存在或调用异常时返回 true，把判断交给原生接口 ——
 * 这样在没配置隐私指引的环境下不会因为我们的封装而卡死，
 * 真需要授权时微信自己会拦。
 */
function ensure() {
  return check().then((state) => {
    if (state !== 'need') return true
    if (!wx.requirePrivacyAuthorize) return true
    return new Promise((resolve) => {
      wx.requirePrivacyAuthorize({
        success: () => resolve(true),
        fail: () => {
          wx.showToast({
            title: '需要同意隐私授权才能选照片',
            icon: 'none',
            duration: 2500
          })
          resolve(false)
        }
      })
    })
  }).catch(() => true)
}

module.exports = { check, ensure }
