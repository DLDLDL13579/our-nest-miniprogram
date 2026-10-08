/**
 * initdb —— 建集合（跑一次就行，重复跑是安全的）
 *
 * 历史：这个函数原本还负责「灌种子题库」，服务于已删除的「今日一题」。
 * 2026-09-24 该功能连同 daily / answer 云函数一起删除（产品决定：不要每日打卡），
 * 所以题库种子、questions / answers / pings / foods 四个遗留集合也一并清掉了。
 */
const cloud = require('wx-server-sdk')
cloud.init({ env: cloud.DYNAMIC_CURRENT_ENV })

const db = cloud.database()

/* 只建真正在用的集合 —— 多建的每一个都是以后要还的技术债 */
const COLLECTIONS = [
  'pairs',         // 小窝：成员、邀请码、在一起的日子
  'moments',       // 随手记
  'wishes',        // 想去·去过
  'capsules',      // 时间胶囊
  'reminds',       // 要记得的事
  'cools',         // 情绪·冷静期（v2）
  'rooms'          // 多人游戏房间（临时数据，2 小时过期）
]

exports.main = async () => {
  const made = [], existed = [], errors = []

  for (const name of COLLECTIONS) {
    try { await db.createCollection(name); made.push(name) }
    catch (e) {
      if (/already exist|已存在|ResourceInUse|501001|TableExist/i.test(String(e.errMsg || e.message))) existed.push(name)
      else errors.push(name + ': ' + (e.errMsg || e.message))
    }
  }

  return {
    ok: errors.length === 0,
    created: made,
    alreadyExists: existed,
    errors: errors,
    todo: [
      '【建议】云开发控制台 → 数据库 → moments → 索引管理，新建普通索引：',
      '    pairId(升序) + createdAt(降序) —— 让编年史翻页快一些。',
      '【建议】pairs 加普通索引 members。',
      '【可选清理】questions / answers / pings / foods 是旧版「今日一题」与',
      '    「今晚吃啥 / 想你了」留下的空集合，已无代码引用，可以在控制台直接删掉。'
    ]
  }
}
