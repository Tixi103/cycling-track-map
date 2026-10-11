#!/usr/bin/env node
/*!
 * run-tests.js —— 一条命令跑完全部测试
 *
 *   node dev/run-tests.js
 *
 * 会依次执行：
 *   1. 重新生成样本文件（保证测试数据与生成脚本同步）
 *   2. 解析层自检        dev/selftest.html
 *   3. 端到端测试        _apptest.html（由 index.html 生成，测的是真实页面）
 *
 * 全程走 dev/probe-realtime.js 的真实时钟通道 —— 端到端测试涉及 IndexedDB，
 * 用 --virtual-time-budget 会得到错误的结论（详见 store.js 里的注释）。
 * 解析层自检本来是纯计算，但统一走同一条通道更省心，也慢不了多少。
 *
 * 退出码：全部通过为 0，有失败为 1。
 */
'use strict';

const { spawn, spawnSync } = require('child_process');
const path = require('path');
const fs = require('fs');

const root = path.join(__dirname, '..');
const node = process.execPath;

function run(cmd, args, opts) {
  return new Promise((resolve) => {
    const p = spawn(cmd, args, Object.assign({ cwd: root, stdio: ['ignore', 'pipe', 'pipe'] }, opts || {}));
    let out = '', err = '';
    p.stdout.on('data', d => { out += d; });
    p.stderr.on('data', d => { err += d; });
    p.on('close', code => resolve({ code, out, err }));
  });
}

function fileUrl(rel) {
  return 'file:///' + path.join(root, rel).replace(/\\/g, '/');
}

/** 用真实时钟跑页面，取回指定元素的文本 */
function probePage(relPath, selector, waitMs) {
  return run(node, [
    path.join(__dirname, 'probe-realtime.js'),
    fileUrl(relPath),
    `document.querySelector(${JSON.stringify(selector)}).textContent`,
    String(waitMs)
  ]);
}

function summarize(label, text) {
  const lines = String(text || '').split('\n');
  const fails = lines.filter(l => l.startsWith('FAIL'));
  const summary = lines.find(l => l.startsWith('SUMMARY')) || '（没有拿到 SUMMARY，测试可能没跑完）';
  return { label, fails, summary };
}

async function main() {
  console.log('骑行轨迹地图 · 测试\n');

  // ── 1. 生成样本 ──
  process.stdout.write('生成样本 …  ');
  const gen = spawnSync(node, [path.join(__dirname, 'make-sample.js')], { cwd: root, encoding: 'utf8' });
  if (gen.status !== 0) {
    console.log('失败');
    console.error(gen.stderr || gen.stdout);
    process.exit(1);
  }
  console.log('完成');

  // ── 2. 生成端到端测试页 ──
  process.stdout.write('生成测试页 …  ');
  const mk = spawnSync(node, [path.join(__dirname, 'make-apptest.js')], { cwd: root, encoding: 'utf8' });
  if (mk.status !== 0) {
    console.log('失败');
    console.error(mk.stderr || mk.stdout);
    process.exit(1);
  }
  console.log('完成');

  // ── 2b. 有真实文件的话，一并生成真实文件测试页 ──
  const realDir = path.join(root, '华为导出骑行文件');
  const hasReal = fs.existsSync(realDir) &&
    fs.readdirSync(realDir).some(f => /\.(gpx|tcx|kml)$/i.test(f));

  if (hasReal) {
    process.stdout.write('生成真实文件测试页 …  ');
    const mr = spawnSync(node, [path.join(__dirname, 'make-realtest.js')], { cwd: root, encoding: 'utf8' });
    if (mr.status !== 0) {
      console.log('失败');
      console.error(mr.stderr || mr.stdout);
      process.exit(1);
    }
    console.log('完成');
  } else {
    console.log('（跳过真实文件测试：华为导出骑行文件/ 目录为空）');
  }
  console.log('');

  const results = [];

  // ── 3. 解析层自检 ──
  process.stdout.write('解析层自检 …  ');
  const a = await probePage('dev/selftest.html', '#log', 8000);
  let aText = a.out;
  try { aText = JSON.parse(a.out); } catch (e) { /* 直接是文本 */ }
  const ra = summarize('解析层自检', aText);
  console.log(ra.summary.replace('SUMMARY', '').replace(/\|/g, ' ').trim());
  results.push(ra);

  // ── 4. 端到端测试 ──
  process.stdout.write('端到端测试 …  ');
  const b = await probePage('_apptest.html', '#apptest-log', 22000);
  let bText = b.out;
  try { bText = JSON.parse(b.out); } catch (e) { /* 直接是文本 */ }
  const rb = summarize('端到端测试', bText);
  console.log(rb.summary.replace('SUMMARY', '').replace(/\|/g, ' ').trim());
  results.push(rb);

  // ── 5. 真实文件交叉验证（有真实文件才跑）──
  if (hasReal) {
    process.stdout.write('真实文件交叉验证 …  ');
    const c = await probePage('_realtest.html', '#realtest-log', 20000);
    let cText = c.out;
    try { cText = JSON.parse(c.out); } catch (e) { /* 直接是文本 */ }
    const rc = summarize('真实文件交叉验证', cText);

    // 把对账表也打出来 —— 这是最能说明问题的一屏
    const tableLines = String(cText).split('\n').filter(l => /^\s+\S.*km.*%/.test(l));
    console.log(rc.summary.replace('SUMMARY', '').replace(/\|/g, ' ').trim());
    if (tableLines.length) {
      console.log('');
      console.log('  用设备自报的数字校验本项目的统计口径：');
      tableLines.forEach(l => console.log(l));
      console.log('');
    }
    results.push(rc);
  }

  // ── 6. 真实文件选择控件（用户点「选择文件」的那条路径）──
  process.stdout.write('文件选择控件 …  ');
  const d = await run(node, [path.join(__dirname, 'input-test.js')]);
  const rd = summarize('文件选择控件', d.out);
  console.log(rd.summary.replace('SUMMARY', '').replace(/\|/g, ' ').trim());
  results.push(rd);

  // ── 汇总 ──
  let failed = 0;
  console.log('');
  for (const r of results) {
    if (r.fails.length) {
      failed += r.fails.length;
      console.log('【' + r.label + '】有 ' + r.fails.length + ' 项失败：');
      r.fails.forEach(l => console.log('  ' + l));
    }
  }

  if (failed) {
    console.log('\n共 ' + failed + ' 项失败。');
    process.exit(1);
  }
  console.log('全部通过。');
  process.exit(0);
}

main().catch(e => {
  console.error('测试运行器自身出错: ' + e.message);
  process.exit(1);
});
