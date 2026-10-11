/*!
 * selftest.js —— 解析层与地理计算层的自动断言
 *
 * 配套 dev/selftest.html 使用。结果写进页面的 <pre id="log">，
 * 用无头浏览器 --dump-dom 抓出来即可（不需要人看页面）。
 *
 * 运行：
 *   node dev/make-sample.js
 *   msedge --headless=new --disable-gpu --dump-dom --virtual-time-budget=8000 \
 *          "file:///.../dev/selftest.html"
 */
(function () {
  'use strict';

  var lines = [];
  var passed = 0;
  var failed = 0;

  function check(name, cond, detail) {
    if (cond) { passed++; lines.push('PASS | ' + name + ' | ' + (detail === undefined ? '' : detail)); }
    else { failed++; lines.push('FAIL | ' + name + ' | ' + (detail === undefined ? '' : detail)); }
  }

  /** 在 [lo, hi] 区间内 */
  function between(v, lo, hi) { return typeof v === 'number' && isFinite(v) && v >= lo && v <= hi; }

  /** 相对偏差（相对 base 的百分比） */
  function relDiff(v, base) { return base === 0 ? Infinity : Math.abs(v - base) / base; }

  function fmt(v, n) { return typeof v === 'number' && isFinite(v) ? v.toFixed(n === undefined ? 1 : n) : String(v); }

  /** 解析一个样本 */
  function parse(key) {
    return Parsers.parseFileContent(SAMPLES[key], key);
  }

  // ------------------------------------------------------------------
  // 前置检查：脚本必须在正确的作用域里
  // ------------------------------------------------------------------
  check('数据层已加载 (XmlUtil)', typeof XmlUtil === 'object' && XmlUtil !== null);
  check('数据层已加载 (Geo)', typeof Geo === 'object' && Geo !== null);
  check('数据层已加载 (Coord)', typeof Coord === 'object' && Coord !== null);
  check('数据层已加载 (Parsers)', typeof Parsers === 'object' && Parsers !== null);
  check('样本已加载', typeof SAMPLES === 'object' && SAMPLES !== null,
    typeof SAMPLES === 'object' ? Object.keys(SAMPLES).length + ' 个样本' : '');
  check('真值已加载', typeof SAMPLE_META === 'object' && SAMPLE_META !== null);

  if (typeof SAMPLES !== 'object' || !SAMPLES) {
    finish();
    return;
  }

  var GT = SAMPLE_META.groundTruth;

  // ------------------------------------------------------------------
  // 一、三种主格式解析
  // ------------------------------------------------------------------
  var gpx = parse('huawei-cycling.gpx');
  check('GPX 解析成功', gpx.ok === true, gpx.error || '');
  check('GPX 格式识别为 gpx', gpx.format === 'gpx', gpx.format);
  check('GPX 轨道条数 = 1', gpx.tracks.length === 1, gpx.tracks.length);

  var tcx = parse('huawei-cycling.tcx');
  check('TCX 解析成功', tcx.ok === true, tcx.error || '');
  check('TCX 格式识别为 tcx', tcx.format === 'tcx', tcx.format);
  check('TCX 轨道条数 = 1（3 个 Lap 合并为一条）', tcx.tracks.length === 1, tcx.tracks.length);

  var kml = parse('huawei-cycling.kml');
  check('KML(gx:Track) 解析成功', kml.ok === true, kml.error || '');
  check('KML 格式识别为 kml', kml.format === 'kml', kml.format);

  var kmlLs = parse('huawei-cycling-linestring.kml');
  check('KML(LineString) 解析成功', kmlLs.ok === true, kmlLs.error || '');

  if (!gpx.ok || !tcx.ok || !kml.ok || !kmlLs.ok) { finish(); return; }

  var g = gpx.tracks[0];
  var t = tcx.tracks[0];
  var k = kml.tracks[0];
  var kl = kmlLs.tracks[0];

  // ------------------------------------------------------------------
  // 二、点数与里程
  // ------------------------------------------------------------------
  check('GPX 点数与生成时一致', g.points.length === GT.pointCount,
    '期望 ' + GT.pointCount + ' 实际 ' + g.points.length);
  check('TCX 点数与生成时一致', t.points.length === GT.pointCount,
    '期望 ' + GT.pointCount + ' 实际 ' + t.points.length);
  check('KML(gx) 点数与生成时一致', k.points.length === GT.pointCount,
    '期望 ' + GT.pointCount + ' 实际 ' + k.points.length);
  check('KML(LineString) 点数与生成时一致', kl.points.length === GT.pointCount,
    '期望 ' + GT.pointCount + ' 实际 ' + kl.points.length);

  // 里程应当略大于几何路线长度（GPS 抖动会轻微拉长），但不应超过 5%
  var distLo = GT.pathMeters;
  var distHi = GT.pathMeters * 1.05;

  check('GPX 里程在合理区间', between(g.stats.distance, distLo, distHi),
    '路线 ' + GT.pathMeters + 'm，算出 ' + fmt(g.stats.distance, 0) + 'm');
  check('TCX 里程与 GPX 一致（差 < 0.5%）', relDiff(t.stats.distance, g.stats.distance) < 0.005,
    'GPX ' + fmt(g.stats.distance, 0) + 'm vs TCX ' + fmt(t.stats.distance, 0) + 'm');
  check('KML(gx) 里程与 GPX 一致（差 < 0.5%）', relDiff(k.stats.distance, g.stats.distance) < 0.005,
    'GPX ' + fmt(g.stats.distance, 0) + 'm vs KML ' + fmt(k.stats.distance, 0) + 'm');

  // ------------------------------------------------------------------
  // 三、坐标顺序（KML 是 经度,纬度 —— 最容易写反的地方）
  // ------------------------------------------------------------------
  var c0 = GT.center;
  check('KML 经纬度未写反', Math.abs(k.points[0].lat - c0.lat) < 0.05 && Math.abs(k.points[0].lon - c0.lon) < 0.05,
    'KML 首点 ' + fmt(k.points[0].lat, 4) + ',' + fmt(k.points[0].lon, 4) + ' 中心 ' + c0.lat + ',' + c0.lon);
  check('KML 与 GPX 首点位置一致（差 < 1m）',
    Geo.distance(g.points[0].lat, g.points[0].lon, k.points[0].lat, k.points[0].lon) < 1,
    fmt(Geo.distance(g.points[0].lat, g.points[0].lon, k.points[0].lat, k.points[0].lon), 3) + 'm');

  // ------------------------------------------------------------------
  // 四、命名空间前缀（华为用 ns3:，解析器必须忽略前缀）
  // ------------------------------------------------------------------
  var hrCount = 0;
  for (var i = 0; i < g.points.length; i++) if (g.points[i].hr !== null) hrCount++;
  check('GPX 心率扩展解析成功（ns3:hr）', hrCount === g.points.length,
    hrCount + '/' + g.points.length + ' 个点带心率');
  check('心率数值在生理范围内', g.points[0].hr >= 90 && g.points[0].hr <= 185,
    '首个点 hr=' + g.points[0].hr);

  var cadNull = 0, cadMin = Infinity, cadMax = -Infinity;
  for (var j = 0; j < g.points.length; j++) {
    var cv = g.points[j].cad;
    if (cv === null || cv === undefined) cadNull++;
    else { if (cv < cadMin) cadMin = cv; if (cv > cadMax) cadMax = cv; }
  }
  check('GPX 踏频扩展解析成功（ns3:cad）',
    cadNull === 0 && cadMin >= 0 && cadMax <= 120,
    'null=' + cadNull + ' 范围 ' + cadMin + '~' + cadMax);

  check('TCX 心率解析成功（HeartRateBpm/Value）', t.points[0].hr !== null && t.points[0].hr > 0,
    'hr=' + t.points[0].hr);

  // ------------------------------------------------------------------
  // 五、速度单位自动纠正（km/h 与 m/s 混用）
  // ------------------------------------------------------------------
  var kmh = parse('speed-in-kmh.gpx');
  check('km/h 样本解析成功', kmh.ok === true, kmh.error || '');
  if (kmh.ok) {
    var kmhT = kmh.tracks[0];
    check('km/h 速度已自动除以 3.6',
      relDiff(kmhT.stats.maxSpeed, g.stats.maxSpeed) < 0.10,
      '正常 ' + fmt(g.stats.maxSpeed * 3.6, 1) + 'km/h vs km/h 文件 ' + fmt(kmhT.stats.maxSpeed * 3.6, 1) + 'km/h');
    check('均速换算后也一致（差 < 10%）',
      relDiff(kmhT.stats.movingAvgSpeed, g.stats.movingAvgSpeed) < 0.10,
      '正常 ' + fmt(g.stats.movingAvgSpeed * 3.6, 1) + 'km/h vs ' + fmt(kmhT.stats.movingAvgSpeed * 3.6, 1) + 'km/h');
  }

  // ------------------------------------------------------------------
  // 六、暂停断点必须断开（否则地图上会画出一条笔直的错误线段）
  // ------------------------------------------------------------------
  var paused = parse('with-pause.gpx');
  check('含暂停样本解析成功', paused.ok === true, paused.error || '');
  if (paused.ok) {
    var pt = paused.tracks[0];
    check('暂停处被切成 2 段', pt.segments.length === 2, '实际 ' + pt.segments.length + ' 段');
    check('两段都各含 2 个点以上',
      pt.segments.length === 2 && pt.segments[0].length >= 2 && pt.segments[1].length >= 2,
      pt.segments.map(function (s) { return s.length; }).join(' + '));
    check('总时长比不停车样本多约 360 秒',
      Math.abs(pt.stats.duration - (g.stats.duration + 360)) <= 3,
      '不停车 ' + fmt(g.stats.duration, 0) + 's，停车 ' + fmt(pt.stats.duration, 0) + 's');
    check('总里程不受停车影响（差 < 0.5%）',
      relDiff(pt.stats.distance, g.stats.distance) < 0.005,
      fmt(pt.stats.distance, 0) + 'm vs ' + fmt(g.stats.distance, 0) + 'm');
  }

  // ------------------------------------------------------------------
  // 七、边界样本必须优雅失败（不能崩、不能返回空数组冒充成功）
  // ------------------------------------------------------------------
  var broken = parse('broken.gpx');
  check('损坏 XML 被拒绝', broken.ok === false, 'error=' + broken.error);
  check('损坏 XML 给出可读的中文原因',
    typeof broken.error === 'string' && /XML|格式|解析/.test(broken.error), broken.error);

  var empty = parse('empty.gpx');
  check('无轨迹点的 GPX 被拒绝', empty.ok === false, 'error=' + empty.error);

  var wpt = parse('waypoints-only.kml');
  check('纯航点 KML 被拒绝', wpt.ok === false, 'error=' + wpt.error);

  check('空字符串被拒绝', Parsers.parseFileContent('', 'x.gpx').ok === false);
  check('null 被拒绝', Parsers.parseFileContent(null, 'x.gpx').ok === false);

  // 把文件重命名为 .txt 仍应按内容识别（按根元素判格式，不看扩展名）
  check('扩展名错误时按内容识别格式',
    Parsers.parseFileContent(SAMPLES['huawei-cycling.gpx'], '被改名了.txt').ok === true);

  // ------------------------------------------------------------------
  // 八、坐标系转换
  // ------------------------------------------------------------------
  var wgsLon = c0.lon, wgsLat = c0.lat;
  var gcj = Coord.wgs84ToGcj02(wgsLon, wgsLat);
  var offsetM = Geo.distance(wgsLat, wgsLon, gcj[1], gcj[0]);
  check('北京地区 GCJ-02 偏移量在 300~800 米之间', between(offsetM, 300, 800),
    fmt(offsetM, 1) + 'm');

  var back = Coord.gcj02ToWgs84(gcj[0], gcj[1]);
  var roundTripM = Geo.distance(wgsLat, wgsLon, back[1], back[0]);
  check('GCJ-02 往返转换可逆（误差 < 0.01 米）', roundTripM < 0.01,
    fmt(roundTripM * 100, 4) + ' 厘米');

  check('境外坐标不做偏移（东京）',
    Coord.outOfChina(139.6917, 35.6895) === true &&
    Coord.wgs84ToGcj02(139.6917, 35.6895)[0] === 139.6917);
  check('境内坐标判定正确（北京）', Coord.outOfChina(116.39, 39.99) === false);

  // convertPoints 必须不修改入参，也不丢字段
  var samplePts = g.points.slice(0, 50);
  var lon0 = samplePts[0].lon;
  var conv = Coord.convertPoints(samplePts, 'GCJ02');
  check('convertPoints 不修改原始点', samplePts[0].lon === lon0);
  check('convertPoints 保留时间字段', conv[0].time === samplePts[0].time);
  check('convertPoints 保留心率字段', conv[0].hr === samplePts[0].hr);
  check('convertPoints 保留踏频字段', conv[0].cad === samplePts[0].cad);
  check('convertPoints 保留速度字段', conv[0].speed === samplePts[0].speed);

  // 反向转换：GCJ-02 → WGS-84。给「导入别的 App 导出的火星坐标轨迹」留的通路
  var backConv = Coord.convertPoints(conv, 'WGS84', 'GCJ02');
  check('convertPoints 支持反向转换（GCJ02→WGS84）',
    Geo.distance(samplePts[0].lat, samplePts[0].lon, backConv[0].lat, backConv[0].lon) < 0.01,
    (Geo.distance(samplePts[0].lat, samplePts[0].lon, backConv[0].lat, backConv[0].lon) * 100).toFixed(4) + ' 厘米');
  check('反向转换同样保留心率字段', backConv[0].hr === samplePts[0].hr);
  check('convertPoints 转换后坐标确实变了',
    Geo.distance(samplePts[0].lat, samplePts[0].lon, conv[0].lat, conv[0].lon) > 100);
  check('convertPoints WGS84 模式为恒等',
    Coord.convertPoints(samplePts, 'WGS84')[0].lon === lon0);

  // ------------------------------------------------------------------
  // 九、抽稀
  // ------------------------------------------------------------------
  var simp = Geo.simplify(g.points, 5);
  check('抽稀后点数显著减少', simp.length < g.points.length * 0.75,
    g.points.length + ' → ' + simp.length + ' 点');
  check('抽稀保留首尾点',
    simp[0] === g.points[0] && simp[simp.length - 1] === g.points[g.points.length - 1]);
  check('抽稀容差为 0 时原样返回', Geo.simplify(g.points, 0).length === g.points.length);

  // 抽稀后形状不能变太多：里程损失应小于 2%
  var simpDist = 0;
  for (var s = 1; s < simp.length; s++) {
    simpDist += Geo.distance(simp[s - 1].lat, simp[s - 1].lon, simp[s].lat, simp[s].lon);
  }
  check('抽稀后里程损失 < 2%', relDiff(simpDist, g.stats.distance) < 0.02,
    '原始 ' + fmt(g.stats.distance, 0) + 'm → 抽稀 ' + fmt(simpDist, 0) + 'm');

  // ------------------------------------------------------------------
  // 十、统计口径
  // ------------------------------------------------------------------
  check('爬升为正值且在合理区间', between(g.stats.elevationGain, 50, 200),
    fmt(g.stats.elevationGain, 0) + 'm');
  check('爬升与下降大致相当', relDiff(g.stats.elevationLoss, g.stats.elevationGain) < 0.6,
    '爬升 ' + fmt(g.stats.elevationGain, 0) + 'm / 下降 ' + fmt(g.stats.elevationLoss, 0) + 'm');
  check('最高海拔大于最低海拔',
    g.stats.maxElevation > g.stats.minElevation,
    fmt(g.stats.minElevation, 1) + 'm ~ ' + fmt(g.stats.maxElevation, 1) + 'm');
  check('总时长与生成时一致（差 2 秒内）',
    Math.abs(g.stats.duration - GT.durationSeconds) <= 2,
    '期望 ' + GT.durationSeconds + 's 实际 ' + fmt(g.stats.duration, 0) + 's');
  check('移动时间小于总时长', g.stats.movingTime > 0 && g.stats.movingTime <= g.stats.duration + 1,
    '移动 ' + fmt(g.stats.movingTime, 0) + 's / 总 ' + fmt(g.stats.duration, 0) + 's');
  check('均速在骑行合理区间（10~35 km/h）',
    between(g.stats.movingAvgSpeed * 3.6, 10, 35),
    fmt(g.stats.movingAvgSpeed * 3.6, 1) + ' km/h');
  check('极速大于均速', g.stats.maxSpeed > g.stats.movingAvgSpeed,
    '极速 ' + fmt(g.stats.maxSpeed * 3.6, 1) + ' / 均速 ' + fmt(g.stats.movingAvgSpeed * 3.6, 1) + ' km/h');
  check('包围盒非空且有面积',
    (function () {
      var b = Geo.bounds(g.points);
      return b && b[1][0] > b[0][0] && b[1][1] > b[0][1];
    })());
  check('KML(LineString) 无时间信息时 hasTime=false', kl.stats.hasTime === false,
    'hasTime=' + kl.stats.hasTime);

  finish();

  // ------------------------------------------------------------------
  function finish() {
    lines.push('');
    lines.push('SUMMARY | passed=' + passed + ' | failed=' + failed);
    var el = document.getElementById('log');
    if (el) el.textContent = lines.join('\n');
    // 供 --dump-dom 之外的场景直接读
    window.__SELFTEST__ = { passed: passed, failed: failed, lines: lines };
  }
})();
