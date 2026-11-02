/**
 * room —— 多人游戏房间
 *
 * ============ 和现有云函数最大的不同 ============
 *
 * 之前所有集合都挂 `pairId`（两个人配对的小窝），但多人游戏不能这样：
 *   · 房间是**临时**的 —— 玩完就散，不该长期占着数据库
 *   · 人数任意 —— 3 个人、5 个人都可能，不是固定两人
 *   · 不同微信号进来 —— 没有"配对"关系，靠**房间码**聚到一起
 *
 * 所以这里是独立的一套：房间码 + 玩家列表 + 房主机制。
 *
 * ============ 三个关键设计 ============
 *
 * ① **状态由服务端算，不信任前端**。
 *    谁该出牌、轮到谁、谁赢了 —— 全部在云函数里判定。
 *    前端只负责"显示服务端说的状态"和"发起操作请求"。
 *    这和双盲解锁是同一套思路：把判断放服务端。
 *
 * ② **每个玩家只能看到自己该看的**。
 *    大话骰这类游戏，自己的骰子只有自己能看 ——
 *    接口按 openid 过滤，别人的骰子在服务端就被丢掉了，
 *    不是"发过去前端藏起来"（那样抓包就穿了）。
 *
 * ③ **房主离开要转移**，不能让房间变成没人能管的死局。
 *
 * ============ 为什么用轮询而不是 watch ============
 * 云数据库的 watch 能做实时推送，但它要维持长连接，
 * 且在小程序端需要处理断线重连。酒桌游戏的操作间隔是秒级，
 * 1.2 秒轮询的体感已经"实时"了，且实现简单、失败可重试。
 * 房间数据很小（一个文档），轮询成本可以忽略。
 */
const cloud = require('wx-server-sdk')
/*
 * 酒桌题卡库 —— 云函数独立打包、不能跨目录 require，所以这里是一份拷贝。
 * 源文件是 `miniprogram/utils/decks.js`，改完跑 `scripts/sync-derive.sh` 同步
 * （那个脚本会自动扫描所有云函数目录下的 decks.js，不用手记路径）。
 *
 * 为什么抽题要放在**服务端**：和转盘抽扇区同理 ——
 * 前端抽的话，"重摇到满意"就穿帮了，而且没法保证全场看到同一张。
 */
const decks = require('./decks.js')
/*
 * 玩法注册表 —— 与 miniprogram/utils/games.js 逐字节一致。
 * 云函数独立打包、不能跨目录 require，所以这里是一份拷贝，
 * 由 scripts/sync-derive.sh 自动同步（改完跑一次）。
 *
 * ★ 加新玩法只改注册表 + 写它的规则分支，**不用再改这个文件里的 id 列表**。
 *   改造前这里有 3 处硬编码 `['dice','liar','wheel']`，加玩法时只改一处的话，
 *   会出现"大厅看得到、屋里建不出来"或者"能建但不能切"——而且不报错。
 */
const { GAMES, gameOf } = require('./games.js')
/*
 * 谁是卧底的词库 —— 同样是前端源文件的拷贝（sync-derive.sh 自动同步）。
 * 抽词必须在**服务端**：前端抽的话，房主能反复重抽到好词，
 * 而且"每个人的词"本来就不该由任何一个客户端决定。
 */
const { pickPair } = require('./words.js')
/*
 * 扑克牌与牌型比较 —— 前端源文件的拷贝。
 * 牌型比较放共享模块的原因：它必须**前后端逐字节一致**，
 * 否则会出现"我这边显示我大、服务端判我输"（同一份代码算的才对得上）。
 */
const poker = require('./poker.js')
const dicerank = require('./dicerank.js')
const loser = require('./loser.js')
const liarCount = require('./liarCount.js')

/*
/* 规则在 miniprogram/utils/liarRules.js（前后端共享，sync-derive 同步过来）——
   两边各写一份必然不一致：会出现"按钮亮了但服务端说不行"，而且不报错。 */
const liarRules = require('./liarRules.js')

/**
 * 比大小的结算（2026-10-30 抽出来）。
 *
 * ============ 为什么要抽 ============
 *
 * 这段原来是内联在 `roll` 的 updateGuarded 回调里的。现在多了一个调用方：
 * `status` 要把**掉线不摇的人**踢出本局并结算 —— 否则只要有一个人掉线，
 * "全员摇完"永远不成立，整局卡死且不报错（已用测试锁住）。
 *
 * 两份结算必然不一致（这个项目栽过太多次），所以抽成纯函数。
 *
 * @param {Array} players   本局玩家的完整数组（每人有 dice）
 * @param {object} prevStreaks  上一局的连庄记录
 * @returns {{result:object, streaks:object}}
 */
/**
 * 卧底投票的结算（2026-10-30 抽出来）。
 *
 * 原来这段内联在 `uwVote` 的 updateGuarded 回调里。现在多了一个调用方：
 * `status` 要把掉线不投票的人踢出本局并结算 —— 否则"全员投完"永远不成立，
 * 全桌卡在投票页且不报错（已用测试锁住）。
 *
 * 两份结算必然不一致，所以抽成纯函数（同 calcDiceResult 的处理）。
 *
 * @returns {object} 要写回房间的 patch
 */
function settleUwVote(fplayers, votes, fresh, ts) {
    /* ---- 结算：票最多的出局 ---- */
    const tally = {}
    votes.forEach(v => { tally[v.target] = (tally[v.target] || 0) + 1 })
    let max = 0
    Object.keys(tally).forEach(k => { if (tally[k] > max) max = tally[k] })
    const top = Object.keys(tally).filter(k => tally[k] === max)

    /*
     * ============ 平票：重投一次，再平票则卧底赢 ============
     *
     * 2026-10-28 改（原来是什么：平票时**随机**挑一个人出局）。
     *
     * 随机的问题不在实现，在**桌上没法解释**：被随机选中的人会问
     * "凭什么是我"，而服务端唯一能给的答案就是"随机"。
     * 调研过的主流口径（腾讯欢乐斗地主系列攻略）是：
     *   平票 → 平票的人各补一句 → 再投 → 仍平票则卧底胜。
     * 这个口径的好处是**每一步都有桌上能懂的理由**，
     * 而且"投不出结果 = 好人失败"本身就符合这个游戏的逻辑。
     *
     * 原来注释里"重投会拖很久"的担心是真的，所以只给**一次**重投机会：
     * 第二次投票无论如何都要出结果（平票则直接判卧底胜）。
     *
     * 状态只有两个字段：uwTieBreak（这一轮是否已用过重投）、uwTieNames（平票名单）。
     * 每轮结算后清零，所以"每轮都有一次重投机会"。
     */
    if (top.length > 1) {
      if (!fresh.uwTieBreak) {
        const tieNames = top.map(oid => (fplayers.filter(p => p.openid === oid)[0] || {}).name || '').join('、')
        return {
          players: fplayers, votes: [], uwTieBreak: true, uwTieNames: tieNames,
          uwStep: 'talk'
        }
      }
      /* 第二次仍平票：不再淘汰任何人，直接判卧底胜 */
      return {
        players: fplayers, votes: [], uwTieBreak: false, uwTieNames: '',
        phase: 'over', uwStep: 'result',
        lastResult: {
          kind: 'undercover', winner: 'spy', tieDeadlock: true,
          civilianWord: (fplayers.filter(p => p.uwRole === 'civilian')[0] || {}).uwWord || '',
          spyWord: (fplayers.filter(p => p.uwRole === 'spy')[0] || {}).uwWord || ''
        },
        uwReveal: fplayers
          .filter(p => p.inRound !== false)
          .map(p => ({ name: p.name, word: p.uwWord, role: p.uwRole, out: !!p.out }))
      }
    }

    const picked = top[0]
    const outP = fplayers.filter(p => p.openid === picked)[0]
    outP.out = true
    outP.inRound = true

    const outRow = { openid: outP.openid, name: outP.name, word: outP.uwWord, role: outP.uwRole }
    const uwOut = (fresh.uwOut || []).concat([outRow])

    /* ---- 胜负判定 ---- */
    const stillAlive = fplayers.filter(p => p.inRound !== false && !p.out)
    const spiesLeft = stillAlive.filter(p => p.uwRole === 'spy').length
    let winner = ''
    if (spiesLeft === 0) winner = 'civilian'          // 卧底全出局
    else if (spiesLeft * 2 >= stillAlive.length) winner = 'spy'   // 卧底占一半，好人也赢不了
    else if (stillAlive.length <= 2) winner = 'spy'    // 只剩两人，卧底拖到底

    const patch = {
      players: fplayers, votes: [], uwOut: uwOut,
      uwLastOut: {
        name: outRow.name, word: outRow.word, role: outRow.role,
        /* 平票已经走"重投"分支，能走到这里的都是单一最高票 */
        tie: false, votes: max,
        /*
         * ★★ 票型：谁投了谁（2026-10-28）。
         *
         * 这是卧底玩法里**最该被看见、却一直没显示**的信息 ——
         * 结算时大家第一个问题就是"谁投的他"，
         * 而投票一结束 votes 就被清空了（见上一行 votes: []），
         * 那条线索当场蒸发，桌上只能靠回忆。
         *
         * 它不改变任何规则，只是把"刚刚发生过的事"摆出来 ——
         * 而这恰恰是这个游戏后半段讨论的燃料。
         */
        ballots: votes.map(v => ({ by: v.name, to: (fplayers.filter(p => p.openid === v.target)[0] || {}).name || '' }))
      },
      /* 本轮结束，重投机会下轮重新给 */
      uwTieBreak: false, uwTieNames: '',
      updatedAt: ts
    }

    if (winner) {
      patch.phase = 'over'
      patch.uwStep = 'result'
      patch.lastResult = {
        kind: 'undercover', winner: winner,
        civilianWord: (fplayers.filter(p => p.uwRole === 'civilian')[0] || {}).uwWord || '',
        spyWord: (fplayers.filter(p => p.uwRole === 'spy')[0] || {}).uwWord || ''
      }
      patch.uwReveal = fplayers
        .filter(p => p.inRound !== false)
        .map(p => ({ name: p.name, word: p.uwWord, role: p.uwRole, out: !!p.out }))
    } else {
      patch.uwStep = 'result'
    }
  return patch
}



/**
 * "当前阶段不能做这个动作" 的**准确**提示。
 *
 * ★ 2026-10-30：原来 roll 和 bid 都直接回「这局还没开始」——
 *   而这个分支实际上是 `phase !== 'playing'`，包含两种完全不同的情况：
 *     · lobby  → 真的还没开始
 *     · over   → **已经结束了**（说实话"还没开始"是反的）
 *   探针跑"结算后再摇"时拿到「这局还没开始」，听起来像产品坏了。
 *   按真实 phase 分档，用户才知道下一步该做什么。
 */
function phaseHint(phase) {
  if (phase === 'over') return '这一局已经结束了，等房主再开一局'
  if (phase === 'countdown') return '马上开始，等倒计时走完'
  return '这局还没开始'
}

function calcDiceResult(players, prevStreaks) {
  const rk = dicerank.rankPlayers(players)
  const winnerSeats = rk.winnerSeats
  /* 连庄：连赢本来就该被说出来（"你又赢了？连庄两把了，加倍喝"） */
  const streaks = {}
  ;(players || []).forEach(p => {
    const won = winnerSeats.indexOf(p.seat) >= 0
    streaks[p.seat] = won ? (((prevStreaks || {})[p.seat] || 0) + 1) : 0
  })
  const maxStreak = Math.max(0, ...Object.keys(streaks).map(k => streaks[k]))
  return {
    result: {
      ranked: rk.ranked,
      winners: rk.winners,
      leopardWin: rk.leopardWin,
      leopardFace: rk.leopardFace,
      top: rk.top,
      streaks: streaks,
      maxStreak: maxStreak,
      winnerSeats: winnerSeats
    },
    streaks: streaks
  }
}

const canRaise = liarRules.canRaise
const GAME_IDS = GAMES.map(g => g.id)
cloud.init({ env: cloud.DYNAMIC_CURRENT_ENV })

const db = cloud.database()
const _ = db.command

/*
 * ============================================================
 * ★★★ 写库前清洗 undefined（2026-10-29 晚）—— 「游戏从来没正常玩过」的头号嫌疑
 * ============================================================
 *
 * 症状链（用户三轮实测）：
 *   · create（add）成功 —— 房间建得出来、开过几局
 *   · bid / roll / spin（update）**全部**报 -502001 database request fail
 *   · 本地 116+ 项断言全绿（mock 的 update 是 Object.assign，undefined 照写）
 *
 * 嫌疑：真实数据库要序列化，data 里一旦混进 `undefined`，整次写入就被拒，
 * 报的还是**没有任何语义的通用码**。而这种表达式满仓都是：
 *     byName: mySeat.name          （玩家没有 name 时 undefined）
 *     lastResult: result           （result 为 undefined 时）
 *     streaks: result ? result.streaks : (room.streaks || {})
 * 为什么不加断言也能拦住？—— 本地 mock 不序列化，**永远测不出来**。
 *
 * 做法：在集合外面包一层，**所有写入的 data 都过 cleanData**。
 *   · 一处改动，全链路生效（56 处调用点不用逐个改，也就不会漏）
 *   · 只清洗**普通对象/数组**；Date、db.command 操作符（_.push 等）原样保留
 *   · 与"收敛成唯一出口"的项目惯例一致：decorate / stageOf / dbCall 都是这么做的
 */
function cleanData(v) {
  if (v === undefined) return undefined
  if (v === null) return null
  if (Array.isArray(v)) {
    /* 数组里的 undefined 直接丢掉（JSON 里本来就是 null，但 null 会覆盖原值） */
    return v.map(cleanData).filter(function (x) { return x !== undefined })
  }
  if (v && typeof v === 'object' && Object.getPrototypeOf(v) === Object.prototype) {
    const out = {}
    Object.keys(v).forEach(function (k) {
      const cv = cleanData(v[k])
      if (cv !== undefined) out[k] = cv
    })
    return out
  }
  /* Date / db.command 操作符 / 其它实例：原样返回，不能破坏它们 */
  return v
}

/*
 * ★★★ 对象值必须用 _.set 整体替换（2026-10-29 真机实测定案 —— 「从来没正常玩过」的根因）
 *
 * 微信云开发 update 对**普通对象**值是**深度合并**语义：内部展开成
 *   $set: { 'bid.face': 1, 'bid.n': 1 }
 * 而房间文档 create 时把 bid / lastResult 初始化成 **null**，于是第一次叫骰写
 *   update({ data: { bid: { n: 1, face: 1 } } })
 * 被 MongoDB 拒绝：
 *   Cannot create field 'face' in element {bid: null}
 * → 整次写入失败 → 前端只看到「操作失败了，再试一次」。
 * **每一局、每一个房间、第一次叫骰/摇骰/转盘都必然失败**，与网络、配额无关。
 *
 * 真机实测（.tooling/repro-bid.js + probeWrite）：
 *   turn / turnAt / updatedAt / players 回写 → ok
 *   bid / lastResult / streaks（对象）      → FAIL -502001
 *   bid = null / lastResult = null          → ok（null 不走深度合并）
 *   本地 mock 原来是 d[k]=v 整体赋值 → 117 项断言全绿也永远发现不了。
 *
 * 修法：写出时对普通对象/数组包 _.set()（set 语义 = 直接设值，不合并）。
 * 命令对象（_.push/_.inc 等）必须原样保留，不能包。
 */
function needsSet(v) {
  if (v === null || v === undefined) return false
  if (v.__op) return false                    /* mock 的命令对象标记 */
  if (Array.isArray(v)) return true
  /* 只包普通对象；wx-server-sdk 的 Command 实例原型不是 Object.prototype，天然被排除 */
  return typeof v === 'object' && Object.getPrototypeOf(v) === Object.prototype
}

/** 清洗 undefined + 对象值改 _.set（写库的唯一出口） */
function cleanOpt(opt) {
  if (!opt || typeof opt !== 'object' || !('data' in opt)) return opt
  const d = cleanData(opt.data)
  if (!d || typeof d !== 'object') return Object.assign({}, opt, { data: d })
  const out = {}
  Object.keys(d).forEach(function (k) {
    out[k] = needsSet(d[k]) ? _.set(d[k]) : d[k]
  })
  return Object.assign({}, opt, { data: out })
}

const _roomsRaw = db.collection('rooms')

/** 文档包装：set / update 都过清洗 */
function wrapDoc(d) {
  return {
    get: function () { return d.get() },
    set: function (opt) { return d.set(cleanOpt(opt)) },
    update: function (opt) { return d.update(cleanOpt(opt)) },
    remove: function () { return d.remove() }
  }
}

/** 查询包装：get/count 原样，update/remove 的 data 过清洗 */
function wrapQuery(q) {
  const self = {
    get: function () { return q.get() },
    count: function () { return q.count() },
    limit: function (n) { q.limit(n); return self },
    skip: function (n) { q.skip(n); return self },
    orderBy: function (f, dir) { q.orderBy(f, dir); return self },
    field: function (f) { q.field(f); return self },
    update: function (opt) { return q.update(cleanOpt(opt)) },
    remove: function () { return q.remove() }
  }
  return self
}

/* 前端所有写库都走它 —— 名字仍叫 rooms，调用点一行都不用改 */
const rooms = {
  doc: function (id) { return wrapDoc(_roomsRaw.doc(id)) },
  where: function (cond) { return wrapQuery(_roomsRaw.where(cond)) },
  /* add = Insert 整文档，**不能**用 _.set（命令对象不是合法字段值），只清洗 undefined */
  add: function (opt) {
    if (!opt || typeof opt !== 'object' || !('data' in opt)) return _roomsRaw.add(opt)
    return _roomsRaw.add(Object.assign({}, opt, { data: cleanData(opt.data) }))
  },
  count: function () { return _roomsRaw.count() }
}

/*
 * 房间码：**3 位纯数字**（000~999）。
 *
 * 2026-10-09 用户要求「房间号简单一点，纯数字即可，三个数」。
 * 原来是 6 位 × 32 字符集（去掉 I/O/0/1 这些容易看错的字符）。
 *
 * ★★ 但 3 位只有 1000 个号，撞码从"可忽略"变成"必须处理"：
 *    按生日问题算，同时有 10 个活跃房间时撞码概率就有 4.4%，20 个时 17%。
 *    自用产品通常只有 1~2 个房间，够用 —— 但**不能靠概率**，因为
 *    撞码的后果不是"重开一次"，而是**进错房间**：
 *    join 里是 `where({code, active:true}).limit(1)` 取第一个匹配，
 *    两个活跃房间同号时，玩家会静默进到别人的房间去。
 *
 *    所以建号改成**穷举去重**（见 pickCode）：列出所有已被占用的号，
 *    从剩下的里随机挑。这样在号码空间耗尽前**保证不重复**。
 *
 * ⚠️ 纯数字的附带好处：不用再处理大小写（原 normCode 要 toUpperCase）。
 */
