/*!
 * format.js —— 单位、时间、日期的格式化
 *
 * 全项目唯一的格式化出口。地图提示气泡、列表、统计卡、剖面图坐标轴
 * 都要用同一套规则，否则同一个数字在不同位置显示成不同样子。
 *
 * 内部一律使用：
 *   距离 米   速度 米/秒   时长 秒   时间戳 毫秒
 * 只在显示时换算成公里、km/h、时分秒。
 */
(function (global) {
  'use strict';

  var EMPTY = '—';

  function pad2(n) { return n < 10 ? '0' + n : String(n); }

  function isNum(v) { return typeof v === 'number' && isFinite(v); }

  /* ---------------- 距离 ---------------- */

  /**
   * 距离。小于 1 公里显示米，否则显示公里。
   * @param {number} meters
   * @param {boolean} [forceKm] 强制用公里（统计卡里各种里程单位要统一）
   */
  function distance(meters, forceKm) {
    if (!isNum(meters)) return EMPTY;
    if (!forceKm && meters < 1000) return Math.round(meters) + ' 米';
    var km = meters / 1000;
    if (km < 10) return km.toFixed(2) + ' 公里';
    if (km < 100) return km.toFixed(1) + ' 公里';
    return Math.round(km).toLocaleString('zh-CN') + ' 公里';
  }

  /** 只要数字部分（给统计卡用，单位单独显示） */
  function distanceValue(meters) {
    if (!isNum(meters)) return EMPTY;
    var km = meters / 1000;
    if (km < 10) return km.toFixed(2);
    if (km < 100) return km.toFixed(1);
    return Math.round(km).toLocaleString('zh-CN');
  }

  function elevation(meters) {
    if (!isNum(meters)) return EMPTY;
    return Math.round(meters).toLocaleString('zh-CN');
  }

  /* ---------------- 速度 ---------------- */

  /** m/s → km/h 数值 */
  function speedValue(mps) {
    if (!isNum(mps)) return EMPTY;
    return (mps * 3.6).toFixed(1);
  }

  function speed(mps) {
    if (!isNum(mps)) return EMPTY;
    return (mps * 3.6).toFixed(1) + ' km/h';
  }

  /* ---------------- 时长 ---------------- */

  /**
   * 秒 → 时长字符串。
   * 刻意不用 Date 对象来算 —— 超过 24 小时的时长会被 Date 绕回前一天。
   */
  function duration(seconds) {
    if (!isNum(seconds) || seconds < 0) return EMPTY;
    var s = Math.round(seconds);
    var h = Math.floor(s / 3600);
    var m = Math.floor((s % 3600) / 60);
    var sec = s % 60;
    if (h > 0) return h + ':' + pad2(m) + ':' + pad2(sec);
    return m + ':' + pad2(sec);
  }

  /** 秒 → 「1 小时 23 分」这种口语化写法，给统计卡用 */
  function durationHuman(seconds) {
    if (!isNum(seconds) || seconds < 0) return EMPTY;
    var s = Math.round(seconds);
    var h = Math.floor(s / 3600);
    var m = Math.floor((s % 3600) / 60);
    if (h > 0) return h + ' 小时 ' + m + ' 分';
    if (m > 0) return m + ' 分 ' + (s % 60) + ' 秒';
    return s + ' 秒';
  }

  /** 秒 → 拆分给统计卡的两个字段 */
  function durationParts(seconds) {
    if (!isNum(seconds) || seconds < 0) return { value: EMPTY, unit: '' };
    var s = Math.round(seconds);
    var h = Math.floor(s / 3600);
    var m = Math.floor((s % 3600) / 60);
    if (h > 0) return { value: h + ':' + pad2(m), unit: '时:分' };
    return { value: m + ':' + pad2(s % 60), unit: '分:秒' };
  }

  /* ---------------- 日期时间 ---------------- */

  // 用显式的 options，而不是 toLocaleString() 的默认行为 ——
  // 默认格式在不同浏览器、不同系统区域设置下差别很大。
  var DTF = null;
  try {
    DTF = new Intl.DateTimeFormat('zh-CN', {
      year: 'numeric', month: '2-digit', day: '2-digit',
      hour: '2-digit', minute: '2-digit', hour12: false
    });
  } catch (e) { DTF = null; }

  function dateTime(ms) {
    if (!isNum(ms)) return EMPTY;
    try {
      if (DTF) return DTF.format(new Date(ms));
    } catch (e2) { /* 落到下面的手工格式 */ }
    var d = new Date(ms);
    return d.getFullYear() + '-' + pad2(d.getMonth() + 1) + '-' + pad2(d.getDate()) +
      ' ' + pad2(d.getHours()) + ':' + pad2(d.getMinutes());
  }

  function dateOnly(ms) {
    if (!isNum(ms)) return EMPTY;
    var d = new Date(ms);
    return d.getFullYear() + '-' + pad2(d.getMonth() + 1) + '-' + pad2(d.getDate());
  }

  /**
   * 「本地日期」键，用于按天分组与筛选。
   *
   * 必须这么拼，不能用 toISOString().slice(0,10) —— 后者按 UTC 取日期，
   * 在 UTC+8 晚上 8 点之后骑的车会被归到第二天，是这类应用最常见的显示错误。
   */
  function localDateKey(ms) {
    if (!isNum(ms)) return '';
    var d = new Date(ms);
    return d.getFullYear() + '-' + pad2(d.getMonth() + 1) + '-' + pad2(d.getDate());
  }

  /** 「今天 / 昨天 / 3 天前 / 2024-05-01」 */
  function relativeDay(ms) {
    if (!isNum(ms)) return EMPTY;
    var today = new Date(); today.setHours(0, 0, 0, 0);
    var that = new Date(ms); that.setHours(0, 0, 0, 0);
    var days = Math.round((today.getTime() - that.getTime()) / 86400000);
    if (days === 0) return '今天';
    if (days === 1) return '昨天';
    if (days === 2) return '前天';
    if (days > 2 && days < 30) return days + ' 天前';
    return dateOnly(ms);
  }

  /** 文件名里用的时间戳：20240501-0812 */
  function fileStamp(ms) {
    var d = isNum(ms) ? new Date(ms) : new Date();
    return '' + d.getFullYear() + pad2(d.getMonth() + 1) + pad2(d.getDate()) +
      '-' + pad2(d.getHours()) + pad2(d.getMinutes());
  }

  /* ---------------- 数值 ---------------- */

  function count(n) {
    if (!isNum(n)) return EMPTY;
    return Math.round(n).toLocaleString('zh-CN');
  }

  /** 文件体积 */
  function bytes(n) {
    if (!isNum(n)) return EMPTY;
    if (n < 1024) return n + ' B';
    if (n < 1024 * 1024) return (n / 1024).toFixed(0) + ' KB';
    return (n / 1024 / 1024).toFixed(1) + ' MB';
  }

  /** 里程百分数（用于占用提示） */
  function percent(v) {
    if (!isNum(v)) return EMPTY;
    return Math.round(v * 100) + '%';
  }

  global.Format = {
    EMPTY: EMPTY,
    distance: distance,
    distanceValue: distanceValue,
    elevation: elevation,
    speed: speed,
    speedValue: speedValue,
    duration: duration,
    durationHuman: durationHuman,
    durationParts: durationParts,
    dateTime: dateTime,
    dateOnly: dateOnly,
    localDateKey: localDateKey,
    relativeDay: relativeDay,
    fileStamp: fileStamp,
    count: count,
    bytes: bytes,
    percent: percent
  };
})(window);
