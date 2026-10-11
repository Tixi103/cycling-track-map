/*!
 * apptest-drive.js —— 端到端断言驱动
 *
 * 在真实的 index.html 页面上跑完整流程：导入样本 → 渲染 → 选中 → 切底图 →
 * 热力图/渐变 → 删除 → 导出 → 持久化，逐步断言。
 *
 * 结果写进页面里 #apptest-log，用无头浏览器 --dump-dom 抓取。
 */
(function (global) {
  'use strict';

  var lines = [];
  var passed = 0, failed = 0;

  function check(name, cond, detail) {
    if (cond) { passed++; lines.push('PASS | ' + name + ' | ' + (detail === undefined ? '' : detail)); }
    else { failed++; lines.push('FAIL | ' + name + ' | ' + (detail === undefined ? '' : detail)); }
  }

  function wait(ms) {
    return new Promise(function (r) { setTimeout(r, ms); });
  }

  /**
   * 等几帧，让渲染与事件回调都跑完。
   * rAF 在无头/后台标签页里不保证触发，所以必须挂一个超时兜底，
   * 否则测试会静默挂死（这正是本项目踩过的坑）。
   */
  function settle(frames) {
    frames = frames || 3;
    return new Promise(function (resolve) {
      var done = false;
      function finish() { if (!done) { done = true; resolve(); } }

      var n = 0;
      function tick() {
        n++;
        if (n >= frames) finish();
        else global.requestAnimationFrame(tick);
      }
      global.requestAnimationFrame(tick);
      setTimeout(finish, 250);
    });
  }

  function section(title) {
    lines.push('');
    lines.push('── ' + title + ' ──');
    flushLog();
  }

  /**
   * 把当前已有的结果先写进页面。
   * 测试卡住时（某个 Promise 永不 resolve），从 --dump-dom 的结果里
   * 还能看出它走到了第几步 —— 否则页面只会留下初始的 "RUNNING"，毫无线索。
   */
  function flushLog() {
    var el = document.getElementById('apptest-log');
    if (el) el.textContent = lines.join('\n');
  }

  function run() {
    var F = global.Format;
    var S = global.TracksStore;
    var MV = global.MapView;

    // 被测轨迹及其第一个原始点（WGS-84）。提升到这一层是因为后面多个 .then
    // 都要拿它们做纠偏比对，声明在某个 .then 回调内部的话，后面的 .then 里就取不到了。
    var first = null;
    var wgsRef = null;

    section('一、启动');
    check('App 已启动', typeof global.App === 'object');
    check('启动阶段无 JS 错误', global.__ERRORS__.length === 0,
      global.__ERRORS__.map(function (e) { return e.kind + ':' + e.message; }).join(' / '));
    check('地图已创建', !!MV.getMap());
    check('底图已加载', MV.getBasemap() !== null,
      MV.getBasemap() ? MV.getBasemap().id : '');
    check('存储后端已报告', typeof S.backend() === 'string', S.backend());

    var st0 = MV.debugStats();
    check('初始无轨迹图层', st0.layers === 0, 'layers=' + st0.layers);

    section('二、导入样本');

    // 把样本字符串包成 File 对象。UI.importFiles 接受任何「有 length 和下标、元素有 name/size 的类数组」，
    // 所以这里用普通数组即可，不需要真的 FileList。
    var names = Object.keys(global.SAMPLES);
    var files = [];
    for (var i = 0; i < names.length; i++) {
      files.push(new File([global.SAMPLES[names[i]]], names[i], { type: 'application/xml' }));
    }
    check('样本文件已就绪', files.length === 9, files.length + ' 个');

    lines.push('开始导入 ' + files.length + ' 个文件…'); flushLog();

    return global.UI.importFiles(files).then(function () {
      lines.push('importFiles 完成，轨迹数 = ' + S.count()); flushLog();
      return settle();
    }).then(function () {
      global.App.afterImport();
      lines.push('afterImport 完成'); flushLog();
      return wait(60);
    }).then(function () {
      // 9 个样本里 6 个有效、3 个故意损坏
      check('导入了 6 条有效轨迹（3 个坏文件被拒）', S.count() === 6, '实际 ' + S.count() + ' 条');

      var vis = S.visible();
      check('6 条轨迹默认全部可见', vis.length === 6, vis.length + ' 条可见');

      var st = MV.debugStats();
      check('地图上为每条可见轨迹建了图层', st.layers === 6, 'layers=' + st.layers);

      var rows = document.querySelectorAll('#track-list .track-item');
      check('列表渲染出 6 行', rows.length === 6, rows.length + ' 行');

      // 6 条轨迹里程相同（同一条合成路线），合计应为 6 倍
      var tot = S.totals(vis);
      var expect = 7595 * 6;
      var diff = Math.abs(tot.distance - expect) / expect;
      check('合计里程正确（误差 < 1%）', diff < 0.01,
        '期望约 ' + expect + 'm，实际 ' + Math.round(tot.distance) + 'm');

      check('合计爬升为正值', tot.elevationGain > 0, Math.round(tot.elevationGain) + 'm');

      // 合计时长必须等于各条之和，而不是各条「应有」的时长之和 ——
      // 样本里 KML LineString 那条结构上就没有时间戳，duration 理应为 0。
      var sumDur = 0;
      for (var d = 0; d < vis.length; d++) sumDur += vis[d].stats.duration || 0;
      check('合计时长等于各条之和', Math.abs(tot.duration - sumDur) < 0.001,
        Math.round(tot.duration) + 's');

      var noTime = vis.filter(function (t) { return !t.stats.hasTime; });
      check('恰好 1 条样本没有时间戳（KML LineString）', noTime.length === 1,
        noTime.length + ' 条');
      check('无时间戳轨迹的时长记为 0，不污染合计',
        noTime.length === 1 && noTime[0].stats.duration === 0);

      // 统计面板
      var statsText = document.getElementById('stats').textContent;
      check('统计面板显示了里程数字', /公里/.test(statsText), statsText.slice(0, 60).replace(/\s+/g, ' '));

      // 导入失败的文件应该给出提示
      check('损坏文件有提示条', !!document.querySelector('#notice-area .notice-error'));

      section('三、选中与剖面图');

      // 刻意挑一条带完整数据的轨迹：列表按时间倒序，无时间戳的那条会排在最前，
      // 用 visible()[0] 会选中它，而它没有速度数据，测不出剖面图的两条曲线
      var withData = null;
      for (var w = 0; w < vis.length; w++) {
        if (vis[w].stats.hasTime && vis[w].stats.hasElevation) { withData = vis[w]; break; }
      }
      check('存在一条含时间与海拔的轨迹可供测试', !!withData,
        withData ? withData.name : '未找到');
      if (!withData) return Promise.resolve();

      first = withData;
      wgsRef = first.points[0];
      global.App.selectTrack(first.id);

      return settle().then(function () {
        check('选中后高亮生效', global.App.getSelectedId() === first.id);
        check('列表高亮同步',
          !!document.querySelector('#track-list .track-item.is-selected'));

        var svgCount = document.querySelectorAll('#profile svg').length;
        check('剖面图渲染出 SVG', svgCount >= 1, svgCount + ' 个图');

        check('剖面图有两个独立小图（海拔 + 速度，无双 Y 轴）', svgCount === 2, svgCount + ' 个');

        var g = document.getElementById('chk-gradient');
        check('选中后「按速度着色」可用', g && g.disabled === false);

        check('回放有时间轴', global.Replay.hasTimeline());

        var replayVisible = !document.getElementById('replay-section').hidden;
        check('回放控件已显示', replayVisible);

        var speeds = S.get(first.id).stats.hasTime;
        check('时间轴就绪（轨迹含时间）', speeds === true);

        section('四、底图切换与坐标纠偏');

        // 先切到高德（GCJ-02）
        global.App.applyBasemap('amap-vector');
        return wait(40);
      }).then(function () {
        check('切到高德后坐标系为 GCJ02', MV.getCrs() === 'GCJ02', MV.getCrs());
        check('高德底图已生效', MV.getBasemap().id === 'amap-vector');

        // 渲染出来的坐标应该已经偏移（Beijing 约 500 米）
        var rendered = MV.debugFirstPoint(first.id);
        check('轨迹已按 GCJ-02 重投影（偏移 > 100 米）',
          !!rendered && global.Geo.distance(wgsRef.lat, wgsRef.lon, rendered.lat, rendered.lon) > 100,
          rendered ? Math.round(global.Geo.distance(wgsRef.lat, wgsRef.lon, rendered.lat, rendered.lon)) + 'm' : '无');

        // 原始点绝不能被改写
        var still = S.get(first.id).points[0];
        check('原始 WGS-84 坐标未被改写', still.lon === wgsRef.lon && still.lat === wgsRef.lat);

        // 切到 OSM（WGS-84）
        global.App.applyBasemap('osm');
        return wait(40);
      }).then(function () {
        check('切到 OSM 后坐标系为 WGS84', MV.getCrs() === 'WGS84', MV.getCrs());

        var rendered = MV.debugFirstPoint(first.id);
        check('切回 WGS-84 后无累积偏移（< 1 米）',
          !!rendered && global.Geo.distance(wgsRef.lat, wgsRef.lon, rendered.lat, rendered.lon) < 1,
          rendered ? global.Geo.distance(wgsRef.lat, wgsRef.lon, rendered.lat, rendered.lon).toFixed(3) + 'm' : '无');

        // 再切一轮，确认往返是幂等的
        global.App.applyBasemap('amap-vector');
        return wait(30);
      }).then(function () {
        var rendered = MV.debugFirstPoint(first.id);
        var d1 = global.Geo.distance(wgsRef.lat, wgsRef.lon, rendered.lat, rendered.lon);

        global.App.applyBasemap('osm');
        return wait(30).then(function () {
          global.App.applyBasemap('amap-vector');
          return wait(30);
        }).then(function () {
          var again = MV.debugFirstPoint(first.id);
          var d2 = global.Geo.distance(wgsRef.lat, wgsRef.lon, again.lat, again.lon);
          check('两次来回切换后偏移量完全一致（幂等，无累积误差）',
            Math.abs(d1 - d2) < 0.01,
            d1.toFixed(2) + 'm vs ' + d2.toFixed(2) + 'm');
        });
      }).then(function () {
        section('五、热力图与渐变着色');

        var trackCount = S.visible().length;

        global.App.setHeatmap(true);
        return settle().then(function () {
          check('热力图已开启', MV.isHeatmapOn());
          check('热力图产生了网格数据', MV.debugStats().heatCells > 0,
            MV.debugStats().heatCells + ' 个格子');
          // 热力图与矢量轨迹必须互斥，否则两套叠在一起互相干扰
          check('热力图模式下矢量轨迹被隐藏', MV.debugStats().heatVisibleLayers === 0,
            '仍显示 ' + MV.debugStats().heatVisibleLayers + ' 条');

          global.App.setHeatmap(false);
          return settle();
        }).then(function () {
          check('热力图已关闭', !MV.isHeatmapOn());
          check('退出热力图后矢量轨迹恢复显示',
            MV.debugStats().heatVisibleLayers === trackCount,
            MV.debugStats().heatVisibleLayers + '/' + trackCount);

          var g = document.getElementById('chk-gradient');
          g.checked = true;
          g.onchange();
          return settle();
        }).then(function () {
          check('按速度渐变着色已开启', MV.isGradientOn());
          check('渐变产生了多个速度色段', MV.debugStats().gradientSegs > 1,
            MV.debugStats().gradientSegs + ' 段');

          var g = document.getElementById('chk-gradient');
          g.checked = false;
          g.onchange();
          return settle();
        });
      }).then(function () {
        section('六、显隐、改名与删除');

        var list = S.all();
        var target = list[0];

        S.update(target.id, { visible: false });
        return settle().then(function () {
          var st = MV.debugStats();
          check('隐藏一条后地图图层减少', st.layers === 5, 'layers=' + st.layers);
          check('隐藏状态反映到列表',
            !!document.querySelector('#track-list .track-item.is-hidden'));

          S.update(target.id, { visible: true });
          return settle();
        }).then(function () {
          check('恢复显示后图层数复原', MV.debugStats().layers === 6,
            'layers=' + MV.debugStats().layers);

          S.update(target.id, { name: '改过的名字' });
          return settle();
        }).then(function () {
          var row = document.querySelector('#track-list .track-item');
          check('改名成功', S.get(target.id).name === '改过的名字');
          var names = document.querySelectorAll('#track-list .track-name');
          var found = false;
          for (var i = 0; i < names.length; i++) {
            if (names[i].textContent === '改过的名字') { found = true; break; }
          }
          check('改名反映到列表', found);

          // 轨迹名来自文件内容，必须用 textContent 渲染，不能被当成 HTML
          S.update(target.id, { name: '<img src=x onerror=alert(1)>' });
          return settle();
        }).then(function () {
          var injected = document.querySelector('#track-list img');
          check('轨迹名不会被当作 HTML 执行（防注入）', injected === null,
            injected ? '发现了注入的 img 节点' : '');

          var removed = S.remove([S.all()[0].id]);
          return settle().then(function () {
            check('删除一条成功', removed === 1 && S.count() === 5,
              S.count() + ' 条剩余');
            check('删除后地图图层同步', MV.debugStats().layers === 5,
              'layers=' + MV.debugStats().layers);
          });
        });
      }).then(function () {
        section('七、导出与持久化');

        var json = S.exportJson();
        check('导出 JSON 非空', json.length > 1000, Math.round(json.length / 1024) + ' KB');

        var parsed = null;
        try { parsed = JSON.parse(json); } catch (e) { /* 下面断言报错 */ }
        check('导出内容可被 JSON 解析', parsed !== null);
        check('导出内容含 tracks 数组', parsed && Array.isArray(parsed.tracks),
          parsed ? (parsed.tracks ? parsed.tracks.length + ' 条' : '无') : '');
        check('导出内容带应用标识', parsed && parsed.app === 'cycling-track-map');

        var pointsOk = parsed && parsed.tracks.every(function (t) {
          return t.points && t.points.length > 2;
        });
        check('每条导出的轨迹都带点数据', pointsOk === true);

        var hasColor = parsed && parsed.tracks.every(function (t) { return !!t.color; });
        check('导出保留了颜色', hasColor === true);

        // 导入回来（应该因为 id 重复而全部跳过）
        var res = S.importJson(json);
        check('重复导入同一份备份按 id 去重', res.added === 0 && res.skipped === 5,
          '新增 ' + res.added + '，跳过 ' + res.skipped);

        var s = S.all()[0].stats;
        check('统计对象完整', s && typeof s.distance === 'number' && typeof s.elevationGain === 'number');

        return wait(1400);   // 等防抖落盘
      }).then(function () {
        check('落盘后无错误', global.__ERRORS__.length === 0,
          global.__ERRORS__.map(function (e) { return e.message; }).join(' / '));

        section('八、配色模式');

        global.App.setColorMode('single');
        return settle().then(function () {
          var colors = {};
          var list = S.all();
          for (var i = 0; i < list.length; i++) colors[list[i].color] = true;
          check('单色模式下所有轨迹同色', Object.keys(colors).length === 1,
            Object.keys(colors).join(', '));

          global.App.setColorMode('category');
          return settle();
        }).then(function () {
          var list = S.all();
          var distinct = {};
          for (var i = 0; i < list.length; i++) distinct[list[i].color] = true;
          // 规范约束：分类色最多 3 个可区分色槽，超出并入中性灰
          check('分类模式最多用 4 种颜色（3 色槽 + 其它）',
            Object.keys(distinct).length <= 4, Object.keys(distinct).length + ' 种');

          global.App.setColorMode('time');
          return settle();
        }).then(function () {
          var list = S.all();
          var distinct = {};
          for (var i = 0; i < list.length; i++) distinct[list[i].color] = true;
          // 样本分布在 2024-05-01 ~ 05-28，时间色阶应当分出多个档位，
          // 而不是全部落到同一档（那样等于这条代码路径没被测到）
          check('时间渐变按日期分出多个色阶', Object.keys(distinct).length >= 3,
            Object.keys(distinct).length + ' 种色阶：' + Object.keys(distinct).join(' '));
        });
      }).then(function () {
        finish();
      });
    }).catch(function (e) {
      check('测试驱动本身未抛异常', false, (e && e.stack) || String(e));
      finish();
    });
  }

  function finish() {
    if (finished) return;   // 只允许写一次 SUMMARY
    finished = true;
    var errs = global.__ERRORS__;
    lines.push('');
    if (errs.length) {
      lines.push('运行期捕获到 ' + errs.length + ' 条错误：');
      for (var i = 0; i < Math.min(errs.length, 10); i++) {
        lines.push('  [' + errs[i].kind + '] ' + errs[i].message);
      }
    }
    lines.push('SUMMARY | passed=' + passed + ' | failed=' + failed);

    var el = document.getElementById('apptest-log');
    if (el) el.textContent = lines.join('\n');
    global.__APPTEST__ = { passed: passed, failed: failed, lines: lines };
  }

  lines.push('驱动脚本已加载，等待 App.ready …');
  flushLog();

  // 看门狗：万一某个 Promise 永远不 resolve，至少还能拿到已跑完的断言，
  // 而不是页面停留在最初的 "RUNNING" 上无从排查。
  //
  // 注意它**不写 SUMMARY**，只在末尾留一条标记。写 SUMMARY 会造成误导 ——
  // 无头模式下虚拟时间推进得比真实时间快得多，看门狗可能在看-
  // 起来很早的时刻触发，此时测试其实还在正常跑，随后会写出真正的 SUMMARY。
  var finished = false;
  setTimeout(function () {
    if (finished) return;
    lines.push('');
    lines.push('WATCHDOG | 到此为止，测试未在预期时间内跑完（可能是卡住了）');
    flushLog();
  }, 60000);

  // App.ready 由 app.js 在启动时暴露；等它就绪说明初始化（含本地存储恢复）已完成
  if (!global.App || !global.App.ready) {
    lines.push('FAIL | App 未暴露 ready（app.js 可能没加载成功）');
    finish();
    return;
  }

  global.App.ready.then(function () {
    lines.push('App.ready 已就绪，开始断言。');
    flushLog();
    return run();
  }).catch(function (e) {
    check('启动流程未抛异常', false, (e && e.stack) || String(e));
    finish();
  });
})(window);
