/* =====================================================================
 * fhir-r4.js —— 内部资源 ↔ FHIR R4 线上格式的转换层
 * ---------------------------------------------------------------------
 * 原型（main 分支）混用了 R5 资源与若干非 R4 词表写法，直连 baseR4 服务端
 * 会被拒（HAPI-0302 / HAPI-1821 / HAPI-1094）。本层在「写入服务端」和
 * 「从服务端读回」两个边界上做收敛，应用内部继续沿用原有类型名与业务词表，
 * 因此 services.js 与各页面组件无需感知差异。
 *
 * 处理的四类不兼容：
 *   1) R5-only 资源：Permission / Citation / ClinicalUseDefinition
 *      → R4 无此类型，按 FHIR 对自定义概念的规范做法落到 Basic 上，
 *        原始元素移入扩展，原始类型记录在 meta.tag（读回时还原）。
 *   2) 业务状态词表与 R4 不一致：Endpoint 的 error/off、DetectedIssue 的
 *      preliminary/mitigated。→ 标准字段只放 R4 合法码，业务状态改由 ext
 *        承载（本系统扩展机制），避免依赖某台服务端的具体码表。
 *   3) 日期：应用内展示用 'YYYY-MM-DD HH:mm'，FHIR instant 要求
 *      'YYYY-MM-DDTHH:mm:ss'，写入前统一转换。
 *   4) 悬空引用：服务端开启引用完整性校验，指向不存在资源的引用会导致整单
 *      写入失败（400），故写入前校验引用目标是否存在，不存在则省略该元素
 *      （这些引用在本系统里均为 0..1 可选）。
 * ===================================================================== */
