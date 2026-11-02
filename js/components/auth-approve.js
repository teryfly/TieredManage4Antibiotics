/* =====================================================================
 * auth-approve.js —— L3-1-2 处方权限审批（审批专家）
 * 审批专家查看待审批申请，查阅材料与适应症校验，作出通过/驳回决定。
 * ===================================================================== */
(function (global) {
  'use strict';
  var AMS = global.AMS, Svc = global.Svc, D = global.Domain, App = global.App;

  AMS.pages['auth-approve'] = {
    data: function () {
      return {
        filter: { status: 'in-progress', type: 'all', dept: 'all', from: '', to: '' },
        page: 1, size: 10,
        showModal: false, current: null,
        decision: '', reason: '',
        selected: [],
        showBatch: false, batchDecision: '', batchReason: ''
      };
    },
    computed: {
      // 模板里裸用 D.xxx() 取不到值（Vue 只在实例上查找），显式暴露领域常量
      D: function () { return D; },
      role: function () { return App.state.roleCode; },
      // 药学部门与审批专家均是处方权限审批流程中的一环，均可访问本页面
      isApprover: function () { return App.state.roleCode === 'expert' || App.state.roleCode === 'pharmacy'; },
      all: function () { App.state.refresh; return Svc.applicationsForApprover(this.role); },
      depts: function () { return D.DEPARTMENTS; },
      filtered: function () {
        var f = this.filter;
        return this.all.filter(function (t) {
          if (f.status !== 'all' && t.status !== f.status) return false;
          if (f.type !== 'all' && t.ext.type !== f.type) return false;
          if (f.dept !== 'all' && t.ext.dept !== f.dept) return false;
          var d = (t.authoredOn || '').slice(0, 10);
          if (f.from && d < f.from) return false;
          if (f.to && d > f.to) return false;
          return true;
        });
      },
      paged: function () { var s = (this.page - 1) * this.size; return this.filtered.slice(s, s + this.size); },
      // 当前页中轮到"我"（当前角色）处理的待审批项
      pendingInPage: function () { var role = this.role; return this.paged.filter(function (t) { return Svc.isMyTurn(t, role); }); },
      allChecked: function () { return this.pendingInPage.length > 0 && this.pendingInPage.every((t) => this.selected.indexOf(t.id) >= 0); },
      isMyTurn: function () { var role = this.role; return function (t) { return Svc.isMyTurn(t, role); }; },
      checks: function () { return this.current ? Svc.validateIndication(this.current.ext.drug, this.current.ext.infection) : []; },
      rejectTemplates: function () {
        return ['缺少药敏/病原学依据，建议完善检查后再申请', '用药指征与适应症知识库标准不符', '用药时长偏长，建议调整治疗方案', '建议先行经验性降阶梯治疗'];
      }
    },
    methods: {
      // R4 的 authoredOn 是 ISO instant，界面按「年-月-日 时:分」展示
      fmtInstant: Svc.fmtInstant,
      reset: function () { this.filter = { status: 'in-progress', type: 'all', dept: 'all', from: '', to: '' }; this.page = 1; this.selected = []; },
      open: function (t) { this.current = t; this.decision = ''; this.reason = ''; this.showModal = true; },
      pickTpl: function (tpl) { this.reason = tpl; },
      confirm: function () {
        if (!this.decision) { App.toast('请选择通过或驳回', 'error'); return; }
        if (this.decision === 'rejected' && !this.reason.trim()) { App.toast('驳回时必须填写理由', 'error'); return; }
        Svc.approveApplication(this.current.id, this.decision, this.reason);
        this.showModal = false;
        App.toast(this.decision === 'approved' ? '已通过该申请，医师可开具对应药品' : '已驳回该申请');
      },
      checkIcon: function (i) { return i === 'ok' ? '✅' : (i === 'warn' ? '⚠️' : '❌'); },
      viewAttachment: function (a) { if (a.dataUrl) window.open(a.dataUrl, '_blank'); else App.toast('该附件无法预览', 'error'); },
      // 批量审批
      toggleOne: function (id) { var i = this.selected.indexOf(id); if (i >= 0) this.selected.splice(i, 1); else this.selected.push(id); },
      toggleAll: function (e) {
        if (e.target.checked) { this.selected = this.pendingInPage.map(function (t) { return t.id; }); }
        else { this.selected = []; }
      },
      openBatch: function (decision) {
        if (!this.selected.length) { App.toast('请先勾选待审批申请', 'error'); return; }
        this.batchDecision = decision; this.batchReason = ''; this.showBatch = true;
      },
      confirmBatch: function () {
        if (this.batchDecision === 'rejected' && !this.batchReason.trim()) { App.toast('批量驳回时必须填写理由', 'error'); return; }
        var self = this, n = this.selected.length;
        this.selected.forEach(function (id) { Svc.approveApplication(id, self.batchDecision, self.batchReason); });
        this.selected = []; this.showBatch = false;
        App.toast('已批量' + (this.batchDecision === 'approved' ? '通过' : '驳回') + ' ' + n + ' 件申请');
      }
    },
    template: `
    <div v-if="!isApprover" class="card"><div class="card-body"><empty-state icon="🔒" text="本页面仅对「审批专家」「药学部门」角色开放。请使用顶部演示角色切换为对应身份。"></empty-state></div></div>
    <div v-else>
      <div class="card">
        <div class="card-body">
          <div class="filter-bar">
            <div class="field"><label>审批状态</label>
              <select v-model="filter.status"><option value="in-progress">待审批</option><option value="completed">已通过</option><option value="rejected">已驳回</option><option value="all">全部</option></select>
            </div>
            <div class="field"><label>申请类型</label>
              <select v-model="filter.type"><option value="all">全部</option><option value="restricted">限制使用级</option><option value="special">特殊使用级</option></select>
            </div>
            <div class="field"><label>申请科室</label>
              <select v-model="filter.dept"><option value="all">全部</option><option v-for="d in depts" :value="d">{{ d }}</option></select>
            </div>
            <div class="field"><label>申请时间</label>
              <div style="display:flex;gap:6px;align-items:center"><input type="date" v-model="filter.from"> ~ <input type="date" v-model="filter.to"></div>
            </div>
            <button class="btn primary" @click="page=1">查询</button><button class="btn" @click="reset">重置</button>
          </div>
        </div>
      </div>

      <div class="card mt16">
        <div class="card-head">
          <h3>📝 审批申请列表</h3>
          <div class="btn-row">
            <span class="muted" v-if="selected.length">已选 {{ selected.length }} 件</span>
            <button class="btn sm primary" :disabled="!selected.length" @click="openBatch('approved')">批量通过</button>
            <button class="btn sm danger" :disabled="!selected.length" @click="openBatch('rejected')">批量驳回</button>
            <span class="muted">待审批 {{ all.filter(isMyTurn).length }} 件</span>
          </div>
        </div>
        <div class="card-body" style="padding:0">
          <div class="table-wrap">
          <table class="tbl" v-if="paged.length">
            <thead><tr><th style="width:36px"><input type="checkbox" :checked="allChecked" @change="toggleAll" :disabled="!pendingInPage.length"></th><th>申请编号</th><th>申请类型</th><th>申请人</th><th>科室</th><th>申请药品</th><th>申请时间</th><th>审批状态</th><th>操作</th></tr></thead>
            <tbody>
              <tr v-for="t in paged">
                <td><input type="checkbox" v-if="isMyTurn(t)" :checked="selected.indexOf(t.id)>=0" @change="toggleOne(t.id)"></td>
                <td class="nowrap">{{ t.identifier[0].value }}</td>
                <td><level-tag :level="t.ext.type"></level-tag></td>
                <td>{{ t.requester.display }}</td>
                <td>{{ t.ext.dept }}</td>
                <td>{{ t.ext.drug }}</td>
                <td class="nowrap">{{ t.authoredOn.slice(5,10) }}</td>
                <td><status-tag :status="t.status"></status-tag></td>
                <td class="actions">
                  <a class="btn-link" v-if="isMyTurn(t)" @click="open(t)">审批</a>
                  <a class="btn-link" v-else @click="open(t)">详情</a>
                </td>
              </tr>
            </tbody>
          </table>
          <empty-state v-else text="暂无待审批申请"></empty-state>
          </div>
          <div class="card-body" v-if="filtered.length"><ui-pager :total="filtered.length" v-model:page="page" :size="size"></ui-pager></div>
        </div>
      </div>

      <!-- 审批详情弹框 -->
      <ui-modal v-if="showModal && current" :title="'审批详情 - '+current.identifier[0].value" width="wide" @close="showModal=false">
        <div class="divider-label">基本信息</div>
        <div class="kv">
          <span class="k">申请编号</span><span>{{ current.identifier[0].value }}</span>
          <span class="k">申请类型</span><span><level-tag :level="current.ext.type"></level-tag></span>
          <span class="k">申请人</span><span>{{ current.requester.display }} / {{ current.ext.dept }}（{{ D.titleName(current.ext.requesterTitle) }}）</span>
          <span class="k">申请时间</span><span>{{ fmtInstant(current.authoredOn) }}</span>
        </div>
        <div class="divider-label">申请内容</div>
        <div class="kv">
          <span class="k">申请药品</span><span>{{ current.ext.drug }}</span>
          <span class="k">使用时间</span><span>{{ current.ext.useStart }} ~ {{ current.ext.useEnd }}</span>
          <span class="k">申请理由</span><span>{{ current.ext.reason }}</span>
        </div>
        <div class="divider-label">患者信息</div>
        <div class="kv">
          <span class="k">姓名</span><span>{{ current.ext.patientName }}</span>
          <span class="k">年龄</span><span>{{ current.ext.patientAge ? current.ext.patientAge+' 岁' : '—' }}</span>
          <span class="k">性别</span><span>{{ current.ext.patientGender==='male'?'男':(current.ext.patientGender==='female'?'女':'—') }}</span>
          <span class="k">科室</span><span>{{ current.ext.patientDept || '—' }}</span>
          <span class="k">住院号</span><span>{{ current.ext.mrn }}</span>
          <span class="k">诊断</span><span>{{ current.ext.diagnosis }}</span>
          <span class="k">感染情况</span><span>{{ current.ext.infection }}</span>
          <span class="k">附件</span><span>
            <template v-if="current.ext.attachments && current.ext.attachments.length">
              <a class="btn-link" v-for="a in current.ext.attachments" @click="viewAttachment(a)">📄 {{ a.name }}</a>
            </template>
            <template v-else>—</template>
          </span>
        </div>
        <div class="divider-label">适应症校验</div>
        <div class="alert" :class="c.icon==='ok'?'success':'warn'" style="margin-bottom:8px" v-for="c in checks">
          <span>{{ checkIcon(c.icon) }}</span><div>{{ c.text }}</div>
        </div>
        <div class="divider-label">审批流程</div>
        <div class="steps">
          <div class="step" :class="n.status" v-for="(n,i) in current.ext.flow">
            <div class="dot">{{ n.status==='approved'?'✓':(n.status==='rejected'?'✕':i+1) }}</div>
            <div class="bar" v-if="i<current.ext.flow.length-1"></div>
            <div class="s-name">{{ n.roleName }}</div>
            <div class="s-meta">{{ n.approver || (n.status==='current'?'当前节点':'待审核') }}</div>
            <div class="s-meta">{{ n.time ? n.time.slice(5) : '' }}</div>
          </div>
        </div>

        <div class="alert info" v-if="current.status==='in-progress' && !isMyTurn(current)"><span>ℹ️</span><div>该申请正在等待其他角色（{{ current.ext.flow.filter(n=>n.status==='current')[0] ? current.ext.flow.filter(n=>n.status==='current')[0].roleName : '' }}）处理，暂不可由您审批，可先查看详情。</div></div>
        <template v-if="current.status==='in-progress' && isMyTurn(current)">
          <div class="divider-label">审批操作</div>
          <div class="radios">
            <label><input type="radio" value="approved" v-model="decision"> ✅ 通过</label>
            <label><input type="radio" value="rejected" v-model="decision"> ❌ 驳回</label>
          </div>
          <div v-if="decision==='rejected'" style="margin-top:12px">
            <div class="form-row"><label class="req">驳回理由</label>
              <div class="ctrl"><textarea v-model="reason" placeholder="请输入驳回理由..."></textarea>
                <div class="chip-row" style="margin-top:6px"><span class="chip" v-for="t in rejectTemplates" @click="pickTpl(t)" style="font-size:12px">{{ t }}</span></div>
              </div>
            </div>
          </div>
        </template>
        <div class="alert" :class="current.ext.decision.result==='approved'?'success':'danger'" v-else-if="current.ext.decision" style="margin-top:14px">
          <span>{{ current.ext.decision.result==='approved'?'✅':'❌' }}</span>
          <div><b>{{ current.ext.decision.result==='approved'?'已通过':'已驳回' }}</b>（{{ current.ext.decision.by }} · {{ current.ext.decision.time }}）<div v-if="current.ext.decision.reason">理由：{{ current.ext.decision.reason }}</div></div>
        </div>

        <template #foot>
          <button class="btn" @click="showModal=false">{{ current.status==='in-progress'?'取消':'关闭' }}</button>
          <button class="btn primary" v-if="current.status==='in-progress' && isMyTurn(current)" @click="confirm">确认提交</button>
        </template>
      </ui-modal>

      <!-- 批量审批弹框 -->
      <ui-modal v-if="showBatch" :title="(batchDecision==='approved'?'批量通过':'批量驳回')+' - 共 '+selected.length+' 件'" narrow @close="showBatch=false">
        <div class="alert" :class="batchDecision==='approved'?'success':'danger'">
          <span>{{ batchDecision==='approved'?'✅':'❌' }}</span>
          <div>即将对所选 <b>{{ selected.length }}</b> 件待审批申请执行「{{ batchDecision==='approved'?'通过':'驳回' }}」操作{{ batchDecision==='approved'?'，通过后对应医师方可开具该药品。':'。' }}</div>
        </div>
        <div v-if="batchDecision==='rejected'" style="margin-top:14px">
          <div class="form-row"><label class="req">驳回理由</label>
            <div class="ctrl"><textarea v-model="batchReason" placeholder="请输入统一驳回理由..."></textarea>
              <div class="chip-row" style="margin-top:6px"><span class="chip" v-for="t in rejectTemplates" @click="batchReason=t" style="font-size:12px">{{ t }}</span></div>
            </div>
          </div>
        </div>
        <template #foot>
          <button class="btn" @click="showBatch=false">取消</button>
          <button class="btn primary" @click="confirmBatch">确认{{ batchDecision==='approved'?'通过':'驳回' }}</button>
        </template>
      </ui-modal>
    </div>`,
    created: function () { this.D = D; }
  };
})(window);
