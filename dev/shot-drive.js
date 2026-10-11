/*!
 * shot-drive.js —— 截图用的驱动
 *
 * 导入样本、选中一条有完整数据的轨迹、把视野调好，
 * 让无头浏览器能截到一张「用户实际会看到的界面」。
 *
 * 与 apptest-drive.js 的区别：这里不做断言，只负责把界面摆到好看的状态。
 * 截图前记得留足时间让瓦片加载完。
 *
 * 用法：
 *   node dev/make-apptest.js dev/shot-drive.js _shot.html
 *   msedge --headless=new --window-size=1560,900 --screenshot=shot.png
 *          --virtual-time-budget=25000 "file:///.../_shot.html"
 */
(function (global) {
  'use strict';

  /** 从 URL 上取开关，方便一张脚本截多种状态：?_state=gradient / heatmap / blank */
  function param(name) {
    var m = new RegExp('[?&]' + name + '=([^&]*)').exec(global.location.search);
    return m ? decodeURIComponent(m[1]) : null;
  }

  function wait(ms) { return new Promise(function (r) { setTimeout(r, ms); }); }

  function ready() {
    // 优先用真实文件 —— 截图是给人看的，真实数据才有代表性
    var src = (global.REAL_SAMPLES && Object.keys(global.REAL_SAMPLES).length)
      ? global.REAL_SAMPLES : global.SAMPLES;
    var names = Object.keys(src);
    var files = [];
    for (var i = 0; i < names.length; i++) {
      files.push(new File([src[names[i]]], names[i], { type: 'application/xml' }));
    }
    return global.UI.importFiles(files).then(function () {
      global.App.afterImport();
      return wait(120);
    });
  }

  /**
   * 挑一条数据最全的轨迹来展示。
   * 不要求有海拔 —— 真实的华为导出文件里根本没有海拔，
   * 硬要求 hasElevation 会一条都选不出来。
   */
  function pickRich() {
    var list = global.TracksStore.visible();
    for (var i = 0; i < list.length; i++) {
      if (list[i].stats.hasTime) return list[i];
    }
    return list[0];
  }

  /** 关掉所有提示条 —— 提示条会改变地图容器高度，留着会把画面挤得很难看 */
  function dismissNotices() {
    var btns = document.querySelectorAll('.notice-close');
    for (var i = 0; i < btns.length; i++) btns[i].click();
  }

  var bootMs = 0;

  global.App.ready.then(function () {
    // 从导航开始到 app 初始化完成（含本地存储恢复）的耗时。
    // 用来验证 file:// 下跳过 IndexedDB 探测确实省掉了那 3 秒白等。
    bootMs = global.performance && performance.now ? performance.now() : 0;
    // 截图页不必保留上次跑测试留下的数据
    global.TracksStore.removeAll();
    return ready();
  }).then(function () {
    var state = param('state');
    // 先关提示条再做定位，顺便验证容器尺寸变化后视野计算是否正确
    dismissNotices();
    return wait(200);
  }).then(function () {
    var state = param('state');
    var track = pickRich();

    global.App.selectTrack(track.id);
    global.MapView.fitTrack(track.id, { padding: [40, 40], maxZoom: 15, animate: false });

    if (state === 'gradient') {
      var g = document.getElementById('chk-gradient');
      g.checked = true;
      g.onchange();
    } else if (state === 'heatmap') {
      global.App.setHeatmap(true);
    } else if (state === 'blank') {
      global.App.applyBasemap('blank');
    }

    return wait(2500);   // 等瓦片加载，否则截出来是空白底图
  }).then(function () {
    reportDiag();
    global.__SHOT_READY__ = true;
  }).catch(function (e) {
    global.__SHOT_ERROR__ = (e && e.stack) || String(e);
    reportDiag();
  });

  /** 把地图的实时状态写进 DOM，方便无头模式排查「地图空白」这类问题 */
  function reportDiag() {
    var map = global.MapView.getMap();
    var el = document.getElementById('map');
    var rect = el ? el.getBoundingClientRect() : null;
    var st = global.MapView.debugStats();

    var lines = [
      '启动耗时: ' + Math.round(bootMs) + ' ms',
      '协议: ' + global.location.protocol,
      '存储后端: ' + global.TracksStore.backend(),
      '容器尺寸: ' + (rect ? Math.round(rect.width) + 'x' + Math.round(rect.height) : '无'),
      'map.getSize(): ' + (map ? map.getSize().x + 'x' + map.getSize().y : '无'),
      'map.getZoom(): ' + (map ? map.getZoom() : '无'),
      'map 中心: ' + (map ? map.getCenter().lat.toFixed(4) + ',' + map.getCenter().lng.toFixed(4) : '无'),
      '瓦片层存在: ' + st.hasTiles,
      '底图: ' + st.basemap + ' / crs=' + st.crs,
      '轨迹图层数: ' + st.layers,
      '页面里的瓦片 img: ' + document.querySelectorAll('.leaflet-tile-pane img').length,
      '页面里的 canvas: ' + document.querySelectorAll('canvas').length,
      '错误: ' + (global.__SHOT_ERROR__ || '无')
    ];

    var pre = document.getElementById('shot-diag');
    if (!pre) {
      pre = document.createElement('pre');
      pre.id = 'shot-diag';
      pre.style.cssText = 'position:fixed;left:-9999px';
      document.body.appendChild(pre);
    }
    pre.textContent = lines.join('\n');
  }
})(window);
