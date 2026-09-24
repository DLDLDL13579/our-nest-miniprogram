/**
 * 只有两个值需要你手填，其余全部代码不用动。
 * 填完这两个，整个工程就能跑起来。
 */
module.exports = {
  /* 云开发环境 ID。在开发者工具「云开发」控制台左上角能看到，形如 wo-de-xiao-wo-3g8xxxxx
     如果账号下只有一个环境，留空也能跑；有多个环境时必须填，否则会连到默认那个。 */
  env: 'cloudbase-d4goh1zdtc8eb9708',

  /* 云函数名统一在这里，避免各页面字符串写错拼不拢 */
  fn: {
    pair: 'pair',       // 配对 / 状态 / 设置
    initdb: 'initdb',   // 建库，只跑一次
    bootstrap: 'bootstrap', // 云端替我们调 initdb（CLI 没有 invoke 命令）
    home: 'home',       // 首页聚合：一次往返拿齐所有数据
    chronicle: 'chronicle', // 编年史：那年今日 + 流水 + 里程碑
    wishes: 'wishes',   // 想去·去过：清单 + 拍照点亮
    moments: 'moments',  // 随手记
    capsule: 'capsule',  // 时间胶囊：写给未来的信
    reminds: 'reminds',  // 要记得的事：纪念日与提醒
    mood: 'mood'         // 情绪·冷静期（v2）
  }
}
