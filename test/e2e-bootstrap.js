/* =====================================================================
 * e2e-bootstrap.js —— 完整装载链路验证（需要一个可写的 FHIR R4 服务端）
 * ---------------------------------------------------------------------
 * 覆盖 round-trip 测试没有走到的路径：首启自动初始化 → 二次装载读回 → 对账
 * 丢弃残留 → 业务操作真实落库 → 大数据集按配置留在本地。
 *
 * 用法：
 *   docker run -d --name hapi-r4-test -p 8081:8080 \
 *     -e hapi.fhir.fhir_version=R4 \
 *     -e hapi.fhir.server.base_url=http://localhost:8081/fhir \
 *     hapiproject/hapi:latest
 *   FHIR_BASE=http://localhost:8081/fhir node test/e2e-bootstrap.js
 *
 * 默认指向本地实例；不打公共演示服务器，避免把本项目数据写进共享环境。
 * ===================================================================== */
'use strict';
const fs = require('fs');
const path = require('path');

const ROOT = path.join(__dirname, '..');
const BASE = process.env.FHIR_BASE || 'http://localhost:8081/fhir';
if (/hapi\.fhir\.org/.test(BASE)) {
  console.error('拒绝执行：本测试会写入业务数据，请不要指向公共演示服务器。');
  process.exit(2);
}

const mem = {};
const win = {
  location: { protocol: 'http:', search: '', hash: '', href: 'http://localhost/' },
  localStorage: {
    getItem: k => (k in mem ? mem[k] : null),
    setItem: (k, v) => { mem[k] = String(v); },
    removeItem: k => { delete mem[k]; }
  },
  addEventListener() {}, scrollTo() {},
  fetch: (...a) => fetch(...a), AbortController, URLSearchParams, Promise, console,
  setTimeout, clearTimeout
};
win.window = win;

function makeContext() {
  const load = rel => {
    const code = fs.readFileSync(path.join(ROOT, rel), 'utf8');
    new Function('window', 'global', 'location', 'localStorage', 'fetch', 'AbortController',
      'URLSearchParams', 'console', code)(win, win, win.location, win.localStorage, win.fetch,
      win.AbortController, win.URLSearchParams, win.console);
  };
  win.App = {
    state: { roleCode: 'admin' },
    currentUser: () => ({ name: '李建国', display: '管理员·李建国', role: 'admin', title: null, practitioner: 'Practitioner-9001' }),
    toast() {}, bump() {}, navigate() {}
  };
  ['js/config.js', 'js/fhir-r4.js', 'js/fhir-client.js', 'js/fhir-ext.js', 'js/domain.js',
    'js/fhir-store.js', 'js/fhir-profiles.js', 'js/seed.js', 'js/services.js'].forEach(load);
  return win;
}

let pass = 0, fail = 0;
const ok = (c, m) => { if (c) pass++; else { fail++; console.error('  ✗ ' + m); } };
const info = m => console.log('  ' + m);
const sleep = ms => new Promise(r => setTimeout(r, ms));

async function waitSettled(F, limitMs = 240000) {
  const t0 = Date.now();
  let st;
  do {
    st = await F.flush();
    if (st.queued === 0 && st.inflight === 0) return st;
    if (Date.now() - t0 > limitMs) return st;
    await sleep(400);
  } while (true);
}

async function snapshot(base) {
  const types = ['Organization', 'Practitioner', 'Patient', 'Medication', 'Basic', 'PlanDefinition',
    'DetectedIssue', 'Observation', 'Communication', 'Provenance', 'Endpoint', 'Task',
    'StructureDefinition', 'MedicationAdministration'];
  const out = {};
  for (const t of types) {
    // HAPI 默认不返回 Bundle.total（需 Prefer: return-count），改用一页 100 条的 entry 计数
    const r = await fetch(`${base}/${t}?_count=100`);
    const j = await r.json().catch(() => ({}));
    out[t] = (j.entry || []).length;
  }
  return out;
}

/* HAPI 的搜索索引是异步构建的，写入后立刻搜索可能返回空——等它追上，
   否则测试断言会偶然失败 */
async function waitIndexed(base, type, expect, limitMs = 90000) {
  const t0 = Date.now();
  while (Date.now() - t0 < limitMs) {
    const r = await fetch(`${base}/${type}?_count=100`);
    const j = await r.json().catch(() => ({}));
    if ((j.entry || []).length >= expect) return (j.entry || []).length;
    await sleep(1500);
  }
  return -1;
}

