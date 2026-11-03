#!/usr/bin/env node
/* =====================================================================
 * demo_walkthrough.js —— 自动执行 SRS 第 7 节 DEMO-01 ~ DEMO-15 并断言
 * ---------------------------------------------------------------------
 * 直连真实 FHIR R4 服务端（默认 SRS §10.1 指定的公共演示实例），用前端自己的
 * 数据层初始化数据、走完整业务闭环，最后把本轮写入的数据清理掉。
 *
 *   node test/demo_walkthrough.js
 *   FHIR_BASE=http://localhost:8081/fhir node test/demo_walkthrough.js
 *   KEEP=1 node test/demo_walkthrough.js     # 保留数据便于手工核对
 *
 * 断言口径：每一步不仅检查内存镜像里的业务结果，还要把关键资源从服务端读回，
 * 证明「写入成功、刷新后仍可查询」（SRS §13.4）。
 * ===================================================================== */
'use strict';
const path = require('path');
const H = require('./harness');

const BASE = process.env.FHIR_BASE || 'https://hapi.fhir.org/baseR4';
const LOCAL = BASE === 'local';   // FHIR_BASE=local → 只跑内存镜像，用于快速自检业务逻辑
const SCOPE = process.env.DEMO_SCOPE || ('kjywfj-e2e-' + Date.now());
const KEEP = process.env.KEEP === '1';

let pass = 0, fail = 0;
const failures = [];
function ok(cond, msg) {
  if (cond) { pass++; return true; }
  fail++; failures.push(msg); console.error('  ✗ ' + msg);
  return false;
}
function step(no, title) { console.log('\n=== DEMO-' + String(no).padStart(2, '0') + ' ' + title + ' ==='); }
function info(t) { console.log('   ' + t); }

/* ---------- 启动前端数据层并连接服务端 ---------- */
const win = H.makeWindow({
  search: LOCAL ? '?mode=local' : '?mode=remote',
  config: { mode: LOCAL ? 'local' : 'remote', fhirBase: BASE, autoSeed: true, demoScope: SCOPE, persistUsageRecords: false }
});
H.loadInto(win);
H.stubApp(win, 'id-ruleadmin');
const F = win.FHIR, A = win.Approval, D = win.Domain, S = win.Svc, Svc = win.Svc, C = win.Clock, R4 = win.FHIRR4, Client = win.FHIRClient;
function setIdentity(id) { win.App.state.identityId = id; win.App.state.roleCode = D.identity(id).role; }
function flush() { return F.flush(); }
async function readBack(refStr) {
  if (LOCAL) {
    // 本地模式没有服务端可读：按「将要发往服务端的线上形态」回读，
    // 这样 identifier / meta.tag 等写入期附加的元素也能被断言覆盖。
    const i = refStr.indexOf('/');
    const t = refStr.slice(0, i), id = refStr.slice(i + 1);
    const can = F.canonical(t, id);
    if (!can) return {};
    return R4.fromWire(R4.toWire(JSON.parse(JSON.stringify(can)), { exists: (a, b) => !!F.read(a, b) }));
  }
  const i = refStr.indexOf('/');
  const t = refStr.slice(0, i), id = refStr.slice(i + 1);
  return Client.get(BASE, t, id, { timeout: 20000 });
}

