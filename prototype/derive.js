/**
 * derive.js — 全 App 唯一的时间真相来源
 *
 * 输入：只有一个「在一起的日子」 anniversary（YYYY-MM-DD，用户在设置页选一次）
 * 输出：其余所有跟时间有关的展示值，全部当场算出来
 *
 * 规则：任何页面 / 任何文案里都不允许出现写死的天数、年头、纪念日倒计时。
 *      要展示时间，就调 derive()，用 data-d 绑定。
 *
 * 同一份文件双端复用：
 *   小程序  →  var derive = require('../../utils/derive.js').derive
 *   原型页  →  <script src="derive.js"></script>
 */

function pad(n) { return n < 10 ? '0' + n : '' + n }

var CN = ['零', '一', '二', '三', '四', '五', '六', '七', '八', '九', '十']
/** 数字转汉字：2 → 两（年）用汉字更像一个人在说话，不像一个表单 */
function cn(n) {
  if (n === 2) return '两'
  if (n <= 10) return CN[n]
  if (n < 20) return '十' + (n % 10 ? CN[n % 10] : '')
  if (n < 100) return CN[Math.floor(n / 10)] + '十' + (n % 10 ? CN[n % 10] : '')
  return String(n)
}

function parseISO(s) {
  var p = String(s || '').split('-')
  return { y: +p[0], m: +p[1] || 1, d: +p[2] || 1 }
}

/**
 * 所有日期运算一律走 UTC 整数（毫秒），不做任何本地时间字符串解析。
 * 原因：iOS 上 new Date('2024-03-26') 按 UTC 解析、new Date('2024/03/26') 按本地解析，
 * 两者差 8 小时，跨零点时天数会莫名差 1 天。用 Date.UTC 拼整数彻底绕开这个坑。
 */
function dayUts(y, m, d) { return Date.UTC(y, m - 1, d) }
function todayUts(now) { return dayUts(now.getFullYear(), now.getMonth() + 1, now.getDate()) }

/** 纪念日落在 2/29 时，平年回落到该年 2 月最后一天，不报错也不跳到 3/1 */
function safeUts(y, m, d) {
  var t = dayUts(y, m, d)
  var dt = new Date(t)
  if (dt.getUTCMonth() !== m - 1) {
    t = dayUts(y, m + 1, 0)   /* 下个月的第 0 天 = 本月最后一天（原来写成 m 会拿到上月的长度） */
  }
  return t
}

/** 里程碑节点：固定档 + 自动补上「下一个年头」，保证永远有东西在前方 */
function milestoneYears(headNo) {
  var want = [1, 2, 3, 5, 10]
  if (want.indexOf(headNo) < 0) {
    want.push(headNo)
    want.sort(function (a, b) { return a - b })
  }
  // 超过 5 个就开窗，让"下一个"始终落在中间偏左，看得见进度也看得见前方
  if (want.length > 5) {
    var i = want.indexOf(headNo)
    var from = Math.max(0, Math.min(i - 1, want.length - 5))
    want = want.slice(from, from + 5)
  }
  return want
}

/**
 * @param {string} anniversaryISO  在一起的日子 YYYY-MM-DD
 * @param {Date|string|number} [nowRaw]  可注入，便于写测试和做演示对比图
 */