(async () => {
  info('目标服务端：' + BASE);
  makeContext();   // 先装载数据层脚本，FHIRClient 等才存在
  try {
    await win.FHIRClient.capabilities(BASE, { timeout: 10000 });
  } catch (e) {
    console.error('\n无法连接 ' + BASE + '：' + e.message);
    console.error('请先按文件头注释启动一个本地 HAPI 实例。');
    process.exit(2);
  }

  /* ---- 1. 首次启动：空服务端应被自动初始化 ---- */
  console.log('\n== 1. 首启：空服务端自动初始化 ==');
  const before = await snapshot(BASE);
  info('初始化前服务端资源总数：' + Object.values(before).reduce((a, b) => a + b, 0));

  let ctx = makeContext();
  let F = ctx.FHIR;
  await ctx.AmrConfig.set({ fhirBase: BASE, mode: 'remote', autoSeed: true, persistUsageRecords: false });
  const st1 = await F.bootstrap();
  ok(st1.mode === 'remote', '未进入 remote 模式');
  ok(st1.loadedCount === 0, '空服务端却读到了数据：' + st1.loadedCount);
  const settled1 = await waitSettled(F);
  ok(settled1.failed === 0, '初始化写入失败 ' + settled1.failed + ' 条：'
    + JSON.stringify(settled1.lastError));
  info('pushAll 入队 ' + st1.pushed + ' 条 → 实际写入 ' + settled1.done + ' 条，失败 ' + settled1.failed);
  ok(settled1.done === st1.pushed, '写入数量与入队不符：' + settled1.done + ' vs ' + st1.pushed);
  const idxMed = await waitIndexed(BASE, 'Medication', 30);
  ok(idxMed >= 30, 'Medication 搜索索引未在合理时间内就绪：' + idxMed);

  const after = await snapshot(BASE);
  info('服务端各类型数量：' + Object.keys(after).filter(k => after[k]).map(k => k + '×' + after[k]).join(', '));
  ok(after.Medication === 30, 'Medication 应为 30，实际 ' + after.Medication);
  ok(after.Patient >= 6, 'Patient 至少 6，实际 ' + after.Patient);
  ok(after.Task >= 10, 'Task 至少 10，实际 ' + after.Task);
  ok(after.MedicationAdministration === 0,
    'persistUsageRecords=false 时不应把用药记录落服务端，实际 ' + after.MedicationAdministration);
  ok(after.Basic >= 13, '配置单例 + 三类自定义概念都应落在 Basic 上，实际 ' + after.Basic);
  info('本地镜像用药记录（未落库）：' + F.count('MedicationAdministration'));

  /* ---- 2. 二次启动：应从服务端读回并保留业务类型名 ---- */
  console.log('\n== 2. 二次装载：读回 + 类型还原 ==');
  ctx = makeContext();
  F = ctx.FHIR;
  await ctx.AmrConfig.set({ fhirBase: BASE, mode: 'remote', autoSeed: true, persistUsageRecords: false });
  const st2 = await F.bootstrap();
  await waitSettled(F);
  info('读回 ' + st2.loadedCount + ' 条，对账丢弃 ' + st2.reconciled + ' 条本地预置残留');
  ok(st2.loadedCount > 0, '二次装载没有读到服务端数据');
  ok(st2.pushed === 0, '服务端已有数据却又初始化了一遍：' + st2.pushed);
  ok(F.count('Permission') === 6, 'Permission 应还原为 6 个内部资源，实际 ' + F.count('Permission'));
  ok(F.count('Citation') === 5, 'Citation 应还原 5 个，实际 ' + F.count('Citation'));
  ok(F.count('ClinicalUseDefinition') === 10, 'ClinicalUseDefinition 应还原 10 个，实际 ' + F.count('ClinicalUseDefinition'));
  ok(F.count('Medication') === 30, 'Medication 应 30 个，实际 ' + F.count('Medication'));
  const med = F.search('Medication', m => m.code.text === '美罗培南')[0];
  ok(med && med.ext.level === 'special', '美罗培南的分级扩展未无损读回：' + JSON.stringify(med && med.ext));
  ok(F.read('Basic', 'Basic-catalog-version'), '配置单例 Basic-catalog-version 未读回');
  const ep = F.read('Endpoint', 'Endpoint-rational');
  ok(ep && ep.status === 'error', 'Endpoint 业务状态应还原为 error，实际 ' + (ep && ep.status));
  const di = F.read('DetectedIssue', 'DetectedIssue-1');
  ok(di && di.status === 'preliminary', 'DetectedIssue 业务状态应还原为 preliminary，实际 ' + (di && di.status));
  ok(F.read('Task', 'Task-1002'), '带引用的 Task 应能读回');

  /* ---- 3. 业务操作真实落库 ---- */
  console.log('\n== 3. 业务操作写穿 ==');
  const Svc = ctx.Svc;
  const newMed = Svc.saveMedication({ name: '头孢地尼（E2E 新增）', ext: {
    drugClass: '头孢菌素类（三代）', level: 'restricted', spec: '0.1g×10粒', brand: '—',
    manufacturer: '测试厂', indicationSummary: '敏感菌感染', usage: '口服',
    allowedTitles: ['chief', 'associate', 'attending'], approvals: ['dept', 'pharmacy'],
    overridden: false, insurance: '医保乙类', stock: '充足', pendingUpdate: false } }, true);
  Svc.submitApplication({
    type: 'special', drug: '美罗培南', dept: '内科', useStart: '2026-11-03', useEnd: '2026-11-10',
    reason: 'E2E 提交申请验证', patientName: '测试患者', mrn: 'E2E-0001',
    diagnosis: '肺部感染', infection: '痰培养阳性', attachments: [] });
  const submitted = F.read('Task', F.search('Task', t => t.ext.mrn === 'E2E-0001')[0].id);
  ok(submitted && submitted.for, '新建申请应关联到真实 Patient');
  // 特殊使用级为三级流程：科室负责人自动通过，药学部门、审批专家各审批一次才完成
  let approved = submitted;
  for (let i = 0; i < 3 && approved.status === 'in-progress'; i++) {
    approved = Svc.approveApplication(approved.id, 'approved', '');
    await waitSettled(F);
  }
  Svc.deleteMedication(newMed.id);

  const settled3 = await waitSettled(F);
  ok(settled3.failed === 0, '业务写穿失败 ' + settled3.failed + ' 条：' + JSON.stringify(settled3.lastError));
  info('本轮写入 ' + settled3.done + ' 条，失败 ' + settled3.failed);

  const got = await win.FHIRClient.get(BASE, 'Task', approved.id);
  ok(got && got.status === 'completed', '审批结果未落服务端，status=' + (got && got.status));
  const byTag = await win.FHIRClient.byTag(BASE, 'Task', ctx.FHIRR4.ID_SYSTEM, approved.id);
  ok((byTag.entry || []).length === 1, 'Task 无法按 _tag 找回');
  const gone = await fetch(`${BASE}/Medication/${encodeURIComponent(newMed.id)}`);
  ok(gone.status === 404 || gone.status === 410, '删除未落服务端，状态码 ' + gone.status);
  const medAfter = await win.FHIRClient.get(BASE, 'Medication', 'Medication-21');
  const backMed = ctx.FHIRR4.fromWire(medAfter);
  ok(ctx.FHIRExt.decode('Medication', backMed).approvals.length === 3,
    '特殊使用级审批节点数量与服务端不一致');
  const patient = await win.FHIRClient.get(BASE, 'Patient', approved.for.reference.split('/')[1]);
  ok(patient && patient.id, '申请未关联到真实 Patient 资源');
  info('申请单 Patient 关联：' + approved.for.reference + '（引用完整性校验已通过）');

  /* ---- 4. 服务端确实存的是合法 R4：不应出现 R5-only 类型 ---- */
  console.log('\n== 4. 服务端资源类型合规 ==');
  for (const t of ['Permission', 'Citation', 'ClinicalUseDefinition']) {
    const r = await fetch(`${BASE}/${t}?_count=1`);
    ok(r.status === 404 || r.status === 400 || r.status === 405,
      t + ' 不该作为资源类型出现在 R4 服务端，实际搜索返回 ' + r.status);
  }

  const finalSnap = await snapshot(BASE);
  info('最终服务端资源总数：' + Object.values(finalSnap).reduce((a, b) => a + b, 0));
  console.log('\n==== 结果：通过 ' + pass + ' 项，失败 ' + fail + ' 项 ====');
  process.exit(fail ? 1 : 0);
})().catch(async e => {
  console.error('\n测试异常：', e && e.stack || e);
  process.exit(1);
});
