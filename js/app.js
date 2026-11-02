/* =====================================================================
 * app.js —— 应用引导：根组件（导航壳）、路由、角色切换、全局工具
 * ===================================================================== */
(function (global) {
  'use strict';
  var Vue = global.Vue, D = global.Domain, Svc = global.Svc;
  // AMS 注册表为共享对象：app.js 先创建，common.js 与各页面组件随后填充同一对象
  var AMS = global.AMS = global.AMS || { components: {}, pages: {} };

  var App = global.App = {
    _vm: null,
    state: Vue.reactive({
      roleCode: 'doctor',     // 默认以“医师”身份进入，便于演示申请→审批主流程
      route: 'home',
      refresh: 0,
      toasts: [],
      showNotif: false,
      showUserMenu: false,
      showFhir: false,
      showServer: false,      // FHIR 服务端设置弹框
      boot: { phase: 'idle', error: null, stats: null },
      sync: null
    }),
    currentUser: function () {
      var rc = this.state.roleCode;
      return D.DEMO_USERS.filter(function (u) { return u.role === rc; })[0];
    },
    switchRole: function (rc) {
      this.state.roleCode = rc;
      this.state.showNotif = false;
      // 切换角色后若当前页不可访问则回到首页
      if (this.state.route !== 'home' && !D.canAccess(rc, this.state.route)) {
        this.navigate('home');
      } else {
        this.bump();
      }
      var u = this.currentUser();
      this.toast('已切换为「' + D.roleName(rc) + '」· ' + u.name, 'info');
    },
    navigate: function (route) {
      if (route !== 'home' && !D.canAccess(this.state.roleCode, route)) {
        this.toast('当前角色无权访问该页面', 'error'); return;
      }
      this.state.route = route;
      global.location.hash = route;
      window.scrollTo(0, 0);
    },
    bump: function () { this.state.refresh++; },
    toast: function (msg, type) {
      var id = Date.now() + Math.random();
      this.state.toasts.push({ id: id, msg: msg, type: type || 'success' });
      setTimeout((function () {
        var i = this.state.toasts.findIndex(function (t) { return t.id === id; });
        if (i >= 0) this.state.toasts.splice(i, 1);
      }).bind(this), 2600);
    },

    /* ---------- 启动 / 重连 FHIR 服务端 ---------- */
    reload: function () {
      var st = this.state.boot;
      st.phase = 'connecting'; st.error = null;
      return global.FHIR.bootstrap().then(function (stats) {
        st.stats = stats;
        st.phase = stats.mode === 'local' ? 'local' : 'ready';
        if (stats.pushed) {
          App.toast('服务端无本系统数据，已写入 ' + stats.pushed + ' 条初始资源', 'info');
          App.bump();
        } else if (stats.loadedCount) {
          App.toast('已从 FHIR 服务端读取 ' + stats.loadedCount + ' 条资源', 'info');
          App.bump();
        }
        return stats;
      }).catch(function (err) {
        st.phase = 'failed'; st.error = err.message;
        throw err;
      });
    },

    /* 后端不可达时退回本地演示，避免白屏；数据仍在内存镜像里可继续操作 */
    useLocalFallback: function () {
      global.FHIR.goLocal();
      this.state.boot.phase = 'local';
      this.state.boot.error = null;
      this.bump();
      this.toast('已切换为本地演示模式（数据不落服务端）', 'info');
    },

    /* 改服务端地址/模式后整页重载：重新走一遍「装载 → 探活 → 预取 → 对账」，
     * 比在运行时清空重建镜像更少出错 */
    applyServerConfig: function (patch) {
      var self = this;
      return global.AmrConfig.set(patch).then(function () {
        self.toast('配置已保存，正在重连…', 'info');
        setTimeout(function () { global.location.reload(); }, 400);
      }).catch(function (err) {
        self.toast('配置有误：' + err.message, 'error');
        throw err;
      });
    }
  };

  // 任意 FHIR 资源变更后，刷新当前页面数据；同步进度只更新状态条，
  // 不触发整页重算（预取大数据集时避免反复聚合）
  global.FHIR.subscribe(function (evt) {
    if (evt && evt.action === 'sync') { App.state.sync = evt.stats; return; }
    App.bump();
  });

  var RootComponent = {
    data: function () {
      var cfg = global.AmrConfig.all();
      return {
        fhirType: 'Medication', fhirId: '',
        srv: { base: cfg.fhirBase, mode: cfg.mode, persist: cfg.persistUsageRecords,
               testing: false, ok: false, result: '' }
      };
    },
    computed: {
      boot: function () { return App.state.boot; },
      appReady: function () { var p = App.state.boot.phase; return p === 'ready' || p === 'local'; },
      sync: function () { return App.state.sync || global.FHIR.stats(); },
      serverCfg: function () { return global.AmrConfig.all(); },
      bootText: function () {
        var st = this.sync;
        if (st.status === 'connecting') return '正在连接 FHIR 服务端…';
        if (st.status === 'loading') return '正在读取服务端资源（已载入 ' + st.loadedCount + ' 条）…';
        if (st.pushed) return '服务端为空，正在写入初始基础数据…';
        return '正在装载 FHIR 数据…';
      },
      bootProgress: function () {
        var st = this.sync;
        if (st.status !== 'loading') return 8;
        var total = global.FHIR.remoteTypes().length;
        return Math.max(8, Math.round((st.loadedTypes || 0) / total * 100));
      },
      connPillText: function () {
        var st = this.sync;
        if (st.mode !== 'remote') return '📴 本地演示模式';
        if (st.failed) return '⚠️ ' + st.failed + ' 条写入失败';
        if (st.queued || st.inflight) return '🔄 同步中 ' + (st.done) + '…';
        return '🟢 已连接 FHIR ' + (st.fhirVersion || '');
      },
      connPillClass: function () {
        var st = this.sync;
        return { 'conn-err': st.failed > 0, 'conn-busy': st.mode === 'remote' && (st.queued > 0 || st.inflight > 0), 'conn-off': st.mode !== 'remote' };
      },
      fhirTypes: function () { App.state.refresh; return global.FHIR.types(); },
      fhirList: function () {
        App.state.refresh;
        return global.FHIR.canonicalAll(this.fhirType).map(function (r) {
          var label = (r.code && r.code.text) || (r.name && (r.name[0] ? r.name[0].text : r.name)) || (r.title) || (r.identifier && r.identifier[0] && r.identifier[0].value) || r.id;
          return { id: r.id, label: label };
        });
      },
      fhirCanonical: function () {
        var id = this.fhirId || (this.fhirList[0] && this.fhirList[0].id);
        return id ? JSON.stringify(global.FHIR.canonical(this.fhirType, id), null, 2) : '';
      },
      s: function () { return App.state; },
      user: function () { return App.currentUser(); },
      role: function () { return App.state.roleCode; },
      roles: function () { return D.ROLES; },
      modules: function () { return D.visibleModules(this.role); },
      pageComp: function () { return 'page-' + App.state.route; },
      crumb: function () {
        var pr = D.pageByRoute(App.state.route);
        return pr ? { module: pr.module.name, page: pr.page.name } : null;
      },
      unread: function () { App.state.refresh; return Svc.unreadCount(this.role); },
      notifs: function () { App.state.refresh; return Svc.notifications(this.role); },
      // 仅路由或角色切换时才重建页面组件（重置该页面本地状态，如筛选/分页/弹框）；
      // 页面内部的数据变更由各页面 computed 属性自行订阅 App.state.refresh 驱动重新渲染，
      // 不应绑定 refresh，否则弹框中"保存后继续编辑"（如审批流程节点增删排序）会被强制重建而意外关闭
      pageKey: function () { return App.state.route + '|' + this.role; }
    },
    methods: {
      go: function (r) { App.navigate(r); },
      openServer: function () {
        var cfg = global.AmrConfig.all();
        this.srv.base = cfg.fhirBase; this.srv.mode = cfg.mode;
        this.srv.persist = cfg.persistUsageRecords; this.srv.result = ''; this.srv.ok = false;
        App.state.showServer = true;
      },
      saveServer: function () {
        var self = this;
        return App.applyServerConfig({
          fhirBase: this.srv.base, mode: this.srv.mode, persistUsageRecords: this.srv.persist
        }).catch(function () { self.srv.result = '保存失败'; self.srv.ok = false; });
      },
      testServer: function () {
        var self = this;
        var base = (this.srv.base || '').trim().replace(/\/+$/, '');
        if (!/^https?:\/\/[^\s]+$/i.test(base)) {
          this.srv.ok = false; this.srv.result = '地址须以 http:// 或 https:// 开头';
          return Promise.reject(new Error(this.srv.result));
        }
        this.srv.testing = true; this.srv.result = '';
        return global.FHIR.ping(base).then(function (r) {
          self.srv.testing = false; self.srv.ok = true;
          self.srv.result = '连接成功 · FHIR ' + r.fhirVersion + (r.software ? ' · ' + r.software : '');
        }, function (err) {
          self.srv.testing = false; self.srv.ok = false;
          self.srv.result = '连接失败：' + err.message;
        });
      },
      retryBoot: function () {
        var self = this;
        App.reload().catch(function () { self.toastRetryFail(); });
      },
      toastRetryFail: function () { App.toast('仍然连不上服务端，可改用本地演示模式', 'error'); },
      useLocal: function () { App.useLocalFallback(); },
      switchRole: function (r) { App.switchRole(r); },
      modulePages: function (m) {
        var role = this.role;
        return m.pages.filter(function (p) { return D.pageRoles(p.route).indexOf(role) >= 0; });
      },
      isModuleActive: function (m) {
        var pr = D.pageByRoute(App.state.route);
        return pr && pr.module.code === m.code;
      },
      toggleNotif: function () { App.state.showNotif = !App.state.showNotif; if (App.state.showNotif) App.state.showUserMenu = false; },
      openFhir: function () { App.state.showFhir = true; this.fhirType = 'Medication'; this.fhirId = ''; },
      onFhirType: function () { this.fhirId = ''; },
      readAll: function () { Svc.markAllRead(this.role); App.toast('已全部标为已读'); },
      roleName: D.roleName
    },
    mounted: function () {
      var hash = (global.location.hash || '').replace('#', '');
      if (hash && (hash === 'home' || D.canAccess(App.state.roleCode, hash))) App.state.route = hash;
      window.addEventListener('click', function () { App.state.showUserMenu = false; });
    },
    template: `
    <div>
      <!-- 启动门：连接/装载 FHIR 服务端期间与失败时的处理 -->
      <div v-if="!appReady" class="boot-mask">
        <div class="boot-card">
          <div class="boot-title">💊 抗菌药物分级管理系统 · FHIR R4</div>
          <div v-if="boot.phase==='connecting' || boot.phase==='idle'">
            <div class="boot-step">{{ bootText }}</div>
            <div class="boot-bar"><i :style="{width: bootProgress + '%'}"></i></div>
            <div class="muted">目标服务端：{{ sync.server || serverCfg.fhirBase }}</div>
          </div>
          <div v-else-if="boot.phase==='failed'">
            <div class="boot-step err">⚠️ 无法连接 FHIR 服务端</div>
            <pre class="boot-err">{{ boot.error }}</pre>
            <div class="muted">目标服务端：{{ serverCfg.fhirBase }}</div>
            <div class="boot-acts">
              <button class="btn primary" @click="retryBoot">重试连接</button>
              <button class="btn" @click="openServer">修改服务端地址</button>
              <button class="btn" @click="useLocal">以本地演示模式继续</button>
            </div>
          </div>
        </div>
      </div>

      <template v-else>
      <!-- 顶部导航 -->
      <header class="topbar">
        <div class="topbar-inner">
          <div class="brand"><span class="logo">💊</span> 抗菌药物分级管理系统</div>
          <nav class="nav">
            <div class="nav-item" :class="{active: s.route==='home'}"><a @click="go('home')">首页</a></div>
            <div class="nav-item" v-for="m in modules" :class="{active: isModuleActive(m)}">
              <a>{{ m.name }} ▾</a>
              <div class="nav-dropdown">
                <a v-for="p in modulePages(m)" :class="{active: s.route===p.route}" @click="go(p.route)">{{ p.name }}</a>
              </div>
            </div>
          </nav>
          <div class="topbar-right">
            <div class="bell" @click.stop="toggleNotif">🔔<span class="badge" v-if="unread">{{ unread }}</span></div>
            <div class="user-menu" @click.stop="s.showUserMenu=!s.showUserMenu">
              <span class="avatar">{{ user.name.charAt(0) }}</span>
              <span style="font-size:13px">{{ user.name }}</span>
              <span style="font-size:11px;opacity:.8">▾</span>
            </div>
          </div>
        </div>
        <!-- 通知面板 -->
        <div v-if="s.showNotif" style="position:absolute;right:20px;top:56px;width:340px;background:#fff;border-radius:10px;box-shadow:var(--shadow-lg);z-index:200;color:var(--text)">
          <div class="flex-between" style="padding:12px 16px;border-bottom:1px solid var(--border)">
            <b style="font-size:14px">通知中心</b><a class="btn-link" @click="readAll">全部已读</a>
          </div>
          <div style="max-height:340px;overflow:auto">
            <div v-for="n in notifs" style="padding:11px 16px;border-bottom:1px solid #eef1f5;font-size:13px">
              <div class="flex-between"><span class="tag blue">{{ n.ext.type }}</span><span v-if="n.ext.unread" class="tag red">未读</span></div>
              <div style="margin-top:5px">{{ n.ext.content }}</div>
              <div class="muted" style="font-size:11px;margin-top:3px">{{ n.ext.time }}</div>
            </div>
            <component-empty v-if="!notifs.length"></component-empty>
          </div>
        </div>
        <!-- 用户菜单 -->
        <div v-if="s.showUserMenu" style="position:absolute;right:20px;top:56px;width:240px;background:#fff;border-radius:10px;box-shadow:var(--shadow-lg);z-index:200;color:var(--text);padding:8px">
          <div style="padding:10px 12px;border-bottom:1px solid var(--border)">
            <b>{{ user.display }}</b>
            <div class="muted" style="font-size:12px">{{ user.dept }} · {{ roleName(role) }}</div>
          </div>
          <div style="padding:8px 12px;font-size:12px;color:var(--text-2)">提示：使用顶部黄色「演示角色切换」可一键切换身份，体验完整业务流程。</div>
        </div>
      </header>

      <!-- 演示角色切换条 -->
      <div class="role-switch">
        <div class="role-switch-inner">
          <span class="label">🎭 演示角色切换：</span>
          <span class="role-pill" v-for="r in roles" :class="{active: r.code===role}" @click="switchRole(r.code)">
            {{ r.icon }} {{ r.name }}
          </span>
          <div style="flex:1"></div>
          <span class="role-pill" :class="connPillClass" @click="openServer"
                :title="sync.server || '未连接服务端'">
            {{ connPillText }}
          </span>
          <span class="role-pill" @click="openFhir" title="查看底层 FHIR 标准资源">🔍 FHIR 资源</span>
        </div>
      </div>

      <!-- 页面内容 -->
      <main class="page">
        <div class="breadcrumb" v-if="crumb"><b>{{ crumb.module }}</b> &nbsp;›&nbsp; {{ crumb.page }}</div>
        <component :is="pageComp" :key="pageKey"></component>
      </main>

      <!-- 底部 -->
      <footer class="footer">
        <span>© 2026 抗菌药物分级管理系统 v1.0</span>
        <span>帮助中心 &nbsp;·&nbsp; 意见反馈 &nbsp;·&nbsp; 隐私政策</span>
      </footer>

      <!-- FHIR 资源查看器 -->
      <ui-modal v-if="s.showFhir" title="🔍 FHIR 资源查看器（底层标准资源）" width="wide" @close="s.showFhir=false">
        <div class="alert info" style="margin-bottom:12px"><span>ℹ️</span><div>本系统所有业务数据均以标准 <b>FHIR</b> 资源存储；基础资源无法表达的数据通过 <b>extension / modifierExtension</b> 承载，自定义概念以 <b>Basic</b> 资源 + <b>StructureDefinition</b> 定义。以下为内存库中的规范化资源原文。</div></div>
        <div class="filter-bar" style="margin-bottom:12px">
          <div class="field"><label>资源类型</label>
            <select v-model="fhirType" @change="onFhirType">
              <option v-for="t in fhirTypes" :value="t">{{ t }}</option>
            </select>
          </div>
          <div class="field" style="flex:1"><label>资源实例</label>
            <select v-model="fhirId">
              <option v-for="r in fhirList" :value="r.id">{{ r.id }} · {{ r.label }}</option>
            </select>
          </div>
        </div>
        <pre style="background:#0f1b2d;color:#cfe3ff;padding:14px;border-radius:8px;max-height:50vh;overflow:auto;font-size:12px;line-height:1.5;white-space:pre">{{ fhirCanonical }}</pre>
        <template #foot><button class="btn" @click="s.showFhir=false">关闭</button></template>
      </ui-modal>

      <!-- Toast -->
      <div class="toast-wrap">
        <div v-for="t in s.toasts" class="toast" :class="t.type">{{ t.msg }}</div>
      </div>
      </template>

      <!-- FHIR 服务端设置 -->
      <ui-modal v-if="s.showServer" title="🔌 FHIR 服务端设置" width="wide" @close="s.showServer=false">
        <div class="alert info" style="margin-bottom:12px"><span>ℹ️</span>
          <div>本分支把业务数据读写到真实 <b>FHIR R4</b> 服务端（默认公共演示实例 <code>https://hapi.fhir.org/baseR4</code>）。
          地址优先级：<b>URL 参数 ?fhir=</b> &gt; <b>本弹框保存的值</b> &gt; <b>fhir-config.json</b> &gt; 内置默认。
          公共演示实例<b>无鉴权、数据公开、会被他人读写或定期清空</b>，仅用于验证链路，请勿存放真实患者数据。</div>
        </div>
        <div class="field" style="margin-bottom:12px">
          <label>HAPI FHIR 基地址（须以 http:// 或 https:// 开头，无需 /资源类型）</label>
          <input v-model="srv.base" placeholder="https://hapi.fhir.org/baseR4" style="width:100%">
        </div>
        <div class="kv" style="margin-bottom:12px">
          <span class="k">数据模式</span>
          <span>
            <label style="margin-right:16px"><input type="radio" value="remote" v-model="srv.mode"> 连接服务端（读镜像 + 写穿透）</label>
            <label><input type="radio" value="local" v-model="srv.mode"> 本地演示（纯内存，不发请求）</label>
          </span>
          <span class="k">用药记录落库</span>
          <span>
            <label><input type="checkbox" v-model="srv.persist"> 把约 4870 条 MedicationAdministration 也写入服务端</label>
            <div class="muted">关闭时仅存于本地镜像，统计页面照常工作；开启后首次初始化会慢很多，公共演示服务器可能限流。</div>
          </span>
        </div>
        <div class="filter-bar" style="margin-bottom:12px">
          <button class="btn" @click="testServer" :disabled="srv.testing">{{ srv.testing ? '测试中…' : '测试连接' }}</button>
          <span v-if="srv.result" :class="srv.ok ? 'tag green' : 'tag red'">{{ srv.result }}</span>
        </div>
        <div class="divider-label">当前同步状态</div>
        <div class="kv">
          <span class="k">模式 / 状态</span><span>{{ sync.mode }} · {{ sync.status }}</span>
          <span class="k">服务端</span><span>{{ sync.server || '—' }}</span>
          <span class="k">FHIR 版本</span><span>{{ sync.fhirVersion || '—' }}</span>
          <span class="k">已读取 / 已写入</span><span>{{ sync.loadedCount }} / {{ sync.done }}</span>
          <span class="k">待写 / 进行 / 失败</span>
          <span>{{ sync.queued }} / {{ sync.inflight }} / <b :class="{'txt-err': sync.failed}">{{ sync.failed }}</b></span>
          <span class="k">最近写入错误</span><span class="muted">{{ sync.lastError ? (sync.lastError.type + '/' + sync.lastError.id + '：' + sync.lastError.message) : '无' }}</span>
        </div>
        <template #foot>
          <button class="btn" @click="s.showServer=false">关闭</button>
          <button class="btn primary" @click="saveServer">保存并重连</button>
        </template>
      </ui-modal>
    </div>`
  };

  function boot() {
    var app = Vue.createApp(RootComponent);
    // 注册通用组件
    Object.keys(AMS.components).forEach(function (k) { app.component(k, AMS.components[k]); });
    // 注册页面组件，命名为 page-<route>
    Object.keys(AMS.pages).forEach(function (k) { app.component('page-' + k, AMS.pages[k]); });
    // 兼容通知面板里的空状态别名
    app.component('component-empty', AMS.components['empty-state']);
    App._vm = app.mount('#app');
    // 先挂载再装载数据：连接过程与失败原因由界面呈现，不会白屏
    App.reload().catch(function () { /* 失败已写入 boot.phase/boot.error，界面提供重试与本地兜底 */ });
    console.log('[app] 已挂载，页面：', Object.keys(AMS.pages).join(', '));
  }

  global.addEventListener('hashchange', function () {
    var h = (global.location.hash || '').replace('#', '');
    if (h && h !== App.state.route && (h === 'home' || D.canAccess(App.state.roleCode, h))) App.state.route = h;
  });

  global.__BOOT_AMS__ = boot;
})(window);
