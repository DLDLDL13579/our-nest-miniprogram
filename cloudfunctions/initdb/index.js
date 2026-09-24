/**
 * initdb —— 建集合 + 灌种子题库（跑一次就行，重复跑是安全的）
 *
 * ⚠️ 有一件事云函数做不到：**唯一索引必须在控制台手工建**。
 *    (pairId, date, by) 这个唯一索引是双盲的地基 —— 没有它，
 *    两个人手快点两下就会存进两条答案，解锁判定立刻错乱。
 *    跑完这个函数，请照返回里的清单去控制台点一遍。
 */
const cloud = require('wx-server-sdk')
cloud.init({ env: cloud.DYNAMIC_CURRENT_ENV })

const db = cloud.database()

/* v1 只用到前 5 个；后面 4 个先建好空集合，省得 v2 再动结构 */
const COLLECTIONS = [
  'pairs', 'questions', 'answers', 'pings', 'foods',
  'anniversaries', 'wishes', 'capsules',
  'moments',       // 随手记（取代原「今日一题」的 answers）
  'reminds'        // 要记得的事（纪念日/生日/还款）
]

/**
 * 种子题库。
 * 注意题干里的 {span} —— 存模板不存成品句，渲染时由 derive.fill() 替换，
 * 所以同一道题今年问是「这两年多里」，五年后再问会自动变成「那五年多里」。
 * 面向「在一起多年 + 同城」：少问热恋期的小惊喜，多问回忆、感谢、往后几年。
 */
const SEED = [
  ['{span}里，哪个瞬间你确定「就是这个人了」？', '回忆'],
  ['我们第一次一起吃饭，你还记得你点了什么吗？', '回忆'],
  ['我做的哪件事，让你在外面跟朋友提起过？', '回忆'],
  ['哪一次吵完架，你反而更确定要我？', '回忆'],
  ['{span}了，我身上哪个变化是你最喜欢、也最没料到的？', '回忆'],
  ['我为你做过的哪件事，你其实一直没跟我说过谢谢？', '感谢'],
  ['最近这一个月，哪个时刻你最想谢谢我？', '感谢'],
  ['我身上哪个毛病，你已经在学着包容了？', '感谢'],
  ['我最让你没有安全感的一点是什么？', '感谢'],
  ['如果给现在的我打个分，你打几分？扣掉的分在哪儿？', '感谢'],
  ['未来一年，你最想我们一起完成的一件事是什么？', '未来'],
  ['如果明年这个时候我们还在为同一件事发愁，你希望是哪件事？', '未来'],
  ['未来三年，你最想改掉我们之间的哪个习惯？', '未来'],
  ['如果有一天我失业了，你第一反应会是什么？', '未来'],
  ['婚礼你心里有个样子吗？不用大，说一个细节就行。', '未来'],
  ['今天最想跟我吐槽的事是什么？', '日常'],
  ['这周有没有哪个瞬间，你特别希望我在旁边？', '日常'],
  ['今晚如果只做一件事让我们俩都开心，做什么？', '日常'],
  ['我最近说的哪句话，你其实记到现在？', '日常'],
  ['有什么话你想说，但一直没找到合适的时机？', '日常']
]

exports.main = async () => {
  const made = [], existed = [], errors = []

  /* 1. 建集合（已存在会抛 -501001，忽略即可） */
  for (const name of COLLECTIONS) {
    try { await db.createCollection(name); made.push(name) }
    catch (e) {
      if (/already exist|已存在|ResourceInUse|501001|TableExist/i.test(String(e.errMsg || e.message))) existed.push(name)
      else errors.push(name + ': ' + (e.errMsg || e.message))
    }
  }

  /* 2. 灌题库：只有空的时候才灌，避免重复跑长出一堆重复题 */
  let inserted = 0, skippedSeed = false
  try {
    const cnt = await db.collection('questions').count()
    if (cnt.total === 0) {
      const today = new Date(Date.now() + 8 * 3600 * 1000).toISOString().slice(0, 10)
      await Promise.all(SEED.map(row => db.collection('questions').add({
        data: { text: row[0], tag: row[1], active: true, source: 'seed', createdAt: today }
      })))
      inserted = SEED.length
    } else {
      skippedSeed = true
    }
  } catch (e) {
    errors.push('questions: ' + (e.errMsg || e.message))
  }

  return {
    ok: errors.length === 0,
    created: made,
    alreadyExists: existed,
    questionsInserted: inserted,
    questionsSkipped: skippedSeed,
    errors: errors,
    todo: [
      '【建议】云开发控制台 → 数据库 → moments → 索引管理，新建普通索引：',
      '    pairId(升序) + createdAt(降序) —— 让编年史翻页快一些。',
      '【建议】pairs 加普通索引 members。',
      '【历史】answers 集合是旧版「今日一题」留下的，已被 moments 取代。',
      '    如果里面有想留的数据，给它建 pairId+date+by 唯一索引；',
      '    如果确认不要了，直接删掉整张表也行。'
    ]
  }
}
