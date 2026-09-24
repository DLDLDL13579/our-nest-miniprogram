const app = getApp()
const { call } = require('../../utils/cloud.js')
const privacy = require('../../utils/privacy.js')
const media = require('../../utils/media.js')

const MOODS = [
  { k: 'happy',   e: '😊', t: '开心' },
  { k: 'miss',    e: '💗', t: '想你' },
  { k: 'daily',   e: '🍚', t: '日常' },
  { k: 'moved',   e: '🥹', t: '感动' },
  { k: 'annoyed', e: '😤', t: '生气' }
]

/* 没头绪时点一下，给个引子 —— 但不能变成"每天必须回答的问题"，
   所以它只是提示文字，写不写、写什么都随你 */
const SPARKS = [
  '今天她做的哪件小事让你心里一暖？',
  '今天有什么想吐槽的？',
  '今天吃到了什么好吃的？',
  '今天有没有哪个瞬间想拍下来？',
  '今天她那句话让你记到现在？',
  '今天想跟她说但没说出口的是什么？',
  '今天你们一起做了什么？',
  '今天她穿了什么让你多看了一眼？'
]

Page({
  data: {
    text: '', photos: [], thumbs: [], mood: 'daily',
    moods: MOODS, uploading: false, saving: false,
    left: 500, solo: false, spark: '', partnerName: 'TA'
  },

  async onLoad() {
    const pair = await app.ensurePair()
    this.setData({ solo: !(pair && pair.partnerName), partnerName: (pair && pair.partnerName) || 'TA' })
    this.setData({ spark: SPARKS[Math.floor(Math.random() * SPARKS.length)] })
  },

  onInput(e) {
    const v = e.detail.value
    this.setData({ text: v, left: 500 - v.length })
  },

  pickMood(e) { this.setData({ mood: e.currentTarget.dataset.k }) },

  nextSpark() {
    let s = this.data.spark
    while (s === this.data.spark) s = SPARKS[Math.floor(Math.random() * SPARKS.length)]
    this.setData({ spark: s })
  },

  /* 拍照 / 选图 —— 最多 3 张，多了就不"随手"了 */
  async addPhoto() {
    const rest = 3 - this.data.photos.length
    if (rest <= 0) return wx.showToast({ title: '最多 3 张', icon: 'none' })

    /* 开了 __usePrivacyCheck__ 之后，选图前必须先拿到隐私授权，否则接口直接 fail */
    const allowed = await privacy.ensure()
    if (!allowed) return

    wx.chooseMedia({
      count: rest, mediaType: ['image'], sourceType: ['camera', 'album'],
      sizeType: ['compressed'], camera: 'back',
      success: async (res) => {
        this.setData({ uploading: true })
        const list = this.data.photos.slice()
        const thumbs = this.data.thumbs.slice()
        for (const f of res.tempFiles) {
          try {
            /* 一次上传同时得到原图和缩略图：列表用小图，点开才加载原图 */
            const up = await media.uploadWithThumb(f.tempFilePath, 'moments')
            list.push(up.full)
            thumbs.push(up.thumb)
          } catch (e) {
            wx.showToast({ title: '有一张没传上去', icon: 'none' })
          }
        }
        this.setData({ photos: list, thumbs: thumbs, uploading: false })
      }
    })
  },

  previewPhoto(e) {
    /* 预览一定用原图 —— 缩略图放大看是糊的 */
    wx.previewImage({ current: e.currentTarget.dataset.src, urls: this.data.photos })
  },

  delPhoto(e) {
    const i = e.currentTarget.dataset.i
    const list = this.data.photos.slice()
    const th = this.data.thumbs.slice()
    list.splice(i, 1)
    th.splice(i, 1)          // 两个数组必须同步，否则缩略图会错位
    this.setData({ photos: list, thumbs: th })
  },

  async save() {
    const text = (this.data.text || '').trim()
    if (!text && !this.data.photos.length) {
      return wx.showToast({ title: '写点什么，或者放张照片', icon: 'none' })
    }
    if (this.data.saving) return
    this.setData({ saving: true })

    const r = await call('moments', {
      action: 'add', text, photos: this.data.photos,
      thumbs: this.data.thumbs, mood: this.data.mood
    }, { loading: '记下来' })
      .catch((e) => { wx.showToast({ title: (e && e.friendly) || '操作失败', icon: 'none', duration: 2500 }); return null })

    this.setData({ saving: false })
    if (r) {
      wx.showToast({ title: '记下了', icon: 'success' })
      setTimeout(() => wx.navigateBack(), 700)
    }
  },

  cancel() { wx.navigateBack() }
})
