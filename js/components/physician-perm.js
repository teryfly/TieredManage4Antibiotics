/* =====================================================================
 * physician-perm.js —— P-2-2 医师权限管理（系统管理员 / 规则管理员）
 * SRS FR-003 科室与个人权限维护：按科室查看医师列表与授权等级、配置科室授权、
 * 维护个人授权、显示医师权限的四层来源与最终判定，并可查询权限变更前后内容。
 * 读写全部落到真实 FHIR R4 资源（Organization / PractitionerRole /
 * Permission / Basic 合并优先级 / Provenance+AuditEvent 留痕）。
 * ===================================================================== */
(function (global) {
  'use strict';
  var AMS = global.AMS, Svc = global.Svc, D = global.Domain, App = global.App;
  var Ap = global.Approval, F = global.FHIR;

  var ROUTE = 'physician-perm';
  var LAYER_LABEL = { person: '个人授权', department: '科室授权', title: '职称规则' };
  var LAYER_DESC = {
    person: '为具体医师维护的授权等级集合，可设定授权名称与到期日',
    department: '按科室维护的授权等级集合，对本科室全部医师生效',
    title: '按医生职称维护的等级矩阵（FR-002），全院同职称医师共用'
  };

  AMS.pages[ROUTE] = {
    data: function () {
      return {
        orgId: '',
        prioDraft: [],
        showPrio: false,
        probe: { pract: '', result: null },
        showDept: false, deptEdit: null,   // {orgId,name,before,beforeText,levels,note,doctors,hitDocs}
        showPerson: false, personEdit: null, // {pract,name,titleName,levels,grantLabel,expires,note,beforeText}
        detailId: '',
        showLog: true,
        logType: 'all'
      };
    },
    created: function () {
      this.prioDraft = Svc.srs.mergePriority().order.slice();
      // 默认打开一个「授权等级不全且有在岗医师」的科室，进入即可演示权限不足与缺少等级
      var list = Svc.srs.departments();
      var pick = list.filter(function (o) {
        return o.grant && o.grant.levels.length < D.LEVELS.length && o.doctors >= 2;
      })[0] || list.filter(function (o) { return o.doctors > 0; })[0] || list[0];
      if (pick) this.orgId = pick.id;
    },
    computed: {
      // 模板不能裸用模块级常量，显式暴露
      D: function () { return D; },
      Ap: function () { return Ap; },
      user: function () { return App.currentUser(); },
      role: function () { return App.state.roleCode; },
      canView: function () { return D.canAccess(this.role, ROUTE); },
      layerLabel: function () { return LAYER_LABEL; },

      /* ---------- FR-003.1/FR-003.2 科室与在岗医师 ---------- */
      depts: function () {
        App.state.refresh;
        return Svc.srs.departments().map(function (o) {
          return Object.assign({}, o, {
            grantNames: o.grant ? o.grant.levels.map(D.levelName) : [],
            grantText: o.grant && o.grant.levels.length ? o.grant.levels.map(D.levelName).join('、') : '未配置'
          });
        });
      },
      dept: function () {
        var id = this.orgId;
        var list = this.depts;
        if (!list.length) return null;
        var hit = list.filter(function (o) { return o.id === id; })[0];
        return hit || list[0];
      },
      docs: function () {
        var d = this.dept;
        if (!d) return [];
        App.state.refresh;
        return Svc.srs.departmentDoctors(d.id).map(function (r) {
          var pr = Ap.personRule(r.practitioner);
          var authz = Ap.authorizations(r.practitioner);
          var pl = authz && authz.layers ? authz.layers.person : null;
          return Object.assign({}, r, {
            person: pr ? {
              label: pr.ext.grantLabel || '个人授权', expires: pr.ext.expires || '',
              levels: (pr.ext.levels || []).map(D.levelName), note: pr.ext.note || '',
              status: pr.status, expired: !!(pl && pl.expired)
            } : null
          });
        });
      },
      deptHitDocs: function () {
        return this.docs.filter(function (r) { return r.hitLayer === '科室授权'; });
      },
      doctorsAll: function () {
        App.state.refresh;
        return Svc.srs.doctorDirectory().filter(function (d) { return d.dept; });
      },
      // 岗位角色中文名取自 FHIR CodeSystem/amr-role（演示岗位角色字典）
      roleDict: function () {
        App.state.refresh;
        var cs = F.read('CodeSystem', 'CodeSystem-amr-role');
        var map = {};
        ((cs && cs.concept) || []).forEach(function (c) { map[c.code] = c.display; });
        return map;
      },

      /* ---------- 合并优先级（SRS §3.2 / BR-002：采购文件未规定冲突优先级） ---------- */
      prio: function () {
        App.state.refresh;
        var m = Svc.srs.mergePriority();
        return { order: m.order, label: m.label, emptyMeans: m.emptyMeans, resId: 'Basic-authz-merge-priority' };
      },
      prioDirty: function () {
        return this.prioDraft.join(',') !== this.prio.order.join(',');
      },
      probeId: function () { return this.probe.pract || this.probeDefault; },
      // 默认探针选一位三层规则都配置过的医师，命中层最容易随优先级变化
      probeDefault: function () {
        var list = this.doctorsAll;
        var withPerson = list.filter(function (d) { return d.hit === '个人授权'; })[0];
        return (withPerson || list[0] || { id: '' }).id;
      },
      probeDetail: function () {
        var id = this.probeId;
        if (!id) return null;
        App.state.refresh;
        return Svc.srs.doctorDetail(id);
      },

      /* ---------- FR-003.4/FR-003.5 医师权限详情 ---------- */
      detail: function () {
        if (!this.detailId) return null;
        App.state.refresh;
        return Svc.srs.doctorDetail(this.detailId);
      },
      detailLayers: function () {
        var d = this.detail;
        if (!d) return [];
        return d.priority.map(function (name) {
          var L = d.layers[name];
          if (!L) return null;
          return {
            layer: name, label: LAYER_LABEL[name] || L.label, desc: LAYER_DESC[name] || '',
            configured: L.configured, source: L.source,
            levels: L.levels.map(D.levelName),
            expired: !!L.expired, expires: L.expires || '', ruleId: L.ruleId || '',
            hit: d.hit.layer === name
          };
        }).filter(Boolean).concat([{
          layer: 'final', label: '最终可使用等级', desc: '按合并优先级取第一个已配置且非空的层作为本次判定依据',
          configured: true, source: d.hit.ruleText, levels: d.levelNames,
          expired: false, expires: '', ruleId: d.hit.srcId || '', hit: true
        }]);
      },
      detailLevels: function () {
        var d = this.detail;
        if (!d) return [];
        return D.LEVELS.map(function (lv) { return d.byLevel[lv.code]; });
      },
      // doctorDetail.missing 是等级编码，界面必须给出中文等级名（FR-003.5 不允许只说「无权限」）
      detailMissing: function () {
        var d = this.detail;
        return d ? d.missing.map(function (c) { return D.levelName(c) + '（' + c + '）'; }) : [];
      },

      /* ---------- FR-003.6 权限变更前后查询 ---------- */
      personGrants: function () {
        App.state.refresh;
        return F.search('Permission', function (r) {
          return r.ext && r.ext.subjectType === 'person' && r.ext.category === 'authorization';
        }).map(function (r) {
          var pid = Ap.idOf(r.ext.subjectRef || '');
          var authz = Ap.authorizations(pid);
          var info = Ap.practitionerInfo(pid) || { name: r.ext.practitionerName || pid, dept: '', title: '' };
          return {
            id: r.id, pract: pid, name: info.name, dept: info.dept,
            titleName: D.titleName(info.title), status: r.status,
            levels: (r.ext.levels || []).map(D.levelName),
            grantLabel: r.ext.grantLabel || '个人授权', expires: r.ext.expires || '',
            note: r.ext.note || '',
            before: r.ext.before, after: r.ext.after,
            expired: !!(authz && authz.layers && authz.layers.person && authz.layers.person.expired),
            effective: authz ? authz.layers.person.levels.map(D.levelName) : []
          };
        }).sort(function (a, b) { return (b.name || '').localeCompare(a.name || '', 'zh'); });
      },
      deptGrants: function () {
        App.state.refresh;
        return F.search('Permission', function (r) {
          return r.ext && r.ext.subjectType === 'department' && r.ext.category === 'authorization';
        }).map(function (r) {
          return {
            id: r.id, name: r.ext.deptName || r.ext.subjectRef, status: r.status,
            levels: (r.ext.levels || []).map(D.levelName), note: r.ext.note || '',
            before: r.ext.before, after: r.ext.after
          };
        });
      },
      logs: function () {
        App.state.refresh;
        var rows = [];
        ['科室授权', '个人授权', '授权优先级'].forEach(function (t) {
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
      levelNames: function (codes) {
        return (codes || []).length ? (codes || []).map(D.levelName).join('、') : '无';
      },
      roleLabel: function (code) { return this.roleDict[code] || D.approvalRoleName(code) || code; },
      orderText: function (order) {
        return (order || []).map(function (c) { return LAYER_LABEL[c] || c; }).join(' ＞ ');
      },
      layerState: function (L) {
        if (L.layer === 'final') return { cls: 'blue', text: '本次判定结果' };
        if (L.expired) return { cls: 'red', text: '已到期' };
        if (!L.configured) return { cls: 'gray', text: '未配置' };
        return L.levels.length ? { cls: 'green', text: '已配置' } : { cls: 'orange', text: '已配置但等级为空' };
      },
      selectDept: function (o) { this.orgId = o.id; },

      /* ---------- 某医师的个人授权概况（列表显示到期与已到期，FR-003.3） ---------- */
      personView: function (pract) {
        var r = Ap.personRule(pract);
        if (!r) return { has: false };
        var authz = Ap.authorizations(pract);
        var layer = authz && authz.layers ? authz.layers.person : null;
        return {
          has: true, label: r.ext.grantLabel || '个人授权', expires: r.ext.expires || '',
          note: r.ext.note || '', status: r.status,
          levels: (r.ext.levels || []).map(D.levelName),
          expired: !!(layer && layer.expired),
          effective: layer ? layer.levels.length > 0 : false
        };
      },

      /* ---------- FR-003.2 配置科室授权（先展示变更前后对比） ---------- */
      openDeptEdit: function () {
        var d = this.dept;
        if (!d) { App.toast('请先选择一个科室', 'error'); return; }
        var rule = Ap.deptRule(d.id);
        var before = rule ? (rule.ext.levels || []).slice() : [];
        this.deptEdit = {
          orgId: d.id, name: d.name, kind: d.kind,
          doctors: d.doctors, hitDocs: this.deptHitDocs.length,
          before: before, beforeText: before.length ? before.map(D.levelName).join('、') : '（未配置）',
          levels: before.slice(), note: rule ? (rule.ext.note || '') : ''
        };
        this.showDept = true;
      },
      deptDiff: function () {
        var e = this.deptEdit;
        if (!e) return [];
        return D.LEVELS.map(function (lv) {
          var from = e.before.indexOf(lv.code) >= 0, to = e.levels.indexOf(lv.code) >= 0;
          if (from === to) return null;
          return { level: lv.code, levelName: lv.name, from: from, to: to, text: from ? '取消授权' : '新增授权' };
        }).filter(Boolean);
      },
      deptDiffText: function (code, kind) {
        var e = this.deptEdit;
        if (!e) return false;
        var from = e.before.indexOf(code) >= 0, to = e.levels.indexOf(code) >= 0;
        return kind === 'add' ? (!from && to) : (from && !to);
      },
      deptDiffSummary: function () {
        return this.deptDiff().map(function (x) { return x.levelName + '（' + x.text + '）'; }).join('、');
      },
      saveDept: function () {
        var e = this.deptEdit;
        if (!this.deptDiff().length) { App.toast('科室授权未发生变化，无需保存', 'error'); return; }
        if (!e.levels.length && !confirm('科室授权等级全部取消后，本科室医师将回退到职称规则判定，确认保存？')) return;
        var r = Svc.srs.saveDeptGrant(e.orgId, e.levels, e.note);
        App.bump();
        this.showDept = false;
        App.toast('科室「' + e.name + '」授权已保存：' + r.before + ' → ' + r.after + '（FR-003.7）');
      },

      /* ---------- FR-003.3 个人授权：增 / 改 / 取消 ---------- */
      openPersonEdit: function (doc) {
        var r = Ap.personRule(doc.practitioner);
        this.personEdit = {
          pract: doc.practitioner, name: doc.name, titleName: doc.titleName, dept: (this.dept || { name: '' }).name,
          beforeText: r && (r.ext.levels || []).length ? r.ext.levels.map(D.levelName).join('、') : '（未配置）',
          levels: r ? (r.ext.levels || []).slice() : [],
          grantLabel: r ? (r.ext.grantLabel || '') : '',
          expires: r ? (r.ext.expires || '') : '',
          note: r ? (r.ext.note || '') : ''
        };
        this.showPerson = true;
      },
      savePerson: function () {
        var e = this.personEdit;
        if (e.levels.length && !e.grantLabel) { App.toast('请填写授权名称，便于留痕与追溯', 'error'); return; }
        if (e.expires && e.expires < global.Clock.date()) {
          if (!confirm('到期日 ' + e.expires + ' 已早于当前演示日期，保存后该授权将立即判定为「已到期」，确认继续？')) return;
        }
        var r = Svc.srs.savePersonGrant(e.pract, e.levels, e.grantLabel, e.expires, e.note);
        App.bump();
        this.showPerson = false;
        App.toast('医师「' + e.name + '」个人授权已保存：' + r.before + ' → ' + r.after);
      },
      revokePerson: function (doc) {
        var v = this.personView(doc.practitioner);
        if (!v.has || !v.levels.length) { App.toast('该医师当前没有个人授权，无需取消', 'error'); return; }
        if (!confirm('确认取消医师「' + doc.name + '」的个人授权（' + v.label + '）？取消后其权限回退到科室授权与职称规则判定。')) return;
        var r = Svc.srs.savePersonGrant(doc.practitioner, [], v.label, '', '界面操作取消个人授权');
        App.bump();
        App.toast('已取消「' + doc.name + '」个人授权：' + r.before + ' → ' + r.after);
      },

      /* ---------- FR-003.4 医师权限详情 ---------- */
      openDetail: function (doc) { this.detailId = doc.practitioner; },
      detailByPract: function (pract) { this.detailId = pract; },
      closeDetail: function () { this.detailId = ''; },

      /* ---------- 合并优先级调整（SRS §3.2：演示配置项） ---------- */
      moveLayer: function (idx, dir) {
        var to = idx + dir;
        if (to < 0 || to >= this.prioDraft.length) return;
        var arr = this.prioDraft.slice();
        var t = arr[idx]; arr[idx] = arr[to]; arr[to] = t;
        this.prioDraft = arr;
      },
      resetPrio: function () { this.prioDraft = this.prio.order.slice(); },
      savePrio: function () {
        var before = Svc.srs.doctorDetail(this.probeId);
        if (!before) { App.toast('请先选择用于验证命中变化的医师', 'error'); return; }
        var snap = { name: before.info.name, order: before.priority.slice(), label: before.priorityLabel,
          srcLabel: before.hit.srcLabel, ruleText: before.hit.ruleText, levels: before.levelNames.slice() };
        Svc.srs.setMergePriority(this.prioDraft.slice());
        App.bump();
        var after = Svc.srs.doctorDetail(this.probeId);
        this.prioDraft = this.prio.order.slice();
        this.probe.result = {
          name: after.info.name,
          before: snap,
          after: { order: after.priority.slice(), label: after.priorityLabel,
            srcLabel: after.hit.srcLabel, ruleText: after.hit.ruleText, levels: after.levelNames.slice() },
          changed: snap.srcLabel !== after.hit.srcLabel || snap.levels.join('、') !== after.levelNames.join('、')
        };
        App.toast('合并优先级已保存；探针医师「' + after.info.name + '」命中层：'
          + snap.srcLabel + ' → ' + after.hit.srcLabel);
      },
      logRefs: function (id) {
        var p = F.read('Provenance', id);
        return ((p && p.entity) || []).map(function (e) { return e.what ? e.what.reference : ''; }).filter(Boolean);
      },
      grantText: function (v) { return v === null || v === undefined || v === '' ? '（首次配置）' : v; },
      identityName: function (id) { var u = D.identity(id); return u ? u.display : id; },
      identityNote: function (id) { var u = D.identity(id); return u ? u.note : id; },
      switchTo: function (id) { App.switchIdentity(id); }
    },
    template: `
    <div>
      <div v-if="!canView" class="card"><div class="card-body">
        <empty-state icon="🔒" text="本页面仅对「系统管理员 / 抗菌药物管理规则管理员」开放，请使用顶部演示角色切换后查看。"></empty-state>
      </div></div>

      <div v-else>
        <div class="alert info mb12">
          <span>ℹ️</span>
          <div>本页对应 SRS FR-003（科室与个人权限维护）。按科室查看医师、职称与当前授权等级，可配置科室授权与医师个人授权，
            并按「职称规则 / 科室授权 / 个人授权 / 最终可使用等级」四层展示权限来源与命中结果。
            数据读写 FHIR R4 的 <code>Organization</code>、<code>PractitionerRole</code>、<code>Permission</code> 与 <code>Basic</code> 资源；
            科室、医师与授权均为<b>虚构演示数据</b>，不构成真实处方权限授权。</div>
        </div>

        <!-- ============ 合并优先级（SRS §3.2 / BR-002） ============ -->
        <div class="card">
          <div class="card-head">
            <h3>⚖️ 权限合并优先级（可调整的配置项）</h3>
            <div class="btn-row">
              <button class="btn sm" @click="resetPrio" :disabled="!prioDirty">放弃未保存的调整</button>
              <button class="btn primary sm" @click="savePrio" :disabled="!prioDirty">保存并演示命中变化</button>
            </div>
          </div>
          <div class="card-body">
            <div class="grid-2">
              <div>
                <div class="section-title">当前生效顺序（已落库）</div>
                <div class="kv">
                  <span class="k">生效顺序</span><span>{{ prio.label }}</span>
                  <span class="k">空规则处理</span><span>{{ prio.emptyMeans==='deny' ? '三层均无配置时禁止使用（需审批或个人/科室授权）' : '三层均无配置时仅允许非限制使用' }}</span>
                  <span class="k">存储位置</span><span><code>Basic/{{ prio.resId }}</code></span>
                </div>
                <div class="alert warn mt12"><span>⚠️</span>
                  <div><b>采购文件未规定三层授权冲突时的优先级算法</b>，此处顺序与「取第一个已配置且非空的层」的合并方式
                    都是<b>演示配置项，可自行调整</b>；界面在每次权限判定时都会展示实际命中的规则来源，便于核对（SRS §3.2 / BR-002）。</div>
                </div>
              </div>
              <div>
                <div class="section-title">调整顺序（上移 / 下移，保存后生效）</div>
                <div class="table-wrap">
                  <table class="tbl">
                    <thead><tr><th style="width:60px">序位</th><th style="width:110px">授权层</th><th>说明</th><th style="width:110px">调整</th></tr></thead>
                    <tbody>
                      <tr v-for="(name,i) in prioDraft" :key="name">
                        <td>{{ i+1 }}</td>
                        <td><b>{{ layerLabel[name] || name }}</b></td>
                        <td class="muted">{{ name==='person' ? '为具体医师维护的授权等级集合，可设定授权名称与到期日'
                          : name==='department' ? '按科室维护的授权等级集合，对本科室全部医师生效'
                          : '按医生职称维护的等级矩阵（FR-002），全院同职称医师共用' }}</td>
                        <td>
                          <div class="actions">
                            <a class="btn-link" :style="{visibility: i===0?'hidden':'visible'}" @click="moveLayer(i,-1)">上移</a>
                            <a class="btn-link" :style="{visibility: i===prioDraft.length-1?'hidden':'visible'}" @click="moveLayer(i,1)">下移</a>
                          </div>
                        </td>
                      </tr>
                    </tbody>
                  </table>
                </div>
                <div class="hint mt8" v-if="prioDirty">当前为未保存的调整顺序，与生效顺序不同；保存后立即影响所有医师的权限判定。</div>
                <div class="hint mt8" v-else>调整顺序与生效顺序一致。</div>
              </div>
            </div>

            <div class="divider-label">保存前后命中变化演示</div>
            <div class="filter-bar">
              <div class="field"><label>选择探针医师</label>
                <select v-model="probe.pract" style="width:280px">
                  <option value="">默认（三层规则最完整的医师）</option>
                  <option v-for="d in doctorsAll" :key="d.id" :value="d.id">{{ d.name }} · {{ d.titleName }} · {{ d.dept }}</option>
                </select>
              </div>
              <div class="field"><label>当前判定</label>
                <div style="padding-top:6px" v-if="probeDetail">
                  命中 <span class="tag blue">{{ probeDetail.hit.srcLabel }}</span>
                  <span class="muted">{{ probeDetail.hit.ruleText }}</span>
                  <div class="muted">可使用等级：{{ probeDetail.levelNames.length ? probeDetail.levelNames.join('、') : '无' }}</div>
                </div>
                <span v-else class="muted">未选择医师</span>
              </div>
            </div>
            <div class="table-wrap mt12" v-if="probe.result">
              <table class="tbl">
                <thead><tr><th style="width:120px">项目</th><th>调整前</th><th>调整后</th></tr></thead>
                <tbody>
                  <tr><td>探针医师</td><td colspan="2">{{ probe.result.name }}</td></tr>
                  <tr><td>合并顺序</td><td>{{ orderText(probe.result.before.order) }}</td>
                      <td>{{ orderText(probe.result.after.order) }}</td></tr>
                  <tr><td>命中规则层</td><td><span class="tag gray">{{ probe.result.before.srcLabel }}</span></td>
                      <td><span class="tag" :class="probe.result.changed?'orange':'gray'">{{ probe.result.after.srcLabel }}</span></td></tr>
                  <tr><td>规则原文</td><td class="muted">{{ probe.result.before.ruleText }}</td><td class="muted">{{ probe.result.after.ruleText }}</td></tr>
                  <tr><td>可使用等级</td><td>{{ probe.result.before.levels.join('、') || '无' }}</td>
                      <td>{{ probe.result.after.levels.join('、') || '无' }}</td></tr>
                  <tr><td>结论</td>
                    <td colspan="2">
                      <span v-if="probe.result.changed">优先级调整改变了该医师的实际命中层与可用等级，界面展示的规则来源即为本次判定依据。</span>
                      <span v-else class="muted">该医师的命中层与可用等级未变化（当前仅一层规则非空，或调整未改变第一个非空层）。</span>
                    </td></tr>
                </tbody>
              </table>
            </div>
          </div>
        </div>

        <!-- ============ 科室 + 医师列表 ============ -->
        <div class="card mt16">
          <div class="card-head">
            <h3>🏥 科室与医师权限（FR-003.1 / FR-003.2）</h3>
            <div class="btn-row">
              <span class="hint" v-if="dept">当前科室：{{ dept.name }}</span>
              <button class="btn primary sm" @click="openDeptEdit">配置科室授权</button>
            </div>
          </div>
          <empty-state v-if="!dept" icon="🏥" text="FHIR 服务端没有 orgKind=department 的组织资源，请先在「演示数据管理」初始化科室。"></empty-state>
          <div class="row" v-else style="padding:0;gap:0">
            <!-- 左：科室列表 -->
            <div style="flex:0 0 300px;max-width:300px;border-right:1px solid var(--border);padding:12px 14px">
              <div class="section-title">临床与药事科室（{{ depts.length }}）</div>
              <div class="rank-list">
                <div class="r" v-for="o in depts" :key="o.id" @click="selectDept(o)"
                     :style="{background: dept.id===o.id ? '#eef4fd' : ''}">
                  <span class="idx" :class="{top: dept.id===o.id}">{{ o.doctors }}</span>
                  <div class="nm">
                    <b>{{ o.name }}</b>
                    <div class="muted">{{ o.kind || '科室' }} · 在岗医师 {{ o.doctors }} 人</div>
                    <div class="muted">科室授权：{{ o.grantText }}</div>
                  </div>
                  <div style="text-align:right">
                    <span class="tag" :class="o.approvable?'blue':'gray'">{{ o.approvable?'有审批职责':'无审批职责' }}</span>
                  </div>
                </div>
              </div>
              <div class="hint mt8">在岗医师数来自 FHIR PractitionerRole 按 Organization 归属统计。</div>
            </div>

            <!-- 右：该科室医师 -->
            <div class="col" style="padding:16px 18px;min-width:520px">
              <div class="kv mb12">
                <span class="k">科室</span><span>{{ dept.name }}（{{ dept.kind || '科室' }}）</span>
                <span class="k">科室授权</span>
                <span>
                  <span class="chip" v-for="n in dept.grantNames" :key="n" style="cursor:default">{{ n }}</span>
                  <span class="muted" v-if="!dept.grantNames.length">未配置科室授权，本科室医师按职称规则判定</span>
                  <span class="muted" v-if="dept.grant && dept.grant.note"> · {{ dept.grant.note }}</span>
                </span>
                <span class="k">当前命中科室层的医师</span><span>{{ deptHitDocs.length }} 位（其余按个人授权或职称规则命中）</span>
              </div>

              <div class="table-wrap">
                <table class="tbl" v-if="docs.length">
                  <thead><tr>
                    <th style="width:90px">姓名</th>
                    <th style="width:100px">职称</th>
                    <th style="width:150px">岗位角色</th>
                    <th>当前可开等级</th>
                    <th style="width:100px">命中授权层</th>
                    <th style="width:190px">个人授权</th>
                    <th style="width:120px">演示身份</th>
                    <th style="width:150px">操作</th>
                  </tr></thead>
                  <tbody>
                    <tr v-for="d in docs" :key="d.practitioner">
                      <td><b>{{ d.name }}</b><div class="muted" v-if="d.canApprove">承担审批</div></td>
                      <td>{{ d.titleName || '—' }}</td>
                      <td>
                        <span class="tag gray" v-for="rt in d.roleTypes" :key="rt">{{ roleLabel(rt) }}</span>
                      </td>
                      <td>
                        <span class="chip" v-for="n in d.levels" :key="n" style="cursor:default">{{ n }}</span>
                        <span class="muted" v-if="!d.levels.length">无可开等级，开立任何抗菌药物都需授权或审批</span>
                      </td>
                      <td><span class="tag blue">{{ d.hitLayer }}</span></td>
                      <td>
                        <template v-if="d.person">
                          <div>{{ d.person.label }}</div>
                          <div class="muted">等级：{{ d.person.levels.length ? d.person.levels.join('、') : '无' }}</div>
                          <span class="tag red" v-if="d.person.expired">已到期（{{ d.person.expires }}）</span>
                          <span class="tag green" v-else-if="d.person.expires">有效期至 {{ d.person.expires }}</span>
                          <span class="tag gray" v-else>长期有效</span>
                        </template>
                        <span class="muted" v-else>未配置</span>
                      </td>
                      <td>
                        <a class="btn-link" v-for="i in d.identities" :key="i" @click="switchTo(i)"
                           :title="'切换为该演示身份：' + identityNote(i)">{{ identityName(i) }}</a>
                        <span class="muted" v-if="!d.identities.length">非演示身份</span>
                      </td>
                      <td>
                        <div class="actions">
                          <a class="btn-link" @click="openPersonEdit(d)">个人授权</a>
                          <a class="btn-link" @click="openDetail(d)">权限详情</a>
                          <a class="btn-link danger" @click="revokePerson(d)">取消授权</a>
                        </div>
                      </td>
                    </tr>
                  </tbody>
                </table>
                <empty-state v-else icon="🩺" text="该科室下没有 PractitionerRole 归属的医师，可在「演示数据管理」补充。"></empty-state>
              </div>
              <div class="hint mt8">「当前可开等级」按合并优先级实时判定；点「权限详情」可查看职称规则 / 科室授权 / 个人授权 / 最终等级四层与命中的是哪一层。</div>
              <div class="alert info mt12"><span>🔁</span>
                <div>演示身份切换（SRS §11.2）：点医师行的身份标识可切换为该医师登录，随后到「临床开单演示」即可验证本条权限规则的实际拦截效果。
                  切换身份后本页对医师角色不可见会自动返回工作台；跨身份的数据一致性通过重新查询 FHIR 服务端实现，本程序不做短信/邮件推送。</div>
              </div>
            </div>
          </div>
        </div>

        <!-- ============ FR-003.6 权限变更前后查询 ============ -->
        <div class="card mt16">
          <div class="card-head"><h3>🔍 权限变更前后查询（FR-003.6）</h3></div>
          <div class="card-body">
            <div class="section-title">医师个人授权的变更前后内容（FHIR Permission.ext.before / ext.after）</div>
            <div class="table-wrap mt8">
              <table class="tbl" v-if="personGrants.length">
                <thead><tr>
                  <th style="width:90px">医师</th>
                  <th style="width:100px">职称</th>
                  <th>科室</th>
                  <th style="width:170px">授权名称</th>
                  <th style="width:150px">变更前</th>
                  <th style="width:150px">变更后</th>
                  <th style="width:110px">到期日</th>
                  <th style="width:90px">状态</th>
                  <th style="width:90px">操作</th>
                </tr></thead>
                <tbody>
                  <tr v-for="p in personGrants" :key="p.id">
                    <td><b>{{ p.name }}</b></td>
                    <td>{{ p.titleName || '—' }}</td>
                    <td class="muted">{{ p.dept || '—' }}</td>
                    <td>{{ p.grantLabel }}<div class="muted" v-if="p.note">{{ p.note }}</div></td>
                    <td class="muted">{{ grantText(p.before) }}</td>
                    <td>{{ grantText(p.after) }}</td>
                    <td class="nowrap">{{ p.expires || '长期' }}</td>
                    <td>
                      <span class="tag red" v-if="p.expired">已到期</span>
                      <span class="tag green" v-else-if="p.status==='active' && p.levels.length">生效中</span>
                      <span class="tag gray" v-else>无生效授权</span>
                    </td>
                    <td><a class="btn-link" @click="detailByPract(p.pract)">详情</a></td>
                  </tr>
                </tbody>
              </table>
              <empty-state v-else icon="🗂️" text="尚无个人授权记录。"></empty-state>
            </div>
            <div class="hint mt8">「已到期」以 <code>Approval.authorizations(pract).layers.person.expired</code> 为准（按演示时钟当前日期比较到期日），
              资源里保留了哪些等级不影响判定结论：到期后这些等级即刻从该医师的可开范围中失效。</div>

            <div class="section-title mt16">科室授权变更前后内容</div>
            <div class="table-wrap mt8">
              <table class="tbl" v-if="deptGrants.length">
                <thead><tr>
                  <th style="width:220px">科室</th><th style="width:160px">变更前</th><th style="width:160px">变更后</th>
                  <th>当前生效等级</th><th style="width:110px">状态</th>
                </tr></thead>
                <tbody>
                  <tr v-for="g in deptGrants" :key="g.id">
                    <td><b>{{ g.name }}</b><div class="muted">{{ g.note }}</div></td>
                    <td class="muted">{{ grantText(g.before) }}</td>
                    <td>{{ grantText(g.after) }}</td>
                    <td><span class="chip" v-for="n in g.levels" :key="n" style="cursor:default">{{ n }}</span></td>
                    <td><span class="tag" :class="g.status==='active'?'green':'gray'">{{ g.status==='active'?'授权生效':'授权已停用' }}</span></td>
                  </tr>
                </tbody>
              </table>
              <empty-state v-else icon="🗂️" text="尚无科室授权记录，可在上方「配置科室授权」保存后生成。"></empty-state>
            </div>
          </div>
        </div>

        <!-- ============ 授权变更留痕 ============ -->
        <div class="card mt16">
          <div class="card-head">
            <h3>🕒 授权变更留痕</h3>
            <div class="field inline">
              <label class="muted">变更类型</label>
              <select v-model="logType">
                <option value="all">全部（科室授权 / 个人授权 / 授权优先级）</option>
                <option value="科室授权">科室授权</option>
                <option value="个人授权">个人授权</option>
                <option value="授权优先级">授权优先级</option>
              </select>
            </div>
          </div>
          <div class="card-body" style="padding:0">
            <div class="table-wrap">
              <table class="tbl" v-if="logs.length">
                <thead><tr>
                  <th style="width:150px">时间</th><th style="width:110px">类型</th><th>变更内容</th>
                  <th style="width:170px">操作人</th><th style="width:240px">关联 FHIR 资源</th>
                </tr></thead>
                <tbody>
                  <tr v-for="p in logs" :key="p.id">
                    <td class="nowrap">{{ p.time }}</td>
                    <td><span class="tag blue">{{ p.changeType }}</span></td>
                    <td>{{ p.content }}</td>
                    <td>{{ p.operator }}</td>
                    <td class="muted">
                      <span v-for="(rf,i) in logRefs(p.id)" :key="p.id+'-'+i"><code>{{ rf }}</code>{{ i ? '、' : '' }}</span>
                      <span v-if="!logRefs(p.id).length">—</span>
                    </td>
                  </tr>
                  <tr class="total-row"><td colspan="5">共 {{ logs.length }} 条授权变更记录</td></tr>
                </tbody>
              </table>
              <empty-state v-else icon="🗂️" text="暂无授权变更记录，保存一次科室或个人授权后即会生成。"></empty-state>
            </div>
          </div>
          <div class="card-body">
            <div class="alert info"><span>ℹ️</span>
              <div>留痕写入 <b>FHIR Provenance</b>（agent.who 为当前演示身份的 Practitioner，entity.what 指向被修改的 Permission/Basic 资源）
                与配对的 <b>AuditEvent</b>，可在「审批留痕与数据关联核查」页面按资源回溯。</div>
            </div>
          </div>
        </div>

        <div class="alert mt16" style="background:#f4f7fc;color:var(--text-2)"><span>🧪</span>
          <div>演示数据边界（SRS BR-010）：本页科室、医师、授权等级与优先级均为虚构配置，保存结果只证明功能可配置，
            不代表真实医师已取得处方权限，也不构成真实临床授权。</div>
        </div>

        <!-- ============ 弹框：配置科室授权 ============ -->
        <ui-modal v-if="showDept && deptEdit" :title="'配置科室授权 - '+deptEdit.name" width="wide" @close="showDept=false">
          <div class="kv mb12">
            <span class="k">科室</span><span>{{ deptEdit.name }}（{{ deptEdit.kind || '科室' }}）</span>
            <span class="k">在岗医师</span><span>{{ deptEdit.doctors }} 位，其中 {{ deptEdit.hitDocs }} 位当前按科室授权判定</span>
          </div>
          <div class="divider-label">勾选科室可授权等级</div>
          <div class="checks">
            <label v-for="lv in D.LEVELS" :key="lv.code">
              <input type="checkbox" :value="lv.code" v-model="deptEdit.levels"> {{ lv.name }}
            </label>
          </div>
          <div class="hint mt8">全部取消即停用该科室授权，本科室医师回退到职称规则判定（保存时会二次确认）。</div>

          <div class="divider-label">变更前后对比</div>
          <div class="table-wrap">
            <table class="tbl">
              <thead><tr><th style="width:170px">等级</th><th style="width:140px">变更前</th><th style="width:140px">变更后</th><th>本次变更</th></tr></thead>
              <tbody>
                <tr v-for="lv in D.LEVELS" :key="lv.code">
                  <td><level-tag :level="lv.code"></level-tag></td>
                  <td><span :class="deptEdit.before.indexOf(lv.code)>=0 ? 'tag green' : 'muted'">{{ deptEdit.before.indexOf(lv.code)>=0 ? '已授权' : '未授权' }}</span></td>
                  <td><span :class="deptEdit.levels.indexOf(lv.code)>=0 ? 'tag green' : 'muted'">{{ deptEdit.levels.indexOf(lv.code)>=0 ? '已授权' : '未授权' }}</span></td>
                  <td>
                    <span class="tag green" v-if="deptDiffText(lv.code, 'add')">新增授权</span>
                    <span class="tag red" v-else-if="deptDiffText(lv.code, 'remove')">取消授权</span>
                    <span class="muted" v-else>不变</span>
                  </td>
                </tr>
                <tr class="total-row"><td colspan="4">变更前：{{ deptEdit.beforeText }} → 变更后：{{ levelNames(deptEdit.levels) }}</td></tr>
              </tbody>
            </table>
          </div>
          <div class="alert warn mt12"><span>⚠️</span>
            <div>保存后本科室全部医师的开单判定立即按新授权集合生效（FR-003.7 会给出明确反馈）；
              已在流程中的审批任务保留其开单时的等级与权限判定依据，不会被本次调整改写。</div>
          </div>
          <div class="form-row mt16"><label>配置说明</label>
            <div class="ctrl"><input type="text" v-model="deptEdit.note" placeholder="如：按科室抗菌药物管理工作要求配置（演示）"></div>
          </div>
          <div class="alert success mt8" v-if="deptDiff().length"><span>📝</span>
            <div>本次变更：{{ deptDiffSummary() }}</div>
          </div>
          <template #foot>
            <button class="btn" @click="showDept=false">取消</button>
            <button class="btn primary" :disabled="!deptDiff().length" @click="saveDept">确认保存科室授权</button>
          </template>
        </ui-modal>

        <!-- ============ 弹框：个人授权 ============ -->
        <ui-modal v-if="showPerson && personEdit" :title="'个人授权 - '+personEdit.name" width="wide" @close="showPerson=false">
          <div class="kv mb12">
            <span class="k">医师</span><span>{{ personEdit.name }} · {{ personEdit.titleName || '无职称' }} · {{ personEdit.dept }}</span>
            <span class="k">现有个人授权</span><span>{{ personEdit.beforeText }}</span>
          </div>
          <div class="divider-label">授权等级集合（取消全部勾选即取消该医师个人授权）</div>
          <div class="checks">
            <label v-for="lv in D.LEVELS" :key="lv.code">
              <input type="checkbox" :value="lv.code" v-model="personEdit.levels"> {{ lv.name }}
            </label>
          </div>
          <div class="form-row mt16"><label class="req">授权名称</label>
            <div class="ctrl">
              <input type="text" v-model="personEdit.grantLabel" placeholder="如：重症感染专项特批（演示）">
              <span class="hint">授权名称会写入 Permission.ext.grantLabel 并在权限详情中作为规则原文展示。</span>
            </div>
          </div>
          <div class="form-row"><label>到期日</label>
            <div class="ctrl">
              <input type="date" v-model="personEdit.expires">
              <span class="hint">留空表示长期有效；到期日早于演示当前日期时，列表与详情按「已到期」处理，这些等级不再参与判定。</span>
            </div>
          </div>
          <div class="form-row"><label>备注</label>
            <div class="ctrl"><input type="text" v-model="personEdit.note" placeholder="如：经药事管理与临床会诊同意（演示）"></div>
          </div>
          <div class="alert info mt8"><span>💡</span>
            <div>个人授权只在合并优先级中排在它之前且该层非空时才生效。当前生效顺序：{{ prio.label }}。
              保存后可用「权限详情」核对该医师实际命中的是哪一层。</div>
          </div>
          <template #foot>
            <button class="btn" @click="showPerson=false">取消</button>
            <button class="btn primary" @click="savePerson">保存个人授权</button>
          </template>
        </ui-modal>

        <!-- ============ 弹框：医师权限详情（四层来源 + 命中） ============ -->
        <ui-modal v-if="detail" :title="'医师权限详情 - '+detail.info.name" width="wide" @close="closeDetail">
          <div class="kv">
            <span class="k">医师</span><span>{{ detail.info.name }} · {{ D.titleName(detail.info.title) }} · {{ detail.info.dept || '未归属科室' }}</span>
            <span class="k">岗位角色</span><span><span class="tag gray" v-for="r in (detail.roleGrants ? detail.roleGrants.roles : [])" :key="r">{{ roleLabel(r) }}</span>
              <span class="muted" v-if="detail.roleGrants && detail.roleGrants.canApprove">承担审批节点</span></span>
            <span class="k">最终可使用等级</span><span>{{ detail.levelNames.length ? detail.levelNames.join('、') : '无（任何抗菌药物开立都需授权或审批）' }}</span>
            <span class="k">命中规则层</span>
            <span><span class="tag blue">{{ detail.hit.srcLabel }}</span>
              <span class="muted">{{ detail.hit.ruleText }}</span>
              <code class="muted" v-if="detail.hit.srcId"> {{ detail.hit.srcId }}</code></span>
            <span class="k">合并优先级</span><span>{{ detail.priorityLabel }}</span>
          </div>
          <div class="alert warn mt12"><span>⚠️</span>
            <div>采购文件未规定三层授权冲突时的优先级，上述顺序是<b>演示配置项（可在本页顶部调整）</b>；
              合并规则为「按顺序取第一个已配置且非空的层」，界面展示的命中层与规则原文即为本次判定的真实依据（SRS §3.2 / BR-002 / FR-003.4）。</div>
          </div>

          <div class="divider-label">四层权限来源</div>
          <div class="table-wrap">
            <table class="tbl">
              <thead><tr><th style="width:120px">层级</th><th style="width:110px">配置状态</th><th>规则原文（FHIR 资源内容）</th><th style="width:200px">等级集合</th><th style="width:80px">命中</th></tr></thead>
              <tbody>
                <tr v-for="L in detailLayers" :key="L.layer">
                  <td><b>{{ L.label }}</b><div class="muted">{{ L.desc }}</div></td>
                  <td>
                    <span class="tag" :class="layerState(L).cls">{{ layerState(L).text }}</span>
                  </td>
                  <td>{{ L.source }}<div class="muted" v-if="L.expires">到期日：{{ L.expires }}</div>
                    <div class="muted" v-if="L.ruleId">资源：{{ L.ruleId }}</div></td>
                  <td>
                    <span class="chip" v-for="n in L.levels" :key="n" style="cursor:default">{{ n }}</span>
                    <span class="muted" v-if="!L.levels.length">无</span>
                  </td>
                  <td><span class="tag" :class="L.hit?'blue':'gray'">{{ L.hit?'是':'否' }}</span></td>
                </tr>
              </tbody>
            </table>
          </div>

          <div class="divider-label">按等级的可开立结果（FR-003.5）</div>
          <div class="table-wrap">
            <table class="tbl">
              <thead><tr><th style="width:170px">抗菌药物等级</th><th style="width:120px">本次判定</th><th style="width:130px">该等级药品数</th><th>说明</th></tr></thead>
              <tbody>
                <tr v-for="b in detailLevels" :key="b.level">
                  <td><level-tag :level="b.level"></level-tag></td>
                  <td><span class="tag" :class="b.allowed?'green':'red'">{{ b.allowed?'可开':'不可开' }}</span></td>
                  <td>{{ b.drugCount }} 种</td>
                  <td class="muted">{{ b.allowed ? '属于命中层（'+detail.hit.srcLabel+'）的授权范围，可直接开立（仍须选择用药目的）'
                    : '不在授权范围，开立将触发该等级已发布的审批流程，或需先取得科室/个人授权' }}</td>
                </tr>
              </tbody>
            </table>
          </div>
          <div class="alert danger mt12" v-if="detailMissing.length"><span>⛔</span>
            <div><b>缺少的授权等级：</b>{{ detailMissing.join('、') }}。
              为该医师配置上述等级的科室授权或个人授权，或提交对应等级的审批流程申请，即可取得使用权限（不是笼统的「无权限」）。</div>
          </div>
          <div class="alert success mt12" v-else><span>✅</span><div>该医师已取得全部演示等级的授权，无缺少项。</div></div>

          <div class="divider-label">该医师相关变更记录</div>
          <div class="table-wrap" v-if="detail.history.length">
            <table class="tbl">
              <thead><tr><th style="width:150px">时间</th><th style="width:110px">类型</th><th>内容</th><th style="width:160px">操作人</th></tr></thead>
              <tbody>
                <tr v-for="h in detail.history" :key="h.id">
                  <td class="nowrap">{{ h.time }}</td><td><span class="tag blue">{{ h.changeType }}</span></td>
                  <td>{{ h.content }}</td><td>{{ h.operator }}</td>
                </tr>
              </tbody>
            </table>
          </div>
          <empty-state v-else icon="🗂️" text="该医师的授权暂无变更记录（变更记录在保存科室或个人授权后生成）。"></empty-state>

          <template #foot><button class="btn" @click="closeDetail">关闭</button></template>
        </ui-modal>
      </div>
    </div>`
  };
})(window);
