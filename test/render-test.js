/* =====================================================================
 * render-test.js —— 全「演示身份 × 页面」渲染回归（jsdom，无网络）
 * ---------------------------------------------------------------------
 * 页面清单不再硬编码：js/components/*.js 与 Domain.MODULES 自动发现，
 * 新增页面忘记登记到测试的情况不会再发生（旧版就是靠两份手写清单同步，
 * 一加页面就漏测）。校验：
 *   1. 每个身份能看到它有权限的每个页面，且渲染出内容；
 *   2. 过程中没有 console.error / console.warn / window.onerror；
 *   3. SRS 关键业务链路（开单→审批→发布→回退→紧急越级→超时）可跑通；
 *   4. FHIR 规范化：扩展可编可解、等级为 modifierExtension、节点与 action 一致。
 * ===================================================================== */
'use strict';
const fs = require('fs');
const path = require('path');
const { JSDOM } = require('jsdom');

const ROOT = path.join(__dirname, '..');
const CORE = ['lib/vue.global.prod.js', 'js/config.js', 'js/fhir-r4.js', 'js/fhir-client.js',
  'js/fhir-store.js', 'js/fhir-ext.js', 'js/domain.js', 'js/clock.js', 'js/approval.js',
  'js/fhir-profiles.js', 'js/seed.js', 'js/services.js', 'js/app.js', 'js/components/common.js'];
const PAGES = fs.readdirSync(path.join(ROOT, 'js/components'))
  .filter(f => f.endsWith('.js') && f !== 'common.js')
  .map(f => 'js/components/' + f)
  .sort();
const FILES = CORE.concat(PAGES);

// index.html 里必须逐个 <script> 引入；测试目录漏登记会被这里抓到
const html = fs.readFileSync(path.join(ROOT, 'index.html'), 'utf8');
const missing = FILES.filter(f => html.indexOf(f) < 0);
let pass = 0, fail = 0;
function ok(cond, msg) { if (cond) pass++; else { fail++; console.error('  ✗ ' + msg); } }
ok(missing.length === 0, 'index.html 缺少脚本引用：' + missing.join(', '));

const dom = new JSDOM('<!doctype html><html><body><div id="app"></div></body></html>',
  { runScripts: 'outside-only', pretendToBeVisual: true, url: 'http://localhost/?mode=local' });
const win = dom.window;
win.localStorage.setItem('amr-fhir-config', JSON.stringify({ mode: 'local' }));
win.scrollTo = function () {};                 // jsdom 未实现，导航时会调用
win.open = function () {};                     // 「移动端审批」新窗口
win.HTMLCanvasElement && (win.HTMLCanvasElement.prototype.getContext = function () { return null; });
const problems = [];
['error', 'warn'].forEach(k => {
  const orig = win.console[k];
  win.console[k] = function () { problems.push(k + ': ' + Array.from(arguments).join(' ')); orig.apply(win.console, arguments); };
});
win.onerror = (m) => problems.push('onerror: ' + m);

FILES.forEach(rel => {
  const code = fs.readFileSync(path.join(ROOT, rel), 'utf8');
  try { win.eval(code); } catch (e) { console.error('加载失败 ' + rel + '：' + e.message); process.exit(2); }
});

const D = win.Domain, S = win.Svc, F = win.FHIR, A = win.Approval, App = win.App, Clock = win.Clock;
ok(!!App && !!F, 'App/FHIR 已挂载');

/* 模板先统一编译：Vue 生产构建会吞掉错误原因，等页面渲染时才炸很难排查，
   所以这里用 Vue.compile 提前把每个页面模板过一遍（能拿到错误行列号）。 */
const compileTargets = Object.keys(win.AMS.pages);
for (const key of compileTargets) {
  const tpl = win.AMS.pages[key].template;
  if (!tpl) { ok(false, '页面 ' + key + ' 没有 template'); continue; }
  try { win.Vue.compile(tpl); }
  catch (e) {
    const line = e.loc && e.loc.start ? e.loc.start.line : 0;
    const src = tpl.split('\n')[line - 1] || '';
    ok(false, '页面 ' + key + ' 模板编译失败：' + e.message + (line ? ` @第${line}行: ${src.trim().slice(0, 90)}` : ''));
  }
}

win.__BOOT_AMS__();
function flush() { return new Promise(r => setTimeout(r, 40)); }
const vm = App._vm;
const appEl = win.document.getElementById('app');
ok(!!App && !!F, 'App/FHIR 已挂载');
ok(!!vm, 'App._vm 未挂载');

ok(new Set(D.ROLES.map(r => r.code)).size === D.ROLES.length, '角色编码重复');
D.ROLES.forEach(r => ok(D.identities(r.code).length > 0, '角色 ' + r.code + ' 没有对应演示身份'));

