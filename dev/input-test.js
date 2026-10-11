#!/usr/bin/env node
/*!
 * input-test.js —— 真实文件选择控件的回归测试
 *
 * 为什么单独有这么一个测试？
 *   端到端测试是直接调 UI.importFiles(files) 的，绕过了 <input type="file">。
 *   于是「选了文件但什么都没发生」这个 bug 一路溜到了用户手上：
 *   input.files 返回的是**活的** FileList，代码为了支持「重复选同一个文件」
 *   先执行了 input.value = ''，那一步把 FileList 一起清空了，
 *   后面的长度判断永远不成立。
 *
 *   这个测试用 CDP 的 DOM.setFileInputFiles 往真实控件里塞真实文件，
 *   走的就是用户点「选择文件」的那条路径。
 *
 * 用法：
 *   node dev/input-test.js
 *   node dev/input-test.js <某个.gpx路径>
 */
'use strict';

const path = require('path');
const fs = require('fs');
const { withPage } = require('./cdp');

const root = path.join(__dirname, '..');

// 优先用真实文件；没有就退回仿真样本
function pickFiles() {
  const realDir = path.join(root, '华为导出骑行文件');
  if (fs.existsSync(realDir)) {
    const gpx = fs.readdirSync(realDir)
      .filter(f => /\.(gpx|tcx|kml)$/i.test(f)).sort();
    if (gpx.length) return gpx.map(f => path.join(realDir, f));
  }
  const samplesDir = path.join(__dirname, 'samples');
  const s = ['huawei-cycling.gpx', 'huawei-cycling.tcx', 'huawei-cycling.kml']
    .map(f => path.join(samplesDir, f)).filter(f => fs.existsSync(f));
  return s;
}

function fileUrl(rel) {
  return 'file:///' + path.join(root, rel).replace(/\\/g, '/');
}

async function main() {
  const files = process.argv[2] ? [path.resolve(process.argv[2])] : pickFiles();
  if (!files.length) {
    console.error('没有可用的测试文件');
    process.exit(1);
  }

  console.log('骑行轨迹地图 · 文件选择控件测试');
  console.log('');
  console.log('将尝试导入 ' + files.length + ' 个文件：');
  files.slice(0, 3).forEach(f => console.log('  ' + path.basename(f)));
  if (files.length > 3) console.log('  …等共 ' + files.length + ' 个');
  console.log('');

  const passed = [], failed = [];

  function check(name, cond, detail) {
    if (cond) { passed.push(name); console.log('PASS | ' + name + ' | ' + (detail || '')); }
    else { failed.push(name); console.log('FAIL | ' + name + ' | ' + (detail || '')); }
  }

  await withPage(fileUrl('index.html'), async (cdp, h) => {
    // 等主控启动完成（含本地存储恢复），并清掉上次留下的数据
    await cdp.eval('window.App && App.ready', true);
    await cdp.eval('(function(){ TracksStore.removeAll(); return true; })()');

    const before = await cdp.eval('TracksStore.count()');
    check('起始状态为空', before === 0, before + ' 条');

    // ★ 关键：往真实的 <input type="file"> 里塞文件，等同于用户点「选择文件」
    await h.setFileInput('#file-input', files);
    await h.sleep(2500);

    const after = await cdp.eval('TracksStore.count()');
    check('选择文件后轨迹被导入（走真实控件路径）', after > 0,
      before + ' → ' + after + ' 条');

    const rows = await cdp.eval("document.querySelectorAll('#track-list .track-item').length");
    check('轨迹列表渲染出行', rows === after, rows + ' 行 / ' + after + ' 条');

    const layers = await cdp.eval('MapView.debugStats().layers');
    check('轨迹已绘制到地图', layers === after, layers + ' 条图层');

    const progressHidden = await cdp.eval(
      "(function(){var p=document.querySelector('.progress');return !p || p.hidden;})()");
    check('导入完成后进度提示已隐藏', progressHidden === true);

    const noError = await cdp.eval(
      "(function(){return document.querySelectorAll('#notice-area .notice-error').length;})()");
    check('没有出现错误提示条', noError === 0, noError + ' 条错误提示');

    // 重复选同一批文件 —— 这正是当初清空 input.value 想解决的问题
    await h.setFileInput('#file-input', files);
    await h.sleep(2500);

    const twice = await cdp.eval('TracksStore.count()');
    check('重复选择同一批文件仍能触发导入', twice === after * 2,
      after + ' → ' + twice + ' 条（应为两倍）');

    // 空选择不应崩溃
    await cdp.eval("(function(){document.getElementById('file-input').dispatchEvent(new Event('change'));return true;})()");
    await h.sleep(400);
    const stillOk = await cdp.eval('TracksStore.count()');
    check('空 change 事件不会出错', stillOk === twice, stillOk + ' 条');

    const errs = await cdp.eval('window.__ERRORS__ ? __ERRORS__.length : 0');
    check('页面没有未捕获的错误', errs === 0, errs + ' 条');
  });

  console.log('');
  console.log('SUMMARY | passed=' + passed.length + ' | failed=' + failed.length);
  process.exit(failed.length ? 1 : 0);
}

main().catch(e => {
  console.error('测试失败: ' + (e && e.stack || e));
  process.exit(1);
});
