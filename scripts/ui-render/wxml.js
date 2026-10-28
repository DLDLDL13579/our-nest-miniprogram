/**
 * 极简 WXML → HTML 转换器（只为「界面审查」服务，不是小程序运行时）
 *
 * 为什么需要它：
 *   本机禁止开微信开发者工具（用户硬约束），automator 也依赖 IDE。
 *   但界面审查必须**看见真实界面**，不能靠读代码猜。
 *   所以把真实的 .wxml + .wxss 直接转成 HTML + CSS，用无头 Chrome 截图。
 *
 * ★ 关键要求：必须渲染**真实文件内容**，不能手抄一份副本。
 *   （AGENTS.md 记过：test-game.js 曾抄逻辑来测，页面一删就测的是自己抄的副本，
 *     "一直全绿却和线上毫无关系" —— 比没有测试更危险。）
 *
 * 支持的 WXML 子集（已覆盖本项目 100% 用法，见 scripts/render-ui.js 的自检）：
 *   {{expr}} 插值（文本内混排 / 整属性值）
 *   wx:if / wx:elif / wx:else（含条件链互斥）
 *   wx:for / wx:for-item / wx:for-index / wx:key
 *   block（不产出标签）
 *   自闭合标签、布尔属性
 *
 * 标签映射：view→div  text→span  image→img  block→透明
 *           input→input  textarea→textarea  picker/scroll-view→div
 */

/* ---------------- 解析 ---------------- */

/** 在属性值里可能有 `>`（如 `{{a.length > 0}}`），所以不能简单 indexOf('>') */
function findTagEnd(src, from) {
  let quote = null
  for (let i = from; i < src.length; i++) {
    const c = src[i]
    if (quote) {
      if (c === quote) quote = null
    } else if (c === '"' || c === "'") {
      quote = c
    } else if (c === '>') {
      return i
    }
  }
  return -1
}

/** 解析属性串：`a="1" b='2' c {{x}}` */
function parseAttrs(s) {
  const attrs = {}
  let i = 0
  while (i < s.length) {
    while (i < s.length && /\s/.test(s[i])) i++
    if (i >= s.length) break
    let name = ''
    while (i < s.length && !/[\s=]/.test(s[i])) name += s[i++]
    while (i < s.length && /\s/.test(s[i])) i++
    if (s[i] === '=') {
      i++
      while (i < s.length && /\s/.test(s[i])) i++
      let val = ''
      if (s[i] === '"' || s[i] === "'") {
        const q = s[i++]
        while (i < s.length && s[i] !== q) val += s[i++]
        i++
      } else {
        while (i < s.length && !/\s/.test(s[i])) val += s[i++]
      }
      attrs[name] = val
    } else if (name) {
      attrs[name] = true
    }
  }
  return attrs
}

function parseWxml(src) {
  src = String(src).replace(/<!--[\s\S]*?-->/g, '')
  const root = { type: 'root', children: [] }
  const stack = [root]
  let i = 0
  const pushText = (t) => {
    if (t) stack[stack.length - 1].children.push({ type: 'text', text: t })
  }

  while (i < src.length) {
    const lt = src.indexOf('<', i)
    if (lt < 0) { pushText(src.slice(i)); break }
    if (lt > i) pushText(src.slice(i, lt))

    const end = findTagEnd(src, lt)
    if (end < 0) { pushText(src.slice(lt)); break }
    const inner = src.slice(lt + 1, end)
    i = end + 1

    // 结束标签
    if (inner[0] === '/') {
      const name = inner.slice(1).trim()
      // 弹出到匹配的层级（容错：找不到就忽略）
      for (let k = stack.length - 1; k > 0; k--) {
        if (stack[k].tag === name) { stack.length = k; break }
      }
      continue
    }

    // 自闭合或普通开标签
    const selfClose = /\/$/.test(inner)
    const body = selfClose ? inner.slice(0, -1) : inner
    const m = /^([a-zA-Z][\w-]*)/.exec(body)
    if (!m) continue
    const tag = m[1]
    const attrs = parseAttrs(body.slice(tag.length))
    const node = { type: 'el', tag, attrs, children: [] }
    stack[stack.length - 1].children.push(node)
    if (!selfClose) stack.push(node)
  }
  return root
}

/* ---------------- 求值 ---------------- */

/**
 * 小程序模板对不存在的字段是**静默的**（渲染成空/假）。
 * 普通 JS 求值会抛 ReferenceError，所以用 Proxy 让所有未知标识符解析成 undefined。
 * 这样渲染结果才和小程序真实行为一致 —— 否则「幽灵字段」会直接报错，
 * 我们就看不到「页面照常渲染、只是少了一块」这个真实症状了。
 */
function makeScope(obj, parent) {
  const base = Object.assign(Object.create(parent || null), obj || {})
  return new Proxy(base, {
    has: () => true,
    get(t, k) {
      if (k === Symbol.unscopables) return undefined
      return t[k]
    }
  })
}

