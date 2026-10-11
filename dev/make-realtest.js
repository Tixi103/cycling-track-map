#!/usr/bin/env node
/*!
 * make-realtest.js —— 用真实的华为导出文件生成测试页
 *
 * 仿真样本只能验证「代码按我设想的格式工作」，验证不了「我设想的格式对不对」。
 * 真实的华为运动健康导出文件（creator="Health"、GPX 1.0、trkpt 里只有经纬度和时间）
 * 与仿真样本差别很大，必须用它再跑一轮。
 *
 * 最有价值的一点：真实文件的 <trk><extensions> 里带着**设备自己算出来的**
 * totalDistance / totalTime / cumulativeClimb。这是现成的地面真值，
 * 可以直接拿来校验本项目的统计口径准不准。
 *
 * 用法：
 *   node dev/make-realtest.js
 *   node dev/probe-realtime.js "file:///.../_realtest.html" \
 *        "document.getElementById('realtest-log').textContent" 20000
 */
'use strict';

const fs = require('fs');
const path = require('path');
const { spawnSync } = require('child_process');

const root = path.join(__dirname, '..');
const srcDir = path.join(root, '华为导出骑行文件');

if (!fs.existsSync(srcDir)) {
  console.error('没找到真实文件目录：' + srcDir);
  console.error('把华为运动健康导出的 .gpx/.tcx/.kml 放进去再运行。');
  process.exit(1);
}

/**
 * 递归收集轨迹文件。
 * 真实导出的文件常常被按格式分到子目录里（gpx/ tcx/ kml/），
 * 只扫一层会漏掉一大半。返回的是相对 srcDir 的路径。
 */
function walk(dir, base) {
  const out = [];
  for (const entry of fs.readdirSync(dir).sort()) {
    const full = path.join(dir, entry);
    const rel = base ? base + '/' + entry : entry;
    const st = fs.statSync(full);
    if (st.isDirectory()) out.push(...walk(full, rel));
    else if (/\.(gpx|tcx|kml)$/i.test(entry)) out.push(rel);
  }
  return out;
}

const files = walk(srcDir, '');
if (!files.length) {
  console.error('目录里没有轨迹文件。');
  process.exit(1);
}

const contents = {};
const meta = {};

/**
 * 从一份导出文件里提取「地面真值」——设备自己算出来的汇总数据。
 *
 * 三种格式的存放位置完全不同，必须分开处理：
 *   GPX  <trk><extensions><totalDistance> / <totalTime>
 *   TCX  <Lap><DistanceMeters> / <TotalTimeSeconds>
 *   KML  <ExtendedData><Data name="totalDistance"><value>
 */
function extractMeta(text, name) {
  const isTcx = /<TrainingCenterDatabase/i.test(text);
  const isKml = /<kml[\s>]/i.test(text);
  const format = isTcx ? 'tcx' : isKml ? 'kml' : 'gpx';

  const num = (re) => {
    const m = re.exec(text);
    return m ? parseFloat(m[1]) : null;
  };

  let pointCount = 0;
  let deviceDistance = null, deviceDuration = null;

  if (format === 'tcx') {
    pointCount = (text.match(/<Trackpoint/g) || []).length;
    deviceDistance = num(/<DistanceMeters>([\d.]+)/);
    deviceDuration = num(/<TotalTimeSeconds>([\d.]+)/);
  } else if (format === 'kml') {
    // 华为的 KML 是一个点一个 Placemark，轨迹点带 TimeSpan
    pointCount = (text.match(/<TimeSpan>/g) || []).length;
    deviceDistance = num(/name="totalDistance"[^>]*>\s*<value>([\d.]+)/);
    deviceDuration = num(/name="totalTime"[^>]*>\s*<value>([\d.]+)/);
  } else {
    pointCount = (text.match(/<trkpt/g) || []).length;
    deviceDistance = num(/<totalDistance>([\d.]+)/);
    deviceDuration = num(/<totalTime>([\d.]+)/);
  }

  return {
    format: format,
    pointCount: pointCount,
    deviceDistance: deviceDistance,
    deviceDuration: deviceDuration,
    creator: (/creator="([^"]*)"/.exec(text) || [])[1] || '',
    version: (/version="([^"]*)"/.exec(text) || [])[1] || '',
    hasEle: /<ele[ >]|AltitudeMeters/.test(text),
    hasHr: /<hr[ >]|HeartRateBpm/.test(text),
    sizeKB: Math.round(Buffer.byteLength(text, 'utf8') / 1024)
  };
}

