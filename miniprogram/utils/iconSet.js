/**
 * iconSet.js —— 页面图标装配的**唯一入口**
 *
 * ============ 为什么要有这一层 ============
 *
 * 改造前每个页面各写一段：
 *
 *     const _IC = {}
 *     for (const _k of ['speakerOn', 'speakerOff', 'target', 'dice', 'wheel']) {
 *       _IC[_k] = icons.dataUri(_k, '#E8B33C')
 *     }
 *
 * 问题是这份清单**手写、跨页面重复、和玩法注册表脱钩**：
 * 加一个玩法忘了往这里加 icon，`ic[item.icon]` 就是 undefined，
 * `<image src="{{undefined}}">` **静默不显示** —— 不报错、不警告。
 *
 * 现在玩法图标**自动并入**（读 games.js），页面只声明自己额外要的少数几个。
 * 加玩法 = 改 games.js，图标自动就有。
 *
 * ============ 为什么做成函数而不是导出一个常量对象 ============
 *
 * 常量对象没法被测试验证"它到底包含什么"（测试只能去 grep 源码写法，
 * 而"判据依赖代码长什么样"已经在本项目连错三版，见 AGENTS.md）。
 * 做成纯函数后，`scripts/test-contract.js` 可以直接调用它、
 * 断言"注册表里每个玩法图标都能拿到非空 data URI" —— 测的是**行为**，不是长相。
 */
const icons = require('./icons.js')
const { GAMES } = require('./games.js')

/** 所有玩法图标 key（从注册表派生，不手写） */
function gameIconKeys() {
  const seen = new Set()
  const out = []
  for (const g of GAMES) {
    if (!g.icon || seen.has(g.icon)) continue
    seen.add(g.icon)
    out.push(g.icon)
  }
  return out
}

/**
 * 装配一个页面的图标表。
 *
 * @param {string[]} keys  这个页面**额外**需要的图标（玩法图标会自动带上）
 * @param {string}   color 描边色
 * @returns {Object} { [key]: dataURI }，缺失的图标会是空串（icons.js 会 warn）
 */
function build(keys, color) {
  const all = []
  const seen = new Set()
  const push = (k) => { if (k && !seen.has(k)) { seen.add(k); all.push(k) } }

  ;(keys || []).forEach(push)
  gameIconKeys().forEach(push)

  const out = {}
  for (const k of all) out[k] = icons.dataUri(k, color || '#C4553F')
  return out
}

module.exports = { build, gameIconKeys }
