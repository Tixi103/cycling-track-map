#!/usr/bin/env node
/*!
 * make-sample.js —— 生成仿真华为运动健康导出格式的样本文件
 *
 * 为什么需要它？
 *   本机没有任何真实的骑行轨迹文件，没有样本就无从验证解析链路。
 *   手敲几个坐标点造出来的文件测不出华为真实的字段差异（ns3: 命名空间扩展、
 *   速度单位、暂停断点），所以这里按华为导出的真实结构生成一套仿真样本。
 *   等拿到用户的真实文件后，再用真实文件跑一轮回归即可。
 *
 * 用法：
 *   node dev/make-sample.js            输出到 dev/samples/
 *   node dev/make-sample.js <目录>     输出到指定目录
 *
 * 产出：
 *   *.gpx / *.tcx / *.kml   可直接拖进页面手动测试的样本文件
 *   samples.js              把所有样本内联成 window.SAMPLES，
 *                           供 dev/selftest.html 用 <script> 加载
 *                           （file:// 下不能 fetch 本地文件，只能内联）
 *   sample-meta.js          各地面真值（真实里程/点数/段数），用于断言
 */

'use strict';

var fs = require('fs');
var path = require('path');

/* ------------------------------------------------------------------ *
 * 地理工具（这里独立实现，不能复用浏览器的 window.Geo）
 * ------------------------------------------------------------------ */

var EARTH_R = 6371008.8;

function rad(d) { return d * Math.PI / 180; }

/** Haversine 距离（米） */
function distance(lat1, lon1, lat2, lon2) {
  var dLat = rad(lat2 - lat1);
  var dLon = rad(lon2 - lon1);
  var a = Math.sin(dLat / 2) * Math.sin(dLat / 2) +
          Math.cos(rad(lat1)) * Math.cos(rad(lat2)) * Math.sin(dLon / 2) * Math.sin(dLon / 2);
  return EARTH_R * 2 * Math.atan2(Math.sqrt(a), Math.sqrt(1 - a));
}

/* ------------------------------------------------------------------ *
 * 路线生成
 * ------------------------------------------------------------------ */

// 中心点取北京奥林匹克公园附近（WGS-84）。
// 注意：生成的是合成路线，不追求落在真实道路上——它的用途是验证解析与渲染链路，
// 不是验证地图贴合度。地图贴合要用用户的真实文件来验。
var CENTER = { lat: 39.9930, lon: 116.3900 };

/**
 * 一条闭合的花瓣形路线（比正圆更像真实骑行路线，且有明显的方向变化）。
 * @param {number} t 归一化参数 [0,1)
 * @returns {{lat:number, lon:number}} WGS-84
 */
function routePoint(t) {
  var a = 2 * Math.PI * t;
  // 双瓣：基础椭圆 + 二次谐波扰动
  var latR = 0.0105;                     // 纬度方向半径（度）≈ 1.17km
  var lonR = 0.0152;                     // 经度方向半径（度）≈ 1.30km
  var lat = CENTER.lat + latR * Math.sin(a) * (1 + 0.18 * Math.cos(2 * a));
  var lon = CENTER.lon + lonR * Math.cos(a) * (1 + 0.12 * Math.sin(2 * a));
  return { lat: lat, lon: lon };
}

/**
 * 按固定弧长间隔把路线重采样成等间距点列。
 * 用等间距而不是等参数，是为了让后面「按速度推时间」有干净的对应关系。
 * @param {number} stepMeters 相邻点间距（米）
 * @returns {Array<{lat,lon}>}
 */
function resampleByArcLength(stepMeters) {
  // 先密集采样，累积弧长
  var dense = [];
  var N = 40000;
  for (var i = 0; i <= N; i++) dense.push(routePoint(i / N));

  // 闭合：把首点补到末尾，形成完整环路
  dense.push(routePoint(0));

  var cum = [0];
  for (var k = 1; k < dense.length; k++) {
    cum.push(cum[k - 1] + distance(dense[k - 1].lat, dense[k - 1].lon, dense[k].lat, dense[k].lon));
  }
  var total = cum[cum.length - 1];

  var out = [];
  var target = 0;
  var j = 0;
  while (target <= total) {
    while (j < cum.length - 1 && cum[j + 1] < target) j++;
    var segLen = cum[j + 1] - cum[j];
    var f = segLen > 0 ? (target - cum[j]) / segLen : 0;
    out.push({
      lat: dense[j].lat + (dense[j + 1].lat - dense[j].lat) * f,
      lon: dense[j].lon + (dense[j + 1].lon - dense[j].lon) * f
    });
    target += stepMeters;
  }
  return { points: out, totalMeters: total };
}

