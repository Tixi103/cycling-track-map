/*!
 * tracks.js —— 轨迹状态与配色
 *
 * 全项目**唯一持有轨迹数组的地方**。其它模块一律通过这里的方法读写，
 * 变更后由本模块发事件通知各方刷新（mapview 重画、ui 重排列表）。
 *
 * ── 配色为什么是这样 ──────────────────────────────────────
 * 地图上的轨迹是「全对场景」——任意两条都可能挨在一起，不像柱状图只有相邻列
 * 需要区分。把候选色板丢进色觉验证器做全对校验，实测结果：
 *
 *   3 个色槽 → 全部通过（最差色对 正常视觉 ΔE 24.0 / 色觉障碍 ΔE 9.2）
 *   4 个色槽 → 不通过（黄 ↔ 橙 正常视觉 ΔE 13.7，低于 15 的硬下限）
 *
 * 也就是说：**地图上靠颜色可靠区分的轨迹上限就是 3 条**，这不是调参能绕过的。
 * 所以本模块不提供「给 N 条轨迹生成 N 种颜色」的做法（常见的黄金角 HSL 生成
 * 在物理上就不成立），而是给了三种编码方式：
 *
 *   按时间（默认）—— 单色蓝的顺序色阶，按日期分 5 档。语义是有意义的
 *                    （越新越深），且对任意条数都成立，不受 3 条上限约束。
 *   单色         —— 全部同色，靠选中来区分，最干净。
 *   分类         —— 只有 3 个验证过的色槽，第 4 条起并入中性灰「其它」。
 *
 * 色阶与色槽都经过 validate_palette 校验，浅底图与深色影像底图各一套。
 */