(async function main() {
  console.log('目标服务端：' + BASE + '\n演示作用域：' + SCOPE);

  /* ---------------- DEMO-01 初始化演示数据 ---------------- */
  step(1, '初始化演示数据');
  /* bootstrap 会加载运行时配置，能力检查必须在它之后做，否则会被判为本地模式 */
  const stats = await F.bootstrap();
  if (!LOCAL && stats.pushed === 0 && stats.loadedCount === 0) {
    const pushed = F.pushAll();
    info('服务端数据本轮不可检索，强制幂等灌入 ' + pushed + ' 条');
    await flush();
  }
  const caps = LOCAL ? { fhirVersion: '4.0.1', types: {}, transaction: true } : await F.capabilities(true);
  const need = ['Patient', 'Encounter', 'Practitioner', 'PractitionerRole', 'Organization', 'Medication',
    'MedicationKnowledge', 'MedicationRequest', 'PlanDefinition', 'Task', 'Communication',
    'CommunicationRequest', 'Provenance', 'AuditEvent', 'Bundle'];
  const unsupported = (LOCAL ? [] : need).filter(t => {
    // Bundle 走的是 system 级 transaction；其余类型的条件搜索在 R4 里码值是 search-type
    if (t === 'Bundle') return !(caps.system || []).includes('transaction');
    const one = (caps.types || {})[t];
    return !one || !one.interactions.create || !(one.interactions['search-type'] || one.interactions.search);
  });
  ok(unsupported.length === 0, '服务端缺少必需资源类型：' + unsupported.join(','));
  if (!LOCAL) {
    const tagSearch = caps.types.Task && caps.types.Task.searchParams && caps.types.Task.searchParams._tag;
    ok(tagSearch, '服务端不支持按 _tag 检索，本系统的数据隔离与清理只能退回按 id 逐条兜底');
  }
  ok(/^4\./.test(caps.fhirVersion), '服务端 FHIR 版本应为 R4，实际 ' + caps.fhirVersion);
  info('bootstrap：读取 ' + stats.loadedCount + ' 条，写入 ' + stats.pushed + ' 条，模式 ' + stats.mode
    + (stats.loadedByIds ? ('，按 id 精确读回 ' + stats.loadedByIds.loaded + ' 条') : ''));
  ok(LOCAL || stats.mode === 'remote', '应为远端模式');
  if (!LOCAL && stats.pushed > 0) { ok(stats.pushed >= 380, '初始化应写入完整演示数据集，实际 ' + stats.pushed); await flush(); }
  const st0 = F.stats();
  ok(st0.failed === 0, '初始化写入失败 ' + st0.failed + ' 条：' + JSON.stringify(st0.lastError));

  // SRS §11 最小集
  ok(F.count('Organization') >= 4, '演示医院与至少三个科室');
  ok(F.count('PractitionerRole') >= F.count('Practitioner') - 2, '每名演示人员都应有 PractitionerRole');
  ok(F.count('Patient') >= 2, '至少两名虚构患者');
  ok(F.search('Encounter', e => e.ext.kind === 'outpatient').length >= 1, '至少一个门诊 Encounter');
  ok(F.search('Encounter', e => e.ext.kind === 'inpatient').length >= 1, '至少一个住院 Encounter');
  D.LEVELS.forEach(lv => ok(F.count('Medication', m => D.normalizeLevel(m.ext.level) === lv.code) > 0,
    '等级 ' + lv.name + ' 下应有演示药品'));
  ['id-doctor-ok', 'id-doctor-low', 'id-expert-person', 'id-expert-dept', 'id-expert-role', 'id-admin', 'id-ruleadmin']
    .forEach(id => ok(!!D.identity(id), '演示身份缺失：' + id));
  const anchor = await readBack('Basic/Basic-catalog-version');
  ok(anchor && anchor.resourceType === 'Basic', '锚点资源应可从服务端读回');

  /* ---------------- DEMO-02 配置抗菌药物三个等级 ---------------- */
  step(2, '配置抗菌药物三个等级');
  const grades = S.srs.grades();
  ok(grades.length >= 3, '至少三个等级');
  ['non-restricted', 'restricted', 'special'].forEach(c => ok(!!grades.find(g => g.code === c), '缺少等级编码 ' + c + '（SRS §3.1）'));
  const trio = [['Medication-1', 'non-restricted'], ['Medication-11', 'restricted'], ['Medication-21', 'special']];
  trio.forEach(([mid, lv]) => {
    const r = S.srs.setDrugGrade(mid, lv, 'DEMO-02 配置');
    ok(r.after === lv, mid + ' 应设为 ' + lv);
  });
  await flush();
  const mkBack = await readBack('Medication/Medication-21');
  const gradeTag = (mkBack.modifierExtension || []).find(e => /Medication-level$/.test(e.url));
  ok(gradeTag && gradeTag.valueCode === 'special', '服务端读回的等级应为 special 且在 modifierExtension');
  ok(F.search('MedicationKnowledge', k => k.ext.level === 'special').length > 0, 'MedicationKnowledge 应带等级分类');

  /* ---------------- DEMO-03 按医生职称设置使用权限 ---------------- */
  step(3, '按医生职称设置使用权限');
  const before = A.titleRuleMatrix('associate');
  const diff = S.srs.titleRuleDiff('associate', ['non-restricted', 'restricted', 'special']);
  ok(Array.isArray(diff), '保存前应有变更摘要');
  S.srs.saveTitleRule('associate', ['non-restricted', 'restricted', 'special'], 'DEMO-03 副高开放特殊使用级');
  const titleAfter = A.titleRuleMatrix('associate');
  ok(titleAfter.special === true && before.special === false, '职称规则应生效');
  const liuY = A.authorizations('Practitioner-1004');
  ok(liuY.hit.srcLabel === '个人授权', '刘洋应先命中个人授权层，实际 ' + liuY.hit.srcLabel);
  ok(S.srs.ruleChangeLog('职称权限').length > 0, '职称权限变更应留痕');
  S.srs.saveTitleRule('associate', ['non-restricted', 'restricted'], 'DEMO-03 复员');
  ok(A.titleRuleMatrix('associate').special === false, '职称规则应可回改');

  /* ---------------- DEMO-04 配置科室及个人权限 ---------------- */
  step(4, '配置科室及个人权限');
  const depts = S.srs.departments();
  ok(depts.length >= 3, '科室列表至少三个');
  const resp = depts.find(d => d.id === 'Organization-dept-demo-1');
  ok(resp, '呼吸内科（演示）应在列表中');
  const docsBefore = S.srs.departmentDoctors('Organization-dept-demo-1');
  ok(docsBefore.length >= 2, '应能列出该科室医师');
  S.srs.saveDeptGrant('Organization-dept-demo-1', ['non-restricted', 'restricted', 'special'], 'DEMO-04 科室整体放开特殊使用级');
  const wang = A.authorizations('Practitioner-9003');
  ok(wang.hit.srcLabel === '科室授权' && wang.levels.indexOf('special') >= 0, '放开科室授权后王伟应具备特殊使用级');
  const detail = S.srs.doctorDetail('Practitioner-9003');
  ok(detail.layers.title && detail.layers.department && detail.layers.person, '权限详情应含三层');
  ok(detail.hit.ruleText && detail.hit.srcLabel, '应显示命中的规则来源');
  S.srs.saveDeptGrant('Organization-dept-demo-1', ['non-restricted', 'restricted'], 'DEMO-04 恢复演示配置');
  const back = A.authorizations('Practitioner-9003');
  ok(back.levels.indexOf('special') < 0, '恢复后王伟应失去特殊使用级');
  ok(S.srs.doctorDetail('Practitioner-9003').missing.indexOf('special') >= 0, '应显示缺少的授权等级而非笼统「无权限」（FR-003.5）');
  const mp = A.mergePriority();
  A.setMergePriority(['department', 'person', 'title']);
  ok(A.mergePriority().order[0] === 'department', '合并优先级应可配置（BR-002）');
  A.setMergePriority(['person', 'department', 'title']);

  /* ---------------- DEMO-05 权限内直接开立 ---------------- */
  step(5, '权限内直接开立');
  setIdentity('id-doctor-ok');
  const direct = S.srs.submitOrder({
    practitionerId: 'Practitioner-1001', medicationId: 'Medication-21', patientId: 'Patient-2',
    encounterId: 'Encounter-2', patientName: '王富贵', mrn: 'ZY20260612008', diagnosis: '腹腔感染',
    purposeCode: 'targeted', purposeNote: '药敏支持', dosageText: '静脉滴注 1g q8h', reason: '目标性治疗'
  });
  ok(direct.mode === 'direct', '权限内应直接允许，实际 ' + direct.mode);
  ok(!!direct.medicationRequest.ext.purpose, '应记录用药目的');
  ok(!direct.instance, '本例不应触发越权审批');
  await flush();
  const mrBack = await readBack('MedicationRequest/' + direct.medicationRequest.id);
  ok(mrBack.resourceType === 'MedicationRequest' && mrBack.intent === 'order', '服务端应能读回 MedicationRequest 且 intent=order');
  ok((mrBack.statusReason || {}).text === '可提交临床系统', '医嘱业务状态应写入 statusReason');

  /* ---------------- DEMO-06 权限不足自动提示 ---------------- */
  step(6, '权限不足自动提示');
  setIdentity('id-doctor-low');
  const chk = A.check({ practitioner: 'Practitioner-9003', medicationId: 'Medication-24' });
  ok(chk.allowed === false, '王伟对万古霉素应权限不足');
  ['medicationName', 'gradeName', 'practitioner', 'allowedLevels', 'reason', 'hit', 'suggestion', 'missingLevels']
    .forEach(k => ok(chk[k] !== undefined, '提示内容缺少字段：' + k + '（FR-006.1）'));
  ok(!!chk.route && !!chk.route.pdId, '应给出审批路径（FR-006.2）');

  /* ---------------- DEMO-07 提交时选择用药目的 ---------------- */
  step(7, '提交抗菌药物时选择用药目的');
  let thrown = null;
  try {
    S.srs.submitOrder({ practitionerId: 'Practitioner-9003', medicationId: 'Medication-24', patientId: 'Patient-4',
      encounterId: 'Encounter-1', purposeCode: '' });
  } catch (e) { thrown = e; }
  ok(thrown && thrown.code === 'PURPOSE_REQUIRED', '未选用药目的必须拦住提交（BR-004）');
  const approval = S.srs.submitOrder({
    practitionerId: 'Practitioner-9003', medicationId: 'Medication-24', patientId: 'Patient-4',
    encounterId: 'Encounter-1', patientName: '赵德胜', mrn: 'ZY20260528022', diagnosis: '皮肤软组织感染',
    purposeCode: 'mdr', purposeNote: '创面 MRSA 阳性', dosageText: '静脉滴注 1g q12h',
    reason: 'DEMO-06/07 超权限申请'
  });
  ok(approval.mode === 'approval', '超权限应进入审批，实际 ' + approval.mode);
  ok(!!approval.instance.ext.sqno, '工作台应显示申请编号（FR-006.4）');
  ok(!!approval.nodes.find(n => n.status === 'current'), '应显示当前审批节点');
  await flush();
  const taskBack = await readBack('Task/' + approval.instance.id);
  ok(taskBack.instantiatesCanonical && /\|/.test(taskBack.instantiatesCanonical), '服务端 Task 应绑定流程版本 canonical');
  ok(!!(taskBack.focus || {}).reference, '服务端 Task.focus 应指向 MedicationRequest');

  /* ---------------- DEMO-08 拖选新增审批节点并配置审核对象 ---------------- */
  step(8, '拖选新增审批节点并配置审核对象');
  const cur = A.currentVersion('tier-approval', 'special');
  const drafts = A.versions('tier-approval', 'special').filter(p => p.status === 'draft');
  const draft = drafts.length ? A.saveDraft(drafts[drafts.length - 1].id, { title: '特殊使用审批流程（DEMO-08）' })
    : A.newDraft({ purpose: 'tier-approval', level: 'special', title: '特殊使用审批流程（DEMO-08）', fromId: cur.id });
  let nodes = A.nodesFromActions(F.read('PlanDefinition', draft.id));
  nodes = nodes.concat([
    A.mkNode(nodes.length + 1, '院感专家（人员）', 'person', ['Practitioner-1102'], { deadlineHours: 12 }),
    A.mkNode(nodes.length + 2, '医务管理科（科室）', 'department', ['Organization-dept-demo-5'], { deadlineHours: 12 }),
    A.mkNode(nodes.length + 3, '感染科医师（角色）', 'role', ['infection'], { deadlineHours: 12, actions: ['approve', 'reject', 'return'] })
  ]);
  ['person', 'department', 'role'].forEach(t => ok(nodes.some(n => n.assigneeType === t), '应支持按 ' + t + ' 配置（FR-012/013/014）'));
  const saved = A.saveDraft(draft.id, { nodes: nodes });
  const v8 = A.validate(saved);
  ok(v8.ok, '校验应通过：' + v8.errors.map(e => e.message).join(';'));
  ok(saved.action.length === nodes.length, '节点应同步投影到 PlanDefinition.action');
  ok(nodes.length === (cur.ext.nodes || []).length + 3, '应净增三个审核节点');
  const bad = A.validate([{ name: '', assigneeType: 'person', assignees: [], deadlineHours: 0, actions: [] }]);
  ok(!bad.ok, '不完整流程必须禁止发布（FR-011.9）');

  /* ---------------- DEMO-09 保存并无感发布 ---------------- */
  step(9, '保存并无感发布新流程');
  const pub = A.publish(draft.id, { operator: '规则管理员·王素芬', note: 'DEMO-09 无感发布' });
  ok(!!pub.version, '发布应返回版本号');
  ok(A.currentVersion('tier-approval', 'special').id === pub.pd.id, '新版本应立刻成为当前有效版本（FR-015.3）');
  setIdentity('id-doctor-low');
  const afterPub = S.srs.submitOrder({
    practitionerId: 'Practitioner-9003', medicationId: 'Medication-27', patientId: 'Patient-6',
    encounterId: 'Encounter-4', patientName: '孙建国', mrn: 'ZY20260614005', diagnosis: '重症肺炎',
    purposeCode: 'severe', purposeNote: '多重耐药鲍曼不动杆菌', dosageText: '首剂100mg，后50mg q12h',
    reason: 'DEMO-09 发布后新申请'
  });
  ok(Number(afterPub.instance.ext.version) === Number(pub.version), '同一会话内的新申请应绑定刚发布的版本（FR-015.4/5，无需退出重登）');
  ok(afterPub.nodes.length === nodes.length, '新申请的审批路径应包含新增节点');
  ok(Number(approval.instance.ext.version) < Number(pub.version), 'DEMO-06/07 已发起的实例仍绑定原版本（FR-015.6、BR-006）');
  ok(!!pub.pd.ext.publishedAt && !!pub.pd.ext.publishedBy, '发布应显示版本号、生效时间和发布人（FR-015.7）');

  /* ---------------- DEMO-10 审核中心查看新增节点并逐节点审批 ---------------- */
  step(10, '审核中心查看新增节点并逐节点审批');
  const view = Svc.srs.centerDetail(afterPub.instance.id);
  const names = view.nodes.map(n => n.name);
  ['院感专家（人员）', '医务管理科（科室）', '感染科医师（角色）'].forEach(nm =>
    ok(names.indexOf(nm) >= 0, '审批中心应展示新增节点：' + nm));
  ok(view.nodes.every(n => n.state && n.assigneeLabel), '节点应显示状态与分配依据（FR-016.5/BR-008）');
  const seenIdentities = [];
  let guard = 0;
  while (guard++ < 12) {
    const n = A.firstActionableNode(afterPub.instance.id, null);
    if (!n) break;
    const assignee = n.ext.assigneeIds[0];
    seenIdentities.push(assignee);
    const res = A.act({ taskId: afterPub.instance.id, action: 'approve', operatorPractId: assignee, comment: 'DEMO-10 逐节点通过' });
    if (['approved', 'rejected'].indexOf(res.flowStatus) >= 0) break;
  }
  const fin = F.read('Task', afterPub.instance.id);
  ok(fin.ext.flowStatus === 'approved', '全部节点通过后实例应为已通过，实际 ' + fin.ext.flowStatus);
  ok(fin.ext.orderStatus === 'ready-to-submit', '通过后医嘱应为可提交临床系统（FR-007.7）');
  await flush();
  const nodeBack = await readBack('Task/' + A.nodeTaskId(afterPub.instance.id, 1));
  ok(nodeBack.partOf && nodeBack.partOf[0].reference === 'Task/' + afterPub.instance.id, '节点 Task 的 partOf 应可从服务端读回');
  ok((nodeBack.output || []).length >= 1, '节点处理结果应写入 Task.output（FR-017.6）');
  setIdentity('id-doctor-low');
  ok(S.srs.centerRows('Practitioner-9003', 'mine').some(r => r.id === afterPub.instance.id && r.flowStatus === 'approved'),
    '开单医师工作台应看到最终审批状态（FR-009.5）');

  /* ---------------- DEMO-11 移动端完成审批 ---------------- */
  step(11, 'APP 移动端完成审批');
  const mobile = S.srs.submitOrder({
    practitionerId: 'Practitioner-9003', medicationId: 'Medication-21', patientId: 'Patient-1',
    encounterId: 'Encounter-1', patientName: '陈秀英', mrn: 'ZY20260615001', diagnosis: '肺炎',
    purposeCode: 'mdr', purposeNote: '痰培养 ESBLs 阳性', dosageText: '0.5g q8h', reason: 'DEMO-11 移动端审批'
  });
  const firstNode = A.firstActionableNode(mobile.instance.id, null);
  const mobileActor = firstNode.ext.assigneeIds[0];
  setIdentity((D.identitiesOfPractitioner(mobileActor)[0] || {}).id || 'id-expert-pharmacy');
  const todoOnMobile = A.rows(mobileActor, 'todo').map(r => r.id);
  ok(todoOnMobile.indexOf(mobile.instance.id) >= 0, '移动端应能看到同一条待办任务（FR-017.2）');
  const mres = A.act({ taskId: mobile.instance.id, action: 'approve', operatorPractId: mobileActor, comment: '移动端审批通过' });
  await flush();
  const shared = await readBack('Task/' + mres.nodeTask.id);
  ok(shared.status === 'completed', '移动端审批应更新服务端 Task 状态');
  ok((shared.output || []).some(o => (o.valueString || '').indexOf('移动端') >= 0), '审批意见应写入服务端 output');
  setIdentity('id-doctor-low');
  ok(A.flowView(mobile.instance.id).nodes[0].comment.indexOf('移动端') >= 0, '桌面端刷新后应看到移动端审批结果（FR-017.7）');
  let e2 = null;
  try { A.act({ taskId: mobile.instance.id, action: 'reject', operatorPractId: A.firstActionableNode(mobile.instance.id, null).ext.assigneeIds[0], comment: '' }); }
  catch (e) { e2 = e; }
  ok(e2, '驳回必须填写原因（FR-017.5）');

  /* ---------------- DEMO-12 紧急越级与 24 小时补审核 ---------------- */
  step(12, '紧急情况下临时越级使用及 24 小时内补审核');
  setIdentity('id-doctor-low');
  let e3 = null;
  try { S.srs.submitOrder({ practitionerId: 'Practitioner-9003', medicationId: 'Medication-22', patientId: 'Patient-3',
    encounterId: 'Encounter-3', purposeCode: 'severe', emergency: true, emergencyReason: '' }); }
  catch (e) { e3 = e; }
  ok(e3 && e3.code === 'EMERGENCY_REASON', '紧急使用必须填写原因（FR-008.2）');
  const em = S.srs.submitOrder({
    practitionerId: 'Practitioner-9003', medicationId: 'Medication-22', patientId: 'Patient-3',
    encounterId: 'Encounter-3', patientName: '李秀兰', mrn: 'ZY20260608015', diagnosis: '脓毒症',
    purposeCode: 'severe', purposeNote: '血培养阳性', dosageText: '0.5g q6h',
    emergency: true, emergencyReason: '患者脓毒症休克早期，情况紧急来不及完成事前审批',
    clinicalNote: '已留取血培养 2 套，负荷给药后按药敏调整'
  });
  ok(em.mode === 'emergency', '应走紧急越级分支');
  ok(em.instance.ext.purpose === 'emergency-review', '紧急补审核应使用与普通审批不同的流程标识（FR-008.10）');
  ok(em.instance.ext.purpose !== mobile.instance.ext.purpose, '紧急补审核流程实例与普通审批实例流程标识不同');
  const hrs = (new Date(em.deadline.replace(' ', 'T')) - new Date(em.instance.authoredOn.replace(' ', 'T'))) / 36e5;
  ok(Math.abs(hrs - 24) < 0.5, '补审核期限应为 24 小时，实际 ' + hrs);
  await flush();
  const emBack = await readBack('Task/' + A.nodeTaskId(em.instance.id, 1));
  ok(emBack.restriction && emBack.restriction.period && emBack.restriction.period.end, '服务端节点 Task 应带 restriction.period 截止时间（SRS §9.7）');
  const rec = S.srs.emergencyRecords('Practitioner-9003').find(r => r.id === em.instance.id);
  ok(rec && /剩余/.test(rec.timeout.text), '应显示剩余时间（FR-008.5）');
  S.srs.submitEmergencyMaterials(em.instance.id, { 病原学送检: '血培养 2 套已采集', 用药前评估: 'MAP 62mmHg', 临床说明: '负荷给药，拟 TDM 监测' });
  ok(F.read('Task', em.instance.id).ext.postReview.病原学送检, '补充材料应可保存（DEMO-12.6）');
  C.advance(25 * 60);
  const to = A.timeoutState(F.read('Task', em.instance.id));
  ok(to.timeout === true, '推进 25 小时后应识别超时（FR-008.8）');
  ok(F.read('Task', em.instance.id).ext.flowStatus !== 'post-review-done', '超时不得自动伪造补审核完成状态');
  const emActor = A.firstActionableNode(em.instance.id, null).ext.assigneeIds[0];
  const done = A.act({ taskId: em.instance.id, action: 'approve', operatorPractId: emActor, comment: '同意紧急越级使用，补审核通过' });
  ok(done.flowStatus === 'post-review-done', '补审核完成后应记录结论（FR-008.7）');
  ok(!!done.mainTask.ext.decision.by && !!done.mainTask.ext.decision.time, '应记录审核人与完成时间');
  C.setOffset(0);

  /* ---------------- DEMO-13 查看流程历史版本 ---------------- */
  step(13, '查看流程历史版本');
  const list = A.versions('tier-approval', 'special');
  const seedVersions = list.map(p => p.id);
  ok(list.length >= 2, '至少应有初始发布版与本次发布版，实际 ' + list.length);
  list.forEach(p => ok(!!p.version && !!p.status, '每个版本都有版本号与状态（FR-018.2）'));
  const v1 = list.find(p => Number(p.version) === Number(cur.version));
  const vNew = list[list.length - 1];
  const cmp = A.compare(v1.id, vNew.id);
  ok(cmp.added.length === 3, '版本比较应识别 3 个新增节点，实际 ' + cmp.added.length + '；removed=' + cmp.removed.length);
  const bound = A.flowView(mobile.instance.id);
  ok(bound.pdId && bound.versionLabel, '审批实例应显示其绑定的流程版本（FR-018.6）');
  const histNode = A.flowView(approval.instance.id);
  ok(Number(histNode.version) === Number(approval.instance.ext.version), '历史实例的版本绑定应可追溯');

  /* ---------------- DEMO-14 回退恢复历史版本 ---------------- */
  step(14, '回退恢复历史版本');
  const beforeRollback = A.currentVersion('tier-approval', 'special');
  const rb = A.rollback(v1.id, { operator: '流程审阅人员·赵敏', note: 'DEMO-14 回退到三节点版本' });
  ok(rb.version > beforeRollback.version, '回退应生成新的发布版本号（FR-019.5）');
  ok(rb.pd.ext.rollbackFrom.fromId === v1.id, '新版本应记录回退来源');
  const afterRoll = A.currentVersion('tier-approval', 'special');
  ok(afterRoll.id === rb.pd.id, '回退后当前版本应切换为恢复版本');
  ok((afterRoll.ext.nodes || []).length === (v1.ext.nodes || []).length, '恢复版本的节点应与目标历史版本一致');
  const afterRollList = A.versions('tier-approval', 'special');
  ok(afterRollList.length >= seedVersions.length + 1, '回退应新增版本而不是删除，实际 ' + afterRollList.length);
  ok(seedVersions.every(id => afterRollList.some(p => p.id === id)), '回退不得删除中间版本（FR-019.4）');
  const rbOrder = S.srs.submitOrder({
    practitionerId: 'Practitioner-9003', medicationId: 'Medication-21', patientId: 'Patient-5',
    encounterId: 'Encounter-1', patientName: '周丽', mrn: 'ZY20260520031', diagnosis: '尿路感染',
    purposeCode: 'empirical', dosageText: '1g q8h', reason: 'DEMO-14 回退后新申请'
  });
  ok(Number(rbOrder.instance.ext.version) === Number(rb.version), '回退后的新申请使用恢复版本（FR-019.6）');
  ok(rbOrder.nodes.length === v1.ext.nodes.filter(n => n.type !== 'start' && n.type !== 'end').length, '新申请审批路线应恢复为三节点');
  const oldAgain = F.read('Task', afterPub.instance.id);
  ok(Number(oldAgain.ext.version) === Number(pub.version), '回退前已创建的实例仍按原绑定版本执行（FR-019.7）');
  const rbLog = S.srs.ruleChangeLog('流程回退');
  ok(rbLog.length > 0 && rbLog[0].content.indexOf('回退恢复') >= 0, '回退应记录操作人/时间/目标版本/新版本号（FR-019.8）');

  /* ---------------- DEMO-15 审批留痕与数据关联核查 ---------------- */
  step(15, '审批留痕与数据关联核查');
  const trace = S.srs.trace('Patient-1');
  ok(trace.patient && trace.encounters.length >= 1, '患者与就诊应可关联查询');
  ok(trace.orders.length >= 1, '应能查到该患者的抗菌药物开单');
  ok(trace.tasks.length >= 1, '开单应能关联到审批任务');
  ok(trace.flows.length >= 1, '审批任务应能关联到流程版本');
  ok(trace.provenance.length >= 1 || trace.auditEvents.length >= 1, '关键操作应有 Provenance/AuditEvent 留痕');
  trace.orders.forEach(o => ok(!!o.grade && !!o.purpose,
    '开单 ' + (o.no || o.id) + ' 缺少等级快照或用药目的：' + JSON.stringify({ grade: o.grade, purpose: o.purpose })));
  ok(trace.orders.every(o => !o.authzHit || o.authzHit.srcLabel), '权限判定依据应可追溯');
  const t1 = trace.tasks[0];
  ok(/V\d+/.test(t1.version) && t1.nodes >= 1, '实例应显示绑定版本与节点数');
  const emTrace = S.srs.trace('Patient-3');
  ok(emTrace.orders.some(o => o.emergency), '紧急越级申请应可在关联核查中找到');
  const idChecks = await Promise.all([
    readBack('Task/' + mobile.instance.id),
    readBack('MedicationRequest/' + mobile.medicationRequest.id)
  ]);
  ok(idChecks[0].identifier.some(i => i.system === R4.ID_SYSTEM), '资源应带演示业务标识（SRS §9.1.2）');
  ok(idChecks[1].subject.reference.indexOf('Patient/') >= 0, '服务端资源之间的 Reference 应可解析');
  const provId = F.search('Provenance', p => (p.ext.changeType || '').indexOf('审批') >= 0)[0];
  ok(!!provId, '应存在审批相关 Provenance 留痕');
  const provBack = provId ? await readBack('Provenance/' + provId.id) : null;
  ok(!!provBack && provBack.resourceType === 'Provenance', '留痕资源应可从服务端读回');

  /* ---------------- 闭环完成条件（SRS §8.3） ---------------- */
  console.log('\n=== SRS §8.3 闭环完成条件 ===');
  ok(grades.length >= 3 && A.titleRuleMatrix('chief').special, '① 管理员完成等级、职称及医师权限配置');
  ok(nodes.some(n => n.assigneeType === 'person') && nodes.some(n => n.assigneeType === 'department') && nodes.some(n => n.assigneeType === 'role'),
    '② 通过拖选新增审核节点并按人员/科室/角色配置');
  ok(Number(rbOrder.instance.ext.version) === Number(rb.version), '③ 流程发布/回退后临床开单无感使用当前版本');
  ok(!!mobile.medicationRequest.ext.purpose, '④ 医师开单触发权限判断与用药目的选择');
  ok(names.indexOf('院感专家（人员）') >= 0, '⑤ 权限不足申请的审批中心展示新增节点');
  ok(shared.status === 'completed', '⑥ 审批人员可在移动端完成审批');
  ok(fin.ext.orderStatus === 'ready-to-submit', '⑦ 审批完成状态能返回开单医师');
  ok(!!afterPub.instance.ext.pdId, '⑧ 申请与任务可追踪到使用的流程版本');
  ok(A.countersFor('Practitioner-9003').mine >= 0, '⑨ 工作台计数可用');
  const st2 = F.stats();
  ok(st2.failed === 0, '本轮写穿服务端失败数应为 0，实际 ' + st2.failed + '：' + JSON.stringify(st2.lastError));

  /* ---------------- 清理本轮数据 ---------------- */
  if (!KEEP && !LOCAL) {
    console.log('\n=== 清理本轮写入的数据（scope=' + SCOPE + '） ===');
    await cleanUp();
  } else {
    console.log(LOCAL ? '\n本地模式：没有向服务端写过数据'
      : '\nKEEP=1：保留服务端数据，可执行 python3 scripts/clean_demo_data.py --scope ' + SCOPE + ' 清理');
  }

  console.log('\n通过 ' + pass + ' 项，失败 ' + fail + ' 项');
  if (LOCAL) console.log('（本地模式：未与服务端交互，仅验证业务逻辑）');
  if (fail) { console.error('\n失败明细：\n - ' + failures.join('\n - ')); process.exit(1); }
  console.log('✅ DEMO-01 ~ DEMO-15 全部走通，闭环条件满足');
  process.exit(0);
})().catch(async e => {
  console.error('\n执行异常：' + (e && e.stack || e));
  if (!KEEP && !LOCAL) { try { await cleanUp(); } catch (_) {} }
  process.exit(2);
});