const DIGITS = '0123456789'
const CODE_LEN = 3
/*
 * 号码空间由位数**派生**（2026-10-28）。
 * 原来两个数字分开写死（3 和 1000），改一个忘另一个就会：
 *   · 只改位数 → 号码池还是 1000，但实际只能发 10^n 个号 → 提前"没号了"或越界
 *   · 只改空间 → 生成出 4 位号码而前端输入框还限 3 位 → **玩家永远输不对**
 * 派生之后这种不一致在语法层面就不存在。
 */
const CODE_SPACE = Math.pow(10, CODE_LEN)

/* 房间存活时间：2 小时没人动就当作废弃。
   酒桌游戏一局最多几十分钟，2 小时足够宽松。 */
const TTL_MS = 2 * 3600 * 1000

/*
 * 每人几颗骰（2026-10-28 从函数里的 `const n = 5` 提上来）。
 * 提成常量是为了让"文案里的颗数"能被断言核对 —— 改了这个数，
 * games.js 里写的「每人 5 颗」如果不跟着改，测试会报。
 */
const DICE_PER_PLAYER = 5

/* 单房间人数上限 —— 一部手机传着玩，人太多轮不过来 */
/*
 * ⚠️ 这个常量曾经是**全局上限 8**，而注册表里每个玩法写着各自的 max ——
 *    由此产生两个方向的不一致：
 *      · 卧底 min=3 max=**12**，但全局 8 把它挡在 8 人，12 人根本进不来
 *      · 金花 max=**6**，全局 8 却允许第 7、第 8 个人进来（超员）
 *    现在按玩法取上限（见 gameCap），这个常量只作**兜底安全值**。
 */
const MAX_PLAYERS = 8

/**
 * 某个玩法的房间人数上限。
 * 注册表没写就退回兜底值 —— 不返回 Infinity，避免异常数据把房间撑爆。
 */
function gameCap(gameId) {
  const g = gameOf(gameId)
  const n = g && Number(g.max)
  return Number.isFinite(n) && n > 0 ? n : MAX_PLAYERS
}

/* 自定义题：单条长度上限 / 每人每类条数上限 */
const MAX_CARD = 60
const MAX_CARDS_PER_KIND = 20

/* 开局倒计时：3 秒。太短来不及反应，太长会等得烦 */
/*
 * ★ 2026-11-02 用户实测：「进入房间的准备画面，4 秒太长」。
 *
 * 原来是 3200ms。听起来不长，但用户感知的是：
 *   点开始 → 云函数往返(0.7~1.3s) → 倒计时 3200ms → 轮询发现 playing(再 0~1.5s)
 * 加起来 4 秒以上，而且倒计时期间**什么都不能做**。
 *
 * 改 2000ms：读秒变成 2、1、开始 三拍，节奏紧凑但不慌。
 * 倒计时的作用只是"让所有人同时看到开局"，2 秒足够。
 */
const COUNTDOWN_MS = 2000

/*
 * 转盘扇区 —— ★ 必须与前端 miniprogram/pages/game/room/room.js 的
 * SECTORS 完全一致（键、权重、文案）。不一致会导致
 * 「指针指着喝一杯、判出来是真心话」，最伤信任。
 * scripts/test-wheel.js 会断言两边一致。
 */
const WHEEL_SECTORS = [
  { k: 'truth', t: '真心话', weight: 22 },
  { k: 'dare',  t: '大冒险', weight: 20 },
  { k: 'drink', t: '喝一杯', weight: 18 },
  { k: 'you',   t: '你喝',   weight: 14 },
  { k: 'me',    t: '我喝',   weight: 12 },
  { k: 'both',  t: '一起喝', weight: 8 },
  { k: 'pass',  t: '免罚一次', weight: 6 }
]

/**
 * 生成一个还在用的房间号。
 *
 * ★ 为什么不是"随机生成 + 撞了就重试"：
 *   3 位只有 1000 个号。随机重试在房间多起来后会**反复撞**，
 *   重试 5 次全失败就只能报错让用户重开 —— 体验差且不可控。
 *
 *   改成**穷举去重**：一次查出所有活跃房间的号，从"没被占用的"里随机挑。
 *   代价是每次建房多一次查询（本来就要查重，成本一样），
 *   换来的是**号码空间耗尽前绝不重复** —— 这才是"不靠概率"。
 *
 * @returns {Promise<string|null>} 可用号码；null = 号码用满了
 */
async function pickCode() {
  /*
   * ★★ 只统计**未过期**的房间（2026-10-09 修的真实缺陷）。
   *
   * 老写法是 `where({ active: true })`，但 **active 永远不会被置回 false** ——
   * 全项目只有一处把它设成 false（房主主动解散时），
   * 房间里的人直接退出去、或者干脆关掉小程序，房间就一直挂着 active:true。
   *
   * 而 3 位号码只有 1000 个。过期房间占着号不放 → **号码池只减不增**：
   *   每天 10 局 → 100 天后永久报「房间号用满了，等一会儿再开」
   *   （而且"等一会儿"永远不会好，因为没有任何机制回收号码）
   *
   * 为什么"过期就该释放"是成立的：`loadRoom` / `join` 里都有
   * `isStale(room) → 拒绝`，**过期房间本来就谁也进不去** ——
   * 它占着号码是纯粹的浪费，不是"保护"。
   *
   * 用 updatedAt 做时间下界（心跳每轮都会刷新它），而不是遍历后再过滤：
   * 让数据库只返回真正可能冲突的那些行。
   * ⚠️ 兼容老数据：createdAt 缺失时用 updatedAt 兜底，两者都没有则视为"很旧"。
   */
  const aliveSince = now() - TTL_MS
  /*
   * ⚠️ limit **必须**是 CODE_SPACE，不能为了快改成 200（2026-10-30 试过，被断言拦下）。
   *
   * 原因：`used` 集合用来判断"号是不是发完了"。只拉 200 条时，
   * 若真有 1000 个未过期房间占满所有号，`used.size` 只有 200 < 1000 →
   * 判定为"还有空号"→ while 循环里撞不出空号 → **发出重复号码** →
   * 玩家 join 时取第一个匹配，**进错房间**。这是静默的严重错误。
   * 对应的断言在 test-room（"1000 个号被未过期房间占满时必须明确拒绝"）。
   * 真要提速，得改成 count() + 分页，而不是砍 limit。
   */
  const r = await rooms.where({
    active: true,
    updatedAt: _.gt(aliveSince)
  }).field({ code: true }).limit(CODE_SPACE).get()
    .catch(() => ({ data: [] }))
  const used = new Set((r.data || []).map(x => x.code))

  if (used.size >= CODE_SPACE) return null      // 号发完了

  /*
   * 先从**全部号码**里随机起点、顺序找第一个没占用的。
   * 不用"列出所有空闲号再随机挑" —— 那要建一个 1000 元素的数组，
   * 而 1000 以内顺序探测最多 1000 次、每次都只是 Set 查找，够快。
   * 随机起点是为了让号码分散，不是每次都从 000 开始。
   */
  const start = Math.floor(Math.random() * CODE_SPACE)
  for (let i = 0; i < CODE_SPACE; i++) {
    const c = String((start + i) % CODE_SPACE).padStart(CODE_LEN, '0')
    if (!used.has(c)) return c
  }
  return null
}

/** 房间号归一化：只留数字，最多 3 位。纯数字就不用处理大小写了 */
function normCode(c) {
  return String(c || '').replace(/\D/g, '').slice(0, CODE_LEN)
}

function now() { return Date.now() }

/** 内容安全。fail-closed（发布策略）：检查不通过或服务不可用都拒绝 */
/**
 * @param {string} text
 * @param {string} openid
 * @param {object} [opt]
 * @param {boolean} [opt.degradable] 检查服务**自身不可用**时是否放行。
 *   昵称用 true（它不是公开内容、风险低、而且拦掉等于整个产品不可用）；
 *   自定义题卡用 false（那是会展示给全场看的 UGC，必须严格）。
 */
async function safe(text, openid, opt) {
  if (!text) return { pass: true }
  try {
    const r = await cloud.openapi.security.msgSecCheck({
      content: text, openid: openid, scene: 2, version: 2
    })
    const s = r && r.result && r.result.suggest
    if (s && s !== 'pass') return { pass: false, msg: '这里有系统判断为风险的内容，改一改' }
    return { pass: true }
  } catch (err) {
    /*
     * 把真实错误码带回前端 —— 否则只能看到「服务不可用」这句笼统的话，
     * 没法区分是「接口挂了」「权限没绑」还是「调用参数不对」。
     * 开发阶段带 errCode，上线后可以按需收紧。
     */
    const code = (err && (err.errCode || err.code)) || 'unknown'
    const detail = (err && (err.errMsg || err.message)) || ''
    console.error('[room] msgSecCheck 调用失败：', code, detail)
    /*
     * ★★ 可降级的场景放行（2026-10-29，用户报"所有游戏开不了房间"）。
     *
     * 原来这里**一律 fail-closed** —— 逻辑上合规，但实测后果是：
     * openapi 权限在部署后需要几次才绑定生效（本文件下面就有这条笔记），
     * 那段时间里**每一次建房都会被拒**，而且提示是"内容检查服务暂时不可用"，
     * 用户完全不知道该怎么办。整个产品等于挂了。
     *
     * 权衡：
     *   · 昵称 —— 12 个字、不公开展示给陌生人、风险极低，**放行**
     *   · 自定义题卡 —— 会展示给全场，**仍然拦**
     * 放行时打 `degraded: true`，调用方可以据此记日志。
     */
    if (opt && opt.degradable) {
      console.error('[room] 内容检查不可用，按可降级放行：', code)
      return { pass: true, degraded: true, _code: code }
    }
    return {
      pass: false,
      code: 'SEC_UNAVAILABLE',
      msg: '内容检查服务暂时不可用，稍后再试',
      /* 带上错误码 —— 否则日志里只有「服务不可用」这句笼统的话，
         没法区分是接口挂了、权限没绑、还是调用参数不对。
         实测踩过：新函数部署后 openapi 权限需要几次部署才绑定生效，
         没有错误码时完全看不出是这个原因。 */
      _code: code
    }
  }
}

/** 房间是否已过期（废弃） */
function isStale(room) {
  return now() - (room.updatedAt || room.createdAt || 0) > TTL_MS
}

/**
 * 给前端的房间视图。
 * ★ 关键：骰子按 openid 过滤 —— 别人的骰子不在响应里。
 */
/**
 * 更新连庄计数。
 *
 * ★ 原来只有「比大小」在算连赢，大话骰 / 金花 / 卧底从来不计 ——
 *   而 `streaks` 这个字段一直在（比大小要它来放连击音效）。
 *   现在收敛成一个 helper：**谁赢由调用方给判据**，这里只管记账。
 *
 * @param {object} prev 旧的 streaks（{ seat: count }）
 * @param {Array} players 当前玩家
 * @param {function} isWinner (player) => boolean
 * @returns {{streaks: object, maxStreak: number}}
 */
function bumpStreaks(prev, players, isWinner) {
  const streaks = {}
  let maxStreak = 0
  ;(players || []).forEach(p => {
    const won = !!isWinner(p)
    const n = won ? ((prev || {})[p.seat] || 0) + 1 : 0
    streaks[p.seat] = n
    if (n > maxStreak) maxStreak = n
  })
  return { streaks: streaks, maxStreak: maxStreak }
}

function shape(room, openid) {
  const players = (room.players || []).map(p => ({
    openid: p.openid,
    name: p.name,
    seat: p.seat,
    isMe: p.openid === openid,
    isHost: p.openid === room.hostOpenid,
    /*
     * 心跳窗口 30 → 20 秒（2026-10-28）。
     * 轮询是 1.5 秒一次，30 秒意味着一个人锁屏后要等半分钟才被发现"掉了"——
     * 而桌上最常发生的就是"他去接电话了，我们等他投完"。
     * 20 秒仍留了充足容错（网络抖动一两次不会误判）。
     */
    online: now() - (p.lastSeen || 0) < 20000,
    /* ★ 是否参与本局：中途进来的是 false（这一局只观战），下一局自动变 true */
    /*
     * ⚠️ 这里原本还有两个死字段，已移除：
     *   · `ready`（"准备"状态）—— 早期"每人点准备"设计的残留，
     *     云端只写不读（从没被设成 true），前端完全没引用。
     *   · `cardsCount`（别人的牌数）—— 金花每人固定 2 张，没有信息量。
     * 判据见 test-contract ⑤b：shape() 返回的字段必须被前端引用。
     */
    inRound: p.inRound !== false,
    score: p.score || 0,
    /* ★ 只有自己的骰子才返回；别人的在服务端就丢掉 */
    dice: p.openid === openid ? (p.dice || []) : undefined,
    diceCount: (p.dice || []).length
  }))

  const me = players.filter(p => p.isMe)[0] || null

  return {
    id: room._id,
    code: room.code,
    game: room.game || '',          // 见 utils/games.js 的 GAMES[].id
    phase: room.phase || 'lobby',   // lobby | countdown | playing | over
    host: room.hostOpenid === openid,
    me: me ? { seat: me.seat, name: me.name, dice: me.dice || [] } : null,
    players: players,
    count: players.length,
    /* 游戏相关的公共状态（不含任何人的私密骰子） */
    /* 倒计时剩余毫秒（前端本地算更准，这里给基准） */
    countdownMs: room.phase === 'countdown' ? Math.max(0, (room.countdownEnd || 0) - now()) : 0,
    turn: room.turn || 0,           // 轮到第几号座位
    locked: !!room.locked,          // 房主锁房（别人进不来）
    round: room.round || 0,
    /*
     * bid 里补一个 lastSeat = 「最近一次动作」是谁做的（叫骰或劈）。
     * 前端据此决定"能不能劈"（自己刚动过的不能再劈自己）——
     * 判据只放一处，避免前端自己再推一遍导致两边不一致。
     */
    bid: room.bid ? Object.assign({}, room.bid, {
      lastSeat: room.bid.piSeat || room.bid.bySeat
    }) : null,          // 大话骰：当前叫骰
    lastResult: room.lastResult || null,
    streaks: room.streaks || {},
    /* 转盘：当前这一转的结果（所有人靠它同步看到同一个扇区） */
    spin: room.spin || null,
    /* 题卡场合（转盘用）—— 全场要看到同一个，所以放在房间状态里。
       谁是卧底复用这个字段存"词库"。 */
    deck: room.deck || 'friends',
    /* 今晚谁喝过几杯（只统计输家明确的玩法，见 again 分支的说明） */
    nightDrinks: room.nightDrinks || {},
    /*
     * 谁是卧底：★★ 这一块是整个玩法的**命门**。
     *
     * 规则的本质是"只有卧底看到不同的词"，所以：
     *   · 每个人的词**只发给他自己**（别人的 word 在服务端就丢掉）
     *   · **谁都不返回身份** —— 连自己的身份也不返回。
     *     真实玩法里卧底并不知道自己是卧底，他要从别人的描述里察觉
     *     "我好像说错了"。告诉他身份，这个游戏最有趣的部分就没了。
     *   · 只有出局者 / 游戏结束时才公开词与身份
     */
    /* 梦幻金花：只给自己的牌，别人的牌在服务端就丢掉（与骰子同一套做法） */
    poker: (function () {
      if (room.game !== 'poker') return null
      const meP = (room.players || []).filter(p => p.openid === openid)[0] || null
      if (!meP) return null
      const alive = (room.players || []).filter(p => p.inRound !== false && !p.out)
      const myHand = meP.cards || []
      return {
        step: room.pkStep || 'play',
        /* 公共牌：全场共用，本来就该看得见 */
        publicCard: room.pkPublic || null,
        publicText: room.pkPublic ? poker.cardText(room.pkPublic) : '',
        /* 明牌：只有自己看得见 */
        myKnown: myHand[0] || null,
        myKnownText: myHand[0] ? poker.cardText(myHand[0]) : '',
        /*
         * ★ 暗牌**不返回**（连自己都看不到）—— 这是这个玩法的核心：
         *   每个人只知道 2/3，第三张靠想象。
         *   发到前端再藏起来不算数，抓包就穿了。
         */
        folded: !!meP.out,
        /* 我为了换牌喝掉的量（半杯 = 0.5） */
        myDrink: (room.pkDrink || {})[openid] || 0,
        /*
         * ★ 所有人的换牌量 —— 这是**公开信息**：
         *   谁换牌谁喝酒，桌子上的人都看见了；而且比牌列表里
         *   "他换过几次"是很有用的决策线索（换得多说明手里不好，或者很拼）。
         *   ⚠️ 只暴露"喝了多少"，不暴露"换的是底牌还是手牌"，
         *      也不暴露换之前的牌 —— 那些是私密的。
         */
        drinks: (room.players || [])
          .filter(p => p.inRound !== false)
          .map(p => ({
            name: p.name,
            cups: Number((room.pkDrink || {})[p.openid]) || 0,
            out: !!p.out
          })),
        aliveCount: alive.length,
        /* 比牌历史：双方亮过的牌（公开信息，本来就是为了让全场看见） */
        last: room.pkLast || null,
        winner: room.pkWinner || null
      }
    })(),
    uw: (function () {
      if (room.game !== 'undercover') return null
      const meRaw = (room.players || []).filter(p => p.openid === openid)[0] || null
      if (!meRaw) return null
      const over = room.phase === 'over'
      const outRow = (room.uwOut || []).filter(x => x.openid === openid)[0] || null
      const revealOwn = over || !!outRow
      const alive = (room.players || []).filter(p => p.inRound !== false && !p.out)
      return {
        step: room.uwStep || 'talk',
        /* 我的词：进行中就要给（要说描述），出局/结束也不怕给 */
        word: meRaw.uwWord || '',
        /* ★ 我的身份：**只在我出局之后或游戏结束才告诉我**。
           真实玩法里卧底并不知道自己是卧底 —— 他要从别人的描述里
           察觉"我好像说错了"。提前告诉他，最有趣的那层就没了。 */
        myRole: revealOwn ? (meRaw.uwRole || '') : '',
        myVote: ((room.votes || []).filter(v => v.by === openid)[0] || {}).target || '',
        voteCount: (room.votes || []).length,
        voterCount: alive.length,
        /*
         * ★★ 谁还没投（2026-10-28，调研结论第 2 条）：
         *   "投票类没有'还差谁'这一层，桌上只能干等，没有催的手段。"
         *
         *   排除自己：自己投没投自己知道，列出"还差你"没有意义。
         *   只给名字不给身份 —— 这不泄露任何东西，投票本来就是公开的。
         */
        waitingNames: alive
          .filter(p => p.openid !== openid && !(room.votes || []).some(v => v.by === p.openid))
          .map(p => p.name),
        waitingCount: alive
          .filter(p => p.openid !== openid && !(room.votes || []).some(v => v.by === p.openid)).length,
        /*
         * 平票重投：第一次平票不淘汰任何人，让平票的几个人各补一句、再投一次；
         * 第二次仍平票则由卧底获胜（"投不出结果"本身就是好人的失败）。
         * 见 uwVote 里的说明 —— 这里只负责把状态透给前端。
         */
        tieBreak: !!room.uwTieBreak,
        /* 催一下的时间戳：前端比对变化来播提示音（不改就不播） */
        nudgeAt: room.uwNudgeAt || 0,
        tieNames: room.uwTieNames || '',
        aliveCount: alive.length,
        /* 上一轮出局的人：公开他的词和身份 —— 这是全场最想看的一刻 */
        lastOut: room.uwLastOut || null,
        /* 结束时把所有人摊开 */
        reveal: over ? (room.uwReveal || null) : null
      }
    })(),
    /*
     * 这个房间自己加的题：只返回**条数**和**我自己加的**。
     * 不把所有人的自定义题全量下发 —— 那是"别人的输入"，前端用不到全量，
     * 而且列表长了会把房间状态撑大（每 1.5 秒轮询一次）。
     */
    myCards: (room.cards || [])
      .filter(c => c.by === openid)
      .map(c => ({ type: c.type, text: c.text })),
    updatedAt: room.updatedAt || 0
  }
}

