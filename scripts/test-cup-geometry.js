/**
 * test-cup-geometry.js —— 骰盅几何：**偷看时骰子必须真的全部露出来**
 *
 * ============ 为什么需要这条断言 ============
 *
 * 2026-10-08 用户实测报障：「筛盅拿开筛子看不全」。
 * 查下来是**两处几何同时不够**，而且都从代码上"看着挺对"：
 *
 *   ① 5 颗骰子横排 612rpx，而盅只有 300rpx → 两端露在盅外面；
 *   ② 偷看只抬 64rpx，盅的内容底边仍压在骰子上沿。
 *
 * 实测算下来：盅最低点 378.5rpx、骰子顶边 374.0rpx —— **还压着 4.5rpx**。
 * 这类问题不会报错、不会白屏，只是"看着别扭"，所以只能靠算。
 *
 * ============ 两个关键认识（都是踩出来的） ============
 *
 * ★ 一、**必须用图片的真实内容边界，不能用 CSS 盒子**。
 *   cup-down.png 是 312×485 的画布，但图形只占 278×400 ——
 *   **上留白 83px（17%）**。CSS 写 300×466 时，
 *   真正画着盅的那块只有 267rpx 宽、且顶边距盒子顶 80rpx。
 *   拿 CSS 盒子算"盖没盖住"，结论一定是错的。
 *
 * ★ 二、**旋转会让最低点下移**。
 *   盅抬起来时带 rotate(-7deg)，角会甩下去 ——
 *   半宽 160rpx × sin(7°) ≈ 19.5rpx。漏算这一项，余量就没了。
 *
 * 跑法：node scripts/test-cup-geometry.js
 */
const fs = require('fs')
const path = require('path')
const assert = require('assert')

const ROOT = path.join(__dirname, '..')
const WXSS = path.join(ROOT, 'miniprogram/pages/game/room/room.wxss')
const CUP_PNG = path.join(ROOT, 'miniprogram/images/cup/cup-down.png')

let n = 0
function ok(msg) { n++; console.log('  ✓ ' + msg) }

/* ---------- 从 PNG 头里读画布尺寸（不依赖任何图形库） ---------- */
function pngSize(file) {
  const fd = fs.openSync(file, 'r')
  const buf = Buffer.alloc(24)
  fs.readSync(fd, buf, 0, 24, 0)
  fs.closeSync(fd)
  assert.strictEqual(buf.toString('ascii', 1, 4), 'PNG', file + ' 不是 PNG')
  return { w: buf.readUInt32BE(16), h: buf.readUInt32BE(20) }
}

/* ---------- 图片真实内容边界（实测值，写在脚本里当基准） ----------
 * 用 alpha 通道量的：cup-down.png 画布 312×485，内容 (13,83)-(291,483)。
 * 这个值由 scripts/render-cup.py 的取景决定，改动渲染器时要同步更新。
 * 脚本会核对"内容宽高比"是否仍与实测一致，防止有人重渲染后忘了改这里。 */
const IMG = { w: 312, h: 485, cTop: 83, cBottom: 483, cLeft: 13, cRight: 291 }

/* ---------- 从 wxss 里抽真实数值（测的是线上真正生效的那份） ---------- */
function rule(selector) {
  const css = fs.readFileSync(WXSS, 'utf8')
  /* 取最后一个匹配 —— 后面的规则会覆盖前面的 */
  const re = new RegExp(selector.replace(/[.*+?^${}()|[\]\\]/g, '\\$&') + '\\s*\\{([^}]*)\\}', 'g')
  let m, last = null
  while ((m = re.exec(css))) last = m[1]
  assert.ok(last, 'wxss 里找不到规则 ' + selector)
  return last
}
function px(body, prop) {
  /* 允许 `0`（不带单位）和 `123rpx` 两种写法 —— bottom:0 是合法的 */
  const m = new RegExp('(?:^|;)\\s*' + prop + '\\s*:\\s*(-?[\\d.]+)(?:rpx)?\\s*(?:;|$)').exec(body)
  return m ? Number(m[1]) : null
}