(function (global) {
  'use strict';

  var NO_IDENTIFIER = { Provenance: true };   // R4 中无 identifier 元素的类型（实测）

  // 内部类型 -> R4 线上类型
  var TO_R4 = {
    Permission: 'Basic',
    Citation: 'Basic',
    ClinicalUseDefinition: 'Basic'
  };
  // 落到 Basic 时在 code 上打的分类码，便于在服务端按类型检索
  var BASIC_CLASS = {
    Permission: 'amr-permission-rule',
    Citation: 'amr-citation',
    ClinicalUseDefinition: 'amr-indication'
  };

  var MARK = 'https://fhir.amr-demo.example/StructureDefinition/amr-';
  var ID_SYSTEM = 'https://fhir.amr-demo.example/id';
  var TYPE_CODE = MARK + 'source-resource-type';       // meta.tag：还原内部类型用
  var SRC = MARK + 'source-element-';                  // 被搬走的原始元素
  var BIZ = MARK + 'business-status-';                 // 业务状态词表

  // 各类型的日期型元素（FHIR instant/dateTime），写入前规范为 ISO
  var DATE_ELEMENTS = {
    Task: ['authoredOn', 'lastModified'],
    Provenance: ['recorded'],
    Observation: ['effective', 'issued'],
    DetectedIssue: ['identified'],
    Communication: ['sent'],
    Basic: ['created'],
    MedicationAdministration: ['recorded']
  };

  // Basic 自身拥有的元素；内部类型多出这些的元素在降级时搬进扩展
  var BASIC_ELEMENTS = ['resourceType', 'id', 'meta', 'implicitRules', 'language', 'text',
    'contained', 'extension', 'modifierExtension', 'identifier', 'code', 'author',
    'recorder', 'subject', 'created', 'category', 'note', 'which'];

  // 引用完整性校验时可信的目标类型（这些类型由本系统自己维护）
  var REF_TARGET_TYPES = ['Patient', 'Practitioner', 'Organization', 'Medication', 'Task',
    'Basic', 'Encounter', 'Provenance', 'Communication'];

  function deepClone(o) { return o == null ? o : JSON.parse(JSON.stringify(o)); }

  /* 'YYYY-MM-DD HH:mm[:ss]' -> 'YYYY-MM-DDTHH:mm:ss'；已是 ISO 或仅日期则原样返回 */
  function toInstant(s) {
    if (typeof s !== 'string' || !s) return s;
    var m = /^(\d{4}-\d{2}-\d{2})[ ](\d{2}:\d{2})(:\d{2})?$/.exec(s);
    return m ? m[1] + 'T' + m[2] + (m[3] || ':00') : s;
  }

  function extEntry(url, v, valueKey) {
    var e = { url: url };
    var key = valueKey || (typeof v === 'boolean' ? 'valueBoolean'
      : typeof v === 'number' ? (Number.isInteger(v) ? 'valueInteger' : 'valueDecimal')
      : 'valueString');
    e[key] = (key === 'valueString' && v && typeof v === 'object') ? JSON.stringify(v) : v;
    return e;
  }

  function extValue(e) {
    var v = e.valueString !== undefined ? e.valueString
      : e.valueBoolean !== undefined ? e.valueBoolean
      : e.valueInteger !== undefined ? e.valueInteger
      : e.valueDecimal !== undefined ? e.valueDecimal
      : e.valueCode !== undefined ? e.valueCode : null;
    if (typeof v === 'string' && /^[{[]/.test(v)) { try { return JSON.parse(v); } catch (_) { return v; } }
    return v;
  }

  function addExt(r, url, v, kind) {
    r.extension = r.extension || [];
    r.extension.push(extEntry(url, v, kind));
  }

  /* ---- 业务状态词表：标准字段用 R4 合法码，原始业务码存扩展 ----
   * 各 HAPI 版本内置的 endpoint-status / detectedissue-status 码表并不一致（实测
   * 公共 baseR4 接受 error/off 却拒绝 failed/draft）。这里只使用「R4 规范定义、
   * 且实测各服务端普遍接受」的码，业务状态本身由扩展承载并在读回时还原，
   * 因此既不违反规范，也不依赖某台服务器的具体码表。 */
  var BIZ_STATUS = {
    Endpoint: {
      standard: { active: 'active', error: 'entered-in-error', off: 'entered-in-error' },
      fallback: 'active',
      extKey: 'connStatus'
    },
    DetectedIssue: {
      standard: { preliminary: 'final', open: 'final', rejected: 'registered',
        mitigated: 'registered', handled: 'registered' },
      fallback: 'final',
      extKey: 'issueStatus'
    }
  };

  function toWire(internal, ctx) {
    var r = deepClone(internal);
    var internalType = r.resourceType;
    var biz = BIZ_STATUS[internalType];

    /* 2) 业务状态先摘出来，标准字段随后只放合法码 */
    if (biz && r.status) {
      addExt(r, BIZ + biz.extKey, r.status, 'valueCode');
      r.status = biz.standard[r.status] || biz.fallback;
    }

    /* 1) R5-only 类型降级为 Basic */
    var wireType = TO_R4[internalType];
    if (wireType) {
      Object.keys(r).forEach(function (k) {
        if (BASIC_ELEMENTS.indexOf(k) >= 0) return;
        addExt(r, SRC + k, r[k]);
        delete r[k];
      });
      r.resourceType = 'Basic';
      // Basic.code 必填：保留原有可读文本，另打分类码
      var code = r.code || {};
      var text = typeof code === 'string' ? code : (code.text || '');
      r.code = { coding: [{ system: MARK + 'basic-class', code: BASIC_CLASS[internalType], display: internalType }] };
      if (text) r.code.text = text;
      delete r.status; // Basic 无 status
      // Basic.which 必填（1..1）：归属到药学部门，目标不存在时省略，避免整单写入失败
      if (ctx && ctx.exists) {
        var org = 'Organization-pharmacy';
        if (ctx.exists('Organization', org)) r.which = { reference: 'Organization/' + org };
      }
    }

    /* 记录内部类型，读回时还原 */
    r.meta = r.meta || {};
    r.meta.tag = (r.meta.tag || []).filter(function (c) { return c.system !== TYPE_CODE; });
    r.meta.tag.push({ system: TYPE_CODE, code: internalType, display: internalType });

    /* 4) 悬空引用处理（引用目标必须已在服务端存在） */
    if (ctx && ctx.exists) dropDanglingRefs(r, ctx);

    /* 3) 日期规范 */
    (DATE_ELEMENTS[internalType] || []).forEach(function (el) {
      if (typeof r[el] === 'string') r[el] = toInstant(r[el]);
    });

    /* 友好 id 的两种落点：
       - meta.tag：所有类型都可写、可按 _tag=system|code 检索（实测各类型均支持），
         作为通用回退键。
       - identifier：FHIR 原生客户端可直接检索，但 R4 的 Provenance 没有该元素
         （实测写入被服务端静默丢弃），故按类型排除。
       注意：公共演示 HAPI 的重复内容判定只看实质内容，仅 id / identifier /
       narrative 不同不会被视为不同资源（实测）。 */
    if (r.id) {
      r.meta.tag = r.meta.tag.filter(function (c) { return c.system !== ID_SYSTEM; });
      r.meta.tag.push({ system: ID_SYSTEM, code: r.id, display: r.id });
      if (!NO_IDENTIFIER[internalType]) {
        r.identifier = r.identifier || [];
        if (!r.identifier.some(function (i) { return i.system === ID_SYSTEM; })) {
          r.identifier.unshift({ system: ID_SYSTEM, value: r.id });
        }
      }
    }
    return r;
  }

  function dropDanglingRefs(node, ctx) {
    if (!node || typeof node !== 'object') return;
    if (Array.isArray(node)) { node.forEach(function (n) { dropDanglingRefs(n, ctx); }); return; }
    Object.keys(node).forEach(function (k) {
      var v = node[k];
      if (v && typeof v === 'object' && typeof v.reference === 'string') {
        var m = /^([A-Za-z]+)\/([^/]+)$/.exec(v.reference);
        if (m && REF_TARGET_TYPES.indexOf(m[1]) >= 0 && !ctx.exists(m[1], m[2])) delete node[k];
        return;
      }
      dropDanglingRefs(v, ctx);
    });
  }

  function fromWire(wire) {
    if (!wire) return wire;
    var r = deepClone(wire);
    var tags = (r.meta && r.meta.tag) || [];
    var tag = tags.filter(function (c) { return c.system === TYPE_CODE; })[0];
    var internalType = tag ? tag.code : r.resourceType;

    if (r.resourceType === 'Basic' && TO_R4[internalType]) {
      var hadCode = false;
      r.extension = (r.extension || []).filter(function (e) {
        if (e.url.indexOf(SRC) !== 0) return true;
        var field = e.url.slice(SRC.length);
        if (field === 'code') hadCode = true;
        r[field] = extValue(e);
        return false;
      });
      r.resourceType = internalType;
      delete r.which;
      // code 是降级时合成的分类载体，原始资源没有它就别还原出来
      if (!hadCode) delete r.code;
    }

    var biz = BIZ_STATUS[internalType];
    if (biz) {
      var bs = (r.extension || []).filter(function (e) { return e.url === BIZ + biz.extKey; })[0];
      if (bs) r.status = extValue(bs);
    }
    return r;
  }

  /* 找回友好 id：identifier 优先（原生客户端可直接检索），其次 meta.tag
     （覆盖 Provenance 这类没有 identifier 元素的类型），最后回落到逻辑 id */
  function wireIdOf(resource) {
    var ids = (resource.identifier || []).filter(function (i) { return i.system === ID_SYSTEM; });
    if (ids.length) return ids[0].value;
    var tags = ((resource.meta || {}).tag || []).filter(function (c) { return c.system === ID_SYSTEM; });
    if (tags.length) return tags[0].code;
    return resource.id;
  }

  global.FHIRR4 = {
    ID_SYSTEM: ID_SYSTEM, TYPE_CODE: TYPE_CODE, TO_R4: TO_R4, BASIC_CLASS: BASIC_CLASS,
    BIZ_STATUS: BIZ_STATUS, NO_IDENTIFIER: NO_IDENTIFIER,
    toInstant: toInstant, toWire: toWire, fromWire: fromWire, wireIdOf: wireIdOf
  };
})(window);
