/* 用 jsdom 真实执行整个前端，检查各角色 / 各页面渲染是否有运行时错误 */
const fs = require('fs');
const path = require('path');
const { JSDOM } = require('jsdom');

const root = path.join(__dirname, '..');
const files = [
  'lib/vue.global.prod.js',
  'js/fhir-store.js', 'js/fhir-ext.js', 'js/domain.js', 'js/fhir-profiles.js', 'js/seed.js', 'js/services.js',
  'js/app.js',
  'js/components/common.js',
  'js/components/home.js', 'js/components/auth-apply.js', 'js/components/auth-approve.js',
  'js/components/catalog.js', 'js/components/perm-mapping.js', 'js/components/indication.js',
  'js/components/monitor.js', 'js/components/report.js', 'js/components/gatekeep.js',
  'js/components/workflow-config.js', 'js/components/sys-params.js'
];

const errors = [];
const dom = new JSDOM('<!DOCTYPE html><html><body><div id="app"></div></body></html>', {
  runScripts: 'outside-only', pretendToBeVisual: true, url: 'http://localhost/'
});
const win = dom.window;
win.scrollTo = () => {};
win.console.error = (...a) => { errors.push('console.error: ' + a.join(' ')); };
win.console.warn = (...a) => { const m = a.join(' '); if (!/Feature flag|hydration/i.test(m)) errors.push('console.warn: ' + m); };
win.onerror = (m) => { errors.push('window.onerror: ' + m); };

// 顺序注入脚本
for (const f of files) {
  const code = fs.readFileSync(path.join(root, f), 'utf8');
  try { win.eval(code); }
  catch (e) { console.log('FATAL while loading', f, '\n', e.message); process.exit(1); }
}

// 启动应用
try { win.__BOOT_AMS__(); } catch (e) { console.log('FATAL boot:', e.stack); process.exit(1); }

const App = win.App, Domain = win.Domain;
function flush() { return new Promise(r => setTimeout(r, 30)); }

const ROUTES = ['home', 'auth-apply', 'auth-approve', 'catalog', 'perm-mapping', 'indication', 'monitor', 'report', 'gatekeep', 'workflow-config', 'sys-params'];

