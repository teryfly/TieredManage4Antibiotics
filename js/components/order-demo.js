/* =====================================================================
 * order-demo.js —— 临床开单演示（SRS FR-005 开立时按医师权限判断、
 * FR-006 权限不足自动提示、FR-007 超权限触发审批、FR-010 提交时选择用药目的）
 * ---------------------------------------------------------------------
 * 这是演示闭环的入口：选患者/就诊/药品 → 实时权限判定 → 提交（二次判定）
 * → 用药目的弹窗 → 按判定结果分岔为「直接允许 / 提交审批 / 紧急越级」。
 * ===================================================================== */
(function (global) {
  'use strict';
  var AMS = global.AMS, Svc = global.Svc, D = global.Domain, App = global.App;
  var Ap = global.Approval;

  AMS.pages['order-demo'] = {
    data: function () {
      return {
        tab: 'order',
        form: {
          patientId: '', encounterId: '', medicationId: '',
          dosageText: '', frequency: 'q12h', days: 7, reason: '',
          purposeCode: '', purposeNote: ''
        },
        check: null,
        showPurpose: false,
        showDenied: false,
        showEmergency: false,
        emergency: { reason: '', clinicalNote: '' },
        result: null,
        submitting: false,
        errors: {}
      };
    },
    computed: {
      D: function () { return D; },
      Ap: function () { return Ap; },
      user: function () { return App.currentUser(); },
      role: function () { return App.state.roleCode; },
      canView: function () { return D.canAccess(this.role, 'order-demo'); },
      authz: function () { App.state.refresh; return Ap.authorizations(this.user.practitioner); },
      patients: function () { App.state.refresh; return Svc.srs.orderPatients(); },
      encounters: function () { App.state.refresh; return this.form.patientId ? Svc.srs.encounters(this.form.patientId) : []; },
      patient: function () {
        var self = this;
        return this.patients.filter(function (p) { return p.id === self.form.patientId; })[0] || null;
      },
      encounter: function () {
        var self = this;
        return this.encounters.filter(function (e) { return e.id === self.form.encounterId; })[0] || null;
      },
      drugs: function () {
        App.state.refresh;
        return Svc.srs.searchDrugs({ level: this.filterLevel })
          .filter(function (d) { return d.enabled; });
      },
      drug: function () { return this.form.medicationId ? Svc.srs.drug(this.form.medicationId) : null; },
      /* FR-005.1/2：选定药品后自动读取等级与当前医师授权并比较 */
      liveCheck: function () {
        App.state.refresh;
        if (!this.form.medicationId) return null;
        return Ap.check({ practitioner: this.user.practitioner, medicationId: this.form.medicationId });
      },
      myOrders: function () {
        App.state.refresh;
        return Svc.srs.centerRows(this.user.practitioner, 'mine');
      },
      levelFilterOptions: function () { return [{ code: '', name: '全部等级' }].concat(D.LEVELS); }
    },
    methods: {
      toast: App.toast,
      goCenter: function () { App.navigate('approval-center'); },
      refreshServer: function () { App.refreshFromServer(); },
      onPatient: function () { this.form.encounterId = ''; },
      onDrug: function () {
        var d = this.drug;
        this.form.dosageText = d ? d.usage : '';
        this.check = this.liveCheck;
        this.result = null;
      },
      /* FR-005.7：判定在提交时再执行一次，不能只在选药时做一次 */
      validate: function () {
        var e = {};
        if (!this.form.patientId) e.patientId = '请选择患者';
        if (!this.form.encounterId) e.encounterId = '请选择就诊记录';
        if (!this.form.medicationId) e.medicationId = '请选择抗菌药物';
        if (!this.form.dosageText) e.dosageText = '请填写用法用量';
        this.errors = e;
        return !Object.keys(e).length;
      },
      submit: function () {
        if (!this.validate()) { App.toast('请完善必填信息', 'error'); return; }
        var chk = Ap.check({ practitioner: this.user.practitioner, medicationId: this.form.medicationId });
        this.check = chk;
        if (!chk.allowed) {
          // FR-006：权限不足自动弹出提示，内容含药品/等级/医师/授权/不足原因
          this.showDenied = true;
          return;
        }
        // FR-010：提交时先弹出用药目的选择
        this.showPurpose = true;
      },
      goEmergency: function () {
        this.showDenied = false;
        this.showEmergency = true;
      },
      goApproval: function () {
        this.showDenied = false;
        this.showPurpose = true;
      },
      /* 真正提交：用药目的必填（BR-004），内部再判一次权限（FR-005.7） */
      doSubmit: function (emergency) {
        var self = this;
        var payload = {
          practitionerId: this.user.practitioner,
          medicationId: this.form.medicationId,
          patientId: this.form.patientId,
          encounterId: this.form.encounterId,
          patientName: this.patient ? this.patient.name : '',
          mrn: this.patient ? this.patient.mrn : '',
          diagnosis: this.patient ? this.patient.diagnosis : '',
          purposeCode: this.form.purposeCode,
          purposeNote: this.form.purposeNote,
          dosageText: this.form.dosageText,
          frequency: this.form.frequency,
          days: this.form.days,
          reason: this.form.reason || (emergency ? '紧急情况临时越级使用' : ''),
          expectedLevel: this.check ? this.check.grade : '',
          emergency: !!emergency,
          emergencyReason: emergency ? this.emergency.reason : '',
          clinicalNote: emergency ? this.emergency.clinicalNote : ''
        };
        if (payload.purposeCode === '') { App.toast('请选择抗菌药物使用目的', 'error'); return; }   // BR-004
        if (emergency && !payload.emergencyReason) { App.toast('请填写紧急使用原因及临床说明', 'error'); return; }  // FR-008.2
        var res;
        try {
          res = Svc.srs.submitOrder(payload);
        } catch (err) {
          App.toast(err.message, 'error');
          if (err.code === 'NO_FLOW') App.navigate('workflow-designer');
          return;
        }
        this.showPurpose = false; this.showEmergency = false;
        this.result = res;
        this.tab = 'result';
        var msg = res.mode === 'direct' ? '权限符合，已提交（未触发越权审批）'
          : res.mode === 'emergency' ? '已临时越级使用，补审核任务已生成'
            : '超权限申请已提交，已进入审批流程';
        App.toast(msg);
        App.bump();
        setTimeout(function () { self.check = null; }, 50);
      },
      resetForm: function () {
        this.form = { patientId: '', encounterId: '', medicationId: '', dosageText: '', frequency: 'q12h', days: 7, reason: '', purposeCode: '', purposeNote: '' };
        this.check = null; this.result = null; this.tab = 'order';
      },
      centerOf: function (r) {
        App.navigate(r.mode === 'emergency' ? 'emergency-review' : 'approval-center');
      },
      flowNodeNames: function (r) {
        return (r.nodes || []).map(function (n) { return n.roleName; }).join(' → ');
      },
      purposeOptions: function () { return D.PURPOSES; }
    },
    template: `
    <div v-if="!canView" class="card"><div class="card-body">
      <empty-state icon="🔒" text="本页面仅对「开单医师」角色开放。请使用顶部演示身份切换为「医师·王伟（权限不足）」或「医师·张建华（权限满足）」。"></empty-state>
    </div></div>

    <div v-else>
      <div class="tabs-top" style="margin-bottom:12px">
        <button class="btn" :class="{primary: tab==='order'}" @click="tab='order'">① 开立抗菌药物</button>
        <button class="btn" :class="{primary: tab==='result'}" :disabled="!result" @click="tab='result'">② 本次提交结果</button>
        <button class="btn" :class="{primary: tab==='mine'}" @click="tab='mine'">③ 我的申请进展</button>
      </div>

      <!-- ================= 开单 ================= -->
      <div v-if="tab==='order'">
        <div class="alert info"><span>ℹ️</span>
          <div>本页是<b>模拟临床开单入口</b>，用于演示分级规则如何嵌入临床业务流程（SRS §1.4）；
          不替代完整 HIS / 门诊与住院医生工作站，所有患者、医师、药品均为<b>虚构演示数据</b>。</div>
        </div>

        <div class="row">
          <div class="col card" style="min-width:420px">
            <div class="card-head"><h3>🧑‍⚕️ 就诊与医师信息</h3></div>
            <div class="card-body">
              <div class="kv">
                <span class="k">当前登录医师</span>
                <span><b>{{ user.name }}</b> · {{ D.titleName(authz.practitioner.title) }} · {{ authz.practitioner.dept || user.dept }}
                  <span class="tag blue">{{ D.roleName(role) }}</span></span>
                <span class="k">本次可开等级</span>
                <span>
                  <span v-if="!authz.levels.length" class="tag red">无有效授权</span>
                  <span v-for="lv in authz.levels" :key="lv.code" class="tag" :class="D.levelTone(lv)" style="margin-right:4px">{{ D.levelName(lv) }}</span>
                </span>
                <span class="k">命中授权层</span>
                <span>{{ authz.hit.srcLabel }} — {{ authz.hit.ruleText }}</span>
              </div>
              <div class="divider-label">患者与就诊</div>
              <div class="form-row">
                <label class="req">患者</label>
                <div class="ctrl">
                  <select v-model="form.patientId" @change="onPatient" :class="{invalid:errors.patientId}">
                    <option value="">请选择虚构患者</option>
                    <option v-for="p in patients" :value="p.id">{{ p.name }}（{{ p.mrn }}）· {{ p.diagnosis }}</option>
                  </select>
                  <span class="err-text" v-if="errors.patientId">请选择患者</span>
                  <div class="muted" v-if="patient">感染情况：{{ patient.infection || '—' }}</div>
                </div>
              </div>
              <div class="form-row">
                <label class="req">就诊记录</label>
                <div class="ctrl">
                  <select v-model="form.encounterId" :disabled="!form.patientId" :class="{invalid:errors.encounterId}">
                    <option value="">请选择门诊/住院/急诊就诊</option>
                    <option v-for="e in encounters" :value="e.id">{{ e.kindName }} {{ e.visitNo }} · {{ e.start }}{{ e.bed ? '（床位 '+e.bed+'）' : '' }}</option>
                  </select>
                  <span class="err-text" v-if="errors.encounterId">请选择就诊记录</span>
                </div>
              </div>
            </div>
          </div>

          <div class="col card" style="min-width:420px">
            <div class="card-head"><h3>💊 抗菌药物与用法</h3></div>
            <div class="card-body">
              <div class="form-row"><label>按等级筛选</label>
                <div class="ctrl"><select v-model="filterLevel">
                  <option v-for="o in levelFilterOptions" :value="o.code">{{ o.name }}</option>
                </select></div>
              </div>
              <div class="form-row">
                <label class="req">抗菌药物</label>
                <div class="ctrl">
                  <select v-model="form.medicationId" @change="onDrug" :class="{invalid:errors.medicationId}">
                    <option value="">请选择药品（演示目录）</option>
                    <option v-for="d in drugs" :value="d.id">{{ d.name }} — {{ d.levelName }}{{ d.demoMark ? '（'+d.demoMark+'）' : '' }}</option>
                  </select>
                  <span class="err-text" v-if="errors.medicationId">请选择抗菌药物</span>
                </div>
              </div>
              <div v-if="drug">
                <div class="kv">
                  <span class="k">药品编码</span><span>{{ drug.drugCode }}</span>
                  <span class="k">剂型/规格</span><span>{{ drug.form }} / {{ drug.spec }}</span>
                  <span class="k">药品分类</span><span>{{ drug.drugClass }}</span>
                  <span class="k">抗菌药物等级</span><span><level-tag :level="drug.level"></level-tag>
                    <span class="muted">生效来源：{{ drug.levelSource }}</span></span>
                </div>
                <div class="form-row"><label class="req">用法用量</label>
                  <div class="ctrl"><textarea v-model="form.dosageText" :class="{invalid:errors.dosageText}" placeholder="如：静脉滴注，0.5~1g/次，每8小时1次"></textarea>
                    <span class="err-text" v-if="errors.dosageText">请填写用法用量</span></div>
                </div>
                <div class="form-row"><label>频次 / 疗程</label>
                  <div class="ctrl" style="flex-direction:row;gap:8px;align-items:center">
                    <select v-model="form.frequency" style="width:130px">
                      <option value="q8h">q8h</option><option value="q12h">q12h</option><option value="qd">qd</option><option value="bid">bid</option>
                    </select>
                    <input type="number" min="1" max="28" v-model.number="form.days" style="width:90px"> 天
                  </div>
                </div>
                <div class="form-row"><label>申请原因（提交审批时展示给审批人）</label>
                  <div class="ctrl"><textarea v-model="form.reason" placeholder="如：痰培养 ESBLs 阳性，经验治疗无效…"></textarea></div>
                </div>
              </div>
            </div>
          </div>

          <!-- FR-005.6：判定结果显示药品等级、医师可用等级、命中规则来源与处理建议 -->
          <div class="col card" style="min-width:360px">
            <div class="card-head"><h3>🛡️ 权限校验结果</h3></div>
            <div class="card-body">
              <div v-if="!liveCheck"><empty-state icon="💊" text="请选择抗菌药物后自动校验"></empty-state></div>
              <template v-else>
                <div class="alert" :class="liveCheck.allowed ? 'success':'danger'" style="display:block">
                  <div style="font-size:15px;font-weight:600">
                    {{ liveCheck.allowed ? '✅ 权限符合' : '⛔ 权限不足' }}
                  </div>
                  <div class="muted" style="margin-top:4px">{{ liveCheck.reason }}</div>
                </div>
                <div class="kv">
                  <span class="k">药品等级</span><span><level-tag :level="liveCheck.grade"></level-tag>
                    <span class="muted">{{ liveCheck.gradeSource }}</span></span>
                  <span class="k">医师可用等级</span>
                  <span><span v-if="!liveCheck.allowedLevels.length" class="tag gray">无</span>
                    <span v-for="lv in liveCheck.allowedLevels" :key="lv" class="tag" :class="D.levelTone(lv)" style="margin-right:4px">{{ D.levelName(lv) }}</span></span>
                  <span class="k">命中规则来源</span><span>{{ liveCheck.hit.srcLabel }}</span>
                  <span class="k">规则原文</span><span class="muted">{{ liveCheck.hit.ruleText }}</span>
                  <span class="k">合并优先级</span><span class="muted">{{ liveCheck.priorityLabel }}</span>
                  <span class="k">处理建议</span><span>{{ liveCheck.suggestion }}</span>
                </div>
                <div class="divider-label">三层授权对照</div>
                <div class="kv">
                  <span class="k" v-for="(L,k) in liveCheck.layers" :key="k">
                    {{ L.label }}<template v-if="liveCheck.hit.layer===k">（命中）</template></span>
                  <span v-for="(L,k) in liveCheck.layers" :key="'v'+k">
                    <span v-if="!L.configured" class="tag gray">未配置</span>
                    <template v-else>
                      <span v-if="!L.levels.length" class="tag gray">无等级</span>
                      <span v-for="lv in L.levels" :key="lv" class="tag" :class="D.levelTone(lv)" style="margin-right:3px">{{ D.levelName(lv) }}</span>
                    </template>
                    <div class="muted" style="font-size:11px">{{ L.source }}</div>
                  </span>
                </div>
                <div class="alert info" v-if="!liveCheck.allowed && !liveCheck.route" style="display:block">
                  <div>该等级尚未发布审批流程，无法发起审批。请先在「审批流程设计」发布版本。</div>
                </div>
                <div class="kv" v-if="liveCheck.route">
                  <span class="k">将走的流程</span><span>{{ liveCheck.route.title }} {{ liveCheck.route.label }}</span>
                  <span class="k">审批节点</span><span>{{ liveCheck.route.nodes.filter(function(n){return n.type!=='start'&&n.type!=='end';}).map(function(n){return n.name;}).join(' → ') }}</span>
                </div>
              </template>
              <div class="btn-row" style="justify-content:flex-end;margin-top:12px">
                <button class="btn" @click="resetForm">清空</button>
                <button class="btn primary" @click="submit">提交抗菌药物</button>
              </div>
            </div>
          </div>
        </div>
      </div>

      <!-- ================= 提交结果 ================= -->
      <div v-else-if="tab==='result' && result">
        <div class="card">
          <div class="card-head">
            <h3>{{ result.mode==='direct' ? '✅ 权限符合，直接允许使用' : (result.mode==='emergency' ? '🚨 已临时越级使用，等待 24 小时内补审核' : '📤 超权限，已提交审批') }}</h3>
            <button class="btn" @click="tab='order'">返回修改</button>
          </div>
          <div class="card-body">
            <div class="alert" :class="result.mode==='direct'?'success':(result.mode==='emergency'?'danger':'info')" style="display:block">
              <div><b>{{ result.medicationRequest.ext.orderNo }}</b> ·
                <span>{{ result.medicationRequest.ext.drugName }}</span>
                <level-tag :level="result.medicationRequest.ext.gradeSnapshot.level"></level-tag>
                <span class="muted">等级快照：{{ result.medicationRequest.ext.gradeSnapshot.name }}（{{ result.medicationRequest.ext.gradeSnapshot.at }}）</span>
              </div>
            </div>
            <div class="kv">
              <span class="k">医嘱业务状态</span><span class="tag blue">{{ D.orderStatusName(result.medicationRequest.ext.orderStatus) }}</span>
              <span class="k">用药目的</span><span>{{ result.medicationRequest.ext.purpose.name }}
                <template v-if="result.medicationRequest.ext.purpose.note">：{{ result.medicationRequest.ext.purpose.note }}</template></span>
              <span class="k">权限命中来源</span><span>{{ result.medicationRequest.ext.authzHit.srcLabel }} — {{ result.medicationRequest.ext.authzHit.ruleText }}</span>
              <span class="k">开单时间</span><span>{{ result.medicationRequest.ext.createdAt }}</span>
            </div>

            <template v-if="result.mode==='direct'">
              <div class="divider-label">本例未触发越权审批</div>
              <div class="alert info"><span>ℹ️</span><div>药品等级在医师可开范围内，系统完成权限校验与用药目的记录，形成可查询的演示 MedicationRequest（SRS DEMO-05 预期结果）。</div></div>
              <div class="kv">
                <span class="k">FHIR 资源</span><span>MedicationRequest/{{ result.medicationRequest.id }}</span>
                <span class="k">开单编号</span><span>{{ result.medicationRequest.ext.orderNo }}</span>
              </div>
            </template>

            <template v-else-if="result.mode==='approval'">
              <div class="divider-label">审批申请进展（FR-006.4：工作台显示申请编号、当前状态与当前审批节点）</div>
              <div class="kv">
                <span class="k">申请编号</span><span><b>{{ result.instance.ext.sqno }}</b></span>
                <span class="k">当前状态</span><span><status-tag :status="result.instance.status"></status-tag> {{ result.instance.ext.flowStatusName || D.flowStatusName(result.instance.ext.flowStatus) }}</span>
                <span class="k">当前审批节点</span><span>{{ (result.nodes.filter(function(n){return n.status==='current';})[0]||{}).roleName || '—' }}</span>
                <span class="k">流程版本</span><span>{{ result.flowTitle }} V{{ result.version }}</span>
              </div>
              <div class="steps" style="margin:10px 0">
                <div class="step" v-for="(n,i) in result.nodes" :key="n.seq" :class="n.status">
                  <div class="dot">{{ n.status==='approved'?'✓':(i+1) }}</div><div class="bar" v-if="i<result.nodes.length-1"></div>
                  <div class="s-name">{{ n.roleName }}</div>
                  <div class="s-meta">{{ n.status==='current'?'当前节点':(n.status==='approved'?'已通过':'待处理') }}</div>
                </div>
              </div>
              <div class="btn-row"><button class="btn primary" @click="centerOf(result)">前往审批中心查看进展</button></div>
            </template>

            <template v-else>
              <div class="divider-label">紧急越级与补审核期限</div>
              <div class="alert danger" style="display:block">
                <div><b>24 小时补审核截止时间：{{ (result.deadline||'').replace('T',' ') }}</b></div>
                <div class="muted">剩余时间：{{ result.instance.ext.postReviewDeadline ? Ap.EMERGENCY_HOURS : 24 }} 小时期限内须由配置的补审核节点完成审核。</div>
              </div>
              <div class="kv">
                <span class="k">申请编号</span><span><b>{{ result.instance.ext.sqno }}</b></span>
                <span class="k">流程标识</span><span>{{ D.flowPurposeName(result.instance.ext.purpose) }}（与普通权限审批使用不同流程标识，SRS FR-008.10）</span>
                <span class="k">医嘱业务状态</span><span>{{ D.orderStatusName(result.instance.ext.orderStatus) }}</span>
                <span class="k">紧急原因</span><span>{{ emergency.reason }}</span>
                <span class="k">临床说明</span><span>{{ emergency.clinicalNote || '—' }}</span>
              </div>
              <div class="btn-row"><button class="btn primary" @click="centerOf(result)">前往「紧急越级补审核」提交材料</button></div>
            </template>

            <div class="alert warn" style="display:block;margin-top:12px">
              <div>本页面的「可提交临床系统」仅代表<b>本演示流程已满足审批条件</b>，不代表药品已真实发药或实际执行（SRS §3.4）。</div>
            </div>
          </div>
        </div>
      </div>

      <!-- ================= 我的申请 ================= -->
      <div v-else-if="tab==='mine'">
        <div class="card">
          <div class="card-head"><h3>📋 我发起的抗菌药物申请</h3>
            <button class="btn" @click="refreshServer()">🔄 从服务端刷新</button></div>
          <div class="card-body" style="padding:0">
            <div class="table-wrap"><table class="tbl" v-if="myOrders.length">
              <thead><tr><th>申请编号</th><th>患者</th><th>药品 / 等级</th><th>申请时间</th><th>当前节点</th><th>流程版本</th><th>状态</th><th>操作</th></tr></thead>
              <tbody>
                <tr v-for="r in myOrders">
                  <td>{{ r.sqno }}</td>
                  <td>{{ r.patient }}</td>
                  <td>{{ r.drug }} <level-tag :level="r.level"></level-tag></td>
                  <td class="nowrap">{{ r.createdAt }}</td>
                  <td>{{ r.currentNode }}<div class="muted" v-if="r.currentAssignees.length">待 {{ r.currentAssignees.join('、') }}</div></td>
                  <td>{{ r.version }}</td>
                  <td><span class="tag" :class="r.tone">{{ r.flowStatusName }}</span>
                    <div v-if="r.timeout.timeout" class="tag red">{{ r.timeout.text }}</div></td>
                  <td class="actions"><a class="btn-link" @click="goCenter()">详情</a></td>
                </tr>
              </tbody>
            </table>
            <empty-state v-else text="暂无申请记录"></empty-state></div>
          </div>
        </div>
      </div>

      <!-- ============ FR-006 权限不足自动提示弹框 ============ -->
      <ui-modal v-if="showDenied && check" title="⛔ 抗菌药物使用权限不足" @close="showDenied=false">
        <div class="alert danger" style="display:block">
          <div><b>本提示不是审批通过。</b>该药品超出您当前权限，普通提交已被阻止，需经审批或紧急情况临时越级使用。</div>
        </div>
        <div class="kv">
          <span class="k">当前药品</span><span>{{ check.medicationName }}（{{ check.medicationCode }}）</span>
          <span class="k">药品等级</span><span><level-tag :level="check.grade"></level-tag> {{ check.gradeName }}</span>
          <span class="k">当前医生</span><span>{{ user.name }} · {{ D.titleName(check.practitioner.title) }} · {{ check.practitioner.dept }}</span>
          <span class="k">医生授权等级</span>
          <span><span v-if="!check.allowedLevels.length" class="tag gray">无有效授权</span>
            <span v-for="lv in check.allowedLevels" :key="lv" class="tag" :class="D.levelTone(lv)" style="margin-right:4px">{{ D.levelName(lv) }}</span></span>
          <span class="k">命中的授权规则</span><span>{{ check.hit.srcLabel }} — {{ check.hit.ruleText }}</span>
          <span class="k">权限不足原因</span><span>{{ check.reason }}</span>
          <span class="k">缺少的授权等级</span><span><span v-for="lv in check.missingLevels" :key="lv" class="tag orange" style="margin-right:4px">{{ D.levelName(lv) }}</span></span>
        </div>
        <div class="divider-label">下一步</div>
        <div class="kv" v-if="check.route">
          <span class="k">将触发的审批流程</span><span>{{ check.route.title }} V{{ check.route.version }}</span>
          <span class="k">审批节点</span><span>{{ check.route.nodes.filter(function(n){return n.type!=='start'&&n.type!=='end';}).map(function(n){return n.name+'（'+D.assigneeTypeName(n.assigneeType)+'）';}).join(' → ') }}</span>
        </div>
        <div class="alert warn" v-else style="display:block"><div>该等级尚未发布审批流程，请先在「审批流程设计」发布版本后再提交。</div></div>
        <template #foot>
          <button class="btn" @click="showDenied=false">返回修改</button>
          <button class="btn" @click="goEmergency" :disabled="!check.route">紧急情况临时越级使用</button>
          <button class="btn primary" @click="goApproval" :disabled="!check.route">提交审批申请</button>
        </template>
      </ui-modal>

      <!-- ============ FR-010 用药目的选择（提交前置步骤） ============ -->
      <ui-modal v-if="showPurpose" :title="check && check.allowed ? '选择抗菌药物使用目的' : '提交审批前：选择抗菌药物使用目的'" @close="showPurpose=false">
        <div class="alert info" style="display:block">
          <div>SRS FR-010：医师下达提交抗菌药物时自动弹出提醒，由医师选择明确的抗菌药物使用目的；<b>未选择用药目的不允许完成提交</b>（BR-004）。</div>
        </div>
        <div class="form-row">
          <label class="req">使用目的分类</label>
          <div class="ctrl">
            <div class="checks" style="flex-direction:column;gap:8px">
              <label v-for="p in purposeOptions()" :key="p.code" style="display:block">
                <input type="radio" name="purpose" :value="p.code" v-model="form.purposeCode">
                <b>{{ p.name }}</b> <span class="muted">{{ p.desc }}</span>
              </label>
            </div>
            <span class="err-text" v-if="!form.purposeCode">未选择用药目的不能提交（BR-004）</span>
          </div>
        </div>
        <div class="form-row"><label>补充说明</label>
          <div class="ctrl"><textarea v-model="form.purposeNote" placeholder="如：痰培养 ESBLs 阳性，依据药敏选择"></textarea>
            <div class="muted">用药目的将与患者、就诊、抗菌药物及本次开单一起保存，审批人员可在任务详情查看（FR-010.4/5）。</div></div>
        </div>
        <div class="kv" v-if="drug">
          <span class="k">本次药品</span><span>{{ drug.name }} <level-tag :level="drug.level"></level-tag></span>
          <span class="k">患者 / 就诊</span><span>{{ patient ? patient.name : '' }} · {{ encounter ? encounter.kindName + ' ' + encounter.visitNo : '' }}</span>
        </div>
        <template #foot>
          <button class="btn" @click="showPurpose=false">取消</button>
          <button class="btn" v-if="check && !check.allowed" @click="showPurpose=false;goEmergency()">改为紧急越级使用</button>
          <button class="btn primary" @click="doSubmit(!!(check && !check.allowed && emergency.reason))">{{ check && check.allowed ? '确认提交' : '提交审批申请' }}</button>
        </template>
      </ui-modal>

      <!-- ============ FR-008 紧急越级弹框 ============ -->
      <ui-modal v-if="showEmergency" title="🚨 紧急情况临时越级使用" @close="showEmergency=false">
        <div class="alert danger" style="display:block">
          <div>紧急情况下允许临时越级使用，但<b>必须创建事后补审核任务并在 24 小时内完成</b>（SRS BR-005）。
          补审核使用独立流程标识：{{ D.flowPurposeName('emergency-review') }}，不会被显示成普通审批通过。</div>
        </div>
        <div class="kv" v-if="check">
          <span class="k">药品 / 等级</span><span>{{ check.medicationName }} <level-tag :level="check.grade"></level-tag></span>
          <span class="k">发起医师</span><span>{{ user.name }} · {{ D.titleName(check.practitioner.title) }} · {{ check.practitioner.dept }}</span>
          <span class="k">患者</span><span>{{ patient ? patient.name + '（' + patient.mrn + '）' : '—' }}</span>
          <span class="k">补审核截止</span><span><b>{{ (check.emergencyDeadline||'').replace('T',' ') }}</b>（发起时间 + 24 小时）</span>
        </div>
        <div class="form-row"><label class="req">紧急使用原因 *</label>
          <div class="ctrl"><textarea v-model="emergency.reason" placeholder="如：患者感染性休克早期，情况紧急来不及完成事前审批"></textarea></div>
        </div>
        <div class="form-row"><label>必要的临床说明</label>
          <div class="ctrl"><textarea v-model="emergency.clinicalNote" placeholder="如：已留取血培养 2 套，按体重负荷给药，48 小时后依据药敏调整"></textarea></div>
        </div>
        <div class="form-row"><label class="req">用药目的 *</label>
          <div class="ctrl"><select v-model="form.purposeCode"><option value="">请选择</option>
            <option v-for="p in purposeOptions()" :value="p.code">{{ p.name }}</option></select></div>
        </div>
        <template #foot>
          <button class="btn" @click="showEmergency=false">取消</button>
          <button class="btn primary" @click="doSubmit(true)">确认提交紧急使用记录</button>
        </template>
      </ui-modal>
    </div>`
  };
})(window);
