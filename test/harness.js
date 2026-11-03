/* =====================================================================
 * harness.js —— 无浏览器环境下装载本系统数据层的公共垫片
 * ---------------------------------------------------------------------
 * 数据层是纯经典脚本（IIFE 挂到 window），不依赖 DOM，因此只需要一个最小
 * window 垫片就能在 Node 里跑起来。scripts/export_seed.js 与三个测试共用它，
 * 避免「测试里各写一份加载逻辑」导致的路径/顺序漂移。
 * ===================================================================== */
'use strict';
const fs = require('fs');
const path = require('path');

const ROOT = path.join(__dirname, '..');

/* 与 index.html 一致的数据层加载顺序 */
const DATA_FILES = [
  'js/config.js', 'js/fhir-r4.js', 'js/fhir-client.js', 'js/fhir-store.js',
  'js/fhir-ext.js', 'js/domain.js', 'js/clock.js', 'js/approval.js',
  'js/fhir-profiles.js', 'js/seed.js', 'js/services.js'
];

function makeWindow(opts) {
  opts = opts || {};
  const store = {};
  if (opts.config) store['amr-fhir-config'] = JSON.stringify(opts.config);
  const win = {
    location: { protocol: 'http:', search: opts.search || '', hash: opts.hash || '', href: 'http://localhost/', reload() {} },
    localStorage: {
      getItem: k => (k in store ? store[k] : null),
      setItem: (k, v) => { store[k] = String(v); },
      removeItem: k => { delete store[k]; }
    },
    addEventListener() {}, removeEventListener() {}, scrollTo() {},
    fetch: global.fetch, AbortController: global.AbortController, URLSearchParams: global.URLSearchParams,
    setTimeout, clearTimeout, setInterval, clearInterval, queueMicrotask,
    console, Date, JSON, Math, Object, Array, String, Number, Boolean, RegExp, Error, Promise, Set, Map, isFinite, parseInt, parseFloat, encodeURIComponent, decodeURIComponent
  };
  win.window = win;
  win.global = win;
  return win;
}

function loadInto(win, files) {
  (files || DATA_FILES).forEach(rel => {
    const code = fs.readFileSync(path.join(ROOT, rel), 'utf8');
    /* eslint-disable no-new-func */
    new Function('window', 'global', 'location', 'localStorage', 'fetch', 'AbortController',
      'URLSearchParams', 'console', 'setTimeout', 'clearTimeout', 'setInterval', 'clearInterval', code)(
      win, win, win.location, win.localStorage, win.fetch, win.AbortController,
      win.URLSearchParams, win.console, win.setTimeout, win.clearTimeout, win.setInterval, win.clearInterval);
  });
  return win;
}

/* 页面/引擎在没有登录界面时（种子、脚本、测试）用的操作人替身 */
function stubApp(win, identityId) {
  const D = win.Domain;
  const id = D.identity(identityId) || D.identity('id-ruleadmin');
  win.App = {
    state: { roleCode: id.role, identityId: id.id, refresh: 0 },
    currentUser: () => D.identity(win.App.state.identityId) || id,
    switchIdentity(nid) { win.App.state.identityId = nid; win.App.state.roleCode = D.identity(nid).role; },
    toast() {}, bump() {}, navigate() {}
  };
  return win.App;
}

function boot(opts) {
  const win = makeWindow(opts);
  loadInto(win, opts && opts.files);
  stubApp(win, opts && opts.as);
  return win;
}

module.exports = { ROOT, DATA_FILES, makeWindow, loadInto, stubApp, boot };
