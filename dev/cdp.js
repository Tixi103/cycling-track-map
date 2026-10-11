/*!
 * cdp.js —— 极简 Chrome DevTools Protocol 客户端
 *
 * 为什么不用 `--dump-dom` 那一套？
 *   两个原因，都是踩过的坑：
 *
 *   1. `--virtual-time-budget` 会让时钟变成虚拟的，任务队列一空就跳到下一个定时器。
 *      凡是异步 + 真实 I/O 的行为（IndexedDB、文件读取、瓦片加载），
 *      用它测会得到完全相反的结论。
 *   2. 它没法模拟真实的用户操作 —— 比如往 `<input type="file">` 里塞文件。
 *      「上传没反应」这类 bug 恰恰只在真实控件路径上才出现。
 *
 *   用 CDP 可以真正地等上几秒、调用页面的 JS、模拟选文件，
 *   这些都是虚拟时钟那套做不到的。
 *
 * 只用 Node 内置能力（fetch + WebSocket），没有第三方依赖。
 */
'use strict';

const { spawn } = require('child_process');
const fs = require('fs');
const os = require('os');
const path = require('path');

const EDGE = 'C:/Program Files (x86)/Microsoft/Edge/Application/msedge.exe';

const sleep = (ms) => new Promise(r => setTimeout(r, ms));

function findEdge() {
  const candidates = [
    EDGE,
    'C:/Program Files/Google/Chrome/Application/chrome.exe',
    'C:/Program Files (x86)/Google/Chrome/Application/chrome.exe',
    process.env.CHROME_PATH || ''
  ];
  for (const c of candidates) {
    if (c && fs.existsSync(c)) return c;
  }
  throw new Error('找不到 Edge 或 Chrome，可用 CHROME_PATH 环境变量指定');
}

/** 连上调试端口，返回一个极简的 CDP 会话对象 */
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
      /** 求值并取回结果 */
      async eval(expression, awaitPromise) {
        const r = await this.send('Runtime.evaluate', {
          expression,
          returnByValue: true,
          awaitPromise: !!awaitPromise
        });
        if (r.exceptionDetails) {
          throw new Error('页面内求值抛异常: ' +
            (r.exceptionDetails.exception && r.exceptionDetails.exception.description ||
             JSON.stringify(r.exceptionDetails)));
        }
        return r.result.value;
      },
      close() { try { ws.close(); } catch (e) { /* 忽略 */ } }
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
      if (msg.method) events.push(msg);
    };

    ws.onerror = () => reject(new Error('WebSocket 连接失败'));
  });
}

/**
 * 打开一个页面，把 CDP 会话交给回调，结束后自动收尾。
 *
 * @param {string} url        要打开的页面
 * @param {Function} fn       回调，签名 (cdp, helpers) => Promise
 * @param {Object} [opts]     {width, height, quiet}
 */
async function withPage(url, fn, opts) {
  opts = opts || {};
  const port = 9400 + Math.floor(Math.random() * 400);
  const profile = fs.mkdtempSync(path.join(os.tmpdir(), 'edge-cdp-'));
  const edge = findEdge();

  const child = spawn(edge, [
    '--headless=new',
    '--disable-gpu',
    '--no-first-run',
    '--no-default-browser-check',
    '--disable-extensions',
    '--remote-debugging-port=' + port,
    '--user-data-dir=' + profile,
    'about:blank'
  ], { stdio: 'ignore' });

  let cdp = null;
  try {
    // 等调试端口起来
    let ready = false;
    for (let i = 0; i < 60; i++) {
      try {
        const r = await fetch('http://127.0.0.1:' + port + '/json/version');
        if (r.ok) { ready = true; break; }
      } catch (e) { /* 还没起来 */ }
      await sleep(250);
    }
    if (!ready) throw new Error('调试端口在 15 秒内没有就绪');

    const list = await (await fetch('http://127.0.0.1:' + port + '/json/list')).json();
    const page = list.find(t => t.type === 'page');
    if (!page) throw new Error('没有可用的页面目标');

    cdp = await connect(page.webSocketDebuggerUrl);
    await cdp.send('Page.enable');
    await cdp.send('Runtime.enable');
    await cdp.send('DOM.enable');
    await cdp.send('Emulation.setDeviceMetricsOverride', {
      width: opts.width || 1560,
      height: opts.height || 900,
      deviceScaleFactor: 1,
      mobile: false
    });

    await cdp.send('Page.navigate', { url });
    await sleep(800);

    const result = await fn(cdp, {
      sleep,
      /** 往 <input type="file"> 里塞真实文件（模拟用户选择） */
      async setFileInput(selector, filePaths) {
        const doc = await cdp.send('DOM.getDocument', { depth: -1 });
        const found = await cdp.send('DOM.querySelector', {
          nodeId: doc.root.nodeId, selector
        });
        if (!found.nodeId) throw new Error('页面上找不到元素: ' + selector);
        await cdp.send('DOM.setFileInputFiles', {
          files: filePaths, nodeId: found.nodeId
        });
        return found.nodeId;
      },
      /** 截图 */
      async screenshot(filePath) {
        const shot = await cdp.send('Page.captureScreenshot', { format: 'png' });
        fs.writeFileSync(filePath, Buffer.from(shot.data, 'base64'));
      }
    });

    return result;
  } finally {
    if (cdp) cdp.close();
    child.kill();
    await sleep(200);
    try { fs.rmSync(profile, { recursive: true, force: true }); } catch (e) { /* 忽略 */ }
  }
}

module.exports = { withPage, sleep };
