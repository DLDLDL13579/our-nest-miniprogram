/**
 * initdb —— 建集合（跑一次就行，重复跑是安全的）
 *
 * 历史：这个函数曾经负责「灌种子题库」（已删除的「今日一题」），
 * 后来又跟着情侣功能建过 pairs / moments / wishes / capsules / reminds / cools。
 * 2026-10-27 整站转成**纯酒桌游戏**，那些集合全部退役，只剩 rooms。
 *
 * ★ 退役的集合不在这里主动删 —— 建库函数只该"补齐缺的"，
 *   删数据是另一件事（要人在控制台看清楚再点）。所以下面只建在用的。
 */
const cloud = require('wx-server-sdk')
cloud.init({ env: cloud.DYNAMIC_CURRENT_ENV })

const db = cloud.database()

/* 只建真正在用的集合 —— 多建的每一个都是以后要还的技术债 */
const COLLECTIONS = [
  'rooms'          // 游戏房间（临时数据，2 小时过期）
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
    todo: []
  }
}