/*
 * ★ 数据库操作的统一重试 + 失败标记（2026-10-29）。
 *
 * 背景：用户实测「点叫骰 → 操作失败了，再试一次」，错误记录里只剩这一句
 * 人话兜底，**排查线索全断了** —— 根本不知道是 update 还是 get、错误码是多少。
 * （历史遗留：2026-10-10 就复现过「叫骰 → document.update:fail -502」，
 *   当时只建了复现脚本 .tooling/diag-bid.js，没把线索接进产品。）
 *
 * 做两件事：
 *   ① **重试一次**：数据库偶发抖动（-502 这类）第二次通常就过。
 *      bid 的 update 是覆盖式赋值（bid/turn/turnAt/updatedAt），重试安全；
 *      get 是纯读，天然幂等。
 *   ② **给错误打 stage 标记**：外层 catch 只把「阶段名 + 数字错误码」
 *      透给前端的错误记录（_diag），**不透原始错误串、不透数据** ——
 *      与 _code 的安全口径一致（见 create 分支 _code 处的说明）。
 */
async function dbCall(stage, fn) {
  try {
    return await fn()
  } catch (e1) {
    try {
      return await fn()
    } catch (e2) {
      const err = e2 || e1 || new Error('db fail')
      err.stage = stage
      throw err
    }
  }
}

/*
 * ★★★ 带乐观锁的文档更新（2026-10-30）。解决的是**多人同时操作导致数据被覆盖**。
 *
 * 真实场景：比大小开局，4 个人几乎同时点「摇骰」。每个请求都是
 *   读房间 → 把自己 dice 塞进 players 数组 → 整体覆盖写回
 * 而云函数之间没有共享内存，两个请求会读到**同一个旧快照**：
 *   A 读 {players:[{},{}]} → 写 A 的骰子
 *   B 读 {players:[{},{}]}（同一快照）→ 写 B 的骰子，**把 A 的冲掉**
 * 后果不是"少一个骰子"这么轻：`全员摇完` 永远不成立 → **这局永远结束不了**。
 * （用 .tooling/race-roll.js 真复现过：甲的骰子变成 []，phase 卡在 playing。）
 *
 * 做法：把"读最新 → 重算 → 写回"包成一个循环，写的时候带条件
 * `updatedAt === 刚才读到的值`：
 *   · 没人抢 → stats.updated = 1，成功
 *   · 被抢了 → stats.updated = 0，重读、重算、再写（带一点随机退避，避免同步重撞）
 *
 * ⚠️ buildData 必须**完全基于传入的最新房间**计算，不能闭包捕获外面读到的旧 room，
 *    否则重试等于用旧数据再冲一次。随机数（骰子点数）要在**循环外**生成，
 *    不然每次重试都会换一个点数 —— 玩家会看到"我摇的骰子变了"。
 */
async function updateGuarded(roomId, buildData, tries) {
  const max = tries || 4
  for (let i = 0; i < max; i++) {
    const r = await rooms.doc(roomId).get()
    const room = r && r.data
    if (!room) throw new Error('房间不见了')
    const data = buildData(room)
    if (!data) return room
    /* 老文档可能没有 updatedAt：没有就不带这个条件（第一次写会补上） */
    const cond = { _id: roomId }
    if (typeof room.updatedAt === 'number') cond.updatedAt = room.updatedAt
    const res = await rooms.where(cond).update({
      data: Object.assign({}, data, { updatedAt: Date.now() })
    })
    if (res && res.stats && res.stats.updated > 0) return Object.assign({}, room, data)
    /* 被抢先：退避一下再重试（随机，避免两个请求同步重撞） */
    await new Promise(function (done) { setTimeout(done, 4 + Math.random() * 12) })
  }
  throw new Error('同时操作的人太多了，这次没抢上')
}

/** 统一取房间：按 id 或 code，并校验"我是不是房间里的人" */
async function loadRoom(event, openid, needMember) {
  let room = null
  if (event.id) {
    const r = await rooms.doc(String(event.id)).get().catch(() => null)
    room = r && r.data
  } else if (event.code) {
    /*
     * 按 code 找房间。
     *
     * ★★ 必须排除**已过期**的房间（2026-10-09 修的真实缺陷，而且是上一轮
     *    「号码回收」修复自己引入的回归）。
     *
     *    背景：pickCode 现在会把过期房间的号码回收给新房间（这是对的）。
     *    但过期的老房间**文档还在、active 仍是 true**，
     *    于是「按 code 查」会同时匹配到两条：
     *        老房间（号码被回收，自己已过期）
     *        新房间（刚拿到这个号码，正常可用）
     *    而 `limit(1)` 取第一个 —— 命中老房间 → isStale 拒绝 →
     *    **玩家看到「这个房间已经过期了」，可新房间明明好好的**。
     *
     *    实测复现：老房间过期 → 号码 283 被回收给新房间 →
     *    别人输 283 进来 → 报「已过期」（新房间 id 才是该进的）。
     *
     *    判据与 pickCode 保持一致：只认未过期的房间。
     *    这样「活跃号码空间」和「按号能找到的房间」就是同一个集合。
     */
    const r = await rooms.where({
      code: normCode(event.code),
      active: true,
      updatedAt: _.gt(now() - TTL_MS)
    }).limit(1).get().catch(() => ({ data: [] }))
    room = (r.data || [])[0]
    /* 老数据可能没有 updatedAt（早期版本写的），退回按 createdAt 也查一次 */
    if (!room) {
      const r2 = await rooms.where({
        code: normCode(event.code), active: true, createdAt: _.gt(now() - TTL_MS)
      }).limit(1).get().catch(() => ({ data: [] }))
      room = (r2.data || [])[0]
    }
  }
  if (!room) return { err: '房间不存在或已解散' }
  if (isStale(room)) return { err: '房间已过期（超过 2 小时没人玩了）' }
  const isMember = (room.players || []).some(p => p.openid === openid)
  if (needMember && !isMember) return { err: '你不在这个房间里' }
  return { room, isMember }
}

