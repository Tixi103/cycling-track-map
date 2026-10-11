/*!
 * mapview.js —— 地图渲染层
 *
 * 本文件是整个项目**唯一直接操作 L.* 的地方**。其它模块一律通过这里的接口
 * 与地图打交道，这样以后想换渲染方案（比如换成 MapLibre）只需要动这一个文件。
 *
 * ── 渲染管线 ─────────────────────────────────────────────
 *   原始点（WGS-84）
 *     → Geo.simplify(seg, 容差米)      按米制抽稀，保留形状
 *     → projectSeg(...)                按当前底图坐标系纠偏（GCJ-02 或原样）
 *     → L.polyline(parts)              parts 是「多段数组」，段与段之间不连线
 *
 * 几个关键设计：
 *
 * 1. **绝不改写 track.points**。轨迹永远以 WGS-84 原始坐标存放，
 *    GCJ-02 只存在于渲染出来的坐标副本里。一旦把纠偏后的坐标写回 points，
 *    切回 OSM 底图时会二次偏移 500 米以上，且无法撤销。
 *
 * 2. **投影结果按坐标系缓存**（track._render）。来回切底图不重复计算，
 *    高德↔OSM 来回切十次和切一次的开销相同。
 *
 * 3. **双 Canvas 分层**。默认 pane 上所有轨迹共用一个 canvas，选中的轨迹
 *    画在单独的 focusPane 上。这样「选中一条」不会触发其余轨迹所在 canvas 重绘。
 *    对比做法 bringToFront() 会重排绘制顺序并要求 canvas 重绘 —— 密集区域
 *    等于全量重绘一次，几百条轨迹时会明显卡顿。
 *
 * 4. **命中测试交给 Leaflet，但只在轨迹数不多时开启**。Leaflet 的 Canvas
 *    命中测试是逐段几何距离计算，且发生在 mousemove 上 —— 几十条轨迹时开销可忽略，
 *    几百条时会拖慢鼠标。超过阈值就整体关掉交互，改由列表选中，
 *    这比「点了没反应」和「鼠标发飘」都好。
 */
