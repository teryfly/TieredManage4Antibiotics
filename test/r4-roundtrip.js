/* =====================================================================
 * r4-roundtrip.js —— R4 合规与真实服务端往返验证
 * ---------------------------------------------------------------------
 * 两部分：
 *   A. 静态检查：把镜像里全部资源的「线上形态」跑一遍，确认没有任何 R5-only
 *      类型、非法业务状态码、非 ISO 日期会被发往 R4 服务端。
 *   B. 真机往返：把一组带引用关系的样例（用随机前缀命名，避免污染公共演示
 *      服务器上的本项目数据）写入 https://hapi.fhir.org/baseR4，读回、还原成
 *      内部形态，逐字段比对 ext 投影是否无损。结束后删除本次写入的全部资源。
 *
 * 用法：node test/r4-roundtrip.js [--keep]   --keep 表示不删除（调试用）
 * ===================================================================== */
'use strict';
const fs = require('fs');
const path = require('path');
const { webcrypto } = require('crypto');

const ROOT = path.join(__dirname, '..');
const BASE = process.env.FHIR_BASE || 'https://hapi.fhir.org/baseR4';
const KEEP = process.argv.includes('--keep');

/* ---------- 用公共垫片装载数据层（含 clock.js / approval.js）---------- */
const H = require('./harness');
const win = H.makeWindow({ search: '?mode=remote', config: { mode: 'remote', demoScope: 'kjywfj-roundtrip' } });
H.loadInto(win);
H.stubApp(win, 'id-ruleadmin');

const F = win.FHIR, R4 = win.FHIRR4, Conf = win.AmrConfig;

const R5_TYPES = ['Permission', 'Citation', 'ClinicalUseDefinition', 'MeasureReport'];
const R4_STATUS = {
  Endpoint: ['active', 'construction', 'old-content', 'draft', 'failed', 'in-preparation', 'entered-in-error'],
  DetectedIssue: ['final', 'amended', 'corrected', 'registered', 'prevented', 'mitigated'],
  // R4 task-status 实测码表（draft,requested,received,accepted,rejected,ready,cancelled,
  // in-progress,on-hold,failed,completed,entered-in-error）
  Task: ['draft', 'requested', 'received', 'accepted', 'rejected', 'ready', 'cancelled',
    'in-progress', 'on-hold', 'failed', 'completed', 'entered-in-error'],
  // R4 request-status（服务端实测拒绝 revoked，接受 cancelled）
  MedicationRequest: ['draft', 'active', 'on-hold', 'cancelled', 'completed', 'entered-in-error', 'unknown'],
  Encounter: ['planned', 'arrived', 'in-progress', 'onleave', 'finished', 'cancelled', 'modified', 'entered-in-error', 'unknown'],
  PlanDefinition: ['draft', 'active', 'retired', 'unknown'],
  CommunicationRequest: ['draft', 'received', 'accepted', 'in-progress', 'on-hold', 'revoked', 'completed', 'entered-in-error', 'unknown'],
  CodeSystem: ['draft', 'active', 'retired', 'unknown'],
  ValueSet: ['draft', 'active', 'retired', 'unknown'],
  PractitionerRole: undefined
};

let pass = 0, fail = 0;
function ok(cond, msg) {
  if (cond) { pass++; }
  else { fail++; console.error('  ✗ ' + msg); }
}

/* ================= A. 全量 wire 静态检查 ================= */
function phaseA() {
  console.log('== A. 镜像全量 wire 检查 ==');
  let n = 0, badTypes = {}, badDates = [], badStatus = [];
  F.types().forEach(type => {
    F.canonicalAll(type).forEach(canonical => {
      const wire = R4.toWire(canonical, { exists: (t, id) => !!F.read(t, id) });
      n++;
      if (R5_TYPES.indexOf(wire.resourceType) >= 0) {
        badTypes[wire.resourceType] = (badTypes[wire.resourceType] || 0) + 1;
      }
      const dump = JSON.stringify(wire);
      // FHIR 日期不允许出现「空格分隔的本地时间」写法
      if (/"(authoredOn|recorded|identified|sent|effective|issued|created|occurred|lastUpdated|requestedOn)":"\d{4}-\d{2}-\d{2} [0-9]/.test(dump)
        || /"(start|end|due|expiration|date)":"\d{4}-\d{2}-\d{2} [0-9]/.test(dump)) {
        badDates.push(wire.resourceType + '/' + wire.id);
      }
      if (R4_STATUS[wire.resourceType] && R4_STATUS[wire.resourceType].indexOf(wire.status) < 0) {
        badStatus.push(wire.resourceType + '/' + wire.id + ' status=' + wire.status);
      }
    });
  });
  ok(Object.keys(badTypes).length === 0, '线上仍存在 R5-only 类型: ' + JSON.stringify(badTypes));
  ok(badDates.length === 0, '线上存在非法日期格式: ' + badDates.slice(0, 5).join(', '));
  ok(badStatus.length === 0, '线上存在非法状态码: ' + badStatus.slice(0, 5).join(', '));
  console.log('  检查 ' + n + ' 个资源；降级为 Basic 的自定义概念：'
    + F.types().filter(t => R4.TO_R4[t]).map(t => t + '×' + F.count(t)).join(', '));
  return n;
}