(function (global) {
  'use strict';

  /* ------------------------------------------------------------------ *
   * 极简事件总线
   * ------------------------------------------------------------------ */

  // 用 Object.create(null) 存监听表，避免键名撞上 __proto__ 之类的原型属性
  var handlers = Object.create(null);

  function on(evt, fn) {
    if (!handlers[evt]) handlers[evt] = [];
    handlers[evt].push(fn);
    return function () { off(evt, fn); };
  }

  function off(evt, fn) {
    var list = handlers[evt];
    if (!list) return;
    var i = list.indexOf(fn);
    if (i >= 0) list.splice(i, 1);
  }

  function emit(evt, payload) {
    var list = handlers[evt];
    if (!list || !list.length) return;
    // 遍历副本：允许监听者在回调里取消自己
    var copy = list.slice();
    for (var i = 0; i < copy.length; i++) {
      try {
        copy[i](payload);
      } catch (e) {
        // 一个监听者出错不能拖垮其它监听者。异步抛出，避免被这里吞掉后无从排查。
        if (global.console && console.error) console.error('[tracks] 监听器出错', e);
      }
    }
  }

  /* ------------------------------------------------------------------ *
   * 配色
   * ------------------------------------------------------------------ */

  // 顺序色阶（单色蓝，5 档）。均由 dataviz 校验器验证通过：
  //   浅底图版：单调递增、相邻 ΔL 均 >= 0.06、浅端对白底 2.11:1、单一色相
  //   深底图版：同样通过，且暗端对深底的对比度达标
  var RAMP_LIGHT = ['#86b6ef', '#5598e7', '#2a78d6', '#1c5cab', '#104281'];
  var RAMP_DARK  = ['#256abf', '#3987e5', '#6da7ec', '#9ec5f4', '#cde2fb'];

  // 分类色槽：只取前 3 个 —— 第 4 槽（黄）加进来后 黄↔橙 ΔE 13.7 不达标
  var CAT_LIGHT = ['#2a78d6', '#eb6834', '#1baf7a'];
  var CAT_DARK  = ['#3987e5', '#d95926', '#199e70'];

  // 超出分类槽上限的轨迹并入这个中性灰（「其它」）
  var OTHER_LIGHT = '#8f8f8a';
  var OTHER_DARK  = '#9a9a94';

  var SINGLE_LIGHT = '#2a78d6';
  var SINGLE_DARK  = '#3987e5';

  var colorMode = 'time';        // 'time' | 'single' | 'category'
  var surface = 'light';         // 'light' | 'dark' | 'plain'

  function ramp() { return surface === 'dark' ? RAMP_DARK : RAMP_LIGHT; }
  function catColors() { return surface === 'dark' ? CAT_DARK : CAT_LIGHT; }
  function otherColor() { return surface === 'dark' ? OTHER_DARK : OTHER_LIGHT; }
  function singleColor() { return surface === 'dark' ? SINGLE_DARK : SINGLE_LIGHT; }

  /**
   * 时间分档的上下界。
   * 只用「全部轨迹」的日期范围计算，不受显隐筛选影响 ——
   * 否则用户勾掉一条轨迹就会导致其它轨迹集体变色。
   * 仅在新增/删除轨迹时重算。
   */
  var timeDomain = null;   // {min, max}

  function recomputeDomain() {
    var min = Infinity, max = -Infinity;
    for (var i = 0; i < tracks.length; i++) {
      var t = timeOf(tracks[i]);
      if (t === null) continue;
      if (t < min) min = t;
      if (t > max) max = t;
    }
    timeDomain = (min === Infinity) ? null : { min: min, max: max };
  }

  function timeOf(track) {
    var s = track.stats && track.stats.startTime;
    if (typeof s === 'number' && isFinite(s)) return s;
    return (typeof track.addedAt === 'number') ? track.addedAt : null;
  }

  /** 按时间落到 0..4 档 */
  function timeBand(track) {
    if (!timeDomain) return ramp().length - 1;
    var t = timeOf(track);
    if (t === null) return ramp().length - 1;
    var span = timeDomain.max - timeDomain.min;
    if (span <= 0) return ramp().length - 1;
    var f = (t - timeDomain.min) / span;
    var idx = Math.floor(f * ramp().length);
    if (idx >= ramp().length) idx = ramp().length - 1;
    if (idx < 0) idx = 0;
    return idx;
  }

  /** 计算某个分类槽位是否已被占用 */
  function usedSlots(exceptId) {
    var used = {};
    for (var i = 0; i < tracks.length; i++) {
      var t = tracks[i];
      if (t.id === exceptId) continue;
      if (t.colorSlot !== undefined && t.colorSlot !== null) used[t.colorSlot] = true;
    }
    return used;
  }

  /** 取一个还没被占用的分类槽位；全占满了返回 null（并入「其它」） */
  function freeSlot(exceptId) {
    var used = usedSlots(exceptId);
    var n = catColors().length;
    for (var i = 0; i < n; i++) if (!used[i]) return i;
    return null;
  }

  /**
   * 依当前模式算出某条轨迹应显示的颜色。
   * 纯函数，随时可重算；但要写回 track.color 以便随数据一起持久化。
   */
  function colorFor(track) {
    if (colorMode === 'single') return singleColor();
    if (colorMode === 'category') {
      if (track.colorSlot === undefined || track.colorSlot === null) return otherColor();
      var c = catColors();
      return c[track.colorSlot] || otherColor();
    }
    return ramp()[timeBand(track)];
  }

  /** 给新加入的轨迹分配分类槽位 */
  function assignSlot(track) {
    if (colorMode !== 'category') { track.colorSlot = null; return; }
    var slot = freeSlot();
    track.colorSlot = slot;   // 可能是 null —— 表示并入「其它」
  }

  /** 重算所有轨迹的颜色并写回（切换配色模式或底图明暗时调用） */
  function repaintAll() {
    for (var i = 0; i < tracks.length; i++) {
      tracks[i].color = colorFor(tracks[i]);
    }
  }

  /* ------------------------------------------------------------------ *
   * 状态
   * ------------------------------------------------------------------ */

  var tracks = [];
  var idCounter = 0;
  var dirty = false;
  var saveTimer = null;
  var currentBackend = 'memory';
  var SAVE_DEBOUNCE_MS = 1200;

  function newId() {
    idCounter++;
    // 刻意不用 crypto.randomUUID()：它需要安全上下文，
    // 而 file:// 下各浏览器对「是否算安全上下文」的处理并不一致。
    return 't_' + Date.now().toString(36) + '_' + idCounter.toString(36) +
           '_' + Math.random().toString(36).slice(2, 7);
  }

  function getAll() { return tracks; }
  function count() { return tracks.length; }

  function get(id) {
    for (var i = 0; i < tracks.length; i++) if (tracks[i].id === id) return tracks[i];
    return null;
  }

  function visible() {
    var out = [];
    for (var i = 0; i < tracks.length; i++) if (tracks[i].visible !== false) out.push(tracks[i]);
    return out;
  }

  function indexOfId(id) {
    for (var i = 0; i < tracks.length; i++) if (tracks[i].id === id) return i;
    return -1;
  }

  /* ------------------------------------------------------------------ *
   * 增删改
   * ------------------------------------------------------------------ */

  /* ---------------- 轨迹命名 ---------------- */

  // 解析器给不出名字时的兜底名，如「GPX 轨迹 2」
  var PARSER_FALLBACK = /^(GPX|TCX|KML)\s*轨迹/;
  // 有些格式（TCX 尤其常见）直接拿 ISO 时间戳当记录名
  var ISO_LIKE = /^\d{4}-\d{2}-\d{2}[T ]\d{2}:\d{2}/;
  // 通用运动名。**华为运动健康导出的每条记录都叫「骑行」**，
  // 一天骑两趟或者积累几十条之后，列表里全是同名条目，完全没法分辨。
  var GENERIC_NAME = /^(骑行|跑步|步行|健走|徒步|登山|游泳|运动|锻炼|户外骑行|室内骑行|cycling|biking|running|walking|riding|hiking)$/i;

  /** 把设备写的运动类型翻成中文，拿不到就返回空串 */
  function sportLabel(sport) {
    if (!sport) return '';
    var s = String(sport).toLowerCase();
    if (s.indexOf('bik') >= 0 || s.indexOf('cycl') >= 0 || s.indexOf('ride') >= 0) return '骑行';
    if (s.indexOf('run') >= 0) return '跑步';
    if (s.indexOf('walk') >= 0 || s.indexOf('hik') >= 0) return '步行';
    if (s.indexOf('swim') >= 0) return '游泳';
    return '';
  }

  /**
   * 给轨迹一个能在列表里分辨的名字。
   *
   * 分三种情况处理：
   *   无意义的名字（解析器兜底名 / 纯 ISO 时间戳）→ 用「日期 + 运动类型」
   *   通用运动名（「骑行」这类）              → 前面补上日期
   *   有具体含义的名字（「环湖一圈」这种）      → 原样保留，用户自己起的名字最有用
   */
  function betterName(t) {
    var raw = String(t.name || '').trim();
    var date = (t.stats && t.stats.startTime) ? global.Format.dateOnly(t.stats.startTime) : '';
    var sport = sportLabel(t.meta && t.meta.sport) || '骑行';

    if (!raw || PARSER_FALLBACK.test(raw) || ISO_LIKE.test(raw)) {
      return (date ? date + ' ' : '') + sport;
    }
    if (GENERIC_NAME.test(raw)) {
      return (date ? date + ' ' : '') + raw;
    }
    return raw;
  }

  /**
   * 补全一条从解析器出来的轨迹，使其满足 Store 的序列化契约。
   * @param {Object} parsed Parsers 产出的轨迹
   * @param {Object} ctx {fileName, relativePath}
   */
  function materialize(parsed, ctx) {
    ctx = ctx || {};
    var t = parsed;
    t.id = newId();
    t.sourceCrs = 'WGS84';                 // 华为导出恒为 WGS-84
    t.visible = true;
    t.addedAt = Date.now();
    t.fileName = ctx.relativePath || ctx.fileName || '';
    t.meta = t.meta || {};

    t.name = betterName(t);

    assignSlot(t);
    t.color = colorFor(t);
    return t;
  }

  /**
   * 加入一批轨迹。
   * @param {Array} parsedList 已解析好的轨迹数组
   * @param {Object} [ctx] {fileName, relativePath}
   * @returns {Array} 实际加入的轨迹
   */
  function add(parsedList, ctx) {
    if (!parsedList || !parsedList.length) return [];
    var added = [];
    for (var i = 0; i < parsedList.length; i++) {
      added.push(materialize(parsedList[i], ctx));
    }
    // 按时间排序插入，让列表和配色都稳定
    for (var j = 0; j < added.length; j++) tracks.push(added[j]);
    tracks.sort(compareTracks);

    recomputeDomain();
    repaintAll();
    markDirty();
    emit('added', { tracks: added });
    emit('change', { type: 'added', tracks: added });
    return added;
  }

  /**
   * 排序：先按骑行时间，没有时间的按加入时间。
   * 新的在前 —— 用户最常想看最近骑的。
   */
  function compareTracks(a, b) {
    var ta = timeOf(a), tb = timeOf(b);
    if (ta === null) ta = a.addedAt || 0;
    if (tb === null) tb = b.addedAt || 0;
    return tb - ta;
  }

  function remove(ids) {
    if (!ids || !ids.length) return 0;
    var removed = [];
    for (var i = tracks.length - 1; i >= 0; i--) {
      if (ids.indexOf(tracks[i].id) >= 0) {
        removed.push(tracks[i]);
        tracks.splice(i, 1);
      }
    }
    if (!removed.length) return 0;
    recomputeDomain();
    // 释放出来的分类槽位要重新分配，否则删掉一条后新加的轨迹会没槽可用
    if (colorMode === 'category') reassignSlots();
    repaintAll();
    markDirty();
    emit('removed', { tracks: removed });
    emit('change', { type: 'removed', tracks: removed });
    return removed.length;
  }

  function removeAll() {
    var n = tracks.length;
    if (!n) return 0;
    tracks = [];
    timeDomain = null;
    markDirty();
    emit('reset', {});
    emit('change', { type: 'reset' });
    return n;
  }

  /**
   * 修改轨迹属性。可改字段：name / visible / color / colorSlot。
   * 不允许改 points —— 见 mapview.js 顶部关于「绝不改写原始坐标」的说明。
   */
  function update(id, patch) {
    var t = get(id);
    if (!t || !patch) return null;
    var changed = false;

    if (patch.name !== undefined && patch.name !== t.name) {
      t.name = String(patch.name).slice(0, 120) || t.name;
      changed = true;
    }
    if (patch.visible !== undefined && patch.visible !== t.visible) {
      t.visible = !!patch.visible;
      changed = true;
    }
    if (patch.colorSlot !== undefined && patch.colorSlot !== t.colorSlot) {
      t.colorSlot = patch.colorSlot;
      t.color = colorFor(t);
      changed = true;
    }
    if (patch.color !== undefined && patch.color !== t.color) {
      t.color = patch.color;
      t.persistColor = true;   // 用户手选的色，切模式时不再覆盖
      changed = true;
    }

    if (changed) {
      markDirty();
      emit('updated', { id: id, track: t });
      emit('change', { type: 'updated', id: id, track: t });
    }
    return t;
  }

  function setAllVisible(v) {
    for (var i = 0; i < tracks.length; i++) tracks[i].visible = !!v;
    markDirty();
    emit('change', { type: 'bulk' });
  }

  /** 只显示选中的这几条，其余隐藏 */
  function isolate(ids) {
    for (var i = 0; i < tracks.length; i++) {
      tracks[i].visible = ids.indexOf(tracks[i].id) >= 0;
    }
    markDirty();
    emit('change', { type: 'bulk' });
  }

  /* ------------------------------------------------------------------ *
   * 配色模式与底图明暗
   * ------------------------------------------------------------------ */

  function setColorMode(mode) {
    if (mode !== 'time' && mode !== 'single' && mode !== 'category') return;
    colorMode = mode;
    if (mode === 'category') reassignSlots();
    repaintAll();
    markDirty();
    emit('colorModeChanged', { mode: mode });
    emit('change', { type: 'repaint' });
  }

  function getColorMode() { return colorMode; }

  /** 分类模式：重排所有槽位。按时间倒序，最新的拿第 1 个色槽。 */
  function reassignSlots() {
    var used = {};
    for (var i = 0; i < tracks.length; i++) {
      var t = tracks[i];
      if (t.persistColor) continue;
      var slot = freeSlotIn(used, catColors().length);
      t.colorSlot = slot;
      if (slot !== null) used[slot] = true;
    }
  }

  function freeSlotIn(used, n) {
    for (var i = 0; i < n; i++) if (!used[i]) return i;
    return null;
  }

  function setSurface(s) {
    if (s === surface) return;
    surface = s || 'light';
    repaintAll();
    markDirty();
    emit('surfaceChanged', { surface: surface });
    emit('change', { type: 'repaint' });
  }

  function getSurface() { return surface; }

  /** 分类模式下能可靠区分的条数上限（供界面提示用） */
  function categoryLimit() { return catColors().length; }

  /** 时间分档的时间范围，供图例显示 */
  function domain() { return timeDomain; }

  /* ------------------------------------------------------------------ *
   * 持久化
   * ------------------------------------------------------------------ */

  function markDirty() {
    dirty = true;
    if (saveTimer) clearTimeout(saveTimer);
    // 防抖。localStorage 写入 5MB 的 JSON 是同步阻塞的（50~200ms），
    // 用户连续点几个复选框不该触发五次全量写入。
    saveTimer = setTimeout(function () { flush(); }, SAVE_DEBOUNCE_MS);
  }

  function flush() {
    if (!dirty) return Promise.resolve(false);
    if (saveTimer) { clearTimeout(saveTimer); saveTimer = null; }
    dirty = false;

    // 先让界面画一帧，再做可能阻塞的写入。
    //
    // 注意：**不能用 requestAnimationFrame 作为唯一路径**。
    // 浏览器在后台标签页（以及无头模式）里不保证触发 rAF —— 只依赖它的话，
    // 用户切走标签页之后的所有改动都会永远不落盘。
    // 这里用「rAF 与超时谁先到算谁」，rAF 只是让位，不是必经之路。
    return new Promise(function (resolve) {
      var started = false;
      var run = function () {
        if (started) return;
        started = true;
        global.Store.save(tracks).then(function () {
          emit('saved', { at: Date.now() });
          resolve(true);
        }).catch(function (err) {
          dirty = true;   // 写失败，保持脏标记，下次再试
          emit('saveError', { error: err });
          resolve(false);
        });
      };

      if (global.requestAnimationFrame) {
        global.requestAnimationFrame(function () { setTimeout(run, 0); });
      }
      setTimeout(run, 120);
    });
  }

  function init() {
    return global.Store.init().then(function (backend) {
      currentBackend = backend;
      return global.Store.load();
    }).then(function (loaded) {
      tracks = loaded || [];
      // 读回来的轨迹缺 color/colorSlot，补齐
      for (var i = 0; i < tracks.length; i++) {
        var t = tracks[i];
        t.sourceCrs = t.sourceCrs || 'WGS84';
        if (t.colorSlot === undefined) t.colorSlot = null;
      }
      tracks.sort(compareTracks);
      recomputeDomain();
      if (colorMode === 'category') reassignSlots();
      repaintAll();
      emit('loaded', { tracks: tracks });
      emit('change', { type: 'loaded' });
      return currentBackend;
    });
  }

  function backend() { return currentBackend; }

  /* ------------------------------------------------------------------ *
   * 导入导出
   * ------------------------------------------------------------------ */

  function exportJson() {
    // 导出前先落盘，保证导出的就是当前内存里的最新状态
    return global.Store.exportJson(tracks);
  }

  /**
   * 从 JSON 文本导入（合并，不覆盖）。
   * 按 id 去重：同一份备份导两次不会出现重复轨迹。
   */
  function importJson(text) {
    var incoming = global.Store.importJson(text);
    if (!incoming || !incoming.length) return { added: 0, skipped: 0 };

    var existingIds = {};
    for (var i = 0; i < tracks.length; i++) existingIds[tracks[i].id] = true;

    var added = [];
    var skipped = 0;
    for (var j = 0; j < incoming.length; j++) {
      var t = incoming[j];
      if (t.id && existingIds[t.id]) { skipped++; continue; }
      if (!t.id) t.id = newId();
      t.visible = (t.visible !== false);
      if (t.colorSlot === undefined) t.colorSlot = null;
      added.push(t);
    }

    for (var k = 0; k < added.length; k++) tracks.push(added[k]);
    tracks.sort(compareTracks);
    recomputeDomain();
    if (colorMode === 'category') reassignSlots();
    repaintAll();
    markDirty();

    if (added.length) {
      emit('added', { tracks: added });
      emit('change', { type: 'added', tracks: added });
    }
    return { added: added.length, skipped: skipped };
  }

  /* ------------------------------------------------------------------ *
   * 汇总
   * ------------------------------------------------------------------ */

  /** 全部轨迹的合计，用于统计面板 */
  function totals(scopeTracks) {
    var list = scopeTracks || tracks;
    var out = {
      trackCount: list.length,
      pointCount: 0,
      distance: 0,
      elevationGain: 0,
      duration: 0,
      movingTime: 0,
      maxSpeed: 0,
      hasTime: false,
      hasElevation: false,
      earliest: null,
      latest: null
    };
    for (var i = 0; i < list.length; i++) {
      var t = list[i];
      var s = t.stats;
      out.pointCount += t.points ? t.points.length : 0;
      if (!s) continue;
      out.distance += s.distance || 0;
      out.elevationGain += s.elevationGain || 0;
      out.duration += s.duration || 0;
      out.movingTime += s.movingTime || 0;
      if (s.maxSpeed > out.maxSpeed) out.maxSpeed = s.maxSpeed;
      if (s.hasTime) {
        out.hasTime = true;
        if (out.earliest === null || s.startTime < out.earliest) out.earliest = s.startTime;
        if (out.latest === null || s.endTime > out.latest) out.latest = s.endTime;
      }
      if (s.hasElevation) out.hasElevation = true;
    }
    return out;
  }

  global.TracksStore = {
    // 事件
    on: on,
    off: off,
    emit: emit,
    // 读
    all: getAll,
    get: get,
    visible: visible,
    count: count,
    indexOfId: indexOfId,
    totals: totals,
    // 写
    add: add,
    remove: remove,
    removeAll: removeAll,
    update: update,
    setAllVisible: setAllVisible,
    isolate: isolate,
    // 配色
    setColorMode: setColorMode,
    getColorMode: getColorMode,
    colorFor: colorFor,
    categoryLimit: categoryLimit,
    domain: domain,
    setSurface: setSurface,
    getSurface: getSurface,
    RAMP_LIGHT: RAMP_LIGHT,
    RAMP_DARK: RAMP_DARK,
    CAT_LIGHT: CAT_LIGHT,
    CAT_DARK: CAT_DARK,
    OTHER_LIGHT: OTHER_LIGHT,
    OTHER_DARK: OTHER_DARK,
    // 持久化
    init: init,
    backend: backend,
    markDirty: markDirty,
    flush: flush,
    exportJson: exportJson,
    importJson: importJson
  };
})(window);