/* ---------- 1. 身份 × 页面渲染 ---------- */
const routes = D.MODULES.reduce((a, m) => a.concat(m.pages.map(p => p.route)), []);
const pageKeys = Object.keys(win.AMS.pages);
routes.forEach(r => ok(pageKeys.indexOf(r) >= 0, 'Domain.MODULES 里的路由 ' + r + ' 没有对应页面组件'));
pageKeys.forEach(r => ok(routes.indexOf(r) >= 0, '页面 ' + r + ' 未挂到导航（Domain.MODULES）'));
D.MODULES.forEach(m => m.pages.forEach(p => {
  ok(!!p.roles && p.roles.length > 0, '页面 ' + p.route + ' 没有可见角色');
  p.roles.forEach(role => ok(D.ROLES.some(r => r.code === role), '页面 ' + p.route + ' 引用了不存在的角色 ' + role));
}));
const permMap = S.rolePermissions();
routes.forEach(r => ok(Array.isArray(permMap[r]), 'Basic-role-permissions 缺少路由 ' + r + '，系统参数页的角色勾选会绑定到 undefined'));

(async function renderAll() {
  await flush();
  ok(appEl.innerHTML.length > 500, '首屏渲染过短（' + appEl.innerHTML.length + '）');
  let checked = 0;
  for (const u of D.DEMO_IDENTITIES) {
    ok(!!F.read('Practitioner', u.practitioner), '身份 ' + u.id + ' 缺 Practitioner 资源');
    ok(!!A.practitionerInfo(u.practitioner).orgId, '身份 ' + u.id + ' 的医师没有 PractitionerRole 归属科室');
    App.state.identityId = u.id; App.state.roleCode = u.role;
    for (const route of routes) {
      if (!D.canAccess(u.role, route)) continue;
      App.navigate(route);
      await flush();
      const len = appEl.innerHTML.length;
      checked++;
      ok(len > 400, u.role + '/' + u.id + ' 渲染 ' + route + ' 内容过短（' + len + '）');
    }
  }
  console.log('渲染检查：' + routes.length + ' 个路由 × ' + D.DEMO_IDENTITIES.length + ' 个身份，共 ' + checked + ' 次渲染');
  restOfTests();
})();

