/* =====================================================================
 * fhir-client.js —— FHIR R4 REST 客户端（纯 HTTP，不持有状态）
 * ---------------------------------------------------------------------
 * 约定：
 *   - 写入一律用 PUT [base]/{type}/{id}。实测 POST 会忽略客户端自带的 id 并
 *     另发数字 id，本系统大量使用语义化 id（Basic-catalog-version、
 *     Permission-map-special、Practitioner-9003）作为引用与读取键，必须保留。
 *   - 所有请求带超时中止，避免服务端不可达时界面卡在半路。
 *   - 服务端返回 OperationOutcome 时，抽取 HAPI 错误码与说明，抛成可读的 Error。
 * ===================================================================== */
(function (global) {
  'use strict';

  var PAGE_SIZE = 100;

  function apiError(status, outcome) {
    var issues = (outcome && outcome.issue) || [];
    // HAPI 的说明文字可能出现在 details.text 或 diagnostics（单复数容易看漏，
    // 漏掉就只能看到 "HTTP 400"，服务端拒绝原因就查不出来了）
    var text = issues.map(function (i) {
      var t = (i.details && i.details.text) || i.diagnostics || i.diagnostic || '';
      var expr = (i.expression || []).join(',');
      return t + (expr ? ' @' + expr : '');
    }).filter(Boolean).join('; ') || ('HTTP ' + status);
    text = text.replace(/&quot;/g, '"');
    var e = new Error(text);
    e.status = status;
    e.hapiCode = (/HAPI-\d+/).exec(text);
    e.hapiCode = e.hapiCode ? e.hapiCode[0] : null;
    e.outcome = outcome;
    return e;
  }

  function request(method, url, body, opts) {
    opts = opts || {};
    var ctl = new AbortController();
    var ms = opts.timeout || 20000;
    var timer = setTimeout(function () { ctl.abort(); }, ms);
    var init = {
      method: method,
      signal: ctl.signal,
      headers: { 'Content-Type': 'application/fhir+json', 'Accept': 'application/fhir+json' }
    };
    if (body !== undefined) init.body = typeof body === 'string' ? body : JSON.stringify(body);
    return fetch(url, init).then(function (r) {
      return r.text().then(function (t) {
        var json = null;
        try { json = t ? JSON.parse(t) : null; } catch (_) { /* 非 JSON 响应 */ }
        if (!r.ok) throw apiError(r.status, json);
        return json;
      });
    }).catch(function (e) {
      if (e && e.name === 'AbortError') { var t = new Error('请求超时（' + ms + 'ms）：' + url); t.timeout = true; throw t; }
      if (e instanceof TypeError) { var n = new Error('无法连接 FHIR 服务端（网络或跨域被拒）：' + url); n.unreachable = true; throw n; }
      throw e;
    }).finally(function () { clearTimeout(timer); });
  }

  /* CapabilityStatement → 支持性摘要。缺 rest 或缺类型都算不支持，
   * 界面据此显示「服务端不支持」而不是假装写入成功（SRS §10.2）。 */
  function summarizeSupport(md) {
    var rest = (md && md.rest && md.rest[0]) || {};
    var types = {};
    (rest.resource || []).forEach(function (r) {
      var inter = {};
      (r.interaction || []).forEach(function (i) { inter[i.code] = true; });
      var params = {};
      (r.searchParam || []).forEach(function (p) { if (p.name) params[p.name] = true; });
      types[r.type] = { interactions: inter, searchParams: params };
    });
    return {
      fhirVersion: (md && md.fhirVersion) || '',
      software: ((md && md.software) || {}).name || '',
      system: (rest.interaction || []).map(function (i) { return i.code; }),
      types: types,
      has: function (type) { return !!types[type]; },
      can: function (type, interaction) {
        return !!(types[type] && types[type].interactions[interaction]);
      },
      canSearch: function (type, param) {
        return !!(types[type] && types[type].searchParams[param]);
      }
    };
  }

  var Client = {
    PAGE_SIZE: PAGE_SIZE,

    /* 服务端能力：确认可达且为 FHIR R4，并解析 SRS §10.2 要求的
     * 「逐资源类型 / 逐 RESTful interaction」支持性清单。 */
    capabilities: function (base, opts) {
      return request('GET', base + '/metadata', undefined, opts).then(function (md) {
        var v = (md && md.fhirVersion) || '';
        if (v && !/^4\./.test(v)) {
          var e = new Error('服务端 FHIR 版本为 ' + v + '，本分支要求 R4（4.x）');
          e.versionMismatch = true;
          throw e;
        }
        md.supported = summarizeSupport(md);
        return md;
      });
    },

    /* 把 CapabilityStatement 压成 {types:{Task:{create:true,read:true,...}}, system:[...]} ；
     * 服务端不支持的类型/交互要能在界面上显式显示，不得假装写入成功。 */
    summarizeSupport: summarizeSupport,

    /* 按语义化 id 写入（新建或整体更新） */
    put: function (base, type, id, resource, opts) {
      return request('PUT', base + '/' + type + '/' + encodeURIComponent(id), resource, opts);
    },

    /* 事务 Bundle（SRS §10.5）：一次 POST 到服务根，entry 之间用 urn:uuid: 互相引用 */
    transaction: function (base, bundle, opts) {
      return request('POST', base, bundle, opts);
    },

    get: function (base, type, id, opts) {
      return request('GET', base + '/' + type + '/' + encodeURIComponent(id), undefined, opts);
    },

    remove: function (base, type, id, opts) {
      return request('DELETE', base + '/' + type + '/' + encodeURIComponent(id), undefined, opts);
    },

    /* 按 identifier=system|value 反查（仅支持 identifier 元素的类型可用） */
    byIdentifier: function (base, type, system, value, opts) {
      var q = 'identifier=' + encodeURIComponent(system + '|' + value) + '&_count=1';
      return request('GET', base + '/' + type + '?' + q, undefined, opts);
    },

    /* 按 meta.tag 反查：_tag 在 R4 全部类型上都可用，包括没有 identifier 元素的
     * Provenance，因此是本系统找回语义化 id 的通用手段 */
    byTag: function (base, type, system, code, opts) {
      var q = '_tag=' + encodeURIComponent(system + '|' + code) + '&_count=1';
      return request('GET', base + '/' + type + '?' + q, undefined, opts);
    },

    /* 全量取回某类型资源，跟随 Bundle.link 翻页 */
    fetchAll: function (base, type, opts) {
      opts = opts || {};
      var out = [];
      function step(url) {
        return request('GET', url, undefined, opts).then(function (b) {
          (b && b.entry ? b.entry : []).forEach(function (e) { if (e.resource) out.push(e.resource); });
          var next = ((b && b.link) || []).filter(function (l) { return l.relation === 'next'; })[0];
          if (next && next.url) return step(next.url);
          return out;
        });
      }
      /* 不带 _sort：实测 HAPI 8.12 对 `_sort=_id` 会返回空结果集；
       * 预取本来就是按 id 归档进镜像，顺序无关紧要 */
      return step(base + '/' + type + '?_count=' + PAGE_SIZE);
    },

    /* 按 meta.tag 全量取回（清理脚本与「演示数据管理」页统计用） */
    fetchAllByTag: function (base, type, system, code, opts) {
      opts = opts || {};
      var out = [];
      var q = '_tag=' + encodeURIComponent(system + '|' + code) + '&_count=' + PAGE_SIZE;
      function step(url) {
        return request('GET', url, undefined, opts).then(function (b) {
          (b && b.entry ? b.entry : []).forEach(function (e) { if (e.resource) out.push(e.resource); });
          var next = ((b && b.link) || []).filter(function (l) { return l.relation === 'next'; })[0];
          if (next && next.url) return step(next.url);
          return out;
        });
      }
      return step(base + '/' + type + '?' + q);
    },

    /* 单次搜索（供连通性测试展示数量） */
    count: function (base, type, opts) {
      return request('GET', base + '/' + type + '?_count=1', undefined, opts)
        .then(function (b) { return (b && b.total) || (b && b.entry ? b.entry.length : 0); });
    }
  };

  global.FHIRClient = Client;
})(window);