const warn = []
/*
 * placeholder-style 收集器。
 *
 * 小程序的 input/textarea 支持 `placeholder-style="font-size:28rpx;..."`，
 * 这是**内联**覆盖 —— 优先级高于任何 class，也是最可靠的一种写法
 * （placeholder-class 在部分基础库上不生效）。
 * HTML 里只能通过 ::placeholder 伪元素表达，所以这里给每个输入框生成
 * 一个唯一类名 + 一条规则，最后统一注入。
 */
let phSeq = 0
const phRules = []
function resetPhRules() { phRules = []; }  // eslint-disable-line no-func-assign
function takePhCss() { return phRules.join('\n') }
function evalExpr(expr, scope) {
  try {
    // eslint-disable-next-line no-new-func
    const fn = new Function('__s', 'with(__s){ return (' + expr + ') }')
    return fn(scope)
  } catch (e) {
    warn.push('表达式求值失败: ' + expr + ' → ' + e.message)
    return undefined
  }
}

/** 把含 {{}} 的字符串求值：整串就是一个表达式时保留原型，否则拼接成字符串 */
function interpolate(raw, scope) {
  if (typeof raw !== 'string') return raw
  const whole = /^\{\{([\s\S]*?)\}\}$/.exec(raw.trim())
  if (whole) return evalExpr(whole[1], scope)

  return raw.replace(/\{\{([\s\S]*?)\}\}/g, (_, e) => {
    const v = evalExpr(e, scope)
    return v === undefined || v === null ? '' : String(v)
  })
}

/* ---------------- 渲染 ---------------- */

const TAG_MAP = {
  view: 'div', text: 'span', image: 'img', scrollview: 'div',
  'scroll-view': 'div', picker: 'div', navigator: 'div', button: 'button'
}

/**
 * 把小程序里的资源绝对路径（`/images/dice/dice-5.png`）解析成 **file:// 绝对路径**。
 *
 * ★ 为什么必须做：预览页是用 `file://` 打开一个临时 HTML，
 *   而 `/images/...` 这种以 `/` 开头的路径在 file:// 下指向**文件系统根目录**，
 *   于是所有图片都变成碎图 —— 而且页面不报错，只是"图不显示"。
 *   这个缺陷让"骰盅 / 骰子"这类必须看图的预览**一直不可信**。
 */
const MINIPROGRAM_ROOT = require('path').resolve(__dirname, '..', '..', 'miniprogram')
function resolveAsset(src) {
  if (!src || typeof src !== 'string') return src
  /* data: / http(s) / 已经是 file: 的原样返回 */
  if (/^(data:|https?:|file:|blob:)/.test(src)) return src
  if (src.startsWith('/')) {
    return 'file://' + require('path').join(MINIPROGRAM_ROOT, src)
  }
  return src
}

function esc(s) {
  return String(s).replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;')
}

function attrVal(v, scope) {
  return interpolate(v, scope)
}

/** 处理一组兄弟节点的条件链（wx:if / wx:elif / wx:else 互斥） */
function renderChildren(children, scope, out) {
  let i = 0
  while (i < children.length) {
    const node = children[i]

    // 条件链
    if (node.type === 'el' && 'wx:if' in node.attrs) {
      const chain = [node]
      let j = i + 1
      while (j < children.length) {
        const n = children[j]
        // ★ 标签之间的换行/缩进也是 text 节点，必须跳过，
        //   否则 `<block wx:if>` 与 `<block wx:else>` 之间隔着一个空白 text
        //   就收不成一条链 —— 结果是 if 和 else 两个分支**同时渲染**。
        //   （本工具第一版就踩了这个，截图里 hero 同时显示了"945 天"和"还没选那天"。）
        if (n.type === 'text' && !n.text.trim()) { j++; continue }
        if (n.type === 'el' && ('wx:elif' in n.attrs || 'wx:else' in n.attrs)) {
          chain.push(n); j++
        } else break
      }
      for (const n of chain) {
        let pass
        if ('wx:if' in n.attrs) pass = !!attrVal(n.attrs['wx:if'], scope)
        else if ('wx:elif' in n.attrs) pass = !!attrVal(n.attrs['wx:elif'], scope)
        else pass = true
        if (pass) { renderNode(n, scope, out); break }
      }
      i = j
      continue
    }

    renderNode(node, scope, out)
    i++
  }
}

