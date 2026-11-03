/* =====================================================================
 * browser-smoke.js —— 真实浏览器冒烟验证（CDP，无第三方依赖）
 *
 * 为什么需要它：render-test / demo_walkthrough 都跑在 jsdom 里，只能证明
 * 「模板能编译、数据能算对」，证明不了真实浏览器里 Vue 能否挂载、CSS/事件
 * 是否可用、以及浏览器直连 FHIR 服务端写穿是否成功。本脚本用 Chrome
 * DevTools Protocol 驱动真实 Chromium 走一遍关键路径。
 *
 * 用法：
 *   npm start                                  # 另开一个终端（或本脚本自动拉起）
 *   npm run test:browser                        # 默认打本地 HAPI localhost:8081/fhir
 *   FHIR_BASE=… APP_ORIGIN=… CHROME=… npm run test:browser
 * ===================================================================== */
'use strict';
const { spawn, spawnSync } = require('child_process');
const fs = require('fs');
const os = require('os');
const path = require('path');

const APP_ORIGIN = process.env.APP_ORIGIN || 'http://localhost:8137';
const FHIR_BASE = process.env.FHIR_BASE || 'http://localhost:8081/fhir';
const SCOPE = process.env.BROWSER_SCOPE || ('kjywfj-browser-' + Date.now());
const PORT = Number(process.env.CDP_PORT || 9333);
const KEEP = process.env.KEEP === '1';

let pass = 0, fail = 0;
const failures = [];
function ok(cond, msg) {
  if (cond) { pass++; return true; }
  fail++; failures.push(msg); console.log('  ✗ ' + msg);
  return false;
}

function findChrome() {
  const cands = [process.env.CHROME];
  const cache = path.join(os.homedir(), '.cache', 'ms-playwright');
  if (fs.existsSync(cache)) {
    fs.readdirSync(cache).filter(d => /^chromium-/.test(d)).forEach(d => {
      cands.push(path.join(cache, d, 'chrome-linux64', 'chrome'));
      cands.push(path.join(cache, d, 'chrome-linux', 'chrome'));
    });
  }
  ['chromium', 'chromium-browser', 'google-chrome', 'google-chrome-stable'].forEach(bin => {
    const found = spawnSync('which', [bin], { encoding: 'utf8' }).stdout.trim();
    if (found) cands.push(found);
  });
  return cands.filter(Boolean).find(c => fs.existsSync(c)) || null;
}

async function getJson(url, tries = 60) {
  for (let i = 0; i < tries; i++) {
    try {
      const r = await fetch(url);
      if (r.ok) return await r.json();
    } catch (e) { /* 浏览器还没起来 */ }
    await new Promise(r => setTimeout(r, 300));
  }
  throw new Error('拿不到 ' + url + '（Chrome 未就绪？）');
}

class Cdp {
  constructor(ws) {
    this.ws = ws; this.n = 0; this.pending = new Map(); this.listeners = [];
    ws.onmessage = (ev) => {
      const m = JSON.parse(ev.data);
      if (m.id && this.pending.has(m.id)) {
        const { res, rej } = this.pending.get(m.id); this.pending.delete(m.id);
        m.error ? rej(new Error(m.error.message)) : res(m.result);
      } else this.listeners.forEach(fn => fn(m));
    };
  }
  static open(url) {
    return new Promise((res, rej) => {
      const ws = new WebSocket(url);
      ws.onopen = () => res(new Cdp(ws));
      ws.onerror = (e) => rej(new Error('CDP 连接失败：' + (e.message || e.type)));
    });
  }
  send(method, params) {
    const id = ++this.n;
    return new Promise((res, rej) => {
      this.pending.set(id, { res, rej });
      this.ws.send(JSON.stringify({ id, method, params: params || {} }));
      setTimeout(() => {
        if (this.pending.has(id)) { this.pending.delete(id); rej(new Error(method + ' 超时')); }
      }, 60000);
    });
  }
  on(fn) { this.listeners.push(fn); }
}

/* 在页面里执行表达式；抛异常就当失败，绝不静默返回 undefined */
async function evalJs(cdp, expression) {
  const r = await cdp.send('Runtime.evaluate', { expression, returnByValue: true, awaitPromise: true });
  if (r.exceptionDetails) {
    const d = r.exceptionDetails;
    throw new Error('页面执行异常：' + ((d.exception && d.exception.description) || d.text));
  }
  return r.result.value;
}