/* ================= B. 真机往返 ================= */
const TAG = 'z' + webcrypto.randomUUID().replace(/-/g, '').slice(0, 8);
const written = [];

function prefixed(internalId) { return TAG + '-' + internalId; }

// 公共演示 HAPI 会对「内容重复」的资源返回 412，且判定会命中此前写入后已删除的
// 资源（实测仅 id / identifier / narrative 不同不算差异）。测试每轮次给样例的一个
// 可读字段打上本轮前缀，保证内容与往轮不同。
function tagContent(r, tag) {
  if (r.ext && typeof r.ext.content === 'string') { r.ext.content += ' ' + tag; return; }
  if (r.ext && typeof r.ext.description === 'string') { r.ext.description += ' ' + tag; return; }
  if (r.ext && typeof r.ext.summary === 'string') { r.ext.summary += ' ' + tag; return; }
  if (r.ext && typeof r.ext.reason === 'string' && r.ext.reason) { r.ext.reason += ' ' + tag; return; }
  if (r.code && typeof r.code.text === 'string') { r.code.text += ' ' + tag; return; }
  if (typeof r.title === 'string') { r.title += ' ' + tag; return; }
  if (r.name && r.name[0] && typeof r.name[0].text === 'string') { r.name[0].text += ' ' + tag; return; }
  if (typeof r.name === 'string') { r.name += ' ' + tag; return; }
  // 兜底：FHIR 通用注释元素，属于真实内容，能参与服务端的内容差异判定
  r.note = (r.note || []).concat([{ text: 'roundtrip ' + tag }]);
}

// 用随机前缀重建样例，避免与公共演示服务器上本项目的既有数据同名
function buildSampleSet() {
  const org = F.read('Organization', 'Organization-pharmacy');
  const pra = F.read('Practitioner', 'Practitioner-9003');
  const pat = F.read('Patient', 'Patient-1');
  const med = F.search('Medication', m => m.code.text === '美罗培南')[0];
  const perm = F.read('Permission', 'Permission-map-special');
  const cit = F.read('Citation', 'Citation-1');
  const cud = F.read('ClinicalUseDefinition', 'ClinicalUseDefinition-1');
  const pln = F.read('PlanDefinition', 'PlanDefinition-amr-tier-approval-special-v1');
  const mk = F.read('MedicationKnowledge', 'MedicationKnowledge-21');
  const prole = F.read('PractitionerRole', 'PractitionerRole-9003');
  const enc = F.read('Encounter', 'Encounter-1');
  const mrq = F.read('MedicationRequest', F.search('MedicationRequest')[0].id);
  const flow = F.search('Task', t => t.ext && t.ext.taskKind === 'main')[0];
  const node = F.search('Task', t => t.ext && t.ext.taskKind === 'node')[0];
  const crq = F.read('CommunicationRequest', F.search('CommunicationRequest')[0].id);
  const aud = F.read('AuditEvent', F.search('AuditEvent')[0].id);
  const csy = F.read('CodeSystem', 'CodeSystem-amr-level');
  const vs = F.read('ValueSet', 'ValueSet-amr-level');
  const det = F.read('DetectedIssue', 'DetectedIssue-1');
  const obs = F.read('Observation', 'Observation-s1');
  const com = F.read('Communication', F.search('Communication')[0].id);
  const pro = F.read('Provenance', F.search('Provenance')[0].id);
  const eps = F.read('Endpoint', 'Endpoint-rational');
  const bas = F.read('Basic', 'Basic-catalog-version');
  const tas = F.read('Task', 'Task-1002');

  const out = [org, pra, pat, med, mk, prole, enc, perm, cit, cud, pln, mrq, det, obs,
    crq, com, pro, aud, eps, bas, tas, flow, node, csy, vs];
  // 样例内部的引用一律改指向本轮前缀的同类资源；指向未纳入样例的资源由
  // fhir-r4 的悬空引用处理省略（这些元素在 R4 里都是可选的）。
  const keepTypes = { Organization: org.id, Practitioner: pra.id, Patient: pat.id,
    Medication: med.id, Encounter: enc.id, MedicationRequest: mrq.id, Task: flow.id,
    PlanDefinition: pln.id, Basic: bas.id, CommunicationRequest: crq.id };
  const refs = ['requester', 'performer', 'owner', 'subject', 'for', 'patient', 'medicationReference',
    'medicationCodeableConcept', 'encounter', 'focus', 'which', 'author', 'recorder', 'sent', 'recipient',
    'sender', 'about', 'individual', 'organization', 'practitioner', 'basedOn', 'partOf', 'instantiatesCanonical',
    'agent', 'who', 'observer', 'entity', 'what', 'source', 'component', 'associatedMedication'];
  function rewrite(node2, depth) {
    if (!node2 || typeof node2 !== 'object' || depth > 5) return;
    if (Array.isArray(node2)) { node2.forEach(n2 => rewrite(n2, depth + 1)); return; }
    Object.keys(node2).forEach(k => {
      const v = node2[k];
      const m = v && typeof v === 'object' && typeof v.reference === 'string'
        ? /^([A-Za-z]+)\/([^/]+)$/.exec(v.reference) : null;
      if (m && keepTypes[m[1]] && refs.indexOf(k) >= 0) v.reference = m[1] + '/' + prefixed(keepTypes[m[1]]);
      else rewrite(v, depth + 1);
    });
  }
  out.forEach(r => {
    r.id = prefixed(r.id);
    r.meta = {};
    rewrite(r, 0);
    tagContent(r, TAG);
  });
  return out;
}