/**
 * 构造一条完整骑行记录：点列 + 时间戳 + 海拔 + 心率 + 踏频 + 速度。
 *
 * 速度曲线刻意做成非匀速，包含起步、巡航、一次停车、冲刺：
 *   —— 这样测出来的均速/极速才有区分度，匀速数据测不出统计口径的问题。
 *
 * @param {Object} opt
 *   stepMeters   相邻点间距（米）
 *   pauseAtMeter 在第几米处插入一次停车（用于制造时间断点），null 表示不停
 *   pauseSeconds 停车时长（秒）
 * @returns {{points:Array, meta:Object}}
 */
function buildRide(opt) {
  var step = opt.stepMeters || 7;
  var res = resampleByArcLength(step);
  var pts = res.points;

  var pauseAt = opt.pauseAtMeter === undefined ? null : opt.pauseAtMeter;
  var pauseSeconds = opt.pauseSeconds || 360;

  // 起点时间。各样本刻意分布在不同日期 —— 否则「按时间渐变」的配色模式
  // 只会落到同一档色阶，那条代码路径就等于没被测到。
  var t = (opt.startMs !== undefined) ? opt.startMs : Date.UTC(2024, 4, 1, 8, 0, 0);
  var out = [];
  var travelled = 0;
  var pauseDone = false;   // 停车只插一次。不能用「标记上一个点」来代替，
                           // 因为下一次迭代读到的又是新推入的点，防重会失效。

  for (var i = 0; i < pts.length; i++) {
    var p = pts[i];

    // v 必须每个点都有值（含首点）。若只在 i>0 分支里 var v，由于变量声明提升，
    // 首点的 v 是 undefined，会让首点的踏频与速度算成 NaN 写进文件。
    var v;
    if (i > 0) {
      travelled += distance(pts[i - 1].lat, pts[i - 1].lon, p.lat, p.lon);
      v = speedAt(travelled, res.totalMeters);
      t += Math.round(step / v * 1000);   // 该段的耗时
    } else {
      v = speedAt(0, res.totalMeters);
    }

    // 骑行中途停车：时间跳变，但坐标不跳。解析层应当据此把轨迹断开。
    if (pauseAt !== null && !pauseDone && travelled >= pauseAt && out.length) {
      t += pauseSeconds * 1000;
      pauseDone = true;
    }

    // 海拔：起伏 + 轻微噪声（真实 GPS 海拔含噪，考验统计层的去噪逻辑）
    var ele = 45 + 14 * Math.sin(travelled / 900) + 6 * Math.sin(travelled / 230)
              + (pseudoRandom(i * 7.13) - 0.5) * 1.2;

    // 心率：随强度爬升，带波动
    var hr = Math.round(112 + 38 * Math.min(1, travelled / 4000) + (pseudoRandom(i * 3.7) - 0.5) * 9);

    // 踏频：与速度正相关
    var cad = Math.round(62 + v * 3.4 + (pseudoRandom(i * 5.1) - 0.5) * 7);

    // 卫星定位抖动分两部分。这里刻意不用白噪声：
    //   真实 GPS 的误差以「慢变漂移」为主（多径效应、电离层延迟），相邻采样点之间高度相关。
    //   如果按逐点独立的白噪声来造，相邻点间距会被虚假拉长，算出来的里程能比真实里程
    //   长 20% 以上 —— 那样样本就无法用来校验统计口径了。
    var driftLat = 2.6e-5 * (Math.sin(i * 0.043) * 0.65 + Math.sin(i * 0.19 + 1.7) * 0.35); // ≈ ±2.9m
    var driftLon = 3.0e-5 * (Math.sin(i * 0.037 + 0.9) * 0.6 + Math.sin(i * 0.23 + 2.4) * 0.4); // ≈ ±2.9m
    var fastLat = (pseudoRandom(i * 11.3) - 0.5) * 2 * 3.0e-6;   // ≈ ±0.33m
    var fastLon = (pseudoRandom(i * 17.9) - 0.5) * 2 * 3.8e-6;
    var jitterLat = driftLat + fastLat;
    var jitterLon = driftLon + fastLon;

    out.push({
      lat: p.lat + jitterLat,
      lon: p.lon + jitterLon,
      ele: ele,
      time: t,
      hr: Math.max(90, Math.min(185, hr)),
      cad: Math.max(0, Math.min(120, cad)),
      speed: v
    });
  }

  var meta = {
    pointCount: out.length,
    pathMeters: res.totalMeters,
    durationSeconds: Math.round((out[out.length - 1].time - out[0].time) / 1000),
    startTime: out[0].time,
    endTime: out[out.length - 1].time
  };
  return { points: out, meta: meta };
}

