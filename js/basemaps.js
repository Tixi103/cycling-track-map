/*!
 * basemaps.js —— 底图 provider 注册表
 *
 * 核心概念：**crs 字段是整个渲染层的枢纽**。
 *   高德、腾讯这类国内底图的瓦片内容用的是 GCJ-02（火星坐标系）基准，
 *   而华为运动健康导出的轨迹是 WGS-84。两者直接叠加会整体偏移 50~500 米，
 *   出现「骑在马路旁边」甚至「骑进河里」。
 *
 *   所以每个 provider 声明自己用哪套坐标系，渲染层据此决定要不要纠偏：
 *     provider.crs === 'GCJ02'  → 画之前把轨迹从 WGS-84 转成 GCJ-02
 *     provider.crs === 'WGS84'  → 原样绘制
 *
 * 注意：**地图本身始终是标准 Web Mercator（EPSG:3857）**，不要为此去自定义
 * L.CRS 子类 —— 高德的瓦片分块规则和 OSM 完全一致，差别只在瓦片内容的地理基准。
 * 自定义 CRS 会牵动瓦片索引、坐标投影、fitBounds 和全部交互，收益为零。
 *
 * 瓦片地址可用性（2026-10 实测于本项目开发机）：
 *   ✅ 高德 webrd/wprd/webst   ~0.3s
 *   ❌ tile.openstreetmap.org  完全不通（多次 12 秒超时）
 *   ✅ a.tile.openstreetmap.fr ~0.9s（同为 OSM 数据，境外镜像）
 */
(function (global) {
  'use strict';

  var list = [];
  var byId = {};

  /**
   * 注册一个底图。
   * @param {Object} p
   *   id            唯一标识，会被持久化到用户设置里
   *   name          界面上显示的中文名
   *   crs           'WGS84' | 'GCJ02' —— 决定轨迹是否需要纠偏
   *   url           瓦片模板；null 表示纯色空白底图（不联网）
   *   subdomains    {s} 的候选值
   *   maxZoom       地图允许的最大缩放级别
   *   maxNativeZoom 瓦片源自身支持的最大级别（超出后 Leaflet 拉伸上一级瓦片，
   *                 好过直接 404 出现白块）
   *   attribution   版权署名，必须显示
   *   surface       'light' | 'dark' | 'plain' —— 画布底色，
   *                 供轨迹配色参考（浅底图上不能再用浅色轨迹）
   *   note          界面上的补充说明，可为空
   */
  function register(p) {
    if (!p || !p.id) throw new Error('底图必须提供 id');
    if (byId[p.id]) throw new Error('底图 id 重复：' + p.id);
    var item = {
      id: p.id,
      name: p.name || p.id,
      crs: p.crs || 'WGS84',
      url: p.url === undefined ? null : p.url,
      subdomains: p.subdomains || 'abc',
      maxZoom: p.maxZoom || 19,
      maxNativeZoom: p.maxNativeZoom || p.maxZoom || 19,
      attribution: p.attribution || '',
      surface: p.surface || 'light',
      note: p.note || ''
    };
    byId[item.id] = item;
    list.push(item);
    return item;
  }

  /* ------------------------------------------------------------------ *
   * 内置底图
   * ------------------------------------------------------------------ */

  // —— 高德：国内加载最快，无需 key。缺点是瓦片内容是 GCJ-02，轨迹必须纠偏 ——
  register({
    id: 'amap-vector',
    name: '高德路网',
    crs: 'GCJ02',
    url: 'https://wprd0{s}.is.autonavi.com/appmaptile?lang=zh_cn&size=1&scl=1&style=7&x={x}&y={y}&z={z}',
    subdomains: ['1', '2', '3', '4'],
    maxZoom: 19,
    maxNativeZoom: 18,
    attribution: '© 高德地图',
    surface: 'light',
    note: '国内加载最快'
  });

  register({
    id: 'amap-image',
    name: '高德影像',
    crs: 'GCJ02',
    url: 'https://webst0{s}.is.autonavi.com/appmaptile?style=6&x={x}&y={y}&z={z}',
    subdomains: ['1', '2', '3', '4'],
    maxZoom: 19,
    maxNativeZoom: 18,
    attribution: '© 高德地图',
    surface: 'dark',
    note: '卫星图，看地形走向'
  });

  // —— OpenStreetMap：全球标准，WGS-84 无需纠偏 ——
  // 官方 tile.openstreetmap.org 在部分网络下不可达，因此默认用 openstreetmap.fr 镜像。
  // 两者数据同源、坐标系同为 WGS-84，只是渲染风格不同。
  register({
    id: 'osm',
    name: 'OSM 标准图',
    crs: 'WGS84',
    url: 'https://a.tile.openstreetmap.fr/osmfr/{z}/{x}/{y}.png',
    subdomains: [],
    maxZoom: 19,
    attribution: '© OpenStreetMap 贡献者',
    surface: 'light',
    note: '全球通用，无需纠偏'
  });

  register({
    id: 'osm-hot',
    name: 'OSM 人道主义图',
    crs: 'WGS84',
    url: 'https://a.tile.openstreetmap.fr/hot/{z}/{x}/{y}.png',
    subdomains: [],
    maxZoom: 19,
    attribution: '© OpenStreetMap 贡献者, 人道主义 OSM 团队',
    surface: 'light',
    note: '配色对比强，路网醒目'
  });

  // —— 空白底图：不联网。既是「离线也能看轨迹」的兑现方式，
  //    也是排查轨迹位置是否正确的干净参照物 ——
  register({
    id: 'blank',
    name: '空白底图',
    crs: 'WGS84',
    url: null,
    maxZoom: 19,
    attribution: '',
    surface: 'plain',
    note: '不联网，仅看轨迹形状'
  });

  global.Basemaps = {
    register: register,
    get: function (id) { return byId[id] || null; },
    list: function () { return list.slice(); },
    /** 默认底图：高德（国内加载最快） */
    defaultId: function () { return 'amap-vector'; },
    /** 某个坐标系下有哪些底图可选 */
    withCrs: function (crs) {
      return list.filter(function (p) { return p.crs === crs; });
    }
  };
})(window);