(function (global) {
  'use strict';

  /* ---------------- 内部状态 ---------------- */

  var map = null;
  var tileLayer = null;
  var currentBasemap = null;
  var currentCrs = 'WGS84';

  var baseRenderer = null;    // 默认 pane：全部未选中的轨迹
  var focusRenderer = null;   // focusPane：选中的轨迹（单独 canvas，互不干扰）

  var layersById = {};        // trackId -> L.Polyline
  var haloLayer = null;       // 选中轨迹底部的深色描边
  var cueMarker = null;       // 剖面图联动的游标

  var selectedId = null;
  var tolerance = 3;          // 抽稀容差（米）
  var interactive = true;     // 当前图层是否可点击/悬浮

  var replayMarker = null;    // 回放时的骑行者圆点
  var gradientLayers = [];    // 按速度渐变着色时产生的多条折线
  var gradientOn = false;
  var heatLayer = null;       // 热力图网格层
  var heatOn = false;
  var heatGrid = null;        // 预计算的密度网格
  var fitTimer = null;
  var pendingFitBounds = null;
  var pendingFitOpts = null;
  var resizeObserver = null;
  var resizePending = false;

  /** 超过这个数量的可见轨迹就关闭地图上的交互，避免鼠标移动被命中测试拖慢 */
  var INTERACTIVE_LIMIT = 60;

  var COLORS = {
    dimmed: '#8f8f8a',
    halo: '#12100e'
  };

  /* ---------------- 坐标投影 ---------------- */

  /**
   * 把一段点投影到目标坐标系，并带上原点的引用。
   *
   * 这里没有直接用 Coord.convertPoints，原因是它按白名单重建对象，
   * 会丢掉我们需要的附加信息。这里复用 Coord 的转换函数本身，
   * 但自行构造对象，顺便把原始点的引用一并带上 ——
   * 这样鼠标悬浮到某个显示点时要查它的心率/海拔/时间，直接取即可，无需反查下标。
   *
   * @param {Array} seg 原始点数组（抽稀后）
   * @param {string} crs 'WGS84' | 'GCJ02'
   * @param {boolean} skipConvert 整条轨迹都在境外时可跳过计算
   * @returns {Array} [{lat, lon, src}]
   */
  function projectSeg(seg, crs, skipConvert) {
    var out = new Array(seg.length);
    var i, p;

    if (crs !== 'GCJ02' || skipConvert) {
      for (i = 0; i < seg.length; i++) {
        p = seg[i];
        out[i] = { lat: p.lat, lon: p.lon, src: p };
      }
      return out;
    }

    for (i = 0; i < seg.length; i++) {
      p = seg[i];
      var c = global.Coord.wgs84ToGcj02(p.lon, p.lat);
      out[i] = { lat: c[1], lon: c[0], src: p };
    }
    return out;
  }

  /**
   * 判断一条轨迹是否完全在中国境外 —— 境外则高德底图也不会偏移，可跳过转换。
   * 注意 Coord.outOfChina 的参数顺序是 (经度, 纬度)，很容易写反。
   */
  function entirelyOutOfChina(b) {
    if (!b) return false;
    var C = global.Coord;
    return C.outOfChina(b[0][1], b[0][0]) && C.outOfChina(b[1][1], b[1][0]);
  }

  /* ---------------- 抽稀与缓存 ---------------- */

  /**
   * 用二分查询取出抽稀后每个点在原段中的下标。
   * Geo.simplify 返回的是原数组元素的引用且保持先后顺序，
   * 所以用游标线性推进即可，整体 O(n)。
   */
  function indexMap(seg, simp) {
    var out = new Array(simp.length);
    var idx = 0;
    for (var i = 0; i < simp.length; i++) {
      while (idx < seg.length && seg[idx] !== simp[i]) idx++;
      out[i] = idx;
    }
    return out;
  }

  /**
   * 计算绘制所需的全部段。结果缓存在 track._render。
   *
   * 缓存键同时包含坐标系与抽稀容差 —— 两者任一变化都必须重算。
   * 顺便记下每段的原始下标，供剖面图与游标定位使用。
   */
  function partsOf(track, force) {
    var cache = track._render;
    if (!force && cache && cache.crs === currentCrs && cache.tol === tolerance) {
      return cache.parts;
    }

    var segs = (track.segments && track.segments.length) ? track.segments : [track.points];
    var bbox = global.Geo.bounds(track.points);
    var skip = entirelyOutOfChina(bbox);

    var parts = [];
    var indexParts = [];

    for (var s = 0; s < segs.length; s++) {
      var seg = segs[s];
      if (!seg || seg.length < 2) continue;

      var simp = global.Geo.simplify(seg, tolerance);
      if (simp.length < 2) continue;

      var im = indexMap(seg, simp);
      parts.push(projectSeg(simp, currentCrs, skip));
      indexParts.push({ seg: s, idx: im });
    }

    track._render = {
      crs: currentCrs,
      tol: tolerance,
      parts: parts,
      indexParts: indexParts,
      bbox: bbox
    };
    return parts;
  }

  /** 清空某条轨迹的投影缓存 */
  function invalidate(track) {
    if (track) track._render = null;
  }

  function invalidateAll(tracks) {
    for (var i = 0; i < tracks.length; i++) invalidate(tracks[i]);
  }

  /* ---------------- 样式 ---------------- */

  function styleFor(track, isSelected) {
    var anySelected = selectedId !== null;

    if (isSelected) {
      return { color: track.color, weight: 6, opacity: 1, lineCap: 'round', lineJoin: 'round' };
    }
    if (anySelected) {
      // 有选中项时其余轨迹整体降为灰色 —— 这比再加一种颜色有效得多
      return { color: COLORS.dimmed, weight: 3, opacity: 0.35, lineCap: 'round', lineJoin: 'round' };
    }
    return { color: track.color, weight: 3, opacity: 0.85, lineCap: 'round', lineJoin: 'round' };
  }

  /* ---------------- 图层管理 ---------------- */

  function removeLayer(id) {
    var lyr = layersById[id];
    if (!lyr) return;
    if (map && map.hasLayer(lyr)) map.removeLayer(lyr);
    delete layersById[id];
  }

  function removeAllLayers() {
    for (var id in layersById) {
      if (Object.prototype.hasOwnProperty.call(layersById, id)) removeLayer(id);
    }
    if (haloLayer && map.hasLayer(haloLayer)) { map.removeLayer(haloLayer); }
    haloLayer = null;
  }

  /**
   * 为一条轨迹建（或重建）折线图层。
   * @param {Object} track
   * @param {boolean} withFocus 是否画在 focusPane 上（选中的轨迹）
   */
  function buildLayer(track, withFocus) {
    var parts = partsOf(track, true);
    if (!parts.length) return null;

    var isSel = (track.id === selectedId);
    var opts = styleFor(track, isSel);

    // 多段数组：段与段之间 Leaflet 不会连线，正好对应骑行中途的暂停断点
    opts.renderer = (withFocus && isSel) ? focusRenderer : baseRenderer;

    if (interactive) {
      opts.interactive = true;
      // Leaflet 的 Canvas 命中带宽 = 线宽/2 + renderer.tolerance。
      // renderer 已设 tolerance:8，这里无需再加。注意 renderer 的 tolerance
      // 是共享的，所以线宽差异会让细线相对更难命中，这是可接受的取舍。
    } else {
      opts.interactive = false;
    }

    var layer = global.L.polyline(parts, opts);
    layer.__trackId = track.id;
    layer.addTo(map);

    if (interactive) bindEvents(layer, track);
    return layer;
  }

  function bindEvents(layer, track) {
    layer.on('click', function (e) {
      if (global.L.DomEvent) global.L.DomEvent.stopPropagation(e);
      if (listeners.onPick) listeners.onPick(track.id, e);
    });
    layer.on('mouseover', function (e) {
      if (listeners.onHover) listeners.onHover(track.id, e);
    });
    layer.on('mouseout', function () {
      if (listeners.onHoverEnd) listeners.onHoverEnd(track.id);
    });
  }

  var listeners = { onPick: null, onHover: null, onHoverEnd: null, onHeatmapEmpty: null };

  /* ---------------- 对外接口 ---------------- */

  /**
   * 初始化地图。
   * @param {Element|string} el 容器元素或 id
   */
  function init(el) {
    if (map) return map;

    map = global.L.map(el, {
      // 显式给 maxZoom。不写的话 getMaxZoom() 返回 Infinity，
      // 单点包围盒做 fitBounds 时算出无穷缩放。
      maxZoom: 19,
      minZoom: 3,
      zoomControl: true,
      attributionControl: true,
      // 拖拽与缩放动画期间不重绘，只在 moveend / zoomend 重绘一次
      preferCanvas: true
    });

    // 选中的轨迹画在单独的 pane 上，与其余轨迹共用的那个 canvas 互不干扰。
    // overlayPane 默认 z-index 是 400、markerPane 是 600，这里取中间。
    var focusPane = map.createPane('focusPane');
    focusPane.style.zIndex = 450;

    // Canvas 渲染器默认 tolerance 是 0 —— 命中带宽只有线宽的一半，
    // 3px 的线也就是 ±1.5px，非技术用户基本点不中。这里放宽到 8px。
    baseRenderer = global.L.canvas({ padding: 0.1, tolerance: 8 });
    focusRenderer = global.L.canvas({ pane: 'focusPane', padding: 0.1, tolerance: 8 });

    map.on('click', function () {
      if (listeners.onMapClick) listeners.onMapClick();
    });

    // 容器如果在创建时尺寸为 0（面板还在布局），Leaflet 会按 0 尺寸初始化，
    // 之后所有瓦片都会错位。延迟一帧补一次尺寸刷新。
    setTimeout(function () { map.invalidateSize(); }, 0);

    // 监听容器自身尺寸的变化。
    // 只监听 window.resize 是不够的 —— 顶部的提示条出现/消失、侧栏折叠、
    // 移动端抽屉收起，都会改变地图容器的大小，而窗口尺寸没变。
    // 尺寸不同步时 Leaflet 的视野计算就是错的，表现为 fitBounds 之后
    // 轨迹仍然跑出可视区。
    if (typeof ResizeObserver !== 'undefined') {
      var ro = new ResizeObserver(function () {
        if (!map) return;
        // invalidateSize 会触发一次重绘，节流一下避免拖拽窗口时高频触发
        if (resizePending) return;
        resizePending = true;
        setTimeout(function () {
          resizePending = false;
          if (map) map.invalidateSize({ animate: false });
        }, 100);
      });
      ro.observe(map.getContainer());
      resizeObserver = ro;
    }

    setBasemap(global.Basemaps.defaultId());
    return map;
  }

  /**
   * 切换底图。坐标系变化时会重投影全部轨迹。
   * @returns {string} 当前坐标系
   */
  function setBasemap(id) {
    var p = global.Basemaps.get(id);
    if (!p) p = global.Basemaps.get(global.Basemaps.defaultId());
    if (!p) return currentCrs;

    currentBasemap = p;

    if (tileLayer) { map.removeLayer(tileLayer); tileLayer = null; }

    if (p.url) {
      tileLayer = global.L.tileLayer(p.url, {
        subdomains: p.subdomains && p.subdomains.length ? p.subdomains : 'abc',
        maxZoom: p.maxZoom,
        maxNativeZoom: p.maxNativeZoom,
        attribution: p.attribution,
        // 保持 false。设成 true 会让 file:// 页面发出带 Origin: null 的请求，
        // 瓦片服务器不返回对应 CORS 头就会整片变白。
        crossOrigin: false,
        // 关掉。开启后高分屏会去请求 z+1 级瓦片再缩小，请求量翻两番，
        // 而国内不少瓦片源在更高级别直接 404。
        detectRetina: false,
        // 给瓦片容器一个底色，瓦片没到位时不至于闪白
        className: 'basemap-' + p.surface
      });
      tileLayer.addTo(map);
      tileLayer.on('tileerror', onTileError);
    }

    var crsChanged = (p.crs !== currentCrs);
    currentCrs = p.crs;

    if (crsChanged) {
      invalidateAll(currentTracks());
      // 缓存失效后必须重建图层；调用方随后会重新 render
      removeAllLayers();
    }

    if (listeners.onBasemap) listeners.onBasemap(p, crsChanged);
    return currentCrs;
  }

  var tileErrorCount = 0;
  function onTileError() {
    tileErrorCount++;
    if (tileErrorCount === 5 && listeners.onTileError) {
      listeners.onTileError(currentBasemap);
    }
  }

  var lastTrackList = [];
  function currentTracks() { return lastTrackList; }

  /**
   * 全量渲染：按 id 差分，只重建有变化的图层。
   * @param {Array} tracks 需要显示的轨迹（已经过滤掉不可见的）
   */
  function render(tracks) {
    if (!map) return;
    lastTrackList = tracks;

    // 轨迹数量跨越交互阈值时需要重建图层（interactive 是建层时的选项）
    var wantInteractive = tracks.length <= INTERACTIVE_LIMIT;
    if (wantInteractive !== interactive && Object.keys(layersById).length) {
      interactive = wantInteractive;
      removeAllLayers();
    } else {
      interactive = wantInteractive;
    }

    var seen = {};
    var i, track;

    for (i = 0; i < tracks.length; i++) {
      track = tracks[i];
      seen[track.id] = true;
      renderOne(track);
    }

    // 删掉已经不在列表里的
    for (var id in layersById) {
      if (Object.prototype.hasOwnProperty.call(layersById, id) && !seen[id]) removeLayer(id);
    }

    // 热力图模式下新建的图层要立刻藏起来，否则数据一变就漏出矢量轨迹
    if (heatOn) showTrackLayers(false);
    else drawHalo();
  }

  /** 单条轨迹的渲染（新建或更新样式） */
  function renderOne(track) {
    if (!track || !track.segments || !track.points || track.points.length < 2) return;

    var isSel = (track.id === selectedId);
    var existing = layersById[track.id];

    // 选中的轨迹必须在 focusPane 上，位置变了就重建
    var needRebuild = !existing || (isSel && existing.options.renderer !== focusRenderer)
                                || (!isSel && existing.options.renderer !== baseRenderer);

    if (needRebuild) {
      removeLayer(track.id);
      var lyr = buildLayer(track, true);
      if (lyr) layersById[track.id] = lyr;
      return;
    }

    // 几何没变、只是样式或可见性变了 → 原地改样式，不重建图层
    var parts = partsOf(track, false);
    existing.setStyle(styleFor(track, isSel));
    if (existing.options.renderer !== (isSel ? focusRenderer : baseRenderer)) {
      removeLayer(track.id);
      var l2 = buildLayer(track, true);
      if (l2) layersById[track.id] = l2;
      return;
    }
    // 段数变化（例如分段参数变了）才需要重设几何
    if (existing.getLatLngs().length !== parts.length) {
      existing.setLatLngs(parts);
    }
  }

  /** 选中轨迹底部的深色描边，让它从密集轨迹里跳出来 */
  function drawHalo() {
    if (haloLayer) { map.removeLayer(haloLayer); haloLayer = null; }
    if (!selectedId) return;
    var track = null;
    for (var i = 0; i < lastTrackList.length; i++) {
      if (lastTrackList[i].id === selectedId) { track = lastTrackList[i]; break; }
    }
    if (!track) return;
    var parts = partsOf(track, false);
    if (!parts.length) return;
    haloLayer = global.L.polyline(parts, {
      renderer: baseRenderer,
      color: COLORS.halo,
      weight: 11,
      opacity: 0.22,
      lineCap: 'round',
      lineJoin: 'round',
      interactive: false
    });
    haloLayer.addTo(map);
  }

  /** 设置选中项（null 表示取消选中） */
  function setSelected(id) {
    if (selectedId === id) return;
    var prev = selectedId;
    selectedId = id;

    if (prev) {
      var p = findTrack(prev);
      if (p) renderOne(p);
    }
    if (id) {
      var t = findTrack(id);
      if (t) renderOne(t);
    }
    // 其余轨迹的「降灰/恢复」需要整体重刷样式
    refreshStylesExcept([prev, id]);
    drawHalo();
    // 渐变着色跟着选中项走，选中变了要重画
    if (gradientOn) applyGradient();
  }

  function refreshStylesExcept(exceptIds) {
    for (var i = 0; i < lastTrackList.length; i++) {
      var t = lastTrackList[i];
      if (exceptIds.indexOf(t.id) >= 0) continue;
      var lyr = layersById[t.id];
      if (lyr) lyr.setStyle(styleFor(t, false));
    }
  }

  function findTrack(id) {
    for (var i = 0; i < lastTrackList.length; i++) {
      if (lastTrackList[i].id === id) return lastTrackList[i];
    }
    return null;
  }

  /* ---------------- 视野控制 ---------------- */

  /**
   * fitBounds 对非法包围盒会**抛异常**（不是静默失败），必须先行守卫。
   * 另外单点包围盒会让它去算无穷缩放，也得单独处理。
   */
  function safeFit(bounds, opts) {
    if (!map || !bounds) return;

    // fitBounds 用的是 Leaflet 缓存的容器尺寸。缓存过期（例如刚弹出一条提示条
    // 把地图挤矮了）会让算出来的缩放级别偏大，表现为轨迹跑出可视区。
    // 这里先花一次 getBoundingClientRect 对一下，不一致才刷新。
    var container = map.getContainer();
    var size = map.getSize();
    if (container.clientWidth !== size.x || container.clientHeight !== size.y) {
      map.invalidateSize({ animate: false });
    }

    var sw = bounds[0], ne = bounds[1];
    if (!sw || !ne) return;
    if (!isFinite(sw[0]) || !isFinite(sw[1]) || !isFinite(ne[0]) || !isFinite(ne[1])) return;

    if (sw[0] === ne[0] && sw[1] === ne[1]) {
      map.setView(sw, (opts && opts.maxZoom) || 15, { animate: false });
      return;
    }
    map.fitBounds(bounds, opts || { padding: [40, 40], maxZoom: 16, animate: false });
  }

  function boundsOf(tracks) {
    var minLat = Infinity, maxLat = -Infinity, minLon = Infinity, maxLon = -Infinity;
    var any = false;
    for (var i = 0; i < tracks.length; i++) {
      var b = global.Geo.bounds(tracks[i].points);
      if (!b) continue;
      any = true;
      if (b[0][0] < minLat) minLat = b[0][0];
      if (b[0][1] < minLon) minLon = b[0][1];
      if (b[1][0] > maxLat) maxLat = b[1][0];
      if (b[1][1] > maxLon) maxLon = b[1][1];
    }
    return any ? [[minLat, minLon], [maxLat, maxLon]] : null;
  }

  function fitAll(tracks, opts) {
    safeFit(boundsOf(tracks && tracks.length !== undefined ? tracks : lastTrackList),
      opts || { padding: [40, 40], maxZoom: 16, animate: false });
  }

  function fitTrack(id, opts) {
    var t = findTrack(id);
    if (!t) return;
    safeFit(global.Geo.bounds(t.points), opts || { padding: [60, 60], maxZoom: 17, animate: true });
  }

  /**
   * 合并短时间内的多次视野调整。
   * 一次导入 20 个文件会触发 20 次 fitBounds，不合并的话地图会疯狂抖动。
   */
  function scheduleFit(bounds, opts) {
    if (!bounds) return;
    if (pendingFitBounds) {
      pendingFitBounds = unionBounds(pendingFitBounds, bounds);
    } else {
      pendingFitBounds = bounds;
    }
    pendingFitOpts = opts || pendingFitOpts || { padding: [40, 40], maxZoom: 16, animate: false };
    if (fitTimer) clearTimeout(fitTimer);
    fitTimer = setTimeout(function () {
      var b = pendingFitBounds, o = pendingFitOpts;
      pendingFitBounds = null; fitTimer = null;
      safeFit(b, o);
    }, 150);
  }

  function unionBounds(a, b) {
    if (!a) return b;
    if (!b) return a;
    return [
      [Math.min(a[0][0], b[0][0]), Math.min(a[0][1], b[0][1])],
      [Math.max(a[1][0], b[1][0]), Math.max(a[1][1], b[1][1])]
    ];
  }

  /** 判断包围盒是否已完全在当前视野内 —— 在的话就不该动镜头 */
  function boundsInView(bounds) {
    if (!map || !bounds) return false;
    try {
      return map.getBounds().contains(global.L.latLngBounds(bounds));
    } catch (e) {
      return false;
    }
  }

  /** 切底图后检查轨迹是否还在视野内，跑出去了才重新定位 */
  function ensureVisibleOnScreen(tracks) {
    var b = boundsOf(tracks);
    if (!b) return;
    if (boundsInView(b)) return;   // 还在视野内，不要粗暴重置用户的缩放位置
    safeFit(b, { padding: [40, 40], maxZoom: 16, animate: false });
  }

  /* ---------------- 剖面图联动的游标 ---------------- */

  function setCueMarker(latlng) {
    if (!map) return;
    if (!latlng) {
      if (cueMarker) { map.removeLayer(cueMarker); cueMarker = null; }
      return;
    }
    // 用 circleMarker 而不是 marker：marker 是 DOM 元素，
    // circleMarker 走 canvas，且命中测试只是半径比较，便宜得多
    if (!cueMarker) {
      cueMarker = global.L.circleMarker(latlng, {
        renderer: focusRenderer,
        radius: 6,
        color: '#ffffff',
        weight: 2,
        fillColor: '#d94f2b',
        fillOpacity: 1,
        interactive: false
      });
      cueMarker.addTo(map);
    } else {
      cueMarker.setLatLng(latlng);
    }
  }

  /* ---------------- 回放标记 ---------------- */

  /**
   * 回放时沿轨迹移动的圆点。
   * 用 circleMarker 而不是 marker：marker 是 DOM 元素，
   * circleMarker 走 canvas，且命中测试只是半径比较，便宜得多。
   */
  function setReplayMarker(latlng) {
    if (!map) return;
    if (!latlng) {
      if (replayMarker) { map.removeLayer(replayMarker); replayMarker = null; }
      return;
    }
    if (!replayMarker) {
      replayMarker = global.L.circleMarker(latlng, {
        renderer: focusRenderer,
        radius: 7,
        color: '#ffffff',
        weight: 2.5,
        fillColor: '#d94f2b',
        fillOpacity: 1,
        interactive: false
      });
      replayMarker.addTo(map);
    } else {
      replayMarker.setLatLng(latlng);
    }
  }

  /* ---------------- 按速度渐变着色 ---------------- */

  /**
   * 把聚焦的那条轨迹按速度分段着色。
   *
   * 用的是「单色顺序色阶」，不是彩虹渐变 —— 速度是有序的量，
   * 顺序色阶（同一色相由浅到深）才是它的正确编码；
   * 彩虹色阶会让「快」和「慢」在色相环上没有方向感。
   *
   * 只对选中的那一条生效：全量做渐变会把图层数乘以分段数，
   * 几百条轨迹时直接卡死。
   */
  function clearGradient() {
    for (var i = 0; i < gradientLayers.length; i++) {
      if (map.hasLayer(gradientLayers[i])) map.removeLayer(gradientLayers[i]);
    }
    gradientLayers = [];
  }

  function applyGradient() {
    clearGradient();
    if (!gradientOn || !selectedId || !global.Profile) return;

    var track = findTrack(selectedId);
    if (!track) return;

    var ramp = global.TracksStore.getSurface() === 'dark'
      ? global.TracksStore.RAMP_DARK : global.TracksStore.RAMP_LIGHT;

    var segs = global.Profile.speedSegments(track, ramp.length);
    if (!segs || !segs.length) return;

    // 段数太多会拖慢渲染，超过上限就不做渐变（回退成单色，不给用户假象）
    if (segs.length > 300) return;

    for (var i = 0; i < segs.length; i++) {
      var s = segs[i];
      if (s.points.length < 2) continue;
      var simp = global.Geo.simplify(s.points, tolerance);
      if (simp.length < 2) continue;
      var conv = projectSeg(simp, currentCrs, entirelyOutOfChina(global.Geo.bounds(simp)));

      var lyr = global.L.polyline(conv, {
        renderer: focusRenderer,
        color: ramp[Math.min(s.level, ramp.length - 1)],
        weight: 6,
        opacity: 1,
        lineCap: 'round',
        lineJoin: 'round',
        interactive: false
      });
      lyr.addTo(map);
      gradientLayers.push(lyr);
    }

    // 渐变着色期间把原来的单色折线藏掉，否则底色会透出来
    var base = layersById[selectedId];
    if (base) base.setStyle({ opacity: 0 });
  }

  function setGradient(on) {
    gradientOn = !!on;
    if (!gradientOn) {
      var base = layersById[selectedId];
      if (base) base.setStyle(styleFor(findTrack(selectedId), true));
    }
    applyGradient();
  }

  function isGradientOn() { return gradientOn; }

  /* ---------------- 热力图 ---------------- */

  /**
   * 预计算轨迹点的密度网格。
   *
   * 网格边长取 0.0005 度（约 55 米）—— 比这细格子数会爆炸，
   * 比这粗市区道路就糊成一块一块的了。
   *
   * 内部按「行」组织（每行是一串按 gx 排好序的格子），
   * 这样每个瓦片只需要二分出自己覆盖的那几行、再在行内二分出列范围，
   * 开销正比于「视口内实际有数据的格子数」，而不是整个网格的规模。
   * 直接拿哈希表在整个网格上扫的话，骑得多了以后每次缩放都会明显卡顿。
   */
  var HEAT_CELL = 0.0005;

  function buildHeatGrid(tracks) {
    var counts = Object.create(null);
    var maxCount = 0;
    var total = 0;

    for (var i = 0; i < tracks.length; i++) {
      var pts = tracks[i].points;
      if (!pts) continue;
      for (var j = 0; j < pts.length; j++) {
        var gx = Math.floor(pts[j].lon / HEAT_CELL);
        var gy = Math.floor(pts[j].lat / HEAT_CELL);
        var key = gx + ':' + gy;
        var c = (counts[key] || 0) + 1;
        counts[key] = c;
        total++;
        if (c > maxCount) maxCount = c;
      }
    }
    if (!total) return null;

    // 转成按行索引的有序结构
    var byRow = Object.create(null);
    for (var k in counts) {
      var parts = k.split(':');
      var rgy = +parts[1];
      if (!byRow[rgy]) byRow[rgy] = [];
      byRow[rgy].push([+parts[0], counts[k]]);
    }

    var rows = [];
    for (var r in byRow) {
      var arr = byRow[r];
      arr.sort(function (a, b) { return a[0] - b[0]; });
      rows.push({ gy: +r, cells: arr });
    }
    rows.sort(function (a, b) { return a.gy - b.gy; });

    return { rows: rows, maxCount: maxCount, cellCount: Object.keys(counts).length };
  }

  /** 在有序数组里二分出第一个 >= v 的下标 */
  function lowerBound(arr, v, pick) {
    var lo = 0, hi = arr.length;
    while (lo < hi) {
      var mid = (lo + hi) >> 1;
      if (pick(arr[mid]) < v) lo = mid + 1; else hi = mid;
    }
    return lo;
  }

  function buildHeatLayer() {
    var GL = global.L.GridLayer.extend({
      createTile: function (coords) {
        var size = this.getTileSize();
        var canvas = document.createElement('canvas');
        canvas.width = size.x;
        canvas.height = size.y;
        var ctx = canvas.getContext('2d');
        if (!heatGrid) return canvas;

        // 该瓦片覆盖的经纬度范围
        var nw = map.unproject([coords.x * size.x, coords.y * size.y], coords.z);
        var se = map.unproject([(coords.x + 1) * size.x, (coords.y + 1) * size.y], coords.z);

        var gx0 = Math.floor(nw.lng / HEAT_CELL), gx1 = Math.ceil(se.lng / HEAT_CELL);
        var gy0 = Math.floor(se.lat / HEAT_CELL), gy1 = Math.ceil(nw.lat / HEAT_CELL);
        if (gx1 < gx0) { var t = gx0; gx0 = gx1; gx1 = t; }

        var rows = heatGrid.rows;
        var rowFrom = lowerBound(rows, gy0, function (r) { return r.gy; });
        var rowTo = lowerBound(rows, gy1, function (r) { return r.gy; });

        // 一格的屏幕像素尺寸
        var a = map.project([gy0 * HEAT_CELL, gx0 * HEAT_CELL], coords.z);
        var b = map.project([(gy0 + 1) * HEAT_CELL, (gx0 + 1) * HEAT_CELL], coords.z);
        var unitW = Math.abs(b.x - a.x) || 1;
        var unitH = Math.abs(b.y - a.y) || 1;

        // 缩得很小时把相邻格子合并成块，否则会画成一团噪点、也白白多画几千个矩形。
        // 合并是在「有数据的格子」上做的，所以不会因为视口大就变慢。
        var stride = 1;
        while (unitW * stride < 3 && stride < 128) stride *= 2;

        var ramp = global.TracksStore.getSurface() === 'dark'
          ? global.TracksStore.RAMP_DARK : global.TracksStore.RAMP_LIGHT;

        var blocks = Object.create(null);

        for (var r = rowFrom; r < rowTo; r++) {
          var row = rows[r];
          var cells = row.cells;
          var from = lowerBound(cells, gx0, function (c) { return c[0]; });
          for (var c2 = from; c2 < cells.length; c2++) {
            if (cells[c2][0] > gx1) break;
            var gx = cells[c2][0], cnt = cells[c2][1];
            var bgx = Math.floor(gx / stride), bgy = Math.floor(row.gy / stride);
            var bk = bgx + ':' + bgy;
            blocks[bk] = (blocks[bk] || 0) + cnt;
          }
        }

        for (var key in blocks) {
          var kp = key.split(':');
          var bx = +kp[0] * stride, by = +kp[1] * stride;

          // 对数分档：骑行次数是长尾分布，线性分档会让绝大多数格子挤在最浅一档
          var f = Math.log(1 + blocks[key]) / Math.log(1 + heatGrid.maxCount);
          var li = Math.min(ramp.length - 1, Math.max(0, Math.floor(f * ramp.length)));
          ctx.fillStyle = ramp[li];

          var p0 = map.project([by * HEAT_CELL, bx * HEAT_CELL], coords.z);
          ctx.fillRect(
            p0.x - coords.x * size.x,
            p0.y - coords.y * size.y,
            unitW * stride + 0.5,
            unitH * stride + 0.5
          );
        }
        return canvas;
      }
    });

    return new GL({ pane: 'focusPane', maxZoom: 19, interactive: false });
  }

  /**
   * 切换热力图模式。与矢量轨迹图层**互斥** ——
   * 两套叠在一起会互相干扰，而且热力图的意义本来就是「不关心单条轨迹，只看全局分布」。
   */
  function setHeatmap(on, tracks) {
    heatOn = !!on;

    if (heatLayer && map.hasLayer(heatLayer)) { map.removeLayer(heatLayer); heatLayer = null; }

    if (!heatOn) {
      heatGrid = null;
      showTrackLayers(true);
      return;
    }

    heatGrid = buildHeatGrid(tracks || lastTrackList);
    if (!heatGrid) {
      // 没有点就没什么可画的，别摆出一个全空的模式
      heatOn = false;
      if (listeners.onHeatmapEmpty) listeners.onHeatmapEmpty();
      return;
    }

    heatLayer = buildHeatLayer();
    heatLayer.addTo(map);
    showTrackLayers(false);
  }

  /** 热力图模式下把矢量轨迹整体藏起来，退出时恢复 */
  function showTrackLayers(show) {
    for (var id in layersById) {
      if (!Object.prototype.hasOwnProperty.call(layersById, id)) continue;
      var lyr = layersById[id];
      if (show) {
        if (!map.hasLayer(lyr)) lyr.addTo(map);
      } else {
        if (map.hasLayer(lyr)) map.removeLayer(lyr);
      }
    }
    if (!show) {
      if (haloLayer && map.hasLayer(haloLayer)) map.removeLayer(haloLayer);
      clearGradient();
      if (replayMarker && map.hasLayer(replayMarker)) map.removeLayer(replayMarker);
    } else {
      drawHalo();
      if (gradientOn) applyGradient();
    }
  }

  function isHeatmapOn() { return heatOn; }

  /** 底图明暗变化后，渐变与热力图都要按新色阶重画 */
  function refreshColorLayers() {
    if (gradientOn) applyGradient();
    if (heatOn) setHeatmap(true, lastTrackList);
  }

  /* ---------------- 杂项 ---------------- */

  function setTolerance(m) {
    if (tolerance === m) return;
    tolerance = m;
  }

  function getTolerance() { return tolerance; }

  function invalidateSize() {
    if (map) map.invalidateSize();
  }

  function getMap() { return map; }
  function getCrs() { return currentCrs; }
  function getBasemap() { return currentBasemap; }

  /**
   * 渲染层的运行时状态快照。
   * 供自动化测试断言用（canvas 渲染的折线没有 DOM 节点，从外部数不出来），
   * 也方便排查「界面上看不到轨迹」这类问题。
   */
  function debugStats() {
    var layerCount = 0;
    for (var id in layersById) {
      if (Object.prototype.hasOwnProperty.call(layersById, id)) layerCount++;
    }
    return {
      layers: layerCount,
      tracks: lastTrackList.length,
      selected: selectedId,
      crs: currentCrs,
      basemap: currentBasemap ? currentBasemap.id : null,
      hasTiles: !!tileLayer,
      heatmap: heatOn,
      heatCells: heatGrid ? heatGrid.cellCount : 0,
      heatVisibleLayers: (function () {
        var n = 0;
        for (var id in layersById) {
          if (Object.prototype.hasOwnProperty.call(layersById, id) && map.hasLayer(layersById[id])) n++;
        }
        return n;
      })(),
      gradient: gradientOn,
      gradientSegs: gradientLayers.length,
      tolerance: tolerance,
      interactive: interactive
    };
  }

  /** 某条轨迹在「当前底图坐标系」下渲染出来的第一个点，供纠偏断言比对 */
  function debugFirstPoint(id) {
    var t = null;
    for (var i = 0; i < lastTrackList.length; i++) {
      if (lastTrackList[i].id === id) { t = lastTrackList[i]; break; }
    }
    if (!t) return null;
    var parts = partsOf(t, false);
    if (!parts.length || !parts[0].length) return null;
    return { lat: parts[0][0].lat, lon: parts[0][0].lon };
  }

  function on(evt, fn) { listeners[evt] = fn; }

  function destroy() {
    removeAllLayers();
    if (map) { map.remove(); map = null; }
  }

  global.MapView = {
    init: init,
    setBasemap: setBasemap,
    render: render,
    renderOne: renderOne,
    invalidate: invalidate,
    invalidateAll: invalidateAll,
    setSelected: setSelected,
    fitAll: fitAll,
    fitTrack: fitTrack,
    scheduleFit: scheduleFit,
    ensureVisibleOnScreen: ensureVisibleOnScreen,
    boundsOf: boundsOf,
    setCueMarker: setCueMarker,
    setReplayMarker: setReplayMarker,
    setGradient: setGradient,
    isGradientOn: isGradientOn,
    setHeatmap: setHeatmap,
    isHeatmapOn: isHeatmapOn,
    refreshColorLayers: refreshColorLayers,
    setTolerance: setTolerance,
    getTolerance: getTolerance,
    invalidateSize: invalidateSize,
    getMap: getMap,
    getCrs: getCrs,
    getBasemap: getBasemap,
    debugStats: debugStats,
    debugFirstPoint: debugFirstPoint,
    on: on,
    INTERACTIVE_LIMIT: INTERACTIVE_LIMIT
  };
})(window);
