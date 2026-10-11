#!/usr/bin/env node
/*!
 * mobile-test.js —— 手机端布局与首屏的回归测试
 *
 * 为什么单独有这个测试：
 *   桌面端一直测得好好的，但用手机打开时是坏的 —— 两类问题都只在窄屏上出现：
 *
 *   1. **地图一片空白灰**。Leaflet 在没设过中心与缩放之前处于「未加载」状态，
 *      瓦片一张都不请求。桌面端之所以没被发现，是因为本地一直有恢复出来的轨迹，
 *      导入后 fitAll 顺手就把视野设上了；换成全新访客（比如手机上第一次打开），
 *      或者 localStorage 是空的，就必然踩到。
 *   2. **顶栏控件顶出屏幕**。flex 项默认 min-width:auto，不显式允许收缩的话
 *      会撑破容器，右侧内容被裁掉一大截。
 *
 * 用 CDP 把视口设成手机尺寸来跑，这两类问题都能稳定复现。
 *
 * 用法：
 *   node dev/mobile-test.js
 */
'use strict';

const path = require('path');
const fs = require('fs');
const { withPage } = require('./cdp');

const root = path.join(__dirname, '..');

// 几档有代表性的手机宽度（CSS 像素）
const VIEWPORTS = [
  { label: 'iPhone SE   ', w: 375, h: 667 },
  { label: 'iPhone 14   ', w: 390, h: 844 },
  { label: '安卓大屏    ', w: 430, h: 932 }
];

function fileUrl(rel) {
  return 'file:///' + path.join(root, rel).replace(/\\/g, '/');
}

function realFiles(n) {
  const dir = path.join(root, '华为导出骑行文件');
  if (!fs.existsSync(dir)) return [];
  return fs.readdirSync(dir).filter(f => /\.(gpx|tcx|kml)$/i.test(f))
    .sort().slice(-n).map(f => path.join(dir, f));
}

const passed = [], failed = [];
function check(name, cond, detail) {
  if (cond) { passed.push(name); console.log('  PASS | ' + name + ' | ' + (detail || '')); }
  else { failed.push(name); console.log('  FAIL | ' + name + ' | ' + (detail || '')); }
}

/**
 * 收集横向溢出到视口外的元素。
 *
 * 判据用 scrollWidth 是否超出视口宽度 —— 那才是「用户要横向滚动才能看全」，
 * 才是真问题。
 *
 * 元素清单里要**排除 Leaflet 的内部节点**：瓦片本来就有一部分被故意放在
 * 视口外、由容器裁剪，这是正常渲染行为，不是布局溢出。
 * 不排除的话每次都会列出一堆 leaflet-tile，把真正的问题淹掉。
 */
const OVERFLOW_PROBE = `(function(){
  var d = document.documentElement, out = [];
  document.querySelectorAll('body *').forEach(function(el){
    var cls = (el.className && el.className.baseVal !== undefined) ? el.className.baseVal : (el.className || '');
    if (String(cls).indexOf('leaflet') >= 0) return;
    var r = el.getBoundingClientRect();
    if (r.width > 0 && (r.right > window.innerWidth + 1 || r.left < -1)) {
      out.push(String(cls || el.tagName).slice(0, 40));
    }
  });
  return JSON.stringify({ scrollW: d.scrollWidth, innerW: window.innerWidth, over: out.slice(0, 6) });
})()`;

async function testViewport(vp, files) {
  console.log('\n── ' + vp.label + ' ' + vp.w + '×' + vp.h + ' ──');

  await withPage(fileUrl('index.html'), async (cdp, h) => {
    await cdp.eval('window.App && App.ready', true);
    await h.sleep(3500);

    // ── 空状态：全新访客第一次打开 ──
    const empty = JSON.parse(await cdp.eval(OVERFLOW_PROBE));
    check('空状态无横向溢出', empty.scrollW - empty.innerW <= 0,
      '溢出 ' + (empty.scrollW - empty.innerW) + 'px' + (empty.over.length ? ' → ' + empty.over.join(', ') : ''));

    const view = JSON.parse(await cdp.eval(
      '(function(){var m=MapView.getMap();return JSON.stringify({' +
      'z:m.getZoom(), lat:m.getCenter().lat, lon:m.getCenter().lng});})()'));
    check('地图有默认视野（不是未加载状态）', view.z > 0,
      'zoom=' + view.z + ' 中心 ' + view.lat.toFixed(2) + ',' + view.lon.toFixed(2));

    const tiles = await cdp.eval("document.querySelectorAll('.leaflet-tile-pane img').length");
    check('空状态也会去请求瓦片', tiles > 0, tiles + ' 张');

    const mapBox = JSON.parse(await cdp.eval(
      "(function(){var r=document.getElementById('map').getBoundingClientRect();return JSON.stringify({w:Math.round(r.width),h:Math.round(r.height)});})()"));
    check('地图容器尺寸合理', mapBox.w > 0 && mapBox.h >= 150,
      mapBox.w + '×' + mapBox.h);

    // ── 导入数据后 ──
    const use = files.slice(0, 6);
    if (use.length) {
      await h.setFileInput('#file-input', use);
      await h.sleep(4000);
      await cdp.eval('(function(){document.querySelectorAll(".notice-close").forEach(function(b){b.click()});return 1})()');
      await h.sleep(500);

      const loaded = JSON.parse(await cdp.eval(OVERFLOW_PROBE));
      check('导入后无横向溢出', loaded.scrollW - loaded.innerW <= 0,
        '溢出 ' + (loaded.scrollW - loaded.innerW) + 'px' + (loaded.over.length ? ' → ' + loaded.over.join(', ') : ''));

      const n = await cdp.eval('TracksStore.count()');
      check('轨迹导入成功', n === use.length, n + '/' + use.length + ' 条');

      const layers = await cdp.eval('MapView.debugStats().layers');
      check('轨迹已绘制', layers === n, layers + ' 条图层');

      // 顶栏不应高得离谱（说明它换行换爆了）
      const barH = await cdp.eval("Math.round(document.querySelector('.topbar').getBoundingClientRect().height)");
      check('顶栏高度在合理范围（未换行换爆）', barH > 0 && barH < vp.h * 0.32,
        barH + 'px（视口高 ' + vp.h + '）');

      // 可交互元素不能小到点不中
      const tiny = JSON.parse(await cdp.eval(`(function(){
        var bad=[];
        document.querySelectorAll('.topbar button, .topbar select').forEach(function(el){
          var r=el.getBoundingClientRect();
          if(r.width>0 && r.height>0 && r.height<24) bad.push((el.textContent||el.tagName).trim().slice(0,10)+':'+Math.round(r.height));
        });
        return JSON.stringify(bad);
      })()`));
      check('顶栏按钮够大，手指点得中', tiny.length === 0, tiny.join(', '));
    }
  }, { width: vp.w, height: vp.h });
}

async function main() {
  console.log('骑行轨迹地图 · 手机端布局测试');
  const files = realFiles(6);
  if (!files.length) console.log('（没找到真实文件，只测空状态）');

  for (const vp of VIEWPORTS) {
    await testViewport(vp, files);
  }

  console.log('');
  console.log('SUMMARY | passed=' + passed.length + ' | failed=' + failed.length);
  process.exit(failed.length ? 1 : 0);
}

main().catch(e => {
  console.error('测试失败: ' + ((e && e.stack) || e));
  process.exit(1);
});
