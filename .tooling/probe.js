const WebSocket = require('ws')
const ports = [49529, 47608, 27858, 32123, 48980, 61821]
;(async () => {
  for (const p of ports) {
    await new Promise(res => {
      const ws = new WebSocket('ws://127.0.0.1:' + p, { handshakeTimeout: 2000 })
      let done = false
      const finish = (ok, note) => { if (!done) { done = true; console.log(`  ${p} → ${ok ? '✓ ' + note : '✗ ' + note}`); try{ws.terminate()}catch(e){}; res() } }
      ws.on('open', () => {
        // 发一个 automator 握手，看它认不认
        try { ws.send(JSON.stringify({id:'1',method:'Tool.getInfo'})) } catch(e){}
        setTimeout(() => finish(true, '可连接（WebSocket 握手成功）'), 800)
      })
      ws.on('error', e => finish(false, e.message.slice(0, 60)))
      ws.on('message', d => finish(true, '返回数据: ' + String(d).slice(0, 80)))
      setTimeout(() => finish(false, '超时'), 3000)
    })
  }
})()
