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
const GAME_IDS = GAMES.map(g => g.id)
cloud.init({ env: cloud.DYNAMIC_CURRENT_ENV })

const db = cloud.database()
const _ = db.command
const rooms = db.collection('rooms')

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
/* 号码空间 = 1000；用满就没号可发，要明确提示而不是死循环 */
const CODE_SPACE = 1000

/* 房间存活时间：2 小时没人动就当作废弃。
   酒桌游戏一局最多几十分钟，2 小时足够宽松。 */
const TTL_MS = 2 * 3600 * 1000

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
const COUNTDOWN_MS = 3200

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
async function safe(text, openid) {
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
    online: now() - (p.lastSeen || 0) < 30000,   // 30 秒内有心跳算在线
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
    round: room.round || 0,
    bid: room.bid || null,          // 大话骰：当前叫骰
    lastResult: room.lastResult || null,
    streaks: room.streaks || {},
    /* 转盘：当前这一转的结果（所有人靠它同步看到同一个扇区） */
    spin: room.spin || null,
    /* 题卡场合（转盘用）—— 全场要看到同一个，所以放在房间状态里。
       谁是卧底复用这个字段存"词库"。 */
    deck: room.deck || 'friends',
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
    /* ================= 建房间 ================= */
    if (action === 'create') {
      const name = String(event.name || '').trim().slice(0, 12) || '玩家1'
      const game = gameOf(event.game) ? event.game : 'dice'
      /*
       * 题卡场合（转盘用）：房主开局前选，全场同步。
       * 校验用 deckOf —— 未知 key 会被回退成默认那副，不会让房间卡在无题可抽的状态。
       */
      const deck = decks.deckOf(String(event.deck || '')).k

      const sec = await safe(name, OPENID)
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

      const name = String(event.name || '').trim().slice(0, 12) || ('玩家')
      const sec = await safe(name, OPENID)
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
          return { ok: false, code: 'STALE', msg: '这个房间已经过期了，让房主重新开一个' }
        }
        return { ok: false, code: 'NO_ROOM', msg: '没找到这个房间，确认一下房间号' }
      }
      if (isStale(room)) return { ok: false, code: 'STALE', msg: '这个房间已经过期了，让房主重新开一个' }

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

      return { ok: true, room: shape(Object.assign({}, rr.data, { players: finalPlayers }), OPENID) }
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
       * ★ 允许单人开局（2026-10-10 用户要求：两个人才能玩，没法调试）。
       *
       * 真实场景也说得通：一个人想先看看自己摇到什么、熟悉一下玩法。
       * 唯一要保证的是**不因此产生非法状态** —— 下面所有按人数算的东西
       * （骰子上限、轮次）在 1 人时都要成立。
       */
      if ((room.players || []).length < 1) return { ok: false, msg: '房间是空的' }
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
          votes: [],
          phase: 'countdown',
          countdownEnd: ts + COUNTDOWN_MS,
          round: (room.round || 0) + 1,
          turn: 1,
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

      if (room.phase !== 'playing') return { ok: false, msg: '这局还没开始' }
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

      /* 必须比上一个大 —— 服务端判定，不信任前端算好的结果 */
      const cur = room.bid
      if (cur) {
        const okHigher = n > cur.n || (n === cur.n && face > cur.face)
        if (!okHigher) return { ok: false, msg: '只能往上叫（数量变大，或数量同、点数大）' }
      }

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
      await rooms.doc(room._id).update({
        data: {
          bid: { n: n, face: face, bySeat: mySeat.seat, byName: mySeat.name, at: ts },
          turn: nextSeat,
          updatedAt: ts
        }
      })
      const rr = await rooms.doc(room._id).get()
      return { ok: true, room: shape(rr.data, OPENID) }
    }

    /* ================= 大话骰：开骰 ================= */
    if (action === 'open') {
      const { room, err } = await loadRoom(event, OPENID, true)
      if (err) return { ok: false, msg: err }

      /* 同 bid：观战者判定必须在 phase 之前（否则提示会误导） */
      const mySeat = (room.players || []).filter(p => p.openid === OPENID)[0]
      if (!mySeat) return { ok: false, msg: '你不在这个房间里' }
      if (mySeat.inRound === false) return { ok: false, msg: '你是这一局中途进来的，下一局就能一起玩' }

      if (room.phase !== 'playing') return { ok: false, msg: '这局还没开始' }
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
      let actual = 0
      ;(room.players || []).forEach(p => {
        (p.dice || []).forEach(d => {
          if (d === cur.face) actual++
          else if (d === 1 && cur.face !== 1) actual++
        })
      })

      const bidderWins = actual >= cur.n
      /* 叫的人没吹牛 → 开的人输；吹了 → 叫的人输 */
      const loserSeat = bidderWins ? mySeat.seat : cur.bySeat

      const result = {
        need: cur.n, face: cur.face,
        actual: actual, bidderWins: bidderWins,
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
      if (room.phase !== 'playing') return { ok: false, msg: '这局还没开始' }
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

      await rooms.doc(room._id).update({
        data: { spin: spin, lastResult: null, updatedAt: ts }
      })
      const rr = await rooms.doc(room._id).get()
      return { ok: true, room: shape(rr.data, OPENID), spin: spin }
    }

    /* ================= 摇骰子：比大小（多人版） ================= */
    if (action === 'roll') {
      const { room, err } = await loadRoom(event, OPENID, true)
      if (err) return { ok: false, msg: err }
      if (room.phase !== 'playing') return { ok: false, msg: '这局还没开始' }

      /* 每人自己摇自己的 —— 服务端摇，前端只拿结果 */
      /*
       * 每人几颗：大话骰 5 颗；摇骰子比大小 2 颗。
       *
       * ⚠️ 原来写的是 `(room.diceCount || 2)` —— 但 `room.diceCount` **从未被赋值**
       *    （房间文档里没这个字段；第 206 行的 diceCount 是 shape() 给**每个 player**
       *    的，不是房间顶层的）。所以它恒为 undefined、恒回退 2。
       *
       * 行为**恰好是对的**（dice 房本就该 2 颗），但这个写法有误导性：
       * 读的人会以为"房间可以配置骰子数"，而实际上没有这个能力。
       * 已改成明确的常量表达式 —— 若将来真要做可配置，再引字段也不迟。
       */
      const n = room.game === 'liar' ? 5 : 2
      const dice = []
      for (let i = 0; i < n; i++) dice.push(1 + Math.floor(Math.random() * 6))

      const players = (room.players || []).map(p =>
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
        /* 全员摇完 → 算点数排名 */
        const ranked = players.map(p => ({
          name: p.name, seat: p.seat,
          dice: p.dice,
          total: (p.dice || []).reduce((a, b) => a + b, 0)
        })).sort((a, b) => b.total - a.total)
        const top = ranked[0].total
        const winnerSeats = ranked.filter(r => r.total === top).map(r => r.seat)

        /* ★ 连庄（streak）：记录每个人连续赢了几局。
           这是酒桌游戏的真实机制 —— "你又赢了？连庄两把了，加倍喝"。
           不是为了让音效有用才加的：连赢本来就该被说出来。 */
        const prevStreaks = room.streaks || {}
        const streaks = {}
        players.forEach(p => {
          const won = winnerSeats.indexOf(p.seat) >= 0
          streaks[p.seat] = won ? ((prevStreaks[p.seat] || 0) + 1) : 0
        })
        const maxStreak = Math.max(0, ...Object.keys(streaks).map(k => streaks[k]))

        result = {
          ranked: ranked,
          winners: ranked.filter(r => r.total === top).map(r => r.name),
          top: top,
          streaks: streaks,
          /* 连庄次数（1 = 刚赢一局，2 = 连庄，3+ = 连庄多次） */
          maxStreak: maxStreak,
          winnerSeats: winnerSeats
        }
      }

      await rooms.doc(room._id).update({
        data: {
          players: players,
          phase: allRolled ? 'over' : 'playing',
          lastResult: result,
          /* 连庄要跨局保留，所以存在房间上而不是 result 里 */
          streaks: result ? result.streaks : (room.streaks || {}),
          updatedAt: ts
        }
      })
      const rr = await rooms.doc(room._id).get()
      return { ok: true, room: shape(rr.data, OPENID), result: result }
    }

    /* ================= 再来一局 ================= */
    /* ================= 加一道自己的题 ================= */
    if (action === 'card') {
      const { room, err } = await loadRoom(event, OPENID, true)
      if (err) return { ok: false, msg: err }
      if (room.game !== 'wheel') return { ok: false, msg: '这个房间玩的不是转盘' }

      const type = event.type === 'dare' ? 'dare' : 'truth'
      const text = String(event.text || '').trim().slice(0, MAX_CARD)
      if (!text) return { ok: false, msg: '写点什么' }

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

      const data = {
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
      if (room.phase !== 'playing') return { ok: false, msg: '这局还没开始' }

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
            data: { uwStep: 'vote', votes: [], updatedAt: ts }
          })
          const rr = await rooms.doc(room._id).get()
          return { ok: true, room: shape(rr.data, OPENID) }
        }
        if (step === 'result') {
          await rooms.doc(room._id).update({
            data: { uwStep: 'talk', votes: [], uwLastOut: null, updatedAt: ts }
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

      const votes = (room.votes || []).slice()
      if (votes.some(v => v.by === OPENID)) return { ok: false, msg: '你已经投过票了' }
      votes.push({ by: OPENID, target: target, name: mine.name, at: ts })

      const alive = players.filter(p => p.inRound !== false && !p.out)
      /* 全员投完就自动结算 —— 不让房主再点一次"开票" */
      const allDone = alive.every(p => votes.some(v => v.by === p.openid))

      if (!allDone) {
        await rooms.doc(room._id).update({ data: { players: players, votes: votes, updatedAt: ts } })
        const rr = await rooms.doc(room._id).get()
        return { ok: true, room: shape(rr.data, OPENID) }
      }

      /* ---- 结算：票最多的出局 ---- */
      const tally = {}
      votes.forEach(v => { tally[v.target] = (tally[v.target] || 0) + 1 })
      let max = 0
      Object.keys(tally).forEach(k => { if (tally[k] > max) max = tally[k] })
      const top = Object.keys(tally).filter(k => tally[k] === max)
      /*
       * 平票：**随机**选一个出局，并在结果里说明"平票随机"。
       * 为什么不做重投：重投在酒桌上会拖很久（谁都不想让步），
       * 而且服务端要在"再投一轮"和"直接结束"之间维护更多状态，
       * 出错面变大。随机是快的，且所有人都接受 —— 反正是个酒桌游戏。
       */
      const picked = top[Math.floor(Math.random() * top.length)]
      const outP = players.filter(p => p.openid === picked)[0]
      outP.out = true
      outP.inRound = true

      const outRow = { openid: outP.openid, name: outP.name, word: outP.uwWord, role: outP.uwRole }
      const uwOut = (room.uwOut || []).concat([outRow])

      /* ---- 胜负判定 ---- */
      const stillAlive = players.filter(p => p.inRound !== false && !p.out)
      const spiesLeft = stillAlive.filter(p => p.uwRole === 'spy').length
      let winner = ''
      if (spiesLeft === 0) winner = 'civilian'          // 卧底全出局
      else if (spiesLeft * 2 >= stillAlive.length) winner = 'spy'   // 卧底占一半，好人也赢不了
      else if (stillAlive.length <= 2) winner = 'spy'    // 只剩两人，卧底拖到底

      const patch = {
        players: players, votes: [], uwOut: uwOut,
        uwLastOut: {
          name: outRow.name, word: outRow.word, role: outRow.role,
          tie: top.length > 1, votes: max
        },
        updatedAt: ts
      }

      if (winner) {
        patch.phase = 'over'
        patch.uwStep = 'result'
        patch.lastResult = {
          kind: 'undercover', winner: winner,
          civilianWord: (players.filter(p => p.uwRole === 'civilian')[0] || {}).uwWord || '',
          spyWord: (players.filter(p => p.uwRole === 'spy')[0] || {}).uwWord || ''
        }
        patch.uwReveal = players
          .filter(p => p.inRound !== false)
          .map(p => ({ name: p.name, word: p.uwWord, role: p.uwRole, out: !!p.out }))
      } else {
        patch.uwStep = 'result'
      }

      await rooms.doc(room._id).update({ data: patch })
      const rr = await rooms.doc(room._id).get()
      return { ok: true, room: shape(rr.data, OPENID) }
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
      if (room.phase !== 'playing') return { ok: false, msg: '这局还没开始' }

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
              pkLast: { kind: 'swap', name: mine.name, what: 'public', drink: addDrink }
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
              pkLast: { kind: 'swap', name: mine.name, what: 'mine', drink: addDrink }
            }
          })
        }
        const rr = await rooms.doc(room._id).get()
        return { ok: true, room: shape(rr.data, OPENID) }
      }

      if (act === 'fold') {
        mine.out = true
        last = { kind: 'fold', name: mine.name }
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
        const handA = poker.fullHand(pub, mine.cards)
        const handB = poker.fullHand(pub, tP.cards)
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
          targetType: poker.rank(handB).name
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
          publicCard: room.pkPublic || null,
          hands: players.filter(p => p.inRound !== false)
            .map(p => {
              const full = poker.fullHand(room.pkPublic, p.cards || [])
              return {
                name: p.name, cards: full, out: !!p.out,
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
    return { ok: false, msg: '操作失败了，再试一次' }
  }
}
