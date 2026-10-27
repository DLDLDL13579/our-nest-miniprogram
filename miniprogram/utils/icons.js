/**
 * icons.js —— 内联 SVG 图标库
 *
 * ============ 为什么不用 emoji ============
 *
 * 2026-10-08 全面审查实测：项目里有 **31 种 emoji、56 个使用点**（18 个文件）。
 * emoji 在小程序上是**最大的专业度破绽**，原因有三：
 *
 *   ① **跨机型完全不一致**。iOS 渲染成彩色立体（Apple Color Emoji），
 *      Android 渲染成黑白单色（Noto Emoji）。同一个 📅，
 *      在你手机上好看，在别人（尤其安卓）手机上是个方块或黑白图标。
 *   ② **无法控制颜色**。emoji 的颜色由系统决定，改不了 —— 放进精心设计的
 *      配色体系里会显得很脏（首页的 🎲 橙红、📡 蓝紫，和米白暖色调完全打架）。
 *   ③ **尺寸基线不一致**。不同 emoji 的视觉大小差别很大
 *      （🎲 比 ✉️ 视觉重得多），排列在一起时基线对不齐。
 *
 * ============ 为什么是「内联 base64 SVG」而不是图片文件 ============
 *
 *   · SVG 图片文件：每个图标一个文件，包体积 +、跨机型一致 ✓
 *   · **内联 base64**（本方案）：图标是 JS 里的字符串，
 *     用 `<image src="data:image/svg+xml;base64,...">` 渲染。
 *     好处是能用 `currentColor` 之外的方式精确控制（我们直接控制 SVG 内填色），
 *     而且**集中在一处**、便于统一调色与换肤。
 *
 *   代价是体积：每个图标约 200~400 字节 base64，31 个 ≈ 9 KB，
 *   相比 emoji 换来的一致性，这点体积完全值得。
 *
 * ============ 颜色策略 ============
 *
 * 全部图标用**单色 + currentColor 思路**：SVG 内填 `currentColor`，
 * 由外层容器的 `color` 决定颜色。这样：
 *   · 主题色统一（跟随 app.wxss 的 --ink 系列变量）
 *   · 状态变化只需改 color，不用换图
 *
 * 所有路径统一 24×24 视口、2px 线宽（与主流图标库一致），视觉重量统一。
 */