(async () => {
  await flush();
  const appEl = win.document.getElementById('app');
  console.log('boot html length:', appEl.innerHTML.length);

  // 遍历每个角色 + 其可访问的每个页面
  for (const role of Domain.ROLES.map(r => r.code)) {
    App.switchRole(role);
    await flush();
    for (const route of ROUTES) {
      const can = route === 'home' || Domain.canAccess(role, route);
      if (!can) continue;
      App.navigate(route);
      await flush();
      const len = appEl.innerHTML.length;
      if (len < 200) errors.push(`[${role}/${route}] 渲染内容过短 (${len})`);
    }
  }

  // 关键业务流：医师提交特殊使用级申请 → 药学部门审批 → 审批专家终审（三级流程，药学部门也是审批中的一环）
  App.switchRole('doctor'); await flush();
  const beforePharmacy = win.Svc.applicationsForApprover('pharmacy').filter(t => win.Svc.isMyTurn(t, 'pharmacy')).length;
  win.Svc.submitApplication({ type: 'special', drug: '美罗培南', dept: '内科', useStart: '2026-06-22', useEnd: '2026-06-28', reason: '测试', patientName: '测试患者', mrn: 'ZY999', diagnosis: '肺炎', infection: '痰培养ESBLs阳性' });
  await flush();
  // 药学部门审批（第一个人工审批节点）
  App.switchRole('pharmacy'); await flush();
  const pendPharmacy = win.Svc.applicationsForApprover('pharmacy').filter(t => win.Svc.isMyTurn(t, 'pharmacy'));
  const afterPharmacy = pendPharmacy.length;
  if (afterPharmacy !== beforePharmacy + 1) errors.push(`提交后药学部门待审批数未+1 (${beforePharmacy}->${afterPharmacy})`);
  const newTask = pendPharmacy.sort((a, b) => b.id.localeCompare(a.id))[0];
  win.Svc.approveApplication(newTask.id, 'approved', '');
  await flush();
  const afterPharmacyApprove = win.FHIR.read('Task', newTask.id);
  if (afterPharmacyApprove.status !== 'in-progress' || !win.Svc.isMyTurn(afterPharmacyApprove, 'expert')) errors.push('药学部门审批通过后未正确流转至审批专家节点: ' + afterPharmacyApprove.status);
  // 审批专家终审
  App.switchRole('expert'); await flush();
  win.Svc.approveApplication(newTask.id, 'approved', '');
  await flush();
  const approved = win.FHIR.read('Task', newTask.id);
  if (approved.status !== 'completed') errors.push('审批通过后状态异常: ' + approved.status);

  // 目录 CRUD：新增药品后版本号递增
  const v0 = win.Svc.catalogVersion().version;
  win.Svc.saveMedication({ name: '测试药品X', ext: { drugClass: '测试类', level: 'special', indicationSummary: 'x', usage: 'x', allowedTitles: ['chief'], approvals: ['expert'] } }, true);
  const v1 = win.Svc.catalogVersion().version;
  if (v0 === v1) errors.push('新增药品后目录版本未递增');

  // 服务层写路径冒烟测试（各页面弹框背后的保存操作）
  App.switchRole('admin'); await flush();
  const S = win.Svc;
  const smoke = [
    ['saveMappingRule', () => S.saveMappingRule('restricted', ['chief', 'associate'], ['dept', 'pharmacy'])],
    ['saveGatekeepRule', () => S.saveGatekeepRule('special', { titleCheck: true, approvalCheck: ['dept', 'pharmacy', 'expert'], interceptOnTitleMismatch: 'block', interceptOnNotApproved: 'block' })],
    ['saveGatekeepStatus', () => S.saveGatekeepStatus({ interceptMode: 'silent' })],
    ['saveGatekeepRule.cascade', () => {
      S.saveGatekeepRule('restricted', { approvalCheck: ['dept'], interceptOnTitleMismatch: 'block', interceptOnNotApproved: 'block' });
      const rule = S.mappingRules().find(r => r.level === 'restricted');
      if (rule.approvals.join(',') !== 'dept') throw new Error('卡控规则调整审批校验后未同步权限映射规则表');
      S.saveGatekeepRule('restricted', { approvalCheck: ['dept', 'pharmacy'], interceptOnTitleMismatch: 'block', interceptOnNotApproved: 'block' }); // 还原
    }],
    ['saveTitlePrivilege', () => S.saveTitlePrivilege('attending', ['unrestricted', 'restricted'])],
    ['saveBasic.sync', () => S.saveBasic('sync-params', { frequency: '每6小时' })],
    ['saveBasic.notify', () => { const c = S.basic('notify-config'); c.items[0].sms = true; S.saveBasic('notify-config', { items: c.items }); }],
    ['saveEndpoint', () => S.saveEndpoint('Endpoint-his', { auth: 'Token' })],
    ['saveWorkflow.new', () => S.saveWorkflow({ title: '测试流程', ext: { level: 'special', nodes: [{ seq: 1, role: 'expert', roleName: '审批专家', mode: 'or', approverType: 'assigned', approvers: ['王建明'], hours: 24, timeout: '仅提醒' }], scopeDrug: '全部', scopeDept: '全院', applyTitles: ['chief'], extraCond: '' } }, true)],
    ['toggleWorkflow', () => S.toggleWorkflow('PlanDefinition-special')],
    ['saveIndication', () => S.saveIndication({ ext: { drug: '美罗培南', description: '测试适应症', standard: '确诊+药敏', citations: ['Citation-1'] } }, true)],
    ['saveCitation', () => S.saveCitation({ title: '测试指南', ext: { publisher: '测试机构', date: '2026-01', url: '', linked: 0 } }, true)],
    ['syncKb', () => S.syncKb()],
    ['handleAlert', () => S.handleAlert('DetectedIssue-1')],
    ['withdrawApplication', () => S.withdrawApplication('Task-1002')],
    ['titleImpact', () => { const r = S.titleImpact('associate'); if (r.total !== 24) throw new Error('副主任医师在岗数应为24'); }],
    ['gatekeepLogs', () => { if (!S.gatekeepLogs().length) throw new Error('卡控变更日志为空'); }],
    ['indicationAuditStats', () => { if (!S.indicationAuditStats().passRates.length) throw new Error('审核统计为空'); }],
    ['runningApprovalCount', () => { if (typeof S.runningApprovalCount('special') !== 'number') throw new Error('runningApprovalCount 异常'); }],
    ['medication-spec', () => { const m = S.medications({ keyword: '美罗培南' })[0]; if (!m.ext.spec || !m.ext.manufacturer) throw new Error('药品缺少规格/生产企业'); }],
    ['rolePermissions', () => {
      const pages = S.rolePermissions();
      if (!pages['auth-approve'] || !pages['auth-approve'].includes('pharmacy')) throw new Error('药学部门应默认可访问处方权限审批');
      S.saveRolePermissions(pages);
    }],
    ['computeOverview', () => { const ov = S.computeOverview(); if (!ov.departmentRanking.length || typeof ov.indicators.ddd.value !== 'number') throw new Error('监测概览统计数据异常'); }],
    ['computeReportTables', () => { const r = S.computeReportTables(); if (!r.summary.length || !r.drugUse.length) throw new Error('统计报表数据异常'); }],
    ['batch-approve', () => {
      App.switchRole('expert');
      const pend = S.applicationsForApprover('expert').filter(t => S.isMyTurn(t, 'expert')).slice(0, 2);
      pend.forEach(t => S.approveApplication(t.id, 'approved', ''));
      pend.forEach(t => { if (win.FHIR.read('Task', t.id).status !== 'completed') throw new Error('批量通过失败'); });
    }]
  ];
  for (const [name, fn] of smoke) { try { fn(); } catch (e) { errors.push('Svc.' + name + ' 抛错: ' + e.message); } }

  // ===== FHIR 扩展规范化一致性校验 =====
  const FHIR = win.FHIR;
  // 1. 内部存储为纯 FHIR 资源（无非标准 ext 字段）
  const canon = FHIR.canonical('Medication', 'Medication-21'); // 美罗培南
  if ('ext' in canon) errors.push('FHIR: 规范化资源不应包含 ext 字段');
  if (!Array.isArray(canon.extension)) errors.push('FHIR: Medication 缺少 extension 数组');
  if (!Array.isArray(canon.modifierExtension)) errors.push('FHIR: Medication 缺少 modifierExtension 数组');
  // 2. 分级(level)应作为 modifierExtension（改变资源含义）
  const levelExt = (canon.modifierExtension || []).find(e => /Medication-level$/.test(e.url));
  if (!levelExt || levelExt.valueCode !== 'special') errors.push('FHIR: level 未作为 modifierExtension/valueCode 存储');
  // 3. 可开具职称应为重复扩展（code 列表）
  const titleExts = (canon.modifierExtension || []).filter(e => /Medication-allowedTitles$/.test(e.url));
  if (titleExts.length < 2 || !titleExts.every(e => 'valueCode' in e)) errors.push('FHIR: allowedTitles 未作为重复 valueCode 扩展存储');
  // 4. 解码后 ext 投影完整还原
  const mat = FHIR.read('Medication', 'Medication-21');
  if (mat.ext.level !== 'special' || !mat.ext.allowedTitles.includes('chief') || !mat.ext.spec) errors.push('FHIR: Medication 解码还原不完整');
  // 5. 复杂结构(Task.flow)以 JSON 扩展承载并往返一致
  const tcanon = FHIR.canonical('Task', 'Task-1001');
  const flowExt = (tcanon.extension || []).find(e => /Task-flow$/.test(e.url));
  if (!flowExt || typeof flowExt.valueString !== 'string') errors.push('FHIR: Task.flow 未以 valueString(JSON) 承载');
  const tmat = FHIR.read('Task', 'Task-1001');
  if (!Array.isArray(tmat.ext.flow) || tmat.ext.flow.length !== 3) errors.push('FHIR: Task.flow 解码未还原为数组');
  // 6. 自定义资源/Profile 定义已登记
  if (!FHIR.canonical('StructureDefinition', 'amr-medication')) errors.push('FHIR: 缺少 amr-medication Profile 定义');
  if (FHIR.count('StructureDefinition') < 10) errors.push('FHIR: StructureDefinition 扩展定义数量不足');

  console.log('\n==== 测试结果 ====');
  console.log('FHIR 存储样例（美罗培南 modifierExtension）：', JSON.stringify((canon.modifierExtension||[]).slice(0,2)));
  if (errors.length) { console.log('发现 ' + errors.length + ' 个问题：'); errors.forEach(e => console.log(' - ' + e)); process.exit(2); }
  else console.log('✅ 全部角色×页面渲染通过，核心业务流（申请→审批、目录CRUD）逻辑正确，无运行时错误');
})();