for (const name of files) {
  const text = fs.readFileSync(path.join(srcDir, name), 'utf8');
  contents[name] = text;
  meta[name] = extractMeta(text, name);
}

// 内联成 JS（file:// 下不能 fetch 本地文件）
const inline =
  '/* 由 dev/make-realtest.js 自动生成，请勿手工编辑。 */\n' +
  'window.REAL_SAMPLES = ' + JSON.stringify(contents) + ';\n' +
  'window.REAL_META = ' + JSON.stringify(meta, null, 2) + ';\n';

const outDir = path.join(__dirname, 'samples');
fs.mkdirSync(outDir, { recursive: true });
fs.writeFileSync(path.join(outDir, 'real-samples.js'), inline, 'utf8');

// 生成测试页（复用与端到端测试相同的注入逻辑，保证测的是真实 index.html）
const gen = spawnSync(process.execPath, [
  path.join(__dirname, 'make-apptest.js'), 'dev/realtest-drive.js', '_realtest.html'
], { cwd: root, encoding: 'utf8', stdio: 'inherit' });

if (gen.status !== 0) process.exit(gen.status || 1);

// 把 real-samples.js 也注入进去
const page = path.join(root, '_realtest.html');
let html = fs.readFileSync(page, 'utf8');
html = html.replace(
  '<script defer src="dev/realtest-drive.js"></script>',
  '<script defer src="dev/samples/real-samples.js"></script>\n<script defer src="dev/realtest-drive.js"></script>'
);
fs.writeFileSync(page, html, 'utf8');

console.log('');
console.log('真实文件：' + files.length + ' 个');

// 按格式分组统计
const byFormat = {};
for (const name of files) {
  const f = meta[name].format;
  byFormat[f] = (byFormat[f] || 0) + 1;
}
console.log('  ' + Object.keys(byFormat).map(f => f.toUpperCase() + ' ' + byFormat[f] + ' 个').join('，'));

// GPX 有很多（几十个），只汇总；TCX / KML 少，逐个列出来
const gpxFiles = files.filter(f => meta[f].format === 'gpx');
if (gpxFiles.length > 5) {
  let pts = 0, dist = 0, dur = 0, ele = 0, hr = 0;
  for (const f of gpxFiles) {
    const m = meta[f];
    pts += m.pointCount;
    dist += m.deviceDistance || 0;
    dur += m.deviceDuration || 0;
    if (m.hasEle) ele++;
    if (m.hasHr) hr++;
  }
  console.log('');
  console.log('  GPX 合计：' + gpxFiles.length + ' 条，' + pts + ' 个点，' +
    (dist / 1000).toFixed(1) + ' 公里，' + (dur / 3600).toFixed(1) + ' 小时');
  console.log('  含海拔的：' + ele + ' 条；含心率的：' + hr + ' 条');
}

const others = files.filter(f => meta[f].format !== 'gpx');
if (others.length) {
  console.log('');
  console.log('  文件'.padEnd(34) + '格式'.padStart(6) + '点数'.padStart(8) +
              '设备里程'.padStart(12) + '设备时长'.padStart(12));
  for (const name of others) {
    const m = meta[name];
    console.log('  ' + name.padEnd(32) + m.format.toUpperCase().padStart(6) +
      String(m.pointCount).padStart(8) +
      String(m.deviceDistance === null ? '?' : m.deviceDistance.toFixed(0) + 'm').padStart(12) +
      String(m.deviceDuration === null ? '?' : m.deviceDuration.toFixed(0) + 's').padStart(12));
  }
}

console.log('');
console.log('已生成 _realtest.html');
