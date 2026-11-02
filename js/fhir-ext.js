/* =====================================================================
 * fhir-ext.js —— FHIR 扩展机制（Extension / ModifierExtension）编解码
 * ---------------------------------------------------------------------
 * 基础 FHIR 资源无法表达的业务数据，按 FHIR 规范通过「扩展」承载：
 *   - extension：为资源补充的附加数据（不改变资源原义）
 *   - modifierExtension：会改变资源含义/处理方式的数据（如抗菌药物分级、
 *     拦截动作——典型的 modifier 场景）
 *   - 复杂嵌套结构（审批流程节点、报表数据集等）无对应 FHIR 元素时，
 *     以 valueString 承载 JSON（real-world FHIR 常见做法），并在 profile
 *     注册表中显式声明，保证诚实可追溯。
 *
 * 每个扩展拥有规范化 canonical url，定义见所注册的 StructureDefinition。
 * 本模块提供 encode/decode，在 FHIR 内存库读写时在「规范扩展数组」与
 * 「开发友好的 ext 投影对象」之间双向转换。
 * ===================================================================== */
(function (global) {
  'use strict';

  // 自定义扩展/Profile 的 canonical 基地址
  var BASE = 'https://fhir.amr-demo.example/StructureDefinition/';

  /* Profile 注册表（等价于各资源的 StructureDefinition 约束）：
   *   modifier：归入 modifierExtension 的字段（改变资源含义）
   *   list    ：标量数组字段（即使单元素也还原为数组）
   *   json    ：复杂嵌套字段，以 valueString 承载 JSON
   * 未列出的字段按 JS 类型自动编码为标量扩展。 */
  var REGISTRY = {
    Practitioner: {},
    Patient: {},
    Organization: {},
    Medication: { modifier: ['level', 'allowedTitles', 'approvals'], list: ['allowedTitles', 'approvals', 'indications'] },
    Citation: {},
    ClinicalUseDefinition: { list: ['citations'] },
    Permission: { modifier: ['interceptOnTitleMismatch', 'interceptOnNotApproved'], list: ['allowedTitles', 'approvals', 'approvalCheck'] },
    PlanDefinition: { list: ['applyTitles'], json: ['nodes'] },
    Task: { modifier: ['type'], json: ['flow', 'decision'] },
    DetectedIssue: { json: ['detail'] },
    Observation: {},
    MeasureReport: { json: ['indicators', 'catalogStats', 'departmentRanking', 'trend', 'summary', 'deptDetail', 'doctorRx', 'drugUse'] },
    Communication: {},
    Provenance: {},
    Endpoint: {},
    Basic: { json: ['scope', 'records', 'rules', 'items', 'byDept'] }
  };

  // 应编码为 valueCode（编码型）而非 valueString 的字段
  var CODE_FIELDS = {
    level: 1, type: 1, category: 1, roleType: 1, title: 1, requesterTitle: 1, rational: 1,
    interceptOnTitleMismatch: 1, interceptOnNotApproved: 1,
    allowedTitles: 1, approvals: 1, approvalCheck: 1, applyTitles: 1
  };

  function reg(rt) { return REGISTRY[rt] || {}; }
  function has(arr, k) { return arr && arr.indexOf(k) >= 0; }

  function valueEntry(url, field, v) {
    var e = { url: url };
    if (typeof v === 'boolean') e.valueBoolean = v;
    else if (typeof v === 'number') e[Number.isInteger(v) ? 'valueInteger' : 'valueDecimal'] = v;
    else e[CODE_FIELDS[field] ? 'valueCode' : 'valueString'] = String(v);
    return e;
  }
  function readValue(e) {
    if ('valueBoolean' in e) return e.valueBoolean;
    if ('valueInteger' in e) return e.valueInteger;
    if ('valueDecimal' in e) return e.valueDecimal;
    if ('valueCode' in e) return e.valueCode;
    if ('valueString' in e) return e.valueString;
    return null;
  }

  /* 将开发友好的 ext 对象编码为标准 FHIR extension / modifierExtension 数组 */
  function encode(rt, ext) {
    var r = reg(rt), extension = [], modifier = [];
    Object.keys(ext || {}).forEach(function (field) {
      var v = ext[field];
      if (v === undefined) return;
      var url = BASE + rt + '-' + field;
      var target = has(r.modifier, field) ? modifier : extension;
      if (v === null) {
        // 空 valueString 会被服务端当缺省丢掉，往返后就消失。声明为 JSON 的字段用
        // 字面量 'null' 承载（可还原成真正的 null）；其余标量 null 直接省略，
        // 上层读取这些字段时都做了存在性判断，缺失与 null 等价。
        if (has(r.json, field)) target.push({ url: url, valueString: 'null' });
        return;
      }
      var isJson = has(r.json, field) ||
        (typeof v === 'object' && !Array.isArray(v)) ||
        (Array.isArray(v) && v.length && typeof v[0] === 'object');
      if (isJson) { target.push({ url: url, valueString: JSON.stringify(v) }); return; }
      if (Array.isArray(v)) { v.forEach(function (item) { target.push(valueEntry(url, field, item)); }); return; }
      target.push(valueEntry(url, field, v));
    });
    return { extension: extension, modifierExtension: modifier };
  }

  /* 从标准 FHIR extension / modifierExtension 数组还原 ext 对象 */
  function decode(rt, resource) {
    var r = reg(rt), prefix = BASE + rt + '-', groups = {};
    ['extension', 'modifierExtension'].forEach(function (which) {
      (resource[which] || []).forEach(function (e) {
        if (!e.url || e.url.indexOf(prefix) !== 0) return;
        var field = e.url.slice(prefix.length);
        (groups[field] = groups[field] || []).push(e);
      });
    });
    var ext = {};
    Object.keys(groups).forEach(function (field) {
      var entries = groups[field];
      if (has(r.json, field)) { ext[field] = parseJson(entries[0]); return; }
      if (has(r.list, field) || entries.length > 1) { ext[field] = entries.map(readValue); return; }
      var val = readValue(entries[0]);
      if (typeof val === 'string' && (val.charAt(0) === '{' || val.charAt(0) === '[')) {
        try { ext[field] = JSON.parse(val); return; } catch (_) { /* 普通字符串 */ }
      }
      ext[field] = val;
    });
    // 声明为标量数组的字段即使为空也还原为 []（空数组编码后无扩展条目）
    (r.list || []).forEach(function (field) { if (!(field in ext)) ext[field] = []; });
    return ext;
  }
  function parseJson(e) { var s = readValue(e); try { return JSON.parse(s); } catch (_) { return s; } }

  global.FHIRExt = { BASE: BASE, REGISTRY: REGISTRY, CODE_FIELDS: CODE_FIELDS, encode: encode, decode: decode };
})(window);
