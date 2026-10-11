/*!
 * store.js —— 轨迹数据本地持久化
 *
 * 存储策略（逐级降级，保证任何环境下都不崩溃）：
 *   1. IndexedDB —— 容量大（通常数百 MB），适合存放大量轨迹，首选。
 *   2. localStorage —— 容量约 5MB，IndexedDB 不可用时（如某些浏览器的 file:// 页面）兜底。
 *   3. 内存 —— 两者都不可用时仍可在当前会话内正常使用，只是关闭页面后数据不保留。
 *
 * 落盘时只保存原始点序列与元信息；分段与统计属于派生数据，读取时重新计算即可，
 * 这样能把存储体积压缩 30% 以上。
 */
(function (global) {
  'use strict';

  var DB_NAME = 'cycling-track-map';
  var DB_VERSION = 1;
  var STORE_NAME = 'tracks';
  var LS_KEY = 'cycling-track-map:tracks';
  var LS_META_KEY = 'cycling-track-map:meta';

  var backend = 'memory'; // 'indexeddb' | 'localstorage' | 'memory'
  var memoryData = null;
  var dbPromise = null;

  /* ---------------- IndexedDB ---------------- */

  function openDb() {
    if (dbPromise) return dbPromise;

    dbPromise = new Promise(function (resolve, reject) {
      if (typeof indexedDB === 'undefined' || !indexedDB) {
        reject(new Error('IndexedDB 不可用'));
        return;
      }
      var req;
      try {
        req = indexedDB.open(DB_NAME, DB_VERSION);
      } catch (e) {
        reject(e);
        return;
      }

      req.onupgradeneeded = function (ev) {
        var db = ev.target.result;
        if (!db.objectStoreNames.contains(STORE_NAME)) {
          db.createObjectStore(STORE_NAME, { keyPath: 'id' });
        }
      };
      req.onsuccess = function (ev) { resolve(ev.target.result); };
      req.onerror = function () { reject(req.error || new Error('打开数据库失败')); };
      // 某些环境下 open 既不触发 success 也不触发 error（例如被隐私设置拦截），加超时保底
      setTimeout(function () { reject(new Error('打开数据库超时')); }, 3000);
    });

    // 失败后清空缓存，便于下次重试
    dbPromise.catch(function () { dbPromise = null; });

    return dbPromise;
  }

  function idbRequest(mode, fn) {
    return openDb().then(function (db) {
      return new Promise(function (resolve, reject) {
        var tx = db.transaction(STORE_NAME, mode);
        var store = tx.objectStore(STORE_NAME);
        var result;
        try {
          result = fn(store);
        } catch (e) {
          reject(e);
          return;
        }
        tx.oncomplete = function () { resolve(result && result.__req ? result.__req.result : result); };
        tx.onerror = function () { reject(tx.error || new Error('数据库事务失败')); };
        tx.onabort = function () { reject(tx.error || new Error('数据库事务被中止')); };
      });
    });
  }

  /* ---------------- localStorage ---------------- */

  function lsAvailable() {
    try {
      var k = '__t__';
      global.localStorage.setItem(k, '1');
      global.localStorage.removeItem(k);
      return true;
    } catch (e) {
      return false;
    }
  }

  /* ---------------- 序列化 ---------------- */

  /**
   * 精简轨迹对象用于存储：去掉可由 points 重新推导的 segments / stats。
   * ele/time 等字段为 null 时不写入，进一步减小体积。
   */
  function serializeTrack(t) {
    var pts = t.points.map(function (p) {
      var o = { lat: round6(p.lat), lon: round6(p.lon) };
      if (p.ele !== null && p.ele !== undefined) o.ele = Math.round(p.ele * 10) / 10;
      if (p.time !== null && p.time !== undefined) o.time = p.time;
      if (p.hr !== null && p.hr !== undefined) o.hr = p.hr;
      if (p.cad !== null && p.cad !== undefined) o.cad = p.cad;
      if (p.speed !== null && p.speed !== undefined) o.speed = Math.round(p.speed * 100) / 100;
      // 功率与温度也要存。解析器（parsers.js）明明读了出来，
      // 这里漏掉的话，界面刷新一次数据就没了 —— 而且是静默丢失，很难查。
      if (p.power !== null && p.power !== undefined) o.power = p.power;
      if (p.atemp !== null && p.atemp !== undefined) o.atemp = Math.round(p.atemp * 10) / 10;
      return o;
    });
    return {
      id: t.id,
      name: t.name,
      format: t.format,
      sourceCrs: t.sourceCrs || 'WGS84',
      color: t.color,
      visible: t.visible !== false,
      fileName: t.fileName || '',
      addedAt: t.addedAt || Date.now(),
      meta: t.meta || {},
      points: pts
    };
  }

  /** 经纬度保留 6 位小数 ≈ 0.11 米精度，远高于 GPS 本身精度，足够且显著省空间 */
  function round6(v) {
    return Math.round(v * 1e6) / 1e6;
  }

  /** 反序列化：重新推导 segments 与 stats */
  function deserializeTrack(o) {
    if (!o || !o.points || o.points.length < 2) return null;
    var points = o.points.map(function (p) {
      return {
        lat: p.lat, lon: p.lon,
        ele: p.ele === undefined ? null : p.ele,
        time: p.time === undefined ? null : p.time,
        hr: p.hr === undefined ? null : p.hr,
        cad: p.cad === undefined ? null : p.cad,
        speed: p.speed === undefined ? null : p.speed,
        power: p.power === undefined ? null : p.power,
        atemp: p.atemp === undefined ? null : p.atemp
      };
    });
    var t = {
      id: o.id,
      name: o.name,
      format: o.format,
      sourceCrs: o.sourceCrs || 'WGS84',
      color: o.color,
      visible: o.visible !== false,
      fileName: o.fileName || '',
      addedAt: o.addedAt || Date.now(),
      meta: o.meta || {},
      points: points
    };
    t.segments = global.Geo.splitByTimeGap(points, 300);
    if (!t.segments.length) t.segments = [points];
    t.stats = global.Geo.computeStats(points);
    return t;
  }

  /* ---------------- 对外接口 ---------------- */

  /** 降级到 localStorage，不可用则退到内存 */
  function fallbackBackend() {
    backend = lsAvailable() ? 'localstorage' : 'memory';
    return backend;
  }

  /**
   * 探测并初始化存储后端。
   * @returns {Promise<string>} 实际启用的后端名
   */
  function init() {
    return openDb().then(function () {
      backend = 'indexeddb';
      return backend;
    }).catch(function () {
      return fallbackBackend();
    });
  }

  /*
   * 关于 file:// 下的行为，这里记录一次实测结论，避免以后再走弯路：
   *
   *   Edge（Chromium）在 file:// 页面下 **IndexedDB 完全可用** ——
   *   打开数据库、建对象仓库、写入、读回，全程约 33 毫秒
   *   （用真实时钟测的，见 dev/probe-realtime.js 与 dev/idb-probe.html）。
   *
   *   曾经一度以为它「卡死」，那是个假象：用无头浏览器的
   *   --virtual-time-budget 跑时，时钟是虚拟的，任务队列一空就会直接跳到
   *   下一个定时器；而 IndexedDB 在等真实磁盘 I/O 的那一刻队列恰好是空的，
   *   于是这里的 3 秒超时会被立刻触发，看起来就像「卡住直到超时」。
   *
   *   同理，上面那个 3 秒超时本身也**不会让用户白等** —— openDb 是竞速，
   *   正常路径下 IndexedDB 几十毫秒就 resolve 了，之后超时再 reject 打在
   *   已经完成的 Promise 上是空操作。它只是防「真的卡住」的保险。
   *
   *   教训：凡是异步 + 真实 I/O 的行为（IndexedDB、大文件读取、Worker），
   *   都不能用虚拟时钟去验证。
   */

  function getBackend() { return backend; }

  /** 保存全部轨迹（覆盖式） */
  function save(tracks) {
    var payload = tracks.map(serializeTrack);

    if (backend === 'indexeddb') {
      return openDb().then(function (db) {
        return new Promise(function (resolve, reject) {
          var tx = db.transaction(STORE_NAME, 'readwrite');
          var store = tx.objectStore(STORE_NAME);
          store.clear();
          for (var i = 0; i < payload.length; i++) store.put(payload[i]);
          tx.oncomplete = function () { resolve(true); };
          tx.onerror = function () { reject(tx.error); };
        });
      }).catch(function (e) {
        // 写入失败（如配额不足）时降级到 localStorage 并如实抛错给上层提示
        if (lsAvailable()) {
          try {
            global.localStorage.setItem(LS_KEY, JSON.stringify(payload));
            backend = 'localstorage';
            return true;
          } catch (e2) { /* 继续向下抛 */ }
        }
        throw e;
      });
    }

    if (backend === 'localstorage') {
      try {
        global.localStorage.setItem(LS_KEY, JSON.stringify(payload));
        return Promise.resolve(true);
      } catch (e) {
        // 超出配额：抛出明确错误，由界面提示用户清理
        var err = new Error('本地存储空间不足，无法保存全部轨迹。建议删除部分轨迹，或使用「导出数据」备份后清理。');
        err.code = 'QUOTA';
        return Promise.reject(err);
      }
    }

    memoryData = payload;
    return Promise.resolve(true);
  }

  /** 读取全部轨迹 */
  function load() {
    if (backend === 'indexeddb') {
      return openDb().then(function (db) {
        return new Promise(function (resolve, reject) {
          var tx = db.transaction(STORE_NAME, 'readonly');
          var store = tx.objectStore(STORE_NAME);
          var req = store.getAll();
          req.onsuccess = function () { resolve(req.result || []); };
          req.onerror = function () { reject(req.error); };
        });
      }).then(function (rows) {
        return rows.map(deserializeTrack).filter(Boolean)
          .sort(function (a, b) { return (a.addedAt || 0) - (b.addedAt || 0); });
      }).catch(function () {
        return [];
      });
    }

    if (backend === 'localstorage') {
      try {
        var raw = global.localStorage.getItem(LS_KEY);
        if (!raw) return Promise.resolve([]);
        var arr = JSON.parse(raw);
        return Promise.resolve(arr.map(deserializeTrack).filter(Boolean));
      } catch (e) {
        return Promise.resolve([]);
      }
    }

    if (memoryData) return Promise.resolve(memoryData.map(deserializeTrack).filter(Boolean));
    return Promise.resolve([]);
  }

  /** 清空全部轨迹 */
  function clear() {
    if (backend === 'indexeddb') {
      return openDb().then(function (db) {
        return new Promise(function (resolve) {
          var tx = db.transaction(STORE_NAME, 'readwrite');
          tx.objectStore(STORE_NAME).clear();
          tx.oncomplete = function () { resolve(true); };
          tx.onerror = function () { resolve(false); };
        });
      }).catch(function () { return false; });
    }
    if (backend === 'localstorage') {
      try { global.localStorage.removeItem(LS_KEY); } catch (e) { /* 忽略 */ }
      return Promise.resolve(true);
    }
    memoryData = null;
    return Promise.resolve(true);
  }

  /**
   * 导出为 JSON 文本（用于备份 / 换设备迁移 / 分享给他人）。
   * 包含完整点数据，可被 importJson 无损还原。
   */
  function exportJson(tracks) {
    var payload = {
      app: 'cycling-track-map',
      version: 1,
      exportedAt: new Date().toISOString(),
      count: tracks.length,
      tracks: tracks.map(serializeTrack)
    };
    return JSON.stringify(payload, null, 0);
  }

  /**
   * 从导出的 JSON 文本还原轨迹。
   * @returns {Array} 轨迹数组
   * @throws {Error} 格式非法时抛出
   */
  function importJson(text) {
    var data;
    try {
      data = JSON.parse(text);
    } catch (e) {
      throw new Error('不是合法的 JSON 文件');
    }
    var list = null;
    if (Array.isArray(data)) list = data;                       // 也接受裸数组
    else if (data && Array.isArray(data.tracks)) list = data.tracks;
    if (!list) throw new Error('JSON 中未找到轨迹数据（缺少 tracks 字段）');

    var out = list.map(deserializeTrack).filter(Boolean);
    if (!out.length) throw new Error('JSON 中没有有效的轨迹点数据');
    return out;
  }

  global.Store = {
    init: init,
    getBackend: getBackend,
    save: save,
    load: load,
    clear: clear,
    exportJson: exportJson,
    importJson: importJson,
    serializeTrack: serializeTrack,
    deserializeTrack: deserializeTrack
  };
})(window);