function derive(anniversaryISO, nowRaw) {
  var now = nowRaw ? new Date(nowRaw) : new Date()
  var a = parseISO(anniversaryISO)
  var ty = now.getFullYear(), tm = now.getMonth() + 1, td = now.getDate()

  var start = safeUts(a.y, a.m, a.d)
  var today = todayUts(now)
  var DAY = 86400000

  var days = Math.max(0, Math.round((today - start) / DAY))

  // 已满整年
  var thisYearAnniv = safeUts(ty, a.m, a.d)
  var full = ty - a.y
  if (thisYearAnniv > today) full -= 1
  if (full < 0) full = 0

  // 满 full 周年之后的零头月份
  var baseY = a.y + full
  var months = (ty - baseY) * 12 + (tm - a.m)
  if (td < a.d) months -= 1
  if (months < 0) months = 0

  var head = full + 1

  // 下一个纪念日
  var naUts = thisYearAnniv > today ? thisYearAnniv : safeUts(ty + 1, a.m, a.d)
  var na = new Date(naUts)
  var next = {
    year: na.getUTCFullYear(),
    month: na.getUTCMonth() + 1,
    date: na.getUTCDate(),
    label: na.getUTCFullYear() + '.' + pad(na.getUTCMonth() + 1) + '.' + pad(na.getUTCDate()),
    iso: na.getUTCFullYear() + '-' + pad(na.getUTCMonth() + 1) + '-' + pad(na.getUTCDate()),
    daysUntil: Math.round((naUts - today) / DAY),
    which: na.getUTCFullYear() - a.y
  }

  // 里程碑
  var ms = [{ label: '100天', uts: start + 100 * DAY, year: 0 }]
  var ys = milestoneYears(head)
  for (var i = 0; i < ys.length; i++) {
    ms.push({ label: ys[i] + ' 年', year: ys[i], uts: safeUts(a.y + ys[i], a.m, a.d) })  /* 进度条用数字，口语文案才用汉字 */
  }
  var seenNext = false
  for (var j = 0; j < ms.length; j++) {
    ms[j].done = today >= ms[j].uts
    ms[j].isNext = !ms[j].done && !seenNext
    if (ms[j].isNext) seenNext = true
  }

  // 题干里的时间跨度：让一句话听起来像人话，而不是模板拼接
  var span
  if (full >= 1) span = cn(full) + '年' + (months >= 2 ? '多' : '')
  else if (months >= 9) span = '大半年'
  else if (months >= 6) span = '半年'
  else if (months >= 1) span = cn(months) + '个月'
  else span = days > 0 ? days + '天' : '这一天'

  // 「那年今日」对齐：一年前的同一天
  var thenUts = safeUts(ty - 1, tm, td)
  var then = new Date(thenUts)

  return {
    anniversary: a.y + '-' + pad(a.m) + '-' + pad(a.d),
    anniversaryLabel: a.y + '.' + pad(a.m) + '.' + pad(a.d),
    todayLabel: ty + '.' + pad(tm) + '.' + pad(td),
    days: days,
    fullYears: full,
    remMonths: months,
    headNo: head,
    headNoCn: cn(head),
    spanText: span,
    yearsLine: full >= 1 ? ('已满 ' + full + ' 年 · 零头 ' + months + ' 个月')
      : months >= 1 ? ('还不到一年 · 已经 ' + months + ' 个月')
      : days >= 1 ? ('刚在一起 ' + days + ' 天')
      : '今天是我们第一天',
    next: next,
    milestones: ms,
    lastYearLabel: then.getUTCFullYear() + '.' + pad(then.getUTCMonth() + 1) + '.' + pad(then.getUTCDate()),
    /** 题库模板替换：{span} {days} {years} {head} —— 题目永远跟着真实时间走 */
    fill: function (tpl) {
      return String(tpl || '')
        .replace(/\{span\}/g, span)
        .replace(/\{days\}/g, days)
        .replace(/\{years\}/g, cn(full))
        .replace(/\{head\}/g, cn(head))
        .replace(/\{anniv\}/g, a.y + '.' + pad(a.m) + '.' + pad(a.d))
        .replace(/\{next\}/g, next.daysUntil)
    }
  }
}


/** 任意日期 → 还有多少天（不重复发生的事件，如还款日、旅行） */
function until(iso, nowRaw) {
  var a = parseISO(iso)
  var now = nowRaw ? new Date(nowRaw) : new Date()
  var d = Math.round((safeUts(a.y, a.m, a.d) - todayUts(now)) / 86400000)
  return { days: d, past: d < 0, label: d > 0 ? '还有 ' + d + ' 天' : (d === 0 ? '就是今天' : '已过 ' + (-d) + ' 天') }
}

/** 每年重复的日子（生日、纪念日）→ 滚动到未来最近一次；2/29 平年自动回落 */
function nextOccur(iso, nowRaw) {
  var a = parseISO(iso)
  var now = nowRaw ? new Date(nowRaw) : new Date()
  var today = todayUts(now), ty = now.getFullYear()
  var t = safeUts(ty, a.m, a.d)
  if (t < today) t = safeUts(ty + 1, a.m, a.d)
  var dt = new Date(t)
  var days = Math.round((t - today) / 86400000)
  return {
    label: dt.getUTCFullYear() + '.' + pad(dt.getUTCMonth() + 1) + '.' + pad(dt.getUTCDate()),
    daysUntil: days, text: days > 0 ? '还有 ' + days + ' 天' : '就是今天',
    turning: dt.getUTCFullYear() - a.y          /* 这次过的是多少岁生日 */
  }
}


/**
 * 把 (年, 月, 日) 夹到该月真实存在的范围内。
 *
 * 为什么需要它：Date.UTC(2026, 8, 31) 不会报错，它会**静默进位**成 10 月 1 日。
 * 同理 Date.UTC(2027, 1, 29) 会变成 3 月 1 日。
 * 「每月 31 号还款」在 9 月（只有 30 天）就会算成 10.01 —— 差一整个月。
 * 所以凡是用户输入的日期，都要先夹一次。
 */
function clampDay(y, m, d) {
  var last = new Date(Date.UTC(y, m, 0)).getUTCDate()   // m 月最后一天
  return d > last ? last : (d < 1 ? 1 : d)
}

/** 每月固定几号（还款、房租）→ 滚动到下一次，不写死年份 */
function nextMonthly(day, nowRaw) {
  var now = nowRaw ? new Date(nowRaw) : new Date()
  var ty = now.getFullYear(), tm = now.getMonth() + 1, td = now.getDate()
  var today = dayUts(ty, tm, td)

  var t = dayUts(ty, tm, clampDay(ty, tm, day))
  if (t < today) {
    var ny = tm === 12 ? ty + 1 : ty
    var nm = tm === 12 ? 1 : tm + 1
    t = dayUts(ny, nm, clampDay(ny, nm, day))
  }
  var d = Math.round((t - today) / 86400000)
  var dt = new Date(t)
  return { label: pad(dt.getUTCMonth() + 1) + '.' + pad(dt.getUTCDate()), daysUntil: d,
           text: d > 0 ? '还有 ' + d + ' 天' : '就是今天' }
}

if (typeof module !== 'undefined' && module.exports) {
  module.exports = { derive: derive, cn: cn, until: until, nextOccur: nextOccur, nextMonthly: nextMonthly }
}
