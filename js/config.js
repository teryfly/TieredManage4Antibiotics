/* =====================================================================
 * config.js —— 运行时配置（HAPI FHIR 服务端地址可配置）
 * ---------------------------------------------------------------------
 * 本分支把数据层从浏览器内存接到真实 FHIR R4 服务端。服务端地址不写死在
 * 源码里（改地址不该重新打包），按以下优先级解析，高优先级覆盖低优先级：
 *   1. URL 查询参数        ?fhir=https://my-host/fhir/baseR4&mode=local
 *   2. localStorage        用户在「FHIR 服务端」设置弹框里保存的值
 *   3. fhir-config.json    部署方改这一个文件即可，无需改源码（仅 http/https 下可读）
 *   4. DEFAULTS           https://hapi.fhir.org/baseR4
 * ===================================================================== */
(function (global) {
  'use strict';

  var LS_KEY = 'amr-fhir-config';

  var DEFAULTS = {
    fhirBase: 'https://hapi.fhir.org/baseR4',
    mode: 'remote',          // remote=读写穿透到 FHIR 服务端 | local=纯内存演示（等价 main 分支）
    autoSeed: true,          // 服务端无本系统数据时，自动写入初始基础数据
    persistUsageRecords: false, // 4870 条用药记录是否落服务端；公共演示服务器上建议关闭
    requestTimeoutMs: 20000
  };

  function normalizeBaseUrl(u) {
    return String(u || '').trim().replace(/\/+$/, '');
  }

  // 仅允许 http/https，避免把 javascript: 之类协议写进配置后被拼接请求
  function isSafeBaseUrl(u) {
    return /^https?:\/\/[^\s]+$/i.test(u);
  }

  function queryString() {
    var s = global.location.search || '';
    var h = global.location.hash || '';
    var i = h.indexOf('?');
    if (i >= 0) s += (s ? '&' : '?') + h.slice(i + 1);
    return s;
  }

  function fromUrlParam() {
    var qs = new URLSearchParams(queryString());
    var out = {};
    if (qs.get('fhir')) out.fhirBase = normalizeBaseUrl(qs.get('fhir'));
    if (qs.get('mode')) out.mode = qs.get('mode') === 'local' ? 'local' : 'remote';
    return out;
  }

  function fromStorage() {
    try { return JSON.parse(global.localStorage.getItem(LS_KEY) || '{}') || {}; } catch (_) { return {}; }
  }

  function persist(patch) {
    try {
      var next = Object.assign({}, fromStorage(), patch);
      global.localStorage.setItem(LS_KEY, JSON.stringify(next));
    } catch (_) { /* 隐私模式下写入失败不影响运行 */ }
  }

  var state = Object.assign({}, DEFAULTS);
  var loaded = false;
  var fileOverlay = {};

  var Config = {
    DEFAULTS: DEFAULTS,
    LS_KEY: LS_KEY,

    /* 读取 fhir-config.json（部署方可改）。失败则沿用默认值，不阻塞启动。 */
    load: function () {
      if (loaded) return Promise.resolve(state);
      loaded = true;
      var canFetchFile = /^https?:$/.test(global.location.protocol) && typeof global.fetch === 'function';
      var p = canFetchFile
        ? fetch('fhir-config.json', { cache: 'no-store' })
            .then(function (r) { return r.ok ? r.json() : {}; })
            .then(function (j) { fileOverlay = j || {}; })
            .catch(function () { fileOverlay = {}; })
        : Promise.resolve();
      return p.then(function () {
        apply([fileOverlay, fromStorage(), fromUrlParam()]);
        return state;
      });
    },

    get: function (k) { return state[k]; },
    all: function () { return Object.assign({}, state); },

    isRemote: function () { return state.mode === 'remote' && isSafeBaseUrl(state.fhirBase); },
    baseUrl: function () { return normalizeBaseUrl(state.fhirBase); },

    /* UI 保存设置 */
    set: function (patch) {
      var next = {};
      if ('fhirBase' in patch) {
        var u = normalizeBaseUrl(patch.fhirBase);
        if (!isSafeBaseUrl(u)) return Promise.reject(new Error('服务端地址须以 http:// 或 https:// 开头'));
        next.fhirBase = u;
      }
      if ('mode' in patch) next.mode = patch.mode === 'local' ? 'local' : 'remote';
      if ('persistUsageRecords' in patch) next.persistUsageRecords = !!patch.persistUsageRecords;
      if ('autoSeed' in patch) next.autoSeed = !!patch.autoSeed;
      persist(next);
      Object.assign(state, next);
      return Promise.resolve(state);
    },

    reset: function () {
      try { global.localStorage.removeItem(LS_KEY); } catch (_) {}
      Object.assign(state, DEFAULTS, fileOverlay, fromUrlParam());
      return state;
    }
  };

  function apply(overlays) {
    overlays.forEach(function (o) {
      Object.keys(o).forEach(function (k) {
        if (!(k in DEFAULTS)) return;
        var v = o[k];
        if (v == null || v === '') return;
        if (k === 'fhirBase') {
          var u = normalizeBaseUrl(v);
          if (isSafeBaseUrl(u)) state.fhirBase = u;
        } else if (k === 'mode') {
          state.mode = v === 'local' ? 'local' : 'remote';
        } else if (k === 'persistUsageRecords' || k === 'autoSeed') {
          state[k] = !!v;
        } else {
          state[k] = v;
        }
      });
    });
  }

  global.AmrConfig = Config;
})(window);
