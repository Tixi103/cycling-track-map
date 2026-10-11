/*!
 * replay.js —— 轨迹回放
 *
 * 沿轨迹播放一个小圆点，重现当时的骑行过程。
 *
 * 核心设计：**按各采样点的真实时间戳插值，而不是按屏幕距离匀速推进**。
 * 匀速推进看起来更"流畅"，但它是假的 —— 遇到红灯、爬坡、下坡时，
 * 圆点会以同样的速度滑过，把最该被看见的节奏差别抹平了。
 * 按真实时间推进时，等待红灯的那几十秒圆点会明显停住，那才是真实发生过的事。
 *
 * 用 requestAnimationFrame 驱动。file:// 下不能用 Web Worker
 * （Chrome 会以安全原因拒绝加载），所有计算都在主线程，
 * 所以这里只对「当前聚焦的那一条轨迹」做回放，不参与多轨迹渲染。
 */
(function (global) {
  'use strict';

  var el = {};
  var track = null;          // 当前回放的轨迹
  var timeline = null;       // {t: [], lat: [], lon: [], duration, hasTime}
  var playing = false;
  var progress = 0;          // 0..1
  var speed = 16;            // 倍速
  var rafId = null;
  var lastFrameTs = 0;

  /** 基准速率：1 倍速下，1 秒真实时间推进多少「轨迹秒」 */
  var BASE = 1.6;

  /* ------------------------------------------------------------------ *
   * 时间轴
   * ------------------------------------------------------------------ */

  /**
   * 建立回放时间轴。
   *
   * 有时间戳 → 以真实时间为轴；
   * 没有时间戳（例如 KML 的 LineString 结构）→ 退化成按累计里程匀速播放，
   * 并在界面上说明，而不是直接拒绝播放。
   */
  function buildTimeline(t) {
    var pts = t.points;
    if (!pts || pts.length < 2) return null;

    var hasTime = false;
    for (var i = 0; i < pts.length; i++) {
      if (typeof pts[i].time === 'number' && isFinite(pts[i].time)) { hasTime = true; break; }
    }

    var tl = { t: [], lat: [], lon: [], src: [] };

    if (hasTime) {
      var t0 = null;
      for (var j = 0; j < pts.length; j++) {
        var tt = pts[j].time;
        if (typeof tt !== 'number' || !isFinite(tt)) continue;
        if (t0 === null) t0 = tt;
        tl.t.push((tt - t0) / 1000);   // 秒
        tl.lat.push(pts[j].lat);
        tl.lon.push(pts[j].lon);
        tl.src.push(j);
      }
      tl.hasTime = true;
    } else {
      // 无时间：用累计里程当时间轴
      var acc = 0;
      tl.t.push(0);
      tl.lat.push(pts[0].lat);
      tl.lon.push(pts[0].lon);
      tl.src.push(0);
      for (var k = 1; k < pts.length; k++) {
        acc += global.Geo.distance(pts[k - 1].lat, pts[k - 1].lon, pts[k].lat, pts[k].lon);
        tl.t.push(acc);
        tl.lat.push(pts[k].lat);
        tl.lon.push(pts[k].lon);
        tl.src.push(k);
      }
      tl.hasTime = false;
    }

    if (tl.t.length < 2) return null;
    tl.duration = tl.t[tl.t.length - 1];
    if (!(tl.duration > 0)) return null;

    // 时间跳变（骑行中途暂停）在回放里应当快速掠过而不是慢慢爬，
    // 这里把超过 120 秒的空档压缩到 2 秒，否则用户会盯着静止的圆点等半分钟。
    compressGaps(tl, 120, 2);

    return tl;
  }

  function compressGaps(tl, thresholdSec, compressedSec) {
    var shift = 0;
    var out = new Array(tl.t.length);
    out[0] = tl.t[0];
    for (var i = 1; i < tl.t.length; i++) {
      var gap = tl.t[i] - tl.t[i - 1];
      if (gap > thresholdSec) {
        shift += gap - compressedSec;
      }
      out[i] = tl.t[i] - shift;
    }
    tl.t = out;
    tl.duration = out[out.length - 1];
    tl.compressed = shift > 0;
  }

  /* ------------------------------------------------------------------ *
   * 取值
   * ------------------------------------------------------------------ */

  /** 二分查找当前时刻所在的区间 */
  function locate(tSec) {
    var t = timeline.t;
    var lo = 0, hi = t.length - 1;
    if (tSec <= t[0]) return 0;
    if (tSec >= t[hi]) return hi - 1;
    while (hi - lo > 1) {
      var mid = (lo + hi) >> 1;
      if (t[mid] <= tSec) lo = mid; else hi = mid;
    }
    return lo;
  }

  /** 当前位置（线性插值），返回 {lat, lon, index} */
  function positionAt(frac) {
    if (!timeline) return null;
    var tSec = frac * timeline.duration;
    var i = locate(tSec);
    var t0 = timeline.t[i], t1 = timeline.t[i + 1];
    var f = (t1 > t0) ? (tSec - t0) / (t1 - t0) : 0;
    if (f < 0) f = 0; else if (f > 1) f = 1;

    return {
      lat: timeline.lat[i] + (timeline.lat[i + 1] - timeline.lat[i]) * f,
      lon: timeline.lon[i] + (timeline.lon[i + 1] - timeline.lon[i]) * f,
      index: i
    };
  }

  /* ------------------------------------------------------------------ *
   * 播放循环
   * ------------------------------------------------------------------ */

  function frame(ts) {
    if (!playing) return;

    if (!lastFrameTs) lastFrameTs = ts;
    var dt = (ts - lastFrameTs) / 1000;      // 真实经过的秒
    lastFrameTs = ts;

    // 切到别的标签页回来时 dt 会很大，钳住避免圆点瞬移
    if (dt > 0.5) dt = 0.5;

    progress += (dt * speed * BASE) / timeline.duration;

    if (progress >= 1) {
      progress = 1;
      apply();
      pause();
      if (el.time) el.time.textContent = readout();
      return;
    }

    apply();
    rafId = global.requestAnimationFrame(frame);
  }

  function apply() {
    var pos = positionAt(progress);
    if (pos) global.MapView.setReplayMarker([pos.lat, pos.lon]);
    if (el.seek) el.seek.value = Math.round(progress * 1000);
    if (el.time) el.time.textContent = readout();
  }

  /** 「08:12 / 23:20」 */
  function readout() {
    if (!timeline) return '--:--';
    var cur = progress * timeline.duration;
    return fmtClock(cur) + ' / ' + fmtClock(timeline.duration);
  }

  function fmtClock(sec) {
    var s = Math.max(0, Math.round(sec));
    var h = Math.floor(s / 3600);
    var m = Math.floor((s % 3600) / 60);
    var ss = s % 60;
    var p = function (n) { return n < 10 ? '0' + n : String(n); };
    if (h > 0) return h + ':' + p(m) + ':' + p(ss);
    return p(m) + ':' + p(ss);
  }

  /* ------------------------------------------------------------------ *
   * 对外接口
   * ------------------------------------------------------------------ */

  function load(t, keepProgress) {
    stop();
    track = t || null;
    if (el.section) el.section.hidden = !track;

    if (!track) {
      timeline = null;
      global.MapView.setReplayMarker(null);
      return false;
    }

    timeline = buildTimeline(track);
    if (!timeline) {
      if (el.time) el.time.textContent = '--:--';
      return false;
    }

    if (!keepProgress) progress = 0;
    apply();
    return true;
  }

  function play() {
    if (!timeline || playing) return;
    if (progress >= 1) progress = 0;   // 播完了再按播放 = 重头再来
    playing = true;
    lastFrameTs = 0;
    if (el.playBtn) el.playBtn.textContent = '暂停';
    rafId = global.requestAnimationFrame(frame);
  }

  function pause() {
    playing = false;
    if (rafId) { global.cancelAnimationFrame(rafId); rafId = null; }
    if (el.playBtn) el.playBtn.textContent = '播放';
  }

  function toggle() {
    if (playing) pause(); else play();
  }

  function stop() {
    pause();
    progress = 0;
    if (el.seek) el.seek.value = 0;
  }

  function seek(frac) {
    if (!timeline) return;
    progress = Math.max(0, Math.min(1, frac));
    apply();
  }

  function setSpeed(x) {
    speed = x || 1;
  }

  function isPlaying() { return playing; }

  /* ------------------------------------------------------------------ *
   * 初始化
   * ------------------------------------------------------------------ */

  function init() {
    el.section = document.getElementById('replay-section');
    el.playBtn = document.getElementById('btn-replay-play');
    el.seek = document.getElementById('replay-seek');
    el.speedSel = document.getElementById('replay-speed');
    el.time = document.getElementById('replay-time');

    if (el.playBtn) el.playBtn.onclick = toggle;

    if (el.seek) {
      el.seek.oninput = function () {
        // 拖动时暂停，松手后不自动续播 —— 用户多半想停在某一帧看
        pause();
        seek(Number(el.seek.value) / 1000);
      };
    }

    if (el.speedSel) {
      speed = Number(el.speedSel.value) || 1;
      el.speedSel.onchange = function () {
        setSpeed(Number(el.speedSel.value) || 1);
      };
    }
  }

  global.Replay = {
    init: init,
    load: load,
    play: play,
    pause: pause,
    toggle: toggle,
    stop: stop,
    seek: seek,
    setSpeed: setSpeed,
    isPlaying: isPlaying,
    hasTimeline: function () { return !!timeline; }
  };
})(window);
