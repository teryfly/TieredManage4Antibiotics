/* =====================================================================
 * grade-rules.js —— P-2-1 抗菌药物等级规则（系统管理员 / 规则管理员）
 * SRS FR-001 抗菌药物等级维护 + FR-002 按医生职称设置使用权限。
 * 三个视图：抗菌药物等级 / 职称使用权限 / 规则变更留痕（SRS §6.3 关联视图）。
 * 所有写入均落到真实 FHIR R4 资源（Basic 等级定义、Permission 职称映射、
 * Medication/MedicationKnowledge 等级、Provenance/AuditEvent 留痕）。
 * ===================================================================== */
(function (global) {
  'use strict';
  var AMS = global.AMS, Svc = global.Svc, D = global.Domain, App = global.App;
  var Ap = global.Approval, F = global.FHIR;

  var ROUTE = 'grade-rules';
  var TABS = [
    { code: 'grade', name: '抗菌药物等级' },
    { code: 'title', name: '职称使用权限' },
    { code: 'log', name: '规则变更留痕' }
  ];
  // 留痕 Tab 合并的三类规则变更（SRS FR-001.7 / FR-002.6 要求可追溯）
  var LOG_TYPES = ['等级维护', '职称权限', '等级调整'];

  AMS.pages[ROUTE] = {
    data: function () {
      return {
        tab: 'grade',
        /* --- 等级视图 --- */
        openGrade: '',                 // 展开药品清单的等级编码
        showEdit: false, edit: null,   // {code,name,desc,note,builtin}
        showOff: false, off: null,     // {code,name,impact,note}
        showAdd: false, add: this.blankAdd(), addErr: {},
        /* --- 药品检索与等级调整 --- */
        filter: { keyword: '', code: '', level: 'all', status: 'all' },
        query: { keyword: '', code: '', level: 'all', status: 'all' },
        page: 1, size: 8,
        showAdjust: false, adjust: null, // {drug,from,to,toName,note,impact}
        /* --- 职称权限视图 --- */
        matrixTick: 0,                   // 强制矩阵复选框按数据重建
        showTitle: false, titleEdit: null, // {title,titleName,levels,orig,doctors,note}
        showTitleLog: false, titleLog: null, // {titleName,rows}
        verify: { pract: '', med: '', result: null },
        /* --- 变更留痕视图 --- */
        logType: 'all'
      };
    },
    computed: {
      // 模板里不能裸用模块级常量（Vue 只在实例上查找标识符），显式暴露
      D: function () { return D; },
      Ap: function () { return Ap; },
      tabs: function () { return TABS; },
      user: function () { return App.currentUser(); },
      role: function () { return App.state.roleCode; },
      canView: function () { return D.canAccess(this.role, ROUTE); },

      /* ---------- FR-001.3 等级列表：名称/编码/说明/启用状态/适用药品数量 ---------- */
      grades: function () {
        App.state.refresh;
        return Svc.srs.grades().map(function (g) {
          // Basic/Basic-grade-{code} 是本系统等级定义的落库位置，显示名与说明以它为准
          var b = F.read('Basic', 'Basic-grade-' + g.code);
          var ext = (b && b.ext) || {};
          return Object.assign({}, g, {
            name: ext.name || g.name,
            desc: ext.desc || g.desc,
            defNote: ext.note || '',
            resId: b ? b.id : '',
            builtin: ['non-restricted', 'restricted', 'special'].indexOf(g.code) >= 0
          });
        });
      },
      openRow: function () {
        var c = this.openGrade;
        return this.grades.filter(function (g) { return g.code === c; })[0] || null;
      },
      // 顶栏指标：启用等级数 / 目录药品数 / 进行中审批数
      statEnabled: function () { return this.grades.filter(function (g) { return g.enabled; }).length; },
      statDrugs: function () { return this.grades.reduce(function (s, g) { return s + g.drugCount; }, 0); },
      statRunning: function () {
        App.state.refresh;
        return F.search('Task', function (t) {
          return t.ext && t.ext.taskKind === 'main'
            && ['approved', 'rejected', 'withdrawn', 'cancelled', 'post-review-done'].indexOf(t.ext.flowStatus) < 0;
        }).length;
      },

      /* ---------- FR-001.5 按药品名称/编码/等级/状态检索 ---------- */
      drugs: function () {
        App.state.refresh;
        var q = this.query;
        return Svc.srs.searchDrugs({ keyword: q.keyword, code: q.code, level: q.level, status: q.status });
      },
      paged: function () {
        var s = (this.page - 1) * this.size;
        return this.drugs.slice(s, s + this.size);
      },

      /* ---------- FR-002.1 职称 × 等级矩阵 ---------- */
      titleRules: function () {
        App.state.refresh;
        return Svc.srs.titleRules().map(function (r) {
          return Object.assign({}, r, { levelNames: r.levels.map(D.levelName) });
        });
      },
      titleDoctorsTotal: function () {
        return this.titleRules.reduce(function (s, r) { return s + r.doctors; }, 0);
      },
      // 三层授权的当前合并顺序（在「医师权限管理」页调整，这里只读取展示）
      prioLabel: function () {
        App.state.refresh;
        return Svc.srs.mergePriority().label;
      },
      // 验证区数据源：有职称且有科室归属的在岗医师 + 全部目录药品
      doctors: function () {
        App.state.refresh;
        return Svc.srs.doctorDirectory().filter(function (d) { return d.dept && d.title; });
      },
      meds: function () { App.state.refresh; return Svc.srs.searchDrugs({}); },
      // 岗位角色中文名取自 FHIR CodeSystem/amr-role
      roleDict: function () {
        App.state.refresh;
        var cs = F.read('CodeSystem', 'CodeSystem-amr-role');
        var map = {};
        ((cs && cs.concept) || []).forEach(function (c) { map[c.code] = c.display; });
        return map;
      },
      // 调整弹框里的目标等级（模板直接读取，必须是 computed 而非 methods）
      adjustTarget: function () {
        var a = this.adjust;
        if (!a) return null;
        return this.grades.filter(function (g) { return g.code === a.to; })[0] || null;
      },
      // 保存前的规则变更摘要（FR-002.4）
      titleDiff: function () {
        if (!this.titleEdit) return [];
        App.state.refresh;
        return Svc.srs.titleRuleDiff(this.titleEdit.title, this.titleEdit.levels);
      },

      /* ---------- 变更留痕：等级维护 / 职称权限 / 等级调整 合并按时间倒序 ---------- */
      logs: function () {
        App.state.refresh;
        var rows = [];
        LOG_TYPES.forEach(function (t) {
          Svc.srs.ruleChangeLog(t).forEach(function (r) {
            rows.push({ id: r.id, time: r.time, content: r.content, operator: r.operator, changeType: r.changeType });
          });
        });
        var type = this.logType;
        return rows.filter(function (r) { return type === 'all' || r.changeType === type; })
          .sort(function (a, b) { return b.time.localeCompare(a.time); });
      }
    },
    methods: {
      roleLabel: function (code) { return this.roleDict[code] || D.approvalRoleName(code) || code || '—'; },
      switchTab: function (t) { this.tab = t; this.page = 1; },

      /* ================= FR-001.1 等级新增 / 编辑 / 停用启用 ================= */
      openGradeEdit: function (g) {
        this.edit = { code: g.code, name: g.name, desc: g.desc, note: g.defNote, builtin: g.builtin, resId: g.resId };
        this.showEdit = true;
      },
      saveGradeEdit: function () {
        var e = this.edit;
        if (!e.name) { App.toast('等级名称不能为空', 'error'); return; }
        Svc.srs.saveGrade(e.code, { name: e.name, desc: e.desc }, e.note);
        App.bump();
        this.showEdit = false;
        App.toast('等级「' + e.name + '」定义已保存到 FHIR Basic 资源');
      },
      // FR-001.7：停用前必须显示影响提示
      openDisable: function (g) {
        this.off = { code: g.code, name: g.name, impact: Svc.srs.gradeImpact(g.code), note: '' };
        this.showOff = true;
      },
      confirmDisable: function () {
        var o = this.off;
        Svc.srs.saveGrade(o.code, { enabled: false }, o.note);
        App.bump();
        this.showOff = false;
        App.toast('等级「' + o.name + '」已停用：受影响药品 ' + o.impact.drugCount + ' 种，进行中审批 '
          + o.impact.runningCount + ' 件仍保留开单时的等级快照');
      },
      enableGrade: function (g) {
        if (!confirm('确认重新启用等级「' + g.name + '」？启用后新的开单请求按该等级参与权限判定。')) return;
        Svc.srs.saveGrade(g.code, { enabled: true }, '重新启用');
        App.bump();
        App.toast('等级「' + g.name + '」已启用');
      },
      blankAdd: function () {
        return { code: '', name: '', desc: '', color: '#7c3aed', rank: '', note: '' };
      },
      openAdd: function () {
        this.add = this.blankAdd();
        this.add.rank = String(D.LEVELS.length + 1);
        this.addErr = {};
        this.showAdd = true;
      },
      validateAdd: function () {
        var e = {}, a = this.add;
        if (!a.name) e.name = 1;
        if (!a.code) e.code = 1;
        else if (/[^a-zA-Z0-9\-_.]/.test(a.code)) e.code = 2;
        else if (D.LEVELS.some(function (l) { return l.code === a.code; })) e.code = 3;
        if (!a.rank || Number(a.rank) <= 0) e.rank = 1;
        this.addErr = e;
        return Object.keys(e).length === 0;
      },
      commitAdd: function () {
        if (!this.validateAdd()) { App.toast('请完善等级分类的必填信息', 'error'); return; }
        var a = this.add;
        var code = Svc.srs.addGrade({ code: a.code, name: a.name, desc: a.desc, color: a.color, rank: a.rank, note: a.note });
        App.bump();
        this.showAdd = false;
        App.toast('等级分类「' + a.name + '」（' + code + '）已新增，可立即关联药品');
      },
      toggleDrugs: function (code) { this.openGrade = this.openGrade === code ? '' : code; },

      /* ================= FR-001.4/FR-004.5 药品检索与等级调整 ================= */
      doSearch: function () {
        this.query = Object.assign({}, this.filter);
        this.page = 1;
      },
      resetSearch: function () {
        this.filter = { keyword: '', code: '', level: 'all', status: 'all' };
        this.query = Object.assign({}, this.filter);
        this.page = 1;
      },
      openAdjust: function (drug) {
        this.adjust = {
          drug: drug, from: drug.level, to: drug.level, note: '',
          impact: Svc.srs.gradeImpact(drug.level)
        };
        this.showAdjust = true;
      },
      openAdjustById: function (id) {
        var d = Svc.srs.drug(id);
        if (d) this.openAdjust(d);
      },
      gradeBy: function (code) {
        return this.grades.filter(function (g) { return g.code === code; })[0] || null;
      },
      commitAdjust: function () {
        var a = this.adjust;
        if (a.to === a.from) { App.toast('目标等级与当前等级一致，未做调整', 'error'); return; }
        var t = this.gradeBy(a.to);
        if (t && !t.enabled) { App.toast('目标等级「' + t.name + '」已停用，请先启用后再关联药品', 'error'); return; }
        var r = Svc.srs.setDrugGrade(a.drug.id, a.to, a.note);
        App.bump();
        this.showAdjust = false;
        App.toast('「' + a.drug.name + '」等级已调整为「' + D.levelName(r.after) + '」，新的开单按新等级判定');
      },

      /* ================= FR-002 职称使用权限 ================= */
      refreshMatrix: function () { this.matrixTick++; },
      // 单元格勾选即发起变更：先走变更摘要弹框，确认后才落库（FR-002.4）
      proposeLevel: function (r, level, on) {
        var levels = r.levels.slice();
        if (on) { if (levels.indexOf(level) < 0) levels.push(level); }
        else levels = levels.filter(function (c) { return c !== level; });
        this.openTitleEdit(r, levels);
      },
      openTitleEdit: function (r, preset) {
        this.titleEdit = {
          title: r.title, titleName: r.titleName, doctors: r.doctors,
          levels: preset ? preset.slice() : r.levels.slice(),
          orig: r.levels.slice(), note: ''
        };
        this.matrixTick++;           // 弹框期间让矩阵回到数据状态
        this.showTitle = true;
      },
      saveTitle: function () {
        var t = this.titleEdit;
        if (!this.titleDiff.length) { App.toast('规则未发生变化，无需保存', 'error'); return; }
        var r = Svc.srs.saveTitleRule(t.title, t.levels, t.note);
        App.bump();
        this.showTitle = false;
        this.matrixTick++;
        App.toast(t.titleName + ' 可使用等级已保存（' + r.text + '），临床开单立即读取最新生效规则');
      },
      // FR-002.3 停用职称权限规则：取消全部等级勾选即停用，仍需摘要确认
      disableTitle: function (r) {
        if (!r.levels.length) { App.toast('该职称当前已无生效等级，无需停用', 'error'); return; }
        this.openTitleEdit(r, []);
      },
      openTitleLog: function (r) {
        this.titleLog = { titleName: r.titleName, rows: Svc.srs.ruleChangeLog('职称权限', r.titleName) };
        this.showTitleLog = true;
      },
      statusOf: function (r) { return r.levels.length ? '生效中' : '已停用'; },
      toneOf: function (r) { return r.levels.length ? 'green' : 'gray'; },

      /* ================= FR-002.5 / FR-005.6 用医师验证最新规则 ================= */
      runVerify: function () {
        var v = this.verify;
        if (!v.pract) { App.toast('请选择一位验证用的在岗医师', 'error'); return; }
        if (!v.med) { App.toast('请选择一个抗菌药物', 'error'); return; }
        var r = Ap.check({ practitioner: v.pract, medicationId: v.med });
        this.verify.result = r;
        App.toast(r.error ? '校验失败：' + r.error : (r.allowed ? '权限校验通过' : '权限不足，判定结果见下方说明'));
      },
      clearVerify: function () { this.verify.result = null; },
      levelNames: function (codes) {
        return (codes || []).length ? (codes || []).map(D.levelName).join('、') : '无';
      },
      routeNodeText: function (route) {
        return route ? (route.title + ' V' + route.version + '（' + (route.nodes || []).length + ' 个审核节点）') : '';
      },
      // 留痕行的 FHIR entity 引用，体现「规则变更可回溯到资源」
      logRefs: function (id) {
        var p = F.read('Provenance', id);
        return ((p && p.entity) || []).map(function (e) { return e.what ? e.what.reference : ''; }).filter(Boolean);
      }
    },
    template: `
    <div>
      <div v-if="!canView" class="card"><div class="card-body">
        <empty-state icon="🔒" text="本页面仅对「系统管理员 / 抗菌药物管理规则管理员」开放，请使用顶部演示角色切换后查看。"></empty-state>
      </div></div>

      <div v-else>
        <div class="alert info mb12">
          <span>ℹ️</span>
          <div>本页对应 SRS FR-001（抗菌药物等级维护）与 FR-002（按医生职称设置使用权限）。等级定义、职称映射、药品等级
          全部读写到 FHIR R4 资源（Basic / Permission / Medication / MedicationKnowledge），变更以 Provenance 与 AuditEvent 双留痕。
          页面中的等级、职称、医师与药品均为<b>虚构演示数据</b>，仅用于证明功能可配置，不构成正式临床管理规则。</div>
        </div>

        <!-- Tab 头 -->
        <div class="card">
          <div class="card-body" style="padding:8px 18px 0">
            <div class="tabs-top">
              <div class="t" v-for="t in tabs" :key="t.code" :class="{active: tab===t.code}" @click="switchTab(t.code)">{{ t.name }}</div>
            </div>
          </div>
        </div>

        <!-- ==================== Tab 1 抗菌药物等级 ==================== -->
        <template v-if="tab==='grade'">
          <div class="card mt16">
            <div class="card-head">
              <h3>🧪 等级分类（FR-001.2 / FR-001.3）</h3>
              <div class="btn-row">
                <button class="btn primary sm" @click="openAdd">＋ 新增等级分类</button>
              </div>
            </div>
            <div class="card-body">
              <div class="stat-grid cols-4">
                <div class="stat-card"><div class="label">等级分类数</div><div class="value">{{ grades.length }}<small>个</small></div><div class="delta flat">含停用</div></div>
                <div class="stat-card"><div class="label">启用中</div><div class="value">{{ statEnabled }}<small>个</small></div><div class="delta up">参与新的开单判定</div></div>
                <div class="stat-card"><div class="label">已关联药品</div><div class="value">{{ statDrugs }}<small>种</small></div><div class="delta flat">按 Medication.level 统计</div></div>
                <div class="stat-card"><div class="label">进行中审批</div><div class="value">{{ statRunning }}<small>件</small></div><div class="delta down">保留开单时等级快照</div></div>
              </div>

              <div class="table-wrap mt16">
                <table class="tbl">
                  <thead><tr>
                    <th style="width:150px">等级名称</th>
                    <th style="width:150px">编码</th>
                    <th>说明</th>
                    <th style="width:90px">启用状态</th>
                    <th style="width:120px">适用药品数量</th>
                    <th style="width:150px">最近修改</th>
                    <th style="width:130px">操作</th>
                  </tr></thead>
                  <tbody>
                    <tr v-for="g in grades" :key="g.code">
                      <td>
                        <span class="level-dot" :style="{background:g.color}"></span><b>{{ g.name }}</b>
                        <div class="muted">{{ g.legacyName }}</div>
                      </td>
                      <td><code>{{ g.code }}</code><div class="muted" v-if="!g.builtin">演示自定义</div></td>
                      <td>
                        {{ g.desc || '—' }}
                        <div class="muted" v-if="g.defNote">管理备注：{{ g.defNote }}</div>
                        <div class="muted" v-if="g.resId">来源资源：Basic/{{ g.resId }}</div>
                      </td>
                      <td><span class="tag" :class="g.enabled?'green':'gray'">{{ g.enabled?'启用中':'已停用' }}</span></td>
                      <td>
                        <a class="btn-link" @click="toggleDrugs(g.code)">{{ g.drugCount }} 种</a>
                        <span class="muted"> {{ openGrade===g.code?'▲ 收起':'▼ 查看' }}</span>
                      </td>
                      <td class="nowrap muted">{{ g.updatedBy || '—' }}<div>{{ g.updatedAt || '—' }}</div></td>
                      <td>
                        <div class="actions">
                          <a class="btn-link" @click="openGradeEdit(g)">编辑</a>
                          <a class="btn-link danger" v-if="g.enabled" @click="openDisable(g)">停用</a>
                          <a class="btn-link" v-else @click="enableGrade(g)">启用</a>
                        </div>
                      </td>
                    </tr>
                  </tbody>
                </table>
              </div>
              <div class="hint mt8">停用或改名不影响等级编码本身：开单快照与审批留痕仍按编码引用，编码是 FHIR 值集 amr-level 的稳定码。</div>
            </div>
          </div>

          <!-- 该等级下的药品清单（FR-001.4 关联关系可见） -->
          <div class="card mt16" v-if="openRow">
            <div class="card-head">
              <h3>📦 「{{ openRow.name }}」等级关联的药品（{{ openRow.drugs.length }} 种）</h3>
              <a class="btn-link" @click="toggleDrugs(openRow.code)">关闭</a>
            </div>
            <div class="card-body" style="padding:0">
              <div class="table-wrap">
                <table class="tbl" v-if="openRow.drugs.length">
                  <thead><tr><th>药品名称</th><th style="width:200px">药品编码</th><th style="width:140px">等级</th><th style="width:140px">操作</th></tr></thead>
                  <tbody>
                    <tr v-for="d in openRow.drugs" :key="d.id">
                      <td>{{ d.name }}</td>
                      <td><code>{{ d.code }}</code></td>
                      <td><level-tag :level="openRow.code"></level-tag></td>
                      <td><a class="btn-link" @click="openAdjustById(d.id)">调整等级</a></td>
                    </tr>
                  </tbody>
                </table>
              </div>
              <empty-state v-if="!openRow.drugs.length" icon="📭" text="该等级下暂无药品，可在下方检索区把药品的等级调整为它。"></empty-state>
            </div>
          </div>

          <!-- 药品检索 + 直接调整等级（FR-001.5 / FR-001.6） -->
          <div class="card mt16">
            <div class="card-head"><h3>🔎 按药品检索并调整等级（FR-001.5）</h3></div>
            <div class="card-body">
              <div class="filter-bar">
                <div class="field"><label>药品名称</label>
                  <input type="text" v-model="filter.keyword" placeholder="名称 / 商品名，支持模糊" style="width:190px" @keyup.enter="doSearch">
                </div>
                <div class="field"><label>药品编码</label>
                  <input type="text" v-model="filter.code" placeholder="精确匹配，如 AMR-D01" style="width:170px" @keyup.enter="doSearch">
                </div>
                <div class="field"><label>等级</label>
                  <select v-model="filter.level">
                    <option value="all">全部等级</option>
                    <option v-for="g in grades" :key="g.code" :value="g.code">{{ g.name }}</option>
                  </select>
                </div>
                <div class="field"><label>状态</label>
                  <select v-model="filter.status">
                    <option value="all">全部状态</option>
                    <option value="enabled">启用中目录药品</option>
                    <option value="disabled">已停用药品</option>
                  </select>
                </div>
                <div class="field"><label>&nbsp;</label>
                  <div class="btn-row">
                    <button class="btn primary sm" @click="doSearch">检索</button>
                    <button class="btn sm" @click="resetSearch">重置</button>
                  </div>
                </div>
              </div>

              <div class="table-wrap mt16">
                <table class="tbl" v-if="paged.length">
                  <thead><tr>
                    <th>药品名称</th>
                    <th style="width:150px">药品编码</th>
                    <th style="width:170px">剂型 / 规格</th>
                    <th style="width:120px">抗菌药物等级</th>
                    <th style="width:80px">状态</th>
                    <th style="width:210px">等级取值资源</th>
                    <th style="width:100px">操作</th>
                  </tr></thead>
                  <tbody>
                    <tr v-for="d in paged" :key="d.id">
                      <td><b>{{ d.name }}</b><div class="muted" v-if="d.demoMark">{{ d.demoMark }}</div></td>
                      <td><code>{{ d.drugCode }}</code></td>
                      <td>{{ d.form }} / {{ d.spec }}</td>
                      <td><level-tag :level="d.level"></level-tag></td>
                      <td><span class="tag" :class="d.enabled?'green':'gray'">{{ d.enabled?'启用':'停用' }}</span></td>
                      <td class="muted">{{ d.levelSource }}</td>
                      <td><a class="btn-link" @click="openAdjust(d)">调整等级</a></td>
                    </tr>
                    <tr class="total-row"><td colspan="7">共 {{ drugs.length }} 条，当前第 {{ page }} 页</td></tr>
                  </tbody>
                </table>
                <empty-state v-else icon="🔎" text="没有符合检索条件的药品，请调整名称、编码、等级或状态条件。"></empty-state>
              </div>
              <ui-pager v-if="drugs.length" :total="drugs.length" v-model:page="page" :size="size"></ui-pager>
            </div>
          </div>
        </template>

        <!-- ==================== Tab 2 职称使用权限 ==================== -->
        <template v-if="tab==='title'">
          <div class="card mt16">
            <div class="card-head">
              <h3>👨‍⚕️ 职称 × 等级权限矩阵（FR-002.1 / FR-002.2）</h3>
              <div class="hint">在岗医师 {{ titleDoctorsTotal }} 人 · 等级 {{ D.LEVELS.length }} 个</div>
            </div>
            <div class="card-body">
              <div class="alert info"><span>💡</span>
                <div>勾选框即该职称在该等级下的生效规则；<b>取消勾选即停用该职称在此等级的使用权限</b>（FR-002.3）。
                任意变更都会先弹出<b>规则变更摘要</b>与影响说明，确认后才写入 FHIR Permission 资源（FR-002.4）。
                保存后临床开单权限判断立即读取最新生效规则，无需重启或重新登录（FR-002.5）。</div>
              </div>

              <div class="table-wrap mt16">
                <table class="tbl">
                  <thead><tr>
                    <th style="width:140px">医生职称</th>
                    <th v-for="lv in D.LEVELS" :key="lv.code" class="text-c" style="width:120px">{{ lv.name }}</th>
                    <th style="width:220px">当前生效等级集合</th>
                    <th style="width:80px">生效状态</th>
                    <th style="width:90px">在岗医师</th>
                    <th style="width:160px">最近修改</th>
                    <th style="width:160px">操作</th>
                  </tr></thead>
                  <tbody :key="'mt'+matrixTick">
                    <tr v-for="r in titleRules" :key="r.title">
                      <td><b>{{ r.titleName }}</b><div class="muted">职称序 {{ r.rank }}</div></td>
                      <td class="text-c" v-for="lv in D.LEVELS" :key="lv.code">
                        <input type="checkbox" :checked="r.matrix[lv.code]"
                               @change="proposeLevel(r, lv.code, $event.target.checked)" style="width:16px;height:16px;cursor:pointer">
                      </td>
                      <td>
                        <span class="chip" v-for="n in r.levelNames" :key="n" style="cursor:default">{{ n }}</span>
                        <span class="muted" v-if="!r.levelNames.length">未配置任何等级</span>
                      </td>
                      <td><span class="tag" :class="toneOf(r)">{{ statusOf(r) }}</span></td>
                      <td>{{ r.doctors }} 人</td>
                      <td class="muted nowrap">{{ r.updatedBy || '—' }}<div>{{ r.updatedAt || '—' }}</div></td>
                      <td>
                        <div class="actions">
                          <a class="btn-link" @click="openTitleEdit(r)">编辑</a>
                          <a class="btn-link danger" @click="disableTitle(r)">停用</a>
                          <a class="btn-link" @click="openTitleLog(r)">修改记录</a>
                        </div>
                      </td>
                    </tr>
                  </tbody>
                </table>
              </div>
              <div class="hint mt8">矩阵取自 FHIR Permission/Permission-map-{等级} 的 allowedTitles 集合，与「权限映射配置」页共用同一份规则。</div>
            </div>
          </div>

          <!-- FR-002.5 保存后立即生效的可验证入口 -->
          <div class="card mt16">
            <div class="card-head"><h3>🧪 用某医师验证最新生效规则（FR-002.5 / FR-005.6）</h3></div>
            <div class="card-body">
              <div class="filter-bar">
                <div class="field"><label>选择医师</label>
                  <select v-model="verify.pract" style="width:260px" @change="clearVerify">
                    <option value="">请选择一位在岗医师</option>
                    <option v-for="d in doctors" :key="d.id" :value="d.id">{{ d.name }} · {{ d.titleName }} · {{ d.dept }}</option>
                  </select>
                </div>
                <div class="field"><label>选择抗菌药物</label>
                  <select v-model="verify.med" style="width:260px" @change="clearVerify">
                    <option value="">请选择一个药品</option>
                    <option v-for="m in meds" :key="m.id" :value="m.id">{{ m.name }}（{{ m.levelName }}）</option>
                  </select>
                </div>
                <div class="field"><label>&nbsp;</label>
                  <button class="btn primary sm" @click="runVerify">执行权限校验</button>
                </div>
              </div>
              <div class="hint mt8">校验按当前生效规则实时计算，合并顺序为「{{ prioLabel }}」（顺序在「医师权限管理」页可调整）。
                判定只读取 FHIR 数据、不落库，可反复验证。</div>

              <div class="mt16" v-if="verify.result">
                <div class="alert success" v-if="!verify.result.error && verify.result.allowed"><span>✅</span>
                  <div><b>允许开立</b> —— {{ verify.result.practitioner.name }}（{{ D.titleName(verify.result.practitioner.title) }}）
                    对「{{ verify.result.medicationName }}」具有使用权限，可直接提交（仍须选择用药目的）。</div>
                </div>
                <div class="alert warn" v-else-if="!verify.result.error"><span>⚠️</span>
                  <div><b>权限不足</b> —— {{ verify.result.practitioner.name }}（{{ D.titleName(verify.result.practitioner.title) }}）
                    对「{{ verify.result.medicationName }}」缺少授权，缺少等级：{{ levelNames(verify.result.missingLevels) }}。</div>
                </div>
                <div class="alert danger" v-else><span>❌</span><div>{{ verify.result.error }}</div></div>

                <div class="kv mt12" v-if="!verify.result.error">
                  <span class="k">医师</span><span>{{ verify.result.practitioner.name }}（{{ verify.result.practitioner.dept || '未归属科室' }} · {{ D.titleName(verify.result.practitioner.title) }} · {{ roleLabel(verify.result.practitioner.roleType) }}）</span>
                  <span class="k">药品等级</span><span><level-tag :level="verify.result.grade"></level-tag> <code>{{ verify.result.grade }}</code> · 取自{{ verify.result.gradeSource }}</span>
                  <span class="k">可使用等级</span><span>{{ levelNames(verify.result.allowedLevels) }}</span>
                  <span class="k">命中规则层</span><span><span class="tag blue">{{ verify.result.hit.srcLabel }}</span> <span class="muted">{{ verify.result.hit.ruleText }}</span></span>
                  <span class="k">判定合并优先级</span><span class="muted">{{ verify.result.priorityLabel }}（采购文件未规定冲突优先级，此为演示配置项）</span>
                  <span class="k">判定说明</span><span>{{ verify.result.reason }}</span>
                  <span class="k">下一步</span><span>{{ verify.result.suggestion }}</span>
                  <span class="k">审批路径</span>
                  <span v-if="verify.result.route">{{ routeNodeText(verify.result.route) }}</span>
                  <span v-else class="muted">该等级尚未发布审批流程，超权限申请无法提交，请先在「审批流程设计」发布版本</span>
                </div>
              </div>
              <empty-state v-else icon="🧭" text="选择一位医师与一个药品，验证职称权限规则保存后的实际生效结果。"></empty-state>
            </div>
          </div>
        </template>

        <!-- ==================== Tab 3 规则变更留痕 ==================== -->
        <div class="card mt16" v-if="tab==='log'">
          <div class="card-head">
            <h3>🕒 规则变更留痕（FR-001.7 / FR-002.6）</h3>
            <div class="field inline">
              <label class="muted">变更类型</label>
              <select v-model="logType">
                <option value="all">全部（等级维护 / 职称权限 / 等级调整）</option>
                <option value="等级维护">等级维护</option>
                <option value="职称权限">职称权限</option>
                <option value="等级调整">等级调整</option>
              </select>
            </div>
          </div>
          <div class="card-body" style="padding:0">
            <div class="table-wrap">
              <table class="tbl" v-if="logs.length">
                <thead><tr>
                  <th style="width:150px">时间</th>
                  <th style="width:110px">变更类型</th>
                  <th>变更内容</th>
                  <th style="width:170px">操作人</th>
                  <th style="width:260px">关联 FHIR 资源</th>
                </tr></thead>
                <tbody>
                  <tr v-for="p in logs" :key="p.id">
                    <td class="nowrap">{{ p.time }}</td>
                    <td><span class="tag blue">{{ p.changeType }}</span></td>
                    <td>{{ p.content }}</td>
                    <td>{{ p.operator }}</td>
                    <td class="muted">
                      <span v-for="(rf,i) in logRefs(p.id)" :key="p.id+i"><code>{{ rf }}</code>{{ i===0 ? '' : '、' }}</span>
                      <span v-if="!logRefs(p.id).length">—</span>
                    </td>
                  </tr>
                  <tr class="total-row"><td colspan="5">共 {{ logs.length }} 条变更记录</td></tr>
                </tbody>
              </table>
              <empty-state v-else icon="🗂️" text="暂无等级或职称规则变更记录，在本页保存一次配置后即会生成。"></empty-state>
            </div>
          </div>
          <div class="card-body">
            <div class="alert info"><span>ℹ️</span>
              <div>留痕数据来源：每次规则保存都写入一条 <b>FHIR Provenance</b>（recorded / agent.who / entity.what 指向被改资源）
                与一条 <b>AuditEvent</b>（type / agent / source.observer），两者按同一 changeType 与内容成对落库，
                因此可以从任一变更记录回溯到被修改的等级或职称规则资源本身。</div>
            </div>
          </div>
        </div>

        <div class="alert mt16" style="background:#f4f7fc;color:var(--text-2)"><span>🧪</span>
          <div>演示数据边界（SRS BR-010）：本页所有等级、职称、药品与人员均为虚构演示数据；保存结果只用于演示本系统的可配置能力，
            不代表真实药品分级结论，也不构成真实处方权限授权。</div>
        </div>

        <!-- ==================== 弹框：编辑等级定义 ==================== -->
        <ui-modal v-if="showEdit && edit" :title="'编辑等级定义 - '+edit.name" @close="showEdit=false">
          <div class="kv mb12">
            <span class="k">等级编码</span><span><code>{{ edit.code }}</code>（编码不可修改，开单与审批留痕按编码引用）</span>
          </div>
          <div class="form-row"><label class="req">等级名称</label>
            <div class="ctrl"><input type="text" v-model="edit.name" placeholder="如：特殊使用"></div>
          </div>
          <div class="form-row"><label>等级说明</label>
            <div class="ctrl"><textarea v-model="edit.desc" placeholder="说明该等级的适用情形与管理要求"></textarea></div>
          </div>
          <div class="form-row"><label>管理备注</label>
            <div class="ctrl"><input type="text" v-model="edit.note" placeholder="如：按医院药事会议纪要调整（演示）"></div>
          </div>
          <div class="divider-label">写入位置</div>
          <div class="alert info"><span>💾</span>
            <div>保存写入 <code>Basic/Basic-grade-{{ edit.code }}</code>，并生成一条「等级维护」Provenance / AuditEvent 留痕。
              停用与调整药品等级时的影响提示使用同一份等级定义数据。</div>
          </div>
          <template #foot>
            <button class="btn" @click="showEdit=false">取消</button>
            <button class="btn primary" @click="saveGradeEdit">保存等级定义</button>
          </template>
        </ui-modal>

        <!-- ==================== 弹框：停用等级影响确认（FR-001.7） ==================== -->
        <ui-modal v-if="showOff && off" :title="'停用等级 - '+off.name" width="wide" @close="showOff=false">
          <div class="alert warn"><span>⚠️</span>
            <div>停用等级前请先确认以下影响：{{ off.impact.snapshotNote }}。</div>
          </div>
          <div class="stat-grid cols-3 mt16">
            <div class="stat-card"><div class="label">受影响药品</div><div class="value">{{ off.impact.drugCount }}<small>种</small></div><div class="delta flat">仍按原编码引用</div></div>
            <div class="stat-card"><div class="label">进行中审批</div><div class="value">{{ off.impact.runningCount }}<small>件</small></div><div class="delta down">保留开单时等级快照</div></div>
            <div class="stat-card"><div class="label">等级编码</div><div class="value" style="font-size:16px">{{ off.code }}</div><div class="delta flat">不删除、不改码</div></div>
          </div>
          <div class="divider-label">受影响药品清单</div>
          <div class="chip-row" v-if="off.impact.drugs.length">
            <span class="chip" v-for="(n,i) in off.impact.drugs" :key="'d'+i" style="cursor:default">{{ n }}</span>
          </div>
          <div class="muted" v-else>该等级下当前没有关联药品。</div>
          <div class="divider-label">审批影响</div>
          <div class="kv">
            <span class="k">进行中审批</span><span>{{ off.impact.flowNote }}</span>
            <span class="k">等级快照</span><span>已创建的审批任务保留其开单时所使用的等级快照；停用等级不会改写历史任务的等级与流程版本（SRS BR-006）。</span>
            <span class="k">新的开单</span><span>停用后本页面不再建议把新药品关联到该等级，已有的药品关联关系不会被自动删除。</span>
          </div>
          <div class="form-row mt16"><label>停用原因</label>
            <div class="ctrl"><input type="text" v-model="off.note" placeholder="如：该等级并入特殊使用级管理（演示）"></div>
          </div>
          <template #foot>
            <button class="btn" @click="showOff=false">取消</button>
            <button class="btn danger" @click="confirmDisable">确认停用</button>
          </template>
        </ui-modal>

        <!-- ==================== 弹框：新增等级分类（FR-001.1） ==================== -->
        <ui-modal v-if="showAdd" title="新增等级分类（FR-001.1）" @close="showAdd=false">
          <div class="form-row"><label class="req">等级名称</label>
            <div class="ctrl">
              <input type="text" v-model="add.name" :class="{invalid: addErr.name}" placeholder="如：重点监控使用">
              <span class="err-text" v-if="addErr.name">请填写等级名称</span>
            </div>
          </div>
          <div class="form-row"><label class="req">等级编码</label>
            <div class="ctrl">
              <input type="text" v-model="add.code" :class="{invalid: addErr.code}" placeholder="英文字母/数字/-，如 watch">
              <span class="err-text" v-if="addErr.code===1">请填写等级编码</span>
              <span class="err-text" v-if="addErr.code===2">编码只允许字母、数字、减号、下划线与点</span>
              <span class="err-text" v-if="addErr.code===3">该编码已存在，请换一个</span>
              <span class="hint">编码写入 FHIR 值集 amr-level 后即为长期引用标识，创建后不可修改。</span>
            </div>
          </div>
          <div class="form-row"><label>等级说明</label>
            <div class="ctrl"><textarea v-model="add.desc" placeholder="说明该等级的管理含义（演示口径）"></textarea></div>
          </div>
          <div class="form-row"><label>标识颜色</label>
            <div class="ctrl">
              <input type="text" v-model="add.color" placeholder="#7c3aed">
              <span class="hint">十六进制色值，用于等级标签与统计图配色。</span>
            </div>
          </div>
          <div class="form-row"><label class="req">等级顺序</label>
            <div class="ctrl">
              <input type="number" v-model="add.rank" :class="{invalid: addErr.rank}" min="1" step="1">
              <span class="err-text" v-if="addErr.rank">请填写大于 0 的顺序号</span>
              <span class="hint">数值越大表示级别越高，开单时按「医师可用等级 vs 药品等级」比较。</span>
            </div>
          </div>
          <div class="form-row"><label>备注</label>
            <div class="ctrl"><input type="text" v-model="add.note" placeholder="新增依据（演示）"></div>
          </div>
          <div class="divider-label">新增后的联动</div>
          <div class="alert info"><span>💡</span>
            <div>确认新增将写入三处 FHIR 资源：<code>Basic</code>（等级定义）、<code>Permission/Permission-map-{编码}</code>（职称映射，初始为空）、
              <code>Permission/Permission-gate-{编码}</code>（卡控规则）。新等级随即出现在职称权限矩阵、药品检索与开单选药的等级选项中。</div>
          </div>
          <template #foot>
            <button class="btn" @click="showAdd=false">取消</button>
            <button class="btn primary" @click="commitAdd">确认新增</button>
          </template>
        </ui-modal>

        <!-- ==================== 弹框：调整药品等级（FR-001.7 / FR-004.5） ==================== -->
        <ui-modal v-if="showAdjust && adjust" :title="'调整药品等级 - '+adjust.drug.name" width="wide" @close="showAdjust=false">
          <div class="kv mb12">
            <span class="k">药品</span><span>{{ adjust.drug.name }}（<code>{{ adjust.drug.drugCode }}</code> · {{ adjust.drug.form }} / {{ adjust.drug.spec }}）</span>
            <span class="k">当前等级</span><span><level-tag :level="adjust.from"></level-tag></span>
            <span class="k">目标等级</span>
            <span>
              <select v-model="adjust.to">
                <option v-for="g in grades" :key="g.code" :value="g.code">{{ g.name }}{{ g.enabled?'':'（已停用）' }}</option>
              </select>
            </span>
          </div>
          <div class="divider-label">影响提示</div>
          <div class="table-wrap">
            <table class="tbl">
              <thead><tr><th style="width:180px">影响项</th><th>说明</th></tr></thead>
              <tbody>
                <tr><td>目标等级状态</td>
                  <td>
                    <span v-if="adjustTarget && adjustTarget.enabled">「{{ adjustTarget.name }}」启用中，当前已有 {{ adjustTarget.drugCount }} 种药品</span>
                    <span v-else class="tag red">「{{ adjustTarget ? adjustTarget.name : '' }}」已停用，不能把新药品关联到停用等级</span>
                  </td>
                </tr>
                <tr><td>原等级进行中审批</td>
                  <td>{{ adjust.impact.runningCount }} 件 —— {{ adjust.impact.flowNote }}</td>
                </tr>
                <tr><td>等级快照</td>
                  <td>已创建的审批任务保留其开单时所使用的等级快照；本次调整只影响之后的新开立请求（FR-001.7 / FR-004.5）。</td>
                </tr>
                <tr><td>医师开单判定</td>
                  <td>调整保存后，医师开单与权限校验按新等级实时判定，超权限的申请会按新等级对应的已发布流程版本触发审批。</td>
                </tr>
              </tbody>
            </table>
          </div>
          <div class="form-row mt16"><label>调整依据</label>
            <div class="ctrl"><input type="text" v-model="adjust.note" placeholder="如：药事管理与药物治疗学会议结论（演示）"></div>
          </div>
          <div class="alert warn mt8"><span>⚠️</span>
            <div>等级调整会同步修改 <code>Medication</code> 与对应 <code>MedicationKnowledge</code> 的等级，并生成「等级调整」留痕；
              历史申请与审批任务的等级快照、绑定的流程版本不会被改写。</div>
          </div>
          <template #foot>
            <button class="btn" @click="showAdjust=false">取消</button>
            <button class="btn primary" @click="commitAdjust">确认调整等级</button>
          </template>
        </ui-modal>

        <!-- ==================== 弹框：职称权限变更摘要（FR-002.4） ==================== -->
        <ui-modal v-if="showTitle && titleEdit" :title="'职称权限变更摘要 - '+titleEdit.titleName" width="wide" @close="showTitle=false">
          <div class="divider-label">勾选可使用的等级（FR-002.2）</div>
          <div class="checks">
            <label v-for="lv in D.LEVELS" :key="lv.code">
              <input type="checkbox" :value="lv.code" v-model="titleEdit.levels"> {{ lv.name }}
            </label>
          </div>
          <div class="hint mt8">全部取消即停用该职称的等级使用权限（FR-002.3），保存后该职称医师开立任何等级药品都需走审批或个人/科室授权。</div>

          <div class="divider-label">变更摘要</div>
          <div class="table-wrap" v-if="titleDiff.length">
            <table class="tbl">
              <thead><tr><th style="width:160px">等级</th><th style="width:120px">变更</th><th>说明</th></tr></thead>
              <tbody>
                <tr v-for="d in titleDiff" :key="d.level">
                  <td><level-tag :level="d.level"></level-tag></td>
                  <td><span class="tag" :class="d.to?'green':'red'">{{ d.to?'新增':'取消' }}</span></td>
                  <td>{{ titleEdit.titleName }} {{ d.text }}（{{ d.from?'原为开放':'原为限制' }} → {{ d.to?'开放':'限制' }}）</td>
                </tr>
              </tbody>
            </table>
          </div>
          <empty-state v-else icon="🟰" text="尚未发生任何变更，勾选调整后再保存。"></empty-state>

          <div class="divider-label">影响范围</div>
          <div class="kv">
            <span class="k">在岗医师</span><span>{{ titleEdit.doctors }} 位{{ D.titleName(titleEdit.title) }}医师的开单判定会随之变化</span>
            <span class="k">生效方式</span><span>保存后临床开单权限判断立即读取最新生效规则（FR-002.5），无需重启程序；已在流程中的审批任务保留其开单时的判定依据与流程版本</span>
            <span class="k">写入位置</span><span><code>Permission/Permission-map-{等级}</code> 的 allowedTitles 集合，并联动同等级卡控规则</span>
          </div>
          <div class="form-row mt16"><label>变更说明</label>
            <div class="ctrl"><input type="text" v-model="titleEdit.note" placeholder="如：按 2026 年药事会议调整（演示）"></div>
          </div>
          <template #foot>
            <button class="btn" @click="showTitle=false">取消</button>
            <button class="btn primary" :disabled="!titleDiff.length" @click="saveTitle">确认保存规则</button>
          </template>
        </ui-modal>

        <!-- ==================== 弹框：某职称规则修改记录（FR-002.6） ==================== -->
        <ui-modal v-if="showTitleLog && titleLog" :title="'修改记录 - '+titleLog.titleName" width="wide" @close="showTitleLog=false">
          <div class="table-wrap" v-if="titleLog.rows.length">
            <table class="tbl">
              <thead><tr><th style="width:150px">时间</th><th>变更内容</th><th style="width:170px">操作人</th></tr></thead>
              <tbody>
                <tr v-for="p in titleLog.rows" :key="p.id">
                  <td class="nowrap">{{ p.time }}</td>
                  <td>{{ p.content }}</td>
                  <td>{{ p.operator }}</td>
                </tr>
              </tbody>
            </table>
          </div>
          <empty-state v-else icon="🗂️" text="该职称规则尚无修改记录。"></empty-state>
          <div class="alert info mt12"><span>ℹ️</span>
            <div>记录来源为 FHIR Provenance（changeType=职称权限），可回溯到被修改的 <code>Permission/Permission-map-*</code> 资源。</div>
        </div>
          <template #foot><button class="btn" @click="showTitleLog=false">关闭</button></template>
        </ui-modal>
      </div>
    </div>`
  };
})(window);