/** 速度曲线（m/s）：起步加速 → 巡航 → 起伏 → 末段冲刺 */
function speedAt(s, total) {
  var f = s / total;
  if (f < 0.04) return 1.2 + (f / 0.04) * 5.0;          // 起步
  if (f > 0.96) return 6.2 - ((f - 0.96) / 0.04) * 5.4; // 收尾减速
  if (f > 0.88) return 8.4;                              // 冲刺
  return 6.0 + 1.5 * Math.sin(f * 22) + 0.8 * Math.sin(f * 61);
}

/** 确定性伪随机：保证每次生成的样本完全一致，断言才稳定 */
function pseudoRandom(seed) {
  var x = Math.sin(seed) * 43758.5453;
  return x - Math.floor(x);
}

/* ------------------------------------------------------------------ *
 * 三种格式的序列化
 * ------------------------------------------------------------------ */

function iso(t) { return new Date(t).toISOString().replace(/\.\d{3}Z$/, 'Z'); }
function fx(v, n) { return v.toFixed(n === undefined ? 6 : n); }

/**
 * 华为运动健康 GPX 结构。
 * 关键特征：creator="HUAWEI Health"、运动类型写在 <trk><type>、
 * 心率/踏频/速度在 <extensions><ns3:TrackPointExtension> 里（ns3 前缀正是解析层要忽略的）。
 */
function toGpx(points, opts) {
  opts = opts || {};
  var speedUnit = opts.speedInKmh ? 3.6 : 1;   // km/h 变体：考验速度单位自动纠正

  var lines = [];
  lines.push('<?xml version="1.0" encoding="UTF-8"?>');
  lines.push('<gpx creator="HUAWEI Health" version="1.1"');
  lines.push('     xmlns="http://www.topografix.com/GPX/1/1"');
  lines.push('     xmlns:ns3="http://www.garmin.com/xmlschemas/TrackPointExtension/v1">');
  lines.push('  <metadata>');
  lines.push('    <name>骑行</name>');
  lines.push('    <time>' + iso(points[0].time) + '</time>');
  lines.push('  </metadata>');
  lines.push('  <trk>');
  lines.push('    <name>骑行</name>');
  lines.push('    <type>cycling</type>');
  lines.push('    <trkseg>');

  var prevTime = null;
  for (var i = 0; i < points.length; i++) {
    var p = points[i];
    // 时间跳跃超过 5 分钟 → 另起一段，模拟真实设备在暂停时的分段写法
    if (prevTime !== null && (p.time - prevTime) / 1000 > 300) {
      lines.push('    </trkseg>');
      lines.push('    <trkseg>');
    }
    lines.push('      <trkpt lat="' + fx(p.lat) + '" lon="' + fx(p.lon) + '">');
    lines.push('        <ele>' + fx(p.ele, 1) + '</ele>');
    lines.push('        <time>' + iso(p.time) + '</time>');
    lines.push('        <extensions>');
    lines.push('          <ns3:TrackPointExtension>');
    lines.push('            <ns3:hr>' + p.hr + '</ns3:hr>');
    lines.push('            <ns3:cad>' + p.cad + '</ns3:cad>');
    lines.push('            <ns3:speed>' + fx(p.speed * speedUnit, 2) + '</ns3:speed>');
    lines.push('          </ns3:TrackPointExtension>');
    lines.push('        </extensions>');
    lines.push('      </trkpt>');
    prevTime = p.time;
  }

  lines.push('    </trkseg>');
  lines.push('  </trk>');
  lines.push('</gpx>');
  return lines.join('\n');
}

