/**
 * probe-room-cloud.js —— 核对云端 room 是不是**刚部署的这一版**
 *
 * ============ 为什么不能用"骰子数=0"当判据 ============
 *
 * 上一版探针走「单人建房 → start → 看骰子数」，打印了「✓ 已生效」，
 * 但那是**假阳性**：
 *   start 有前置条件 `players.length < 2 → 拒绝`，
 *   单人房 start **必然失败**，phase 停在 lobby，
 *   而 lobby 阶段骰子本来就该是空的 ——
 *   于是"骰子数=0"跟修复毫无关系，旧版本照样打印 ✓。
 *
 * ★ 教训：判据必须**只被"目标改动"影响**。
 *   这里"骰子数"同时被两件事决定（有没有开局 / 发不发骰子），
 *   分不清是哪一件在起作用。
 *
 * ============ 现在的判据 ============
 *
 * 用**只有新版才有的行为**做指纹：
 *   dice 房 start 之后，`players[].diceCount` 必须全是 0（谁摇谁生成）。
 *   旧版在这里会给每人塞 2 颗 → diceCount = 2。
 *
 * 但 start 需要 2 个人，而探针只有一个 openid……
 * → 所以改用 **大话骰房做对照 + dice 房的 countdown 阶段**：
 *   新版对 dice 房"开局发空数组"这一步发生在 start 里，
 *   而 start 需要两人。
 *
 * 因此判据换成**代码指纹**：直接看云端函数包里 start 的那段分支。
 * 用 CLI download 把云端的 index.js 拉下来，比对它是否含
 * `room.game === 'wheel' || room.game === 'dice'`。
 *
 * 这比"跑一遍看行为"更直接、更可靠 —— 它测的就是"云端跑的是哪份代码"。
 *
 * 用法：node .tooling/probe-room-cloud.js
 * 前置：无（不需要开发者工具，CLI 自己会连）
 */
const { execFileSync } = require('child_process')
const fs = require('fs')
const path = require('path')
const os = require('os')

const ROOT = path.join(__dirname, '..')
const CLI = '/Applications/wechatwebdevtools.app/Contents/MacOS/cli'
const ENV_ID = 'cloudbase-d4goh1zdtc8eb9708'

const local = fs.readFileSync(path.join(ROOT, 'cloudfunctions/room/index.js'), 'utf8')

/* 本地这份代码的指纹 */
const FINGERPRINTS = [
  {
    name: 'dice 房开局不发骰子（谁摇谁生成）',
    re: /room\.game === 'wheel' \|\| room\.game === 'dice'/
  },
  {
    name: '转盘 spin action',
    re: /action === 'spin'/
  },
  {
    name: '叫骰 bid action',
    re: /action === 'bid'/
  },
  {
    /* ★ 2026-10-09 房间号改 3 位数字 —— 这条是本轮最关键的版本指纹：
       云端若还是旧版，前端按 3 位输号会**永远进不去**（旧版要 6 位）。 */
    name: '房间号 3 位纯数字',
    re: /const CODE_LEN = 3/
  },
  {
    name: '房间号穷举去重（不靠随机重试）',
    re: /async function pickCode/
  }
]

console.log('\n  ── 云端 room 版本核对 ──')
console.log('  本地代码指纹：')
FINGERPRINTS.forEach(f => {
  console.log(`    ${f.re.test(local) ? '✓' : '✗'} ${f.name}`)
})

const outDir = fs.mkdtempSync(path.join(os.tmpdir(), 'room-cloud-'))
console.log('\n  正在从云端下载 room …')

let downloaded = null
try {
  /* ⚠️ download 的参数是 `--name`（单数），不是 deploy 的 `--names` ——
     写错会报 "Command failed" 而不告诉你哪个参数错了。 */
  execFileSync(CLI, [
    'cloud', 'functions', 'download',
    '--project', ROOT, '--env', ENV_ID,
    '--name', 'room', '--path', outDir
  ], { stdio: 'pipe', timeout: 180000 })

  /*
   * CLI 的落盘结构不固定，递归找 index.js。
   *
   * ⚠️ 必须跳过 node_modules（2026-10-29 实测踩坑）：
   *   递归 find 先命中的是依赖包（如 wx-server-sdk）的 index.js（82900 字节），
   *   拿它和本地 index.js（115940 字节）比指纹 —— 5 条老指纹碰巧全中，
   *   打出「部署已生效」的误导结论，而比的根本不是云函数本体。
   *   判据错的时候结论也可能对，这比报错更危险。
   */
  ;(function find(d) {
    for (const f of fs.readdirSync(d)) {
      const p = path.join(d, f)
      if (fs.statSync(p).isDirectory()) {
        if (f === 'node_modules') continue
        find(p)
      } else if (f === 'index.js' && !downloaded) downloaded = p
    }
  })(outDir)
} catch (e) {
  console.log('  ★ 下载失败：' + String(e.message).split('\n')[0])
  console.log('    （CLI 的 download 需要开发者工具在跑；部署本身不需要）')
  process.exit(2)
}

if (!downloaded) {
  console.log('  ★ 下载目录里没找到 index.js')
  process.exit(2)
}

const cloud = fs.readFileSync(downloaded, 'utf8')
console.log(`  ✓ 已下载（${cloud.length} 字节）\n`)

let bad = 0
FINGERPRINTS.forEach(f => {
  const inCloud = f.re.test(cloud)
  const inLocal = f.re.test(local)
  const same = inCloud === inLocal
  console.log(`  ${same ? '✓' : '★'} ${f.name}：云端 ${inCloud ? '有' : '无'} / 本地 ${inLocal ? '有' : '无'}`)
  if (!same) bad++
})

console.log()
if (bad === 0 && cloud.length === local.length) {
  console.log('  ✓ 云端 room 与本地一致（指纹 + 字节数都吻合）—— 部署已生效')
} else if (bad === 0) {
  /*
   * ★ 指纹全中但字节数不同 —— 说明指纹太粗（都是旧功能），
   *   云端实际仍有差异（2026-10-29 实测：差 33KB）。
   *   这种情况**不能**报"一致"，宁可报可疑。
   */
  console.log(`  ★ 指纹全中但字节数不同（云端 ${cloud.length} / 本地 ${local.length}）`)
  console.log('    指纹都是旧功能、抓不住新差异 —— 请 download 后 diff 确认')
  bad = 1
} else {
  console.log(`  ✗ 有 ${bad} 处不一致 → 云端还是旧版，需要重新部署 room`)
}
console.log()

fs.rmSync(outDir, { recursive: true, force: true })
process.exit(bad === 0 ? 0 : 1)
