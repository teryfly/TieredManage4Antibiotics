/* =====================================================================
 * emergency-review.js —— 紧急越级补审核（SRS FR-008 / BR-004 / BR-005 / DEMO-12）
 * ---------------------------------------------------------------------
 * 承载采购条款「紧急情况下医生临时越级使用抗菌药物，事后 24h 内医生补审核流程」：
 *   发起临时越级 → 生成独立的补审核流程标识与 24 小时期限 → 提交补充材料
 *   → 补审核节点处理 → 展示结论/审核人/完成时间/意见；超时只提示，不改状态。
 * 业务规则一律走 Approval 引擎与 Svc.srs，本文件只做界面与取数编排。
 * ===================================================================== */
(function (global) {
  'use strict';
  var AMS = global.AMS, Svc = global.Svc, D = global.Domain, App = global.App;
  var Ap = global.Approval, F = global.FHIR;

  /* 补审核所需补充材料（SRS §15.3：采购文件未规定表单字段，此处为演示配置项） */
  var MATERIAL_KEYS = [
    { key: '病原学送检', hint: '血培养 / 分泌物培养 / 药敏送检情况', ph: '如：血培养 2 套 + 创面分泌物培养（已采集）' },
    { key: '用药前评估', hint: '用药前的病情与生命体征评估', ph: '如：GCS 13，MAP 62 mmHg，乳酸 4.1 mmol/L' },
    { key: '临床说明', hint: '越级使用的临床依据与给药方案', ph: '如：万古霉素 1g q12h 负荷给药，拟行血药浓度监测' },
    { key: '后续方案', hint: '药敏回报后的调整与降阶梯计划', ph: '如：48 小时后依据药敏结果调整为窄谱方案' }
  ];

  /* Svc.srs.clock() 内部是 Object.assign(Clock.state(), {...})，会把 FHIR 读写模式
   * 覆盖进时钟自己的缓存对象（数据层既有副作用），冻结模式会被顶掉。
   * 这里读完立刻 Clock.reload()，让缓存回到镜像真相，界面再分开显示两种模式。 */
  function clockView() {
    global.App.state.refresh;
    var c = global.Svc.srs.clock();
    var fhirMode = c.mode;
    global.Clock.reload();
    var st = global.Clock.state();
    return {
      now: c.now, instant: c.instant, scope: c.scope, base: c.base, server: c.server,
      fhirMode: fhirMode, mode: st.mode, offsetMinutes: st.offsetMinutes,
      frozenAt: st.frozenAt, setBy: st.setBy, setAt: st.setAt
    };
  }

  AMS.pages['emergency-review'] = {
    data: function () {
      return {
        openId: '',
        showCreate: false,
        created: null,
        onlyMine: false,
        statusFilter: 'all',
        drugScope: 'special',
        form: {
          patientId: '', encounterId: '', medicationId: '', dosageText: '',
          purposeCode: '', purposeNote: '', emergencyReason: '', clinicalNote: ''
        },
        errors: {},
        matForm: {},
        actForm: { action: 'approve', comment: '' }
      };
    },
    computed: {
      D: function () { return D; },
      Ap: function () { return Ap; },
      materialKeys: function () { return MATERIAL_KEYS; },
      user: function () { return App.currentUser(); },
      role: function () { return App.state.roleCode; },
      canView: function () { return D.canAccess(App.state.roleCode, 'emergency-review'); },
      /* FR-008.1 越级入口只属于开单医师；其他角色到临床开单演示页发起 */
      isDoctor: function () { return App.state.roleCode === 'doctor'; },
      isFlowOwner: function () { return ['admin', 'ruleadmin'].indexOf(App.state.roleCode) >= 0; },
      purposeName: function () { return D.flowPurposeName('emergency-review'); },

      /* ---------- FR-008.3/4/5/6/8：紧急越级记录与期限 ---------- */
      records: function () {
        App.state.refresh;
        var pract = this.user.practitioner;
        return Svc.srs.emergencyRecords(pract).map(function (r) {
          var m = F.read('Task', r.id);
          var ext = (m && m.ext) || {};
          return Object.assign({}, r, {
            purpose: ext.purpose, purposeName: D.flowPurposeName(ext.purpose),
            versionLabel: ext.version ? 'V' + ext.version : '—',
            pdTitle: ext.pdTitle || '', pdId: ext.pdId || '',
            canonical: (m && m.instantiatesCanonical) || '',
            clinicalNote: ext.clinicalNote || '',
            submittedAt: ext.postReviewSubmittedAt || '',
            postReview: ext.postReview || null,
            orderStatusName: D.orderStatusName(ext.orderStatus),
            encounterRef: (function () {
              var mr = F.read('MedicationRequest', ext.mrId);
              return mr && mr.encounter ? mr.encounter.reference : '';
            })()
          });
        }).sort(function (a, b) { return (b.createdAt || '').localeCompare(a.createdAt || ''); });
      },
      /* 顶部三段统计（待补审核 / 已超时 / 我的记录） */
      counters: function () {
        var pending = 0, timeout = 0, mine = 0;
        this.records.forEach(function (r) {
          if (Ap.CLOSED_MAIN.indexOf(r.flowStatus) < 0) pending++;
          if (r.timeout && r.timeout.timeout) timeout++;
          if (r.mine) mine++;
        });
        return { pending: pending, timeout: timeout, mine: mine };
      },
      timeoutRows: function () {
        return this.records.filter(function (r) { return r.timeout && r.timeout.kind === 'timeout'; });
      },
      visibleRows: function () {
        var q = this.statusFilter, mine = this.onlyMine;
        return this.records.filter(function (r) {
          if (mine && !r.mine) return false;
          if (q === 'all') return true;
          if (q === 'timeout') return r.timeout && r.timeout.kind === 'timeout';
          if (q === 'pending') return Ap.CLOSED_MAIN.indexOf(r.flowStatus) < 0;
          if (q === 'done') return r.flowStatus === 'post-review-done';
          return r.flowStatus === q;
        });
      },
      statusOptions: function () {
        return [{ code: 'all', name: '全部状态' }, { code: 'pending', name: '补审核进行中' },
        { code: 'timeout', name: '补审核超时' }, { code: 'done', name: '补审核完成' },
        { code: 'rejected', name: '补审核驳回' }];
      },

      /* ---------- 发起紧急越级（仅医师） ---------- */
      patients: function () { App.state.refresh; return Svc.srs.orderPatients(); },
      encounters: function () {
        App.state.refresh;
        return this.form.patientId ? Svc.srs.encounters(this.form.patientId) : [];
      },
      patient: function () {
        var self = this, id = this.form.patientId;
        return this.patients.filter(function (p) { return p.id === id; })[0] || null;
      },
      drugs: function () {
        App.state.refresh;
        var scope = this.drugScope;
        return Svc.srs.searchDrugs(scope === 'all' ? {} : { level: scope })
          .filter(function (d) { return d.enabled; });
      },
      drug: function () {
        App.state.refresh;
        return this.form.medicationId ? Svc.srs.drug(this.form.medicationId) : null;
      },
      /* FR-008.1：越级提交前即时给出药品等级与本人权限判定 */
      liveCheck: function () {
        App.state.refresh;
        if (!this.form.medicationId) return null;
        return Ap.check({ practitioner: this.user.practitioner, medicationId: this.form.medicationId, isEmergency: true });
      },

      /* ---------- 详情（DEMO-12.6/7/8、FR-008.7） ---------- */
      detail: function () {
        App.state.refresh;
        if (!this.openId) return null;
        var v = Svc.srs.centerDetail(this.openId);
        if (!v) return null;
        var m = F.read('Task', this.openId);
        var ext = (m && m.ext) || {};
        v.emergencyReason = ext.emergencyReason || '';
        v.clinicalNote = ext.clinicalNote || '';
        v.postReview = ext.postReview || null;
        v.postReviewSubmittedAt = ext.postReviewSubmittedAt || '';
        v.decision = ext.decision || null;
        v.canonical = (m && m.instantiatesCanonical) || '';
        v.postNode = v.nodes.filter(function (n) { return n.isPostReview; })[0]
          || v.nodes[v.nodes.length - 1] || null;
        return v;
      },
      /* FR-008.9：补审核节点构成由流程配置确定，这里展示当前发布版本的节点配置 */
      emergencyFlow: function () {
        App.state.refresh;
        return Ap.currentVersion('emergency-review', '');
      },
      deadlineHours: function () {
        var pd = this.emergencyFlow;
        if (!pd || !pd.ext || !pd.ext.nodes || !pd.ext.nodes.length) return Ap.EMERGENCY_HOURS;
        var post = pd.ext.nodes.filter(function (n) { return n.isPostReview; })[0] || pd.ext.nodes[0];
        return post.deadlineHours || Ap.EMERGENCY_HOURS;
      },
      clockView: function () { return clockView(); },
      clockModeName: function () {
        var m = this.clockView.mode;
        return m === 'live' ? '实时' : (m === 'frozen' ? '冻结于设定时刻' : '按偏移量前进');
      }
    },
    methods: {
      toast: App.toast,
      fmt: function (s) { return (s || '').replace('T', ' ').slice(0, 16) || '—'; },

      /* ---------- 发起 ---------- */
      openCreate: function () {
        this.form = {
          patientId: '', encounterId: '', medicationId: '', dosageText: '',
          purposeCode: '', purposeNote: '', emergencyReason: '', clinicalNote: ''
        };
        this.errors = {};
        this.showCreate = true;
      },
      onPatient: function () { this.form.encounterId = ''; },
      onDrug: function () {
        var d = this.drug;
        this.form.dosageText = d ? d.usage : '';
        this.errors = {};
      },
      validateCreate: function () {
        var f = this.form, e = {};
        if (!f.patientId) e.patientId = '请选择演示患者';
        if (!f.encounterId) e.encounterId = '请选择本次就诊';
        if (!f.medicationId) e.medicationId = '请选择越级使用的抗菌药物';
        if (!f.dosageText) e.dosageText = '请填写用法用量';
        if (!f.purposeCode) e.purposeCode = '用药目的为必填（SRS BR-004）';
        if (!f.emergencyReason) e.emergencyReason = '紧急使用原因为必填（SRS FR-008.2）';
        if (!f.clinicalNote) e.clinicalNote = '临床说明为必填（SRS FR-008.2）';
        this.errors = e;
        return Object.keys(e).length === 0;
      },
      doCreate: function () {
        if (!this.validateCreate()) { App.toast('请补全必填项：紧急使用原因与临床说明缺一不可（FR-008.2）', 'error'); return; }
        var f = this.form, p = this.patient, chk = this.liveCheck;
        var payload = {
          practitionerId: this.user.practitioner, medicationId: f.medicationId,
          patientId: f.patientId, encounterId: f.encounterId,
          patientName: p ? p.name : '', mrn: p ? p.mrn : '', diagnosis: p ? p.diagnosis : '',
          purposeCode: f.purposeCode, purposeNote: f.purposeNote,
          dosageText: f.dosageText, reason: f.emergencyReason,
          emergency: true, emergencyReason: f.emergencyReason, clinicalNote: f.clinicalNote,
          expectedLevel: chk ? chk.grade : undefined
        };
        var res;
        try {
          res = Svc.srs.submitOrder(payload);
        } catch (err) {
          if (err && err.code === 'EMERGENCY_REASON') { App.toast('紧急情况临时越级使用必须填写紧急使用原因及临床说明，提交已被拦下（FR-008.2）', 'error'); return; }
          if (err && err.code === 'PURPOSE_REQUIRED') { App.toast('请先选择抗菌药物使用目的，未选择不得提交（BR-004）', 'error'); return; }
          if (err && err.code === 'NO_FLOW') { App.toast('「' + D.flowPurposeName('emergency-review') + '」尚未发布流程版本，无法生成补审核任务', 'error'); return; }
          App.toast('提交失败：' + (err && err.message ? err.message : '未知错误'), 'error');
          return;
        }
        if (res.mode !== 'emergency' || !res.instance) {
          App.toast('本次提交未进入紧急越级分支（可能权限已满足），请核对判定结果', 'error');
          return;
        }
        var inst = res.instance;
        this.created = {
          sqno: inst.ext.sqno, mainId: inst.id, deadline: res.deadline || inst.ext.postReviewDeadline || '',
          drug: inst.ext.drug, levelName: D.levelName(inst.ext.level), patient: inst.ext.patientName,
          purposeName: D.flowPurposeName(inst.ext.purpose), versionLabel: 'V' + inst.ext.version
        };
        this.showCreate = false;
        App.toast('已生成补审核任务 ' + inst.ext.sqno + '，24 小时期限已记录（FR-008.4）', 'success');
      },
      clearCreated: function () { this.created = null; },
      goCenter: function () { App.navigate('approval-center'); },
      goDemo: function () { App.navigate('demo-data'); },
      /* 节点动作中文名（模板里不能裸用模块常量，统一由此方法转换） */
      actionNames: function (list) {
        var names = (list || []).map(function (a) { return Ap.actionName(a); });
        return names.length ? names.join('、') : '—';
      },
      actionLabel: function (a) { return a ? Ap.actionName(a) : '—'; },

      /* ---------- 详情 / 材料 / 处理 ---------- */
      openRow: function (r) {
        this.openId = r.id;
        var src = r.postReview || {};
        this.matForm = MATERIAL_KEYS.reduce(function (o, k) { o[k.key] = src[k.key] || ''; return o; }, {});
        this.actForm = { action: 'approve', comment: '' };
      },
      closeRow: function () { this.openId = ''; },
      saveMaterials: function () {
        var f = this.matForm, data = {};
        MATERIAL_KEYS.forEach(function (k) { if ((f[k.key] || '').trim()) data[k.key] = f[k.key].trim(); });
        if (!Object.keys(data).length) { App.toast('请至少填写一项补审核材料（如病原学送检、用药前评估）', 'error'); return; }
        try {
          Svc.srs.submitEmergencyMaterials(this.openId, data);
        } catch (err) {
          App.toast('材料保存失败：' + (err && err.message ? err.message : '未知错误'), 'error');
          return;
        }
        App.toast('补充材料已保存并留痕（DEMO-12 第 6 步）', 'success');
      },
      doAct: function (action) {
        var d = this.detail;
        if (!d || !d.actions || !d.actions.canAct) { App.toast('当前节点不在您名下待处理', 'error'); return; }
        if (action !== 'approve' && !this.actForm.comment.trim()) {
          App.toast('驳回必须填写原因（SRS FR-022.2）', 'error');
          return;
        }
        try {
          var r = Svc.srs.act({
            taskId: d.mainId, action: action, operatorPractId: this.user.practitioner,
            comment: this.actForm.comment.trim()
          });
          App.toast('补审核节点已「' + Ap.actionName(action) + '」，实例状态：' + D.flowStatusName(r.flowStatus), 'success');
          this.actForm = { action: 'approve', comment: '' };
        } catch (err) {
          App.toast('处理失败：' + (err && err.message ? err.message : '未知错误'), 'error');
        }
      },
      stepCls: function (s) {
        return s === 'passed' ? 'approved' : (s === 'rejected' ? 'rejected' : (s === 'doing' ? 'current' : ''));
      },
      timeoutCls: function (k) {
        return k === 'timeout' ? 'red' : (k === 'near' ? 'orange' : (k === 'due' ? 'blue' : 'gray'));
      },
      /* ---------- 演示时钟（FR-008.8 超时只提示，不写库） ---------- */
      advanceClock: function () {
        Svc.srs.advanceClock(25 * 60);
        App.bump();
        App.toast('演示时钟已推进 25 小时；超时状态由计算得出，任务状态未被改写', 'info');
      },
      resetClock: function () {
        Svc.srs.setClock({ mode: 'live' });
        App.bump();
        App.toast('演示时钟已恢复为实时时钟', 'info');
      }
    },
    template: `
    <div>
      <div v-if="!canView" class="card"><div class="card-body">
        <empty-state icon="🔒" text="本页面仅对「开单医师 / 审批人员 / 系统管理员 / 规则管理员」角色开放。请使用顶部演示角色切换。"></empty-state>
      </div></div>

      <div v-else>
        <!-- 顶部三段统计 -->
        <div class="card">
          <div class="card-body">
            <div class="stat-grid cols-3">
              <div class="stat-card">
                <div class="label">待补审核件数</div>
                <div class="value">{{ counters.pending }}<small>件</small></div>
                <div class="delta flat">补审核流程未结束（不含完成/驳回/撤回）</div>
              </div>
              <div class="stat-card">
                <div class="label">已超时件数</div>
                <div class="value" :class="counters.timeout ? 'txt-err' : ''">{{ counters.timeout }}<small>件</small></div>
                <div class="delta" :class="counters.timeout ? 'down' : 'flat'">超过 24 小时期限仍未完成补审核</div>
              </div>
              <div class="stat-card">
                <div class="label">我的紧急越级记录</div>
                <div class="value">{{ counters.mine }}<small>条</small></div>
                <div class="delta flat">当前身份：{{ user.display }}</div>
              </div>
            </div>
          </div>
        </div>

        <!-- 发起入口（FR-008.1） -->
        <div class="card mt16">
          <div class="card-head">
            <h3>🚨 发起紧急越级使用</h3>
            <div class="btn-row" style="margin:0">
              <button v-if="isDoctor" class="btn primary" @click="openCreate">＋ 发起紧急临时越级使用</button>
              <button class="btn" @click="goCenter">前往审批中心</button>
            </div>
          </div>
          <div class="card-body">
            <div v-if="!isDoctor" class="alert info"><span>ℹ️</span>
              <div>当前身份是「{{ D.roleName(role) }}」，紧急越级使用须由<b>开单医师</b>在发起时填写紧急原因，请切到医师身份后到「临床业务 → 临床开单演示」选择患者、就诊与药品发起；本页用于<b>查看补审核进度、提交补充材料并处理补审核节点</b>。</div>
            </div>
            <div v-else class="alert info"><span>💡</span>
              <div>入口只受理<b>权限不足</b>时的临时越级使用：选择患者 → 就诊 → 抗菌药物（默认列出特殊使用级）后即时显示药品等级与本人权限判定；紧急使用原因与临床说明<b>均为必填</b>（SRS FR-008.2、BR-004），提交后生成<b>独立于普通审批</b>的「{{ purposeName }}」任务并记录 24 小时期限。</div>
            </div>
            <div v-if="created" class="alert success" style="display:block">
              <span>✅</span>
              <div>
                <div><b>紧急越级使用已记录</b> · 申请编号 {{ created.sqno }}</div>
                <div class="mt8">患者：{{ created.patient }} ｜ 药品：{{ created.drug }}（{{ created.levelName }}）</div>
                <div>24 小时补审核截止时间：<b>{{ fmt(created.deadline) }}</b>（发起时间 + 流程配置的期限）</div>
                <div>流程标识：{{ created.purposeName }} {{ created.versionLabel }} ｜ 已生成补审核任务，进入审核中心待办（FR-008.4/5）</div>
                <div class="muted mt8" style="font-size:12px">本条为演示数据：紧急越级使用仅代表演示流程已按配置生成补审核任务，不代表真实临床处方已执行。</div>
                <div class="btn-row mt8"><button class="btn" @click="openRow({id:created.mainId})">查看补审核详情</button><button class="btn ghost" @click="clearCreated">关闭提示</button></div>
              </div>
            </div>
          </div>
        </div>

        <!-- FR-008.8：超时突出提示，且不得自动写成完成 -->
        <div v-if="timeoutRows.length" class="alert danger mt12" style="display:block">
          <span>⛔</span>
          <div>
            <div><b>有 {{ timeoutRows.length }} 件补审核已超过 24 小时期限</b>（{{ timeoutRows.map(function(r){return r.sqno;}).join('、') }}）。</div>
            <div class="mt8">这些任务的状态显示为「补审核超时」，实例状态仍为「{{ timeoutRows[0].flowStatusName }}」——系统<b>不会</b>把超时任务自动改写为补审核完成，也不会自动生成审批意见（SRS FR-008.8）。请在界面提醒责任人尽快处理，超时后的临床处置规则采购文件未规定，本演示不做推定。</div>
          </div>
        </div>

        <!-- FR-008.9/10：独立流程标识与节点配置 -->
        <div class="card mt16">
          <div class="card-head"><h3>🧩 {{ purposeName }}流程标识与节点配置</h3></div>
          <div class="card-body">
            <div class="kv">
              <span class="k">流程用途编码</span><span>emergency-review（与普通分级审批 tier-approval 分开的独立标识，FR-008.10）</span>
              <span class="k">当前发布版本</span><span v-if="emergencyFlow">{{ emergencyFlow.ext.title }} · V{{ emergencyFlow.version }}（{{ emergencyFlow.id }}）</span>
              <span v-else>尚未发布已生效版本，紧急越级提交会被拦下</span>
              <span class="k">补审核期限</span><span>{{ deadlineHours }} 小时（= 发起时间 + 流程节点配置的 deadlineHours，FR-008.4）</span>
              <span class="k">临近提醒阈值</span><span>{{ Ap.NEAR_TIMEOUT_HOURS }} 小时（剩余时间小于该值时列为「即将超时」）</span>
              <span class="k">节点构成</span>
              <span v-if="emergencyFlow">
                <span v-for="(n,i) in emergencyFlow.ext.nodes"><span class="tag blue">{{ i+1 }}·{{ n.name }}</span>
                  {{ D.assigneeTypeName(n.assigneeType) }}（{{ n.assigneeType==='auto' ? '按开单医师所属科室自动匹配' : '指定：' + (n.assignees||[]).join('、') }}）｜ 期限 {{ n.deadlineHours }} 小时 ｜ 动作 {{ actionNames(n.actions) }}；</span>
              </span>
              <span v-else>—</span>
            </div>
            <div class="alert warn mt12"><span>⚠️</span>
              <div>采购文件未规定紧急补审核的具体节点、岗位与表单字段（SRS §15.3）。<b>以上是演示配置项，可在「审批流程设计」中调整并重新发布</b>；调整只影响此后新发起的补审核任务，已在运行的实例仍使用其创建时绑定的版本（BR-006）。</div>
            </div>
          </div>
        </div>

        <!-- 记录列表 -->
        <div class="card mt16">
          <div class="card-head"><h3>📋 紧急越级使用记录</h3></div>
          <div class="card-body">
            <div class="filter-bar mb12">
              <div class="field"><label>状态</label>
                <select v-model="statusFilter"><option v-for="o in statusOptions" :value="o.code">{{ o.name }}</option></select>
              </div>
              <div class="field"><label>范围</label>
                <div class="radios" style="flex-direction:row;gap:16px">
                  <label><input type="checkbox" v-model="onlyMine"> 只看本人发起</label>
                </div>
              </div>
              <div class="field"><label>演示时钟</label><span class="hint">{{ clockView.now }}（{{ clockModeName }}）</span></div>
            </div>
            <div class="table-wrap">
              <table class="tbl" v-if="visibleRows.length">
                <thead><tr>
                  <th>患者 / 病历号</th><th>抗菌药物 / 等级</th><th>发起医师</th><th>发起时间</th>
                  <th>24 小时截止时间</th><th>剩余 / 超时</th><th>补审核状态</th><th>流程标识</th><th style="width:70px">操作</th>
                </tr></thead>
                <tbody>
                  <tr v-for="r in visibleRows">
                    <td><b>{{ r.patient }}</b><div class="muted" style="font-size:12px">{{ r.mrn }}</div></td>
                    <td>{{ r.drug }}<div class="mt8"><level-tag :level="r.level"></level-tag></div></td>
                    <td>{{ r.requester }}<div class="muted" style="font-size:12px">{{ r.mine ? '本人发起' : '其他医师' }}</div></td>
                    <td class="nowrap">{{ fmt(r.createdAt) }}</td>
                    <td class="nowrap">{{ fmt(r.deadline) }}</td>
                    <td>
                      <span class="tag" :class="timeoutCls(r.timeout.kind)">{{ r.timeout.text }}</span>
                      <div v-if="r.timeout.kind==='timeout'" class="err-text mt8" style="font-weight:600">⛔ 补审核超时</div>
                    </td>
                    <td><span class="tag" :class="r.tone">{{ r.flowStatusName }}</span>
                      <div class="muted" style="font-size:12px">{{ r.orderStatusName }}</div></td>
                    <td><span class="tag blue">{{ r.purposeName }}</span>
                      <div class="muted" style="font-size:12px">{{ r.versionLabel }}{{ r.materialsMissing ? ' ｜ 材料未交' : '' }}</div></td>
                    <td class="actions"><a class="btn-link" @click="openRow(r)">详情</a></td>
                  </tr>
                </tbody>
              </table>
              <empty-state v-else text="当前筛选条件下没有紧急越级使用记录。可用权限不足的医师身份在临床开单演示页发起。"></empty-state>
            </div>
          </div>
        </div>

        <!-- 演示辅助：演示时钟说明（FR-008.8 复现超时） -->
        <div class="card mt16">
          <div class="card-head"><h3>⏱️ 演示辅助：24 小时期限与超时如何产生</h3></div>
          <div class="card-body">
            <div class="alert info" style="display:block"><span>💡</span>
              <div>
                <div>本演示的<b>全部时间取自演示时钟</b>（js/clock.js），不是浏览器真实时间的流逝：</div>
                <div class="mt8">· <b>24 小时期限</b> = 补审核任务的发起时间 + 流程节点配置的 <code>deadlineHours</code>，写入 Task.restriction.period.end；</div>
                <div>· <b>超时状态</b> = 当前演示时钟时刻与截止时间的<b>比较结果</b>，每次渲染时算出，<b>不写库、不会自动改变任务状态</b>，也不会自动写成「补审核完成」（FR-008.8）；</div>
                <div>· 复现方式：在「系统管理 → 演示数据管理」页推进演示时钟，或点下方按钮直接推进 25 小时。</div>
                <div class="mt8">当前时钟：<b>{{ clockView.now }}</b> ｜ 时钟模式 {{ clockModeName }} ｜ 偏移 {{ clockView.offsetMinutes }} 分钟 ｜ 设置人 {{ clockView.setBy || '—' }} ｜ 数据读写模式 {{ clockView.fhirMode }}</div>
              </div>
            </div>
            <div class="btn-row mt12">
              <button v-if="isFlowOwner" class="btn" @click="advanceClock">⏩ 推进演示时钟 25 小时</button>
              <button v-if="isFlowOwner" class="btn ghost" @click="resetClock">⏸ 恢复实时时钟</button>
              <span v-if="!isFlowOwner" class="hint">演示时钟仅「系统管理员 / 规则管理员」可调整；医师与审批人员身份只读，避免演示中被误改。</span>
              <div style="flex:1"></div>
              <button v-if="isFlowOwner" class="btn ghost" @click="goDemo">前往演示数据管理</button>
            </div>
          </div>
        </div>

        <!-- 详情弹框 -->
        <ui-modal v-if="detail" :title="'紧急越级补审核详情 · ' + detail.sqno" width="wide" @close="closeRow">
          <div class="alert" :class="detail.timeout.kind==='timeout' ? 'danger' : (detail.timeout.kind==='near' ? 'warn' : 'info')" style="display:block;margin-bottom:12px">
            <span>{{ detail.timeout.kind==='timeout' ? '⛔' : '⏱️' }}</span>
            <div>
              <div>补审核截止 <b>{{ fmt(detail.timeout.deadline) }}</b> ｜ {{ detail.timeout.text }}</div>
              <div v-if="detail.timeout.kind==='timeout'" class="mt8">
                <b>当前状态为「补审核超时」，不是「补审核完成」。</b>实例状态仍是「{{ detail.flowStatusName }}」；系统不会因超时自动补写完成结论、审核人或完成时间（FR-008.8）。超时后是否停药、如何处理责任人，采购文件未规定，本演示不做推定。
              </div>
              <div v-else-if="detail.flowStatus==='post-review-done'">补审核已完成，计时结束（下方显示结论、审核人、完成时间与意见）。</div>
            </div>
          </div>

          <div class="divider-label">越级使用记录（FR-008.3）</div>
          <div class="kv">
            <span class="k">申请编号</span><span>{{ detail.sqno }}</span>
            <span class="k">患者 / 病历号</span><span>{{ detail.request.patient }} ｜ {{ detail.request.mrn }} ｜ {{ detail.request.diagnosis }}</span>
            <span class="k">就诊</span><span>{{ detail.request.encounter || '—' }}</span>
            <span class="k">抗菌药物</span><span>{{ detail.request.drug }}（{{ detail.request.drugCode }}） <level-tag :level="detail.request.level"></level-tag></span>
            <span class="k">等级快照</span><span>{{ detail.request.gradeSnapshot ? (detail.request.gradeSnapshot.name + ' · ' + fmt(detail.request.gradeSnapshot.at)) : '—' }}</span>
            <span class="k">发起医师</span><span>{{ detail.request.requester }} ｜ {{ detail.request.requesterTitle }} ｜ {{ detail.request.dept }}</span>
            <span class="k">发起时间</span><span>{{ fmt(detail.request.authoredAt) }}</span>
            <span class="k">医嘱状态</span><span>{{ detail.request.orderStatusName }}（紧急临时使用，事后补审核）</span>
            <span class="k">流程标识</span><span><span class="tag blue">{{ detail.purposeName }}</span> {{ detail.versionLabel }} ｜ {{ detail.pdTitle }}</span>
            <span class="k">版本绑定</span><span>{{ detail.canonical || '—' }}（实例仍按其创建时绑定的版本执行，BR-006）</span>
          </div>

          <div class="divider-label">紧急使用原因与临床说明（FR-008.2，提交时必填）</div>
          <div class="kv">
            <span class="k">紧急使用原因</span><span>{{ detail.emergencyReason || '—' }}</span>
            <span class="k">临床说明</span><span>{{ detail.clinicalNote || '—' }}</span>
            <span class="k">用药目的</span><span>{{ detail.request.purpose ? (detail.request.purpose.name + (detail.request.purpose.note ? '：' + detail.request.purpose.note : '')) : '—' }}</span>
            <span class="k">用法用量</span><span>{{ detail.request.dosage ? (detail.request.dosage.text || '—') : '—' }}</span>
            <span class="k">权限判定依据</span><span>{{ detail.request.authzHit ? (detail.request.authzHit.srcLabel + ' — ' + detail.request.authzHit.ruleText + '；当时可用等级 ' + ((detail.request.authzHit.allowedLevels||[]).map(function(l){return D.levelName(l);}).join('、') || '无')) : '—' }}</span>
          </div>

          <div class="divider-label">补审核流程图（{{ purposeName }} · {{ detail.versionLabel }}）</div>
          <div class="steps mb12">
            <div class="step" :class="stepCls(n.state)" v-for="(n,i) in detail.nodes">
              <div class="dot">{{ n.state==='passed' ? '✓' : (n.state==='rejected' ? '✕' : i+1) }}</div>
              <div class="bar" v-if="i<detail.nodes.length-1"></div>
              <div class="s-name">{{ n.name }}</div>
              <div class="s-meta">{{ n.stateName }}</div>
              <div class="s-meta">{{ n.actedBy ? n.actedBy : (n.assignees.map(function(a){return a.name;}).join('、') || '—') }}</div>
            </div>
          </div>
          <div class="table-wrap">
            <table class="tbl">
              <thead><tr><th style="width:48px">节点</th><th>名称 / 审批对象</th><th>期限</th><th>状态</th><th>处理人</th><th>处理时间</th><th>意见 / 结论</th></tr></thead>
              <tbody>
                <tr v-for="n in detail.nodes">
                  <td class="text-c">{{ n.seq }}</td>
                  <td>{{ n.name }}<div class="muted" style="font-size:12px">{{ n.assigneeLabel }} ｜ {{ n.modeName }}<span v-if="n.isPostReview"> ｜ 补审核节点</span></div></td>
                  <td class="nowrap">{{ n.deadlineHours }} 小时<div class="muted" style="font-size:12px">{{ fmt(n.deadlineEnd) }}</div></td>
                  <td><span class="tag" :class="n.state==='passed'?'green':(n.state==='rejected'?'red':(n.state==='doing'?'orange':'gray'))">{{ n.stateName }}</span></td>
                  <td>{{ n.actedBy || '—' }}</td>
                  <td class="nowrap">{{ n.actedAt || '—' }}</td>
                  <td>{{ n.comment || (n.state==='doing' ? '待处理' : '—') }}</td>
                </tr>
              </tbody>
            </table>
          </div>

          <!-- 补充材料（DEMO-12 第 6 步） -->
          <div class="divider-label">补审核所需补充材料</div>
          <div class="alert info"><span>💡</span>
            <div>采购文件没有规定补审核表单字段，<b>以下四项为演示配置项</b>（可在数据层调整）；材料写入 Task 扩展并留痕，提交后可再次修改并保留最近一次提交时间。</div>
          </div>
          <div class="form-row" v-for="k in materialKeys">
            <label>{{ k.key }}</label>
            <div class="ctrl">
              <input type="text" v-model="matForm[k.key]" :placeholder="k.ph">
              <span class="hint">{{ k.hint }}</span>
            </div>
          </div>
          <div class="btn-row">
            <button class="btn primary" @click="saveMaterials">💾 保存补充材料</button>
            <span class="hint" v-if="detail.postReviewSubmittedAt">上次提交时间：<b>{{ detail.postReviewSubmittedAt }}</b></span>
            <span class="hint err-text" v-else>尚未提交补审核材料</span>
          </div>
          <div class="kv mt8" v-if="detail.postReview">
            <template v-for="(v,key) in detail.postReview"><span class="k">{{ key }}</span><span>{{ v }}</span></template>
          </div>

          <!-- 补审核处理（FR-008.7 / FR-022） -->
          <div class="divider-label">补审核处理</div>
          <div v-if="detail.actions.canAct">
            <div class="alert info"><span>✅</span>
              <div>当前身份「{{ user.display }}」是节点「{{ detail.actions.node.name }}」的审批人，可执行该节点配置的动作；节点未配置的动作不显示按钮（FR-022.3）。</div>
            </div>
            <div class="form-row">
              <label>处理动作</label>
              <div class="ctrl">
                <div class="radios" style="flex-direction:row;gap:18px">
                  <label v-for="a in detail.actions.node.actions">
                    <input type="radio" :value="a" v-model="actForm.action">
                    {{ a==='approve' ? '通过补审核' : actionLabel(a) }}
                  </label>
                </div>
              </div>
            </div>
            <div class="form-row">
              <label :class="actForm.action==='approve' ? '' : 'req'">审批意见</label>
              <div class="ctrl"><textarea rows="2" v-model="actForm.comment" placeholder="驳回时必须填写原因"></textarea></div>
            </div>
            <div class="btn-row"><button class="btn primary" @click="doAct(actForm.action)">提交处理结果</button></div>
          </div>
          <div v-else class="alert warn"><span>ℹ️</span>
            <div>当前身份不是该实例待处理节点的审批人（或流程已结束），此处不显示处理按钮。补审核由流程配置的人员 / 科室 / 角色成员处理，可切换演示身份（如「审批人员·陈慧兰（科室）」）后重试；也可到审批中心看待办分布。</div>
          </div>

          <template v-if="detail.postNode && (detail.flowStatus==='post-review-done' || detail.postNode.actedBy)">
            <div class="divider-label">补审核结论（FR-008.7）</div>
            <div class="alert success" style="display:block"><span>✅</span>
              <div>
                <div v-if="detail.flowStatus==='post-review-done'"><b>补审核已完成</b>，实例状态「{{ detail.flowStatusName }}」，医嘱状态「{{ detail.request.orderStatusName }}」。</div>
                <div v-else><b>补审核节点已处理（{{ detail.postNode.stateName }}）</b>，实例整体状态仍为「{{ detail.flowStatusName }}」，未自动记为完成。</div>
                <div class="mt8">审核人：{{ detail.postNode.actedBy || '—' }} ｜ 完成时间：{{ detail.postNode.actedAt || '—' }}</div>
                <div>处理动作：{{ actionLabel(detail.postNode.actionKind) }}</div>
                <div>意见：{{ detail.postNode.comment || '—' }}</div>
                <div class="muted mt8" style="font-size:12px">「{{ detail.request.orderStatusName }}」仅表示本演示流程已满足补审核条件，不代表药品已真实发药或医嘱已实际执行。</div>
              </div>
            </div>
          </template>

          <div class="divider-label">FHIR 数据留痕</div>
          <div class="kv">
            <span class="k">审批实例</span><span>Task/{{ detail.mainId }}</span>
            <span class="k">开单资源</span><span>MedicationRequest/{{ detail.request.mrId }}</span>
            <span class="k">流程定义</span><span>{{ detail.pdId }} ｜ {{ detail.pdUrl }}</span>
            <span class="k">节点任务</span><span>{{ detail.nodes.map(function(n){return n.nodeTaskId;}).join('、') }}</span>
          </div>
          <div class="muted mt8" style="font-size:12px">以上为患者 → 就诊 → 开单 → 补审核任务 → 流程版本 → 留痕的关联键，可在「演示数据管理 → 数据关联核查」按患者逐层展开（SRS DEMO-15）。全部为虚构演示数据（BR-010）。</div>

          <template #foot>
            <button class="btn" @click="closeRow">关闭</button>
            <button class="btn ghost" @click="goCenter">在审批中心打开</button>
          </template>
        </ui-modal>

        <!-- 发起弹框 -->
        <ui-modal v-if="showCreate" title="发起紧急情况临时越级使用" width="wide" @close="showCreate=false">
          <div class="alert warn"><span>⚠️</span>
            <div>本入口用于<b>权限不足且情况紧急</b>时的临时越级使用：先用药、后补审核。紧急使用原因与临床说明<b>必填</b>（FR-008.2），提交后立刻生成 24 小时内补审核任务并进入审核中心待办（FR-008.4/5）。</div>
          </div>
          <div class="divider-label">第一步：患者与就诊</div>
          <div class="form-row">
            <label class="req">演示患者</label>
            <div class="ctrl">
              <select v-model="form.patientId" @change="onPatient">
                <option value="">请选择患者</option>
                <option v-for="p in patients" :value="p.id">{{ p.name }} ｜ {{ p.mrn }} ｜ {{ p.diagnosis }}</option>
              </select>
              <span class="err-text" v-if="errors.patientId">{{ errors.patientId }}</span>
            </div>
          </div>
          <div class="form-row">
            <label class="req">本次就诊</label>
            <div class="ctrl">
              <select v-model="form.encounterId">
                <option value="">请先选择患者</option>
                <option v-for="e in encounters" :value="e.id">{{ e.kindName }} ｜ {{ e.visitNo }} ｜ {{ e.start }}<span v-if="e.chief"> ｜ {{ e.chief }}</span></option>
              </select>
              <span class="err-text" v-if="errors.encounterId">{{ errors.encounterId }}</span>
            </div>
          </div>

          <div class="divider-label">第二步：越级使用的抗菌药物</div>
          <div class="form-row">
            <label>药品范围</label>
            <div class="ctrl">
              <div class="radios" style="flex-direction:row;gap:18px">
                <label><input type="radio" value="special" v-model="drugScope"> 仅特殊使用级</label>
                <label><input type="radio" value="all" v-model="drugScope"> 全部等级（含限制使用级）</label>
              </div>
              <span class="hint">越级使用通常发生在高于本人权限的等级上；权限满足时不会被记为紧急越级。</span>
            </div>
          </div>
          <div class="form-row">
            <label class="req">抗菌药物</label>
            <div class="ctrl">
              <select v-model="form.medicationId" @change="onDrug">
                <option value="">请选择药品</option>
                <option v-for="d in drugs" :value="d.id">{{ d.name }}（{{ d.drugCode }}）· {{ d.levelName }}</option>
              </select>
              <span class="err-text" v-if="errors.medicationId">{{ errors.medicationId }}</span>
            </div>
          </div>
          <div class="kv mt8" v-if="liveCheck">
            <span class="k">药品等级</span><span>{{ liveCheck.gradeName }}（等级来源：{{ liveCheck.gradeSource }}）</span>
            <span class="k">本人权限</span><span><b :class="liveCheck.allowed ? 'tag green' : 'tag red'">{{ liveCheck.allowed ? '权限符合' : '权限不足' }}</b>
              可用等级：{{ (liveCheck.allowedLevels||[]).map(function(l){return D.levelName(l);}).join('、') || '无' }}</span>
            <span class="k">判定依据</span><span>{{ liveCheck.hit ? (liveCheck.hit.srcLabel + ' — ' + liveCheck.hit.ruleText) : '—' }}</span>
            <span class="k">越级后流程</span><span>{{ liveCheck.route ? (liveCheck.route.title + ' V' + liveCheck.route.version + '（' + D.flowPurposeName(liveCheck.route.purpose) + '）') : '该等级尚未发布流程版本' }}</span>
            <span class="k">补审核截止</span><span>{{ fmt(liveCheck.emergencyDeadline) }}（提交时刻 + {{ deadlineHours }} 小时）</span>
          </div>
          <div class="alert danger mt8" v-if="liveCheck && liveCheck.allowed"><span>⚠️</span>
            <div>本人对该药<b>权限符合</b>，提交将按普通开单处理而不会生成紧急越级记录；如需演示补审核，请改用权限不足的医师身份（例如「医师·王伟（权限不足）」）。</div>
          </div>

          <div class="divider-label">第三步：用法与用药目的（BR-004 必填）</div>
          <div class="form-row">
            <label class="req">用法用量</label>
            <div class="ctrl">
              <input type="text" v-model="form.dosageText" placeholder="如：静脉滴注，1g/次，每12小时">
              <span class="err-text" v-if="errors.dosageText">{{ errors.dosageText }}</span>
            </div>
          </div>
          <div class="form-row">
            <label class="req">用药目的</label>
            <div class="ctrl">
              <select v-model="form.purposeCode">
                <option value="">请选择用药目的</option>
                <option v-for="p in D.PURPOSES" :value="p.code">{{ p.name }} —— {{ p.desc }}</option>
              </select>
              <span class="err-text" v-if="errors.purposeCode">{{ errors.purposeCode }}</span>
              <input type="text" v-model="form.purposeNote" placeholder="目的补充说明（可选）" class="mt8">
            </div>
          </div>

          <div class="divider-label">第四步：紧急使用原因与临床说明（FR-008.2 必填）</div>
          <div class="form-row">
            <label class="req">紧急使用原因</label>
            <div class="ctrl">
              <textarea rows="2" v-model="form.emergencyReason" placeholder="如：患者感染性休克早期，创面培养 MRSA 阳性，情况紧急来不及完成事前审批"></textarea>
              <span class="err-text" v-if="errors.emergencyReason">{{ errors.emergencyReason }}</span>
            </div>
          </div>
          <div class="form-row">
            <label class="req">临床说明</label>
            <div class="ctrl">
              <textarea rows="2" v-model="form.clinicalNote" placeholder="如：已留取血培养 2 套与创面分泌物培养，按体重负荷给药，拟 48 小时后依据药敏调整"></textarea>
              <span class="err-text" v-if="errors.clinicalNote">{{ errors.clinicalNote }}</span>
            </div>
          </div>

          <div class="alert info mt12"><span>ℹ️</span>
            <div>演示数据声明：患者、就诊、药品与理由均为<b>虚构演示数据</b>（SRS BR-010），提交结果仅用于演示分级流程，不构成真实临床处方或用药建议。</div>
          </div>
          <template #foot>
            <button class="btn" @click="showCreate=false">取消</button>
            <button class="btn primary" @click="doCreate">确认提交紧急越级使用</button>
          </template>
        </ui-modal>
      </div>
    </div>`
  };
})(window);