async function phaseB() {
  console.log('\n== B. 真实服务端往返（' + BASE + '，前缀 ' + TAG + '）==');
  const md = await win.FHIRClient.capabilities(BASE, { timeout: 20000 });
  console.log('  服务端 FHIR 版本：' + md.fhirVersion);
  ok(/^4\./.test(md.fhirVersion), '服务端不是 R4：' + md.fhirVersion);

  const samples = buildSampleSet();
  // 走真实写链路：create → ext 编码 → toWire → 写队列 → HTTP
  await Conf.set({ fhirBase: BASE });
  F.reset();
  F.setMode('remote', BASE);

  const order = ['Organization', 'Practitioner', 'Patient', 'Medication', 'MedicationKnowledge',
    'PractitionerRole', 'Encounter', 'Basic', 'PlanDefinition', 'MedicationRequest',
    'DetectedIssue', 'Observation', 'Task', 'CommunicationRequest', 'Communication',
    'Provenance', 'AuditEvent', 'Endpoint', 'CodeSystem', 'ValueSet',
    'Permission', 'Citation', 'ClinicalUseDefinition'];
  samples.sort((a, b) => order.indexOf(a.resourceType) - order.indexOf(b.resourceType));
  samples.forEach(r => F.create(r));

  const st = await F.flush();
  ok(st.failed === 0, '写队列存在失败：' + st.failed + ' 条，最近一条 '
    + (st.lastError ? st.lastError.type + '/' + st.lastError.id + ' ' + st.lastError.message : ''));
  console.log('  队列写入 ' + st.done + ' 条，失败 ' + st.failed + ' 条');

  // 按 meta.tag 从服务端找回（R4 全类型通用；identifier 在 Provenance 上不可用），
  // 再 fromWire + ext 解码，与写入前的内部形态逐字段比对
  const Ext = win.FHIRExt;
  function normExt(v) { return (v && Object.keys(v).length) ? JSON.stringify(v) : null; }
  let sameType = 0, sameExt = 0, sameId = 0, restoredTypes = {}, identOk = 0;
  for (const before of samples) {
    const wireType = R4.TO_R4[before.resourceType] || before.resourceType;
    let bundle;
    try {
      bundle = await win.FHIRClient.byTag(BASE, wireType, R4.ID_SYSTEM, before.id);
    } catch (e) {
      ok(false, '按 _tag 反查失败 ' + before.resourceType + '/' + before.id + '：' + e.message);
      continue;
    }
    const entry = (bundle.entry || [])[0];
    if (!entry) { ok(false, '按 _tag 未找回 ' + before.resourceType + '/' + before.id); continue; }
    written.push({ type: wireType, id: entry.resource.id });

    // 支持 identifier 的类型应同时可按 identifier 检索（原生 FHIR 客户端的入口）
    if (!R4.NO_IDENTIFIER[before.resourceType]) {
      try {
        const byId = await win.FHIRClient.byIdentifier(BASE, wireType, R4.ID_SYSTEM, before.id);
        if ((byId.entry || []).length) identOk++;
        else ok(false, 'identifier 检索为空 ' + before.resourceType + '/' + before.id);
      } catch (e) {
        ok(false, 'identifier 检索失败 ' + before.resourceType + '/' + before.id + '：' + e.message);
      }
    }

    const back = R4.fromWire(entry.resource);
    if (back.resourceType === before.resourceType) {
      sameType++;
      restoredTypes[back.resourceType] = (restoredTypes[back.resourceType] || 0) + 1;
    } else ok(false, '类型未还原：' + before.resourceType + ' -> wire ' + wireType + ' -> ' + back.resourceType);
    if (R4.wireIdOf(back) === before.id) sameId++;
    else ok(false, 'id 未找回：' + before.id + ' -> ' + R4.wireIdOf(back));
    if (back.id !== before.id) ok(false, '读回的逻辑 id 与写入不一致：' + before.id + ' -> ' + back.id);

    const a = normExt(before.ext), b = normExt(Ext.decode(back.resourceType, back));
    if (a === b) sameExt++;
    else ok(false, 'ext 投影有损：' + before.resourceType + '/' + before.id
      + '\n      发出 ' + a + '\n      回来 ' + b);
    // 业务状态词表必须原样回来（标准字段已被换成 R4 合法码）
    if (R4.BIZ_STATUS[before.resourceType]) {
      const wireStatus = entry.resource.status;
      ok(R4_STATUS[before.resourceType].indexOf(wireStatus) >= 0,
        before.resourceType + '/' + before.id + ' 线上状态码非 R4 规范值：' + wireStatus);
      if (before.status !== back.status) {
        ok(false, '业务状态未还原：' + before.resourceType + '/' + before.id
          + ' 发出 ' + before.status + ' 回来 ' + back.status);
      }
    }
    // FHIR 真实元素：日期必须是 ISO 形态
    if (before.authoredOn) ok(/T/.test(entry.resource.authoredOn || ''),
      'authoredOn 未转为 ISO instant：' + entry.resource.authoredOn);
  }
  ok(sameType === samples.length, '类型还原不完整：' + sameType + '/' + samples.length);
  ok(sameId === samples.length, 'id 找回不完整：' + sameId + '/' + samples.length);
  ok(sameExt === samples.length, 'ext 无损往返不完整：' + sameExt + '/' + samples.length);
  console.log('  类型还原 ' + sameType + ' · id 找回 ' + sameId + ' · ext 无损 ' + sameExt
    + ' / 共 ' + samples.length + ' · identifier 可检索 ' + identOk);
  console.log('  还原后类型分布：' + Object.keys(restoredTypes).sort().map(t => t + '×' + restoredTypes[t]).join(', '));
}

