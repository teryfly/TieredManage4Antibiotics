/* =====================================================================
 * sys-params.js —— L3-4-3 系统参数设置（系统管理员）
 * 左侧竖排 Tab + 右侧内容区，6 个 Tab：
 *   职称权限对应 / 同步参数配置 / 职称变动规则 / 外部系统对接 /
 *   系统通知配置 / 参数变更记录
 * 各 Tab 表单绑定 data 中的工作副本（从 Svc 深拷贝），由各自「保存」按钮持久化。
 * ===================================================================== */
(function (global) {
  'use strict';
  var AMS = global.AMS, Svc = global.Svc, D = global.Domain, App = global.App;

  function clone(o) { return JSON.parse(JSON.stringify(o)); }

  AMS.pages['sys-params'] = {
    data: function () {
      return {
        active: 'title-priv',
        tabs: [
          { code: 'title-priv', name: '职称权限对应' },
          { code: 'role-perm', name: '用户角色权限' },
          { code: 'sync', name: '同步参数配置' },
          { code: 'title-rules', name: '职称变动规则' },
          { code: 'endpoint', name: '外部系统对接' },
          { code: 'notify', name: '系统通知配置' },
          { code: 'provenance', name: '参数变更记录' }
        ],
        // Tab1 编辑弹框
        showPriv: false, privTitle: '', privForm: { 'non-restricted': false, restricted: false, special: false }, privOriginal: { 'non-restricted': false, restricted: false, special: false },
        // Tab2（用户角色权限）工作副本
        rolePerm: null,
        // Tab3 工作副本
        sync: null,
        // Tab4 工作副本
        rules: null,
        // Tab5 配置弹框
        showEndpoint: false, endpointId: '', endpointForm: { address: '', auth: '', frequency: '实时' },
        // Tab6 编辑弹框
        showNotify: false, notifyIndex: -1,
        notifyForm: { inApp: false, sms: false, email: false, target: '', rule: 'each', repeatEnabled: false, repeatInterval: 24, repeatMax: 3, content: '' },
        // Tab7 筛选
        pvFilter: { start: '', end: '', type: 'all' }, pvQuery: { start: '', end: '', type: 'all' },
        page: 1, size: 20
      };
    },
    created: function () {
      this.D = D;
      this.loadRolePerm();
      this.loadSync();
      this.loadRules();
    },
    computed: {
      // 模板中直接写 D.xxx() 的话，Vue 运行时编译只会在实例上找 D，取不到就抛错，
      // 因此在此显式暴露领域常量（与本分支改造无关，属既有缺陷修正）
      D: function () { return D; },
      isAdmin: function () { return App.state.roleCode === 'admin'; },
      // Tab1
      matrix: function () { App.state.refresh; return Svc.titleMatrix(); },
      privImpact: function () { return Svc.titleImpact(this.privTitle); },
      privRevoked: function () {
        var o = this.privOriginal, f = this.privForm, out = [];
        ['non-restricted', 'restricted', 'special'].forEach(function (k) { if (o[k] && !f[k]) out.push(D.levelName(k)); });
        return out;
      },
      // Tab4
      endpoints: function () { App.state.refresh; return Svc.endpoints(); },
      endpointAlerts: function () {
        return this.endpoints.filter(function (e) { return e.status !== 'active'; }).map(function (e) {
          return e.name + (e.status === 'error' ? '同步异常，请检查接口配置' : '连接已断开，请重新配置');
        });
      },
      // Tab5
      notifyItems: function () { App.state.refresh; var b = Svc.basic('notify-config'); return b ? b.items : []; },
      // Tab6
      provenanceAll: function () { App.state.refresh; return Svc.provenance(); },
      changeTypes: function () {
        var seen = {}, out = [];
        this.provenanceAll.forEach(function (p) { var t = p.ext.changeType; if (t && !seen[t]) { seen[t] = 1; out.push(t); } });
        return out;
      },
      provenanceFiltered: function () {
        var q = this.pvQuery;
        return this.provenanceAll.filter(function (p) {
          var d = (p.recorded || '').slice(0, 10);
          if (q.start && d < q.start) return false;
          if (q.end && d > q.end) return false;
          if (q.type !== 'all' && p.ext.changeType !== q.type) return false;
          return true;
        });
      },
      provenancePaged: function () { var s = (this.page - 1) * this.size; return this.provenanceFiltered.slice(s, s + this.size); }
    },
    methods: {
      switchTab: function (code) {
        this.active = code;
        if (code === 'role-perm') this.loadRolePerm();
        if (code === 'sync') this.loadSync();
        if (code === 'title-rules') this.loadRules();
      },
      loadSync: function () { this.sync = clone(Svc.basic('sync-params')); },
      loadRules: function () { this.rules = clone(Svc.basic('title-change-rules')); },

      /* -------- Tab2 用户角色权限 -------- */
      loadRolePerm: function () { this.rolePerm = clone(Svc.rolePermissions()); },
      saveRolePerm: function () {
        Svc.saveRolePermissions(this.rolePerm);
        App.bump();
        App.toast('用户角色权限已保存并即时生效');
      },

      /* -------- Tab1 职称权限对应 -------- */
      openPriv: function (row) {
        this.privTitle = row.title;
        this.privForm = { 'non-restricted': !!row['non-restricted'], restricted: !!row.restricted, special: !!row.special };
        this.privOriginal = { 'non-restricted': !!row['non-restricted'], restricted: !!row.restricted, special: !!row.special };
        this.showPriv = true;
      },
      savePriv: function () {
        var f = this.privForm, levels = [];
        ['non-restricted', 'restricted', 'special'].forEach(function (k) { if (f[k]) levels.push(k); });
        Svc.saveTitlePrivilege(this.privTitle, levels);
        this.showPriv = false;
        App.bump();
        App.toast('已保存「' + D.titleName(this.privTitle) + '」处方权限，并联动更新权限映射配置');
      },

      /* -------- Tab2 同步参数配置 -------- */
      manualSync: function () {
        this.sync.records.unshift({ time: Svc.now(), status: '成功', amount: 1250, cost: '10s' });
        Svc.saveBasic('sync-params', { records: this.sync.records });
        App.bump();
        App.toast('手动同步完成，已同步 1,250 条数据（演示）');
      },
      saveSync: function () {
        Svc.saveBasic('sync-params', {
          enabled: this.sync.enabled, frequency: this.sync.frequency, time: this.sync.time,
          scope: this.sync.scope, onFail: this.sync.onFail, failThreshold: this.sync.failThreshold,
          records: this.sync.records
        });
        App.bump();
        App.toast('同步参数已保存');
      },

      /* -------- Tab3 职称变动规则 -------- */
      saveRules: function () {
        Svc.saveBasic('title-change-rules', {
          promoteTiming: this.rules.promoteTiming, demoteTiming: this.rules.demoteTiming,
          rules: this.rules.rules, onLeave: this.rules.onLeave, onReturn: this.rules.onReturn
        });
        App.bump();
        App.toast('职称变动规则已保存');
      },

      /* -------- Tab4 外部系统对接 -------- */
      endpointStatus: function (s) {
        return { active: { icon: '🟢', text: '正常', cls: 'green' }, error: { icon: '🟡', text: '异常', cls: 'orange' }, off: { icon: '🔴', text: '断开', cls: 'red' } }[s] || { icon: '⚪', text: s, cls: 'gray' };
      },
      openEndpoint: function (e) {
        this.endpointId = e.id;
        this.endpointForm = { address: e.ext.address, auth: e.ext.auth, frequency: '实时' };
        this.showEndpoint = true;
      },
      testEndpoint: function () { App.toast('🟢 连接正常，响应时间 128ms（演示）'); },
      saveEndpoint: function () {
        Svc.saveEndpoint(this.endpointId, { address: this.endpointForm.address, auth: this.endpointForm.auth });
        this.showEndpoint = false;
        App.bump();
        App.toast('外部系统配置已保存');
      },

      /* -------- Tab5 系统通知配置 -------- */
      openNotify: function (item, idx) {
        this.notifyIndex = idx;
        this.notifyForm = {
          inApp: !!item.inApp, sms: !!item.sms, email: !!item.email, target: item.target, rule: 'each',
          repeatEnabled: !!item.repeatEnabled, repeatInterval: item.repeatInterval || 24, repeatMax: item.repeatMax || 3,
          content: item.content || ''
        };
        this.showNotify = true;
      },
      saveNotify: function () {
        var items = clone(this.notifyItems), f = this.notifyForm, i = this.notifyIndex;
        if (i >= 0 && items[i]) {
          items[i].inApp = f.inApp; items[i].sms = f.sms; items[i].email = f.email; items[i].target = f.target;
          items[i].repeatEnabled = f.repeatEnabled; items[i].repeatInterval = f.repeatInterval; items[i].repeatMax = f.repeatMax;
          items[i].content = f.content;
        }
        Svc.saveBasic('notify-config', { items: items });
        this.showNotify = false;
        App.bump();
        App.toast('通知配置已保存');
      },

      /* -------- Tab6 参数变更记录 -------- */
      doQuery: function () { this.pvQuery = clone(this.pvFilter); this.page = 1; },
      resetQuery: function () { this.pvFilter = { start: '', end: '', type: 'all' }; this.pvQuery = { start: '', end: '', type: 'all' }; this.page = 1; }
    },
    template: `
    <div v-if="!isAdmin" class="card"><div class="card-body"><empty-state icon="🔒" text="本页面仅对「系统管理员」角色开放。请使用顶部演示角色切换为「系统管理员」。"></empty-state></div></div>
    <div v-else>
      <div class="card">
        <div class="tab-layout">
          <!-- 左侧 Tab -->
          <div class="tab-side">
            <a v-for="t in tabs" class="t" :class="{active:active===t.code}" @click="switchTab(t.code)">{{ t.name }}</a>
          </div>

          <!-- 右侧内容区 -->
          <div class="tab-content">

            <!-- Tab1 职称权限对应 -->
            <div v-if="active==='title-priv'">
              <h3 style="margin:0 0 14px;font-size:16px">职称权限对应表</h3>
              <div class="alert info mb12"><span>💡</span><div>此表定义各职称的默认处方权限，与权限映射配置联动生效。修改此表将同步更新权限映射配置的默认规则。</div></div>
              <table class="tbl">
                <thead><tr><th>职称</th><th>非限制使用级</th><th>限制使用级</th><th>特殊使用级</th><th>操作</th></tr></thead>
                <tbody>
                  <tr v-for="row in matrix">
                    <td>{{ D.titleName(row.title) }}</td>
                    <td><span :style="{color: row['non-restricted'] ? '#16a34a' : '#9aa4b2'}">{{ row['non-restricted'] ? '✔' : '✘' }}</span></td>
                    <td><span :style="{color: row.restricted ? '#16a34a' : '#9aa4b2'}">{{ row.restricted ? '✔' : '✘' }}</span></td>
                    <td><span :style="{color: row.special ? '#16a34a' : '#9aa4b2'}">{{ row.special ? '✔' : '✘' }}</span></td>
                    <td class="actions"><a class="btn-link" @click="openPriv(row)">编辑</a></td>
                  </tr>
                </tbody>
              </table>
              <div class="muted mt8" style="font-size:12px">✔ = 可开具　✘ = 不可开具（需单独审批授权）</div>
            </div>

            <!-- Tab2 用户角色权限 -->
            <div v-if="active==='role-perm' && rolePerm">
              <h3 style="margin:0 0 14px;font-size:16px">用户角色权限配置</h3>
              <div class="alert info mb12"><span>💡</span><div>配置各系统角色可访问的功能页面，勾选后该角色对应的顶部导航菜单、下拉子菜单与首页快捷入口即时生效。</div></div>
              <div class="table-wrap">
                <table class="tbl">
                  <thead><tr><th>模块</th><th>页面</th><th v-for="r in D.ROLES" style="text-align:center">{{ r.icon }} {{ r.name }}</th></tr></thead>
                  <tbody>
                    <template v-for="m in D.MODULES">
                      <tr v-for="(p,i) in m.pages">
                        <td v-if="i===0" :rowspan="m.pages.length">{{ m.icon }} {{ m.name }}</td>
                        <td>{{ p.name }}</td>
                        <td v-for="r in D.ROLES" style="text-align:center">
                          <input type="checkbox" :value="r.code" v-model="rolePerm[p.route]">
                        </td>
                      </tr>
                    </template>
                  </tbody>
                </table>
              </div>
              <div class="btn-row mt16"><div style="flex:1"></div><button class="btn primary" @click="saveRolePerm">保存</button></div>
            </div>

            <!-- Tab3 同步参数配置 -->
            <div v-if="active==='sync' && sync">
              <h3 style="margin:0 0 14px;font-size:16px">同步参数配置</h3>
              <div class="divider-label">医师资质系统同步</div>
              <div class="form-row">
                <label>同步开关</label>
                <div class="ctrl"><div class="radios" style="flex-direction:row;gap:18px">
                  <label><input type="radio" :value="true" v-model="sync.enabled"> 已开启</label>
                  <label><input type="radio" :value="false" v-model="sync.enabled"> 关闭</label>
                </div></div>
              </div>
              <div class="form-row">
                <label>同步频率</label>
                <div class="ctrl"><select v-model="sync.frequency"><option>每小时</option><option>每6小时</option><option>每日</option><option>每周</option></select></div>
              </div>
              <div class="form-row">
                <label>同步时间</label>
                <div class="ctrl"><select v-model="sync.time"><option>00:00</option><option>02:00</option><option>04:00</option><option>06:00</option><option>22:00</option></select><span class="muted" style="font-size:12px">每日同步时生效</span></div>
              </div>
              <div class="form-row">
                <label>同步范围</label>
                <div class="ctrl"><div class="checks">
                  <label><input type="checkbox" v-model="sync.scope.title"> 职称信息</label>
                  <label><input type="checkbox" v-model="sync.scope.dept"> 科室信息</label>
                  <label><input type="checkbox" v-model="sync.scope.onDuty"> 在岗状态</label>
                  <label><input type="checkbox" v-model="sync.scope.exam"> 处方权考核记录</label>
                </div></div>
              </div>

              <div class="divider-label">异常处理规则</div>
              <div class="form-row">
                <label>同步失败时</label>
                <div class="ctrl"><select v-model="sync.onFail"><option>保持原数据不变</option><option>标记异常并通知管理员</option></select></div>
              </div>
              <div class="form-row">
                <label>连续失败次数</label>
                <div class="ctrl" style="flex-direction:row;align-items:center;gap:8px"><input type="number" v-model.number="sync.failThreshold" style="width:80px"> <span class="muted" style="font-size:12px">次后发送告警通知</span></div>
              </div>

              <div class="divider-label">最近同步记录</div>
              <table class="tbl">
                <thead><tr><th>同步时间</th><th>状态</th><th>同步数据量</th><th>耗时</th></tr></thead>
                <tbody>
                  <tr v-for="r in sync.records">
                    <td class="nowrap">{{ r.time }}</td>
                    <td><span class="tag" :class="r.status==='成功'?'green':'red'">{{ r.status }}</span></td>
                    <td>{{ r.amount }}</td>
                    <td>{{ r.cost }}</td>
                  </tr>
                </tbody>
              </table>
              <div class="btn-row mt16">
                <button class="btn" @click="manualSync">🔄 手动同步</button>
                <div style="flex:1"></div>
                <button class="btn primary" @click="saveSync">保存</button>
              </div>
            </div>

            <!-- Tab3 职称变动规则 -->
            <div v-if="active==='title-rules' && rules">
              <h3 style="margin:0 0 14px;font-size:16px">职称变动规则</h3>
              <div class="divider-label">权限生效时机</div>
              <div class="form-row">
                <label>职称晋升时</label>
                <div class="ctrl"><div class="radios">
                  <label><input type="radio" value="immediate" v-model="rules.promoteTiming"> 立即生效</label>
                  <label><input type="radio" value="nextday" v-model="rules.promoteTiming"> 次日生效</label>
                  <label><input type="radio" value="nextmonth" v-model="rules.promoteTiming"> 次月生效</label>
                </div></div>
              </div>
              <div class="form-row">
                <label>职称降级时</label>
                <div class="ctrl"><div class="radios">
                  <label><input type="radio" value="immediate" v-model="rules.demoteTiming"> 立即生效</label>
                  <label><input type="radio" value="nextday" v-model="rules.demoteTiming"> 次日生效</label>
                  <label><input type="radio" value="nextmonth" v-model="rules.demoteTiming"> 次月生效</label>
                </div></div>
              </div>

              <div class="divider-label">权限变更规则</div>
              <div class="radios" style="margin-bottom:8px">
                <label><input type="checkbox" v-model="rules.rules.autoMatchOnPromote"> 职称晋升时，自动匹配新职称权限范围</label>
                <label><input type="checkbox" v-model="rules.rules.autoRevokeOnDemote"> 职称降级时，自动收回超出新职称的权限</label>
                <label><input type="checkbox" v-model="rules.rules.keepSpecialOnDemote"> 职称降级时，保留已获得的特殊使用级授权</label>
                <label><input type="checkbox" v-model="rules.rules.notifyOnChange"> 权限变更后，自动通知相关医师</label>
                <label><input type="checkbox" v-model="rules.rules.stopApprovalOnRevoke"> 权限收回时，同时中止该医师进行中的审批流程</label>
              </div>

              <div class="divider-label">特殊情况处理</div>
              <div class="form-row">
                <label>医师离岗/离职时</label>
                <div class="ctrl"><div class="radios">
                  <label><input type="radio" value="revoke" v-model="rules.onLeave"> 立即收回全部处方权限</label>
                  <label><input type="radio" value="keep" v-model="rules.onLeave"> 保留权限，手动收回</label>
                </div></div>
              </div>
              <div class="form-row">
                <label>医师返岗时</label>
                <div class="ctrl"><div class="radios">
                  <label><input type="radio" value="restore" v-model="rules.onReturn"> 自动恢复离岗前权限</label>
                  <label><input type="radio" value="manual" v-model="rules.onReturn"> 不自动恢复，需重新授权</label>
                </div></div>
              </div>

              <div class="btn-row mt16"><div style="flex:1"></div><button class="btn primary" @click="saveRules">保存规则</button></div>
            </div>

            <!-- Tab4 外部系统对接 -->
            <div v-if="active==='endpoint'">
              <h3 style="margin:0 0 14px;font-size:16px">外部系统对接</h3>
              <table class="tbl">
                <thead><tr><th>系统名称</th><th>对接方式</th><th>状态</th><th>最近同步</th><th>操作</th></tr></thead>
                <tbody>
                  <tr v-for="e in endpoints">
                    <td>{{ e.name }}</td>
                    <td>{{ e.ext.conn }}</td>
                    <td><span class="tag" :class="endpointStatus(e.status).cls">{{ endpointStatus(e.status).icon }} {{ endpointStatus(e.status).text }}</span></td>
                    <td class="nowrap">{{ e.ext.lastSync }}</td>
                    <td class="actions"><a class="btn-link" @click="openEndpoint(e)">配置</a></td>
                  </tr>
                </tbody>
              </table>
              <div class="alert warn mt16" v-if="endpointAlerts.length"><span>⚠️</span><div><div v-for="a in endpointAlerts">{{ a }}</div></div></div>
            </div>

            <!-- Tab5 系统通知配置 -->
            <div v-if="active==='notify'">
              <h3 style="margin:0 0 14px;font-size:16px">系统通知配置</h3>
              <table class="tbl">
                <thead><tr><th>通知类型</th><th>站内消息</th><th>短信</th><th>邮件</th><th>接收人</th><th>操作</th></tr></thead>
                <tbody>
                  <tr v-for="(item,idx) in notifyItems">
                    <td>{{ item.type }}</td>
                    <td><span :style="{color: item.inApp ? '#16a34a' : '#9aa4b2'}">{{ item.inApp ? '✔' : '✘' }}</span></td>
                    <td><span :style="{color: item.sms ? '#16a34a' : '#9aa4b2'}">{{ item.sms ? '✔' : '✘' }}</span></td>
                    <td><span :style="{color: item.email ? '#16a34a' : '#9aa4b2'}">{{ item.email ? '✔' : '✘' }}</span></td>
                    <td>{{ item.target }}</td>
                    <td class="actions"><a class="btn-link" @click="openNotify(item,idx)">编辑</a></td>
                  </tr>
                </tbody>
              </table>
              <div class="muted mt8" style="font-size:12px">✔ = 已启用　✘ = 未启用</div>
            </div>

            <!-- Tab6 参数变更记录 -->
            <div v-if="active==='provenance'">
              <h3 style="margin:0 0 14px;font-size:16px">参数变更记录</h3>
              <div class="filter-bar mb12">
                <div class="field"><label>变更时间</label>
                  <div class="field inline"><input type="date" v-model="pvFilter.start"> ~ <input type="date" v-model="pvFilter.end"></div>
                </div>
                <div class="field"><label>变更类型</label>
                  <select v-model="pvFilter.type"><option value="all">全部</option><option v-for="t in changeTypes" :value="t">{{ t }}</option></select>
                </div>
                <button class="btn primary" @click="doQuery">查询</button>
                <button class="btn" @click="resetQuery">重置</button>
              </div>
              <div class="table-wrap">
                <table class="tbl" v-if="provenancePaged.length">
                  <thead><tr><th>变更时间</th><th>变更类型</th><th>变更内容</th><th>操作人</th></tr></thead>
                  <tbody>
                    <tr v-for="p in provenancePaged">
                      <td class="nowrap">{{ p.recorded }}</td>
                      <td><span class="tag blue">{{ p.ext.changeType }}</span></td>
                      <td>{{ p.ext.content }}</td>
                      <td class="nowrap">{{ p.ext.operator }}</td>
                    </tr>
                  </tbody>
                </table>
                <empty-state v-else text="暂无参数变更记录"></empty-state>
              </div>
              <ui-pager v-if="provenanceFiltered.length" :total="provenanceFiltered.length" v-model:page="page" :size="size"></ui-pager>
            </div>

          </div>
        </div>
      </div>

      <!-- Tab1 编辑弹框 -->
      <ui-modal v-if="showPriv" :title="'编辑职称权限 - '+D.titleName(privTitle)" @close="showPriv=false">
        <div class="divider-label">处方权限范围</div>
        <div class="radios" style="gap:14px">
          <label><input type="checkbox" v-model="privForm['non-restricted']"> 非限制使用级　可开具</label>
          <label><input type="checkbox" v-model="privForm.restricted"> 限制使用级　可开具</label>
          <label><input type="checkbox" v-model="privForm.special"> 特殊使用级　可开具</label>
        </div>
        <div class="alert warn mt12"><span>⚠️</span><div>勾选「特殊使用级」后，该职称医师可申请特殊使用级处方权，仍需通过审批流程获得授权。</div></div>

        <div class="divider-label">变更影响预览</div>
        <div>当前该职称在岗医师数：<b>{{ privImpact.total }}</b> 人</div>
        <div v-if="privRevoked.length" class="mt8">
          <div class="alert danger" style="margin-bottom:8px"><span>⚠️</span><div>若取消「{{ privRevoked.join('、') }}」开具权限，以下在岗人员的对应处方权将被收回：</div></div>
          <table class="tbl">
            <thead><tr><th>科室</th><th>受影响人数</th><th>当前持有该级别处方权人数</th></tr></thead>
            <tbody>
              <tr v-for="r in privImpact.byDept"><td>{{ r.dept }}</td><td>{{ r.count }}</td><td>{{ r.holding }}</td></tr>
            </tbody>
          </table>
        </div>
        <div v-else class="muted mt8" style="font-size:12px">本次未收回任何已有权限，无人员受影响。</div>

        <div class="alert info mt12"><span>💡</span><div>此表与权限映射配置联动生效，保存后将同步更新权限映射配置的默认规则。</div></div>
        <template #foot>
          <button class="btn" @click="showPriv=false">取消</button>
          <button class="btn primary" @click="savePriv">确认保存</button>
        </template>
      </ui-modal>

      <!-- Tab4 配置弹框 -->
      <ui-modal v-if="showEndpoint" title="系统对接配置" @close="showEndpoint=false">
        <div class="divider-label">接口配置</div>
        <div class="form-row"><label class="req">接口地址</label><div class="ctrl"><input type="text" v-model="endpointForm.address"></div></div>
        <div class="form-row"><label class="req">认证方式</label><div class="ctrl"><select v-model="endpointForm.auth"><option>OAuth2.0</option><option>API Key</option><option>Basic Auth</option></select></div></div>
        <div class="divider-label">同步设置</div>
        <div class="form-row"><label>同步频率</label><div class="ctrl"><select v-model="endpointForm.frequency"><option>实时</option><option>每5分钟</option><option>每小时</option><option>每日</option></select></div></div>
        <div class="btn-row mt12"><button class="btn" @click="testEndpoint">测试连接</button></div>
        <template #foot>
          <button class="btn" @click="showEndpoint=false">取消</button>
          <button class="btn primary" @click="saveEndpoint">保存配置</button>
        </template>
      </ui-modal>

      <!-- Tab5 编辑弹框 -->
      <ui-modal v-if="showNotify && notifyIndex>=0" :title="'编辑通知配置 - '+(notifyItems[notifyIndex] ? notifyItems[notifyIndex].type : '')" @close="showNotify=false">
        <div class="divider-label">通知渠道</div>
        <div class="radios" style="gap:14px">
          <label><input type="checkbox" v-model="notifyForm.inApp"> 站内消息　即时推送至系统内消息中心</label>
          <label><input type="checkbox" v-model="notifyForm.sms"> 短信通知　发送至接收人绑定手机号</label>
          <label><input type="checkbox" v-model="notifyForm.email"> 邮件通知　发送至接收人绑定邮箱</label>
        </div>
        <div class="divider-label">接收人</div>
        <div class="form-row"><label>接收人</label><div class="ctrl"><input type="text" v-model="notifyForm.target"></div></div>
        <div class="divider-label">发送规则</div>
        <div class="form-row">
          <label>触发条件</label>
          <div class="ctrl">
            <div class="radios">
              <label><input type="radio" value="each" v-model="notifyForm.rule"> 每次预警产生时发送</label>
              <label><input type="radio" value="daily" v-model="notifyForm.rule"> 每日汇总发送</label>
              <label><input type="radio" value="severe" v-model="notifyForm.rule"> 仅严重预警时发送</label>
            </div>
          </div>
        </div>
        <div class="form-row">
          <label>重复提醒</label>
          <div class="ctrl">
            <label style="display:inline-flex;align-items:center;gap:6px"><input type="checkbox" v-model="notifyForm.repeatEnabled"> 同一预警在未处理时重复提醒</label>
            <div v-if="notifyForm.repeatEnabled" style="margin-top:8px;display:flex;align-items:center;gap:6px;font-size:13px">
              提醒间隔 每 <input type="number" min="1" v-model.number="notifyForm.repeatInterval" style="width:70px"> 小时，最多提醒 <input type="number" min="1" v-model.number="notifyForm.repeatMax" style="width:70px"> 次
            </div>
          </div>
        </div>
        <div class="divider-label">通知内容</div>
        <div class="form-row">
          <label>通知内容</label>
          <div class="ctrl"><textarea v-model="notifyForm.content" placeholder="请输入通知内容文案，支持变量占位符如 \${科室名称}、\${药品名称} 等"></textarea></div>
        </div>
        <template #foot>
          <button class="btn" @click="showNotify=false">取消</button>
          <button class="btn primary" @click="saveNotify">确认保存</button>
        </template>
      </ui-modal>
    </div>`
  };
})(window);