function renderNode(node, scope, out) {
  if (node.type === 'text') {
    const t = interpolate(node.text, scope)
    if (t !== '' && t !== null && t !== undefined) out.push(esc(t))
    return
  }

  const a = node.attrs || {}

  // wx:for 优先于自身其他属性
  if ('wx:for' in a) {
    const itemName = a['wx:for-item'] || 'item'
    const idxName = a['wx:for-index'] || 'index'
    let list = attrVal(a['wx:for'], scope)
    if (typeof list === 'number') list = Array.from({ length: list }, (_, k) => k)
    if (!list || typeof list.length !== 'number') list = []
    const clone = { type: 'el', tag: node.tag, attrs: Object.assign({}, a), children: node.children }
    delete clone.attrs['wx:for']
    delete clone.attrs['wx:for-item']
    delete clone.attrs['wx:for-index']
    delete clone.attrs['wx:key']
    for (let k = 0; k < list.length; k++) {
      const s2 = makeScope({ [itemName]: list[k], [idxName]: k }, scope)
      renderNodeSingular(clone, s2, out)
    }
    return
  }

  renderNodeSingular(node, scope, out)
}

function renderNodeSingular(node, scope, out) {
  const a = node.attrs || {}

  // block 只做逻辑分组
  if (node.tag === 'block') {
    renderChildren(node.children, scope, out)
    return
  }

  // 跳过条件/循环指令残留
  const clean = {}
  for (const k of Object.keys(a)) {
    if (k.startsWith('wx:')) continue
    if (/^(bind|catch|mut-bind|capture-)/.test(k)) continue
    if (/^data-/.test(k)) continue
    clean[k] = a[k]
  }

  let tag = TAG_MAP[node.tag] || 'div'
  if (node.tag === 'image') tag = 'img'

  // class / style
  const cls = clean.class ? String(attrVal(clean.class, scope) || '') : ''
  const style = clean.style ? String(attrVal(clean.style, scope) || '') : ''

  const parts = []
  if (cls.trim()) parts.push(`class="${esc(cls.trim())}"`)
  if (style.trim()) parts.push(`style="${esc(style.trim())}"`)

  if (tag === 'img') {
    const src = clean.src ? String(attrVal(clean.src, scope) || '') : ''
    if (src) parts.push(`src="${esc(resolveAsset(src))}"`)
    // 小程序 <image mode> 的语义映射到 CSS
    const mode = clean.mode ? String(attrVal(clean.mode, scope) || '') : 'scaleToFill'
    const fit = { aspectFit: 'contain', aspectFill: 'cover', scaleToFill: 'fill', widthFix: 'contain' }[mode] || 'fill'
    parts.push(`data-mode="${esc(mode)}"`)
    parts.push(`style="object-fit:${fit};${esc(style)}"`)
    // 上面已经加过 style，去掉重复那一条的原始 style
    const fixed = parts.filter((p, idx) => !(p.startsWith('style="') && idx !== parts.length - 1))
    out.push(`<${tag} ${fixed.join(' ')}>`)
    return
  }

  /* ★ 必须判 node.tag 而不是映射后的 tag：
     TAG_MAP 里没有 input/textarea 条目，映射后 tag 已经是 'div'，
     用映射后的值判断会导致输入框**整个不渲染**（界面上是空白，且不报错）。 */
  if (node.tag === 'input') {
    const v = clean.value !== undefined ? String(attrVal(clean.value, scope) ?? '') : ''
    const ph = clean.placeholder ? String(attrVal(clean.placeholder, scope) ?? '') : ''
    const ml = clean.maxlength ? String(attrVal(clean.maxlength, scope)) : ''
    const phStyle = clean['placeholder-style'] ? String(attrVal(clean['placeholder-style'], scope) || '') : ''
    let phCls = ''
    if (phStyle) {
      phCls = 'phx' + (++phSeq)
      phRules.push(`.${phCls}::placeholder{${phStyle}}`)
    }
    /* ⚠️ class 只能拼一次：第一版是"先 push 新 class，再 filter 掉所有 class"，
       结果把**原来那个 class 也删了** —— 输入框丢掉了 .tin/.code 的边框和字号，
       截图里看着像"框不见了"。先拼好再一次性输出。 */
    const allCls = (cls + (phCls ? ' ' + phCls : '')).trim()
    const attrs = parts.filter(p => !p.startsWith('class="'))
    if (allCls) attrs.push(`class="${esc(allCls)}"`)
    out.push(`<input ${attrs.join(' ')} value="${esc(v)}" placeholder="${esc(ph)}" data-maxlength="${esc(ml)}">`)
    return
  }

  if (node.tag === 'textarea') {
    const v = clean.value !== undefined ? String(attrVal(clean.value, scope) ?? '') : ''
    const ph = clean.placeholder ? String(attrVal(clean.placeholder, scope) ?? '') : ''
    out.push(`<textarea ${parts.join(' ')} placeholder="${esc(ph)}">${esc(v)}</textarea>`)
    return
  }

  const buf = []
  renderChildren(node.children, scope, buf)
  out.push(`<${tag} ${parts.join(' ')}>${buf.join('')}</${tag}>`)
}

/* ---------------- 对外 ---------------- */

function render(rootNode, data) {
  const out = []
  renderChildren(rootNode.children, makeScope(data), out)
  return out.join('')
}

module.exports = { parseWxml, render, interpolate, evalExpr, makeScope, warn, takePhCss, getWarnings: () => warn }