/* 取某类型下属于本作用域的资源。公共实例上绝不能退回全量列表：那会把别人的
 * 几万条 Patient 拉进来，既拖垮演示又可能误删。因此只在 _tag 检索「报错」
 * （服务端不支持该检索）时兜底，返回空数组就当作本作用域确实没有数据。 */
async function scopedList(type) {
  try {
    const list = await Client.fetchAllByTag(BASE, type, R4.SCOPE_SYSTEM, SCOPE, { timeout: 25000 });
    return { list: list, err: null };
  } catch (e) { return { list: [], err: String(e && e.message || e) }; }
}

/* 逆引用顺序删除本作用域资源（与 scripts/clean_demo_data.py 同一口径） */
async function cleanUp() {
  const order = R4 ? F.remoteTypes().slice().reverse() : [];
  for (let round = 1; round <= 4; round++) {
    let n = 0; const errs = [];
    for (const type of order) {
      const r = await scopedList(type);
      if (r.err) errs.push(type + ' 检索异常：' + r.err);
      for (const res of r.list) {
        try { await Client.remove(BASE, type, res.id, { timeout: 20000 }); n++; }
        catch (e) {
          if (e.status !== 404 && e.status !== 410) errs.push(type + '/' + res.id + '：' + (e.hapiCode || '') + ' ' + e.message);
        }
      }
    }
    console.log('   第 ' + round + ' 轮删除 ' + n + ' 条'
      + (errs.length ? '，被引用保护/异常 ' + errs.length + ' 项：' + errs.slice(0, 2).join(' | ') : ''));
    if (!n) break;
    await new Promise(r => setTimeout(r, 1500));   // 等删除也建好索引，下一轮才复核得到
  }
  // 复核只看「有没有」，用 _count=1 的探测，不再整表翻页
  let left = [];
  for (const type of order) {
    try {
      const b = await Client.byTag(BASE, type, R4.SCOPE_SYSTEM, SCOPE, { timeout: 20000 });
      if ((b.entry || []).length) left.push(type);
    } catch (e) { /* 检索不可用时以删除结果为准 */ }
  }
  ok(!left.length, '清理后服务端仍可能残留本作用域资源：' + left.join(', '));
}