/** 华为运动健康 TCX 结构：多个 <Lap>（自动计圈），速度在 <ns3:TPX><ns3:Speed> */
function toTcx(points, opts) {
  opts = opts || {};
  var lapCount = opts.laps || 3;
  var perLap = Math.floor(points.length / lapCount);
  var speedUnit = opts.speedInKmh ? 3.6 : 1;

  var lines = [];
  lines.push('<?xml version="1.0" encoding="UTF-8"?>');
  lines.push('<TrainingCenterDatabase');
  lines.push('  xmlns="http://www.garmin.com/xmlschemas/TrainingCenterDatabase/v2"');
  lines.push('  xmlns:ns3="http://www.garmin.com/xmlschemas/ActivityExtension/v2">');
  lines.push('  <Activities>');
  lines.push('    <Activity Sport="Biking">');
  lines.push('      <Id>' + iso(points[0].time) + '</Id>');

  for (var l = 0; l < lapCount; l++) {
    var from = l * perLap;
    var to = (l === lapCount - 1) ? points.length : (l + 1) * perLap;
    if (from >= points.length) break;
    var slice = points.slice(from, to);

    var lapDist = 0;
    for (var d = 1; d < slice.length; d++) {
      lapDist += distance(slice[d - 1].lat, slice[d - 1].lon, slice[d].lat, slice[d].lon);
    }
    var lapTime = Math.round((slice[slice.length - 1].time - slice[0].time) / 1000);

    lines.push('      <Lap StartTime="' + iso(slice[0].time) + '">');
    lines.push('        <TotalTimeSeconds>' + lapTime + '</TotalTimeSeconds>');
    lines.push('        <DistanceMeters>' + lapDist.toFixed(1) + '</DistanceMeters>');
    lines.push('        <Track>');

    var cum = 0;
    for (var i = 0; i < slice.length; i++) {
      var p = slice[i];
      if (i > 0) cum += distance(slice[i - 1].lat, slice[i - 1].lon, p.lat, p.lon);
      lines.push('          <Trackpoint>');
      lines.push('            <Time>' + iso(p.time) + '</Time>');
      lines.push('            <Position>');
      lines.push('              <LatitudeDegrees>' + fx(p.lat) + '</LatitudeDegrees>');
      lines.push('              <LongitudeDegrees>' + fx(p.lon) + '</LongitudeDegrees>');
      lines.push('            </Position>');
      lines.push('            <AltitudeMeters>' + fx(p.ele, 1) + '</AltitudeMeters>');
      lines.push('            <DistanceMeters>' + cum.toFixed(1) + '</DistanceMeters>');
      lines.push('            <HeartRateBpm><Value>' + p.hr + '</Value></HeartRateBpm>');
      lines.push('            <Cadence>' + p.cad + '</Cadence>');
      lines.push('            <Extensions>');
      lines.push('              <ns3:TPX>');
      lines.push('                <ns3:Speed>' + fx(p.speed * speedUnit, 2) + '</ns3:Speed>');
      lines.push('              </ns3:TPX>');
      lines.push('            </Extensions>');
      lines.push('          </Trackpoint>');
    }

    lines.push('        </Track>');
    lines.push('      </Lap>');
  }

  lines.push('    </Activity>');
  lines.push('  </Activities>');
  lines.push('</TrainingCenterDatabase>');
  return lines.join('\n');
}

/** KML 结构 B：gx:Track（带时间戳，信息最全） */
function toKmlGx(points) {
  var lines = [];
  lines.push('<?xml version="1.0" encoding="UTF-8"?>');
  lines.push('<kml xmlns="http://www.opengis.net/kml/2.2"');
  lines.push('     xmlns:gx="http://www.google.com/kml/ext/2.2">');
  lines.push('  <Document>');
  lines.push('    <name>骑行轨迹</name>');
  lines.push('    <Placemark>');
  lines.push('      <name>骑行</name>');
  lines.push('      <TimeSpan>');
  lines.push('        <begin>' + iso(points[0].time) + '</begin>');
  lines.push('        <end>' + iso(points[points.length - 1].time) + '</end>');
  lines.push('      </TimeSpan>');
  lines.push('      <gx:Track>');
  for (var i = 0; i < points.length; i++) {
    lines.push('        <when>' + iso(points[i].time) + '</when>');
  }
  for (var j = 0; j < points.length; j++) {
    var p = points[j];
    // 注意 KML 是 经度 纬度 海拔，空格分隔，与 GPX 的 lat/lon 顺序相反
    lines.push('        <gx:coord>' + fx(p.lon) + ' ' + fx(p.lat) + ' ' + fx(p.ele, 1) + '</gx:coord>');
  }
  lines.push('      </gx:Track>');
  lines.push('    </Placemark>');
  lines.push('  </Document>');
  lines.push('</kml>');
  return lines.join('\n');
}

