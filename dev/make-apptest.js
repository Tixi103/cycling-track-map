#!/usr/bin/env node
/*!
 * make-apptest.js —— 由 index.html 生成端到端测试页
 *
 * 为什么不让测试页单独维护一份 HTML？
 *   那样它迟早会和 index.html 走偏，测的就不是真正要交付的那个页面了。
 *   这里直接读 index.html 再注入两个测试脚本，保证被测页面与交付页面同源。
 *
 * 注入的两个脚本：
 *   dev/apptest-errors.js  装在最前面，收集执行期间的一切 JS 错误
 *   dev/apptest-drive.js   装在最后面，驱动导入、断言、把结果写进页面
 *
 * 产物写到项目根目录（与 index.html 同级），这样所有相对路径都原样可用，
 * 不需要改写路径。它是开发产物，可以随时删除重建。
 *
 * 用法：
 *   node dev/make-apptest.js
 *   node dev/make-apptest.js dev/shot-drive.js _shot.html     # 换成截图用的驱动
 *
 *   msedge --headless=new --dump-dom --virtual-time-budget=90000
 *          "file:///.../_apptest.html"
 */
'use strict';

var fs = require('fs');
var path = require('path');

var root = path.join(__dirname, '..');
var src = path.join(root, 'index.html');

// 允许换驱动与产物名，方便复用同一套注入逻辑做截图页
var driver = process.argv[2] || 'dev/apptest-drive.js';
var outName = process.argv[3] || '_apptest.html';
var out = path.join(root, outName);

var html = fs.readFileSync(src, 'utf8');

var ERRORS_TAG = '<script defer src="dev/apptest-errors.js"></script>';
var FIRST_TAG = '<script defer src="lib/leaflet/leaflet.js"></script>';
var LAST_TAG = '<script defer src="js/app.js"></script>';

if (html.indexOf(FIRST_TAG) < 0) {
  console.error('没找到第一个脚本标签，index.html 的结构可能变了。');
  process.exit(1);
}
if (html.indexOf(LAST_TAG) < 0) {
  console.error('没找到 ' + LAST_TAG + '，index.html 的结构可能变了。');
  process.exit(1);
}

// 错误收集器排在所有脚本之前 —— 它必须比被测代码先跑起来
html = html.replace(FIRST_TAG, ERRORS_TAG + '\n' + FIRST_TAG);

// 样本与断言驱动排在 app.js 之后：
//   samples 提供 window.SAMPLES（内联形式，因为 file:// 下不能 fetch 本地文件）
//   drive   依赖 app 已经启动（App.ready），所以必须排在 app.js 后面
var tail =
  '<script defer src="dev/samples/samples.js"></script>\n' +
  // 真实文件样本（由 make-realtest.js 生成）。存在就一并注入 ——
  // 截图和端到端测试都优先用真实数据，那才有代表性。
  (fs.existsSync(path.join(__dirname, 'samples', 'real-samples.js'))
    ? '<script defer src="dev/samples/real-samples.js"></script>\n' : '') +
  '<script defer src="' + driver + '"></script>';

html = html.replace(LAST_TAG, LAST_TAG + '\n' + tail);

// 给测试结果留一个容器
html = html.replace('<div id="map" class="map"></div>',
  '<div id="map" class="map"></div>\n<pre id="apptest-log" style="position:fixed;left:-9999px">RUNNING</pre>');

fs.writeFileSync(out, html, 'utf8');
console.log('已生成测试页: ' + out);
console.log('（它是开发产物，可以随时删除重建）');