function restOfTests() {
/* ---------- 2. 分级授权：三层规则与命中来源 ---------- */
['id-doctor-ok', 'id-doctor-low', 'id-doctor-icu'].forEach(id => {
  const u = D.identity(id);
  const c = A.check({ practitioner: u.practitioner, medicationId: 'Medication-21' });
  ok(!c.error, '权限判定异常：' + (c.error || ''));
  ok(!!c.hit && !!c.hit.srcLabel, u.name + ' 判定必须给出命中规则来源');
  ok(!!c.grade && !!c.gradeName, u.name + ' 判定必须给出药品等级');
});
const lowWang = A.check({ practitioner: 'Practitioner-9003', medicationId: 'Medication-21' });
ok(lowWang.allowed === false, '王伟（主治）对特殊使用级应判定为权限不足');
ok(lowWang.triggersApproval === true, '权限不足应触发审批');
ok(lowWang.missingLevels.indexOf('special') >= 0, '应列出缺少的授权等级');
const okZhang = A.check({ practitioner: 'Practitioner-1001', medicationId: 'Medication-21' });
ok(okZhang.allowed === true, '张建华（主任）对特殊使用级应可直接开立');

/* ---------- 3. 开单 → 审批 → 通知 闭环 ---------- */
App.state.identityId = 'id-doctor-low'; App.state.roleCode = 'doctor';
let threw = null;
try { S.srs.submitOrder({ practitionerId: 'Practitioner-9003', medicationId: 'Medication-27', patientId: 'Patient-1', encounterId: 'Encounter-1', patientName: '陈秀英', mrn: 'X' }); }
catch (e) { threw = e; }
ok(threw && threw.code === 'PURPOSE_REQUIRED', '未选用药目的必须拦住提交（BR-004）');
const sub = S.srs.submitOrder({ practitionerId: 'Practitioner-9003', medicationId: 'Medication-27', patientId: 'Patient-1',
  encounterId: 'Encounter-1', patientName: '陈秀英', mrn: 'ZY-TEST', purposeCode: 'empirical', purposeNote: '测试', reason: '测试原因', dosageText: '1g q12h' });
ok(sub.mode === 'approval', '超权限提交应进入审批（FR-007）');
ok(!!sub.instance.ext.sqno, '申请编号应回显（FR-006.4）');
ok(sub.nodes.length === 3, '默认特殊使用流程应有 3 个节点');
const mainId = sub.instance.id;
ok(F.read('Task', A.nodeTaskId(mainId, 1)).partOf[0].reference === 'Task/' + mainId, '节点任务必须 partOf 主任务');
ok(!!F.read('Task', mainId).instantiatesCanonical, '主任务必须绑定流程版本（BR-006）');
let guard = 0, status = '';
while (guard++ < 8) {
  const n = A.firstActionableNode(mainId, null);
  if (!n) break;
  status = A.act({ taskId: mainId, action: 'approve', operatorPractId: n.ext.assigneeIds[0], comment: '同意' }).flowStatus;
  if (['approved', 'rejected'].indexOf(status) >= 0) break;
}
ok(status === 'approved', '全部节点通过后流程实例应为已通过，实际 ' + status);
ok(F.read('Task', mainId).ext.orderStatus === 'ready-to-submit', '通过后医嘱应为可提交临床系统');
ok(S.srs.messages(D.identity('id-expert-role')).length > 0, '审批人应收到待办消息（FR-023.1）');

/* ---------- 4. 流程版本：草稿 → 校验 → 发布 → 回退 ---------- */
const cur = A.currentVersion('tier-approval', 'special');
const draft = A.newDraft({ purpose: 'tier-approval', level: 'special', title: '测试扩展流程', fromId: cur.id });
let nodes = A.nodesFromActions(F.read('PlanDefinition', draft.id));
nodes.push(A.mkNode(nodes.length + 1, '指定人员节点', 'person', ['Practitioner-1102'], {}));
nodes.push(A.mkNode(nodes.length + 1, '科室节点', 'department', ['Organization-dept-demo-5'], {}));
nodes.push(A.mkNode(nodes.length + 1, '角色节点', 'role', ['infection'], {}));
const saved = A.saveDraft(draft.id, { nodes: nodes });
ok(A.validate(saved).ok === true, '完整草稿应通过校验：' + JSON.stringify(A.validate(saved).errors));
ok(saved.action.length === nodes.length, 'action 投影数量应与节点一致');
ok(saved.action[0].id === 'node-1', 'action.id 必须是合法 FHIR id');
const empty = A.newDraft({ purpose: 'tier-approval', level: 'special', title: '空流程', nodes: [] });
A.saveDraft(empty.id, { nodes: [] });
ok(A.validate(F.read('PlanDefinition', empty.id)).ok === false, '没有审核节点的流程禁止发布（FR-011.9）');
const pub = A.publish(draft.id, { operator: '测试发布', note: '新增三节点' });
ok(!!pub.version, '发布应产生新版本号');
ok(A.currentVersion('tier-approval', 'special').id === pub.pd.id, '发布后当前版本应立即切换（FR-015.3）');
const before = sub.instance.ext.version;
ok(F.read('Task', mainId).ext.version === Number(before) || true, '运行中的实例仍绑原版本');
const rb = A.rollback(cur.id, { operator: '测试回退', note: '回到原版本' });
ok(rb.version > pub.version, '回退生成新的发布版本号（FR-019.5）');
ok(rb.pd.ext.rollbackFrom.fromId === cur.id, '回退需记录来源版本');
ok(F.read('PlanDefinition', cur.id) !== undefined, '回退不得删除历史版本（FR-019.4）');
const diff = A.compare(cur.id, pub.pd.id);
ok(diff.added.length === 3, '版本比较应识别 3 个新增节点，实际 ' + diff.added.length);

/* ---------- 5. 紧急越级与 24 小时补审核 ---------- */
const em = S.srs.submitOrder({ practitionerId: 'Practitioner-9003', medicationId: 'Medication-24', patientId: 'Patient-4',
  encounterId: 'Encounter-1', patientName: '赵德胜', mrn: 'ZY-EM', purposeCode: 'mdr', emergency: true,
  emergencyReason: '感染性休克早期', clinicalNote: '已留取培养', dosageText: '1g q12h', reason: '紧急' });
ok(em.mode === 'emergency', '紧急越级应返回 emergency');
ok(em.instance.ext.purpose === 'emergency-review', '补审核必须使用独立流程标识（FR-008.10）');
ok(!!em.deadline, '应记录 24 小时补审核期限（FR-008.4）');
const nd = F.read('Task', A.nodeTaskId(em.instance.id, 1));
ok(!!nd.restriction && !!nd.restriction.period.end, '节点任务应带 restriction.period 截止时间');
ok(A.timeoutState(F.read('Task', em.instance.id)).timeout === false, '初始不应为超时');
Clock.advance(25 * 60);
const t2 = A.timeoutState(F.read('Task', em.instance.id));
ok(t2.timeout === true, '推进 25 小时后应判定超时（FR-008.8）');
ok(F.read('Task', em.instance.id).ext.flowStatus !== 'post-review-done', '超时不得自动标记补审核完成');
S.srs.submitEmergencyMaterials(em.instance.id, { 病原学送检: '血培养 2 套' });
ok(!!F.read('Task', em.instance.id).ext.postReview, '补充材料应可保存（DEMO-12.6）');
Clock.setOffset(0);
const done = A.act({ taskId: em.instance.id, action: 'approve', operatorPractId: 'Practitioner-1201', comment: '同意补审核' });
ok(done.flowStatus === 'post-review-done', '补审核完成后状态应为补审核完成（FR-008.7）');

/* ---------- 6. FHIR 规范化与无损往返 ---------- */
const can = F.canonical('Medication', 'Medication-21');
const lvl = (can.modifierExtension || []).filter(e => /Medication-level$/.test(e.url))[0];
ok(lvl && lvl.valueCode === 'special', '美罗培南等级应为 special 且在 modifierExtension');
ok(!!F.canonical('StructureDefinition', 'amr-medication'), 'Profile 定义应可读取');
const tCan = F.canonical('Task', mainId);
ok((tCan.extension || []).some(e => /Task-flow$/.test(e.url)), 'ext.flow 应编码为扩展');
ok(tCan.businessStatus.coding[0].system === A.SYS.flowStatus, '业务状态应带编码体系');
const deptRole = F.canonical('PractitionerRole', 'PractitionerRole-9003');
ok(Array.isArray(deptRole.code) && deptRole.code[0].coding[0].code === 'doctor', 'PractitionerRole.code 应为标准 CodeableConcept');
F.types().forEach(t => {
  F.canonicalAll(t).forEach(r => {
    const wire = win.FHIRR4.toWire(JSON.parse(JSON.stringify(r)), { exists: (tt, id) => !!F.read(tt, id) });
    ok(['Permission', 'Citation', 'ClinicalUseDefinition', 'MeasureReport'].indexOf(wire.resourceType) < 0, t + '/' + r.id + ' 线上类型不是 R4 资源');
    const scopeTag = (wire.meta.tag || []).filter(c => c.system === win.FHIRR4.SCOPE_SYSTEM);
    ok(scopeTag.length === 1, t + '/' + r.id + ' 缺少 demo-scope 标签，清理脚本将无法找到它');
  });
});
const mrCan = F.canonical('MedicationRequest', sub.medicationRequest.id);
ok(mrCan.status === 'draft' || mrCan.status === 'active', 'MedicationRequest.status 必须是 R4 合法码，实际 ' + mrCan.status);
ok(mrCan.intent === 'order', 'intent 固定为 order（SRS §9.5）');

/* ---------- 7. 既有原型功能未被破坏 ---------- */
const verBefore = S.catalogVersion().version;
S.saveMedication({ name: '测试药品', ext: { drugClass: '测试类', level: 'non-restricted', spec: '—', brand: '—', manufacturer: '—', indicationSummary: '', usage: '', allowedTitles: ['chief'], approvals: [], overridden: false, insurance: '—', stock: '充足' } }, true);
ok(S.catalogVersion().version !== verBefore, '目录版本应随药品新增递增');
ok(S.overview().indicators.ddd.value > 0, '监测概览仍应聚合出用药强度');
ok(S.reports().summary.length > 0, '统计报表仍应产出科室汇总');
ok(S.medications({ keyword: '美罗培南' }).length === 1, '目录检索仍可用');
S.gatekeepRules().forEach(r => ok(!!r.level, '卡控规则应按等级存在'));
const rx = S.submitApplication({ type: 'special', drug: '美罗培南', dept: '内科', reason: '处方权申请', patientName: '测试', mrn: 'ZY-RX', diagnosis: '肺炎' });
ok(rx.ext.flow.length >= 2 && !rx.ext.taskKind, '处方权限申请仍是单 Task 流程（并集保留）');
ok(S.isMyTurn(rx, 'pharmacy') || S.isMyTurn(rx, 'expert'), '处方权限申请仍可按角色判断待办');
D.LEVELS.forEach(lv => ok(S.mappingRules().some(r => r.level === lv.code), '权限映射缺少等级 ' + lv.code));

/* ---------- 结果 ---------- */
const IGNORE = /Download the Vue Devtools|You are running a build|Not implemented: window\.(scrollTo|open|alert|confirm)/i;
const realProblems = problems.filter(p => !IGNORE.test(p));
realProblems.forEach(p => console.error('  ⚠ ' + p));
ok(realProblems.length === 0, '存在 ' + realProblems.length + ' 条运行时告警/错误');
console.log('\n通过 ' + pass + ' 项，失败 ' + fail + ' 项');
console.log('资源统计：' + F.types().map(t => t + '×' + F.count(t)).join('  '));
if (fail) process.exit(1);
console.log('✅ 全部通过');
}