/** KML 结构 A：LineString（无时间戳，逗号分隔） */
function toKmlLineString(points) {
  var lines = [];
  lines.push('<?xml version="1.0" encoding="UTF-8"?>');
  lines.push('<kml xmlns="http://www.opengis.net/kml/2.2">');
  lines.push('  <Document>');
  lines.push('    <name>骑行轨迹</name>');
  lines.push('    <Placemark>');
  lines.push('      <name>骑行路线</name>');
  lines.push('      <LineString>');
  lines.push('        <coordinates>');
  var chunks = [];
  for (var i = 0; i < points.length; i++) {
    chunks.push(fx(points[i].lon) + ',' + fx(points[i].lat) + ',' + fx(points[i].ele, 1));
  }
  lines.push('          ' + chunks.join(' '));
  lines.push('        </coordinates>');
  lines.push('      </LineString>');
  lines.push('    </Placemark>');
  lines.push('  </Document>');
  lines.push('</kml>');
  return lines.join('\n');
}

/* ------------------------------------------------------------------ *
 * 边界样本（专门用来验证解析层的健壮性）
 * ------------------------------------------------------------------ */

/** 只有航点、没有轨迹的 KML：应当解析失败并给出明确原因，而不是返回空轨迹 */
function toKmlWaypointsOnly() {
  return [
    '<?xml version="1.0" encoding="UTF-8"?>',
    '<kml xmlns="http://www.opengis.net/kml/2.2">',
    '  <Document>',
    '    <name>收藏地点</name>',
    '    <Placemark><name>补给点A</name><Point><coordinates>116.3900,39.9930,0</coordinates></Point></Placemark>',
    '    <Placemark><name>补给点B</name><Point><coordinates>116.4000,39.9950,0</coordinates></Point></Placemark>',
    '  </Document>',
    '</kml>'
  ].join('\n');
}

/** 语法损坏的 XML */
function brokenXml() {
  return [
    '<?xml version="1.0" encoding="UTF-8"?>',
    '<gpx creator="HUAWEI Health">',
    '  <trk><name>骑行</name>',
    '    <trkseg>',
    '      <trkpt lat="39.9930" lon="116.3900"><ele>45</ele></trkpt>',
    '    </trkseg>',
    // 这里故意不闭合 trk 与 gpx
  ].join('\n');
}

/** 结构合法但没有任何轨迹点的 GPX */
function emptyGpx() {
  return [
    '<?xml version="1.0" encoding="UTF-8"?>',
    '<gpx creator="HUAWEI Health" version="1.1" xmlns="http://www.topografix.com/GPX/1/1">',
    '  <metadata><name>空记录</name></metadata>',
    '  <trk><name>骑行</name><trkseg></trkseg></trk>',
    '</gpx>'
  ].join('\n');
}

/* ------------------------------------------------------------------ *
 * 主流程
 * ------------------------------------------------------------------ */

