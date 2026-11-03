#!/usr/bin/env node
/* =====================================================================
 * export_seed.js —— 把 js/seed.js 的种子数据导出为「线上形态」的 FHIR 资源包
 * ---------------------------------------------------------------------
 * 单一数据源原则：演示数据的唯一定义在 js/seed.js（前端装载时也用它），
 * Python 初始化脚本不重抄一份数据，而是调用本脚本拿到同一份 bundle。
 * 导出的每条资源都经过 FHIRR4.toWire（R5 类型降级、日期规范、语义 id 与
 * demo-scope 标签写入 meta.tag），因此和浏览器实际写入服务端的字节一致。
 *
 * 用法：
 *   node scripts/export_seed.js [--out build/seed-bundle.json] [--scope kjywfj-demo-v2]
 * ===================================================================== */
'use strict';
const fs = require('fs');
const path = require('path');
const H = require('../test/harness');

const argv = process.argv.slice(2);
function flag(name, dflt) {
  const i = argv.indexOf('--' + name);
  return i >= 0 && argv[i + 1] && !argv[i + 1].startsWith('--') ? argv[i + 1] : dflt;
}
const OUT = flag('out', path.join(H.ROOT, 'build', 'seed-bundle.json'));
const SCOPE = flag('scope', 'kjywfj-demo-v2');
const PERSIST_USAGE = argv.includes('--with-usage-records');

const win = H.boot({
  search: '?mode=local&autoSeed=0',
  config: { mode: 'local', autoSeed: false, demoScope: SCOPE, persistUsageRecords: PERSIST_USAGE }
});
const F = win.FHIR, R4 = win.FHIRR4;

// 与浏览器写穿时完全一致的转换：canonical → wire
const ctx = { exists: (t, id) => !!F.read(t, id) };
// 与浏览器写穿时一致：
//   1) 用药记录（MedicationAdministration）默认只留本地镜像，不落服务端；
//   2) 内部类型 Permission / Citation / ClinicalUseDefinition 在 toWire 时降级为
//      Basic，所以打包必须按「线上类型」归类，否则脚本会去 PUT 一个 R4 不存在的
//      类型路径（HAPI-0302）。
const LOCAL_ONLY = PERSIST_USAGE ? [] : ['MedicationAdministration'];
const types = {};
let total = 0;
function add(wire) {
  const t = wire.resourceType;
  (types[t] = types[t] || []).push(wire);
  total++;
}
const allTypes = F.remoteTypes().concat(Object.keys(F.dump()).filter(t => F.remoteTypes().indexOf(t) < 0));
allTypes.forEach(type => {
  if (LOCAL_ONLY.indexOf(type) >= 0) return;
  F.canonicalAll(type).forEach(c => add(R4.toWire(JSON.parse(JSON.stringify(c)), ctx)));
});

const order = F.remoteTypes().filter(t => types[t]).concat(Object.keys(types).filter(t => F.remoteTypes().indexOf(t) < 0));
const bundle = {
  meta: {
    generator: 'KJYWFJ export_seed.js',
    fhirVersion: '4.0.1',
    demoScope: SCOPE,
    tagSystem: R4.SCOPE_SYSTEM,
    idSystem: R4.ID_SYSTEM,
    exportedAt: new Date().toISOString(),
    resourceCount: total,
    // 写入顺序 = 引用依赖顺序；删除必须逆序
    writeOrder: order.filter(t => types[t]),
    localOnlyTypes: PERSIST_USAGE ? [] : ['MedicationAdministration']
  },
  counts: order.filter(t => types[t]).reduce((m, t) => { m[t] = types[t].length; return m; }, {}),
  resources: types
};

fs.mkdirSync(path.dirname(OUT), { recursive: true });
fs.writeFileSync(OUT, JSON.stringify(bundle, null, 1));
console.log('已导出 ' + total + ' 条资源 → ' + path.relative(H.ROOT, OUT));
console.log(Object.entries(bundle.counts).map(([k, v]) => k + '×' + v).join('  '));