/** 图标路径表（24×24 viewBox，stroke 风格，描边色 currentColor） */
const PATHS = {
  /* ---------- 界面 ---------- */
  close: '<path d="M6 6l12 12M18 6L6 18"/>',
  check: '<path d="M4 12.5l5.2 5.2L20 7"/>',
  chevronDown: '<path d="M6 9.5l6 6 6-6"/>',
  chevronRight: '<path d="M9.5 6l6 6-6 6"/>',
  arrowRight: '<path d="M4 12h15M13 6l6 6-6 6"/>',
  arrowDown: '<path d="M12 4v15M6 13l6 6 6-6"/>',

  /* ---------- 状态 / 提示 ---------- */
  heart: '<path d="M12 20.5C7 16.8 3.5 13.6 3.5 9.9A4.4 4.4 0 0 1 12 7.4a4.4 4.4 0 0 1 8.5 2.5c0 3.7-3.5 6.9-8.5 10.6z"/>',
  lock: '<rect x="4.5" y="10.5" width="15" height="10" rx="2.4"/><path d="M8 10.5V7.4a4 4 0 0 1 8 0v3.1"/>',
  bell: '<path d="M6.5 10a5.5 5.5 0 0 1 11 0c0 4 1.6 5.5 1.6 5.5H4.9S6.5 14 6.5 10z"/><path d="M10 18.5a2.2 2.2 0 0 0 4 0"/>',
  bulb: '<path d="M9 17.5h6M10 21h4"/><path d="M12 3a6 6 0 0 1 3.6 10.8c-.6.5-1 1.2-1 2h-5.2c0-.8-.4-1.5-1-2A6 6 0 0 1 12 3z"/>',

  /* ---------- 声音 ---------- */
  speakerOn: '<path d="M4 9.5h3l4-3.2v11.4l-4-3.2H4z"/><path d="M14.5 9a4.2 4.2 0 0 1 0 6"/><path d="M17 6.6a7.6 7.6 0 0 1 0 10.8"/>',
  speakerOff: '<path d="M4 9.5h3l4-3.2v11.4l-4-3.2H4z"/><path d="M15 9.5l4.5 5M19.5 9.5L15 14.5"/>',
  hapticOn: '<rect x="8" y="3.5" width="8" height="17" rx="2"/><path d="M5.5 8.5v3M2.8 10v0M18.5 8.5v3M21.2 10v0"/>',
  hapticOff: '<rect x="8" y="3.5" width="8" height="17" rx="2"/><path d="M3 3l18 18"/>',

  /* ---------- 内容类型 ---------- */
  mail: '<rect x="3" y="5.5" width="18" height="13" rx="2.2"/><path d="M3.6 7l8.4 6 8.4-6"/>',
  calendar: '<rect x="3.5" y="5" width="17" height="15.5" rx="2.2"/><path d="M3.5 9.6h17M8 3v4M16 3v4"/>',
  calendarAlt: '<rect x="3.5" y="5" width="17" height="15.5" rx="2.2"/><path d="M7.5 3v4M16.5 3v4M3.5 10h17"/><circle cx="8.5" cy="14.5" r="1"/><circle cx="13" cy="14.5" r="1"/>',
  flag: '<path d="M6 21V4M6 4.5h11l-2 3.5 2 3.5H6"/>',
  book: '<path d="M12 6.5S9.8 4.5 6 4.5c-1 0-1.8.2-2 .3v13.4c.2-.1 1-.3 2-.3 3.8 0 6 2 6 2s2.2-2 6-2c1 0 1.8.2 2 .3V4.8c-.2-.1-1-.3-2-.3-3.8 0-6 2-6 2z"/><path d="M12 6.5v13.4"/>',
  candle: '<path d="M12 2.5c1.9 2 2.8 3.4 2.8 4.6a2.8 2.8 0 0 1-5.6 0c0-1.2.9-2.6 2.8-4.6z"/><path d="M8.6 10.2h6.8v2H8.6z"/><path d="M9.6 12.2h4.8v8.3H9.6z"/>',
  balloon: '<path d="M12 3.2a5.8 5.8 0 0 1 5.8 5.8c0 3.6-2.6 6.4-5.8 7.3-3.2-.9-5.8-3.7-5.8-7.3A5.8 5.8 0 0 1 12 3.2z"/><path d="M12 16.5v1.5"/>',
  dove: '<path d="M20.5 5.5c-3.2.6-5.6 2.3-7.2 4.8-1.4 2.2-2.4 4.6-4.6 5.6-1.5.7-3 .6-4.2.4 1.2 1.6 3 2.7 5 3.2 3.2.8 6.5-.2 8.5-2.4 1.4-1.6 2.3-3.7 2.5-6.2.2-2.2.1-4-.5-5.4z"/>',
  leaf: '<path d="M20 4c0 9-5.4 14-11 14a6 6 0 0 1-5-2.6C6 9.6 12 6.2 20 4z"/><path d="M4.5 20c1.5-4.5 4.5-8 9-9.8"/>',
  sparkle: '<path d="M12 3.5l1.9 5.1 5.1 1.9-5.1 1.9L12 17.5l-1.9-5.1L5 10.5l5.1-1.9z"/><path d="M18.5 16.5l.8 2.2 2.2.8-2.2.8-.8 2.2-.8-2.2-2.2-.8 2.2-.8z"/>',
  sunCloud: '<circle cx="7.5" cy="7.5" r="2.8"/><path d="M7.5 2.2v1.4M2.9 7.5H1.5M4 4l-1-1M11 4l1-1"/><path d="M10 20.5h8.6a3.4 3.4 0 0 0 .2-6.8 4.8 4.8 0 0 0-9.2-.8 3.8 3.8 0 0 0 .4 7.6z"/>',
  home: '<path d="M3.5 10.5L12 3.5l8.5 7"/><path d="M5.5 9.5v10.5h13V9.5"/><path d="M10 20v-5.5h4V20"/>',
  pen: '<path d="M4 20l1-4.5L15.6 4.9a2.3 2.3 0 0 1 3.2 3.2L8.3 18.5z"/><path d="M14.5 6l3.2 3.2"/>',
  pencilLine: '<path d="M4 20l1-4.5L15.6 4.9a2.3 2.3 0 0 1 3.2 3.2L8.3 18.5z"/><path d="M4 20h4.5"/>',
  camera: '<path d="M3.5 8.5h3.6l1.4-2.4h7l1.4 2.4h3.6v11H3.5z"/><circle cx="12" cy="13.4" r="3.4"/>',
  pin: '<path d="M12 21.5s7-6.4 7-11a7 7 0 1 0-14 0c0 4.6 7 11 7 11z"/><circle cx="12" cy="10.4" r="2.6"/>',
  speech: '<path d="M4 5.5h16v11H9.5L5.5 20v-3.5H4z"/>',
  beer: '<path d="M5.5 7.5h9v11a2 2 0 0 1-2 2h-5a2 2 0 0 1-2-2z"/><path d="M14.5 10h2.2a2.3 2.3 0 0 1 0 4.6h-2.2"/><path d="M7.5 4.2v3.3M10.5 4.2v3.3"/>',

  /* ---------- 游戏 ---------- */
  dice: '<rect x="3.5" y="3.5" width="17" height="17" rx="3.4"/><circle cx="8.3" cy="8.3" r="1.35" fill="currentColor" stroke="none"/><circle cx="15.7" cy="8.3" r="1.35" fill="currentColor" stroke="none"/><circle cx="12" cy="12" r="1.35" fill="currentColor" stroke="none"/><circle cx="8.3" cy="15.7" r="1.35" fill="currentColor" stroke="none"/><circle cx="15.7" cy="15.7" r="1.35" fill="currentColor" stroke="none"/>',
  cup: '<path d="M6 9h12l-1.3 10.2a2 2 0 0 1-2 1.8H9.3a2 2 0 0 1-2-1.8z"/><path d="M5 9h14"/><path d="M8.5 6.2a3.5 3.5 0 0 1 7 0"/>',
  target: '<circle cx="12" cy="12" r="8.5"/><circle cx="12" cy="12" r="4.8"/><circle cx="12" cy="12" r="1.4" fill="currentColor" stroke="none"/>',
  wheel: '<circle cx="12" cy="12" r="8.5"/><path d="M12 3.5v17M3.5 12h17M6 6l12 12M18 6L6 18"/><circle cx="12" cy="12" r="2" fill="currentColor" stroke="none"/>',
  signal: '<path d="M4.5 9.5a11 11 0 0 1 0 5"/><path d="M8 12.5a6.6 6.6 0 0 1 0-1"/><path d="M11.6 15.2a2.4 2.4 0 0 1 0-6.4"/><path d="M18.5 6a15.5 15.5 0 0 1 0 12"/>',
  /* 竖起的手指 = 「我有你没有」的"我有" */
  hand: '<path d="M8.8 13.2V6.4a1.5 1.5 0 0 1 3 0V12"/><path d="M11.8 12V4.9a1.5 1.5 0 0 1 3 0V11.8"/><path d="M14.8 11.8V7.2a1.5 1.5 0 0 1 3 0v8a6.2 6.2 0 0 1-6.2 6.2h-.8a4.6 4.6 0 0 1-3.3-1.4l-3.7-3.8a1.6 1.6 0 0 1 2.3-2.3l2.2 2.1"/>',
  /* 面具 = 「谁是卧底」这类秘密身份玩法 */
  mask: '<path d="M4 8.6c2.6-1 5.3-1.5 8-1.5s5.4.5 8 1.5c0 4.6-3.6 8.2-8 8.2S4 13.2 4 8.6z"/><circle cx="8.7" cy="10.9" r="1.15" fill="currentColor" stroke="none"/><circle cx="15.3" cy="10.9" r="1.15" fill="currentColor" stroke="none"/>',
  /* 两张叠起来的扑克 = 牌类玩法 */
  cards: '<rect x="3.6" y="6.4" width="11" height="15.2" rx="2" transform="rotate(-9 9.1 14)"/><rect x="9.4" y="4.2" width="11" height="15.2" rx="2"/><path d="M14.9 9.4l1.1 2.4 2.4 1.1-2.4 1.1-1.1 2.4-1.1-2.4-2.4-1.1 2.4-1.1z" fill="currentColor" stroke="none"/>',
  /* 投票箱 */
  vote: '<path d="M5 11.5h14v8H5z"/><path d="M8.6 11.5V6.6a3.4 3.4 0 0 1 6.8 0v4.9"/><path d="M9.9 8.9l2.1 2.1 2.1-2.1"/>',

  /* ---------- 情绪 ---------- */
  moodHappy: '<circle cx="12" cy="12" r="8.6"/><path d="M8.4 14.2a4.4 4.4 0 0 0 7.2 0"/><circle cx="9.2" cy="9.6" r="1" fill="currentColor" stroke="none"/><circle cx="14.8" cy="9.6" r="1" fill="currentColor" stroke="none"/>',
  moodMiss: '<circle cx="12" cy="12" r="8.6"/><path d="M9.6 16.2a4 4 0 0 1 4.8 0"/><circle cx="9.2" cy="9.6" r="1" fill="currentColor" stroke="none"/><circle cx="14.8" cy="9.6" r="1" fill="currentColor" stroke="none"/>',
  moodDaily: '<path d="M12 3.5c-2.5 0-4.2 2-4.2 4.3 0 3 4.2 8.7 4.2 8.7s4.2-5.7 4.2-8.7c0-2.3-1.7-4.3-4.2-4.3z"/>',
  moodMoved: '<path d="M12 20.5s-8-4.8-8-10.2A4.6 4.6 0 0 1 12 7.4a4.6 4.6 0 0 1 8 2.9c0 5.4-8 10.2-8 10.2z"/><path d="M9 11.2l2 2 4-4"/>',
  moodAnnoyed: '<circle cx="12" cy="12" r="8.6"/><path d="M8.8 16.4a4.4 4.4 0 0 1 6.4 0"/><path d="M8.4 9.2l2.6 1.6M15.6 9.2L13 10.8"/>'
}

/**
 * 生成一个图标的 data URI（可直接给 `<image src>` 用）。
 *
 * @param {string} name  PATHS 里的键
 * @param {string} color 描边色（默认跟随文字色 currentColor）
 * @param {number} w,h   输出尺寸（默认 24，即矢量无损）
 */
function dataUri(name, color, w, h) {
  const body = PATHS[name]
  if (!body) {
    console.warn('[icons] 没有这个图标:', name)
    return ''
  }
  const svg =
    '<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 24 24" ' +
    'width="' + (w || 24) + '" height="' + (h || 24) + '" ' +
    'fill="none" stroke="' + (color || 'currentColor') + '" ' +
    'stroke-width="2" stroke-linecap="round" stroke-linejoin="round">' +
    body + '</svg>'
  /* 小程序的 <image> 支持 data URI；用 encodeURIComponent 更安全（base64 需 btoa，wxml 里没有） */
  return 'data:image/svg+xml,' + encodeURIComponent(svg)
}

/** 图标清单（给断言/文档用） */
function list() {
  return Object.keys(PATHS)
}

module.exports = { dataUri, list, PATHS }