const wait = ms => new Promise(r => setTimeout(r, ms));

(async function main() {
  const CHROME = findChrome();
  if (!CHROME) {
    console.error('找不到可用的 Chromium/Chrome。设置 CHROME=/path/to/chrome 后重试。');
    process.exit(3);
  }
  console.log('浏览器：' + CHROME);

  /* 静态服务器：没人在跑就自己拉一个 */
  let app = null;
  try { await fetch(APP_ORIGIN + '/index.html'); }
  catch (e) {
    app = spawn('python3', ['-m', 'http.server', String(new URL(APP_ORIGIN).port)], { stdio: 'ignore', cwd: __dirname + '/..' });
    await wait(1200);
  }

  const profile = fs.mkdtempSync(path.join(os.tmpdir(), 'kjywfj-chrome-'));
  const chrome = spawn(CHROME, [
    '--headless=new', '--disable-gpu', '--no-sandbox', '--no-first-run',
    '--remote-debugging-port=' + PORT, '--user-data-dir=' + profile, 'about:blank'
  ], { stdio: 'ignore' });

  let cdp = null, pageErrors = [];
  try {
    await getJson(`http://127.0.0.1:${PORT}/json/version`);
    const targets = await getJson(`http://127.0.0.1:${PORT}/json/list`);
    const page = targets.find(t => t.type === 'page' && t.webSocketDebuggerUrl);
    if (!page) throw new Error('没有可用的页面 target');
    cdp = await Cdp.open(page.webSocketDebuggerUrl);
    await cdp.send('Runtime.enable'); await cdp.send('Page.enable'); await cdp.send('Log.enable');
    cdp.on(m => {
      if (m.method === 'Runtime.exceptionThrown') {
        const d = m.params.exceptionDetails;
        pageErrors.push(((d.exception && d.exception.description) || d.text || '').split('\n')[0]);
      } else if (m.method === 'Log.entryAdded' && m.params.entry.level === 'error') {
        pageErrors.push(m.params.entry.text);
      } else if (m.method === 'Runtime.consoleAPICalled' && m.params.type === 'error') {
        pageErrors.push((m.params.args || []).map(a => a.value || a.description || '').join(' '));
      }
    });

    const url = APP_ORIGIN + '/index.html?fhir=' + encodeURIComponent(FHIR_BASE) + '&scope=' + SCOPE;
    console.log('打开：' + url);
    await cdp.send('Page.navigate', { url });

    /* 1. Vue 挂载 + 真实服务端装载/写穿 */
    let stats = null;
    for (let i = 0; i < 100; i++) {
      await wait(1000);
      stats = await evalJs(cdp, `(function(){
        if (!window.App || !window.FHIR || !App._vm) return null;
        var s = FHIR.stats();
        if (s.status !== 'ready') return null;
        s.counts = { Medication: FHIR.count('Medication'), Patient: FHIR.count('Patient'), Task: FHIR.count('Task') };
        return s;
      })()`);
      if (stats && (stats.queued + stats.inflight) === 0) break;
    }
    ok(!!stats, '应用未在真实浏览器里完成启动（Vue 未挂载或装载未 ready）');
    if (!stats) throw new Error('启动失败：' + pageErrors.join(' | '));
    ok(stats.mode === 'remote', '应按配置连到 ' + FHIR_BASE + '，实际模式 ' + stats.mode);
    ok(stats.pushed > 0 || stats.loadedCount > 0, '服务端数据既没读到也没写入：' + JSON.stringify(stats));
    ok(stats.failed === 0, '浏览器直连服务端的写穿失败 ' + stats.failed + ' 条：' + JSON.stringify(stats.errors));
    ok(stats.counts.Medication >= 30 && stats.counts.Patient >= 6 && stats.counts.Task >= 28,
      '本地镜像资源数不对：' + JSON.stringify(stats.counts));
    console.log('  装载：读回 ' + stats.loadedCount + ' 条 / 写入 ' + stats.pushed + ' 条 / 失败 ' + stats.failed + ' 条');

    /* 2. 导航栏渲染 + 真实点击切换页面 */
    const shell = await evalJs(cdp, `(function(){
      var root = document.querySelector('#app');
      return { text: root.innerText, navItems: document.querySelectorAll('.nav-item').length, links: document.querySelectorAll('.nav-item a').length };
    })()`);
    ok(shell.navItems >= 2 && shell.links >= 5, '导航没有按当前身份渲染：nav-item=' + shell.navItems + '，link=' + shell.links);
    ok(shell.text.length > 200, '首页正文为空（length=' + shell.text.length + '）');
    let navClicks = 0;

    for (const route of ['grade-rules', 'workflow-designer', 'order-demo', 'approval-center', 'demo-data', 'mobile-approval']) {
      const info = await evalJs(cdp, `(function(){
        var def = (Domain.pageByRoute('${route}') || {}).page || {};
        var link = Array.prototype.slice.call(document.querySelectorAll('.nav-item a'))
          .filter(function (a) { return a.textContent.trim() === def.name; })[0];
        if (link) link.click(); else App.navigate('${route}');
        return { clicked: !!link, route: App.state.route };
      })()`);
      await wait(700);
      const body = await evalJs(cdp, `document.querySelector('#app').innerText`);
      ok(info.route === '${route}' && body.length > 60,
        '页面没能打开或正文为空：${route}（route=' + info.route + '，text=' + body.length + '）');
      if (info.clicked) navClicks++;
    }
    ok(navClicks >= 4, '多数页面不是靠真实点击导航的（点中 ' + navClicks + ' 个）');

    /* 3. 身份切换（真实 select change 事件） */
    const sw = await evalJs(cdp, `(function(){
      var sel = document.querySelector('select.identity-pick');
      if (!sel) return { found: false };
      sel.value = 'id-doctor-low';
      sel.dispatchEvent(new Event('change'));
      return { found: true, identity: App.state.identityId, user: App.currentUser().display };
    })()`);
    await wait(500);
    ok(sw.found, '演示身份下拉框没有渲染，无法验证多身份切换');
    ok(sw.identity === 'id-doctor-low', '身份未切换：' + sw.identity);
    ok(/王伟/.test(sw.user || ''), '切换后的用户不对：' + sw.user);

    /* 4. 在真实浏览器里跑一次业务写入（开单 → 触发审批 → 写穿服务端） */
    const order = await evalJs(cdp, `(function(){
      return Promise.resolve(Svc.srs.submitOrder({
        practitionerId: App.currentUser().practitioner, medicationId: 'Medication-21',
        patientId: 'Patient-1', encounterId: 'Encounter-1', patientName: '陈秀英', mrn: 'ZY20260615001',
        diagnosis: '肺炎', purposeCode: 'mdr', purposeNote: '浏览器冒烟', dosageText: '1g q8h', reason: '浏览器冒烟验证'
      })).then(function(o){
        return FHIR.flush().then(function(s){ return { mode: o.mode, id: o.instance && o.instance.id, failed: s.failed, errors: s.errors }; });
      });
    })()`);
    ok(order.mode === 'approval', '权限不足的医师开单应触发审批，实际 ' + order.mode);
    ok(order.failed === 0, '浏览器内业务写入失败 ' + order.failed + ' 条：' + JSON.stringify(order.errors));
    const readBack = await evalJs(cdp, `fetch('${FHIR_BASE}/Task/${order.id}', { headers: { Accept: 'application/fhir+json' } })
      .then(function (r) { return r.status; })`);
    ok(readBack === 200, '审批实例没能落到服务端（HTTP ' + readBack + '）');

    /* 5. 页面自身不得有未捕获异常 */
    const realErrors = pageErrors.filter(t => !/favicon/i.test(t));
    ok(realErrors.length === 0, '浏览器控制台有报错：' + realErrors.slice(0, 3).join(' | '));
  } finally {
    chrome.kill(); if (app) app.kill();
    if (!KEEP) {
      console.log('\n清理浏览器冒烟写入的数据（scope=' + SCOPE + '）…');
      const r = spawnSync('python3', [__dirname + '/../scripts/clean_demo_data.py',
        '--base', FHIR_BASE, '--scope', SCOPE, '--yes'], { encoding: 'utf8' });
      console.log((r.stdout || '').trim().split('\n').slice(-2).join('\n') || ('清理退出码 ' + r.status));
    }
    fs.rmSync(profile, { recursive: true, force: true });
    if (cdp) cdp.ws.close();
  }

  console.log('\n==== 结果：通过 ' + pass + ' 项，失败 ' + fail + ' 项 ====');
  if (fail) console.error('失败明细：\n - ' + failures.join('\n - '));
  process.exit(fail ? 1 : 0);
})().catch(e => { console.error('\n测试异常：' + (e && e.stack || e)); process.exit(2); });
