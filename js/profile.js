/*!
 * profile.js —— 海拔与速度剖面图
 *
 * 用原生 SVG 自绘，不引任何图表库（零构建、离线可用的约束下，多一个依赖就多一分风险）。
 *
 * 两条来自数据可视化规范的硬规则：
 *
 *   1. **绝不使用双 Y 轴**。海拔（米）和速度（km/h）量纲完全不同，
 *      把它们画在同一张图里、左右各挂一个刻度，是图表设计里最经典的错误 ——
 *      两条曲线的交叉点会变成纯粹的视觉巧合，读不出任何含义。
 *      正确做法是拆成两个共享 X 轴的小图，各自拥有独立的 Y 轴。
 *
 *   2. **必须有十字准线 + 数值提示**。SVG 图表天然是可交互的，
 *      悬停时显示数值、并与地图上的游标联动，是这个形态的基本要求。
 *
 * X 轴用「累计里程」而不是时间 —— 骑行中会有等待红绿灯、休息等零速时段，
 * 按时间铺开会把那些平坦段拉得很长，掩盖真正有信息量的坡度与速度变化。
 */
(function (global) {
  'use strict';

  var el = {};
  var current = null;        // 当前渲染的轨迹
  var series = null;         // 降采样后的数据序列
  var cursorIndex = -1;

  var NS = 'http://www.w3.org/2000/svg';

  // 版面
  var W = 320;               // viewBox 宽度（CSS 会等比拉伸）
  var PAD_L = 30, PAD_R = 8, PAD_T = 10;
  var H_ELE = 92;            // 海拔图高度
  var H_SPD = 74;            // 速度图高度
  var GAP = 16;              // 两图间距

  /** 采样点数上限。再多屏幕上也画不出差别，只会拖慢 SVG 渲染。 */
  var MAX_SAMPLES = 320;

  function svgEl(name, attrs) {
    var n = document.createElementNS(NS, name);
    if (attrs) {
      for (var k in attrs) {
        if (Object.prototype.hasOwnProperty.call(attrs, k)) n.setAttribute(k, attrs[k]);
      }
    }
    return n;
  }

  function num(v, fallback) {
    return (typeof v === 'number' && isFinite(v)) ? v : fallback;
  }

  /* ------------------------------------------------------------------ *
   * 数据准备
   * ------------------------------------------------------------------ */

  /**
   * 把轨迹点整理成绘图序列：X = 累计里程（公里），Y = 海拔 / 速度。
   *
   * 速度优先用文件自带的，没有则按相邻点距离与时间推算（Geo.deriveSpeeds）。
   * 推算出来的原始速度噪声很大（GPS 抖动会让静止时也显示 20km/h），
   * 所以再做一次滑动平均。
   */
  function buildSeries(track) {
    var pts = track.points;
    if (!pts || pts.length < 2) return null;

    var Geo = global.Geo;
    var speeds = Geo.deriveSpeeds(pts, false);
    var smoothed = Geo.smoothSpeedSeries(
      pts.map(function (p, i) { return { speed: speeds[i] }; }), 9
    );

    // 累计里程
    var cum = new Array(pts.length);
    cum[0] = 0;
    for (var i = 1; i < pts.length; i++) {
      var d = Geo.distance(pts[i - 1].lat, pts[i - 1].lon, pts[i].lat, pts[i].lon);
      cum[i] = cum[i - 1] + d;
    }
    var totalKm = cum[pts.length - 1] / 1000;
    if (!(totalKm > 0)) return null;

    // 等距降采样：按累计里程均匀取点，而不是按数组下标，
    // 否则采样点会密集堆在慢速路段，快速路段反而稀疏
    var step = Math.max(1, Math.floor(pts.length / MAX_SAMPLES));
    var idxs = [];
    for (var j = 0; j < pts.length; j += step) idxs.push(j);
    if (idxs[idxs.length - 1] !== pts.length - 1) idxs.push(pts.length - 1);

    var out = {
      km: [], ele: [], spd: [], hasEle: false, hasSpd: false,
      totalKm: totalKm, srcIndex: [], points: pts, cum: cum
    };

    for (var k = 0; k < idxs.length; k++) {
      var p = pts[idxs[k]];
      out.km.push(cum[idxs[k]] / 1000);
      out.srcIndex.push(idxs[k]);

      var e = num(p.ele, null);
      out.ele.push(e);
      if (e !== null) out.hasEle = true;

      var s = num(smoothed[idxs[k]], null);
      out.spd.push(s !== null ? s * 3.6 : null);   // m/s → km/h
      if (s !== null) out.hasSpd = true;
    }

    return out;
  }

  /* ------------------------------------------------------------------ *
   * 绘图
   * ------------------------------------------------------------------ */

  function makeScales(values, h, padT, padB) {
    var min = Infinity, max = -Infinity;
    for (var i = 0; i < values.length; i++) {
      var v = values[i];
      if (v === null || !isFinite(v)) continue;
      if (v < min) min = v;
      if (v > max) max = v;
    }
    if (min === Infinity) return null;
    if (max - min < 1e-6) { max = min + 1; min = min - 1; }

    // 上下各留一点余量，曲线不要贴着边框
    var span = max - min;
    min -= span * 0.08;
    max += span * 0.08;

    var innerH = h - padT - padB;
    return {
      min: min, max: max,
      y: function (v) {
        var f = (v - min) / (max - min);
        return padT + (1 - f) * innerH;
      }
    };
  }

  function linePath(xs, ys, scaleY, xScale) {
    var d = '';
    var started = false;
    for (var i = 0; i < ys.length; i++) {
      var v = ys[i];
      if (v === null || !isFinite(v)) { started = false; continue; }
      var X = xScale(xs[i]);
      var Y = scaleY(v);
      // 数据有断档（缺海拔/缺速度）时另起一笔，不要跨断档连线
      d += (started ? 'L' : 'M') + X.toFixed(1) + ' ' + Y.toFixed(1) + ' ';
      started = true;
    }
    return d;
  }

  function areaPath(xs, ys, scaleY, xScale, baselineY) {
    var d = '';
    var started = false;
    var firstX = null, lastX = null;
    for (var i = 0; i < ys.length; i++) {
      var v = ys[i];
      if (v === null || !isFinite(v)) {
        if (started) d += 'L' + lastX + ' ' + baselineY + ' Z ';
        started = false;
        continue;
      }
      var X = xScale(xs[i]);
      var Y = scaleY(v);
      if (!started) { d += 'M' + X.toFixed(1) + ' ' + Y.toFixed(1) + ' '; firstX = X; }
      else d += 'L' + X.toFixed(1) + ' ' + Y.toFixed(1) + ' ';
      started = true;
      lastX = X.toFixed(1);
    }
    if (started && firstX !== null) d += 'L' + lastX + ' ' + baselineY + ' Z ';
    return d;
  }

  /** 画一个图：网格 + 面积 + 曲线 + Y 轴刻度 */
  function buildChart(container, opt) {
    var width = W;
    var innerW = width - PAD_L - PAD_R;
    var padB = 16;

    var scale = makeScales(opt.values, opt.height, PAD_T, padB);
    if (!scale) return null;

    var svg = svgEl('svg', {
      viewBox: '0 0 ' + width + ' ' + opt.height,
      preserveAspectRatio: 'none',
      height: opt.height
    });
    svg.style.height = opt.height + 'px';

    var xScale = function (km) { return PAD_L + (km / opt.totalKm) * innerW; };
    var baselineY = opt.height - padB;

    // 网格线（三条：上、中、下）—— 保持克制，不要喧宾夺主
    var gy = [scale.max, (scale.max + scale.min) / 2, scale.min];
    for (var i = 0; i < gy.length; i++) {
      svg.appendChild(svgEl('line', {
        class: 'profile-grid-line',
        x1: PAD_L, x2: width - PAD_R,
        y1: scale.y(gy[i]).toFixed(1), y2: scale.y(gy[i]).toFixed(1)
      }));
    }

    if (opt.kind === 'area') {
      svg.appendChild(svgEl('path', {
        class: 'profile-area',
        d: areaPath(opt.xs, opt.values, scale.y, xScale, baselineY)
      }));
    }

    svg.appendChild(svgEl('path', {
      class: 'profile-line' + (opt.extraClass ? ' ' + opt.extraClass : ''),
      d: linePath(opt.xs, opt.values, scale.y, xScale)
    }));

    // Y 轴刻度：只标最大值与最小值，中间靠网格线示意
    var yMax = svgEl('text', { class: 'profile-axis-label', x: PAD_L - 5, y: scale.y(scale.max) + 4, 'text-anchor': 'end' });
    yMax.textContent = opt.fmt(scale.max);
    svg.appendChild(yMax);

    var yMin = svgEl('text', { class: 'profile-axis-label', x: PAD_L - 5, y: scale.y(scale.min) + 4, 'text-anchor': 'end' });
    yMin.textContent = opt.fmt(scale.min);
    svg.appendChild(yMin);

    // X 轴刻度：起点与终点
    var x0 = svgEl('text', { class: 'profile-axis-label', x: PAD_L, y: opt.height - 4, 'text-anchor': 'start' });
    x0.textContent = '0';
    svg.appendChild(x0);

    var x1 = svgEl('text', { class: 'profile-axis-label', x: width - PAD_R, y: opt.height - 4, 'text-anchor': 'end' });
    x1.textContent = opt.totalKm.toFixed(1) + ' km';
    svg.appendChild(x1);

    // 十字准线（初始隐藏）
    var cursor = svgEl('line', {
      class: 'profile-cursor', x1: 0, x2: 0, y1: PAD_T - 2, y2: baselineY,
      opacity: 0
    });
    svg.appendChild(cursor);

    container.appendChild(svg);

    return { svg: svg, scale: scale, xScale: xScale, cursor: cursor, padB: padB, height: opt.height, kind: opt.kind };
  }

  /* ------------------------------------------------------------------ *
   * 渲染
   * ------------------------------------------------------------------ */

  function render(track) {
    current = track || null;
    var host = el.profile;
    if (!host) return;

    // 清空
    while (host.firstChild) host.removeChild(host.firstChild);
    el.section.hidden = !track;

    if (!track) { series = null; return; }

    series = buildSeries(track);
    if (!series || !series.hasEle && !series.hasSpd) {
      host.appendChild(makeDiv('profile-empty', '这条轨迹没有海拔或速度数据，无法绘制剖面图。'));
      el.legend.hidden = true;
      return;
    }

    // 标题跟着实际画出来的图走。真实的华为导出文件里没有海拔，
    // 只画速度曲线时标题还写着「海拔与速度」，会让人以为图没画全。
    var titleEl = el.section.querySelector('.panel-title');
    if (titleEl) {
      titleEl.textContent = (series.hasEle && series.hasSpd) ? '海拔与速度'
        : series.hasEle ? '海拔剖面'
        : '速度剖面';
    }

    host.appendChild(buildLegend(series));

    charts = {};

    if (series.hasEle) {
      charts.ele = buildChart(host, {
        kind: 'area',
        xs: series.km,
        values: series.ele,
        height: H_ELE,
        totalKm: series.totalKm,
        fmt: function (v) { return Math.round(v) + 'm'; }
      });
    }

    if (series.hasSpd) {
      charts.spd = buildChart(host, {
        kind: 'line',
        xs: series.km,
        values: series.spd,
        height: H_SPD,
        extraClass: 'profile-line-speed',
        totalKm: series.totalKm,
        fmt: function (v) { return v.toFixed(0); }
      });
    }

    // 悬停提示层：绝对定位在剖面区内，由 bindHover 里的鼠标位置驱动。
    // 必须挂在 host 上而不是另建容器 —— 它的定位基准就是 .profile（CSS 里 position: relative）。
    tipEl = makeDiv('track-tip');
    tipEl.style.display = 'none';
    host.appendChild(tipEl);

    bindHover();
  }

  var charts = {};
  var tipEl = null;

  function makeDiv(cls, text) {
    var d = document.createElement('div');
    d.className = cls;
    if (text) d.textContent = text;
    return d;
  }

  /* ------------------------------------------------------------------ *
   * 悬停交互
   * ------------------------------------------------------------------ */

  function bindHover() {
    var host = el.profile;
    if (!series) return;

    function onMove(e) {
      if (!charts.ele && !charts.spd) return;
      var ref = (charts.ele || charts.spd).svg;
      var rect = ref.getBoundingClientRect();
      if (!rect.width) return;

      var ratio = (e.clientX - rect.left) / rect.width;
      ratio = Math.max(0, Math.min(1, ratio));

      var km = ratio * series.totalKm;
      var idx = nearestIndex(series.km, km);
      if (idx < 0) return;

      cursorIndex = idx;
      moveCursors(series.km[idx]);

      showTip(idx, rect, e.clientX);

      // 与地图上的游标联动：用原始点，保证位置精确
      var srcIdx = series.srcIndex[idx];
      var p = series.points[srcIdx];
      if (p && global.App) global.App.cueAt(p.lat, p.lon);
    }

    function onLeave() {
      cursorIndex = -1;
      moveCursors(null);
      if (tipEl) tipEl.style.display = 'none';
      if (global.App) global.App.cueAt(null, null);
    }

    host.addEventListener('mousemove', onMove);
    host.addEventListener('mouseleave', onLeave);
  }

  /** 二分找最近的 X */
  function nearestIndex(arr, target) {
    if (!arr.length) return -1;
    var lo = 0, hi = arr.length - 1;
    while (hi - lo > 1) {
      var mid = (lo + hi) >> 1;
      if (arr[mid] < target) lo = mid; else hi = mid;
    }
    return (target - arr[lo]) <= (arr[hi] - target) ? lo : hi;
  }

  function moveCursors(km) {
    for (var k in charts) {
      if (!Object.prototype.hasOwnProperty.call(charts, k)) continue;
      var c = charts[k];
      if (!c || !c.cursor) continue;
      if (km === null) { c.cursor.setAttribute('opacity', '0'); continue; }
      var x = c.xScale(km);
      c.cursor.setAttribute('x1', x.toFixed(1));
      c.cursor.setAttribute('x2', x.toFixed(1));
      c.cursor.setAttribute('opacity', '0.55');
    }
  }

  function showTip(idx, rect, clientX) {
    if (!tipEl) return;
    var p = series.points[series.srcIndex[idx]];
    var F = global.Format;

    tipEl.innerHTML = '';
    tipEl.appendChild(makeDiv('track-tip-name', current ? current.name : ''));

    var rows = [['里程', series.km[idx].toFixed(2) + ' 公里']];
    if (p.ele !== null && p.ele !== undefined) rows.push(['海拔', F.elevation(p.ele) + ' 米']);
    if (series.spd[idx] !== null) rows.push(['速度', series.spd[idx].toFixed(1) + ' km/h']);
    if (p.hr !== null && p.hr !== undefined) rows.push(['心率', p.hr + ' bpm']);
    if (p.time !== null && p.time !== undefined) rows.push(['时间', F.dateTime(p.time)]);

    for (var i = 0; i < rows.length; i++) {
      var r = makeDiv('track-tip-row');
      r.appendChild(document.createTextNode(rows[i][0] + '：'));
      var b = document.createElement('b');
      b.textContent = rows[i][1];
      r.appendChild(b);
      tipEl.appendChild(r);
    }

    // 提示框跟随鼠标，靠近右边缘时翻到左侧
    var hostRect = el.profile.getBoundingClientRect();
    var left = clientX - hostRect.left + 14;
    if (left + 200 > hostRect.width) left = clientX - hostRect.left - 200;
    if (left < 0) left = 0;

    tipEl.style.display = '';
    tipEl.style.position = 'absolute';
    tipEl.style.left = left + 'px';
    tipEl.style.top = '8px';
    tipEl.style.background = 'var(--panel)';
    tipEl.style.border = '1px solid var(--border)';
    tipEl.style.borderRadius = 'var(--radius-sm)';
    tipEl.style.boxShadow = 'var(--shadow)';
    tipEl.style.padding = '7px 10px';
    tipEl.style.pointerEvents = 'none';
    tipEl.style.zIndex = '10';
  }

  /* ------------------------------------------------------------------ *
   * 速度分档（供轨迹按速度渐变着色用）
   * ------------------------------------------------------------------ */

  /**
   * 把一条轨迹按速度切成若干段，每段一个颜色档。
   * 返回 [{points:[...], level:0..n-1}]，颜色由调用方按已校验的色阶取。
   *
   * 用中位数而不是均值分档 —— 骑行速度分布是右偏的（等红灯拉低均值但不代表常态），
   * 按均值切会让大部分点挤在低档。
   */
  function speedSegments(track, levels) {
    var pts = track.points;
    if (!pts || pts.length < 2) return null;

    var Geo = global.Geo;
    var speeds = Geo.deriveSpeeds(pts, false);
    var smoothed = Geo.smoothSpeedSeries(
      pts.map(function (p, i) { return { speed: speeds[i] }; }), 9
    );

    // 收集有效速度用于定分档边界
    var valid = [];
    for (var i = 0; i < smoothed.length; i++) {
      if (smoothed[i] !== null && isFinite(smoothed[i])) valid.push(smoothed[i]);
    }
    if (valid.length < 10) return null;

    valid.sort(function (a, b) { return a - b; });
    var q = [];
    for (var k = 1; k < levels; k++) {
      q.push(valid[Math.floor(valid.length * k / levels)]);
    }

    function levelOf(v) {
      if (v === null || !isFinite(v)) return 0;
      for (var m = 0; m < q.length; m++) if (v < q[m]) return m;
      return levels - 1;
    }

    // 切成同档的连续段
    var segs = [];
    var curPts = [pts[0]];
    var curLevel = levelOf(smoothed[0]);

    for (var j = 1; j < pts.length; j++) {
      var lv = levelOf(smoothed[j]);
      if (lv !== curLevel) {
        curPts.push(pts[j]);            // 把拐点接到前一段，段间不会出现缝隙
        segs.push({ points: curPts, level: curLevel });
        curPts = [pts[j]];
        curLevel = lv;
      } else {
        curPts.push(pts[j]);
      }
    }
    if (curPts.length >= 2) segs.push({ points: curPts, level: curLevel });

    return segs;
  }

  /* ------------------------------------------------------------------ *
   * 初始化
   * ------------------------------------------------------------------ */

  /** 图例按实际画出来的曲线生成，没有对应数据的条目就不出现 */
  function buildLegend(series) {
    var legend = makeDiv('profile-legend');

    function item(color, text) {
      var span = document.createElement('span');
      var i = document.createElement('i');
      i.style.background = color;
      span.appendChild(i);
      span.appendChild(document.createTextNode(text));
      return span;
    }

    if (series.hasEle) legend.appendChild(item('#2f6fed', '海拔'));
    if (series.hasSpd) legend.appendChild(item('#d97706', '速度'));
    return legend;
  }

  function init() {
    el.profile = document.getElementById('profile');
    el.section = document.getElementById('profile-section');
  }

  global.Profile = {
    init: init,
    render: render,
    speedSegments: speedSegments,
    hasSeries: function () { return !!series; }
  };
})(window);
