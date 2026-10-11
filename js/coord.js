/*!
 * coord.js —— 地理坐标系转换
 *
 * 为什么需要这个文件？
 *   华为运动健康 APP 导出的 GPX/TCX/KML 使用的都是 **WGS-84** 国际标准坐标（GPS 原始坐标）。
 *   而国内的高德、腾讯、百度等地图瓦片使用的是 **GCJ-02**（俗称"火星坐标系"，国家强制加密偏移）。
 *   如果把 WGS-84 的轨迹直接画在高德底图上，轨迹会整体偏移 50~500 米，
 *   出现"骑在马路旁边"甚至"骑进河里"的现象。
 *
 *   因此：底图是高德/腾讯时 → 轨迹必须转成 GCJ-02 再绘制；
 *        底图是 OpenStreetMap / 地形图时 → 保持 WGS-84 原样绘制。
 *
 * 算法来源：国测局 GCJ-02 加密算法的公开参考实现（克拉索夫斯基椭球）。
 */
(function (global) {
  'use strict';

  var PI = Math.PI;
  var A = 6378245.0;                    // 克拉索夫斯基椭球长半轴（米）
  var EE = 0.00669342162296594323;      // 椭球偏心率平方

  /**
   * 判断坐标是否在中国境外（境外坐标 GCJ-02 不做偏移）。
   * 使用中国大致经纬度范围包围盒。
   */
  function outOfChina(lon, lat) {
    return !(lon > 73.66 && lon < 135.05 && lat > 3.86 && lat < 53.55);
  }

  function transformLat(x, y) {
    var ret = -100.0 + 2.0 * x + 3.0 * y + 0.2 * y * y + 0.1 * x * y + 0.2 * Math.sqrt(Math.abs(x));
    ret += (20.0 * Math.sin(6.0 * x * PI) + 20.0 * Math.sin(2.0 * x * PI)) * 2.0 / 3.0;
    ret += (20.0 * Math.sin(y * PI) + 40.0 * Math.sin(y / 3.0 * PI)) * 2.0 / 3.0;
    ret += (160.0 * Math.sin(y / 12.0 * PI) + 320.0 * Math.sin(y * PI / 30.0)) * 2.0 / 3.0;
    return ret;
  }

  function transformLon(x, y) {
    var ret = 300.0 + x + 2.0 * y + 0.1 * x * x + 0.1 * x * y + 0.1 * Math.sqrt(Math.abs(x));
    ret += (20.0 * Math.sin(6.0 * x * PI) + 20.0 * Math.sin(2.0 * x * PI)) * 2.0 / 3.0;
    ret += (20.0 * Math.sin(x * PI) + 40.0 * Math.sin(x / 3.0 * PI)) * 2.0 / 3.0;
    ret += (150.0 * Math.sin(x / 12.0 * PI) + 300.0 * Math.sin(x / 30.0 * PI)) * 2.0 / 3.0;
    return ret;
  }

  /**
   * WGS-84 → GCJ-02
   * @param {number} lon 经度
   * @param {number} lat 纬度
   * @returns {number[]} [经度, 纬度]
   */
  function wgs84ToGcj02(lon, lat) {
    if (outOfChina(lon, lat)) return [lon, lat];

    var dLat = transformLat(lon - 105.0, lat - 35.0);
    var dLon = transformLon(lon - 105.0, lat - 35.0);
    var radLat = lat / 180.0 * PI;
    var magic = Math.sin(radLat);
    magic = 1 - EE * magic * magic;
    var sqrtMagic = Math.sqrt(magic);

    dLat = (dLat * 180.0) / ((A * (1 - EE)) / (magic * sqrtMagic) * PI);
    dLon = (dLon * 180.0) / (A / sqrtMagic * Math.cos(radLat) * PI);

    return [lon + dLon, lat + dLat];
  }

  /**
   * GCJ-02 → WGS-84
   *
   * 该变换没有解析反函数，采用「迭代逼近」求解：
   *   猜测 wgs ≈ gcj，算出对应的 gcj' 与目标的差值，用差值反向修正 wgs，重复若干次即可收敛到毫米级。
   *
   * @param {number} lon 经度（GCJ-02）
   * @param {number} lat 纬度（GCJ-02）
   * @param {number} [iterations=5] 迭代次数，5 次已可达 ~1e-9 度精度
   * @returns {number[]} [经度, 纬度]（WGS-84）
   */
  function gcj02ToWgs84(lon, lat, iterations) {
    if (outOfChina(lon, lat)) return [lon, lat];

    var n = iterations === undefined ? 5 : iterations;
    var wgsLon = lon;
    var wgsLat = lat;

    for (var i = 0; i < n; i++) {
      var conv = wgs84ToGcj02(wgsLon, wgsLat);
      wgsLon += lon - conv[0];
      wgsLat += lat - conv[1];
    }
    return [wgsLon, wgsLat];
  }

  /**
   * 按指定的目标坐标系转换单个坐标点。
   * @param {number} lon
   * @param {number} lat
   * @param {string} targetCrs 'WGS84' | 'GCJ02'
   */
  function convert(lon, lat, targetCrs) {
    if (targetCrs === 'GCJ02') return wgs84ToGcj02(lon, lat);
    return [lon, lat];
  }

  // 轨迹点上会被解析器写进去的全部字段。
  // 转换时必须原样带过去 —— 漏掉任何一个都会让「转换后心率/海拔丢失」这类问题
  // 在很远的地方才暴露出来（比如剖面图悬停时数值显示为空）。
  var POINT_FIELDS = ['ele', 'time', 'hr', 'cad', 'speed', 'power', 'atemp', 'dist'];

  function copyPoint(p, lat, lon) {
    var o = { lat: lat, lon: lon };
    for (var i = 0; i < POINT_FIELDS.length; i++) {
      var k = POINT_FIELDS[i];
      if (p[k] !== undefined) o[k] = p[k];
    }
    return o;
  }

  /**
   * 批量转换轨迹点数组（返回新数组，不修改入参）。
   * @param {Array} points 形如 [{lat, lon, ...}] 的轨迹点
   * @param {string} targetCrs 'WGS84' | 'GCJ02'
   * @param {string} [sourceCrs='WGS84'] 源坐标系。华为运动健康导出恒为 WGS84，
   *        这个参数是为「导入别的 App 导出的 GCJ-02 轨迹」这类情况留的 ——
   *        轨迹对象上的 sourceCrs 字段与之对应。
   * @returns {Array} 新的点数组，已替换 lat/lon
   */
  function convertPoints(points, targetCrs, sourceCrs) {
    var from = sourceCrs || 'WGS84';
    var to = targetCrs || 'WGS84';

    // 同坐标系转换就是恒等 —— 保证「切底图来回切」是幂等的，不会累积偏移
    if (from === to) {
      return points.map(function (p) { return copyPoint(p, p.lat, p.lon); });
    }

    var forward = (from === 'WGS84' && to === 'GCJ02');
    return points.map(function (p) {
      var c = forward ? wgs84ToGcj02(p.lon, p.lat) : gcj02ToWgs84(p.lon, p.lat);
      return copyPoint(p, c[1], c[0]);
    });
  }

  global.Coord = {
    wgs84ToGcj02: wgs84ToGcj02,
    gcj02ToWgs84: gcj02ToWgs84,
    outOfChina: outOfChina,
    convert: convert,
    convertPoints: convertPoints
  };
})(window);
