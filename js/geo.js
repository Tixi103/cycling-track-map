/*!
 * geo.js —— 地理计算工具：距离、抽稀、统计分析
 *
 * 包含三部分能力：
 *   1. Haversine 球面距离计算（配合多点累计得到总里程）
 *   2. Douglas-Peucker 轨迹抽稀 —— 万点级轨迹直接绘制会卡顿，抽稀后视觉几乎无差别但渲染快数倍
 *   3. 骑行统计 —— 总里程、爬升、耗时、均速、极速等
 */
(function (global) {
  'use strict';

  var EARTH_R = 6371008.8; // 地球平均半径（米），IUGG 推荐值

  /** 角度转弧度 */
  function rad(d) { return d * Math.PI / 180; }

  /**
   * Haversine 公式计算两点球面距离。
   * 相比勾股近似，在高纬度与长距离下更准确。
   * @returns {number} 距离（米）
   */
  function distance(lat1, lon1, lat2, lon2) {
    var dLat = rad(lat2 - lat1);
    var dLon = rad(lon2 - lon1);
    var a = Math.sin(dLat / 2) * Math.sin(dLat / 2) +
            Math.cos(rad(lat1)) * Math.cos(rad(lat2)) *
            Math.sin(dLon / 2) * Math.sin(dLon / 2);
    var c = 2 * Math.atan2(Math.sqrt(a), Math.sqrt(1 - a));
    return EARTH_R * c;
  }

  /**
   * 计算两点连线在「局部平面」上的近似投影坐标差。
   * 用于抽稀时做垂直距离判断 —— 小范围内把经纬度当作平面直角坐标处理，误差可忽略。
   */
  function projectToMeters(lat, lon, lat0, lon0) {
    var x = rad(lon - lon0) * Math.cos(rad((lat + lat0) / 2)) * EARTH_R;
    var y = rad(lat - lat0) * EARTH_R;
    return [x, y];
  }

  /** 点到线段的垂直距离（平面近似，单位米） */
  function perpendicularDistance(p, a, b) {
    var pa = projectToMeters(p.lat, p.lon, a.lat, a.lon);
    var pb = projectToMeters(b.lat, b.lon, a.lat, a.lon);
    var px = pa[0], py = pa[1];
    var bx = pb[0], by = pb[1];

    var sqLen = bx * bx + by * by;
    if (sqLen === 0) return Math.sqrt(px * px + py * py); // a 与 b 重合

    // 把点投影到线段所在直线上，并夹紧到 [0,1] 区间
    var t = (px * bx + py * by) / sqLen;
    if (t < 0) t = 0; else if (t > 1) t = 1;

    var dx = px - t * bx;
    var dy = py - t * by;
    return Math.sqrt(dx * dx + dy * dy);
  }

  /**
   * Douglas-Peucker 轨迹抽稀（迭代实现，避免递归过深导致栈溢出）。
   *
   * 思路：保留首尾点，找出离首尾连线最远的点，若超过容差则保留该点并递归处理两侧。
   * 骑行轨迹用 2~5 米容差抽稀后肉眼几乎无差别，但点数可减少 60%~90%。
   *
   * @param {Array} points 轨迹点数组 [{lat, lon, ...}]
   * @param {number} tolerance 容差（米），<=0 表示不抽稀
   * @returns {Array} 抽稀后的点数组（元素引用原始对象，保留 ele/time 等字段）
   */
  function simplify(points, tolerance) {
    var n = points.length;
    if (!(tolerance > 0) || n <= 2) return points.slice();

    // keep[i] 标记第 i 个点是否保留
    var keep = new Uint8Array(n);
    keep[0] = 1;
    keep[n - 1] = 1;

    // 用显式栈代替递归：每项为 [起始下标, 结束下标]
    var stack = [[0, n - 1]];
    while (stack.length) {
      var seg = stack.pop();
      var first = seg[0];
      var last = seg[1];
      if (last - first < 2) continue;

      var maxDist = -1;
      var maxIdx = -1;
      var a = points[first];
      var b = points[last];

      for (var i = first + 1; i < last; i++) {
        var d = perpendicularDistance(points[i], a, b);
        if (d > maxDist) { maxDist = d; maxIdx = i; }
      }

      if (maxDist > tolerance) {
        keep[maxIdx] = 1;
        stack.push([first, maxIdx], [maxIdx, last]);
      }
    }

    var out = [];
    for (var j = 0; j < n; j++) {
      if (keep[j]) out.push(points[j]);
    }
    return out;
  }

  /**
   * 平滑速度值。
   * 原始逐点速度受 GPS 抖动影响很大（静止时也可能显示 20km/h），
   * 采用滑动窗口中位数 + 均值混合，得到更符合直觉的速度曲线。
   */
  function smoothSpeedSeries(points, windowSize) {
    var half = Math.floor((windowSize || 5) / 2);
    var n = points.length;
    var speeds = new Array(n);

    for (var i = 0; i < n; i++) {
      var lo = Math.max(0, i - half);
      var hi = Math.min(n - 1, i + half);
      var sum = 0;
      var cnt = 0;
      for (var j = lo; j <= hi; j++) {
        var s = points[j].speed;
        if (typeof s === 'number' && isFinite(s) && s >= 0) { sum += s; cnt++; }
      }
      speeds[i] = cnt ? sum / cnt : null;
    }
    return speeds;
  }

  /**
   * 为轨迹点补齐 speed 字段（若文件中没有速度信息则按相邻点距离/时间差推算）。
   * @param {Array} points
   * @returns {number[]} 与 points 等长的速度数组（m/s），无法计算处为 null
   */
  function deriveSpeeds(points, existing) {
    var n = points.length;
    var out = new Array(n);

    // 先看文件是否自带速度（华为 GPX/TCX 通常带 speed 扩展）
    var hasOwn = false;
    for (var k = 0; k < n; k++) {
      if (typeof points[k].speed === 'number' && isFinite(points[k].speed)) { hasOwn = true; break; }
    }
    if (hasOwn && !existing) {
      for (var m = 0; m < n; m++) {
        var v = points[m].speed;
        out[m] = (typeof v === 'number' && isFinite(v) && v >= 0) ? v : null;
      }
      // 文件自带的速度同样要过一遍跳点过滤 —— 厂商写入的值也可能有尖刺
      return despikeSpeeds(points, out);
    }

    // 否则用相邻点推算
    for (var i = 0; i < n; i++) {
      var prev = points[i - 1];
      var cur = points[i];
      if (!prev || !cur || prev.time === null || cur.time === null || prev.time === undefined || cur.time === undefined) {
        // 没有时间信息时退化为使用自带 speed
        var sv = cur && cur.speed;
        out[i] = (typeof sv === 'number' && isFinite(sv) && sv >= 0) ? sv : null;
        continue;
      }
      var dt = (cur.time - prev.time) / 1000; // 秒
      if (dt <= 0) { out[i] = out[i - 1] !== undefined ? out[i - 1] : null; continue; }
      out[i] = distance(prev.lat, prev.lon, cur.lat, cur.lon) / dt;
    }
    // 注意顺序：**先过滤，再定首点的速度**。
    // 反过来的话跳点会被复制到首点，而首点没有「上一段」可供比较，
    // 加速度判据对它无从下手 —— 实测中 68.6 km/h 的跳点就是这样漏过去的。
    var cleaned = despikeSpeeds(points, out);
    if (n > 0) cleaned[0] = cleaned.length > 1 ? cleaned[1] : null;
    return cleaned;
  }

  /** 第 k 个采样点对应的时长（秒）——它是 k-1 → k 这一段 */
  function segmentSeconds(points, k) {
    if (k < 1) return 0;
    var a = points[k - 1], b = points[k];
    if (!a || !b) return 0;
    if (typeof a.time !== 'number' || typeof b.time !== 'number') return 0;
    var dt = (b.time - a.time) / 1000;
    return dt > 0 ? dt : 0;
  }

  /**
   * 剔除由 GPS 跳点造成的荒谬速度。
   *
   * 为什么需要：偶发的一个定位跳点（卫星信号短暂失锁后跳到几百米外再跳回来）
   * 会让相邻两点的距离骤增，算出来的速度能到 90 km/h 以上 —— 骑车不可能。
   * 实测用户的真实数据：某条轨迹速度中位数 15.3 km/h、99 分位 24.1 km/h，
   * 但最大值 94.7 km/h，全线只有 1 个点超过 60。这一个点会拉高「最高速度」，
   * 也会在速度曲线上戳出一根尖刺。
   *
   * 判据用「与邻域中位数的比值」而不是绝对阈值：
   * 绝对阈值要同时适配慢速通勤和高速下坡，定死了必然误伤一头。
   * 邻域中位数代表「当下这段路正常该有多快」，突然高出好几倍就是跳点。
   *
   * @param {Array} speeds 速度数组（m/s），原地不动，返回新数组
   * @returns {Array} 跳点位置置为 null
   */
  function despikeSpeeds(points, speeds) {
    var n = speeds.length;
    if (n < 5) return speeds;

    var out = speeds.slice();
    var i, j, v;

    /* ── 第一遍：与邻域中位数的比值 ──
       能抓住骑行途中偶发的一次跳点（定位短暂失锁后跳出去再跳回来）。
       窗口取前后各 15 个点，中位数代表「这段路正常该有多快」。 */
    var WIN = 15;
    // 倍率取 2.5 是实测出来的，不是拍的：
    //   4 倍太松 —— 起步段邻域中位数就有 21 km/h，4 倍是 84 km/h，
    //   实测中 69.5 km/h 的冷启动跳点正好从这个口子漏过去；
    //   2.5 倍能拦住它，又不会误伤真正的下坡 ——
    //   因为持续的高速会把邻域中位数一起抬上去，判据是自我校准的：
    //   下坡第 1 个采样点可能被判掉，但从第 2 个点起窗口里就全是高速值了。
    //   换句话说：**它只拦孤立尖刺，不拦持续高速**，这正是我们要的。
    var RATIO = 2.5;
    var FLOOR = 9;                                 // 至少超过 9 m/s(32 km/h) 才判，
                                                   // 免得在慢速路段误伤正常的加速
    var win = [];

    for (i = 0; i < n; i++) {
      v = out[i];
      if (typeof v !== 'number' || !isFinite(v)) continue;

      win.length = 0;
      var lo = Math.max(0, i - WIN);
      var hi = Math.min(n - 1, i + WIN);
      for (j = lo; j <= hi; j++) {
        var u = speeds[j];
        if (typeof u === 'number' && isFinite(u) && u >= 0) win.push(u);
      }
      if (win.length < 5) continue;

      win.sort(function (a, b) { return a - b; });
      var med = win[Math.floor(win.length / 2)];
      if (med <= 0) continue;

      if (v > Math.max(med * RATIO, FLOOR)) out[i] = null;
    }

    /* ── 第二遍：加速度校验 ──
       专门对付**起步阶段**的定位漂移。

       卫星刚锁定时的头几个定位点很不准，跳到十几米外是常事。实测用户的
       真实数据：某条轨迹前两个点分别是「19.4 米/1.01 秒」和「19.1 米/1.00 秒」，
       折合 69.5 和 68.6 km/h，而同一次骑行的中位速度只有 21 km/h，
       正常段每秒只走 6 米左右。

       比值判据在这里会失效 —— 起步段邻域的中位数本身就有 21 km/h，
       乘 4 倍是 86 km/h，拦不住 69.5。但加速度判据一眼就能看出来：
       从静止到 69.5 km/h 只需 1 秒的话，加速度得 19 m/s²，
       而人骑车的起步加速度也就 1~2 m/s²。

       上一个速度缺失或已被判为跳点时按「静止」处理 —— 骑行通常就是从静止起步的，
       而且未通过前面的过滤本身就说明那个值不可信。 */
    var A_MAX = 6;                                 // m/s²，远超骑行所能达到
    var prevV = 0;

    for (var k = 0; k < n; k++) {
      v = out[k];
      if (typeof v !== 'number' || !isFinite(v)) continue;   // 保持 prevV 不变

      var dt = segmentSeconds(points, k);
      if (dt > 0 && Math.abs(v - prevV) / dt > A_MAX) {
        out[k] = null;
        // 判掉之后要把基准重设成这个值，否则会连锁误伤：
        // 下一个点的「上一段」正是从这个被判定为坏点的位置出发的，
        // 它的速度本身就不可信；继续拿旧基准去比，会把后面一连串
        // 正常点也一起判掉。这里只负责认出「从静止突然跳高」这一种情况。
        prevV = v;
        continue;
      }
      prevV = v;
    }

    return out;
  }

  /**
   * 计算单条轨迹的统计信息。
   *
   * 关键处理：
   *   - 距离：逐点 Haversine 累计。为避免 GPS 静止漂移虚增里程，忽略位移 < 1 米的相邻点。
   *   - 爬升：原始海拔含噪，先做滑动平均再累加"正向爬升"，并设 0.4 米阈值过滤抖动。
   *   - 移动时间：速度 > 0.5 m/s 的采样点时间之和，比总时长更能反映真实骑行强度。
   *
   * @param {Array} points 原始点数组（WGS-84，含 time/ele）
   * @returns {Object} 统计结果
   */
  function computeStats(points) {
    var n = points.length;
    var stats = {
      pointCount: n,
      distance: 0,          // 总里程（米）
      elevationGain: 0,     // 累计爬升（米）
      elevationLoss: 0,     // 累计下降（米）
      maxElevation: null,
      minElevation: null,
      duration: 0,          // 总耗时（秒），基于首末点时间
      movingTime: 0,        // 移动耗时（秒）
      avgSpeed: 0,          // 全程均速（m/s）
      movingAvgSpeed: 0,    // 移动均速（m/s）
      maxSpeed: 0,          // 最高速度（m/s）
      startTime: null,      // 时间戳（毫秒）
      endTime: null,
      hasTime: false,
      hasElevation: false
    };
    if (n === 0) return stats;

    // ---------- 时间范围 ----------
    var t0 = null;
    var t1 = null;
    for (var i = 0; i < n; i++) {
      var t = points[i].time;
      if (typeof t === 'number' && isFinite(t)) {
        if (t0 === null || t < t0) t0 = t;
        if (t1 === null || t > t1) t1 = t;
      }
    }
    if (t0 !== null && t1 !== null) {
      stats.hasTime = true;
      stats.startTime = t0;
      stats.endTime = t1;
      stats.duration = Math.max(0, (t1 - t0) / 1000);
    }

    // ---------- 距离与速度 ----------
    var speeds = deriveSpeeds(points, false);
    var movingSeconds = 0;
    var movingDistance = 0;
    var maxSpeed = 0;

    for (var j = 1; j < n; j++) {
      var a = points[j - 1];
      var b = points[j];
      var seg = distance(a.lat, a.lon, b.lat, b.lon);

      // 过滤 GPS 静止漂移：位移过小的相邻点不计入里程
      if (seg < 1) seg = 0;
      stats.distance += seg;

      var v = speeds[j];
      if (typeof v === 'number' && isFinite(v)) {
        if (v > maxSpeed) maxSpeed = v;
        if (v > 0.5 && a.time !== null && b.time !== null && a.time !== undefined && b.time !== undefined) {
          var dt = (b.time - a.time) / 1000;
          if (dt > 0) { movingSeconds += dt; movingDistance += seg; }
        }
      }
    }

    stats.movingTime = movingSeconds;
    stats.maxSpeed = maxSpeed;

    if (stats.duration > 0) stats.avgSpeed = stats.distance / stats.duration;
    if (movingSeconds > 0) stats.movingAvgSpeed = movingDistance / movingSeconds;

    // ---------- 海拔 ----------
    var eles = [];
    for (var k = 0; k < n; k++) {
      var e = points[k].ele;
      if (typeof e === 'number' && isFinite(e)) eles.push(e);
    }
    if (eles.length >= 2) {
      stats.hasElevation = true;
      stats.maxElevation = Math.max.apply(null, eles);
      stats.minElevation = Math.min.apply(null, eles);

      // 滑动平均去噪，窗口取 5 个采样点
      var half = 2;
      var smoothed = new Array(n);
      for (var p = 0; p < n; p++) {
        var sum = 0, cnt = 0;
        for (var q = Math.max(0, p - half); q <= Math.min(n - 1, p + half); q++) {
          var ev = points[q].ele;
          if (typeof ev === 'number' && isFinite(ev)) { sum += ev; cnt++; }
        }
        smoothed[p] = cnt ? sum / cnt : null;
      }

      // 累加"正向爬升"与"负向下降"，0.4 米阈值过滤 GPS 海拔抖动
      var THRESHOLD = 0.4;
      var base = null;
      for (var r = 0; r < n; r++) {
        var cur = smoothed[r];
        if (cur === null) continue;
        if (base === null) { base = cur; continue; }
        var diff = cur - base;
        if (diff > THRESHOLD) { stats.elevationGain += diff; base = cur; }
        else if (diff < -THRESHOLD) { stats.elevationLoss += -diff; base = cur; }
      }
    }

    return stats;
  }

  /** 计算轨迹的包围盒，用于地图自动缩放到合适视野 */
  function bounds(points) {
    if (!points.length) return null;
    var minLat = Infinity, maxLat = -Infinity, minLon = Infinity, maxLon = -Infinity;
    for (var i = 0; i < points.length; i++) {
      var p = points[i];
      if (p.lat < minLat) minLat = p.lat;
      if (p.lat > maxLat) maxLat = p.lat;
      if (p.lon < minLon) minLon = p.lon;
      if (p.lon > maxLon) maxLon = p.lon;
    }
    return [[minLat, minLon], [maxLat, maxLon]];
  }

  /** 取轨迹中点（用于打标、定位），优先取累计里程一半处的点 */
  function midpoint(points) {
    if (!points.length) return null;
    var total = 0;
    var i;
    for (i = 1; i < points.length; i++) {
      total += distance(points[i - 1].lat, points[i - 1].lon, points[i].lat, points[i].lon);
    }
    var half = total / 2;
    var acc = 0;
    for (i = 1; i < points.length; i++) {
      acc += distance(points[i - 1].lat, points[i - 1].lon, points[i].lat, points[i].lon);
      if (acc >= half) return points[i];
    }
    return points[points.length - 1];
  }

  /**
   * 把轨迹按"时间间隔过大"切成多段。
   * 骑行途中暂停/关机后再记录，会产生跨越数小时甚至数天的两个相邻点，
   * 直接连线会在地图上画出一条笔直的错误线段。此处按阈值断开。
   * @param {Array} points
   * @param {number} maxGapSeconds 允许的最大时间间隔（秒），默认 300 秒
   * @returns {Array<Array>} 分段数组
   */
  function splitByTimeGap(points, maxGapSeconds) {
    var gap = maxGapSeconds || 300;
    if (!points.length) return [];

    // 先判断是否真的存在时间信息
    var hasTime = false;
    for (var i = 0; i < points.length; i++) {
      if (typeof points[i].time === 'number') { hasTime = true; break; }
    }
    if (!hasTime) return [points];

    var segments = [];
    var cur = [points[0]];
    for (var j = 1; j < points.length; j++) {
      var prev = points[j - 1];
      var now = points[j];
      var dt = (typeof prev.time === 'number' && typeof now.time === 'number')
        ? (now.time - prev.time) / 1000
        : 0;
      if (dt > gap) {
        segments.push(cur);
        cur = [now];
      } else {
        cur.push(now);
      }
    }
    segments.push(cur);

    // 过滤掉只有一个点的碎片段
    return segments.filter(function (s) { return s.length >= 2; });
  }

  global.Geo = {
    EARTH_R: EARTH_R,
    distance: distance,
    perpendicularDistance: perpendicularDistance,
    simplify: simplify,
    smoothSpeedSeries: smoothSpeedSeries,
    deriveSpeeds: deriveSpeeds,
    computeStats: computeStats,
    bounds: bounds,
    midpoint: midpoint,
    splitByTimeGap: splitByTimeGap
  };
})(window);
