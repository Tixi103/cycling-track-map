/*!
 * realtest-drive.js —— 真实华为导出文件的交叉验证
 *
 * 拿真实文件跑，并把结果与**设备自己算出来的**数据中心对照。
 *
 * 分四段：
 *   一、逐文件直接校验解析器（不做 UI 导入，快且能精确定位到具体文件）
 *   二、同一次骑行的三种格式必须给出一致结果
 *   三、批量导入走一遍 UI
 *   四、渲染、纠偏等运行时行为
 *
 * 注意第一段为什么不能「先全部导入、再按点数去匹配」：
 *   46 个文件里有好几对点数完全相同（同一天骑两趟、以及重复文件），
 *   按点数匹配必然张冠李戴。逐文件处理才靠得住。
 */
(function (global) {
  'use strict';

  var lines = [];
  var passed = 0, failed = 0;

  function check(name, cond, detail) {
    if (cond) { passed++; lines.push('PASS | ' + name + ' | ' + (detail === undefined ? '' : detail)); }
    else { failed++; lines.push('FAIL | ' + name + ' | ' + (detail === undefined ? '' : detail)); }
  }

  function section(t) { lines.push(''); lines.push('── ' + t + ' ──'); flushLog(); }

  function flushLog() {
    var el = document.getElementById('realtest-log');
    if (!el) {
      el = document.createElement('pre');
      el.id = 'realtest-log';
      el.style.cssText = 'position:fixed;left:-9999px';
      document.body.appendChild(el);
    }
    el.textContent = lines.join('\n');
  }

  function wait(ms) { return new Promise(function (r) { setTimeout(r, ms); }); }

  function settle() {
    return new Promise(function (resolve) {
      var done = false;
      function finish() { if (!done) { done = true; resolve(); } }
      var n = 0;
      function tick() { n++; if (n >= 3) finish(); else global.requestAnimationFrame(tick); }
      global.requestAnimationFrame(tick);
      setTimeout(finish, 250);
    });
  }

  function pct(a, b) { return b ? (a - b) / b * 100 : NaN; }
  function fmtDur(sec) {
    if (sec === null || sec === undefined || !isFinite(sec)) return '?';
    var s = Math.round(sec), h = Math.floor(s / 3600), m = Math.floor((s % 3600) / 60);
    var p = function (n) { return n < 10 ? '0' + n : String(n); };
    return h + ':' + p(m) + ':' + p(s % 60);
  }

  /* ------------------------------------------------------------------ *
   * 一、逐文件校验解析器
   * ------------------------------------------------------------------ */
  function verifyParsers() {
    var names = Object.keys(global.REAL_SAMPLES);
    section('一、逐文件解析校验（' + names.length + ' 个文件）');

    var bad = { parse: [], points: [], dist: [], dur: [], source: [] };
    var rows = [];
    var byFormat = { gpx: 0, tcx: 0, kml: 0 };

    for (var i = 0; i < names.length; i++) {
      var name = names[i];
      var m = global.REAL_META[name];
      byFormat[m.format]++;

      var res;
      try {
        res = global.Parsers.parseFileContent(global.REAL_SAMPLES[name], name);
      } catch (e) {
        bad.parse.push(name + ' 抛异常: ' + (e && e.message));
        continue;
      }

      if (!res.ok || !res.tracks.length) {
        bad.parse.push(name + ' → ' + (res.error || '无轨迹'));
        continue;
      }

      var t = res.tracks[0];
      var s = t.stats;

      // 解析出的点数可能**略少于**文件里的 trkpt 数 ——
      // 解析层会剔除坐标完全重复的相邻点（设备偶尔会连着写两个相同位置），
      // 那是正确行为，不算问题。这里只要求不少得离谱。
      if (t.points.length > m.pointCount ||
          t.points.length < m.pointCount * 0.995) {
        bad.points.push(name + ' 文件 ' + m.pointCount + ' 解析出 ' + t.points.length);
      }

      // 里程：现在应当**精确等于**设备自报值（因为优先采用设备数据）
      if (m.deviceDistance) {
        var dp = Math.abs(pct(s.distance, m.deviceDistance));
        if (dp > 0.01) bad.dist.push(name + ' 偏差 ' + dp.toFixed(3) + '%');
      }
      // 时长：同理
      if (m.deviceDuration) {
        var tp = Math.abs(pct(s.movingTime, m.deviceDuration));
        if (tp > 0.01) bad.dur.push(name + ' 偏差 ' + tp.toFixed(3) + '%');
      }
      // 数据来源标记
      if (m.deviceDistance && s.distanceSource !== 'device') {
        bad.source.push(name + ' 里程来源=' + s.distanceSource);
      }
      if (m.deviceDuration && s.timeSource !== 'device') {
        bad.source.push(name + ' 时长来源=' + s.timeSource);
      }

      rows.push({
        name: name, format: m.format, points: t.points.length,
        dist: s.distance, devDist: m.deviceDistance,
        dur: s.movingTime, devDur: m.deviceDuration,
        wall: s.duration, want: t.points.length === m.pointCount
      });
    }

    check('全部文件解析成功', bad.parse.length === 0,
      bad.parse.length ? bad.parse.slice(0, 5).join('; ') : names.length + ' 个全部成功');
    check('每条轨迹点数与文件吻合（允许剔除重复点）', bad.points.length === 0,
      bad.points.length ? bad.points.slice(0, 5).join('; ') : '全部吻合');
    check('里程精确等于设备自报值', bad.dist.length === 0,
      bad.dist.length ? bad.dist.slice(0, 5).join('; ') : '全部精确匹配');
    check('骑行用时精确等于设备自报时长', bad.dur.length === 0,
      bad.dur.length ? bad.dur.slice(0, 5).join('; ') : '全部精确匹配');
    check('数据来源标记正确（用的是设备值而非推算值）', bad.source.length === 0,
      bad.source.length ? bad.source.slice(0, 5).join('; ') : '');

    check('三种格式都覆盖到了',
      byFormat.gpx > 0 && byFormat.tcx > 0 && byFormat.kml > 0,
      'GPX ' + byFormat.gpx + ' / TCX ' + byFormat.tcx + ' / KML ' + byFormat.kml);

    return rows;
  }

  /* ------------------------------------------------------------------ *
   * 二、同一次骑行的三种格式必须一致
   * ------------------------------------------------------------------ */
  function verifyCrossFormat() {
    section('二、同一趟骑行的三格式一致性');

    // 找出同名的 GPX / TCX / KML
    var names = Object.keys(global.REAL_SAMPLES);
    var groups = {};
    for (var i = 0; i < names.length; i++) {
      var base = names[i].split('/').pop().replace(/\.[^.]+$/, '');
      if (!groups[base]) groups[base] = {};
      groups[base][global.REAL_META[names[i]].format] = names[i];
    }

    var tested = 0;
    for (var base2 in groups) {
      var g = groups[base2];
      if (!(g.gpx && g.tcx && g.kml)) continue;
      tested++;

      lines.push('  同一趟骑行「' + base2 + '」：');
      var results = {};
      for (var f in g) {
        var r = global.Parsers.parseFileContent(global.REAL_SAMPLES[g[f]], g[f]);
        var t = r.tracks[0];
        results[f] = t;
        lines.push('    ' + f.toUpperCase() + '  点 ' + t.points.length +
          '  里程 ' + (t.stats.distance / 1000).toFixed(3) + 'km' +
          '  用时 ' + fmtDur(t.stats.movingTime) +
          '  首点 ' + t.points[0].lat.toFixed(6) + ',' + t.points[0].lon.toFixed(6));
      }

      var gp = results.gpx, tp = results.tcx, kp = results.kml;
      check(base2 + ' 三格式点数一致',
        gp.points.length === tp.points.length && tp.points.length === kp.points.length,
        gp.points.length + ' / ' + tp.points.length + ' / ' + kp.points.length);
      check(base2 + ' 三格式里程一致',
        Math.abs(gp.stats.distance - tp.stats.distance) < 0.5 &&
        Math.abs(gp.stats.distance - kp.stats.distance) < 0.5);
      check(base2 + ' 三格式用时一致',
        Math.abs(gp.stats.movingTime - tp.stats.movingTime) < 1 &&
        Math.abs(gp.stats.movingTime - kp.stats.movingTime) < 1);
      check(base2 + ' 三格式首点坐标一致（差 < 1 米）',
        global.Geo.distance(gp.points[0].lat, gp.points[0].lon, tp.points[0].lat, tp.points[0].lon) < 1 &&
        global.Geo.distance(gp.points[0].lat, gp.points[0].lon, kp.points[0].lat, kp.points[0].lon) < 1);
    }

    if (!tested) {
      check('存在同一趟骑行的三种格式可供比对', false, '没找到同名文件');
    }
    return tested;
  }

  /* ------------------------------------------------------------------ *
   * 三、批量导入走一遍 UI
   * ------------------------------------------------------------------ */
  function runUI(rows) {
    var S = global.TracksStore;
    var names = Object.keys(global.REAL_SAMPLES);
    section('三、批量导入与界面');

    var files = [];
    for (var i = 0; i < names.length; i++) {
      files.push(new File([global.REAL_SAMPLES[names[i]]], names[i], { type: 'application/xml' }));
    }

    return global.UI.importFiles(files).then(settle).then(function () {
      global.App.afterImport();
      return wait(80);
    }).then(function () {
      check('全部文件导入成功', S.count() === names.length,
        S.count() + '/' + names.length + ' 条');

      var st = global.MapView.debugStats();
      check('全部轨迹绘制到地图', st.layers === S.count(), st.layers + ' 条图层');

      var rows2 = document.querySelectorAll('#track-list .track-item').length;
      check('列表行数与轨迹数一致', rows2 === S.count(), rows2 + ' 行');

      var tot = S.totals(S.all());
      var sumD = 0, sumT = 0;
      var all = S.all();
      for (var k = 0; k < all.length; k++) {
        sumD += all[k].stats.distance;
        sumT += all[k].stats.movingTime;
      }
      check('合计里程等于各条之和', Math.abs(tot.distance - sumD) < 0.01,
        (tot.distance / 1000).toFixed(1) + ' 公里');
      check('合计用时等于各条之和', Math.abs(tot.movingTime - sumT) < 0.01,
        (tot.movingTime / 3600).toFixed(1) + ' 小时');

      // 真实文件里确实存在长时间空档，应被切开
      var multi = 0;
      for (var j = 0; j < all.length; j++) if (all[j].segments.length > 1) multi++;
      check('含长时间空档的轨迹被切成多段', multi > 0,
        all.length + ' 条中有 ' + multi + ' 条被切分');

      // 真实文件没有海拔
      var anyEle = false;
      for (var e = 0; e < all.length; e++) {
        for (var p = 0; p < all[e].points.length; p++) {
          if (all[e].points[p].ele !== null) { anyEle = true; break; }
        }
        if (anyEle) break;
      }
      check('真实文件不含海拔时未被填成 0', anyEle === false);

      return { all: all };
    });
  }

  /* ------------------------------------------------------------------ *
   * 四、渲染与纠偏
   * ------------------------------------------------------------------ */
  function runRuntime() {
    var S = global.TracksStore;
    section('四、渲染、剖面与坐标纠偏');

    var first = null;
    var all = S.all();
    for (var i = 0; i < all.length; i++) {
      if (all[i].stats.hasTime) { first = all[i]; break; }
    }
    check('存在含时间的轨迹可供测试', !!first, first ? first.name : '未找到');
    if (!first) return Promise.resolve();

    global.App.selectTrack(first.id);

    return settle().then(function () {
      var svgs = document.querySelectorAll('#profile svg').length;
      check('无海拔时只画速度图', svgs === 1, svgs + ' 个图');

      var title = document.querySelector('#profile-section .panel-title');
      check('剖面图标题反映实际内容', title && title.textContent === '速度剖面',
        title ? title.textContent : '无');

      check('回放时间轴可用', global.Replay.hasTimeline());

      global.App.applyBasemap('amap-vector');
      return wait(60);
    }).then(function () {
      var raw = first.points[0];
      var rendered = global.MapView.debugFirstPoint(first.id);
      var off = global.Geo.distance(raw.lat, raw.lon, rendered.lat, rendered.lon);
      check('高德底图下按 GCJ-02 偏移（300~800 米）', off > 300 && off < 800,
        Math.round(off) + 'm');

      global.App.applyBasemap('osm');
      return wait(60);
    }).then(function () {
      var raw = first.points[0];
      var rendered = global.MapView.debugFirstPoint(first.id);
      var off = global.Geo.distance(raw.lat, raw.lon, rendered.lat, rendered.lon);
      check('切回 OSM 无残留偏移', off < 1, off.toFixed(4) + 'm');
    });
  }

  /* ------------------------------------------------------------------ */

  var finished = false;
  function finish() {
    if (finished) return;
    finished = true;
    var errs = global.__ERRORS__ || [];
    if (errs.length) {
      lines.push('');
      lines.push('运行期捕获到 ' + errs.length + ' 条错误：');
      for (var i = 0; i < Math.min(errs.length, 8); i++) {
        lines.push('  [' + errs[i].kind + '] ' + errs[i].message);
      }
    }
    lines.push('');
    lines.push('SUMMARY | passed=' + passed + ' | failed=' + failed);
    flushLog();
  }

  lines.push('真实文件测试驱动已加载 …');
  flushLog();

  setTimeout(function () {
    if (!finished) { lines.push(''); lines.push('WATCHDOG | 未在预期时间内跑完'); flushLog(); }
  }, 120000);

  if (!global.App || !global.App.ready) {
    check('App 已启动', false, 'app.js 没有暴露 ready');
    finish();
    return;
  }

  global.App.ready.then(function () {
    global.TracksStore.removeAll();
    return wait(50);
  }).then(function () {
    var rows = verifyParsers();
    verifyCrossFormat();
    return runUI(rows);
  }).then(function () {
    return runRuntime();
  }).then(function () {
    finish();
  }).catch(function (e) {
    check('测试驱动未抛异常', false, (e && e.stack) || String(e));
    finish();
  });
})(window);
