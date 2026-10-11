/*!
 * apptest-errors.js —— 端到端测试的错误收集器
 *
 * 必须排在所有被测脚本之前加载，否则抓不到启动阶段的错误。
 * 收集结果挂在 window.__ERRORS__，由 apptest-drive.js 汇总输出。
 */
(function (global) {
  'use strict';

  var errors = [];
  global.__ERRORS__ = errors;

  global.addEventListener('error', function (e) {
    var msg = e.message || '';
    // 浏览器扩展、字体探测之类的噪声不算项目的问题
    if (/chrome-extension:|moz-extension:|extension:\/\//.test(e.filename || '')) return;
    errors.push({
      kind: 'error',
      message: msg,
      source: (e.filename || '') + (e.lineno ? ':' + e.lineno : '')
    });
  }, true);

  global.addEventListener('unhandledrejection', function (e) {
    errors.push({
      kind: 'rejection',
      message: (e.reason && (e.reason.message || String(e.reason))) || '未知'
    });
  });

  // 把 console.error 也抓进来。很多库（含 Leaflet）用 console.error 报错而不抛异常，
  // 只看 window.onerror 会漏掉。
  var origError = console.error;
  console.error = function () {
    var parts = [];
    for (var i = 0; i < arguments.length; i++) {
      var a = arguments[i];
      parts.push(a && a.message ? a.message : String(a));
    }
    errors.push({ kind: 'console.error', message: parts.join(' ') });
    origError.apply(console, arguments);
  };
})(window);