async function cleanup() {
  if (KEEP) { console.log('\n--keep：保留 ' + written.length + ' 个测试资源'); return; }
  console.log('\n== 清理测试资源 ==');
  let queue = written.slice().reverse(), left = [];
  // 按写入的逆序删除；服务端有引用完整性约束，被引用方要等引用方先消失，故再轮一遍
  for (let round = 1; round <= 3 && queue.length; round++) {
    left = [];
    for (const w of queue) {
      try { await win.FHIRClient.remove(BASE, w.type, w.id); }
      catch (e) { if (e.status !== 404 && e.status !== 410) left.push(w); }
    }
    console.log('  第 ' + round + ' 轮删除 ' + (queue.length - left.length) + '/' + queue.length
      + ' 条' + (left.length ? '，被引用保护拦下 ' + left.length + ' 条' : ''));
    queue = left.slice().reverse();
  }
  const still = [];
  for (const w of written) {
    try { await win.FHIRClient.get(BASE, w.type, w.id); still.push(w.type + '/' + w.id); }
    catch (e) { /* 404/410 表示已不可读 */ }
  }
  ok(!still.length, '清理后服务端仍可读到 ' + still.length + ' 个测试资源：' + still.slice(0, 8).join(', '));
}

(async () => {
  try {
    await Conf.load();
    const n = phaseA();
    await phaseB();
    await cleanup();
    console.log('\n==== 结果：通过 ' + pass + ' 项，失败 ' + fail + ' 项（检查 ' + n + ' 个资源）====');
    process.exit(fail ? 1 : 0);
  } catch (e) {
    console.error('\n测试异常：', e && e.stack || e);
    await cleanup();
    process.exit(1);
  }
})();
