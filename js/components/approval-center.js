/* =====================================================================
 * approval-center.js —— 审批中心（统一审批工作台）
 * SRS FR-016 审核中心展示新增流程节点、FR-020 审批任务列表、
 * FR-021 审批任务详情、FR-022 审批操作与状态流转、FR-023 消息与提醒
 * ===================================================================== */
(function (global) {
  'use strict';
  var AMS = global.AMS, Svc = global.Svc, D = global.Domain, App = global.App;
  var Ap = global.Approval, F = global.FHIR;

  AMS.pages['approval-center'] = {
    data: function () {
      return {
        scope: 'todo',
        filter: { drug: '', level: 'all', patient: '', requester: '', dept: 'all', status: 'all', version: 'all', dateStart: '', dateEnd: '' },
        page: 1, size: 10,
        detailId: '',
        comment: '',
        rejectReason: '',
        mode: 'table',
        withdrawReason: ''
      };
    },
    computed: {
      D: function () { return D; },
      user: function () { return App.currentUser(); },
      role: function () { return App.state.roleCode; },
      canView: function () { return D.canAccess(this.role, 'approval-center'); },
      scopes: function () { return Svc.srs.centerScopes(); },
      counters: function () { App.state.refresh; return Ap.countersFor(this.user.practitioner); },
      rows: function () {
        App.state.refresh;
        return Svc.srs.centerRows(this.user.practitioner, this.scope, this.filter);
      },
      paged: function () { var s = (this.page - 1) * this.size; return this.rows.slice(s, s + this.size); },
      versions: function () {
        App.state.refresh;
        var set = {}, out = [{ code: 'all', name: '全部版本' }];
        Ap.allVersions().forEach(function (p) {
          var k = p.ext.purposeKey;
          if (!set[k]) { set[k] = true; out.push({ code: p.version, name: (p.ext.title || k) + ' V' + p.version }); }
        });
        return out;
      },
      detail: function () { App.state.refresh; return this.detailId ? Svc.srs.centerDetail(this.detailId) : null; },
      /* 特殊使用级待审批的醒目提醒（FR-009.6） */
      specialWaiting: function () {
        App.state.refresh;
        return Svc.srs.centerRows(this.user.practitioner, 'todo').filter(function (r) { return r.level === 'special'; });
      },
      messages: function () { App.state.refresh; return Svc.srs.messages(this.user).slice(0, 12); },
      levels: function () { return [{ code: 'all', name: '全部等级' }].concat(D.LEVELS); },
      statuses: function () { return [{ code: 'all', name: '全部状态' }].concat(D.FLOW_STATUS); },
      /* FR-020.2 的「申请科室」按组织科室（含演示科室）取值 */
      deptOptions: function () {
        App.state.refresh;
        return F.search('Organization', function (o) { return o.ext && o.ext.orgKind === 'department'; })
          .map(function (o) { return o.name; }).sort(function (a, b) { return a.localeCompare(b, 'zh'); });
      },
    },
    methods: {
      setScope: function (s) { this.scope = s; this.page = 1; },
      openDetail: function (id) { this.detailId = id; this.comment = ''; this.rejectReason = ''; this.mode = 'detail'; },
      backToList: function () { this.mode = 'table'; this.detailId = ''; },
      refresh: function () { App.refreshFromServer(); },
      act: function (action) {
        var d = this.detail;
        if (!d || !d.actions.node) { App.toast('当前没有轮到您处理的节点', 'error'); return; }
        var comment = action === 'approve' ? (this.comment || '同意') : this.comment;
        if (action === 'reject' && !comment) { App.toast('驳回必须填写原因（FR-022.2）', 'error'); return; }
        try {
          var r = Svc.srs.act({ nodeTaskId: d.actions.node.id, action: action,
            operatorPractId: this.user.practitioner, comment: comment });
          App.toast('已' + Ap.actionName(action) + '，实例状态：' + D.flowStatusName(r.flowStatus));
          this.comment = '';
          if (!r.next) this.backToList();
          App.bump();
        } catch (e) { App.toast(e.message, 'error'); }
      },
      withdraw: function () {
        var d = this.detail;
        if (!confirm('确认撤回该申请？撤回后原审批记录仍保留。')) return;
        Svc.srs.withdraw(d.mainId, this.withdrawReason);
        App.toast('申请已撤回'); this.backToList();
      },
      resubmitMaterials: function () {
        var d = this.detail;
        var note = this.comment || '已补充病原学与用药评估材料';
        try {
          Svc.srs.resubmitMaterials(d.mainId, note);
          App.toast('已补充材料并重新提交至原节点');
          this.comment = '';
          App.bump();
        } catch (e) { App.toast(e.message, 'error'); }
      },
      revise: function () {
        var d = this.detail;
        var inst = Svc.srs.reviseAndResubmit(d.mainId, { applicationReason: (d.request.reason || '') + '（修改后重提）' });
        App.toast('已按原申请修改重提，新申请编号 ' + inst.ext.sqno + '；原审批记录保留');
        this.openDetail(inst.id);
      },
      nodeClass: function (n) {
        return { passed: 'approved', rejected: 'rejected', doing: 'current',
          returned: 'current', cancelled: '', unreached: '' }[n.state] || '';
      },
      nodeMark: function (n, i) {
        if (n.state === 'passed') return '✓';
        if (n.state === 'rejected') return '✕';
        if (n.state === 'returned') return '↺';
        if (n.state === 'doing') return '●';
        return String(i + 1);
      },
      goMobile: function () { App.navigate('mobile-approval'); },
      jumpMessage: function (comm) {
        Svc.srs.markRead(comm.id);
        var j = Svc.srs.jump(comm);
        if (j.task && Svc.srs.centerDetail(j.task)) { this.mode = 'table'; App.navigate(j.route); this.openDetail(j.task); App.state.route = j.route; }
        else App.navigate(j.route || 'approval-center');
      },
      markAllRead: function () { Svc.srs.markAllRead(this.user); App.toast('已全部标为已读'); }
    },
    template: `
    <div v-if="!canView" class="card"><div class="card-body">
      <empty-state icon="🔒" text="本页面不对当前角色开放。请使用顶部演示身份切换为「审批人员」或「开单医师」。"></empty-state>
    </div></div>

    <div v-else>
      <!-- ============== 详情视图 ============== -->
      <template v-if="mode==='detail' && detail">
        <div class="flex-between mb12">
          <h2 style="margin:0;font-size:18px">📋 审批任务详情 · {{ detail.sqno }}</h2>
          <div>
            <button class="btn" @click="backToList">← 返回列表</button>
            <button class="btn ghost" @click="goMobile">📱 移动端视图</button>
          </div>
        </div>

        <div class="row">
          <div class="col card" style="min-width:430px;flex:2">
            <div class="card-head"><h3>① 申请与患者信息（FR-021）</h3>
              <span class="tag" :class="detail.tone">{{ detail.flowStatusName }}</span></div>
            <div class="card-body">
              <div class="kv">
                <span class="k">患者 / 就诊</span><span>{{ detail.request.patient }}（{{ detail.request.mrn }}）·
                  <template v-if="detail.request.encounter">{{ detail.request.encounter }}</template></span>
                <span class="k">诊断</span><span>{{ detail.request.diagnosis || '—' }}</span>
                <span class="k">开单医师</span><span>{{ detail.request.requester }} · {{ detail.request.requesterTitle }} · {{ detail.request.dept }}</span>
                <span class="k">抗菌药物</span><span>{{ detail.request.drug }}（{{ detail.request.drugCode }}）
                  <level-tag :level="detail.request.level"></level-tag></span>
                <span class="k">等级快照</span><span>{{ detail.request.gradeSnapshot.name }} 于 {{ detail.request.gradeSnapshot.at }}
                  <span class="muted">（来源 {{ detail.request.gradeSnapshot.source }}；后续等级调整不影响本单）</span></span>
                <span class="k">用药目的</span><span><b>{{ detail.request.purpose ? detail.request.purpose.name : '—' }}</b>
                  <template v-if="detail.request.purpose && detail.request.purpose.note">：{{ detail.request.purpose.note }}</template></span>
                <span class="k">用法用量</span><span>{{ detail.request.dosage.text || '—' }}</span>
                <span class="k">申请原因</span><span>{{ detail.request.reason || '—' }}</span>
                <span class="k">权限校验结果</span><span>{{ detail.request.authzHit ? (detail.request.authzHit.srcLabel + ' — ' + detail.request.authzHit.reason) : '—' }}</span>
                <span class="k">触发原因</span><span>{{ detail.request.authzHit ? detail.request.authzHit.ruleText : '—' }}</span>
                <span class="k">医嘱业务状态</span><span class="tag blue">{{ detail.request.orderStatusName }}</span>
                <span class="k">开单时间</span><span>{{ detail.request.authoredAt }}</span>
                <span class="k">紧急越级</span>
                <span v-if="detail.emergency"><span class="tag red">是</span> {{ detail.request.emergencyReason }}
                  <div class="muted" v-if="detail.timeout.deadline">补审核截止 {{ detail.timeout.deadline.replace('T',' ') }}（{{ detail.timeout.text }}）</div></span>
                <span v-else class="muted">否</span>
              </div>

              <div class="divider-label">② 审批流程图（FR-016.3/4/5）</div>
              <div class="steps">
                <div class="step" v-for="(n,i) in detail.nodes" :key="n.seq" :class="nodeClass(n)">
                  <div class="dot">{{ nodeMark(n,i) }}</div><div class="bar" v-if="i<detail.nodes.length-1"></div>
                  <div class="s-name">{{ n.name }}</div>
                  <div class="s-meta">{{ n.stateName }}</div>
                  <div class="s-meta" v-if="n.actedBy">{{ n.actedBy }} · {{ (n.actedAt||'').slice(5) }}</div>
                </div>
              </div>
              <div class="table-wrap"><table class="tbl">
                <thead><tr><th>顺序</th><th>节点</th><th>审批对象与分配依据</th><th>方式</th><th>时限</th><th>状态</th><th>审批人 / 时间 / 意见</th></tr></thead>
                <tbody>
                  <tr v-for="n in detail.nodes" :key="n.seq">
                    <td>{{ n.seq }}</td>
                    <td>{{ n.name }}<span class="tag red" v-if="n.isPostReview">补审核</span></td>
                    <td>{{ n.assigneeLabel }}
                      <div class="muted" v-if="n.basis.length" style="font-size:11px">{{ n.basis[0] }}</div>
                      <div class="muted" v-if="n.assignees.length" style="font-size:11px">待办人：{{ n.assignees.map(function(a){return a.name;}).join('、') }}</div></td>
                    <td>{{ n.modeName }}</td>
                    <td class="nowrap">{{ n.deadlineHours }}h<div class="muted" v-if="n.remaining">{{ n.remaining }}</div></td>
                    <td><span class="tag" :class="n.state==='passed'?'green':(n.state==='rejected'?'red':(n.state==='doing'?'orange':'gray'))">{{ n.stateName }}</span></td>
                    <td><template v-if="n.actedBy">{{ n.actedBy }} · {{ n.actedAt }}<div class="muted">{{ n.comment }}</div></template>
                      <span v-else class="muted">—</span></td>
                  </tr>
                </tbody>
              </table></div>
              <div class="alert info" style="display:block">
                <div>本实例绑定的流程版本：<b>{{ detail.pdTitle }} {{ detail.versionLabel }}</b>（canonical {{ detail.pdUrl }}|{{ detail.version }}）
                <span class="tag green" v-if="detail.boundVersionStillActive">该版本仍是当前发布版</span>
                <span class="tag gray" v-else>该版本已被新版本替代，但本实例仍按绑定版本执行（BR-006）</span></div>
              </div>
            </div>
          </div>

          <!-- 审批操作区 -->
          <div class="col card" style="min-width:320px">
            <div class="card-head"><h3>③ 审批操作</h3></div>
            <div class="card-body">
              <template v-if="detail.actions.canAct">
                <div class="alert info" style="display:block">
                  <div>当前节点：<b>{{ detail.actions.node.name }}</b>（第 {{ detail.actions.node.seq }} 步）
                    <div class="muted" v-if="detail.actions.node.deadlineEnd">办理截止 {{ detail.actions.node.deadlineEnd.replace('T',' ') }}</div></div>
                </div>
                <div class="form-row" v-if="detail.actions.node.actions.indexOf('approve')>=0">
                  <label>审批意见</label>
                  <div class="ctrl"><textarea v-model="comment" placeholder="通过时可不填，默认「同意」"></textarea></div>
                </div>
                <div class="form-row" v-if="detail.actions.node.actions.indexOf('reject')>=0">
                  <label class="req">驳回原因</label>
                  <div class="ctrl"><textarea v-model="comment" placeholder="驳回必须填写原因"></textarea></div>
                </div>
                <div class="btn-row" style="flex-direction:column;align-items:stretch;gap:8px">
                  <button class="btn primary" v-if="detail.actions.node.actions.indexOf('approve')>=0" @click="act('approve')">✓ 审批通过</button>
                  <button class="btn danger" v-if="detail.actions.node.actions.indexOf('reject')>=0" @click="act('reject')">✕ 驳回</button>
                  <button class="btn" v-if="detail.actions.node.actions.indexOf('return')>=0" @click="act('return')">↺ 退回补充</button>
                </div>
                <div class="muted" style="margin-top:8px;font-size:12px">
                  界面只展示本节点配置允许的操作（FR-022.3）：
                  {{ detail.actions.node.actions.map(function(c){return (D.NODE_ACTIONS.filter(function(a){return a.code===c;})[0]||{}).name||c;}).join('、') }}
                </div>
              </template>
              <div v-else class="alert warn" style="display:block"><div>当前没有轮到您处理的节点。可用顶部身份切换条换成
                「审批人员·陈慧兰（科室）」「审批人员·张玉梅（药学）」「审批人员·陈志远（角色）」等身份查看待办。</div></div>

              <div class="divider-label" v-if="detail.actions.canWithdraw || detail.actions.canResubmit || detail.actions.canRevise">申请人操作</div>
              <div class="form-row" v-if="detail.actions.canWithdraw">
                <label>撤回原因</label><div class="ctrl"><input type="text" v-model="withdrawReason"></div></div>
              <div class="btn-row" style="flex-direction:column;align-items:stretch;gap:8px">
                <button class="btn danger" v-if="detail.actions.canWithdraw" @click="withdraw">撤回申请</button>
                <button class="btn primary" v-if="detail.actions.canResubmit" @click="resubmitMaterials">补充材料并重新提交</button>
                <button class="btn" v-if="detail.actions.canRevise" @click="revise">修改后重新提交（保留原记录）</button>
              </div>

              <div class="divider-label">本人与审批有关的消息（FR-023）</div>
              <div style="max-height:260px;overflow:auto">
                <div v-for="m in messages" style="padding:9px 0;border-bottom:1px solid #eef1f5;font-size:13px">
                  <div class="flex-between"><span class="tag blue">{{ m.ext.type }}</span>
                    <span v-if="m.ext.unread" class="tag red">未读</span></div>
                  <div style="margin-top:4px"><a class="btn-link" @click="jumpMessage(m)">{{ m.ext.content }}</a></div>
                  <div class="muted" style="font-size:11px">{{ m.ext.time }}</div>
                </div>
                <empty-state v-if="!messages.length" text="暂无消息"></empty-state>
              </div>
              <div class="btn-row" style="justify-content:flex-end;margin-top:8px">
                <button class="btn ghost" @click="markAllRead">全部已读</button>
              </div>
            </div>
          </div>
        </div>
      </template>

      <!-- ============== 列表视图 ============== -->
      <div v-else>
        <div class="stat-grid cols-4" style="margin-bottom:12px">
          <div class="stat-card"><div class="label">待我审批</div><div class="value">{{ counters.todo }}<small>件</small></div></div>
          <div class="stat-card"><div class="label">特殊使用级待办</div><div class="value">{{ counters.special }}<small>件</small></div>
            <div class="delta up" v-if="counters.special">需及时处理</div></div>
          <div class="stat-card"><div class="label">超时 / 紧急待补审核</div><div class="value">{{ counters.timeout }}<small>件</small> / {{ counters.emergency }}<small>件</small></div>
            <div class="delta up" v-if="counters.timeout">已超时</div></div>
          <div class="stat-card"><div class="label">我发起的进行中</div><div class="value">{{ counters.mine }}<small>件</small></div></div>
        </div>

        <div class="alert danger" v-if="specialWaiting.length" style="display:block">
          <div>🔴 <b>特殊使用级药物待审批提醒（FR-009.6）</b>：
            {{ specialWaiting.map(function(r){ return r.patient+' · '+r.drug+'（'+r.currentNode+'）'; }).join('；') }}</div>
        </div>

        <div class="card">
          <div class="card-body">
            <div class="filter-bar">
              <button class="btn" v-for="s in scopes" :key="s.code" :class="{primary: scope===s.code}" @click="setScope(s.code)">{{ s.name }}</button>
              <div style="flex:1"></div>
              <button class="btn" @click="refresh">🔄 刷新服务端</button>
            </div>
            <div class="filter-bar" style="margin-top:10px">
              <div class="field"><label>患者</label><input type="text" v-model="filter.patient" placeholder="姓名/住院号"></div>
              <div class="field"><label>药品</label><input type="text" v-model="filter.drug" placeholder="药品名称"></div>
              <div class="field"><label>等级</label>
                <select v-model="filter.level"><option v-for="l in levels" :value="l.code">{{ l.name }}</option></select></div>
              <div class="field"><label>开单医师</label><input type="text" v-model="filter.requester" placeholder="医师姓名"></div>
              <div class="field"><label>申请科室</label>
                <select v-model="filter.dept"><option value="all">全部科室</option>
                  <option v-for="dp in deptOptions" :value="dp">{{ dp }}</option></select></div>
              <div class="field"><label>任务状态</label>
                <select v-model="filter.status"><option v-for="st in statuses" :value="st.code">{{ st.name }}</option></select></div>
              <div class="field"><label>流程版本</label>
                <select v-model="filter.version"><option v-for="v in versions" :value="v.code">{{ v.name }}</option></select></div>
              <div class="field"><label>开始日期</label><input type="date" v-model="filter.dateStart"></div>
              <div class="field"><label>结束日期</label><input type="date" v-model="filter.dateEnd"></div>
              <button class="btn" @click="page=1">查询</button>
              <button class="btn ghost" @click="filter={drug:'',level:'all',patient:'',requester:'',dept:'all',status:'all',version:'all',dateStart:'',dateEnd:''};page=1">重置</button>
            </div>
          </div>
        </div>

        <div class="card mt16">
          <div class="card-head"><h3>🗂️ 审批任务列表</h3><span class="muted">共 {{ rows.length }} 条 · 当前身份 {{ user.display }}</span></div>
          <div class="card-body" style="padding:0">
            <div class="table-wrap">
              <table class="tbl" v-if="paged.length">
                <thead><tr>
                  <th>申请编号</th><th>患者</th><th>开单医师 / 科室</th><th>药品 / 等级</th><th>用药目的</th>
                  <th>申请时间</th><th>当前审批节点</th><th>等待</th><th>流程状态</th><th>版本</th><th>操作</th>
                </tr></thead>
                <tbody>
                  <tr v-for="r in paged" :key="r.id">
                    <td class="nowrap">{{ r.sqno }}</td>
                    <td>{{ r.patient }}<div class="muted" style="font-size:11px">{{ r.mrn }}</div></td>
                    <td>{{ r.requester }}<div class="muted" style="font-size:11px">{{ r.dept }}</div></td>
                    <td>{{ r.drug }} <level-tag :level="r.level"></level-tag></td>
                    <td class="muted">{{ r.purposeName }}</td>
                    <td class="nowrap">{{ r.createdAt }}</td>
                    <td>{{ r.currentNode }}
                      <div class="muted" style="font-size:11px" v-if="r.currentAssignees.length">待 {{ r.currentAssignees.join('、') }}</div></td>
                    <td class="nowrap">{{ r.waitingHours }}h</td>
                    <td><span class="tag" :class="r.tone">{{ r.flowStatusName }}</span>
                      <div v-if="r.timeout.kind==='near'" class="tag orange">{{ r.timeout.text }}</div>
                      <div v-if="r.timeout.timeout" class="tag red">{{ r.timeout.text }}</div></td>
                    <td>{{ r.version }}</td>
                    <td class="actions">
                      <a class="btn-link" @click="openDetail(r.id)">{{ r.actionable ? '审批' : '详情' }}</a>
                    </td>
                  </tr>
                </tbody>
              </table>
              <empty-state v-else text="没有符合条件的审批任务。可切换身份（如「审批人员·张玉梅（药学）」）或换个列表分类看看。"></empty-state>
            </div>
            <div class="card-body" v-if="rows.length > size"><ui-pager :total="rows.length" v-model:page="page" :size="size"></ui-pager></div>
          </div>
        </div>

        <div class="alert info" style="display:block">
          <div>说明：本演示的跨身份数据同步通过<b>重新查询 FHIR 服务端</b>实现（SRS FR-009.8），不提供医院短信或统一消息服务；
            任务分配依据（人员/科室/角色）与每个节点的处理人、时间、意见均来自 FHIR <b>Task</b> 资源，可在顶部「🔍 FHIR 资源」中查看原文。</div>
        </div>
      </div>
    </div>`
  };
})(window);
