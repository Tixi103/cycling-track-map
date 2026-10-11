/*!
 * ui.js —— 界面渲染与文件交互
 *
 * 负责：轨迹列表、统计面板、提示条、模态框、进度提示、文件读取与解析调度。
 *
 * 两条必须守住的规矩：
 *   1. **所有来自文件的内容一律用 textContent 渲染**，绝不用 innerHTML。
 *      轨迹名取自用户导入的 GPX/TCX/KML 内部字段，那是外部输入，
 *      直接拼进 HTML 就是注入漏洞。
 *   2. 本模块只读 TracksStore，从不直接改它的内部数组 —— 改数据一律走
 *      TracksStore.update / remove，然后由事件驱动重绘。
 */
(function (global) {
  'use strict';

  var Store = null;   // TracksStore 的引用，init 时赋上

  var el = {};        // DOM 引用
  var notices = {};   // id -> 元素
  var progressEl = null;
  var editingId = null;

  /* ------------------------------------------------------------------ *
   * 工具
   * ------------------------------------------------------------------ */

  function $(id) { return document.getElementById(id); }

  function make(tag, cls, text) {
    var n = document.createElement(tag);
    if (cls) n.className = cls;
    if (text !== undefined && text !== null) n.textContent = text;
    return n;
  }

  function clear(node) {
    while (node.firstChild) node.removeChild(node.firstChild);
  }

  /* ------------------------------------------------------------------ *
   * 提示条
   * ------------------------------------------------------------------ */

  /**
   * 顶部提示条。
   * @param {string} text
   * @param {Object} [opts]
   *   type     'info'(默认) | 'warn' | 'error' | 'ok'
   *   id       相同 id 的提示会替换而不是堆叠
   *   actions  [{label, onClick}]
   *   timeout  毫秒后自动消失
   */
  function notice(text, opts) {
    opts = opts || {};
    var id = opts.id || ('n_' + Math.random().toString(36).slice(2, 8));

    if (notices[id] && notices[id].parentNode) {
      notices[id].parentNode.removeChild(notices[id]);
    }

    var box = make('div', 'notice' + (opts.type && opts.type !== 'info' ? ' notice-' + opts.type : ''));
    box.appendChild(make('div', 'notice-text', text));

    if (opts.actions && opts.actions.length) {
      for (var i = 0; i < opts.actions.length; i++) {
        (function (a) {
          var b = make('button', 'notice-action', a.label);
          b.type = 'button';
          b.onclick = function () { close(); a.onClick(); };
          box.appendChild(b);
        })(opts.actions[i]);
      }
    }

    var closeBtn = make('button', 'notice-close', '×');
    closeBtn.type = 'button';
    closeBtn.title = '关闭';
    closeBtn.onclick = close;
    box.appendChild(closeBtn);

    el.noticeArea.appendChild(box);
    notices[id] = box;

    if (opts.timeout) setTimeout(close, opts.timeout);

    function close() {
      if (box && box.parentNode) box.parentNode.removeChild(box);
      delete notices[id];
    }

    return close;
  }

  /** 富文本提示（列表形式），内容仍然只用 textContent */
  function noticeList(title, items, opts) {
    opts = opts || {};
    var id = opts.id || ('n_' + Math.random().toString(36).slice(2, 8));
    if (notices[id] && notices[id].parentNode) {
      notices[id].parentNode.removeChild(notices[id]);
    }
    var box = make('div', 'notice' + (opts.type && opts.type !== 'info' ? ' notice-' + opts.type : ''));
    var body = make('div', 'notice-text');
    body.appendChild(document.createTextNode(title));
    var ul = make('ul');
    for (var i = 0; i < items.length; i++) ul.appendChild(make('li', null, items[i]));
    body.appendChild(ul);
    box.appendChild(body);

    if (opts.actions) {
      for (var j = 0; j < opts.actions.length; j++) {
        (function (a) {
          var b = make('button', 'notice-action', a.label);
          b.type = 'button';
          b.onclick = function () { close(); a.onClick(); };
          box.appendChild(b);
        })(opts.actions[j]);
      }
    }

    var cb = make('button', 'notice-close', '×');
    cb.type = 'button';
    cb.onclick = close;
    box.appendChild(cb);

    el.noticeArea.appendChild(box);
    notices[id] = box;

    function close() {
      if (box && box.parentNode) box.parentNode.removeChild(box);
      delete notices[id];
    }
    return close;
  }

  /* ------------------------------------------------------------------ *
   * 模态框
   * ------------------------------------------------------------------ */

  /**
   * 通用模态框。
   * @returns {{close: Function, body: Element}}
   */
  function modal(opts) {
    opts = opts || {};
    var backdrop = make('div', 'modal-backdrop');
    var box = make('div', 'modal');

    box.appendChild(make('div', 'modal-head', opts.title || ''));
    var body = make('div', 'modal-body');
    if (opts.body) body.appendChild(document.createTextNode(opts.body));
    if (opts.bodyNode) body.appendChild(opts.bodyNode);
    box.appendChild(body);

    var foot = make('div', 'modal-foot');
    var buttons = opts.buttons || [];
    for (var i = 0; i < buttons.length; i++) {
      (function (bdef) {
        var b = make('button', 'btn ' + (bdef.kind === 'primary' ? 'btn-primary'
          : bdef.kind === 'ghost' ? 'btn-ghost' : 'btn-outline'), bdef.label);
        b.type = 'button';
        b.onclick = function () { if (bdef.onClick) bdef.onClick(); if (bdef.keepOpen !== true) close(); };
        foot.appendChild(b);
      })(buttons[i]);
    }
    box.appendChild(foot);

    backdrop.appendChild(box);
    document.body.appendChild(backdrop);

    function onKey(e) {
      if (e.key === 'Escape') close();
    }
    document.addEventListener('keydown', onKey);

    function close() {
      document.removeEventListener('keydown', onKey);
      if (backdrop.parentNode) backdrop.parentNode.removeChild(backdrop);
    }

    backdrop.addEventListener('click', function (e) {
      if (e.target === backdrop) close();
    });

    return { close: close, body: body };
  }

  /** 确认框，返回 Promise<boolean> */
  function confirm(opts) {
    return new Promise(function (resolve) {
      modal({
        title: opts.title,
        body: opts.body,
        buttons: [
          { label: opts.cancelText || '取消', kind: 'ghost', onClick: function () { resolve(false); } },
          {
            label: opts.confirmText || '确定',
            kind: opts.danger ? 'outline' : 'primary',
            onClick: function () { resolve(true); }
          }
        ]
      });
    });
  }

  /* ------------------------------------------------------------------ *
   * 进度提示
   * ------------------------------------------------------------------ */

  function showProgress(text) {
    if (!progressEl) {
      progressEl = make('div', 'progress');
      progressEl.appendChild(make('div', 'progress-spinner'));
      progressEl.appendChild(make('span', 'progress-text'));
      document.body.appendChild(progressEl);
    }
    progressEl.querySelector('.progress-text').textContent = text || '处理中…';
    progressEl.hidden = false;
  }

  function hideProgress() {
    if (progressEl) progressEl.hidden = true;
  }

  /* ------------------------------------------------------------------ *
   * 轨迹列表
   * ------------------------------------------------------------------ */

  function renderList() {
    var list = Store.all();
    clear(el.trackList);

    el.trackCount.textContent = list.length ? list.length + ' 条' : '0 条';
    el.listEmpty.hidden = list.length > 0;

    for (var i = 0; i < list.length; i++) {
      el.trackList.appendChild(buildItem(list[i]));
    }
  }

  function buildItem(track) {
    var item = make('div', 'track-item');
    item.dataset.id = track.id;
    if (track.visible === false) item.classList.add('is-hidden');
    if (editingId === track.id) item.classList.add('is-selected');

    // 显隐勾选
    var chk = document.createElement('input');
    chk.type = 'checkbox';
    chk.checked = track.visible !== false;
    chk.title = chk.checked ? '隐藏这条轨迹' : '显示这条轨迹';
    chk.onclick = function (e) {
      e.stopPropagation();
      Store.update(track.id, { visible: chk.checked });
    };
    item.appendChild(chk);

    // 颜色圆点（同时充当图例）
    var sw = make('div', 'track-swatch');
    sw.style.background = track.color || '#888';
    item.appendChild(sw);

    var body = make('div', 'track-body');

    var name = make('div', 'track-name', track.name || '未命名');
    name.title = '双击可改名';
    name.ondblclick = function (e) {
      e.stopPropagation();
      startRename(track, name, item);
    };
    body.appendChild(name);

    body.appendChild(make('div', 'track-meta', metaLine(track)));
    item.appendChild(body);

    // 操作按钮
    var actions = make('div', 'track-actions');

    var zoom = make('button', 'track-action', '定位');
    zoom.type = 'button';
    zoom.title = '缩放到这条轨迹';
    zoom.onclick = function (e) {
      e.stopPropagation();
      if (global.App) global.App.focusTrack(track.id);
    };
    actions.appendChild(zoom);

    var del = make('button', 'track-action is-danger', '删除');
    del.type = 'button';
    del.title = '删除这条轨迹';
    del.onclick = function (e) {
      e.stopPropagation();
      if (global.App) global.App.requestDelete(track.id);
    };
    actions.appendChild(del);

    item.appendChild(actions);

    // 点整行 = 选中
    item.onclick = function () {
      if (global.App) global.App.selectTrack(track.id);
    };

    return item;
  }

  /** 列表里的一行摘要：日期 · 里程 · 时长 */
  function metaLine(track) {
    var F = global.Format;
    var s = track.stats || {};
    var parts = [];

    if (s.hasTime && s.startTime) parts.push(F.relativeDay(s.startTime));
    else parts.push(track.format ? track.format.toUpperCase() : '无时间');

    if (s.distance) parts.push(F.distance(s.distance, true));
    // 用移动时间，与统计面板的「骑行用时」保持一致
    if (s.movingTime) parts.push(F.duration(s.movingTime));

    return parts.join(' · ');
  }

  function startRename(track, nameEl, item) {
    editingId = track.id;
    var original = track.name || '';
    nameEl.contentEditable = 'true';
    nameEl.spellcheck = false;
    nameEl.focus();

    // 全选，用户直接打字即可覆盖
    try {
      var range = document.createRange();
      range.selectNodeContents(nameEl);
      var sel = global.getSelection();
      sel.removeAllRanges();
      sel.addRange(range);
    } catch (e) { /* 选区失败不影响改名 */ }

    function finish(commit) {
      nameEl.contentEditable = 'false';
      editingId = null;
      var next = (nameEl.textContent || '').trim();
      if (commit && next && next !== original) {
        Store.update(track.id, { name: next });
      } else {
        nameEl.textContent = original;
      }
    }

    nameEl.onkeydown = function (e) {
      if (e.key === 'Enter') { e.preventDefault(); finish(true); }
      else if (e.key === 'Escape') { e.preventDefault(); finish(false); }
      e.stopPropagation();
    };
    nameEl.onblur = function () { finish(true); };
  }

  function highlightSelection(id) {
    var items = el.trackList.querySelectorAll('.track-item');
    for (var i = 0; i < items.length; i++) {
      items[i].classList.toggle('is-selected', items[i].dataset.id === id);
    }
    // 选中项滚动到可见
    if (id) {
      var cur = el.trackList.querySelector('.track-item.is-selected');
      if (cur && cur.scrollIntoView) cur.scrollIntoView({ block: 'nearest' });
    }
  }

  /* ------------------------------------------------------------------ *
   * 统计面板
   * ------------------------------------------------------------------ */

  function renderStats(scopeTrack) {
    el.stats.innerHTML = '';
    var F = global.Format;

    if (scopeTrack) {
      el.statsScope.textContent = '单条轨迹';
      buildStatsInto(el.stats, singleTotals(scopeTrack), true);
      return;
    }

    var list = Store.visible();
    el.statsScope.textContent = list.length === Store.count() ? '全部轨迹' : '已显示 ' + list.length + ' 条';

    if (!list.length) {
      el.stats.appendChild(make('div', 'stats-empty', '还没有轨迹。导入后会在这里显示合计里程、爬升和用时。'));
      return;
    }
    buildStatsInto(el.stats, Store.totals(list), list.length > 1);
  }

  function singleTotals(track) {
    var s = track.stats || {};
    return {
      trackCount: 1,
      distance: s.distance || 0,
      elevationGain: s.elevationGain || 0,
      duration: s.duration || 0,
      movingTime: s.movingTime || 0,
      maxSpeed: s.maxSpeed || 0,
      hasTime: !!s.hasTime,
      hasElevation: !!s.hasElevation,
      avgSpeed: s.movingAvgSpeed || s.avgSpeed || 0
    };
  }

  function buildStatsInto(container, t, multi) {
    var F = global.Format;

    // 主角数字：总里程
    var hero = make('div', 'stat-hero');
    hero.appendChild(make('div', 'stat-hero-label', multi ? '合计骑行里程' : '骑行里程'));
    var hv = make('div', 'stat-hero-value');
    hv.appendChild(document.createTextNode(F.distanceValue(t.distance)));
    hv.appendChild(make('span', 'stat-hero-unit', '公里'));
    hero.appendChild(hv);
    container.appendChild(hero);

    var grid = make('div', 'stat-grid');

    // 均速：多条轨迹时用「总里程/总移动时间」，比各条均速再平均更准确
    var avg = t.avgSpeed;
    if (avg === undefined) {
      avg = (t.movingTime > 0) ? (t.distance / t.movingTime) : 0;
    }

    // 「骑行用时」用的是移动时间（movingTime），不是首末点的挂钟跨度。
    // 这一点是拿真实的华为导出文件比对出来的：设备在 <trk><extensions><totalTime>
    // 里报的就是不含休息的运动时长，与这里的 movingTime 误差在 2% 以内。
    // 如果显示挂钟跨度，用户一对比 App 就会觉得「多出来一大截」。
    // 没有海拔数据时显示「—」而不是 0。
    // 真实的华为导出文件里就没有海拔字段，显示「累计爬升 0 米」会让用户
    // 以为这趟骑行完全平坦 —— 那是错误信息，不是「没有信息」。
    var hasEle = t.hasElevation === true;

    var cells = [
      {
        label: '累计爬升',
        value: hasEle ? F.elevation(t.elevationGain) : '—',
        unit: hasEle ? '米' : '',
        hint: hasEle ? '' : '这条记录里没有海拔数据'
      },
      { label: '骑行用时', value: F.duration(t.movingTime), unit: '' },
      { label: multi ? '平均速度' : '骑行均速', value: F.speedValue(avg), unit: 'km/h' },
      { label: '最高速度', value: F.speedValue(t.maxSpeed), unit: 'km/h' },
      { label: '轨迹条数', value: String(t.trackCount), unit: '条' },
      { label: '总耗时', value: F.duration(t.duration), unit: '' }
    ];

    for (var i = 0; i < cells.length; i++) {
      var cell = make('div', 'stat-cell');
      if (cells[i].hint) cell.title = cells[i].hint;
      cell.appendChild(make('div', 'stat-label', cells[i].label));
      var v = make('div', 'stat-value', cells[i].value);
      if (cells[i].unit) v.appendChild(make('span', 'stat-unit', cells[i].unit));
      cell.appendChild(v);
      grid.appendChild(cell);
    }

    container.appendChild(grid);
  }

  /* ------------------------------------------------------------------ *
   * 存储状态徽标
   * ------------------------------------------------------------------ */

  function renderStorageBadge() {
    var b = Store.backend();
    var badge = el.storageBadge;

    if (b === 'indexeddb') {
      badge.textContent = '存储：大容量';
      badge.className = 'badge badge-ok';
      badge.title = '轨迹保存在浏览器的 IndexedDB 里，容量通常有数百 MB。';
      return;
    }
    if (b === 'localstorage') {
      badge.textContent = '存储：约 5MB';
      badge.className = 'badge badge-warn';
      badge.title = '当前页面用的是浏览器本地存储，容量约 5MB（大约能放 20~50 次骑行）。' +
        '存满时请先「导出备份」再清理旧轨迹。双击「启动本地服务器.bat」打开可以获得更大容量。';
      return;
    }
    badge.textContent = '存储：临时';
    badge.className = 'badge badge-warn';
    badge.title = '当前环境不允许保存数据，关闭页面后导入的轨迹会丢失。';
  }

  /** 后端能力不足以持久化时的常驻警告 */
  function warnIfEphemeral() {
    if (Store.backend() === 'memory') {
      notice('当前浏览器不允许这个页面保存数据，关闭后导入的轨迹会丢失。建议导入后立即点右上角「导出备份」。', {
        id: 'ephemeral', type: 'warn'
      });
    }
  }

  /* ------------------------------------------------------------------ *
   * 文件读取与解析
   * ------------------------------------------------------------------ */

  var TRACK_EXT = /\.(gpx|tcx|kml)$/i;

  /**
   * 把 FileList 复制成普通数组。
   *
   * 必须复制，不能直接持有 FileList —— 它是**活的**，与对应的 input 绑定：
   * 一旦对 input 执行 value = ''，这个 FileList 立刻变空。
   *
   * 这个坑踩过一次，症状是「选了文件但什么都没发生」：
   *   var files = input.files;   // 取到引用，此时 length 是 1
   *   input.value = '';          // 为了能重复选同一个文件而清空
   *   files.length               // 已经变成 0，于是后面的判断永远不成立
   * 清空 input 是必要的（否则再选同一个文件不触发 change），
   * 但顺序必须是「先复制、再清空」。
   */
  function toArray(fileList) {
    var out = [];
    if (!fileList) return out;
    for (var i = 0; i < fileList.length; i++) out.push(fileList[i]);
    return out;
  }

  /** 读文本。优先 file.text()，失败或指定编码时回退 FileReader。 */
  function readText(file, encoding) {
    if (file.text && !encoding) {
      return file.text().catch(function () { return readText(file, 'GBK'); });
    }
    return new Promise(function (resolve, reject) {
      var fr = new FileReader();
      fr.onload = function () { resolve(fr.result); };
      fr.onerror = function () { reject(fr.error || new Error('读取文件失败')); };
      try {
        fr.readAsText(file, encoding || 'UTF-8');
      } catch (e) {
        reject(e);
      }
    });
  }

  /**
   * 解析并导入一批文件。
   * 串行处理，每个文件之间让出主线程 —— 一次拖进几十个文件时界面不会假死。
   */
  function importFiles(files) {
    var list = [];
    for (var i = 0; i < files.length; i++) {
      var f = files[i];
      if (f.size === 0) continue;                  // 同步盘的占位文件
      if (!TRACK_EXT.test(f.name) && !/\.xml$/i.test(f.name) && f.type.indexOf('xml') < 0) {
        // 扩展名不像轨迹文件，但仍然尝试 —— 解析器是按 XML 根元素判格式的，
        // 用户把文件改过名也能识别。这里只是跳过明显无关的（图片、压缩包等）。
        if (!/\.(txt|json|gpx|tcx|kml|xml)$/i.test(f.name)) continue;
      }
      list.push(f);
    }

    if (!list.length) {
      notice('没有找到可解析的文件。支持的格式是 .gpx / .tcx / .kml。', { type: 'warn' });
      return Promise.resolve();
    }

    if (list.length > 500) {
      return confirm({
        title: '文件有点多',
        body: '一次导入了 ' + list.length + ' 个文件，解析可能需要较长时间。确定继续吗？',
        confirmText: '继续'
      }).then(function (ok) {
        if (!ok) return;
        return doImport(list);
      });
    }
    return doImport(list);
  }

  function doImport(list) {
    var okCount = 0, trackCount = 0, pointTotal = 0;
    var failures = [];
    var i = 0;

    showProgress('正在解析 1/' + list.length + '：' + list[0].name);

    function step() {
      if (i >= list.length) {
        hideProgress();
        reportImport(okCount, trackCount, pointTotal, failures);
        return Promise.resolve();
      }

      var file = list[i];
      showProgress('正在解析 ' + (i + 1) + '/' + list.length + '：' + file.name);

      return readText(file).catch(function () {
        return readText(file, 'GBK');   // 编码回退：少数老工具导出的是 GBK
      }).then(function (content) {
        var res;
        try {
          // 解析器对上层承诺永不抛异常，这里再兜一层以防万一
          res = global.Parsers.parseFileContent(content, file.name);
        } catch (e) {
          res = { ok: false, error: '解析出错：' + (e && e.message ? e.message : String(e)), tracks: [] };
        }

        if (res.ok && res.tracks.length) {
          var ctx = {
            fileName: file.name,
            relativePath: file.webkitRelativePath || file.name
          };
          var added = Store.add(res.tracks, ctx);
          okCount++;
          trackCount += added.length;
          for (var k = 0; k < added.length; k++) pointTotal += added[k].points.length;
        } else {
          failures.push({ name: file.webkitRelativePath || file.name, error: res.error || '未知原因' });
        }
      }).catch(function (e) {
        failures.push({ name: file.webkitRelativePath || file.name, error: (e && e.message) || '读取失败' });
      }).then(function () {
        i++;
        // 让出一帧，保证进度提示能刷新、界面不假死
        return new Promise(function (r) { setTimeout(r, 0); }).then(step);
      });
    }

    return step();
  }

  function reportImport(okCount, trackCount, pointTotal, failures) {
    var F = global.Format;

    if (okCount) {
      var msg = '已导入 ' + okCount + ' 个文件、' + trackCount + ' 条轨迹';
      if (pointTotal) msg += '（共 ' + F.count(pointTotal) + ' 个轨迹点）';
      notice(msg + '。', {
        type: failures.length ? 'warn' : 'ok',
        id: 'import',
        timeout: failures.length ? 0 : 4000
      });
    }

    if (failures.length) {
      var items = [];
      var shown = Math.min(failures.length, 8);
      for (var i = 0; i < shown; i++) {
        items.push(failures[i].name + ' —— ' + failures[i].error);
      }
      if (failures.length > shown) items.push('……另有 ' + (failures.length - shown) + ' 个文件失败');

      noticeList(okCount ? '以下文件没能导入：' : '这些文件都没能导入：', items, {
        id: 'import-fail',
        type: 'error',
        actions: [{ label: '知道了', onClick: function () {} }]
      });
    }
  }

  /* ------------------------------------------------------------------ *
   * 拖放
   * ------------------------------------------------------------------ */

  function bindDropzone() {
    var dz = el.dropzone;

    // 必须在 window 上全局拦掉 dragover / drop，
    // 否则用户不小心把文件丢到页面空白处，浏览器会直接导航到那个文件，当前状态全丢
    global.addEventListener('dragover', function (e) { e.preventDefault(); }, false);
    global.addEventListener('drop', function (e) { e.preventDefault(); }, false);

    var depth = 0;   // dragenter/dragleave 会随子元素冒泡，用计数避免闪烁

    dz.addEventListener('dragenter', function (e) {
      e.preventDefault();
      depth++;
      dz.classList.add('is-over');
    });
    dz.addEventListener('dragleave', function (e) {
      e.preventDefault();
      depth = Math.max(0, depth - 1);
      if (!depth) dz.classList.remove('is-over');
    });
    dz.addEventListener('dragover', function (e) {
      e.preventDefault();
      e.dataTransfer.dropEffect = 'copy';
    });
    dz.addEventListener('drop', function (e) {
      e.preventDefault();
      depth = 0;
      dz.classList.remove('is-over');
      var files = e.dataTransfer && e.dataTransfer.files;
      if (files && files.length) {
        importFiles(files).then(afterImport);
      }
    });
  }

  function afterImport() {
    if (global.App) global.App.afterImport();
  }

  /* ------------------------------------------------------------------ *
   * 初始化
   * ------------------------------------------------------------------ */

  function init(store) {
    Store = store;

    el = {
      noticeArea: $('notice-area'),
      dropzone: $('dropzone'),
      trackList: $('track-list'),
      trackCount: $('track-count'),
      listEmpty: $('list-empty'),
      stats: $('stats'),
      statsScope: $('stats-scope'),
      storageBadge: $('storage-badge'),
      fileInput: $('file-input'),
      dirInput: $('dir-input'),
      jsonInput: $('json-input'),
      btnBrowse: $('btn-browse'),
      btnBrowseDir: $('btn-browse-dir'),
      btnImport: $('btn-import')
    };

    bindDropzone();

    // 选择文件。两个入口共用一个 input。
    function pickFiles() { el.fileInput.click(); }
    el.btnBrowse.onclick = pickFiles;
    el.btnImport.onclick = pickFiles;

    el.fileInput.onchange = function () {
      // 顺序要紧：先复制成普通数组，再清空 input。
      // 清空是为了让用户第二次选同一个文件也能触发 change 事件。
      var files = toArray(el.fileInput.files);
      el.fileInput.value = '';
      if (files.length) importFiles(files).then(afterImport);
    };

    // 选择整个文件夹（webkitdirectory 只有带前缀的写法）。
    // 它和普通文件选择互斥 —— 一个 input 不能既选文件又选文件夹，所以用两个 input。
    var supportsDir = ('webkitdirectory' in document.createElement('input')) ||
                      ('directory' in document.createElement('input'));
    if (supportsDir) {
      el.btnBrowseDir.hidden = false;
      el.btnBrowseDir.onclick = function () { el.dirInput.click(); };
      el.dirInput.onchange = function () {
        // 同上：先复制再清空
        var files = toArray(el.dirInput.files);
        el.dirInput.value = '';
        if (files.length) importFiles(files).then(afterImport);
      };
    }

    // 事件驱动重绘：数据一变就刷新界面，界面从不主动去改数据
    Store.on('change', function (payload) {
      renderList();
      if (payload && payload.type === 'added' && payload.tracks && payload.tracks.length === 1) {
        // 只加了一条时，统计跟着切到这条
      }
    });
    Store.on('loaded', function () { renderList(); });

    Store.on('saveError', function (p) {
      var err = p && p.error;
      if (err && err.code === 'QUOTA') {
        notice('本地存储空间已满，新的改动没能保存。建议先「导出备份」，再删除一些旧轨迹。', {
          id: 'quota', type: 'error',
          actions: [{
            label: '导出备份',
            onClick: function () { if (global.App) global.App.exportBackup(); }
          }]
        });
      } else {
        notice('保存失败：' + ((err && err.message) || '未知原因'), { id: 'save-err', type: 'error' });
      }
    });

    renderStorageBadge();
    // 注意：warnIfEphemeral() 不能在这里调用 —— 此刻存储后端还没探测出来，
    // Store.getBackend() 还是默认值 'memory'，会误报「无法保存数据」。
    // 它由 app.js 在 TracksStore.init() 完成之后调用。
  }

  global.UI = {
    init: init,
    renderList: renderList,
    renderStats: renderStats,
    renderStorageBadge: renderStorageBadge,
    warnIfEphemeral: warnIfEphemeral,
    highlightSelection: highlightSelection,
    notice: notice,
    noticeList: noticeList,
    modal: modal,
    confirm: confirm,
    showProgress: showProgress,
    hideProgress: hideProgress,
    importFiles: importFiles
  };
})(window);
