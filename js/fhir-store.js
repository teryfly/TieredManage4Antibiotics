/* =====================================================================
 * fhir-store.js —— 轻量级 FHIR 内存资源库（模拟 FHIR REST 服务）
 * ---------------------------------------------------------------------
 * 提供类 FHIR RESTful 的 CRUD 接口（create / read / update / delete /
 * search），所有数据保存在浏览器内存（缓存）中。资源遵循 FHIR R5 资源
 * 模型（Medication / Practitioner / Patient / Task / ClinicalUseDefinition
 * / Citation / Permission / PlanDefinition / DetectedIssue / MeasureReport
 * / Communication / Provenance / Endpoint / Organization 等）。
 *
 * 该库不依赖任何框架，挂载到 window.FHIR。
 * ===================================================================== */
(function (global) {
  'use strict';

  function nowISO() {
    // 演示用固定“当前时间”，与文档中的 2026-06 数据保持一致
    return new Date().toISOString();
  }

  function deepClone(obj) {
    return obj == null ? obj : JSON.parse(JSON.stringify(obj));
  }

  var db = {};        // resourceType -> { id -> resource }
  var counters = {};  // resourceType -> number
  var listeners = []; // 变更订阅者（用于 UI 响应式刷新）

  function ensure(type) {
    if (!db[type]) db[type] = {};
    return db[type];
  }

  // 写入前：将友好的 ext 投影编码为标准 FHIR extension/modifierExtension，
  // 并从资源上移除非标准的 ext 字段，使内部存储为纯 FHIR 资源。
  function toCanonical(resource) {
    var r = deepClone(resource);
    var ext = r.ext; delete r.ext;
    delete r.extension; delete r.modifierExtension;
    if (global.FHIRExt && ext) {
      var enc = global.FHIRExt.encode(r.resourceType, ext);
      if (enc.extension.length) r.extension = enc.extension;
      if (enc.modifierExtension.length) r.modifierExtension = enc.modifierExtension;
    }
    return r;
  }

  // 读取时：在纯 FHIR 资源上解码出友好的 ext 投影，便于上层使用。
  function materialize(canonical) {
    if (!canonical) return canonical;
    var r = deepClone(canonical);
    if (global.FHIRExt) r.ext = global.FHIRExt.decode(r.resourceType, r);
    return r;
  }

  function nextId(type) {
    counters[type] = (counters[type] || 0) + 1;
    return type + '-' + String(counters[type]).padStart(4, '0');
  }

  function emit(evt) {
    listeners.forEach(function (fn) {
      try { fn(evt); } catch (e) { console.error('FHIR listener error', e); }
    });
  }

  var FHIR = {
    /* 订阅资源变更，返回取消订阅函数 */
    subscribe: function (fn) {
      listeners.push(fn);
      return function () {
        var i = listeners.indexOf(fn);
        if (i >= 0) listeners.splice(i, 1);
      };
    },

    /* 直接植入资源（带 id），用于种子数据初始化，不触发事件 */
    seed: function (resource) {
      var type = resource.resourceType;
      ensure(type);
      if (!resource.id) resource.id = nextId(type);
      // 维持 counter 单调递增，避免后续生成 id 冲突
      var m = /-(\d+)$/.exec(resource.id);
      if (m) counters[type] = Math.max(counters[type] || 0, parseInt(m[1], 10));
      var canonical = toCanonical(resource);
      canonical.meta = resource.meta || {};
      canonical.meta.versionId = canonical.meta.versionId || '1';
      canonical.meta.lastUpdated = canonical.meta.lastUpdated || nowISO();
      db[type][canonical.id] = canonical;
      return materialize(canonical);
    },

    /* FHIR: create —— POST [base]/{type} */
    create: function (resource) {
      var type = resource.resourceType;
      if (!type) throw new Error('resourceType 缺失');
      ensure(type);
      if (!resource.id) resource.id = nextId(type);
      var canonical = toCanonical(resource);
      canonical.meta = { versionId: '1', lastUpdated: nowISO() };
      db[type][canonical.id] = canonical;
      emit({ action: 'create', resourceType: type, id: canonical.id, resource: deepClone(canonical) });
      return materialize(canonical);
    },

    /* FHIR: read —— GET [base]/{type}/{id}（返回带 ext 投影的资源） */
    read: function (type, id) {
      return db[type] && db[type][id] ? materialize(db[type][id]) : undefined;
    },

    /* 读取纯 FHIR 资源（不含 ext 投影，仅 extension/modifierExtension）——
     * 供 FHIR 资源查看器展示规范化形态 */
    canonical: function (type, id) {
      return db[type] && db[type][id] ? deepClone(db[type][id]) : undefined;
    },
    canonicalAll: function (type) {
      return db[type] ? Object.keys(db[type]).map(function (k) { return deepClone(db[type][k]); }) : [];
    },
    types: function () { return Object.keys(db).sort(); },

    /* FHIR: update —— PUT [base]/{type}/{id} */
    update: function (resource) {
      var type = resource.resourceType, id = resource.id;
      if (!type || !id) throw new Error('update 需要 resourceType 与 id');
      ensure(type);
      var prev = db[type][id];
      var ver = prev && prev.meta ? String(parseInt(prev.meta.versionId || '1', 10) + 1) : '1';
      var canonical = toCanonical(resource);
      canonical.meta = { versionId: ver, lastUpdated: nowISO() };
      db[type][id] = canonical;
      emit({ action: 'update', resourceType: type, id: id, resource: deepClone(canonical) });
      return materialize(canonical);
    },

    /* FHIR: patch —— 局部更新（合并字段） */
    patch: function (type, id, partial) {
      var cur = this.read(type, id);
      if (!cur) throw new Error('资源不存在: ' + type + '/' + id);
      Object.assign(cur, partial);
      return this.update(cur);
    },

    /* FHIR: delete —— DELETE [base]/{type}/{id} */
    remove: function (type, id) {
      if (db[type] && db[type][id]) {
        var res = db[type][id];
        delete db[type][id];
        emit({ action: 'delete', resourceType: type, id: id, resource: deepClone(res) });
        return true;
      }
      return false;
    },

    /* FHIR: search —— GET [base]/{type}?...
     * predicate 为可选过滤函数 (resource) => boolean
     * 返回资源数组（已克隆） */
    search: function (type, predicate) {
      var coll = db[type] ? Object.keys(db[type]).map(function (k) { return materialize(db[type][k]); }) : [];
      if (predicate) coll = coll.filter(predicate);
      return coll;
    },

    /* 返回某类型资源数量 */
    count: function (type, predicate) {
      return this.search(type, predicate).length;
    },

    /* 以 Bundle 形式返回（更贴近 FHIR searchset 语义） */
    bundle: function (type, predicate) {
      var entries = this.search(type, predicate);
      return {
        resourceType: 'Bundle',
        type: 'searchset',
        total: entries.length,
        entry: entries.map(function (r) {
          return { fullUrl: type + '/' + r.id, resource: r };
        })
      };
    },

    /* 调试用：导出全部数据 */
    dump: function () { return deepClone(db); },
    reset: function () { db = {}; counters = {}; }
  };

  global.FHIR = FHIR;
})(window);
