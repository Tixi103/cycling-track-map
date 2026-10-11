/*!
 * app.js —— 主控：初始化与事件接线
 *
 * 这个文件不含业务逻辑，只做三件事：
 *   1. 按依赖顺序把各模块初始化起来
 *   2. 把各模块之间的事件接上（谁变了通知谁）
 *   3. 处理选区、底图切换、导入导出这些跨模块的编排
 *
 * 数据流是单向的：
 *   用户操作 → TracksStore（唯一数据源）→ change 事件 → UI 重绘 / 地图重画
 * 没有任何模块会绕过 TracksStore 去改数据。
 */
(function (global) {
  'use strict';

  var selectedId = null;
  var booted = false;
  var coloredOnce = false;

  /* ------------------------------------------------------------------ *
   * 选区
   * ------------------------------------------------------------------ */

  function selectTrack(id) {
    if (selectedId === id) {
      // 再次点击已选中的项 = 取消选中
      id = null;
    }
    selectedId = id;

    global.MapView.setSelected(id);
    global.UI.highlightSelection(id);
    global.UI.renderStats(id ? global.TracksStore.get(id) : null);

    var track = id ? global.TracksStore.get(id) : null;
    global.Profile.render(track);

    // 回放只针对聚焦的那一条轨迹
    if (track) global.Replay.load(track);
    else { global.Replay.load(null); }

    var grad = document.getElementById('chk-gradient');
    if (grad) grad.disabled = !track;
  }

  function focusTrack(id) {
    selectTrack(id);
    global.MapView.fitTrack(id);
  }

  function requestDelete(id) {
    var t = global.TracksStore.get(id);
    if (!t) return;
    global.UI.confirm({
      title: '删除轨迹',
      body: '确定要删除「' + t.name + '」吗？删除后可以重新导入原始文件还原。',
      confirmText: '删除',
      danger: true
    }).then(function (ok) {
      if (!ok) return;
      if (selectedId === id) selectTrack(null);
      global.TracksStore.remove([id]);
      global.UI.notice('已删除「' + t.name + '」。', { type: 'info', timeout: 3000 });
    });
  }

  function requestClearAll() {
    var n = global.TracksStore.count();
    if (!n) return;
    global.UI.confirm({
      title: '清空全部轨迹',
      body: '将删除全部 ' + n + ' 条轨迹。建议先「导出备份」，之后可以随时导入还原。',
      confirmText: '全部清空',
      danger: true
    }).then(function (ok) {
      if (!ok) return;
      selectTrack(null);
      global.TracksStore.removeAll();
      global.UI.notice('已清空全部轨迹。', { type: 'info', timeout: 3000 });
    });
  }

  /* ------------------------------------------------------------------ *
   * 地图刷新
   * ------------------------------------------------------------------ */

  function refreshMap() {
    global.MapView.render(global.TracksStore.visible());
  }

  function afterImport() {
    refreshMap();

    var list = global.TracksStore.visible();
    if (!list.length) return;

    if (!coloredOnce) {
      // 第一次导入：直接把视野对到所有轨迹上
      coloredOnce = true;
      global.MapView.fitAll(list, { padding: [40, 40], maxZoom: 16, animate: false });
      return;
    }

    // 后续新增：只有当新轨迹不在当前视野里时才移动镜头。
    // 否则用户每加一条轨迹，镜头就被粗暴拽走一次。
    var bounds = global.MapView.boundsOf(list);
    if (!bounds) return;
    var map = global.MapView.getMap();
    if (!map) return;
    try {
      if (!map.getBounds().contains(global.L.latLngBounds(bounds))) {
        global.MapView.fitAll(list, { padding: [40, 40], maxZoom: 16, animate: true });
      }
    } catch (e) { /* 包围盒异常时不动镜头即可 */ }
  }

  /** 剖面图悬停时联动地图上的游标 */
  function cueAt(lat, lon) {
    if (lat === null || lat === undefined) {
      global.MapView.setCueMarker(null);
      return;
    }
    global.MapView.setCueMarker([lat, lon]);
  }

  /* ------------------------------------------------------------------ *
   * 底图与配色
   * ------------------------------------------------------------------ */

  function applyBasemap(id) {
    var crs = global.MapView.setBasemap(id);
    var p = global.Basemaps.get(id);

    // 底图的明暗决定了轨迹该用哪一套色阶（浅底图用深色端，深底图用浅色端）
    if (p) global.TracksStore.setSurface(p.surface);

    refreshMap();
    global.MapView.refreshColorLayers();

    // 切坐标系会让轨迹整体偏移几百米，高缩放下可能整条跑出视野。
    // 但只有在真的看不见了才重新定位 —— 无条件 fit 会把用户的缩放位置粗暴重置。
    if (crs) {
      setTimeout(function () {
        global.MapView.ensureVisibleOnScreen(global.TracksStore.visible());
      }, 0);
    }
  }

  function setColorMode(mode) {
    global.TracksStore.setColorMode(mode);
    refreshMap();
  }

  /** 热力图按钮的按下态。单独抽出来是因为模式可能被地图层回滚（无数据时）。 */
  function syncHeatButton(on) {
    var btn = document.getElementById('btn-heatmap');
    if (btn) btn.classList.toggle('btn-primary', !!on);
  }

  function setHeatmap(on) {
    // 热力图与矢量轨迹互斥：两套叠在一起会互相干扰，
    // 而且热力图的意义本来就是「不关心单条轨迹，只看全局分布」
    global.MapView.setHeatmap(!!on, global.TracksStore.visible());

    if (on && !global.MapView.isHeatmapOn()) {
      // 没有数据可画，MapView 会把模式回滚并触发 onHeatmapEmpty
      return;
    }
    syncHeatButton(on);

    if (on) {
      global.UI.notice('已切换到热力图模式：颜色越深表示骑过的次数越多。再点一次按钮可切回轨迹模式。', {
        id: 'heatmap', type: 'info', timeout: 5000
      });
    }
  }

  /* ------------------------------------------------------------------ *
   * 导出与导入
   * ------------------------------------------------------------------ */

  function downloadText(filename, text, mime) {
    var blob = new Blob([text], { type: (mime || 'application/json') + ';charset=utf-8' });
    var url = URL.createObjectURL(blob);
    var a = document.createElement('a');
    a.href = url;
    a.download = filename;
    document.body.appendChild(a);   // 必须入文档，某些浏览器不入文档不触发下载
    a.click();
    document.body.removeChild(a);
    // 立刻 revoke 会取消还未开始的下载，留一点时间
    setTimeout(function () { URL.revokeObjectURL(url); }, 4000);
  }

  function exportBackup() {
    var tracks = global.TracksStore.all();
    if (!tracks.length) {
      global.UI.notice('还没有轨迹可以导出。', { type: 'warn' });
      return;
    }

    var text = global.TracksStore.exportJson();
    var name = '骑行轨迹备份-' + global.Format.fileStamp(Date.now()) + '.json';

    try {
      downloadText(name, text, 'application/json');
      global.UI.notice('已导出 ' + tracks.length + ' 条轨迹的备份文件。保存好它，换电脑时导入即可还原。', {
        id: 'export', type: 'ok', timeout: 6000
      });
    } catch (e) {
      showExportFallback(text, e);
    }
  }

  /** 下载失败时的降级路径：把 JSON 摊在文本框里让用户自己复制 */
  function showExportFallback(text, err) {
    var ta = document.createElement('textarea');
    ta.className = 'modal-textarea';
    ta.value = text;
    ta.readOnly = true;

    global.UI.modal({
      title: '导出备份',
      body: '自动下载没能成功（' + ((err && err.message) || '浏览器限制') + '）。' +
            '请点击下面的文本全选复制，粘贴到记事本里另存为 .json 文件。',
      bodyNode: ta,
      buttons: [
        { label: '全选复制', kind: 'outline', keepOpen: true, onClick: function () { ta.select(); document.execCommand('copy'); } },
        { label: '关闭', kind: 'ghost' }
      ]
    });
  }

  function importBackup() {
    var input = document.getElementById('json-input');
    if (!input) return;
    input.click();
  }

  function bindJsonImport() {
    var input = document.getElementById('json-input');
    if (!input) return;
    input.onchange = function () {
      // 先把 File 取出来再清空 input。
      // input.files 是活的 FileList，value = '' 会把它一起清空，
      // 顺序反了就会出现「选了文件没反应」。
      var file = input.files && input.files[0];
      input.value = '';
      if (!file) return;

      global.UI.showProgress('正在读取备份…');
      var read = file.text ? file.text() : new Promise(function (resolve, reject) {
        var fr = new FileReader();
        fr.onload = function () { resolve(fr.result); };
        fr.onerror = function () { reject(fr.error); };
        fr.readAsText(file);
      });

      read.then(function (text) {
        global.UI.hideProgress();
        var res;
        try {
          res = global.TracksStore.importJson(text);
        } catch (e) {
          global.UI.notice('导入失败：' + e.message, { type: 'error' });
          return;
        }
        refreshMap();
        afterImport();
        var msg = '已导入 ' + res.added + ' 条轨迹。';
        if (res.skipped) msg += '跳过 ' + res.skipped + ' 条已存在的（按 id 去重）。';
        global.UI.notice(msg, { type: res.added ? 'ok' : 'warn', timeout: 5000 });
      }).catch(function (e) {
        global.UI.hideProgress();
        global.UI.notice('读取备份文件失败：' + ((e && e.message) || '未知原因'), { type: 'error' });
      });
    };
  }

  /* ------------------------------------------------------------------ *
   * 键盘快捷键
   * ------------------------------------------------------------------ */

  function bindKeys() {
    document.addEventListener('keydown', function (e) {
      // 正在改名、或者在输入框里时，快捷键一律让路
      var tag = (e.target && e.target.tagName) || '';
      if (e.target && e.target.isContentEditable) return;
      if (tag === 'INPUT' || tag === 'SELECT' || tag === 'TEXTAREA') return;

      if (e.key === 'Escape') {
        if (selectedId) selectTrack(null);
        return;
      }

      if (e.code === 'Space') {
        if (!selectedId) return;
        if (!global.Replay.hasTimeline()) return;
        e.preventDefault();
        global.Replay.toggle();
        return;
      }

      // 左右方向键：在轨迹之间切换
      if (e.key === 'ArrowDown' || e.key === 'ArrowUp') {
        var list = global.TracksStore.all();
        if (list.length < 2) return;
        e.preventDefault();
        var idx = -1;
        for (var i = 0; i < list.length; i++) if (list[i].id === selectedId) { idx = i; break; }
        var next;
        if (idx < 0) next = e.key === 'ArrowDown' ? 0 : list.length - 1;
        else next = (idx + (e.key === 'ArrowDown' ? 1 : -1) + list.length) % list.length;
        focusTrack(list[next].id);
      }
    });
  }

  /* ------------------------------------------------------------------ *
   * 顶栏
   * ------------------------------------------------------------------ */

  function buildBasemapSelect() {
    var sel = document.getElementById('basemap-select');
    if (!sel) return;
    var list = global.Basemaps.list();
    for (var i = 0; i < list.length; i++) {
      var o = document.createElement('option');
      o.value = list[i].id;
      o.textContent = list[i].name + (list[i].note ? '（' + list[i].note + '）' : '');
      sel.appendChild(o);
    }
    sel.value = global.Basemaps.defaultId();
    sel.onchange = function () { applyBasemap(sel.value); };
  }

  function buildColorModeSelect() {
    var sel = document.getElementById('color-mode');
    if (!sel) return;
    // 「分类」按规范只能可靠区分 3 条，超过就并入灰，所以标注上限
    var opts = [
      ['time', '按时间渐变'],
      ['single', '单色'],
      ['category', '分类色（最多 ' + global.TracksStore.categoryLimit() + ' 条可区分）']
    ];
    for (var i = 0; i < opts.length; i++) {
      var o = document.createElement('option');
      o.value = opts[i][0];
      o.textContent = opts[i][1];
      sel.appendChild(o);
    }
    sel.value = global.TracksStore.getColorMode();
    sel.onchange = function () { setColorMode(sel.value); };
  }

  function bindToolbar() {
    var fit = document.getElementById('btn-fit-all');
    if (fit) fit.onclick = function () {
      global.MapView.fitAll(global.TracksStore.visible(),
        { padding: [40, 40], maxZoom: 16, animate: true });
    };

    var exp = document.getElementById('btn-export');
    if (exp) exp.onclick = exportBackup;

    var imp = document.getElementById('btn-import-json');
    if (imp) imp.onclick = importBackup;

    var heat = document.getElementById('btn-heatmap');
    if (heat) heat.onclick = function () {
      setHeatmap(!global.MapView.isHeatmapOn());
    };

    var grad = document.getElementById('chk-gradient');
    if (grad) {
      grad.disabled = true;
      grad.onchange = function () { global.MapView.setGradient(grad.checked); };
    }

    var clr = document.getElementById('btn-clear');
    if (clr) clr.onclick = requestClearAll;
  }

  /* ------------------------------------------------------------------ *
   * 启动
   * ------------------------------------------------------------------ */

  function boot() {
    if (booted) return;
    booted = true;

    // 地图先起来，后面的渲染才有落点
    global.MapView.init('map');
    global.UI.init(global.TracksStore);
    global.Profile.init();
    global.Replay.init();

    global.MapView.on('onPick', function (id) { selectTrack(id); });
    global.MapView.on('onMapClick', function () { if (selectedId) selectTrack(null); });
    global.MapView.on('onHover', function (id, e) { showHoverTip(id, e); });
    global.MapView.on('onHoverEnd', function () { hideHoverTip(); });
    global.MapView.on('onTileError', function (p) {
      global.UI.notice('底图「' + (p ? p.name : '') + '」加载失败，可能是当前网络访问不了这个瓦片服务。' +
        '轨迹数据和统计不受影响，可以换一个底图试试。', { id: 'tile', type: 'warn' });
    });
    global.MapView.on('onHeatmapEmpty', function () {
      syncHeatButton(false);
      global.UI.notice('还没有轨迹，热力图没有内容可画。先导入几条骑行记录吧。', {
        type: 'warn', timeout: 4000
      });
    });
    global.MapView.on('onBasemap', function (p) {
      // 底图明暗变化后，已画的热力图与渐变要用新色阶重画
      if (global.MapView.isHeatmapOn()) {
        global.MapView.setHeatmap(true, global.TracksStore.visible());
      }
    });

    buildBasemapSelect();
    buildColorModeSelect();
    bindToolbar();
    bindJsonImport();
    bindKeys();

    // 数据一变就重画地图与统计
    global.TracksStore.on('change', function (payload) {
      // 先处理选中项的失效，再刷新界面，否则会按已删除的轨迹去渲染统计
      if (payload && (payload.type === 'removed' || payload.type === 'reset')) {
        if (selectedId && !global.TracksStore.get(selectedId)) selectTrack(null);
      }
      refreshMap();
      global.UI.renderStats(selectedId ? global.TracksStore.get(selectedId) : null);
      if (payload && payload.type === 'repaint') {
        global.MapView.refreshColorLayers();
      }
    });

    global.TracksStore.on('loaded', function () {
      if (global.TracksStore.count()) coloredOnce = true;
    });

    global.TracksStore.on('saveError', function () { /* 由 UI 层统一提示 */ });

    // 关页面前尽量把改动落盘。不能在这里做重活 ——
    // 浏览器不保证等异步完成，真正靠的是输入后的防抖落盘，这里只是兜底。
    global.addEventListener('beforeunload', function () {
      global.TracksStore.flush();
    });
    global.addEventListener('pagehide', function () {
      global.TracksStore.flush();
    });

    // 窗口尺寸变化后刷新地图尺寸。面板开合、横竖屏切换也走这里。
    var resizeTimer = null;
    global.addEventListener('resize', function () {
      if (resizeTimer) clearTimeout(resizeTimer);
      resizeTimer = setTimeout(function () { global.MapView.invalidateSize(); }, 150);
    });

    // 从本地存储恢复轨迹
    global.App.ready = global.TracksStore.init().then(function (backend) {
      global.UI.renderStorageBadge();
      // 存储后端到这里才探测完成。在此之前 getBackend() 还是默认值，
      // 会把 localStorage 环境误报成「无法保存数据」。
      global.UI.warnIfEphemeral();
      global.UI.renderList();
      global.UI.renderStats(null);
      applyBasemap(document.getElementById('basemap-select').value);
      refreshMap();

      var n = global.TracksStore.count();
      if (n) {
        afterImport();
        global.UI.notice('已从本地恢复 ' + n + ' 条轨迹。', { id: 'restore', type: 'info', timeout: 4000 });
      }
      var hint = document.getElementById('map-hint');
      if (hint) hint.hidden = true;
    }).catch(function (e) {
      var hint = document.getElementById('map-hint');
      if (hint) hint.hidden = true;
      global.UI.notice('初始化失败：' + ((e && e.message) || '未知原因'), { type: 'error' });
    });
  }

  /* ------------------------------------------------------------------ *
   * 悬浮提示
   * ------------------------------------------------------------------ */

  var tipLayer = null;

  function showHoverTip(id, e) {
    var track = global.TracksStore.get(id);
    if (!track) return;
    var map = global.MapView.getMap();
    if (!map) return;

    var F = global.Format;
    var s = track.stats || {};

    // 用 DOM 节点构造内容，不用 HTML 字符串 —— 轨迹名是外部输入
    var box = document.createElement('div');
    box.className = 'track-tip';
    var name = document.createElement('div');
    name.className = 'track-tip-name';
    name.textContent = track.name;
    box.appendChild(name);

    var rows = [
      ['里程', F.distance(s.distance, true)],
      ['用时', F.duration(s.movingTime)],   // 移动时间，与华为 App 口径一致
      ['均速', F.speed(s.movingAvgSpeed || s.avgSpeed)]
    ];
    if (s.hasTime && s.startTime) rows.push(['日期', F.dateTime(s.startTime)]);

    for (var i = 0; i < rows.length; i++) {
      var r = document.createElement('div');
      r.className = 'track-tip-row';
      r.appendChild(document.createTextNode(rows[i][0] + '：'));
      var b = document.createElement('b');
      b.textContent = rows[i][1];
      r.appendChild(b);
      box.appendChild(r);
    }

    if (!tipLayer) {
      tipLayer = global.L.tooltip({ direction: 'top', offset: [0, -10], opacity: 1 });
    }
    tipLayer.setLatLng(e.latlng);
    tipLayer.setContent(box);
    trayAdd();
  }

  function trayAdd() {
    var map = global.MapView.getMap();
    if (tipLayer && map && !map.hasLayer(tipLayer)) tipLayer.addTo(map);
  }

  function hideHoverTip() {
    var map = global.MapView.getMap();
    if (tipLayer && map && map.hasLayer(tipLayer)) map.removeLayer(tipLayer);
  }

  /* ------------------------------------------------------------------ *
   * 全局错误兜底
   * ------------------------------------------------------------------ */

  global.addEventListener('error', function (e) {
    // 只在已经启动后提示，避免把浏览器扩展的报错也算进来
    if (!booted) return;
    if (global.console && console.error) console.error('[app] 未捕获错误', e.error || e.message);
  });

  global.App = {
    boot: boot,
    selectTrack: selectTrack,
    focusTrack: focusTrack,
    requestDelete: requestDelete,
    requestClearAll: requestClearAll,
    afterImport: afterImport,
    cueAt: cueAt,
    exportBackup: exportBackup,
    applyBasemap: applyBasemap,
    setColorMode: setColorMode,
    setHeatmap: setHeatmap,
    getSelectedId: function () { return selectedId; }
  };

  // 所有脚本都是 defer，执行到这里 DOM 已经解析完毕，直接启动即可
  boot();
})(window);
