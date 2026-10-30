/**
 * shot.js —— 连上模拟器，让它自己截图、自己点、自己读数据
 *
 * 为什么需要它：之前我一直靠"猜界面长什么样"，因为 macOS 不允许程序抢窗口焦点，
 * 截图只能拍到桌面。miniprogram-automator 走的是 IDE 内部调试通道，
 * 直接从小程序运行时取页面结构 —— 不依赖窗口是否在最前。
 *
 * 用法：
 *   node .tooling/shot.js                  # 截图当前页面
 *   node .tooling/shot.js --page pages/index/index
 *   node .tooling/shot.js --tap "写点什么"  # 点一个按钮再截图
 */
const automator = require('miniprogram-automator')
const path = require('path')
const fs = require('fs')

const CLI_PORT = Number(process.env.WSPORT || 9420)
const PROJECT = path.join(__dirname, '..')
const OUT = path.join(PROJECT, 'outputs')

function arg(name, def) {
  const i = process.argv.indexOf('--' + name)
  return i >= 0 && process.argv[i + 1] ? process.argv[i + 1] : def
}

;(async () => {
  if (!fs.existsSync(OUT)) fs.mkdirSync(OUT, { recursive: true })

  /**
   * 用 launch 而不是 connect。
   * connect(wsEndpoint) 要求工具已经以自动化模式跑起来并暴露出那个端口 ——
   * 实测它开的几个端口都不是 automator 协议端口，连上就被拒。
   * launch 会自己拉起工具、自己协商端口，是官方推荐路径。
   * 前提：安全设置里的「服务端口」必须开着（已开）。
   */
  console.log('启动自动化会话…')
  const mini = await automator.launch({
    cliPath: '/Applications/wechatwebdevtools.app/Contents/MacOS/cli',
    projectPath: PROJECT,
    timeout: 60000
  })
  console.log('✓ 已连上模拟器')

  const targetPage = arg('page')
  if (targetPage) {
    console.log('跳转到 ' + targetPage)
    await mini.reLaunch('/' + targetPage.replace(/^\//, ''))
    await new Promise(r => setTimeout(r, 2500))
  }

  /* 点一个按钮 */
  const tapText = arg('tap')
  if (tapText) {
    console.log('点击「' + tapText + '」…')
    const page = await mini.currentPage()
    const el = await page.$(tapText)                 // 支持选择器或文本
    if (!el) {
      console.log('  没找到这个元素，先把当前页面结构打出来：')
      console.log(await page.data())
    } else {
      await el.tap()
      await new Promise(r => setTimeout(r, 2000))
    }
  }

  /* 截图 */
  const page = await mini.currentPage()
  const name = arg('out', (page.path || 'page').replace(/\//g, '_') + '.png')
  const file = path.join(OUT, name)
  await mini.screenshot({ path: file })
  console.log('✓ 截图已保存：outputs/' + name)
  console.log('  当前页面：' + page.path)

  /* 页面数据也打出来 —— 这比截图更能说明问题 */
  const data = await page.data()
  if (data) {
    const brief = {}
    Object.keys(data).forEach(k => {
      const v = data[k]
      if (v === null || v === undefined) brief[k] = v
      else if (Array.isArray(v)) brief[k] = 'Array(' + v.length + ')'
      else if (typeof v === 'object') brief[k] = 'Object{' + Object.keys(v).slice(0, 5).join(',') + '}'
      else brief[k] = v
    })
    console.log('  页面数据：', JSON.stringify(brief, null, 0).slice(0, 600))
  }

  await mini.disconnect()
  console.log('✓ 完成')
})().catch(err => {
  console.error('✗ 失败：', err.message)
  if (/connect|ECONNREFUSED|timeout/i.test(err.message)) {
    console.error('  提示：先确认 IDE 正在运行，且已在「设置 → 安全设置」里开启服务端口。')
    console.error('  另外 auto 模式需要用 cli auto 启动过。')
  }
  process.exit(1)
})
