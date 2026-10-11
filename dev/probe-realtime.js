#!/usr/bin/env node
/*!
 * probe-realtime.js —— 在真实时间里跑页面脚本
 *
 * 为什么需要它？
 *   用 `--dump-dom --virtual-time-budget` 跑无头浏览器时，**时钟是虚拟的**：
 *   当任务队列里没有待办时，虚拟时钟会直接跳到下一个定时器。
 *   而 IndexedDB 的读写是在等真实的磁盘 I/O —— 那一刻队列是空的，
 *   于是 any `setTimeout(…, 3000)` 会立刻触发，把 IndexedDB 误判成「超时/卡死」。
 *   这个假象足以得出完全相反的结论。
 *
 *   所以凡是「异步 + 真实 I/O」的行为（IndexedDB、大文件读取、Worker），
 *   都必须在真实时钟下验证。这个脚本通过 Chrome DevTools Protocol 驱动浏览器，
 *   可以真正地等上几秒，再把页面的执行结果取回来。
 *
 * 用法：
 *   node dev/probe-realtime.js <url> <expression> [等待毫秒] [截图输出路径]
 *
 * 例：
 *   node dev/probe-realtime.js "file:///D:/x/probe.html" "runProbe()" 6000
 *   node dev/probe-realtime.js "file:///D:/x/page.html" "1" 8000 shot.png
 *
 * 截图也必须走这条路：--screenshot 用的是虚拟时钟，会在页面还在等真实 I/O
 * （瓦片、IndexedDB）时就把画面截下来，截出来多半是空白的。
 */
'use strict';

const { spawn } = require('child_process');
const os = require('os');
const path = require('path');
const fs = require('fs');

const EDGE = 'C:\\Program Files (x86)\\Microsoft\\Edge\\Application\\msedge.exe';
const PORT = 9333;

const url = process.argv[2];
const expression = process.argv[3];
const waitMs = parseInt(process.argv[4] || '6000', 10);
const shotPath = process.argv[5] || null;

if (!url || !expression) {
  console.error('用法: node dev/probe-realtime.js <url> <expression> [等待毫秒]');
  process.exit(1);
}

const profile = fs.mkdtempSync(path.join(os.tmpdir(), 'edge-probe-'));

const child = spawn(EDGE, [
  '--headless=new',
  '--disable-gpu',
  '--no-first-run',
  '--no-default-browser-check',
  '--disable-extensions',
  '--remote-debugging-port=' + PORT,
  '--user-data-dir=' + profile,
  'about:blank'
], { stdio: 'ignore' });

function sleep(ms) { return new Promise(r => setTimeout(r, ms)); }

async function waitForDebugger() {
  for (let i = 0; i < 60; i++) {
    try {
      const res = await fetch('http://127.0.0.1:' + PORT + '/json/version');
      if (res.ok) return await res.json();
    } catch (e) { /* 还没起来 */ }
    await sleep(250);
  }
  throw new Error('调试端口在 15 秒内没有就绪');
}

/** 极简 CDP 客户端 */
function connect(wsUrl) {
  return new Promise((resolve, reject) => {
    const ws = new WebSocket(wsUrl);
    let id = 0;
    const pending = new Map();
    const events = [];

    ws.onopen = () => resolve({
      send(method, params) {
        return new Promise((res, rej) => {
          const msgId = ++id;
          pending.set(msgId, { res, rej });
          ws.send(JSON.stringify({ id: msgId, method, params: params || {} }));
        });
      },
      waitEvent(name, timeoutMs) {
        return new Promise((res, rej) => {
          const found = events.find(e => e.method === name);
          if (found) return res(found.params);
          const timer = setTimeout(() => rej(new Error('等待事件超时: ' + name)), timeoutMs || 15000);
          events.push({ __wait: name, res, rej, timer });
        });
      },
      close() { try { ws.close(); } catch (e) {} }
    });

    ws.onmessage = (ev) => {
      const msg = JSON.parse(ev.data);
      if (msg.id && pending.has(msg.id)) {
        const p = pending.get(msg.id);
        pending.delete(msg.id);
        if (msg.error) p.rej(new Error(msg.error.message));
        else p.res(msg.result);
        return;
      }
      if (msg.method) {
        const waiter = events.find(e => e.__wait === msg.method);
        if (waiter) {
          clearTimeout(waiter.timer);
          events.splice(events.indexOf(waiter), 1);
          waiter.res(msg.params);
        } else {
          events.push(msg);
        }
      }
    };

    ws.onerror = (e) => reject(new Error('WebSocket 连接失败'));
  });
}

async function main() {
  const version = await waitForDebugger();

  const listRes = await fetch('http://127.0.0.1:' + PORT + '/json/list');
  const targets = await listRes.json();
  const page = targets.find(t => t.type === 'page');
  if (!page) throw new Error('没有找到可用的页面目标');

  const cdp = await connect(page.webSocketDebuggerUrl);
  await cdp.send('Page.enable');
  await cdp.send('Runtime.enable');

  // 固定视口尺寸，保证截图稳定（无头窗口的实际尺寸未必是命令行给的那个）
  await cdp.send('Emulation.setDeviceMetricsOverride', {
    width: 1560, height: 900, deviceScaleFactor: 1, mobile: false
  });

  await cdp.send('Page.navigate', { url });
  await sleep(600);   // 让页面脚本先跑起来

  // 真实等待 —— 这一步是虚拟时间做不到的
  await sleep(waitMs);

  if (shotPath) {
    const shot = await cdp.send('Page.captureScreenshot', { format: 'png' });
    fs.writeFileSync(shotPath, Buffer.from(shot.data, 'base64'));
    console.log('截图已写入: ' + shotPath);
  }

  const result = await cdp.send('Runtime.evaluate', {
    expression,
    returnByValue: true,
    awaitPromise: true
  });

  if (result.exceptionDetails) {
    console.log('页面抛出异常: ' + JSON.stringify(result.exceptionDetails.exception));
  } else {
    console.log(JSON.stringify(result.result.value, null, 2));
  }

  cdp.close();
}

main().then(() => {
  child.kill();
  setTimeout(() => process.exit(0), 300);
}).catch(err => {
  console.error('探针失败: ' + err.message);
  child.kill();
  setTimeout(() => process.exit(1), 300);
});
