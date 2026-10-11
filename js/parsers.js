/*!
 * parsers.js —— 轨迹文件解析器（GPX / TCX / KML）
 *
 * 设计要点：
 *   1. 以 XML 根元素名判定格式，而非文件扩展名 —— 用户把文件重命名为 .txt 也能解析。
 *   2. 全程忽略命名空间前缀（见 xmlutil.js），兼容华为 / Garmin / Strava / 佳明 等各厂商导出。
 *   3. 一个文件可能包含多条轨迹（GPX 多 <trk>、TCX 多 <Activity>、KML 多 <Placemark>），
 *      统一返回轨迹数组。
 *   4. 解析结果统一为标准化结构，供地图渲染层直接使用。
 *
 * 标准化轨迹结构：
 *   {
 *     name:       {string}  轨迹名称
 *     format:     {string}  'gpx' | 'tcx' | 'kml'
 *     points:     {Array}   [{lat, lon, ele, time, hr, cad, speed}]  lat/lon 为 WGS-84
 *     stats:      {Object}  统计信息（见 geo.js computeStats）
 *     segments:   {Array}   按时间断点切分后的分段数组，避免暂停期间画出直线
 *     meta:       {Object}  厂商、运动类型等附加信息
 *   }
 */
(function (global) {
  'use strict';

  var X = global.XmlUtil;
  var Geo = global.Geo;

  /* ------------------------------------------------------------------ *
   * 通用工具
   * ------------------------------------------------------------------ */

  /**
   * 修正速度单位。
   *
   * 各厂商 GPX 扩展中的 <speed> 单位并不统一：Garmin/华为通常是 m/s，
   * 但部分工具会写 km/h。若直接用错会导致"最高速度 150km/h"这类荒谬结果。
   *
   * 判定方法：当文件自带时间戳时，用「距离/时间」推算一组参考速度，
   * 比较两者中位数比值；接近 3.6 则说明文件用的是 km/h，需除以 3.6。
   */
  function normalizeSpeedUnit(points) {
    var declared = [];
    var derived = [];
    for (var i = 0; i < points.length; i++) {
      var p = points[i];
      if (typeof p.speed === 'number' && isFinite(p.speed) && p.speed > 0) declared.push(p.speed);
      if (i > 0) {
        var a = points[i - 1];
        if (typeof a.time === 'number' && typeof p.time === 'number' && p.time > a.time) {
          var dt = (p.time - a.time) / 1000;
          var d = Geo.distance(a.lat, a.lon, p.lat, p.lon);
          if (dt > 0.5 && d > 1) derived.push(d / dt);
        }
      }
    }
    if (declared.length < 10 || derived.length < 10) return points;

    var medianDeclared = median(declared);
    var medianDerived = median(derived);
    if (medianDerived <= 0.1 || medianDeclared <= 0.1) return points;

    var ratio = medianDeclared / medianDerived;
    // 比值接近 3.6 判定为 km/h；接近 1 判定为 m/s；其他比值不做处理（可能是设备平滑差异）
    if (ratio > 2.5 && ratio < 5.0) {
      for (var j = 0; j < points.length; j++) {
        if (typeof points[j].speed === 'number') points[j].speed = points[j].speed / 3.6;
      }
    }
    return points;
  }

  function median(arr) {
    if (!arr.length) return 0;
    var sorted = arr.slice().sort(function (a, b) { return a - b; });
    var mid = Math.floor(sorted.length / 2);
    return sorted.length % 2 ? sorted[mid] : (sorted[mid - 1] + sorted[mid]) / 2;
  }

  /**
   * 清理轨迹点序列：
   *   - 剔除经纬度非法（NaN / 超出范围 / 0,0 空点）的采样点
   *   - 剔除完全重复的相邻点（部分设备会写入重复点，导致长度虚增）
   */
  function cleanPoints(points) {
    var out = [];
    var prev = null;
    for (var i = 0; i < points.length; i++) {
      var p = points[i];
      if (typeof p.lat !== 'number' || typeof p.lon !== 'number') continue;
      if (!isFinite(p.lat) || !isFinite(p.lon)) continue;
      if (p.lat < -90 || p.lat > 90 || p.lon < -180 || p.lon > 180) continue;
      // (0,0) 是典型的无效占位坐标（几内亚湾），华为设备在未定位时可能写入
      if (p.lat === 0 && p.lon === 0) continue;
      // 跳过与前一个点完全重合的点（保留时间信息更完整的那个）
      if (prev && p.lat === prev.lat && p.lon === prev.lon && p.ele === prev.ele) continue;
      out.push(p);
      prev = p;
    }
    return out;
  }

  /**
   * 组装一条标准轨迹：清洗 → 单位修正 → 分段 → 统计。
   * @param {Object} raw {name, format, points, meta}
   * @returns {Object|null} 标准轨迹对象，点数为 0 时返回 null
   */
  function buildTrack(raw) {
    var points = cleanPoints(raw.points || []);
    if (points.length < 2) return null;

    normalizeSpeedUnit(points);

    var track = {
      name: raw.name || '未命名轨迹',
      format: raw.format,
      points: points,
      segments: Geo.splitByTimeGap(points, 300),
      stats: Geo.computeStats(points),
      meta: raw.meta || {}
    };
    // 只有一条连续段时，segments 就是它本身
    if (!track.segments.length) track.segments = [points];

    applyDeviceTotals(track);
    return track;
  }

  /**
   * 优先采用设备在文件里自报的汇总数据。
   *
   * 为什么不用自己算的？
   *   导出的轨迹点是设备**降采样**之后的，而设备的「暂停判定」来自它自己的
   *   传感器和内部状态，从这些点里根本推不出来。实测 44 个真实的华为导出文件：
   *   用「速度 > 0.5 m/s 的时长之和」去逼近设备上报的 totalTime，合计偏差
   *   只有 0.01%，看起来完美 —— 但那是正负相抵的巧合，单条最大偏差
   *   能到 −37%（某个文件里有一段 31 分钟的采样空档，设备显然按自己的
   *   规则处理了它，文件里看不出是怎么处理的）。
   *
   *   设备把正确答案直接写在文件里了（GPX 在 <trk><extensions>、
   *   TCX 在 <Lap>、KML 在 <ExtendedData>），那就不该去猜。
   *
   * 自己算的值同时保留在 stats.computedDistance / computedMovingTime 里，
   * 一是便于排查，二是文件里没有汇总字段时（Garmin / Strava 导出常常没有）
   * 界面仍然有数可显示。
   */
  function applyDeviceTotals(track) {
    var meta = track.meta || {};
    var stats = track.stats;

    stats.computedDistance = stats.distance;
    stats.computedMovingTime = stats.movingTime;

    // 距离：与逐点累加的结果对一下，差得太离谱就认为文件里的值是脏数据，宁可用自己算的
    var d = meta.deviceTotalDistance;
    if (typeof d === 'number' && isFinite(d) && d > 0) {
      if (!(stats.distance > 0) || Math.abs(d - stats.distance) / stats.distance < 0.5) {
        stats.distance = d;
        stats.distanceSource = 'device';
      }
    }
    if (!stats.distanceSource) stats.distanceSource = 'computed';

    // 时长：设备上报的是「运动时长」，与 movingTime 是同一种东西。
    // 只做一条硬校验：不可能骑得比首末点的挂钟跨度还久。
    var t = meta.deviceTotalTime;
    if (typeof t === 'number' && isFinite(t) && t > 0) {
      if (!(stats.duration > 0) || t <= stats.duration * 1.05) {
        stats.movingTime = t;
        stats.timeSource = 'device';
      }
    }
    if (!stats.timeSource) stats.timeSource = 'computed';

    // 爬升：设备没报就保持自己算的结果（通常是 0，因为文件里没有海拔）
    var c = meta.deviceClimb;
    if (typeof c === 'number' && isFinite(c) && c > 0 && !stats.hasElevation) {
      stats.elevationGain = c;
      stats.elevationSource = 'device';
    }

    // 均速随之更新，否则会出现「用时变了、均速没变」的自相矛盾
    if (stats.movingTime > 0) {
      stats.movingAvgSpeed = stats.distance / stats.movingTime;
    }
    if (stats.duration > 0) {
      stats.avgSpeed = stats.distance / stats.duration;
    }
  }

  /** 生成默认轨迹名：优先用文件内名称，否则用「格式 + 时间」 */
  function fallbackName(doc, format, index, extra) {
    if (extra) return extra;
    return format.toUpperCase() + ' 轨迹' + (index > 0 ? ' ' + (index + 1) : '');
  }

  /* ------------------------------------------------------------------ *
   * GPX 解析
   * ------------------------------------------------------------------ */

  /**
   * 解析 GPX。
   *
   * 华为运动健康导出结构：
   *   <gpx creator="HUAWEI Health">
   *     <metadata><name>骑行</name><time>...</time></metadata>
   *     <trk>
   *       <name>骑行</name><type>cycling</type>
   *       <trkseg>
   *         <trkpt lat=".." lon="..">
   *           <ele>..</ele><time>..</time>
   *           <extensions><ns3:TrackPointExtension>
   *             <ns3:hr>..</ns3:hr><ns3:cad>..</ns3:cad><ns3:speed>..</ns3:speed>
   *           </ns3:TrackPointExtension></extensions>
   *         </trkpt>
   *       </trkseg>
   *     </trk>
   *   </gpx>
   */
  function parseGpx(doc) {
    var root = doc.documentElement;
    var meta = {
      creator: X.attr(root, 'creator') || '',
      sport: null
    };

    // --- 从 metadata 读取整体信息 ---
    var metaNode = X.child(root, 'metadata');
    var fileTitle = X.textOf(metaNode, 'name');
    var fileTime = X.textOf(metaNode, 'time');

    var tracks = [];
    var trkNodes = X.children(root, 'trk');

    // 没有 <trk> 时尝试解析 <rte>（路线）作为兜底
    if (!trkNodes.length) {
      var rteNodes = X.children(root, 'rte');
      for (var r = 0; r < rteNodes.length; r++) {
        trkNodes.push(rteNodes[r]);
      }
      // 只有 rtept 的情况下，把它们当作 trkpt 处理
      if (rteNodes.length) meta.routeOnly = true;
    }

    for (var i = 0; i < trkNodes.length; i++) {
      var trk = trkNodes[i];
      var trkName = X.textOf(trk, 'name');
      var trkType = X.textOf(trk, 'type');
      if (trkType && !meta.sport) meta.sport = trkType;

      var points = [];
      var segNodes = X.children(trk, 'trkseg');
      var ptNodes = [];

      if (segNodes.length) {
        // 多段：逐段展开。段内的点连续，段之间视为不连续（由后续 splitByTimeGap 再次把关）
        for (var s = 0; s < segNodes.length; s++) {
          var segPts = X.children(segNodes[s], 'trkpt');
          for (var sp = 0; sp < segPts.length; sp++) ptNodes.push(segPts[sp]);
        }
      } else {
        // 有些文件省略 trkseg，trkpt 直接挂在 trk 下
        ptNodes = X.children(trk, 'trkpt');
        if (!ptNodes.length) ptNodes = X.children(trk, 'rtept');
      }

      for (var p = 0; p < ptNodes.length; p++) {
        var node = ptNodes[p];
        var lat = parseFloat(X.attr(node, 'lat'));
        var lon = parseFloat(X.attr(node, 'lon'));
        var pt = {
          lat: lat,
          lon: lon,
          ele: X.numOf(node, 'ele'),
          time: X.parseTime(X.textOf(node, 'time')),
          hr: null,
          cad: null,
          speed: null
        };

        // 扩展字段：不同厂商标签名不同，逐个按本地名查找
        var ext = X.first(node, 'extensions');
        if (ext) {
          pt.hr = pickNumber(ext, ['hr', 'heartrate', 'heartRateBpm', 'Value']);
          pt.cad = pickNumber(ext, ['cad', 'cadence']);
          pt.speed = pickNumber(ext, ['speed', 'enhancedSpeed']);
          pt.power = pickNumber(ext, ['power', 'watts', 'PowerInWatts']);
          pt.atemp = pickNumber(ext, ['atemp', 'temp', 'temperature']);
        }

        points.push(pt);
      }

      // <trk><extensions> 里是设备自报的汇总（totalTime / totalDistance /
      // cumulativeClimb）。华为运动健康导出的 GPX 把汇总放在这里，
      // 而不是逐点写入 —— 见 applyDeviceTotals 里关于为什么优先用它的说明。
      var dev = {};
      var trkExt = X.first(trk, 'extensions');
      if (trkExt) {
        dev.deviceTotalTime = X.numOf(trkExt, 'totalTime');
        dev.deviceTotalDistance = X.numOf(trkExt, 'totalDistance');
        dev.deviceClimb = X.numOf(trkExt, 'cumulativeClimb');
      }

      var built = buildTrack({
        name: trkName || fileTitle || fallbackName(doc, 'gpx', i),
        format: 'gpx',
        points: points,
        meta: {
          creator: meta.creator,
          sport: trkType || meta.sport,
          fileTime: fileTime,
          deviceTotalTime: dev.deviceTotalTime,
          deviceTotalDistance: dev.deviceTotalDistance,
          deviceClimb: dev.deviceClimb
        }
      });
      if (built) tracks.push(built);
    }

    return { tracks: tracks, meta: meta };
  }

  /** 在一组候选本地名中，返回第一个能解析出数值的字段 */
  function pickNumber(root, names) {
    for (var i = 0; i < names.length; i++) {
      var v = X.numOf(root, names[i]);
      if (v !== null) return v;
    }
    return null;
  }

  /* ------------------------------------------------------------------ *
   * TCX 解析
   * ------------------------------------------------------------------ */

  /**
   * 解析 TCX。
   *
   * 华为运动健康导出结构：
   *   <TrainingCenterDatabase>
   *     <Activities>
   *       <Activity Sport="Biking">
   *         <Id>2024-05-01T08:00:00Z</Id>
   *         <Lap StartTime="..">
   *           <TotalTimeSeconds>..</TotalTimeSeconds>
   *           <DistanceMeters>..</DistanceMeters>
   *           <Track>
   *             <Trackpoint>
   *               <Time>..</Time>
   *               <Position>
   *                 <LatitudeDegrees>..</LatitudeDegrees>
   *                 <LongitudeDegrees>..</LongitudeDegrees>
   *               </Position>
   *               <AltitudeMeters>..</AltitudeMeters>
   *               <DistanceMeters>..</DistanceMeters>
   *               <HeartRateBpm><Value>..</Value></HeartRateBpm>
   *               <Cadence>..</Cadence>
   *               <Extensions><ns3:TPX><ns3:Speed>..</ns3:Speed></ns3:TPX></Extensions>
   *             </Trackpoint>
   *           </Track>
   *         </Lap>
   *       </Activity>
   *     </Activities>
   *   </TrainingCenterDatabase>
   */
  function parseTcx(doc) {
    var root = doc.documentElement;
    var activities = X.all(root, 'Activity');
    var tracks = [];

    for (var i = 0; i < activities.length; i++) {
      var act = activities[i];
      var sport = X.attr(act, 'Sport') || '';
      var idText = X.textOf(act, 'Id');
      var actName = X.textOf(act, 'Name');

      var points = [];
      var devDist = 0, devTime = 0, hasDev = false;

      // 一条 Activity 可能有多个 Lap（自动计圈），全部合并为一条轨迹
      var laps = X.children(act, 'Lap');
      for (var l = 0; l < laps.length; l++) {
        // Lap 上的汇总。必须用 child（只看直接子元素）而不是 numOf（深度优先），
        // 因为 <DistanceMeters> 也可能出现在每个 <Trackpoint> 里，
        // 深度优先会先捞到轨迹点的那个，把汇总当成单点的里程。
        var lapDist = X.num(X.child(laps[l], 'DistanceMeters'));
        var lapTime = X.num(X.child(laps[l], 'TotalTimeSeconds'));
        if (lapDist !== null) { devDist += lapDist; hasDev = true; }
        if (lapTime !== null) { devTime += lapTime; hasDev = true; }

        var trackNodes = X.children(laps[l], 'Track');
        for (var t = 0; t < trackNodes.length; t++) {
          var tpNodes = X.children(trackNodes[t], 'Trackpoint');
          for (var k = 0; k < tpNodes.length; k++) {
            var tp = tpNodes[k];
            var posNode = X.child(tp, 'Position');
            if (!posNode) continue; // 无定位的点（如室内热身）跳过

            var lat = X.numOf(posNode, 'LatitudeDegrees');
            var lon = X.numOf(posNode, 'LongitudeDegrees');
            if (lat === null || lon === null) continue;

            var pt = {
              lat: lat,
              lon: lon,
              ele: X.numOf(tp, 'AltitudeMeters'),
              time: X.parseTime(X.textOf(tp, 'Time')),
              hr: null,
              cad: X.numOf(tp, 'Cadence'),
              speed: null
            };

            // 心率在 <HeartRateBpm><Value> 中
            var hrNode = X.child(tp, 'HeartRateBpm');
            if (hrNode) pt.hr = X.numOf(hrNode, 'Value');
            if (pt.hr === null) pt.hr = X.numOf(tp, 'HeartRate');

            // 速度在 <Extensions><TPX><Speed> 中
            var ext = X.child(tp, 'Extensions');
            if (ext) {
              pt.speed = pickNumber(ext, ['Speed', 'speed', 'enhancedSpeed']);
              if (pt.cad === null) pt.cad = pickNumber(ext, ['RunCadence', 'Cadence']);
              if (pt.hr === null) pt.hr = pickNumber(ext, ['HeartRate', 'hr']);
              pt.power = pickNumber(ext, ['Watts', 'Power', 'power']);
            }

            // TCX 自带累计里程字段，保存备用
            pt.dist = X.numOf(tp, 'DistanceMeters');

            points.push(pt);
          }
        }
      }

      var name = actName || idText || fallbackName(doc, 'tcx', i);
      var built = buildTrack({
        name: name,
        format: 'tcx',
        points: points,
        meta: {
          sport: sport,
          id: idText,
          creator: 'TrainingCenterDatabase',
          deviceTotalDistance: hasDev && devDist > 0 ? devDist : null,
          deviceTotalTime: hasDev && devTime > 0 ? devTime : null
        }
      });
      if (built) {
        built.meta.sport = sport;
        tracks.push(built);
      }
    }

    return { tracks: tracks, meta: {} };
  }

  /* ------------------------------------------------------------------ *
   * KML 解析
   * ------------------------------------------------------------------ */

  /**
   * 解析 KML。
   *
   * 两种常见结构：
   *   A) <Placemark><LineString><coordinates>lon,lat,alt lon,lat,alt</coordinates></LineString></Placemark>
   *   B) <Placemark><gx:Track><when>..</when><gx:coord>lon lat alt</gx:coord></gx:Track></Placemark>
   *
   * 注意：KML 坐标顺序是 **经度,纬度,海拔**（lon,lat,alt），与 GPX 的 lat/lon 顺序相反，
   *      这是最容易写错的地方。
   */
  function parseKml(doc) {
    var root = doc.documentElement;
    var docName = X.textOf(root, 'name');

    var placemarks = X.all(root, 'Placemark');
    var tracks = [];

    // 有些导出工具（含华为）不用 LineString / gx:Track，而是把**每个轨迹点
    // 单独写成一个 Placemark**，时间放在 <TimeSpan> 里。这样的 Placemark 每个
    // 只有一个点，按「一个 Placemark 一条轨迹」处理的话全都凑不够两个点，
    // 会被整体丢弃 —— 表现就是整份文件提示「没有找到有效的轨迹数据」。
    //
    // 所以这里把这类单点 Placemark 先收集起来，若最终没有形成任何轨迹，
    // 就把它们按时间合成一条。带时间的才是轨迹点；不带时间的是 Start/End
    // 之类的标记，跳过（它们的坐标与首末轨迹点重合，合并进去会多出重复点）。
    var loose = [];

    for (var i = 0; i < placemarks.length; i++) {
      var pm = placemarks[i];
      var pmName = X.textOf(pm, 'name');
      var pmDesc = X.textOf(pm, 'description');

      // 时间范围（用于多轨迹按时间排序）
      var timeSpan = X.child(pm, 'TimeSpan');
      var begin = timeSpan ? X.parseTime(X.textOf(timeSpan, 'begin')) : null;
      var end = timeSpan ? X.parseTime(X.textOf(timeSpan, 'end')) : null;
      if (begin === null) begin = X.parseTime(X.textOf(pm, 'TimeStamp')); // TimeStamp>when

      var points = [];

      // ---- 结构 B：gx:Track（带时间戳的逐点记录，信息最全）----
      var gxTracks = X.all(pm, 'Track');
      if (gxTracks.length) {
        for (var g = 0; g < gxTracks.length; g++) {
          var whenNodes = X.children(gxTracks[g], 'when');
          var coordNodes = X.children(gxTracks[g], 'coord'); // gx:coord → 本地名 coord
          var count = Math.min(whenNodes.length, coordNodes.length);
          for (var c = 0; c < count; c++) {
            var parsed = parseKmlCoordText(X.text(coordNodes[c]));
            if (!parsed) continue;
            points.push({
              lat: parsed[1],
              lon: parsed[0],
              ele: parsed[2],
              time: X.parseTime(X.text(whenNodes[c])),
              hr: null, cad: null, speed: null
            });
          }
        }
      }

      // ---- 结构 A：LineString / MultiGeometry ----
      if (!points.length) {
        var lineStrings = X.all(pm, 'LineString');
        for (var ls = 0; ls < lineStrings.length; ls++) {
          var coordText = X.textOf(lineStrings[ls], 'coordinates');
          if (!coordText) continue;
          var arr = parseKmlCoordinates(coordText);
          for (var a = 0; a < arr.length; a++) {
            points.push({
              lat: arr[a][1],
              lon: arr[a][0],
              ele: arr[a][2],
              time: null,
              hr: null, cad: null, speed: null
            });
          }
        }
      }

      // ---- 结构 C：只有 Point 的航点集合（每个 Placemark 一个点）----
      if (!points.length) {
        var pointNodes = X.all(pm, 'Point');
        for (var pn = 0; pn < pointNodes.length; pn++) {
          var pc = parseKmlCoordText(X.textOf(pointNodes[pn], 'coordinates'));
          if (pc) {
            points.push({ lat: pc[1], lon: pc[0], ele: pc[2], time: null, hr: null, cad: null, speed: null });
          }
        }
      }

      if (!points.length) continue;

      // KML 的点没有自带时间时，若 TimeSpan 可用则用 begin/end 给首末点补上，
      // 这样多轨迹叠加时仍能按时间排序。
      if (begin !== null && points[0].time === null) points[0].time = begin;
      if (end !== null && points[points.length - 1].time === null) points[points.length - 1].time = end;

      if (points.length === 1) {
        // 单点 Placemark：暂存，等确定没有真正的轨迹时再合成
        if (points[0].time !== null) {
          points[0].__pmName = pmName;
          loose.push(points[0]);
        }
        continue;
      }

      var built = buildTrack({
        name: pmName || docName || fallbackName(doc, 'kml', i),
        format: 'kml',
        points: points,
        meta: { description: pmDesc, begin: begin, end: end }
      });
      if (built) tracks.push(built);
    }

    // 一个正经轨迹都没有，但攒了一堆带时间的单点 —— 那就是「每点一个地标」的写法
    if (!tracks.length && loose.length >= 2) {
      var merged = mergeLoosePoints(loose);
      var ext = kmlExtendedData(root);
      var built2 = buildTrack({
        name: docName || fallbackName(doc, 'kml', 0),
        format: 'kml',
        points: merged,
        meta: {
          source: 'single-point-placemarks',
          deviceTotalDistance: ext.deviceTotalDistance,
          deviceTotalTime: ext.deviceTotalTime,
          deviceClimb: ext.deviceClimb
        }
      });
      if (built2) tracks.push(built2);
    }

    return { tracks: tracks, meta: {} };
  }

  /**
   * 把零散的单点合成一条有序轨迹。
   * 文件里本来就是按时间顺序写的，只有在明显乱序时才排序 ——
   * 无脑排序会在时间戳相同（同一秒内两个点）时打乱原有的先后。
   */
  function mergeLoosePoints(loose) {
    var sorted = true;
    for (var i = 1; i < loose.length; i++) {
      if (loose[i].time < loose[i - 1].time) { sorted = false; break; }
    }
    var list = sorted ? loose.slice() : loose.slice().sort(function (a, b) {
      return a.time - b.time;
    });
    // 清掉临时字段，避免写进存储
    for (var j = 0; j < list.length; j++) delete list[j].__pmName;
    return list;
  }

  /**
   * 读取 KML 的 <ExtendedData>，里面是设备自报的汇总数据。
   * 结构： <ExtendedData><Data name="totalDistance"><value>33686.0</value></Data>…</ExtendedData>
   */
  function kmlExtendedData(root) {
    var out = {};
    var ext = X.first(root, 'ExtendedData');
    if (!ext) return out;

    var datas = X.all(ext, 'Data');
    for (var i = 0; i < datas.length; i++) {
      var key = X.attr(datas[i], 'name');
      if (!key) continue;
      var v = X.numOf(datas[i], 'value');
      if (v === null) continue;
      if (key === 'totalDistance') out.deviceTotalDistance = v;
      else if (key === 'totalTime') out.deviceTotalTime = v;
      else if (key === 'cumulativeClimb') out.deviceClimb = v;
    }
    return out;
  }

  /**
   * 解析 KML <coordinates> 文本。
   * 格式：每对/每组坐标用空白分隔，组内用逗号分隔，顺序为 经度,纬度[,海拔]
   * 例如：  "116.397,39.908,45\n116.398,39.909,46"
   * @returns {Array<Array<number>>} [[lon, lat, ele|null], ...]
   */
  function parseKmlCoordinates(text) {
    var out = [];
    if (!text) return out;
    // 先按空白（空格/换行/制表符）切分成坐标组
    var groups = String(text).replace(/^\s+|\s+$/g, '').split(/\s+/);
    for (var i = 0; i < groups.length; i++) {
      var parsed = parseKmlCoordText(groups[i]);
      if (parsed) out.push(parsed);
    }
    return out;
  }

  /**
   * 解析单个坐标组，兼容逗号分隔（LineString）与空格分隔（gx:coord）两种写法。
   * @returns {Array|null} [lon, lat, ele|null]
   */
  function parseKmlCoordText(text) {
    if (!text) return null;
    var t = String(text).replace(/^\s+|\s+$/g, '');
    if (!t) return null;
    var parts = t.split(',');
    if (parts.length === 1) parts = t.split(/\s+/); // gx:coord 用空格分隔
    if (parts.length < 2) return null;

    var lon = parseFloat(parts[0]);
    var lat = parseFloat(parts[1]);
    var ele = parts.length > 2 ? parseFloat(parts[2]) : null;

    if (!isFinite(lon) || !isFinite(lat)) return null;
    if (ele !== null && !isFinite(ele)) ele = null;
    return [lon, lat, ele];
  }

  /* ------------------------------------------------------------------ *
   * 统一入口
   * ------------------------------------------------------------------ */

  /** 根据 XML 根元素名判断格式 */
  function detectFormat(doc, fileName) {
    var root = X.rootName(doc);
    if (root === 'gpx') return 'gpx';
    if (root === 'TrainingCenterDatabase') return 'tcx';
    if (root === 'kml') return 'kml';

    // 根元素无法识别时退回扩展名判断
    var ext = String(fileName || '').toLowerCase().split('.').pop();
    if (ext === 'gpx' || ext === 'tcx' || ext === 'kml') return ext;
    return null;
  }

  /**
   * 解析单个轨迹文件内容。
   * @param {string} content 文件文本内容
   * @param {string} fileName 文件名（用于格式兜底判断与默认命名）
   * @returns {{ok: boolean, tracks: Array, format: string|null, error: string|null}}
   */
  function parseFileContent(content, fileName) {
    if (content === null || content === undefined || content === '') {
      return { ok: false, tracks: [], format: null, error: '文件内容为空' };
    }

    var res = X.parseXml(content);
    if (!res.doc) {
      return { ok: false, tracks: [], format: null, error: res.error };
    }

    var format = detectFormat(res.doc, fileName);
    if (!format) {
      return {
        ok: false, tracks: [], format: null,
        error: '无法识别的文件格式（仅支持 .gpx / .tcx / .kml）'
      };
    }

    // 本函数对上层承诺「永不抛异常」——任何单文件的问题都转成 ok:false 返回，
    // 这样批量导入时一个坏文件不会中断整批处理。
    var out;
    try {
      if (format === 'gpx') out = parseGpx(res.doc);
      else if (format === 'tcx') out = parseTcx(res.doc);
      else out = parseKml(res.doc);
    } catch (e) {
      return { ok: false, tracks: [], format: format, error: '解析出错：' + (e && e.message ? e.message : String(e)) };
    }

    if (!out.tracks.length) {
      return {
        ok: false, tracks: [], format: format,
        error: '文件中没有找到有效的轨迹数据（可能是只有航点的文件，或所有坐标均无效）'
      };
    }

    return { ok: true, tracks: out.tracks, format: format, error: null };
  }

  global.Parsers = {
    parseFileContent: parseFileContent,
    detectFormat: detectFormat,
    parseGpx: parseGpx,
    parseTcx: parseTcx,
    parseKml: parseKml,
    parseKmlCoordinates: parseKmlCoordinates,
    cleanPoints: cleanPoints,
    normalizeSpeedUnit: normalizeSpeedUnit
  };
})(window);