function main() {
  var outDir = process.argv[2] || path.join(__dirname, 'samples');
  if (!fs.existsSync(outDir)) fs.mkdirSync(outDir, { recursive: true });

  // 同一条路线、不同日期 —— 路线相同让里程断言保持简单，
  // 日期不同则让「按时间渐变」的配色模式有多个色阶可测。
  function onDay(day, hour) {
    return Date.UTC(2024, 4, day, hour || 8, 0, 0);
  }

  // 主样本：约 1085 点、7 米间距 ≈ 7.6km 的一圈骑行
  var ride = buildRide({ stepMeters: 7, startMs: onDay(1) });
  // 带停车断点的样本：在 4200 米处停 6 分钟（> 300 秒阈值，应被切成两段）
  var paused = buildRide({ stepMeters: 7, pauseAtMeter: 4200, pauseSeconds: 360, startMs: onDay(10, 9) });

  var files = {};
  var meta = {};

  // --- 三种主格式（同一趟骑行的三种导出格式）---
  files['huawei-cycling.gpx'] = toGpx(ride.points);
  files['huawei-cycling.tcx'] = toTcx(
    buildRide({ stepMeters: 7, startMs: onDay(8, 7) }).points, { laps: 3 });
  files['huawei-cycling.kml'] = toKmlGx(
    buildRide({ stepMeters: 7, startMs: onDay(15, 18) }).points);
  files['huawei-cycling-linestring.kml'] = toKmlLineString(
    buildRide({ stepMeters: 7, startMs: onDay(22, 6) }).points);

  meta['huawei-cycling.gpx'] = { format: 'gpx', expectOk: true, tracks: 1 };
  meta['huawei-cycling.tcx'] = { format: 'tcx', expectOk: true, tracks: 1 };
  meta['huawei-cycling.kml'] = { format: 'kml', expectOk: true, tracks: 1 };
  meta['huawei-cycling-linestring.kml'] = { format: 'kml', expectOk: true, tracks: 1, noTime: true };

  // --- 变体样本 ---
  // 速度写成 km/h：解析层应自动识别并除以 3.6，否则会出现「极速 200km/h」
  files['speed-in-kmh.gpx'] = toGpx(
    buildRide({ stepMeters: 7, startMs: onDay(28, 7) }).points, { speedInKmh: true });
  meta['speed-in-kmh.gpx'] = { format: 'gpx', expectOk: true, tracks: 1, speedUnit: 'kmh' };

  // 含暂停断点：应被 splitByTimeGap 切成 2 段
  files['with-pause.gpx'] = toGpx(paused.points);
  meta['with-pause.gpx'] = { format: 'gpx', expectOk: true, tracks: 1, expectedSegments: 2 };

  // --- 边界样本：都应当优雅失败 ---
  files['broken.gpx'] = brokenXml();
  meta['broken.gpx'] = { expectOk: false, reason: 'XML 语法错误' };

  files['empty.gpx'] = emptyGpx();
  meta['empty.gpx'] = { expectOk: false, reason: '没有轨迹点' };

  files['waypoints-only.kml'] = toKmlWaypointsOnly();
  meta['waypoints-only.kml'] = { expectOk: false, reason: '只有航点没有轨迹' };

  // --- 写盘 ---
  var names = Object.keys(files);
  for (var i = 0; i < names.length; i++) {
    var p = path.join(outDir, names[i]);
    fs.writeFileSync(p, files[names[i]], 'utf8');
  }

  // --- 内联成 samples.js（file:// 下无法 fetch，只能靠 <script> 加载）---
  var inline = '/* 由 dev/make-sample.js 自动生成，请勿手工编辑。 */\nwindow.SAMPLES = ' +
    JSON.stringify(files) + ';\n';
  fs.writeFileSync(path.join(outDir, 'samples.js'), inline, 'utf8');

  var metaInline = '/* 由 dev/make-sample.js 自动生成，请勿手工编辑。 */\n' +
    'window.SAMPLE_META = ' + JSON.stringify({
      samples: meta,
      groundTruth: {
        pathMeters: Math.round(ride.meta.pathMeters),
        pointCount: ride.meta.pointCount,
        durationSeconds: ride.meta.durationSeconds,
        center: CENTER
      }
    }, null, 2) + ';\n';
  fs.writeFileSync(path.join(outDir, 'sample-meta.js'), metaInline, 'utf8');

  // --- 报告 ---
  console.log('样本已生成到: ' + outDir);
  console.log('');
  console.log('  真实路线长度  : ' + ride.meta.pathMeters.toFixed(0) + ' 米');
  console.log('  采样点数      : ' + ride.meta.pointCount);
  console.log('  骑行时长      : ' + (ride.meta.durationSeconds / 60).toFixed(1) + ' 分钟');
  console.log('  平均速度      : ' +
    (ride.meta.pathMeters / ride.meta.durationSeconds * 3.6).toFixed(1) + ' km/h');
  console.log('');
  for (var k = 0; k < names.length; k++) {
    var sz = fs.statSync(path.join(outDir, names[k])).size;
    console.log('  ' + names[k].padEnd(30) + (sz / 1024).toFixed(1).padStart(8) + ' KB');
  }
  console.log('');
  console.log('  另含 samples.js 与 sample-meta.js（供 selftest.html 加载）');
}

main();
