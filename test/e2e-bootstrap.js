#!/usr/bin/env node
/* =====================================================================
 * e2e-bootstrap.js —— 完整装载链路验证（需要一个可写的 FHIR R4 服务端）
 * ---------------------------------------------------------------------
 * 覆盖 round-trip 测试没走到的路径：
 *   首启自动初始化 → 二次装载读回 → 对账丢弃残留 → 业务操作真实落库
 *   → SRS 新增资源（Encounter / PractitionerRole / MedicationRequest /
 *     主 Task + 节点 Task / AuditEvent）真实往返 → 大数据集按配置留在本地。
 * 写入时使用独立 demo-scope，结束时清理，不污染服务端上的其他数据。
 *
 * 用法：
 *   npm run fhir:up        # docker 起本地 HAPI（8081，R4）
 *   npm run test:e2e
 *   FHIR_BASE=http://其他/fhir node test/e2e-bootstrap.js
 * 默认指向本地实例；拒绝打公共演示服务器（那条链路由 test:demo 覆盖）。
 * ===================================================================== */
'use strict';
const H = require('./harness');

const BASE = process.env.FHIR_BASE || 'http://localhost:8081/fhir';
if (/hapi\.fhir\.org/.test(BASE)) {
  console.error('拒绝执行：本测试会写入业务数据，请不要指向公共演示服务器。');
  console.error('公共服务器上的全链路验证请用 npm run test:demo');
  process.exit(2);
}
const SCOPE = 'kjywfj-e2e-' + Date.now();
const KEEP = process.env.KEEP === '1';

let pass = 0, fail = 0;
const ok = (c, m) => { if (c) pass++; else { fail++; console.error('  ✗ ' + m); } };
const info = m => console.log('  ' + m);
const sleep = ms => new Promise(r => setTimeout(r, ms));

function makeContext() {
  const win = H.makeWindow({ search: '?mode=remote', config: { mode: 'remote', demoScope: SCOPE, autoSeed: true, persistUsageRecords: false } });
  H.loadInto(win);
  H.stubApp(win, 'id-admin');
  return win;
}

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

/* 取某类型下「属于本作用域」的资源。
 * 先按 _tag 检索；检索报错或返回空（服务端索引滞后、该实例未启用 _tag 索引）时
 * 退回全量列表，但逐条核对 meta.tag —— 公共实例上绝不能按类型盲删别人的数据。 */
async function mineResources(base, type, scope, opts) {
  const win = makeContext();
  const R = win.FHIRR4;
  const owned = (r) => (((r.meta || {}).tag || [])
    .some(c => c.system === R.SCOPE_SYSTEM && c.code === scope));
  let err = null, list = [];
  try { list = await win.FHIRClient.fetchAllByTag(base, type, R.SCOPE_SYSTEM, scope, opts); }
  catch (e) { err = e; }
  if (!list.length) {
    let all = [];
    try { all = await win.FHIRClient.fetchAll(base, type, opts); } catch (e) { err = err || e; }
    list = all.filter(owned);
  }
  return { list: list, err: err ? String(err.message || err) : null };
}

/* 统计服务端条数。本测试跑在自建实例上，但统计口径仍按作用域过滤，
 * 与公共实例上「只认自己数据」的行为保持一致。 */
async function snapshot(base, types) {
  const out = {};
  for (const t of types) {
    const r = await mineResources(base, t, SCOPE, { timeout: 25000 });
    out[t] = r.list.length;
  }
  return out;
}
async function waitIndexed(base, types, expect, limitMs = 120000) {
  const need = Object.keys(expect);   // 只有列在 expect 里的类型需要达标，其余仅供后续断言读取
  const t0 = Date.now();
  let snap = {};
  while (Date.now() - t0 < limitMs) {
    snap = await snapshot(base, types);
    if (need.every(t => snap[t] >= expect[t])) return snap;
    await sleep(2000);
  }
  info('超时未达标：' + need.filter(t => !(snap[t] >= expect[t])).map(t => t + ' ' + snap[t] + '/' + expect[t]).join(', '));
  return null;
}

const TYPES = ['Organization', 'Practitioner', 'Patient', 'PractitionerRole', 'Encounter', 'Medication',
  'MedicationKnowledge', 'MedicationRequest', 'Basic', 'PlanDefinition', 'Task', 'Communication',
  'CommunicationRequest', 'Provenance', 'AuditEvent', 'StructureDefinition', 'CodeSystem', 'ValueSet',
  'DetectedIssue', 'Observation', 'Endpoint', 'MedicationAdministration'];