exports.main = async (event) => {
  const { OPENID } = cloud.getWXContext()
  const action = event.action || 'status'
  const ts = now()

  try {
    /* ================= 预热（ping） ================= */
    /*
     * 只做一件事：让云函数**先热起来**。
     *
     * 2026-10-28 加。用户反馈"手机加载特别慢"、点转盘还弹"操作失败"——
     * 云函数是**按需冷启动**的：容器闲置一段时间会被回收，下次调用要重新拉起
     * （实测 1~5 秒）。而这个小程序的所有动作都走云函数，
     * 于是"打开 → 点玩法 → 转一下"里，第一下最容易撞上冷启动、甚至超时失败。
     *
     * 做法：小程序启动时（app.js 的 onLaunch）发一个空请求把容器叫醒，
     * 等人真的点下去时容器已经是热的。这个请求不碰数据库、不写任何东西，
     * 所以随便失败也不影响任何玩法。
     */
    if (action === 'ping') {
      return { ok: true, pong: ts, fn: 'room' }
    }

    /* ================= 数据库自检（selftest） ================= */
    /*
     * ★ 2026-10-29 晚加。用户报「游戏从来没正常玩过」，而 -502001 是
     *   **无语义的通用码**（官方文档原话）—— 再靠猜就是浪费用户的时间。
     *
     *   做法：对 rooms 集合跑一遍 最小写入→读→改→删 的完整链路，
     *   每步只回「步骤名 + 成败 + 错误码/操作类别/特征标签」——
     *   与 _diag 同一脱敏口径（不回原始错误串、不回文档 id）。
     *   前端「我的 → 复制诊断信息」会先跑一次它，把结果拼进诊断文本。
     *
     *   自检文档即建即删；删失败也不影响（probe 字段过滤，且过期清理会带走）。
     */
    if (action === 'selftest') {
      const steps = []
      const snap = (s, ok, err) => {
        const raw = err ? String((err.errMsg || err.message) || '') : ''
        const opM = raw.match(/FailedOperation\.(\w+)/)
        steps.push({
          s: s, ok: !!ok,
          code: (raw.match(/-\d{2,6}/) || [])[0] || '',
          op: opM ? opM[1] : '',
          tag: /key too large|Index/i.test(raw) ? 'keyTooLarge'
            : /timeout|timed out/i.test(raw) ? 'timeout'
            : /exceed|limit|quota|rate/i.test(raw) ? 'quota'
            : /permission/i.test(raw) ? 'perm' : ''
        })
      }
      let pid = null
      try {
        const r = await rooms.add({ data: { probe: true, createdAt: ts, updatedAt: ts } })
        pid = r && r._id
        snap('add', !!pid)
      } catch (e) { snap('add', false, e) }
      if (pid) {
        try { await rooms.doc(pid).get(); snap('get', true) } catch (e) { snap('get', false, e) }
        try {
          await rooms.doc(pid).update({ data: { probe: 2, updatedAt: ts } })
          snap('update', true)
        } catch (e) { snap('update', false, e) }
        /*
         * ★★ 2026-10-29 晚的关键实验：微信云数据库**能不能写 undefined**。
         *
         * 怀疑链：本地 mock 的 update 是直接 Object.assign，undefined 照写不误；
         * 而真实数据库要序列化，data 里一旦混进 undefined（`byName: p.name`、
         * `lastResult: result`、`streaks: result ? ... : ...` 这类表达式极易产出），
         * 整次写入就可能被拒成 -502001 —— 于是「add 能成（create 建房）、
         * 所有 update 全挂（叫骰/摇骰/转盘）」，而 116 项断言全绿也发现不了。
         *
         * 两条一起测，才能分清是「undefined 不行」还是「update 本身不行」：
         *   updateNull  写 null  → 应成功（对照组）
         *   updateUndef 写 undefined → 若失败，假设成立，必须全链路清洗
         */
        try {
          await rooms.doc(pid).update({ data: { probeN: null } })
          snap('updateNull', true)
        } catch (e) { snap('updateNull', false, e) }
        try {
          await rooms.doc(pid).update({ data: { probeU: undefined } })
          snap('updateUndef', true)
        } catch (e) { snap('updateUndef', false, e) }
        try { await rooms.doc(pid).remove(); snap('remove', true) } catch (e) { snap('remove', false, e) }
      } else {
        snap('get', false); snap('update', false); snap('updateNull', false)
        snap('updateUndef', false); snap('remove', false)
      }
      try { await rooms.where({ probe: true }).count(); snap('count', true) } catch (e) { snap('count', false, e) }

      /*
       * ★ 对**用户正在玩的那个房间文档**做一次真实探测（2026-10-29）。
       *   自检文档是新建的空文档，测不出"真实房间文档（有 players/bid/spin）"
       *   上的问题 —— 前端出错时会自动把出事房间的 id 传进来（cloud.js）。
       *   写入是无害的：updatedAt 写回它原本的值（心跳本来也在写这个字段）。
       */
      if (event.probeRoomId) {
        const rid = String(event.probeRoomId)
        try {
          const rr0 = await rooms.doc(rid).get()
          snap('room.get', !!(rr0 && rr0.data))
          const keep = (rr0 && rr0.data && rr0.data.updatedAt) || ts
          try {
            await rooms.doc(rid).update({ data: { updatedAt: keep } })
            snap('room.update', true)
          } catch (e) { snap('room.update', false, e) }
        } catch (e) {
          snap('room.get', false, e)
          snap('room.update', false, e)
        }
      }
      return { ok: true, probe: steps, ts: ts }
    }

    /* ================= 字段级写入探测（probeWrite） ================= */
    /*
     * ★★ 2026-10-29 晚。真实复现（.tooling/repro-bid.js）给出了决定性矛盾：
     *     · selftest 的 add/get/update/remove 全 ok
     *     · **start 的 update 也 ok**（写 phase/countdownEnd/players）
     *     · 对真实房间文档写 updatedAt 也 ok
     *     · 但 **bid / roll 的 update 必挂**（-502001）
     *   → 问题不在"update 通道"，而在**这次写入的具体内容**。
     *
     *   所以这里把 bid/roll 写过的字段**逐个单写**，一次定位是哪一个引发失败：
     *   turn / turnAt / bid 对象 / lastResult 对象 / streaks / players 数组回写。
     *
     * ⚠️ 安全约束：用例是**服务端硬编码**的（不接受前端任意 data），
     *   只能写入上列字段，且只会写进你指定的那个探针房间。
     */
    if (action === 'probeWrite') {
      const rid = String(event.probeRoomId || '')
      if (!rid) return { ok: false, msg: '缺少探针房间' }
      const cases = [
        { k: 'zzNum新字段', d: { zzNum: 1 } },
        { k: 'zzObj新字段', d: { zzObj: { a: 1 } } },
        /* ★ 对照实验，用来区分三种假设（2026-10-29）：
           A) 「已存在的字段」写不进去   B) 「值为对象」写不进去   C) 特定字段名有问题 */
        { k: 'zzObj二次(已存在)', d: { zzObj: { b: 2 } } },
        { k: 'phase(已存在字符串)', d: { phase: 'playing' } },
        { k: 'turn', d: { turn: 1 } },
        { k: 'turnAt', d: { turnAt: ts } },
        { k: 'bid（对象）', d: { bid: { n: 1, face: 1 } } },
        { k: 'bid=null', d: { bid: null } },
        { k: 'lastResult（对象）', d: { lastResult: { winner: 'x' } } },
        { k: 'lastResult=null', d: { lastResult: null } },
        { k: 'streaks（空对象）', d: { streaks: {} } },
        { k: 'streaks=null', d: { streaks: null } },
        { k: 'zzObjDeep（深一层）', d: { zzObj2: { a: { b: 1 } } } },
        { k: 'updatedAt', d: { updatedAt: ts } }
      ]
      const pick = e => {
        const raw = String((e && (e.errMsg || e.message)) || '')
        const opM = raw.match(/FailedOperation\.(\w+)/)
        return {
          code: (raw.match(/-\d{2,6}/) || [])[0] || '',
          op: opM ? opM[1] : '',
          hint: raw.slice(0, 460)
        }
      }
      const writes = []
      for (let i = 0; i < cases.length; i++) {
        const c = cases[i]
        try {
          await rooms.doc(rid).update({ data: c.d })
          writes.push({ k: c.k, ok: true })
        } catch (e) {
          writes.push(Object.assign({ k: c.k, ok: false }, pick(e)))
        }
      }
      /* 最后单独测「把真实 players 数组原样写回」（大数组 + 嵌套对象） */
      try {
        const rr = await rooms.doc(rid).get()
        const pl = (rr.data && rr.data.players) || []
        await rooms.doc(rid).update({ data: { players: pl } })
        writes.push({ k: 'players回写(' + pl.length + '人)', ok: true })
      } catch (e) {
        writes.push(Object.assign({ k: 'players回写', ok: false }, pick(e)))
      }
      return { ok: true, writes: writes, ts: ts }
    }

    /* ================= 建房间 ================= */
    if (action === 'create') {
      /*
       * ★ 顺手清理过期房间文档（2026-10-29）。
       *
       * "2 小时过期"只是**逻辑**过期（isStale 看 updatedAt），文档一直躺在
       * 集合里没人删 —— 玩得越多集合越大，pickCode 的"查全 1000 号"和
       * 按 code 查找都退化成慢查询，而慢查询正是 -502001（database request
       * fail）的高发场景。用户报「从来没正常玩过」后查到这里。
       *
       * 只删 24 小时前的：给"房间过期后人又回来接着玩"留足余量。
       * 尽力而为：清理失败不影响建房（catch 吞掉，下次 create 再试）。
       */
      /*
       * ★ 清理改成**概率触发**（2026-10-30）。
       *
       * 原来每次 create 都跑一次 `where({updatedAt: _.lt(...)}).remove()` ——
       * 这是全表条件删除，房间一多就是几百毫秒到几秒，而它挡在**建房路径**上。
       * 实测（automator 模拟器）：点玩法卡 → 房间号出现要 **5.86 秒**，
       * 而首屏只要 0.53 秒 —— 慢的这一段用户能明显感到"点了没反应"。
       *
       * 15% 概率触发：平均每 7 次建房清理一次，过期房最多多留几十分钟
       * （它们本来就有 2 小时 TTL，多留一会儿不影响正确性），
       * 但 85% 的建房省掉了这次全表删除。
       */
      if (Math.random() < 0.15) {
        try {
          await rooms.where({ updatedAt: _.lt(ts - 24 * 3600 * 1000) }).remove()
        } catch (e) { /* 清理失败不影响任何功能 */ }
      }

      const name = String(event.name || '').trim().slice(0, 12) || '玩家1'
      const game = gameOf(event.game) ? event.game : 'dice'
      /*
       * 题卡场合（转盘用）：房主开局前选，全场同步。
       * 校验用 deckOf —— 未知 key 会被回退成默认那副，不会让房间卡在无题可抽的状态。
       */
      const deck = decks.deckOf(String(event.deck || '')).k

      /*
       * ★ 只有**用户自己写的名字**才需要过内容安全（2026-10-28）。
       *   默认名「房主 / 玩家N」是系统生成的字符串，不可能违规，
       *   却白白多吃一次 openapi 往返（实测几百毫秒）——
       *   而云函数默认超时只有 3 秒，这一下足够把开局拖到超时。
       */
      const sec = await safe(String(event.name || '').trim().slice(0, 12), OPENID, { degradable: true })
      /*
       * 这里原来写的是 `_debug: sec._debug` —— 而 safe() 返回的字段叫 **`_code`**
       * （见 safe 里 `return { pass:false, code:'SEC_UNAVAILABLE', _code: code }`）。
       * 取一个不存在的字段 → 恒为 undefined，**排查信息实际没传到前端**，
       * 而它正是当初为了排查"openapi 权限没绑"才加的。
       * 改成正确的 `_code`，让那条排查线索真的可用。
       */
      if (!sec.pass) return { ok: false, msg: sec.msg, _code: sec._code }
      /*
       * 关于 `_code` 的安全性（想清楚了再改）：
       *   它是微信 openapi 的错误码（如 -601059），**不含 openid / 数据库 id / 堆栈**，
       *   前端也不展示它（只进 console 和日志）。它是"权限没绑 vs 接口挂了"的
       *   唯一区分线索 —— 去掉它等于把当初踩过的坑重新埋一遍。
       *   若将来要收紧，应该按环境开关，而不是直接删。
       */

      /*
       * 房间号：3 位数字，**穷举去重**（见 pickCode）。
       * 原来这里是"随机生成 + count 查重 + 重试 5 次" ——
       * 6 位 32 字符集时够用，但 3 位只有 1000 个号，
       * 房间一多就会反复撞、重试完还失败。改成一次查全、挑空闲的。
       */
      const code = await pickCode()
      if (!code) {
        return { ok: false, msg: '房间号用满了（同时最多 1000 个房间），等一会儿再开' }
      }

      const added = await rooms.add({
        data: {
          code: code,
          game: game,
          phase: 'lobby',
          hostOpenid: OPENID,
          players: [{
            openid: OPENID, name: name, seat: 1, score: 0, dice: [],
            inRound: true,          // 房主一定参与（单人房能直接开局）
            joinedAt: ts, lastSeen: ts
          }],
          turn: 0,
          round: 0,
          bid: null,
          lastResult: null,
          deck: deck,
          active: true,
          createdAt: ts,
          updatedAt: ts
        }
      })

      const r = await rooms.doc(added._id).get()
      return { ok: true, room: shape(r.data, OPENID) }
    }

    /* ================= 加入 ================= */
    if (action === 'join') {
      const code = normCode(event.code)
      if (code.length !== CODE_LEN) return { ok: false, msg: '房间号是 3 位数字' }

      /*
       * ★★ 默认名要**唯一**（2026-10-28）。
       *
       * 原来没设昵称的人一律叫「玩家」—— 两个人同时进房就是两个「玩家」，
       * 桌上完全对不上人：别人屏幕上写「玩家 叫了 3 个 4」，
       * 而屏幕前坐着的是谁、该谁喝，谁也说不清。
       *
       * 但座位号要等原子 push 之后重编号才知道（见下面的 `_.push` 竞态说明），
       * 所以这里先给占位名 —— 真正唯一的默认名在座位定下来之后再补。
       */
      const rawName = String(event.name || '').trim().slice(0, 12)
      const name = rawName || '玩家'
      /*
       * 同 create：只有用户自己写的名字才过内容安全，并且**必须同样降级**。
       *
       * ★★ 2026-10-29 晚真实故障：用户拿另一个微信号加入房间，被拒
       *    「内容检查服务暂时不可用，稍后再试」—— 建房能进、加入进不来。
       *    根因就是这一行漏了 { degradable: true }：
       *      · create 有降级 → 服务挂掉时建房照常
       *      · join 没有   → 服务挂掉时**新玩家全部进不来**
       *    而检查服务确实会不可用：openapi 权限在部署后要过一阵才重新生效，
       *    我这几天部署了几十次云函数 —— 这是必现场景，不是理论风险。
       *    昵称本来就只是桌上一句称呼（默认名还是系统生成的），
       *    宁可放行一个可能不雅的昵称，也不能让人进不了房间。
       */
      const sec = await safe(rawName, OPENID, { degradable: true })
      if (!sec.pass) return { ok: false, msg: sec.msg }

      /*
       * 同 loadRoom：必须排除过期房间 —— 否则号码被回收后，
       * 输号的人会命中那个过期的老房间，被告知"已过期"（见 loadRoom 的注释）。
       */
      const r0 = await rooms.where({
        code: code, active: true, updatedAt: _.gt(ts - TTL_MS)
      }).limit(1).get().catch(() => ({ data: [] }))
      if (!(r0.data || []).length) {
        const r0b = await rooms.where({
          code: code, active: true, createdAt: _.gt(ts - TTL_MS)
        }).limit(1).get().catch(() => ({ data: [] }))
        r0.data = r0b.data || []
      }
      const room = (r0.data || [])[0]
      if (!room) {
        /*
         * ★ 查不到时，再确认一次「是不是有个同号的房间只是过期了」。
         *
         * 为什么不能直接回「没找到」：号码一被回收，同名的新房间就存在了，
         * 但用户也可能是拿着**老房间的号**来试。两种情况的正确提示完全不同：
         *   · 有同号的过期房 → 「这个房间已经过期了」（号码没错，是房间没了）
         *   · 完全没这个号   → 「没找到这个房间，确认一下房间号」
         * 只说"没找到"会让用户反复核对一个其实没错的号码。
         */
        const stale = await rooms.where({ code: code, active: true }).limit(1).get()
          .catch(() => ({ data: [] }))
        if ((stale.data || []).length) {
          return { ok: false, code: 'STALE', msg: '这个房间已经过期了（2 小时没用会自动散），回大厅点一张玩法卡就能重开' }
        }
        /*
         * ★ 文案里要给**下一步**（2026-10-29 用户报障后改）。
         *   原来只说"没找到这个房间，确认一下房间号" ——
         *   用户核对完号码，还是不知道该干什么。
         *   实测场景：房间 2 小时过期后号码会被回收，
         *   这时拿着老号码去试就是这条提示，而"重开一桌"才是正确动作。
         */
        return {
          ok: false,
          code: 'NO_ROOM',
          msg: '这个号现在没有房间（可能已经散了）。想开一桌新的，回大厅点一张玩法卡就行'
        }
      }
      if (isStale(room)) return { ok: false, code: 'STALE', msg: '这个房间已经过期了（2 小时没用会自动散），回大厅点一张玩法卡就能重开' }

      /* 锁房：新房客直接拒；房里的人重进不受影响（already 分支在下面） */
      const alreadyIn = (room.players || []).some(p => p.openid === OPENID)
      if (room.locked && !alreadyIn) {
        return { ok: false, msg: '房主锁房了，进不去' }
      }

      const already = (room.players || []).some(p => p.openid === OPENID)
      if (already) {
        /* 已在房里（比如退出重进）→ 只刷新心跳，不重复加人 */
        const players = room.players.map(p => p.openid === OPENID ? Object.assign({}, p, { lastSeen: ts, name: name || p.name }) : p)
        await rooms.doc(room._id).update({ data: { players: players, updatedAt: ts } })
        const rr = await rooms.doc(room._id).get()
        return { ok: true, room: shape(rr.data, OPENID), rejoined: true }
      }

      {
        /* 按**当前玩法**的容量判，并把具体数字告诉对方 ——
           "房间满了" 不说几个人，用户只会反复试。 */
        const cap = gameCap(room.game)
        const cur = (room.players || []).length
        if (cur >= cap) {
          const g = gameOf(room.game)
          return {
            ok: false,
            msg: '房间满了（' + (g ? g.name : '这个玩法') + '最多 ' + cap + ' 人，已经 ' + cur + ' 人）'
          }
        }
      }
      /*
       * ★★ 允许"玩到一半进来"（2026-10-10 用户要求）。
       *
       * 改造前：`phase !== 'lobby'` 直接拒绝 —— 别人打到一半你就进不来，
       * 只能等他开新一局。真实酒桌不是这样的：有人晚到，坐下就能看。
       *
       * ★ 但**不能只是删掉这句**，否则引入两个更糟的问题：
       *
       *   ① **回合错乱**
       *      座位重编号会把所有人的 seat 平移。若 A 正轮到 seat2，
       *      新人插进来占了 seat2、A 变成 seat3 → 正在玩的人回合全乱。
       *   ② **本局永远结束不了**（最隐蔽）
       *      比大小的结束判据是 `players.every(p => p.dice.length > 0)`。
       *      新人的 dice 是空的 → **永远为假** → 这局卡死。
       *
       * 所以引入 `inRound` 标记：
       *   · 中途进来的人 `inRound: false` —— 排在末尾、**不重编号已有座位**
       *   · 只在 lobby 进来的人 `inRound: true` —— 参与本局
       *   · 发骰子、判结束、轮回合都只看 `inRound` 的人
       *   · 开新一局（again/game）时统一置回 true —— 新人自然参与下一局
       */
      const joinMidRound = room.phase === 'playing' || room.phase === 'countdown'

      /*
       * ★★ 用**原子 push** 追加，不要整数组覆盖写（2026-10-09 修竞态）。
       *
       * 老写法是「读 room → 拼一个新数组 → 整数组写回」。问题是读和写之间有窗口：
       * 两个人同时点「进去」时，双方都读到同样的 3 人列表、都算出 seat=4，
       * 然后**后写的覆盖先写的** —— 结果只进来一个人，另一个静默消失
       * （他的请求返回 ok:true，界面上却不在房间里，下一轮轮询才被踢回大厅）。
       *
       * `_.push` 是数据库端的原子追加，天然消除"读-改-写"窗口。
       */
      await rooms.doc(room._id).update({
        data: {
          players: _.push([{
            openid: OPENID, name: name, seat: 0,     // seat 稍后统一重编号
            score: 0, dice: [],
            /* ★ 中途进来的人不参与本局（只观战），下一局才发骰子 */
            inRound: !joinMidRound,
            joinedAt: ts, lastSeen: ts
          }]),
          updatedAt: ts
        }
      })

      /* 追加后重读：并发下可能几个人同时通过了容量检查，必须复查 */
      const rr = await rooms.doc(room._id).get()
      let finalPlayers = (rr.data && rr.data.players) || []

      /* 超员 → 把自己摘出去（同样是整写，但此时只有"我"这一个变量） */
      if (finalPlayers.length > gameCap(room.game)) {
        finalPlayers = finalPlayers.filter(p => p.openid !== OPENID)
        await rooms.doc(room._id).update({ data: { players: finalPlayers, updatedAt: ts } }).catch(() => {})
        const g = gameOf(room.game)
        return {
          ok: false,
          msg: '房间满了（' + (g ? g.name : '这个玩法') + '最多 ' + gameCap(room.game) + ' 人）'
        }
      }

      /*
       * ★ 座位按最终顺序重编号 —— 保证 seat 是 1..N 连续且唯一。
       *
       * 为什么必须做：并发追加时两个人先都拿到 seat=0（占位），
       * 不重编号就会出现"两个座位相同"的情况。而 `turn` 是按 seat 找人的
       * （`players.filter(p => p.seat === room.turn)`）——
       * 座位重复意味着**回合永远轮不到其中一个**，游戏卡死且不报错。
       * 这和 leave 里的"退出后重编号"是同一个不变式，两处都要维持。
       */
      /*
       * ★ 座位重编号。
       *
       * 平时（lobby 加入）按最终顺序重编成 1..N ——
       * 并发追加时两人都先拿 seat=0，不重编就会出现"座位重复"，
       * 而 turn 是按 seat 找人的 → 回合永远轮不到其中一个（卡死且不报错）。
       *
       * ★★ 但**中途加入时绝不能重编号已有座位** ——
       * 那会把正在玩的人的座位平移（A 从 seat2 变 seat3），
       * 而他正轮到 seat2 → 回合立刻错乱。
       * 所以这种情况只给新人分配"末尾的号"。
       */
      if (joinMidRound) {
        /* 已有人的座位保持不变；新人取"当前最大座位 + 1" */
        const maxSeat = finalPlayers.reduce((m, p) => Math.max(m, p.seat || 0), 0)
        let nextSeat = maxSeat
        finalPlayers = finalPlayers.map(p => {
          if (p.openid !== OPENID || (p.seat && p.seat > 0)) return p
          nextSeat += 1
          return Object.assign({}, p, { seat: nextSeat })
        })
        await rooms.doc(room._id).update({ data: { players: finalPlayers, updatedAt: ts } })
      } else {
        const seatsOk = finalPlayers.every((p, i) => p.seat === i + 1)
        if (!seatsOk) {
          finalPlayers = finalPlayers.map((p, i) => Object.assign({}, p, { seat: i + 1 }))
          await rooms.doc(room._id).update({ data: { players: finalPlayers, updatedAt: ts } })
        }
      }

      /*
       * ★★ 座位定下来之后，把"没起名"的人补成**唯一**的默认名（2026-10-28）。
       *
       * 默认名必须等座位号出来才补 —— 上面 push 的那一刻 seat 还是占位的 0
       * （并发追加要靠重编号兜底），那时算不出"玩家几"。
       *
       * 为什么值得单独一步：两人都没设昵称时，原来都叫「玩家」，
       * 桌上完全对不上号；而座位号是唯一且一直显示在列表里的。
       * 判定用 `name === '玩家'`（就是 join 入口给的占位名），
       * 用户自己填的名字（哪怕也叫"玩家"）不会被改 —— 那种情况在前面就被 rawName 接住了。
       */
      {
        const needName = finalPlayers.filter(p => p.name === '玩家' && p.openid === OPENID)
        if (needName.length) {
          finalPlayers = finalPlayers.map(p =>
            (p.openid === OPENID && p.name === '玩家') ? Object.assign({}, p, { name: '玩家' + p.seat }) : p)
          await rooms.doc(room._id).update({ data: { players: finalPlayers, updatedAt: ts } })
        }
      }

      return { ok: true, room: shape(Object.assign({}, rr.data, { players: finalPlayers }), OPENID) }
    }

    /* ================= 改自己的名字 ================= */
    /*
     * 为什么有这个 action：进房**不要求输昵称**（一步到位，见 entry 的注释），
     * 所以没设过名字的人一开始是「玩家N」。而酒桌上最常说的是「该谁喝」——
     * 名字对不上这句话就说不下去。所以给一个随时能改的入口，
     * 一个点击 + 系统原生输入框，不强制。
     *
     * 约束（都是能想到的滥用面）：
     *   · 只能改**自己**（按 OPENID 定位，event.name 只是新名字）
     *   · 长度截断到 12（与服务端其它地方一致）
     *   · 必须过内容安全（UGC，多人可见；项目里所有 UGC 都过这一道）
     *   · 重名不拦 —— 酒桌上本来就可能有同名，拦了反而让人觉得坏了
     */
    if (action === 'rename') {
      const { room, err } = await loadRoom(event, OPENID, true)
      if (err) return { ok: false, msg: err }
      const raw = String(event.name || '').trim().slice(0, 12)
      if (!raw) return { ok: false, msg: '名字不能是空的' }
      /* 同 join：改名也是昵称，检查服务不可用时降级放行 */
      const sec = await safe(raw, OPENID, { degradable: true })
      if (!sec.pass) return { ok: false, msg: sec.msg, _code: sec._code }
      const players = (room.players || []).map(p =>
        p.openid === OPENID ? Object.assign({}, p, { name: raw }) : p)
      await rooms.doc(room._id).update({ data: { players: players, updatedAt: ts } })
      const rr = await rooms.doc(room._id).get()
      return { ok: true, room: shape(rr.data, OPENID) }
    }

    /* ================= 锁房 =================
     *
     * ★★ 2026-10-28（调研第 25 条）。
     *
     *   房间号是 3 位数字（1000 个），而且**任何人知道号就能进** ——
     *   隔壁桌听见你们报号、或者随手撞号，人就进来了，房主没有任何办法。
     *   Plato / Houseparty 都有"锁房"，而且把开关常驻在界面上。
     *
     * 只在 lobby 能切：玩到一半锁房没有意义（已经在里面的人不受影响），
     * 反而会让"想拉个朋友进来"的人困惑为什么进不来。
     */
    /* ================= 催一下 =================
     *
     * ★ 2026-10-28（调研第 2 条的后半）。
     *
     *   「投票类没有'还差谁'这一层，桌上只能干等，没有催的手段」——
     *   前半段（还差谁）已经做了，这是后半段：房主得能拍一下桌子。
     *
     * 服务端只做两件事：记时间戳、限流。限流是必要的 ——
     * 没有它，房主会一直点，其他人就变成"每 1.5 秒被催一次"。
     */
    if (action === 'nudge') {
      const { room, err } = await loadRoom(event, OPENID, true)
      if (err) return { ok: false, msg: err }
      if (room.hostOpenid !== OPENID) return { ok: false, msg: '只有房主能催' }
      /*
       * ★ 2026-10-30 扩到「比大小」（用户反馈这个玩法"没有游戏体验"）。
       *
       * 原来只有卧底投票能催 —— 而比大小**等别人摇骰**同样是干等：
       * 屏幕上只有一行"还差 2 个人没摇（倩萍、阿杰）"，桌上没法推动。
       * 两边都是"等人"这件事，不该只有一种玩法能催。
       */
      const isUW = room.game === 'undercover' && room.uwStep === 'vote'
      const isDice = room.game === 'dice' && room.phase === 'playing'
      if (!isUW && !isDice) return { ok: false, msg: '现在不用催' }
      const atKey = isUW ? 'uwNudgeAt' : 'nudgeAt'
      const cntKey = isUW ? 'uwNudgeCount' : 'nudgeCount'
      /* 限流：一轮最多催两次，间隔至少 15 秒 */
      const last = room[atKey] || 0
      if (ts - last < 15000) return { ok: false, msg: '刚催过，等一会儿' }
      if ((room[cntKey] || 0) >= 2) return { ok: false, msg: '催了两次了，再等等' }
      const nudgeData = { updatedAt: ts }
      nudgeData[atKey] = ts
      nudgeData[cntKey] = (room[cntKey] || 0) + 1
      await rooms.doc(room._id).update({ data: nudgeData })
      const rr = await rooms.doc(room._id).get()
      return { ok: true, room: shape(rr.data, OPENID) }
    }

    if (action === 'lock') {
      const { room, err } = await loadRoom(event, OPENID, true)
      if (err) return { ok: false, msg: err }
      if (room.hostOpenid !== OPENID) return { ok: false, msg: '只有房主能锁房' }
      if (room.phase !== 'lobby') return { ok: false, msg: '玩到一半没法锁房' }
      const want = event.locked === true
      await rooms.doc(room._id).update({ data: { locked: want, updatedAt: ts } })
      const rr = await rooms.doc(room._id).get()
      return { ok: true, room: shape(rr.data, OPENID) }
    }

    /* ================= 房间状态（轮询用） ================= */
    if (action === 'status') {
      let { room, err } = await loadRoom(event, OPENID, false)
      if (err) return { ok: false, code: 'NO_ROOM', msg: err }

      /* ★ 倒计时到点 → 自动进入 playing。
         为什么放在 status 里做：云函数没有定时器，必须靠"有人来问"这个时机推进。
         轮询正好提供了这个时机（每 1.5 秒有人问一次）。
         谁先问到谁触发，其他人下一次轮询就看到新状态 —— 不需要锁，
         因为这一步是幂等的（重复推进结果一样）。 */
      if (room.phase === 'countdown' && ts >= (room.countdownEnd || 0)) {
        await rooms.doc(room._id).update({
          data: { phase: 'playing', updatedAt: ts }
        }).catch(() => {})
        room = Object.assign({}, room, { phase: 'playing' })
      }

      /*
       * ★★ 回合超时（2026-10-28，调研第 3 条）。
       *
       *   「无回合超时。有人锁屏/接电话，全桌停在'等某某'」——
       *   这个项目在 AGENTS.md 里记过两次"永远没人轮到"的卡死。
       *
       *   谁先来问 status 谁就触发检查（和倒计时推进同一个思路：
       *   云函数没有定时器，靠轮询的时机做事；这一步幂等，不需要锁）。
       *
       *   只管**大话骰**：它是唯一"回合卡住就整局卡住"的玩法
       *   （比大小各自摇、金花可以弃牌、卧底房主能推进、转盘房主点）。
       *   超时 45 秒 ≈ 30 次轮询都不动，基本可以确定人不在。
       *   动作选"开骰"——最接近"我不信"的自然行为，且一定会结算。
       */
      /*
       * ★★★ 房主掉线 → 顺位转移（2026-10-30）。
       *
       * 这是最根本的那个死路：全项目有 **7 处「只有房主能」**的操作
       * （卧底「开始投票/继续下一轮」、转盘「转」、催一下、锁房……）。
       * 房主接个电话、锁屏、走出门，只要有这一幕，房间里剩下的所有人
       * **全都动不了，而且没有任何提示** —— 比单个玩法卡住更糟。
       *
       * 判据：房主心跳超过 60 秒 → 把房主转给「心跳最新的其他人」。
       * 60 秒而不是 20 秒（online 的阈值），是因为房主可能只是在看规则；
       * 而"半分钟还没动静"在酒桌上已经够久了。
       */
      {
        const playersH = room.players || []
        const hostP = playersH.filter(p => p.openid === room.hostOpenid)[0]
        const hostGone = hostP && ts - (hostP.lastSeen || 0) > 60000
        if (hostGone && playersH.length > 1) {
          const next = playersH
            .filter(p => p.openid !== room.hostOpenid)
            .sort((a, b) => (b.lastSeen || 0) - (a.lastSeen || 0))[0]
          if (next) {
            await dbCall('status.hostMove', () =>
              rooms.doc(room._id).update({ data: { hostOpenid: next.openid, updatedAt: ts } }))
            const rrh = await rooms.doc(room._id).get()
            return { ok: true, room: shape(rrh.data, OPENID) }
          }
        }
      }

      /*
       * ★★ 比大小：掉线不摇的人要自动退出本局（2026-10-30）。
       *
       * 原来这里只处理大话骰，并注释说"比大小各自摇、不会卡"——
       * **那个判断是错的**：判据是 `every(p => p.dice.length > 0)`，
       * 只要有一个人掉线不摇，就永远不成立 → 整局卡死、一句提示都没有。
       * 已用测试锁住（test-room ㉑：3 人局两人掉线，剩下一人摇完必须结算）。
       *
       * 判据：本局参与、还没摇、心跳超过 30 秒 → 视为掉线，踢出本局。
       */
      if (room.game === 'dice' && room.phase === 'playing') {
        const playersD = room.players || []
        const ghosts = playersD.filter(p =>
          p.inRound !== false && !(p.dice || []).length &&
          ts - (p.lastSeen || 0) > 30000)
        if (ghosts.length) {
          const marked = playersD.map(p =>
            ghosts.some(g => g.openid === p.openid) ? Object.assign({}, p, { inRound: false }) : p)
          const alive = marked.filter(p => p.inRound !== false)
          const allDone = alive.length > 0 && alive.every(p => (p.dice || []).length > 0)
          const patch = { players: marked, updatedAt: ts }
          if (allDone) {
            const calc = calcDiceResult(marked, room.streaks || {})
            patch.phase = 'over'
            patch.lastResult = calc.result
            patch.streaks = calc.streaks
          }
          await dbCall('status.diceGhost', () => rooms.doc(room._id).update({ data: patch }))
          const rrd = await rooms.doc(room._id).get()
          return { ok: true, room: shape(rrd.data, OPENID) }
        }
      }

      /*
       * ★★ 卧底投票：掉线不投的人也要自动退出本局（2026-10-30）。
       *
       * 判据是 `alive.every(p => 有票)` —— 有人掉线不投就永远不成立，
       * 全桌卡在投票页，只有房主能「催一下」（而催也不推进）。
       * 已用测试锁住（test-room ㉒）。
       */
      if (room.game === 'undercover' && room.uwStep === 'vote' && room.phase === 'playing') {
        const playersU = room.players || []
        const votesU = room.votes || []
        const ghostsU = playersU.filter(p =>
          p.inRound !== false && !p.out &&
          !votesU.some(v => v.by === p.openid) &&
          ts - (p.lastSeen || 0) > 30000)
        if (ghostsU.length) {
          const markedU = playersU.map(p =>
            ghostsU.some(g => g.openid === p.openid) ? Object.assign({}, p, { inRound: false }) : p)
          const aliveU = markedU.filter(p => p.inRound !== false && !p.out)
          const allDoneU = aliveU.length > 0 &&
            aliveU.every(p => votesU.some(v => v.by === p.openid))
          const patchU = Object.assign({}, allDoneU
            ? settleUwVote(markedU, votesU, room, ts)
            : { players: markedU, updatedAt: ts })
          patchU.updatedAt = ts
          await dbCall('status.uwGhost', () => rooms.doc(room._id).update({ data: patchU }))
          const rru = await rooms.doc(room._id).get()
          return { ok: true, room: shape(rru.data, OPENID) }
        }
      }

      if (room.game === 'liar' && room.phase === 'playing' && room.bid &&
          room.turnAt && ts - room.turnAt > 45000) {
        const idleSeat = room.turn
        const idle = (room.players || []).filter(p => p.seat === idleSeat)[0]
        /* 那个人是不是真的不在了（心跳也很旧）—— 不能因为"想得久"就替他开 */
        const idleGone = !idle || ts - (idle.lastSeen || 0) > 20000
        if (idleGone) {
          const cur = room.bid
          /* 重算实际骰子数（和 open 分支同一套规则：1 是万能） */
          let actual = 0
          ;(room.players || []).forEach(p => {
            (p.dice || []).forEach(d => {
              if (d === cur.face) actual++
              else if (d === 1 && cur.face !== 1) actual++
            })
          })
          const bidderWins = actual >= cur.n
          const loserSeat = bidderWins ? idleSeat : cur.bySeat
          const loserName = ((room.players || []).filter(p => p.seat === loserSeat)[0] || {}).name || '?'
          await rooms.doc(room._id).update({
            data: {
              phase: 'over',
              lastResult: {
                need: cur.n, face: cur.face, actual: actual,
                bidderWins: bidderWins, mult: 1, cups: 1,
                loserSeat: loserSeat, loserName: loserName,
                bidderName: cur.byName, piBy: '',
                autoOpened: (idle && idle.name) || '',
                /*
         * ★ allDice 带围骰标记（2026-10-30）：一盅五颗全同时那个点数算 6 个，
         *   比高亮的颗数多 1 —— 不标出来玩家会以为"显示 5 颗、结算说 6 个"是 bug。
         *   判据与 countActual 里完全一致：全同 且（等于叫的点数 或 不斋时全是 1）。
         */
        allDice: (room.players || []).map(p => {
          const d = p.dice || []
          const same = d.length === 5 && d.every(x => x === d[0])
          const counts = same && (d[0] === cur.face || (d[0] === 1 && cur.face !== 1 && !cur.zhai))
          return { name: p.name, seat: p.seat, dice: d, leopard: !!counts }
        })
              },
              updatedAt: ts
            }
          }).catch(() => {})
          const rr = await rooms.doc(room._id).get()
          return { ok: true, room: shape(rr.data, OPENID) }
        }
      }

      /* 顺手刷新心跳 —— 前端轮询的同时就把"我还活着"告诉服务端，
         省一次专门的请求 */
      const isMember = (room.players || []).some(p => p.openid === OPENID)
      if (isMember) {
        const players = room.players.map(p => p.openid === OPENID ? Object.assign({}, p, { lastSeen: ts }) : p)
        /* 只在心跳确实变旧时才写库，避免每次轮询都写（省写入次数与费用） */
        const mine = room.players.filter(p => p.openid === OPENID)[0]
        if (ts - (mine.lastSeen || 0) > 10000) {
          await rooms.doc(room._id).update({ data: { players: players } }).catch(() => {})
        }
      }
      return { ok: true, room: shape(room, OPENID) }
    }

    /* ================= 开局 ================= */
    if (action === 'start') {
      const { room, err } = await loadRoom(event, OPENID, true)
      if (err) return { ok: false, msg: err }
      if (room.hostOpenid !== OPENID) return { ok: false, msg: '只有房主能开局' }
      /*
       * ★★ 人数下限由**服务端**判，前端只负责把开关状态传上来（2026-10-28）。
       *
       * 改造前：前端按 `shortBy > 0` 拦，服务端只查"房间不是空的"——
       * 于是"到底几个人能开"有两个判据，而且两边不一致：
       * 前端挡着的时候服务端其实早就放行了（反之亦然）。
       * 现在收敛成一处：
       *   · event.solo === true（测试期，config.js 的 soloTest）→ 一个人也能开
       *   · 否则必须达到注册表里这个玩法的 min 人数
       * 这样测试期能一个人跑遍 5 个玩法，正式上线把开关关掉就自动恢复。
       */
      const nPlayers = (room.players || []).length
      if (nPlayers < 1) return { ok: false, msg: '房间是空的' }
      {
        const gm = gameOf(room.game)
        const solo = event.solo === true
        /*
         * ★★ 有些玩法"一个人能开局"但**永远走不下去**（2026-10-28）。
         *
         *   卧底就是例子：1 人时开局逻辑 `Math.max(1, order.length-1)` 会把
         *   **唯一的人选成卧底**，然后投票页列表为空（不能投自己），
         *   而服务端又拦"不能投自己" —— 卡死在投票页，没有任何人能推进。
         *
         *   这比"开不了局"更糟：玩家会以为是自己操作错了。
         *   所以 soloTest 放行的是"能测"的玩法，不是"所有玩法"——
         *   每个玩法用 soloMin 声明自己最少要几个人才跑得完一轮。
         */
        const need = solo ? (gm && gm.soloMin ? gm.soloMin : 1) : (gm ? gm.min : 2)
        if (nPlayers < need) {
          return {
            ok: false,
            msg: '这个玩法要 ' + need + ' 个人，还差 ' + (need - nPlayers) + ' 个'
          }
        }
      }
      /*
       * ★ 必须把 countdown 也拦掉（2026-10-09 安全审计发现）。
       *
       * 原来只拦 `playing`，于是房主在 3.2 秒倒计时窗口内重复调用 start，会：
       *   · 反复重置 countdownEnd（永远开不了局）
       *   · **重新生成大话骰的骰子** —— 前一秒偷看过的点数突然变了，
       *     玩家会以为"这游戏作弊"（而骰子确实是重新摇的）
       *
       * 前端此时按钮已隐藏，所以正常操作碰不到；但云函数是公开接口，
       * 直接调用可达 —— 这类"前端藏了、后端没拦"的缺口必须后端补。
       */
      if (room.phase === 'countdown' || room.phase === 'playing') {
        return { ok: false, msg: '这局已经开始了' }
      }

      /* 骰子由**服务端**生成 —— 前端只拿自己的。
         这和"前端摇完上报"有本质区别：那样抓包就能看到别人的点数。

         ★ 大话骰：开局就给每人发好 5 颗 —— 这是玩法本身，
           骰子一开局就定好、藏在盅下等人偷看，所以必须开局就有。

         ★ 摇骰子比大小：**必须等各人自己摇时才生成**。
           这是 2026-10-08 用户实测报「双人交互不智能」时挖出来的 bug ——
           原来这里也给**所有人**预生成了骰子，导致两件事都不对：
             ① 「等其他人摇」形同虚设 —— allRolled 永远成立，
                你一摇就立刻出结果，别人根本不用摇
             ② 别人的骰子在**你摇之前就已经定了**（前端看不到，
                但"等"的仪式感没了，而且白生成了一堆没用的数据）
           所以 dice 房间开局一律发空数组，谁摇谁生成。

         ★ 转盘不需要骰子（它靠 spin 抽扇区），同样跳过。 */
      const players = (room.players || []).map(p => {
        /*
         * ★ 中途进来的人（inRound === false）这一局**只观战**：
         *   不发骰子、不参与回合。开新一局（again/game）时会统一置回 true。
         *   1 人房的房主 inRound 默认就是 true（create 时写的）。
         */
        const inRound = p.inRound !== false
        if (!inRound) return Object.assign({}, p, { dice: [] })
        /* 转盘 / 比大小 / 谁是卧底 都不需要开局发骰子 */
        if (room.game === 'wheel' || room.game === 'dice' || room.game === 'undercover' || room.game === 'poker') {
          return Object.assign({}, p, { dice: [] })
        }
        const n = room.game === 'liar' ? 5 : 2
        const dice = []
        for (let i = 0; i < n; i++) dice.push(1 + Math.floor(Math.random() * 6))
        return Object.assign({}, p, { dice: dice })
      })

      /* ★ 进入"开局倒计时"而不是直接开始 —— 商业多人游戏的标配。
         为什么必须有：骰子在这一刻已经生成好了，但玩家还在看别人的名字、
         还没把手机放好。直接开局 = 有人错过第一轮叫骰。
         3 秒倒计时给所有人一个"要开始了"的缓冲。 */
      /*
       * ============ 谁是卧底：发词 + 抽卧底 ============
       *
       * 两个关键决定：
       *   ① **每个人的词存在自己身上**（p.uwWord），shape 只按 openid 放行 —— 
       *      别人的词在服务端就丢掉了，抓包也拿不到。
       *   ② **不告诉任何人自己的身份**。卧底不知道自己是卧底，
       *      要自己从别人的描述里察觉。这是玩法的核心体验，也是它和
       *      「我拿到空白卡」那种变体的区别。
       *
       * 卧底人数：7 人以上放 2 个（1 个在人多时会被淹没，游戏没张力）。
       */
      if (room.game === 'undercover') {
        const pair = pickPair(room.deck)
        const inRound = players.filter(p => p.inRound !== false)
        const spyN = inRound.length >= 7 ? 2 : 1
        /* 洗牌取前 N 个当卧底 —— 用 Fisher-Yates，不用 sort(random)（后者分布不均） */
        const order = inRound.slice()
        for (let i = order.length - 1; i > 0; i--) {
          const j = Math.floor(Math.random() * (i + 1))
          const t = order[i]; order[i] = order[j]; order[j] = t
        }
        const spies = order.slice(0, Math.min(spyN, Math.max(1, order.length - 1))).map(p => p.openid)
        players.forEach(p => {
          if (p.inRound === false) { p.uwWord = ''; p.uwRole = ''; return }
          p.uwRole = spies.indexOf(p.openid) >= 0 ? 'spy' : 'civilian'
          p.uwWord = p.uwRole === 'spy' ? pair.spy : pair.civilian
        })
      }

      /*
       * ============ 梦幻金花：发牌 ============
       *
       * 每人三张，**牌存在自己身上**（p.cards），shape 只按 openid 放行。
       * 洗牌用 Fisher-Yates（不是 sort(random)，那个分布不均）。
       */
      if (room.game === 'poker') {
        /*
         * ★★ 梦幻金花 ≠ 炸金花（用户 2026-10-27 明确说明）。
         *    · 1 张**公共牌**：所有人可见
         *    · 每人 1 张**明牌**：只有自己看得见
         *    · 每人 1 张**暗牌**：连自己都看不到，靠想象
         *   比牌时用「公共牌 + 明牌 + 暗牌」三张算牌型。
         *   每个人只知道 2/3 的信息 —— 这就是"梦幻"两个字的意思。
         *   也因此**不存在闷牌**：本来就没有"全看"这个状态。
         */
        const inRoundN = players.filter(p => p.inRound !== false).length
        const dealt = poker.dealDream(inRoundN)
        let k = 0
        players.forEach(p => {
          if (p.inRound === false) { p.cards = []; p.out = true; return }
          p.cards = dealt.hands[k++]
          p.out = false
        })
        room._pkPublic = dealt.publicCard
        room._pkRest = dealt.rest
      }

      await rooms.doc(room._id).update({
        data: {
          players: players,
          /* 梦幻金花的进度：开局直接进"比牌"，turn 指向第一个在局的人 */
          pkStep: room.game === 'poker' ? 'play' : null,
          pkPublic: room._pkPublic || null,
          /* 没发出去的牌 —— 换牌只能从这里抽 */
          pkRest: room._pkRest || [],
          /* 换牌喝掉的量：{ openid: 杯数 }，半杯记 0.5 */
          pkDrink: {},
          pkLast: null,
          pkWinner: null,
          /* 谁是卧底的进度：开局直接进"说描述"（看词是按住看，不需要单独一步） */
          uwStep: room.game === 'undercover' ? 'talk' : null,
          uwOut: [],
          uwLastOut: null,
          uwReveal: null,
          uwTieBreak: false,
          uwTieNames: '',
          votes: [],
          phase: 'countdown',
          countdownEnd: ts + COUNTDOWN_MS,
          round: (room.round || 0) + 1,
          turn: 1,
          turnAt: ts,
          bid: null,
          /* ★ 新一局必须清掉上一转的结果，否则前端一进 playing
             就会看到"上一局转出来的扇区"，误以为这局已经转过了 */
          spin: null,
          lastResult: null,
          updatedAt: ts
        }
      })
      const rr = await rooms.doc(room._id).get()
      return { ok: true, room: shape(rr.data, OPENID) }
    }

    /* ================= 大话骰：叫骰 ================= */
    if (action === 'bid') {
      const { room, err } = await loadRoom(event, OPENID, true)
      if (err) return { ok: false, msg: err }
      /*
       * ★ 玩法归属校验（2026-10-29 审计补）。
       *   与 spin / uwSay / pkAct 保持一致：先确认这个房间**玩的就是这个玩法**。
       *   缺了它的话，跨玩法直接调接口会写进不属于该玩法的字段
       *   （比如在转盘房叫骰），把房间数据搞脏而且不报错。
       *   前端藏按钮不算拦 ——「前端藏了、后端没拦的缺口必须后端补」。
       */
      if (room.game !== 'liar') return { ok: false, msg: '这个房间玩的不是大话骰' }

      /*
       * ★ 观战者判定要放在 `phase !== 'playing'` **之前**。
       *
       * 顺序反了的话，一局结束后（phase='over'）观战者点叫骰会收到
       * 「这局还没开始」—— 而真正的原因是"你是中途进来的，下一局才能玩"。
       * **提示的顺序决定用户知不知道下一步该做什么**，这不是文字问题。
       * （这条是写断言时才暴露出来的：断言期望看到"下一局"，实际却拿到"还没开始"。）
       */
      const mySeat = (room.players || []).filter(p => p.openid === OPENID)[0]
      if (!mySeat) return { ok: false, msg: '你不在这个房间里' }
      if (mySeat.inRound === false) return { ok: false, msg: '你是这一局中途进来的，下一局就能一起玩' }

      if (room.phase !== 'playing') return { ok: false, msg: phaseHint(room.phase) }
      if (room.turn !== mySeat.seat) return { ok: false, msg: '还没轮到你' }

      const n = Number(event.n)
      const face = Number(event.face)
      /*
       * ★ 必须校验**整数**，不只是范围（2026-10-09 安全审计发现）。
       *
       * 范围判断挡不住小数：`2.5 >= 1 && 2.5 <= 10` 成立 → 会落库。
       * 后果不是"数据难看"，而是**玩法被破坏**：
       *   开骰时按 face 精确匹配数骰子（`dice.filter(d => d === face)`），
       *   face=3.7 永远命中 0 颗 → 无论实际有没有 3 点，
       *   判定都是"叫的人输了"→ 谁叫谁输，一局就废了。
       *
       * （顺带澄清：`NaN` 其实**会**被范围判断拦住 —— `NaN >= 1` 为 false。
       *   审计报告说"NaN 直接落库"不准确，真实缺口是小数。）
       */
      if (!Number.isInteger(n) || n < 1 || n > (room.players || []).length * 5) {
        return { ok: false, msg: '数量不对' }
      }
      if (!Number.isInteger(face) || face < 1 || face > 6) {
        return { ok: false, msg: '点数不对' }
      }

      /*
       * ★★ 完整叫骰校验（2026-10-30）。
       * 用户实测指出：缺斋、缺起叫档、缺斋/不斋混叫。
       * 规则依据 docs/大话骰规则.md。服务端判定，不信任前端算好的结果。
       */
      const zhai = event.zhai === true || event.zhai === 1
      const cur = room.bid
      const chk = canRaise(cur, { n: n, face: face, zhai: zhai }, (room.players || []).length)
      if (!chk.ok) return { ok: false, msg: chk.why }

      /*
       * ★ 回合只在**参与本局**的人之间轮转。
       *
       * 原来按 `players.length` 转 —— 中途进来的观战者也被算进循环，
       * 于是回合会停在观战者身上：他不能叫骰（inRound=false 会被拒），
       * 别人又等不到 → **整局卡死且不报错**。
       * 这是"允许中途加入"必须同步改的第三处（前两处：发骰子、判结束）。
       */
      const ring = (room.players || []).filter(p => p.inRound !== false)
        .map(p => p.seat).sort((a, b) => a - b)
      const myIdx = ring.indexOf(mySeat.seat)
      const nextSeat = ring.length === 0 ? 1
        : ring[(myIdx + 1 + ring.length) % ring.length]
      await dbCall('bid.update', () => rooms.doc(room._id).update({
        data: {
          bid: { n: n, face: face, zhai: zhai, bySeat: mySeat.seat, byName: mySeat.name, at: ts },
          turn: nextSeat,
          /* 回合开始时间 —— status 里用它判超时（2026-10-28） */
          turnAt: ts,
          updatedAt: ts
        }
      }))
      const rr = await dbCall('bid.reload', () => rooms.doc(room._id).get())
      return { ok: true, room: shape(rr.data, OPENID) }
    }

    /* ================= 大话骰：开骰 ================= */
    /* ================= 劈（加倍） =================
     *
     * ★★ 2026-10-28 加。调研过同类产品后得出的判断：
     *   大话骰缺的**不是规则数量，而是一个让桌上争吵有出口的动作**。
     *   现在只有「叫」和「开」——有人叫了个离谱的，你除了开没有别的回应，
     *   而"开"是一翻两瞪眼。真实的酒桌上，最有火药味的一句是**"劈！"**
     *   （我加倍赌你在吹），以及被劈的人回的**"反劈！"**。
     *
     * 规则（刻意做到一句话能说清）：
     *   · 只能在轮到你、且已经有人叫过时劈
     *   · 劈 → 倍数 ×2，回合交给**上一个叫骰的人**（被劈的人）
     *   · 被劈的人可以：反劈（再 ×2）/ 继续往上叫 / 开
     *   · 开出来的输家喝 **倍数** 杯（1 杯 × 倍数）
     *   · 每局最多劈到 8 倍（防止无限翻倍把一局拖成天文数字）
     *
     * 为什么不做"认输/投降"：那是逃避，酒桌上没人用，而且会让局提前结束。
     */
    if (action === 'pi') {
      const { room, err } = await loadRoom(event, OPENID, true)
      if (err) return { ok: false, msg: err }
      /*
       * ★ 玩法归属校验（2026-10-29 审计补）。
       *   与 spin / uwSay / pkAct 保持一致：先确认这个房间**玩的就是这个玩法**。
       *   缺了它的话，跨玩法直接调接口会写进不属于该玩法的字段
       *   （比如在转盘房叫骰），把房间数据搞脏而且不报错。
       *   前端藏按钮不算拦 ——「前端藏了、后端没拦的缺口必须后端补」。
       */
      if (room.game !== 'liar') return { ok: false, msg: '这个房间玩的不是大话骰' }
      const meP = (room.players || []).filter(p => p.openid === OPENID)[0]
      if (!meP) return { ok: false, msg: '你不在这个房间里' }
      if (meP.inRound === false) return { ok: false, msg: '你是这一局中途进来的，下一局就能一起玩' }
      if (room.phase !== 'playing') return { ok: false, msg: phaseHint(room.phase) }
      const cur = room.bid
      if (!cur) return { ok: false, msg: '还没人叫骰，没得劈' }
      if (room.turn !== meP.seat) return { ok: false, msg: '还没轮到你' }
      /*
       * ★ 能不能劈，看的是「**最近一次动作**是谁做的」，不是"这口骰是谁叫的"。
       *
       *   ⚠️ 第一版写的是 `cur.bySeat === meP.seat` → 反劈被自己的规则拦住了：
       *      A 叫骰、B 劈 A、回合回到 A，此时 bySeat 仍是 A，
       *      于是 A 想反劈时被判成"自己叫的骰不能自己劈"。
       *      而反劈恰恰是这个动作最有火药味的一半。
       *
       *   真正的语义：谁刚做过动作（叫骰 / 劈），谁就不能接着劈自己 —— 否则
       *   一个人可以无限把自己翻倍，把「劈」变成自娱自乐。
       */
      const lastActor = cur.piSeat || cur.bySeat
      if (lastActor === meP.seat) return { ok: false, msg: '你刚叫的，不能自己劈自己' }

      const nextMult = Math.min(8, (cur.mult || 1) * 2)
      if (nextMult === (cur.mult || 1)) {
        return { ok: false, msg: '已经劈到 8 倍了，够了' }
      }
      /*
       * 回合交给**上一个叫骰的人** —— 他必须回应这一劈。
       * 这是"劈"和"叫"最大的区别：叫是把球传给下家，劈是**直接怼回去**。
       */
      await rooms.doc(room._id).update({
        data: {
          bid: {
            n: cur.n, face: cur.face, at: ts,
            bySeat: cur.bySeat, byName: cur.byName,
            mult: nextMult,
            /* 谁劈的（记**最后一次**—— 结算时"4 倍是谁推上去的"才对得上） */
            piBy: meP.name, piSeat: meP.seat
          },
          /* 回合怼回**最近一次动作的人**：第一次劈是怼叫骰的人，
             反劈是怼上一次劈的人（不能一律怼 bySeat，否则反劈会把球
             传给原叫骰人而不是刚才劈你的人） */
          turn: cur.piSeat || cur.bySeat,
          turnAt: ts,
          updatedAt: ts
        }
      })
      const rr = await rooms.doc(room._id).get()
      return { ok: true, room: shape(rr.data, OPENID) }
    }

    if (action === 'open') {
      const { room, err } = await loadRoom(event, OPENID, true)
      if (err) return { ok: false, msg: err }
      /*
       * ★ 玩法归属校验（2026-10-29 审计补）。
       *   与 spin / uwSay / pkAct 保持一致：先确认这个房间**玩的就是这个玩法**。
       *   缺了它的话，跨玩法直接调接口会写进不属于该玩法的字段
       *   （比如在转盘房叫骰），把房间数据搞脏而且不报错。
       *   前端藏按钮不算拦 ——「前端藏了、后端没拦的缺口必须后端补」。
       */
      if (room.game !== 'liar') return { ok: false, msg: '这个房间玩的不是大话骰' }

      /* 同 bid：观战者判定必须在 phase 之前（否则提示会误导） */
      const mySeat = (room.players || []).filter(p => p.openid === OPENID)[0]
      if (!mySeat) return { ok: false, msg: '你不在这个房间里' }
      if (mySeat.inRound === false) return { ok: false, msg: '你是这一局中途进来的，下一局就能一起玩' }

      if (room.phase !== 'playing') return { ok: false, msg: phaseHint(room.phase) }
      const cur = room.bid
      if (!cur) return { ok: false, msg: '还没人叫骰' }
      if (room.turn !== mySeat.seat) return { ok: false, msg: '还没轮到你' }

      /*
       * 统计全场骰子：**1 恒为万能**（可以当任何点数）。
       *
       * ★ 这里原本还有一套「斋」规则（叫斋时 1 不万能）—— 已移除：
       *   · 前端从来没有叫斋的入口（永远传 zhai: false），是死逻辑；
       *   · 斋 / 破斋的数量换算是大话骰里最容易吵架的规则；
       *   · 用户明确要求「游戏不能太烧脑，简单一些」。
       *   现在规则只有一句好记的：1 是万能。
       */
      /* 统计逻辑抽到 `liarCount.js`（纯函数）—— 原来内联在这里，
         而骰子是随机发的，所以"1 是否算万能"这条规则一直没法单测。 */
      /* ★ 斋时 1 不万能（2026-10-30）—— 少了这个参数，叫「3个4斋」会把 1 也数进去 */
      const actual = liarCount.countActual(room.players, cur.face, cur.zhai)

      const bidderWins = actual >= cur.n
      /* 叫的人没吹牛 → 开的人输；吹了 → 叫的人输 */
      const loserSeat = bidderWins ? mySeat.seat : cur.bySeat

      const mult = Math.max(1, Number(cur.mult) || 1)
      const result = {
        need: cur.n, face: cur.face,
        /* ★ 是斋还是没斋（2026-10-30）。没有这个字段的话，
           玩家看到"叫了 5 个 4、实际 3 个"会以为 1 该算进去 ——
           而斋的规则恰恰是 1 不算。开骰结果必须能解释自己。 */
        zhai: !!cur.zhai,
        actual: actual, bidderWins: bidderWins,
        /* 被劈了几次 → 输家喝几杯（1 杯 × 倍数） */
        mult: mult,
        cups: mult,
        /* 谁劈的（没有就是普通开） */
        piBy: cur.piBy || '',
        loserText: ((room.players || []).filter(p => p.seat === (bidderWins ? mySeat.seat : cur.bySeat))[0] || {}).name || '?',

        loserSeat: loserSeat,
        loserName: ((room.players || []).filter(p => p.seat === loserSeat)[0] || {}).name || '?',
        bidderName: cur.byName,
        /* ★ 开骰后才亮出所有人的骰子 */
        allDice: (room.players || []).map(p => ({ name: p.name, seat: p.seat, dice: p.dice || [] }))
      }

      const players = (room.players || []).map(p =>
        p.seat === loserSeat ? Object.assign({}, p, { score: (p.score || 0) - 1 }) : p)

      /* 大话骰只有一个人输，所以"除他以外都赢" */
      const liarStreak = bumpStreaks(room.streaks, room.players,
        (p) => p.seat !== loserSeat)
      result.streaks = liarStreak.streaks
      result.maxStreak = liarStreak.maxStreak

      await rooms.doc(room._id).update({
        data: {
          players: players, phase: 'over', lastResult: result,
          /* 连庄要跨局保留 —— 存在房间上而不是 result 里 */
          streaks: liarStreak.streaks,
          updatedAt: ts
        }
      })
      const rr = await rooms.doc(room._id).get()
      return { ok: true, room: shape(rr.data, OPENID), result: result }
    }

    /* ================= 命运转盘（联机） =================
     *
     * 房主点"转"，服务端抽结果，全场同步。
     *
     * ★ 结果必须在这里定，不能让房主前端定 ——
     *   单机版可以本地随机（大家看同一块屏幕），
     *   联机版如果让房主前端算，房主就能改结果（"我要真心话"）。
     *   这是"联网游戏"和"传着玩"的根本区别。
     *
     * 扇区权重必须和前端 buildSectors() 完全一致，
     * 否则会出现「指针指着喝一杯、判出来是真心话」——
     * 这类不一致最伤信任（玩家不会觉得是 bug，会觉得游戏在骗人）。
     * scripts/test-wheel.js 会断言两边权重一致。
     */
    if (action === 'spin') {
      const { room, err } = await loadRoom(event, OPENID, true)
      if (err) return { ok: false, msg: err }
      if (room.phase !== 'playing') return { ok: false, msg: phaseHint(room.phase) }
      if (room.game !== 'wheel') return { ok: false, msg: '这个房间玩的不是转盘' }
      if (room.hostOpenid !== OPENID) return { ok: false, msg: '只有房主能转' }

      /* 权重抽样 */
      const total = WHEEL_SECTORS.reduce((a, s) => a + s.weight, 0)
      let roll = Math.random() * total
      let index = 0
      for (let i = 0; i < WHEEL_SECTORS.length; i++) {
        roll -= WHEEL_SECTORS[i].weight
        if (roll <= 0) { index = i; break }
        index = i
      }
      const sec = WHEEL_SECTORS[index]

      /*
       * ★ 转到「真心话 / 大冒险」时，**顺手把题目抽好**一起下发。
       *
       * 为什么必须由服务端抽、且和扇区结果同一次返回：
       *   ① 前端抽 → 可以"重新抽到满意"，题目就不再是运气了
       *   ② 分开两次请求 → 中间那一小段时间，每个人看到的可能不是同一张
       *      （转盘的仪式感全在"全场同时看到同一个结果"）
       *
       * 场合从房间取（房主开局前选），没选就回退第一副牌 —— 保证永远有题可抽。
       */
      let card = null
      if (sec.k === 'truth' || sec.k === 'dare') {
        const deck = decks.deckOf(room.deck)
        /*
         * ★ 题池 = 内置题库 + 这个房间里自己加的题。
         *
         * 为什么合并而不是二选一：酒桌上"我刚想到一个梗，加进去"是真实需求，
         * 加了却抽不到会让人以为没生效。合并之后自定义题和内置题**同等机会**。
         */
        const builtin = deck[sec.k] || []
        const custom = (room.cards || []).filter(c => c.type === sec.k).map(c => c.text)
        const pool = builtin.concat(custom)
        if (pool.length) {
          /*
           * ⚠️ 下标**只抽一次**。
           *   第一版写成 `pool[抽]` 和 `custom.indexOf(pool[抽])` 各调一次
           *   Math.random() —— 两次抽到的可能不是同一个元素，
           *   于是"是不是自定义题"这个标记会随机错。
           *   这类 bug 不报错、只是偶尔标错，极难发现。
           */
          const pick = Math.floor(Math.random() * pool.length)
          card = {
            deck: deck.k,
            deckName: deck.name,
            type: sec.k,
            text: pool[pick],
            /* 标记来源：自定义题在界面上有个小标记，让加的人有反馈 */
            custom: pick >= builtin.length
          }
        }
      }

      const spin = {
        index: index,
        k: sec.k,
        t: sec.t,
        card: card,                                 // 真心话/大冒险的题目；其余扇区为 null
        turns: 4 + Math.floor(Math.random() * 3),   // 4~6 圈，每次不一样
        jitter: (Math.random() - 0.5) * 0.6,        // 扇区内随机偏移（前端会夹紧）
        at: ts
      }

      await dbCall('spin.update', () => rooms.doc(room._id).update({
        data: { spin: spin, lastResult: null, updatedAt: ts }
      }))
      const rr = await dbCall('spin.reload', () => rooms.doc(room._id).get())
      return { ok: true, room: shape(rr.data, OPENID), spin: spin }
    }

    /* ================= 摇骰子：比大小（多人版） ================= */
    if (action === 'roll') {
      const { room, err } = await loadRoom(event, OPENID, true)
      if (err) return { ok: false, msg: err }
      /*
       * ★ 玩法归属校验（2026-10-29 审计补）。
       *   与 spin / uwSay / pkAct 保持一致：先确认这个房间**玩的就是这个玩法**。
       *   缺了它的话，跨玩法直接调接口会写进不属于该玩法的字段
       *   （比如在转盘房叫骰），把房间数据搞脏而且不报错。
       *   前端藏按钮不算拦 ——「前端藏了、后端没拦的缺口必须后端补」。
       */
      if (room.game !== 'dice') return { ok: false, msg: '这个房间玩的不是比大小' }
      /*
       * ★★ 观战者判定（2026-10-29 审计补上的真实缺口）。
       *
       * bid / pi / open / pkAct / uwSay 都有这道检查，**roll 漏了** ——
       * 于是中途进来只能观战的人调 roll 会拿到自己的骰子：
       * 他的 dice 从此有值，"全员摇完"的过滤虽然按 inRound 算（不卡局），
       * 但这个人手里握着一副"本不属于本局"的骰子，结算边界很容易出错。
       *
       * 顺序也有讲究：观战判定必须在 phase 之前（AGENTS.md 记过——
       * 否则一局结束后观战者收到的是"这局还没开始"，而真正原因是"你只能看"，
       * **提示的顺序决定用户知不知道下一步该做什么**）。
       */
      const meRoll = (room.players || []).filter(p => p.openid === OPENID)[0]
      if (!meRoll) return { ok: false, msg: '你不在这个房间里' }
      if (meRoll.inRound === false) return { ok: false, msg: '你是这一局中途进来的，下一局就能一起玩' }
      if (room.phase !== 'playing') return { ok: false, msg: phaseHint(room.phase) }
      /*
       * ★★ 已经摇过就不能再摇（2026-10-28 补的缺口）。
       *
       * 前端摇完会把按钮藏起来，但**云函数是公开接口** ——
       * 直接调用（或前端状态没同步到）就能再摇一次，结果是
       * **同一个人的骰子被覆盖成新的点数**。
       *
       * 这和"偷看过的骰子突然变了"是同一类事故：玩家不会觉得是 bug，
       * 会觉得 App 在作弊。AGENTS.md 记过这条判据 ——
       * "前端藏了、后端没拦的缺口必须后端补"。
       *
       * 注意不要和 again（再来一局）混淆：那里会把 dice 清空，
       * 所以下一局照样能摇。
       */
      {
        const meNow = (room.players || []).filter(p => p.openid === OPENID)[0]
        if (meNow && Array.isArray(meNow.dice) && meNow.dice.length) {
          return { ok: false, msg: '你已经摇过了' }
        }
      }

      /* 每人自己摇自己的 —— 服务端摇，前端只拿结果 */
      /*
       * 每人几颗：**两个玩法都是 5 颗**（2026-10-28 改）。
       *
       * 原来比大小是 2 颗，理由是"骰子房本来就该 2 颗"——但那个数字其实来自
       * 一个 bug：`room.diceCount` 从未被赋值，恒为 undefined，恒回退 2。
       * 也就是说"2 颗"是**回退值**，不是设计值。
       *
       * 为什么改成 5：
       *   · 真实骰盅就装 5 颗，玩家对这个数量有直觉
       *   · 2 颗只有 12 种结果，分布挤中间，比大小几乎没有悬念
       *   · 5 颗才能有"豹子"（五同，1/1296），那才是摇盅时的心跳来源
       *   · 结算页 8 人 × 5 颗也放得下（已用预览验证）
       */
      const n = DICE_PER_PLAYER
      const dice = []
      for (let i = 0; i < n; i++) dice.push(1 + Math.floor(Math.random() * 6))

      /*
       * ★★★ 从"读快照拼数组再覆盖写"改成**乐观锁更新**（2026-10-30）。
       * 原因见 updateGuarded 的注释：4 个人同时摇骰会互相覆盖，
       * 丢骰子的一方让"全员摇完"永远不成立 → 这局卡死。
       * `dice` 在闭包外生成一次，重试不会换点数。
       */
      const out = await dbCall('roll.update', () => updateGuarded(room._id, (fresh) => {
      const players = (fresh.players || []).map(p =>
        p.openid === OPENID ? Object.assign({}, p, { dice: dice, rolledAt: ts }) : p)

      /*
       * ★★ 判"全员摇完"只能看**参与本局**的人。
       *
       * 若把中途进来的观战者也算进去，他的 dice 永远是空的
       * → `every(...)` 永远为假 → **这局永远结束不了**（卡死且不报错）。
       * 这是"允许中途加入"最容易踩的坑。
       */
      const inRoundPlayers = players.filter(p => p.inRound !== false)
      const allRolled = inRoundPlayers.length > 0 &&
        inRoundPlayers.every(p => (p.dice || []).length > 0)

      let result = null
      if (allRolled) {
        /* 结算逻辑抽到 calcDiceResult（纯函数）—— status 里"踢掉线的人"也要用同一份 */
        result = calcDiceResult(players, fresh.streaks || {}).result
      }

      return {
        players: players,
        phase: allRolled ? 'over' : 'playing',
        lastResult: result,
        /* 连庄要跨局保留，所以存在房间上而不是 result 里 */
        streaks: result ? result.streaks : (fresh.streaks || {})
      }
      }))
      const rr = await rooms.doc(room._id).get()
      return { ok: true, room: shape(rr.data, OPENID), result: out.lastResult || null }
    }

    /* ================= 再来一局 ================= */
    /* ================= 加一道自己的题 ================= */
    if (action === 'card') {
      const { room, err } = await loadRoom(event, OPENID, true)
      if (err) return { ok: false, msg: err }
      if (room.game !== 'wheel') return { ok: false, msg: '这个房间玩的不是转盘' }

      const type = event.type === 'dare' ? 'dare' : 'truth'
      const text = String(event.text || '').trim().slice(0, MAX_CARD)
      if (!text) return { ok: false, msg: '题目不能是空的' }

      /*
       * ★★ 自定义题目也是 UGC，**必须过内容安全**。
       *
       * 这一条是 2026-10-09 安全审计刚补上的合规要求（wishes/reminds/pair 都漏过），
       * 新功能不能在同一处再犯 —— 而且房间是多人场景，违规内容会被**所有人**看到，
       * 比双人场景更严重。
       */
      const sec = await safe(text, OPENID)
      if (!sec.pass) return { ok: false, msg: sec.msg, _code: sec._code }

      /* 每人每类最多 20 条 —— 防刷屏，也避免房主塞几百条把内置题库淹掉 */
      const mine = (room.cards || []).filter(c => c.by === OPENID && c.type === type)
      if (mine.length >= MAX_CARDS_PER_KIND) {
        return { ok: false, msg: '你自己这一类已经加了 ' + MAX_CARDS_PER_KIND + ' 条，够玩了' }
      }

      const card = { by: OPENID, type: type, text: text, at: ts }
      await rooms.doc(room._id).update({
        data: { cards: _.push([card]), updatedAt: ts }
      })
      const rr = await rooms.doc(room._id).get()
      return {
        ok: true,
        room: shape(rr.data, OPENID),
        card: card,
        total: ((rr.data && rr.data.cards) || []).length
      }
    }

    /* ================= 删掉自己加的题 ================= */
    if (action === 'cardDel') {
      const { room, err } = await loadRoom(event, OPENID, true)
      if (err) return { ok: false, msg: err }
      const text = String(event.text || '')
      const before = (room.cards || []).length
      /* 只能删自己的 —— 别人加的题你无权删（同 moments 的"只能删自己记的"） */
      const after = (room.cards || []).filter(c => !(c.by === OPENID && c.text === text))
      if (after.length === before) return { ok: false, msg: '没有这条题' }
      await rooms.doc(room._id).update({ data: { cards: after, updatedAt: ts } })
      const rr = await rooms.doc(room._id).get()
      return { ok: true, room: shape(rr.data, OPENID) }
    }

    /* ================= 换题卡场合（房主，lobby 或 over 时） ================= */
    if (action === 'deck') {
      const { room, err } = await loadRoom(event, OPENID, true)
      if (err) return { ok: false, msg: err }
      if (room.hostOpenid !== OPENID) return { ok: false, msg: '只有房主能换题卡' }
      /*
       * 只在**没在玩**的时候允许换：局中换会让"这张牌属于哪个场合"变得含糊，
       * 而且已经转出来的人会觉得规则变了。
       */
      if (room.phase === 'playing' || room.phase === 'countdown') {
        return { ok: false, msg: '这局玩完再换' }
      }
      const dk = decks.deckOf(String(event.deck || ''))
      await rooms.doc(room._id).update({ data: { deck: dk.k, updatedAt: ts } })
      const rr = await rooms.doc(room._id).get()
      return { ok: true, room: shape(rr.data, OPENID), deck: dk.k }
    }

    /* ================= 再来一局 ================= */
    /*
     * ================= 回大厅（再来一局 / 换玩法） =================
     *
     * ★★ 「再来一局」和「换个玩法」**合并成同一个入口**，只差改不改 game。
     *
     * 为什么必须合并：两者的动作本质相同 ——
     *   清局内状态（骰子 / 叫骰 / 结果 / 回合）→ 回 lobby。
     * 如果拆成两个 action 各写一份清理，就必然出现"其中一个漏清某个字段"的问题，
     * 而且**不报错**。这个项目已经在这类"同一件事有多个出口"上栽过两次：
     *   · `stage` 在 doStart 里被手写死 → 「转盘无法转」
     *   · 派生字段有 7 个出口被 setData 抹掉 → 「点击叫骰没反应」
     * 所以清理逻辑只能有一份。
     *
     * `deck`（题卡场合）一次带过来：换玩法时如果新玩法是转盘，
     * 可以顺便把场合也定了 —— 省得再点一次。
     */
    if (action === 'again' || action === 'game') {
      const { room, err } = await loadRoom(event, OPENID, true)
      if (err) return { ok: false, msg: err }
      if (room.hostOpenid !== OPENID) {
        return { ok: false, msg: action === 'game' ? '只有房主能换玩法' : '只有房主能开新一局' }
      }

      /*
       * 今晚战况：谁喝过几杯（2026-10-29）。
       *
       * 只累加**输家明确的玩法**：大话骰（loserName）、比大小（点数最少）。
       * 金花的输家不在 hands 里（比牌过程才决定），卧底和转盘**根本没有输家** ——
       * 硬凑会算错，而"你欠几杯"在酒桌上是较真的事，**算错比不算更糟**。
       */
      /*
       * 今晚战况：谁喝过几杯（2026-10-29）。
       *
       * 提取逻辑在 `loser.js`（纯函数，7 项单测）——
       * 只统计**输家明确**的玩法：大话骰、比大小、金花（出局者 + 换牌代价）。
       * 卧底和转盘没有明确输家，宁可留空也不凑数 ——
       * "你欠几杯"在酒桌上是较真的事，**算错比不算更糟**。
       */
      const nightDrinks = Object.assign({}, room.nightDrinks || {})
      loser.drinkers({
        game: room.game,
        lastResult: room.lastResult,
        players: room.players || [],
        pkDrink: room.pkDrink || {}
      }).forEach(d => {
        nightDrinks[d.name] = (Number(nightDrinks[d.name]) || 0) + d.cups
      })

      /*
       * ★★ 这个 data 里**只放该清的**，不放该留的 —— 2026-10-29 整理。
       *
       * 清（局内状态，每局重来）：
       *   phase / bid / lastResult / turn / round / spin
       *   pk*（金花：比牌步骤、公共牌、牌堆、喝的记录）
       *   uw*（卧底：环节、出局名单、摊牌、票数、重投）
       *   每人 dice / cards / uwWord / uwRole / out / score
       *
       * 留（跨局累计，**绝对不能清**）：
       *   · nightDrinks —— 今晚谁喝过几杯（清了就每局从 0 开始）
       *   · streaks     —— 连胜（清了连击音效永远触发不到 combo2 以上）
       *
       * 判据：**"这一局结束之后还有意义吗"** —— 有就留。
       * 两类混在同一个入口，最容易顺手把该留的一起清掉，而不报错。
       */
      const data = {
        /* 今晚累计的"喝过几杯"（跨局保留，换玩法也不清） */
        nightDrinks: nightDrinks,
        /*
         * ★ 新一局把**所有中途进来的人纳入**（inRound 置回 true）。
         *   这是"下一局才参与"这个承诺的兑现处 —— 漏了它，
         *   观战者会永远观战下去（而且不报错）。
         */
        players: (room.players || []).map(p =>
          Object.assign({}, p, { dice: [], inRound: true, score: 0, out: false, cards: [], uwWord: '', uwRole: '' })),
        phase: 'lobby',
        bid: null, lastResult: null, turn: 0,
        /* 转盘这一转的结果也要清 —— 否则换到转盘后，屏幕上还留着上一轮的扇区 */
        spin: null,
        /* 金花 / 卧底的局内状态一起清 */
        pkStep: null, pkLast: null, pkWinner: null, pkPublic: null, pkRest: [], pkDrink: {},
        /*
         * ★★ 卧底这一批也要在这里清（2026-10-28）。
         *
         * 原来只有 pk* 那几项，uw* 与 votes 全靠**下一次 start 时**才清
         * （start 里有完整的一份）。也就是说重开之后、再开局之前，
         * 房间里保留着上一局的出局名单、全场摊牌、票型、重投状态。
         *
         * 现在所有读取都看 phase 兜住了，所以**没有立刻出错**——
         * 但这正是"依赖隐式约定"的典型：哪天有一个地方读了 uwReveal
         * 而忘了看 phase，就会把上一局的摊牌显示出来，而且不报错。
         * 本项目对"状态残留"栽过（spin 不清 → 换到转盘后还留着上一轮扇区），
         * 所以这里一次清干净，不再依赖 start 兜底。
         */
        uwStep: null, uwOut: [], uwLastOut: null, uwReveal: null,
        uwTieBreak: false, uwTieNames: '', votes: [],

        updatedAt: ts
      }

      if (action === 'game') {
        /*
         * 只在**没在玩**的时候允许换。
         * playing 中途换会让"已经摇过的骰子"失去意义（玩家不知道算不算数），
         * countdown 中途换则是和开局抢时序。
         */
        if (room.phase === 'playing' || room.phase === 'countdown') {
          return { ok: false, msg: '这局玩完再换' }
        }
        const g = String(event.game || '')
        const meta = gameOf(g)
        if (!meta) return { ok: false, msg: '没有这个玩法' }
        /*
         * ★ 换玩法也要看人数：8 个人在玩大话骰，房主换成金花（最多 6 人）
         *   就会挤进去 —— 而金花的发牌按人数走，多出来的人拿不到牌，
         *   后果是"有人永远轮不到"（和当年 turn 越界同一类静默卡死）。
         *   拒绝要**说清数字**，房主才知道该踢人还是换个玩法。
         */
        const cap = gameCap(g)
        const now = (room.players || []).length
        if (now > cap) {
          return { ok: false, msg: meta.name + '最多 ' + cap + ' 人，现在有 ' + now + ' 人' }
        }
        data.game = g
        /* 顺便换题卡场合（只有转盘用得到；传了就换，没传就保持） */
        if (event.deck !== undefined) data.deck = decks.deckOf(String(event.deck)).k
      }

      await rooms.doc(room._id).update({ data: data })
      const rr = await rooms.doc(room._id).get()
      return { ok: true, room: shape(rr.data, OPENID), game: data.game || room.game }
    }

    /* ================= 谁是卧底：进入投票 / 下一轮 / 投票 =================
     *
     * 状态机只有三步，每一步都对应酒桌上一个真实动作：
     *   talk   大家轮流口头描述（**手机上不需要任何操作**，按住屏幕顶部看词就行）
     *   vote   投票（每人一次点击，这是每轮唯一的手机操作）
     *   result 公布谁出局、他是什么词（全场最想看的一刻）
     *
     * ★ 为什么"开始投票"要房主点：
     *   服务端无法知道桌上聊完了没有。这个点击是**把线下节奏翻译给服务端**，
     *   属于"必须有一个"，不是多余的交互。
     */
    if (action === 'uwSay' || action === 'uwVote') {
      const { room, err } = await loadRoom(event, OPENID, true)
      if (err) return { ok: false, msg: err }
      if (room.game !== 'undercover') return { ok: false, msg: '这个房间玩的不是「谁是卧底」' }
      if (room.phase !== 'playing') return { ok: false, msg: phaseHint(room.phase) }

      const players = (room.players || []).map(p => Object.assign({}, p))
      const mine = players.filter(p => p.openid === OPENID)[0]
      if (!mine) return { ok: false, msg: '你不在这个房间里' }
      if (mine.inRound === false) return { ok: false, msg: '你是中途进来的，下一局才能参与' }

      const step = room.uwStep || 'talk'

      /* ---------- 房主：开始投票 / 继续下一轮 ---------- */
      if (action === 'uwSay') {
        if (room.hostOpenid !== OPENID) return { ok: false, msg: '只有房主能切换环节' }
        if (step === 'talk') {
          await rooms.doc(room._id).update({
            data: { uwStep: 'vote', votes: [], uwNudgeAt: 0, uwNudgeCount: 0, updatedAt: ts }
          })
          const rr = await rooms.doc(room._id).get()
          return { ok: true, room: shape(rr.data, OPENID) }
        }
        if (step === 'result') {
          await rooms.doc(room._id).update({
            data: {
              uwStep: 'talk', votes: [], uwLastOut: null,
              /* 重投状态必须一起清：不清的话下一轮第一次平票会被当成
                 "已经用过重投了" → 直接判卧底胜，而且不报错 */
              uwTieBreak: false, uwTieNames: '', updatedAt: ts
            }
          })
          const rr = await rooms.doc(room._id).get()
          return { ok: true, room: shape(rr.data, OPENID) }
        }
        return { ok: false, msg: '现在是投票环节，等大家投完' }
      }

      /* ---------- 投票 ---------- */
      if (step !== 'vote') return { ok: false, msg: '现在还不是投票的时候' }
      if (mine.out) return { ok: false, msg: '你已经出局了，这局在旁边看' }

      const target = String(event.target || '')
      if (!target) return { ok: false, msg: '先选一个人' }
      if (target === OPENID) return { ok: false, msg: '不能投自己' }
      const tP = players.filter(p => p.openid === target)[0]
      if (!tP) return { ok: false, msg: '没有这个人' }
      if (tP.out) return { ok: false, msg: '他已经出局了' }
      if (tP.inRound === false) return { ok: false, msg: '他是中途进来的，不参与这局' }

      /*
       * ★★★ 投票改成**乐观锁**（2026-10-30）。原因与 roll 相同：
       *   多人同时投票时，各自读到旧的 votes 快照再整体覆盖写回，
       *   最后只剩一张票 —— 于是"全员投完"永远不成立，**卡死在投票页**。
       *
       * 现在把「读最新票 → 追加我的票 → 判断投完没 → 结算」整体放进
       * updateGuarded 的重算回调：被抢先就重读重算。
       * 重试必须幂等 —— 我的票已经在里面时不重复追加（返回 null 表示无需再写）。
       */
      /* 初次重复点击：直接给友好提示（"同一人只能投一次"这条约束不能放宽）。
         并发重试的情况由下面回调里的同名判断兜住（那里返回 null = 无需再写）。 */
      if ((room.votes || []).some(v => v.by === OPENID)) {
        return { ok: false, msg: '你已经投过票了' }
      }
      const out = await dbCall('uwVote.update', () => updateGuarded(room._id, (fresh) => {
      const votes = (fresh.votes || []).slice()
      if (votes.some(v => v.by === OPENID)) return null
      votes.push({ by: OPENID, target: target, name: mine.name, at: ts })

      const fplayers = (fresh.players || []).map(p => Object.assign({}, p))
      const alive = fplayers.filter(p => p.inRound !== false && !p.out)
      /* 全员投完就自动结算 —— 不让房主再点一次"开票" */
      const allDone = alive.every(p => votes.some(v => v.by === p.openid))

      if (!allDone) return { votes: votes }

      /* 结算逻辑抽到 settleUwVote（纯函数）—— status 里踢掉线的人也要用同一份 */
      const patch = settleUwVote(fplayers, votes, fresh, ts)


      return patch
      }))
      const rr2 = await rooms.doc(room._id).get()
      return { ok: true, room: shape(rr2.data, OPENID) }
    }

    /* ================= 梦幻金花：弃牌 / 比牌 =================
     *
     * 只有三个动作，因为用户明确要求「不能太烧脑，简单一些」：
     *   看牌（按住看，纯前端）· 弃牌 · 比牌
     *
     * 刻意**不做**的东西（真实炸金花里都有，但会把一局拖很长）：
     *   · 下注/跟注/加注 —— 酒桌上用"喝几杯"代替筹码永远是笔糊涂账
     *   · 闷牌的价格优势 —— 规则一复杂就没人记得住
     *   · 看牌才能比牌的限制 —— 想看就看，不看也能比，全凭胆子
     *
     * 保留的是这个玩法的核心：**三张牌只有自己知道，比牌那一刻才亮**。
     */
    if (action === 'pkAct') {
      const { room, err } = await loadRoom(event, OPENID, true)
      if (err) return { ok: false, msg: err }
      if (room.game !== 'poker') return { ok: false, msg: '这个房间玩的不是梦幻金花' }
      if (room.phase !== 'playing') return { ok: false, msg: phaseHint(room.phase) }

      const players = (room.players || []).map(p => Object.assign({}, p))
      const mine = players.filter(p => p.openid === OPENID)[0]
      if (!mine) return { ok: false, msg: '你不在这个房间里' }
      if (mine.inRound === false) return { ok: false, msg: '你是中途进来的，下一局才能参与' }
      if (mine.out) return { ok: false, msg: '你已经出局了，这局在旁边看' }
      if ((room.turn || 0) !== mine.seat) {
        const cur = players.filter(p => p.seat === room.turn)[0]
        return { ok: false, msg: '还没轮到你，等 ' + ((cur && cur.name) || '下一位') }
      }

      const act = String(event.act || '')
      const alive = players.filter(p => p.inRound !== false && !p.out)
      let last = null

      /*
       * ============ 换牌（用户 2026-10-27 加的规则）============
       *
       *   换公共牌（底牌）→ 喝 1 杯
       *   换自己的手牌   → 喝半杯
       *
       * 为什么这个机制重要：它把"运气"变成了"可付费的选择"。
       * 公共牌是全场共用的，换它影响所有人 —— 所以代价是换手牌的两倍。
       * 手牌只影响自己，半杯。
       *
       * 规则细节：
       *   · 只能在**轮到自己**时换（和其他操作保持一致，避免抢着换）
       *   · 换完回合**不推进** —— 喝完还能接着决定跟不跟、比不比
       *   · 可以从现有牌堆抽，旧牌放回牌堆底（保证 52 张不丢不重）
       *   · 喝的量记在自己名下，**累计**（换两次就是 2 杯）
       */
      if (act === 'swapPublic' || act === 'swapMine') {
        const rest = (room.pkRest || []).slice()
        if (!rest.length) return { ok: false, msg: '没牌可换了，这局凑合打完吧' }
        const drink = Object.assign({}, room.pkDrink || {})
        const addDrink = act === 'swapPublic' ? 1 : 0.5
        drink[OPENID] = (Number(drink[OPENID]) || 0) + addDrink

        if (act === 'swapPublic') {
          const nc = rest.shift()
          /* 旧的公共牌放回牌堆底 —— 牌不能凭空消失，否则剩下的牌会越来越少 */
          if (room.pkPublic) rest.push(room.pkPublic)
          await rooms.doc(room._id).update({
            data: {
              pkPublic: nc, pkRest: rest, pkDrink: drink, updatedAt: ts,
              pkLast: {
                kind: 'swap', name: mine.name, what: 'public', drink: addDrink,
                /* 前端比牌区有一行说明（room.wxml 的 .pkl-note）——
                   以前从来没生成过这个字段，那一行永远空白 */
                noteText: mine.name + ' 换了公共底牌，喝 1 杯'
              }
            }
          })
        } else {
          const n1 = rest.shift()
          const n2 = rest.shift() || rest.shift()
          if (!n1 || !n2) return { ok: false, msg: '牌不够换两手了' }
          const old = (mine.cards || []).slice()
          mine.cards = [n1, n2]
          old.forEach(c => { if (c) rest.push(c) })
          await rooms.doc(room._id).update({
            data: {
              players: players, pkRest: rest, pkDrink: drink, updatedAt: ts,
              pkLast: {
                kind: 'swap', name: mine.name, what: 'mine', drink: addDrink,
                noteText: mine.name + ' 换了自己的手牌，喝半杯'
              }
            }
          })
        }
        const rr = await rooms.doc(room._id).get()
        return { ok: true, room: shape(rr.data, OPENID) }
      }

      if (act === 'fold') {
        mine.out = true
        last = {
          kind: 'fold', name: mine.name,
          noteText: mine.name + ' 弃牌，退出这局'
        }
      } else if (act === 'vs') {
        const target = String(event.target || '')
        if (!target) return { ok: false, msg: '先选一个人' }
        if (target === OPENID) return { ok: false, msg: '不能跟自己比' }
        const tP = players.filter(p => p.openid === target)[0]
        if (!tP) return { ok: false, msg: '没有这个人' }
        if (tP.out) return { ok: false, msg: '他已经出局了' }
        if (tP.inRound === false) return { ok: false, msg: '他是中途进来的，不参与这局' }
        /* 梦幻金花每人手里是**两张**（明牌 + 暗牌），第三张是公共牌 */
        if (!Array.isArray(mine.cards) || mine.cards.length !== 2) return { ok: false, msg: '你的牌不见了，让房主重开一局' }
        if (!Array.isArray(tP.cards) || tP.cards.length !== 2) return { ok: false, msg: '对方的牌不见了，让房主重开一局' }

        /*
         * 比牌 —— **双方亮牌**。
         * 真实炸金花不亮牌，但线上不亮的话，输的人会觉得"凭什么"；
         * 亮出来所有人都能自己看，公信力比神秘感重要。
         *
         * 并列（同点数不同花色）真实存在。这里的处理：**挑战者赢**。
         * 理由：先手本就有风险，给它一点补偿；而且规则必须明确，
         * 不能"随机判"—— 那会让双方都不服。
         */
        const pub = room.pkPublic
        if (!pub) return { ok: false, msg: '公共牌不见了，让房主重开一局' }
        /*
         * ★★ 暗牌是**纯想象**（2026-10-30 用户纠正）。
         *   「暗牌是纯想象的什么牌都可以，不是固定的，比大小的时候想象组合最大的」
         *   所以比的是"公共底牌 + 自己的明牌 + 最优想象牌"，
         *   而不是服务端随机发的那张暗牌（那等于让玩家赌一张看不见的牌）。
         *   cards[0] 是明牌，cards[1] 那张随机暗牌不再参与比牌。
         */
        const handA = poker.bestHand(pub, mine.cards[0]).cards
        const handB = poker.bestHand(pub, tP.cards[0]).cards
        const cmp = poker.compare(handA, handB)
        /*
         * ★ 并列时**发起比牌的人输**（"先开为负"）。
         *   这是主流平台的规则，我第一版做成了挑战者赢 —— 反了。
         *   为什么这么定得通：先开的人主动暴露信息，本来就该承担风险；
         *   而且规则方向明确，双方才不会觉得被坑。
         */
        const challengerWins = cmp > 0
        if (challengerWins) tP.out = true
        else mine.out = true
        last = {
          kind: 'vs',
          by: mine.name, target: tP.name,
          /* 摊牌时把双方的暗牌也亮出来 —— 不亮的话没人知道凭什么输 */
          byCards: handA, targetCards: handB,
          byKnown: mine.cards[0], byHidden: mine.cards[1],
          targetKnown: tP.cards[0], targetHidden: tP.cards[1],
          winner: challengerWins ? mine.name : tP.name,
          tie: cmp === 0,
          byType: poker.rank(handA).name,
          targetType: poker.rank(handB).name,
          /*
           * 一句话说清"为什么是他输"。
           * 没有这句时，比牌区只有四张牌 —— 玩家得自己比对牌型才知道结果，
           * 而牌型大小顺序本来就最容易吵（尤其 A23 是第二大顺子、
           * 一样大时先开为负，这两条各平台口径并不统一）。
           * 当场把判据写出来，比事前读规则有用。
           */
          /*
           * ⚠️ 平局文案里带上双方牌型：只说"牌一样大"的话，桌上会追问
           *    "都是什么牌" —— 而这正是判平手的前提。顺带说明"先开为负"
           *    这条各平台一致、但玩家最容易觉得被坑的规则。
           */
          noteText: cmp === 0
            ? '牌一样大（都是' + poker.rank(handA).name + '），先开为负 —— ' + mine.name + ' 出局'
            : (challengerWins ? mine.name : tP.name) + ' 的 '
              + (challengerWins ? poker.rank(handA).name : poker.rank(handB).name)
              + ' 赢 ' + (challengerWins ? tP.name : mine.name) + ' 的 '
              + (challengerWins ? poker.rank(handB).name : poker.rank(handA).name)
        }
      } else {
        return { ok: false, msg: '不认识的动作' }
      }

      const stillAlive = players.filter(p => p.inRound !== false && !p.out)
      const patch = {
        players: players, pkLast: last, updatedAt: ts
      }

      if (stillAlive.length <= 1) {
        patch.phase = 'over'
        patch.pkStep = 'result'
        patch.pkWinner = stillAlive.length ? stillAlive[0].name : ''
        /*
         * 金花：只有最后站着的那个人赢。
         * ⚠️ 用 **名字** 判而不是座位 —— pkwInner 存的是名字，
         *    而这里 players 已经改过（out 标记），用名字更直接。
         */
        const pkStreak = bumpStreaks(room.streaks, room.players,
          (p) => p.name === patch.pkWinner && p.inRound !== false)
        patch.streaks = pkStreak.streaks
        patch.lastResult = {
          kind: 'poker',
          winner: patch.pkWinner,
          /*
           * ★★ winText / cardsText 是 2026-10-28 补的**真机缺失字段**。
           *
           *   结算页模板（room.wxml）一直在渲染：
           *       <view class="pkr-t">{{room.lastResult.winText}}</view>   ← 大标题
           *       <text wx:for="{{item.cardsText}}">…</text>               ← 每行三张牌
           *   而云函数从来没生成过这两个字段 —— 只生成 hands[].cards（对象数组）。
           *
           *   为什么一直没被发现：**离线渲染的 mock 里手写了 winText / cardsText**，
           *   截图上有"邓林 赢"和三张牌，看着完全正常；
           *   真机上标题是空的、每行牌面也是空的 —— 结算页最想看的两样都没了。
           *   mock 与真实响应不一致时，预览会替真实代码"圆谎"。
           */
          /*
           * ★ 2026-10-30：原来写 `(pkWinner || '没人') + ' 赢'` ——
           * 没有人赢时生成 **「没人 赢」**，中间多一个空格，读起来不像人话。
           * （全场都弃牌时会走到这条；真机探针跑出来才发现。）
           */
          winText: patch.pkWinner ? patch.pkWinner + ' 赢' : '这局没人赢',
          publicCard: room.pkPublic || null,
          publicText: room.pkPublic ? poker.cardText(room.pkPublic) : '',
          hands: players.filter(p => p.inRound !== false)
            .map(p => {
              const full = poker.fullHand(room.pkPublic, p.cards || [])
              /*
               * 牌型名（2026-10-28 补）。
               * 结算页原来只有牌面 + "XX 赢"，**看不出为什么赢** ——
               * 桌上第一个问题就是"他什么牌"。poker.rank 本来就算得出，
               * 只是没透出来。
               */
              const rk = poker.rank(full)
              return {
                name: p.name, cards: full, handName: rk.name,
                /* 牌面文字（♠Q 这种）——模板直接用，前端不该再拼一遍 */
                cardsText: full.map(c => poker.cardText(c)),
                /*
                 * ★ 每张牌的 {文本, 是否红色} —— 2026-10-28 补。
                 *
                 * 原来模板里写的是 `class="pkr-c {{item.indexOf('♥') >= 0 ? 'pk-red' : ''}}"`，
                 * 而**微信 wxml 的表达式不支持函数调用**（.indexOf 直接让整个文件编译失败：
                 * `Bad attr class ... unexpected token '.'`）。
                 * 这个错误只在**真机上传/预览**时才暴露，本地渲染和所有断言都看不到 ——
                 * 所以"看起来一切都对"的项目，一次上传都过不去。
                 */
                cardsRich: full.map(c => {
                  const t = poker.cardText(c)
                  return { t: t, red: /[♥♦]/.test(t) }
                }),
                out: !!p.out,
                typeName: poker.rank(full).name
              }
            })
        }
      } else {
        /* 回合交给下一个还在局里的人（按座位往后找一圈） */
        let next = null
        for (let k = 1; k <= players.length; k++) {
          const seat = ((mine.seat - 1 + k) % players.length) + 1
          const cand = stillAlive.filter(p => p.seat === seat)[0]
          if (cand) { next = cand; break }
        }
        patch.turn = next ? next.seat : (room.turn || 0)
      }

      await rooms.doc(room._id).update({ data: patch })
      const rr = await rooms.doc(room._id).get()
      return { ok: true, room: shape(rr.data, OPENID) }
    }

    /* ================= 离开 ================= */
    if (action === 'leave') {
      const { room, err } = await loadRoom(event, OPENID, true)
      if (err) return { ok: false, msg: err }

      let players = (room.players || []).filter(p => p.openid !== OPENID)
      let hostOpenid = room.hostOpenid
      let active = true
      const upd = {}

      if (!players.length) {
        /* 最后一个人走了 → 房间解散 */
        active = false
      } else {
        /*
         * 房主走了 → 顺位转移给下一个人（不能让房间变成没人能管的死局）。
         *
         * ★★ 接任者如果是"中途加入、本局观战"的人，必须同时把他纳入本局。
         *   否则会出现一条很隐蔽的死路：
         *     3 人局 → 两人中途加入只能观战 → 原有的 3 人陆续离开 →
         *     房主落到观战者头上，而他 inRound 仍是 false。
         *   此时点"开始"：start 按 inRound 过滤，**没人发骰子、没人参与**，
         *   一个人时直接卡死（turn 指向空气），而且一句错误都没有。
         *   原有参与者都走光了，这一局实质上已经重置 —— 把他纳入是合理的。
         */
        /*
         * ★★ 本局的人是不是已经走光了？
         *   如果是，房间实质上"这一局没人了" —— 必须退回 lobby 并把所有人纳入，
         *   否则会卡成一条死路：phase 停在 playing，剩下的人**没有骰子**，
         *   又因为"这局已经开始了"而无法重开 —— 谁也玩不了，且没有一条错误提示。
         */
        const anyoneInRound = players.some(p => p.inRound !== false)

        if (hostOpenid === OPENID) {
          hostOpenid = players[0].openid
          /* 接任者若在观战，纳入本局（见上面那段说明） */
          if (anyoneInRound && players[0].inRound === false) players[0].inRound = true
        }

        if (!anyoneInRound) {
          /* 本局参与者全部离开 → 房间回到大厅态，所有人（都是观战的）转为参与 */
          players = players.map(p => Object.assign({}, p, {
            inRound: true, dice: [], score: 0, out: false,
            cards: [], uwWord: '', uwRole: ''
          }))
          Object.assign(upd, {
            phase: 'lobby', bid: null, lastResult: null, turn: 0, spin: null,
            pkStep: null, pkLast: null, pkWinner: null,
            pkPublic: null, pkRest: [], pkDrink: {}
          })
        }

        /*
         * ★ 座位重编号时必须同步修正 turn，否则回合会指向不存在的座位。
         *
         * 场景：3 人局，轮到 seat2，此时 seat2 退出。
         * 重编号后原来 seat3 变成 seat2，而 turn 还是 2 —— 看起来能对上，
         * 但如果退出的是 seat1（当前回合是 2），重编号后只剩 1、2 两号，
         * turn 仍然是 2 却指向了别人，或者人数减少后 turn 越界，
         * 结果就是"没有任何人轮到"，游戏卡死且不报错。
         *
         * 做法：找出"退出者在原座位序列里的位置"，把 turn 映射到新序列上。
         */
        const oldOrder = (room.players || []).map(p => p.openid)
        const leftIdx = oldOrder.indexOf(OPENID)
        const oldTurn = room.turn || 0

        if (room.phase === 'playing' && oldTurn > 0) {
          if (oldTurn === leftIdx + 1) {
            /* 走的人正好是当前回合持有者 → 顺延给下一位（循环） */
            upd.turn = ((leftIdx) % players.length) + 1
          } else if (oldTurn > leftIdx + 1) {
            /* 走的人在当前回合之前 → 回合序号前移一位 */
            upd.turn = oldTurn - 1
          } else {
            /* 走的人在当前回合之后 → 回合序号不变 */
            upd.turn = oldTurn
          }
          /* 双保险：不管怎么算，turn 必须落在 [1, 人数] 内 */
          if (upd.turn > players.length) upd.turn = 1
          if (upd.turn < 1) upd.turn = 1
        }

        players = players.map((p, i) => Object.assign({}, p, { seat: i + 1 }))
      }

      await rooms.doc(room._id).update({
        data: Object.assign({
          players: players, hostOpenid: hostOpenid, active: active, updatedAt: ts
        }, upd)
      })
      return { ok: true, closed: !active }
    }

    return { ok: false, msg: '不认识的操作：' + action }

  } catch (err) {
    console.error('[room]', action, err)
    const raw = String((err && (err.errMsg || err.message)) || '')
    if (/ResourceNotFound|not exist|Table not exist/i.test(raw)) {
      return { ok: false, code: 'NO_TABLE', msg: '数据表还没建好，重启一次小程序即可' }
    }
    /*
     * ★ 透出脱敏诊断码（2026-10-29）。
     *
     * 这句兜底以前把**所有线索都吞了**：错误记录里只剩「操作失败了，再试一次」，
     * 连是哪一步失败都不知道（2026-10-29 用户实测报障就卡在这里）。
     *
     * 现在把「阶段名（代码常量）+ 数字错误码（微信官方错误码，如 -502）」
     * 放进 _diag 随响应带回去，前端只写进本地错误记录（不弹给用户）。
     *
     * ⚠️ **只透码、不透原始错误串**（安全审计结论⑩：数据库原始错误
     *   不能返回客户端）—— _diag 不含 openid / 文档 id / 堆栈 / 用户数据。
     */
    const numCode = (raw.match(/-\d{2,6}/) || [])[0] || ''
    /*
     * ★ 再多带两个**脱敏语义标签**（2026-10-29 晚，用户报「从来没正常玩过」）：
     *   · op  —— FailedOperation 后面的操作名（Insert/Update/Query…），
     *     只是操作类别，不含数据；它决定"是写挂了还是读挂了"。
     *   · tag —— 底层原因的关键特征词（索引键超限 / 超时 / 限流配额 / 权限）。
     *   通用码 -502001 本身什么都不说（官方文档明确"无特殊语义"），
     *   而用户已经等了很多轮 —— 必须让下一次点击直接给出根因证据。
     */
    const opM = raw.match(/FailedOperation\.(\w+)/)
    const op = opM ? opM[1] : ''
    const tag = /key too large|Index/i.test(raw) ? 'keyTooLarge'
      : /timeout|timed out/i.test(raw) ? 'timeout'
      : /exceed|limit|quota|rate/i.test(raw) ? 'quota'
      : /permission/i.test(raw) ? 'perm' : ''
    const diag = [((err && err.stage) || action), numCode, op, tag]
      .filter(Boolean).join(':')
    return { ok: false, msg: '操作失败了，再试一次', _diag: diag }
  }
}