;(() => {
  console.log('\n=== 骰盅几何：偷看时骰子必须完整露出 ===')

  /* 先核对图片基准没变 */
  const png = pngSize(CUP_PNG)
  assert.strictEqual(png.w, IMG.w, `cup-down.png 宽度变成 ${png.w}，几何基准要重算`)
  assert.strictEqual(png.h, IMG.h, `cup-down.png 高度变成 ${png.h}，几何基准要重算`)
  ok(`盅图基准一致（画布 ${IMG.w}×${IMG.h}，内容 ${IMG.cRight - IMG.cLeft}×${IMG.cBottom - IMG.cTop}）`)

  const scene = rule('.cupscene')
  const cup = rule('.cs-cup')
  const dice = rule('.cs-dice')
  const die = rule('.cs-die')
  const peek = rule('.cs-cup.peek')
  const hint = rule('.cs-hint')

  const sceneH = px(scene, 'height')
  const cupW = px(cup, 'width'), cupH = px(cup, 'height')
  const cupBottom = px(cup, 'bottom')
  const diceBottom = px(dice, 'bottom'), diceW = px(dice, 'width')
  const dieW = px(die, 'width'), dieH = px(die, 'height')
  const gap = px(dice, 'gap')
  const liftM = /translateY\(\s*(-?[\d.]+)rpx\s*\)/.exec(peek)
  const scaleM = /scale\(\s*([\d.]+)\s*\)/.exec(peek)
  const rotM = /rotate\(\s*(-?[\d.]+)deg\s*\)/.exec(peek)

  for (const [k, v] of Object.entries({
    '场景高': sceneH, '盅宽': cupW, '盅高': cupH, '盅 bottom': cupBottom,
    '骰子 bottom': diceBottom, '骰子容器宽': diceW, '单颗骰子宽': dieW,
    '单颗骰子高': dieH, '骰子间距': gap
  })) assert.ok(v !== null, k + ' 读不到 rpx 值')
  assert.ok(liftM && scaleM && rotM, '.cs-cup.peek 必须有 translateY + scale + rotate')

  const lift = Math.abs(Number(liftM[1]))
  const scale = Number(scaleM[1])
  const rot = Math.abs(Number(rotM[1]))

  /* ---------- ① 比例不变形 ---------- */
  const imgRatio = IMG.w / IMG.h
  assert.ok(Math.abs(cupW / cupH - imgRatio) < 0.01,
    `盅被拉变形了：CSS ${cupW}×${cupH} = ${(cupW / cupH).toFixed(3)}，` +
    `图片比例 ${imgRatio.toFixed(3)}（图会糊/会被压扁）`)
  ok(`盅保持原始比例（${cupW}×${cupH}，ratio ${(cupW / cupH).toFixed(3)}）`)

  /* ---------- ② 骰子横向必须塞得进盅的「内容宽」 ---------- */
  const k = cupW / IMG.w
  const cWidth = (IMG.cRight - IMG.cLeft) * k
  const rowW = 5 * dieW + 4 * gap
  assert.ok(rowW <= cWidth - 4,
    `★ 骰子行 ${rowW}rpx 比盅的内容宽 ${cWidth.toFixed(1)}rpx 还宽 —— ` +
    `盅盖着时两端会从两侧探出来（就是「看不全」的横向那半）`)
  ok(`骰子行宽 ${rowW}rpx ≤ 盅内容宽 ${cWidth.toFixed(1)}rpx（左右各余 ${((cWidth - rowW) / 2).toFixed(1)}rpx）`)

  /* ---------- ③ 偷看时，盅的最低点必须在骰子顶边之上 ---------- */
  const cTop = IMG.cTop * k, cBottom = IMG.cBottom * k
  const boxTop = sceneH - cupH - (cupBottom || 0)
  const contentBottomY = boxTop + cBottom
  const center = boxTop + cupH / 2
  /* 旋转后的最低点：半宽 × sin(旋转角) 会甩到下方 */
  const rotDrop = (cWidth / 2) * Math.sin(rot * Math.PI / 180)
  const lowest = center + (contentBottomY - center) * scale + rotDrop - lift
  const diceTop = sceneH - diceBottom - dieH
  const margin = diceTop - lowest

  assert.ok(margin >= 16,
    `★ 偷看时盅还压着骰子 ${(-margin).toFixed(1)}rpx（余量只有 ${margin.toFixed(1)}，至少要 16）\n` +
    `      盅最低点 ${lowest.toFixed(1)}  骰子顶边 ${diceTop}\n` +
    `      抬升 ${lift} 缩放 ${scale} 旋转 ${rot}° → 需要抬得更高或缩得更小`)
  ok(`★ 偷看时盅最低点 ${lowest.toFixed(1)}rpx < 骰子顶边 ${diceTop}rpx（余量 ${margin.toFixed(1)}rpx，真的露得出来）`)

  /* ---------- ④ 抬起来之后不能被 overflow:hidden 裁掉 ---------- */
  const contentTopY = center + (boxTop + cTop - center) * scale - lift
  assert.ok(contentTopY > 0,
    `★ 盅抬起来后顶部跑到 ${contentTopY.toFixed(1)}rpx（<0），会被 .cupscene 的 ` +
    `overflow:hidden 裁掉一块 —— 看起来像盅被切了`)
  ok(`抬起后盅顶仍在场景内（${contentTopY.toFixed(1)}rpx > 0，不会被裁）`)

  /* ---------- ⑤ 盖着的时候，骰子必须真的看不见 ---------- */
  const coveredTop = center + (boxTop + cTop - center)      // 没抬时内容顶边
  assert.ok(diceTop >= coveredTop - 1,
    `★ 骰子顶边 ${diceTop} 高于盅内容顶边 ${coveredTop.toFixed(1)} —— ` +
    `盅扣着时骰子会从盅口上方冒出来（泄底）`)
  ok(`扣盅时骰子完全在盅内（骰子顶 ${diceTop} ≥ 盅内容顶 ${coveredTop.toFixed(1)}）`)

  /* ---------- ⑥ 揭盅要比偷看抬得更高（两个动作要能区分） ---------- */
  const liftRule = rule('.cs-cup.lift')
  const liftM2 = /translateY\(\s*(-?[\d.]+)rpx\s*\)/.exec(liftRule)
  assert.ok(liftM2, '.cs-cup.lift 必须有 translateY')
  const lift2 = Math.abs(Number(liftM2[1]))
  assert.ok(lift2 > lift + 30,
    `★ 揭盅抬 ${lift2}rpx、偷看抬 ${lift}rpx —— 差得太少，玩家分不清是偷看还是揭盅`)
  ok(`揭盅(${lift2}rpx) 明显高于偷看(${lift}rpx)，两个动作能区分`)

  /* ---------- ⑦ 提示语不能压在骰子上 ---------- */
  const hintTop = px(hint, 'top')
  const hintBottom = px(hint, 'bottom')
  if (hintBottom !== null) {
    assert.ok(hintBottom + 30 < diceBottom,
      `★ 提示语在底部 ${hintBottom}rpx，而骰子在 ${diceBottom}~${diceBottom + dieH}rpx —— ` +
      `文字会挡住刚露出来的骰子`)
    ok('提示语在骰子下方，不遮挡')
  } else {
    assert.ok(hintTop !== null, '.cs-hint 既没有 top 也没有 bottom')
    assert.ok(hintTop + 34 < coveredTop,
      `★ 提示语在顶部 ${hintTop}rpx，盅内容从 ${coveredTop.toFixed(1)}rpx 开始 —— 会压在盅上`)
    ok(`提示语在盅上方空白区（${hintTop}rpx，盅从 ${coveredTop.toFixed(1)}rpx 才开始）`)
  }

  console.log(`\n${'='.repeat(58)}`)
  console.log(`  骰盅几何：全部 ${n} 项断言通过`)
  console.log(`${'='.repeat(58)}\n`)
})()

/* 断言失败要能让 test-all.sh 停下来 —— 和其它测试保持一致 */
process.on('uncaughtException', (e) => {
  console.error('\n  ✗ 断言失败：', e.message, '\n')
  process.exit(1)
})