(async () => {
  info('目标服务端：' + BASE + '（scope=' + SCOPE + '）');
  const probe = makeContext();
  try { await probe.FHIRClient.capabilities(BASE, { timeout: 10000 }); }
  catch (e) {
    console.error('\n无法连接 ' + BASE + '：' + e.message);
    console.error('请先执行 npm run fhir:up 启动本地 HAPI。');
    process.exit(2);
  }

  /* ---- 1. 首启：空服务端自动初始化 ---- */
  console.log('\n== 1. 首启：空服务端自动初始化 ==');
  let ctx = makeContext();
  let F = ctx.FHIR;
  await ctx.AmrConfig.set({ fhirBase: BASE, mode: 'remote', autoSeed: true, demoScope: SCOPE, persistUsageRecords: false });
  const st1 = await F.bootstrap();
  ok(st1.mode === 'remote', '未进入 remote 模式');
  const settled1 = await waitSettled(F);
  ok(settled1.failed === 0, '初始化写入失败 ' + settled1.failed + ' 条：'
    + (settled1.errors || []).map(e => e.type + '/' + e.id + ' ' + (e.hapiCode || '') + ' ' + e.message).join(' | '));
  info('入队 ' + st1.pushed + ' 条 → 实际写入 ' + settled1.done + ' 条');
  ok(st1.pushed === 0 || settled1.done >= st1.pushed, '写入数量少于入队');
  const idx = await waitIndexed(BASE, TYPES, {
    Medication: 30, Patient: 6, Task: 28, Encounter: 6, PractitionerRole: 16,
    MedicationKnowledge: 30, PlanDefinition: 7, AuditEvent: 16
  });
  ok(!!idx, 'SRS 新增资源未能在超时内被服务端检索到');
  if (idx) {
    info('服务端本作用域：' + Object.keys(idx).filter(k => idx[k]).map(k => k + '×' + idx[k]).join(', '));
    ok(idx.Medication === 30, 'Medication 应为 30，实际 ' + idx.Medication);
    ok(idx.Encounter >= 6, 'Encounter 至少 6，实际 ' + idx.Encounter);
    ok(idx.PractitionerRole >= 16, 'PractitionerRole 至少 16，实际 ' + idx.PractitionerRole);
    ok(idx.Task >= 28, '主/节点 Task 至少 28，实际 ' + idx.Task);
    ok(idx.MedicationAdministration === 0, 'persistUsageRecords=false 时用药记录不应落服务端，实际 ' + idx.MedicationAdministration);
    ok(idx.Basic >= 40, '配置单例 + 三类自定义概念都应落在 Basic 上，实际 ' + idx.Basic);
  }
  info('本地镜像用药记录（未落库）：' + F.count('MedicationAdministration'));

  /* ---- 2. 二次装载：读回 + 内部类型还原 ---- */
  console.log('\n== 2. 二次装载：读回 + 类型还原 ==');
  ctx = makeContext(); F = ctx.FHIR;
  await ctx.AmrConfig.set({ fhirBase: BASE, mode: 'remote', autoSeed: true, demoScope: SCOPE, persistUsageRecords: false });
  const st2 = await F.bootstrap();
  await waitSettled(F);
  info('读回 ' + st2.loadedCount + ' 条，对账丢弃 ' + st2.reconciled + ' 条');
  ok(st2.loadedCount > 0, '二次装载没有读到服务端数据');
  ok(st2.pushed === 0, '服务端已有数据却又初始化了一遍：' + st2.pushed);
  ok(F.count('Permission') === 11, 'Permission 应还原为 11 个内部资源，实际 ' + F.count('Permission'));
  ok(F.count('Citation') === 5, 'Citation 应还原 5 个，实际 ' + F.count('Citation'));
  ok(F.count('ClinicalUseDefinition') === 10, 'ClinicalUseDefinition 应还原 10 个，实际 ' + F.count('ClinicalUseDefinition'));
  ok(F.count('Medication') === 30, 'Medication 应 30 个，实际 ' + F.count('Medication'));
  const med = F.search('Medication', m => m.code.text === '美罗培南')[0];
  ok(med && med.ext.level === 'special', '美罗培南的分级扩展未无损读回：' + JSON.stringify(med && med.ext));
  const enc = F.read('Encounter', 'Encounter-2');
  ok(enc && enc.ext.kind === 'inpatient' && enc.period.start.indexOf('T') > 0, 'Encounter 应无损读回（含 ISO 日期）');
  const prole = F.read('PractitionerRole', 'PractitionerRole-9003');
  ok(prole && Array.isArray(prole.code) && prole.ext.roles.indexOf('doctor') >= 0, 'PractitionerRole.code/ext.roles 应无损读回');
  const cs = F.read('CodeSystem', 'CodeSystem-amr-level');
  ok(cs && Array.isArray(cs.concept) && cs.concept.length === 3, 'CodeSystem 的 concept 应无损读回');
  const ep = F.read('Endpoint', 'Endpoint-rational');
  ok(ep && ep.status === 'error', 'Endpoint 业务状态应还原为 error，实际 ' + (ep && ep.status));
  const di = F.read('DetectedIssue', 'DetectedIssue-1');
  ok(di && di.status === 'preliminary', 'DetectedIssue 业务状态应还原为 preliminary，实际 ' + (di && di.status));

  /* ---- 3. SRS 审批链路的真实落库 ---- */
  console.log('\n== 3. SRS 开单 → 审批 → 留痕 写穿 ==');
  const S = ctx.Svc, A = ctx.Approval;
  const order = S.srs.submitOrder({
    practitionerId: 'Practitioner-9003', medicationId: 'Medication-21', patientId: 'Patient-1',
    encounterId: 'Encounter-1', patientName: '陈秀英', mrn: 'ZY20260615001', diagnosis: '肺炎',
    purposeCode: 'mdr', purposeNote: 'E2E 验证', dosageText: '1g q8h', reason: 'E2E 超权限申请'
  });
  ok(order.mode === 'approval', 'E2E 开单应进入审批，实际 ' + order.mode);
  const mainId = order.instance.id;
  let rounds = 0;
  while (rounds++ < 8) {
    const n = A.firstActionableNode(mainId, null);
    if (!n) break;
    const r = A.act({ taskId: mainId, action: 'approve', operatorPractId: n.ext.assigneeIds[0], comment: 'E2E 通过' });
    if (['approved', 'rejected'].indexOf(r.flowStatus) >= 0) break;
  }
  const settled3 = await waitSettled(F);
  ok(settled3.failed === 0, '业务写穿失败 ' + settled3.failed + ' 条：' + JSON.stringify(settled3.lastError));
  await sleep(3000);
  const mainBack = await ctx.FHIRClient.get(BASE, 'Task', mainId);
  ok(mainBack.status === 'completed', '流程主任务未落服务端，status=' + mainBack.status);
  ok(/\|/.test(mainBack.instantiatesCanonical || ''), '主任务应绑定流程版本 canonical，实际 ' + mainBack.instantiatesCanonical);
  const nodeBack = await ctx.FHIRClient.get(BASE, 'Task', A.nodeTaskId(mainId, 1));
  ok(nodeBack.partOf[0].reference === 'Task/' + mainId, '节点 Task 的 partOf 应落服务端');
  ok(nodeBack.restriction && nodeBack.restriction.period.end.indexOf('T') > 0, '节点任务办理期限应为 ISO 日期');
  // 逐个节点回读：审批结论落在被处理过的那个（些）节点 Task.output 上
  const nodeBacks = [];
  for (const seq of [1, 2, 3]) {
    try { nodeBacks.push(await ctx.FHIRClient.get(BASE, 'Task', A.nodeTaskId(mainId, seq))); } catch (e) { }
  }
  const acted = nodeBacks.filter(t => t.status === 'completed');
  ok(acted.length >= 3, '三个节点都应在服务端为 completed，实际 ' + acted.length);
  ok(acted.some(t => (t.output || []).length >= 1),
    '已处理节点的 Task.output 应含审批结论，实际 ' + JSON.stringify(acted.map(t => (t.output || []).length)));
  const mrBack = await ctx.FHIRClient.get(BASE, 'MedicationRequest', order.medicationRequest.id);
  ok(mrBack.intent === 'order' && mrBack.statusReason.text === '可提交临床系统',
    '医嘱状态与 statusReason 应落服务端，实际 ' + mrBack.status + '/' + JSON.stringify(mrBack.statusReason));
  const audBack = await ctx.FHIRClient.get(BASE, 'AuditEvent', F.search('AuditEvent')[0].id);
  ok(audBack.resourceType === 'AuditEvent' && audBack.agent[0], 'AuditEvent 应可写入并读回（SRS §9.8）');
  const pdBack = await ctx.FHIRClient.get(BASE, 'PlanDefinition', order.instance.ext.pdId);
  ok(pdBack.status === 'active' && pdBack.action.length >= 3, 'PlanDefinition 的 action 投影应落服务端');
  const byTag = await ctx.FHIRClient.byTag(BASE, 'Task', ctx.FHIRR4.ID_SYSTEM, mainId);
  ok((byTag.entry || []).length === 1, 'Task 无法按 _tag 找回');
  for (const t of ['Permission', 'Citation', 'ClinicalUseDefinition']) {
    const r = await fetch(`${BASE}/${t}?_count=1`);
    ok(r.status === 404 || r.status === 400 || r.status === 405,
      t + ' 不该作为资源类型出现在 R4 服务端，实际 ' + r.status);
  }

  /* ---- 4. 流程发布/回退落库 ---- */
  console.log('\n== 4. 流程版本发布与回退写穿 ==');
  const cur = A.currentVersion('tier-approval', 'special');
  const draft = A.newDraft({ purpose: 'tier-approval', level: 'special', title: 'E2E 扩展流程', fromId: cur.id });
  A.saveDraft(draft.id, { nodes: A.nodesFromActions(F.read('PlanDefinition', draft.id))
    .concat([A.mkNode(4, 'E2E 人员节点', 'person', ['Practitioner-1102'], {})]) });
  const pub = A.publish(draft.id, { operator: 'E2E', note: '发布验证' });
  const rb = A.rollback(cur.id, { operator: 'E2E', note: '回退验证' });
  await waitSettled(F);
  await sleep(2500);
  const back1 = await ctx.FHIRClient.get(BASE, 'PlanDefinition', pub.pd.id);
  const back2 = await ctx.FHIRClient.get(BASE, 'PlanDefinition', rb.pd.id);
  ok(back1.status === 'retired' || back1.status === 'active', '发布版本应可读回，实际 ' + back1.status);
  ok(back2.status === 'active' && Number(back2.version) > Number(pub.version), '回退版本应为新的当前发布版');
  ok(!!back2.extension.find(e => /rollbackFrom/.test(e.url)), '回退来源应以扩展落库');
  ok(F.read('PlanDefinition', cur.id), '回退不得删除历史版本');

  if (!KEEP) {
    console.log('\n清理本作用域写入的数据…');
    const order2 = ctx.FHIR.remoteTypes().slice().reverse();
    for (let round = 1; round <= 3; round++) {
      let n = 0; const errs = [];
      for (const t of order2) {
        const r = await mineResources(BASE, t, SCOPE, { timeout: 25000 });
        if (r.err) errs.push(t + ' 检索异常：' + r.err);
        for (const res of r.list) {
          try { await ctx.FHIRClient.remove(BASE, t, res.id); n++; }
          catch (e) { errs.push(t + '/' + res.id + ' 删除失败：' + (e.hapiCode || '') + ' ' + e.message); }
        }
      }
      info('第 ' + round + ' 轮删除 ' + n + ' 条' + (errs.length ? '，被引用保护拦下 ' + errs.length + ' 项（下一轮继续）' : ''));
      if (!n) break;
      await sleep(1500);   // 等服务端把删除也建好索引，下一轮才能复核到残留
    }
    const left = await snapshot(BASE, TYPES);
    const bad = TYPES.filter(t => left[t] > 0);
    ok(!bad.length, '清理后服务端仍残留：' + bad.map(t => t + '×' + left[t]).join(', '));
  } else {
    info('KEEP=1：保留数据（scope=' + SCOPE + '）');
  }

  // 汇总放在清理之后打印，清理的复核结果才算得进最终数字
  console.log('\n==== 结果：通过 ' + pass + ' 项，失败 ' + fail + ' 项 ====');
  process.exit(fail ? 1 : 0);
})().catch(e => { console.error('\n测试异常：', e && e.stack || e); process.exit(1); });
