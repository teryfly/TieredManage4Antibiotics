/* =====================================================================
 * mobile-approval.js —— L3-5-2 移动端审批（SRS FR-017，§6.7，DEMO-11）
 * ---------------------------------------------------------------------
 * 采购要求「支持 APP 移动端审核操作」。本实现按 FR-017.8 采用
 * 同一前端程序的响应式路由：不另建独立系统，待办、详情与审批动作
 * 全部读写与桌面端同一条 FHIR Task（主任务 + 节点任务），
 * 因此桌面端「审批中心」刷新后即可看到移动端提交的结果（DEMO-11.6）。
 * ===================================================================== */
(function (global) {
  'use strict';
  var AMS = global.AMS, Svc = global.Svc, D = global.Domain, App = global.App;
  var Ap = global.Approval;

  var MARKS = ['①', '②', '③', '④', '⑤', '⑥', '⑦', '⑧', '⑨', '⑩'];

  function fmtInstant(s) { return (s || '').replace('T', ' ').slice(0, 16); }

  AMS.pages['mobile-approval'] = {
    data: function () {
      return {
        mode: 'list',        // list 待办卡片 | detail 申请详情（同页切换，不用弹框）
        mainId: '',
        comment: '',
        errComment: false,
        lastAct: null
      };
    },
    computed: {
      D: function () { return D; },
      Ap: function () { return Ap; },
      user: function () { return App.currentUser(); },
      role: function () { return App.state.roleCode; },
      canView: function () { return D.canAccess(this.role, 'mobile-approval'); },
      pract: function () { return this.user.practitioner; },

      counters: function () { App.state.refresh; return Ap.countersFor(this.pract); },
      /* FR-017.2 当前用户待审批任务 */
      todos: function () { App.state.refresh; return Ap.rows(this.pract, 'todo'); },

      /* FR-017.3 任务详情（与桌面端审批中心同一份视图模型） */
      detail: function () {
        App.state.refresh;
        return this.mainId ? Svc.srs.centerDetail(this.mainId) : null;
      },
      req: function () { return this.detail && this.detail.request ? this.detail.request : null; },
      nodes: function () {
        App.state.refresh;
        if (!this.mainId) return [];
        var v = this.detail;
        return v ? (v.nodes || []) : [];
      },
      /* 当前轮到本人处理的节点（未配置的动作不显示按钮，FR-022.3） */
      actionNode: function () {
        var v = this.detail;
        return (v && v.actions) ? v.actions.node : null;
      },
      actionButtons: function () {
        var n = this.actionNode;
        if (!n) return [];
        return (n.actions || []).map(function (code) {
          var hit = D.NODE_ACTIONS.filter(function (a) { return a.code === code; })[0];
          return { code: code, name: hit ? hit.name : code, danger: code === 'reject' };
        });
      },
      currentNode: function () {
        var doing = this.nodes.filter(function (n) { return n.state === 'doing' || n.state === 'returned'; });
        return doing[0] || null;
      }
    },
    methods: {
      /* ---------------- 视图切换 ---------------- */
      openTask: function (r) {
        this.mainId = r.id; this.comment = ''; this.errComment = false; this.mode = 'detail';
      },
      backList: function () { this.mode = 'list'; this.mainId = ''; this.comment = ''; this.errComment = false; },
      /* FR-009.8：跨身份的数据更新通过重新查询 FHIR 服务端实现（不做推送承诺） */
      refresh: function () { App.refreshFromServer(); },
      desktop: function () { App.navigate('approval-center'); },

      /* ---------------- 展示辅助 ---------------- */
      mark: function (seq) { return MARKS[(Number(seq) || 1) - 1] || ('(' + seq + ')'); },
      fmt: function (s) { return fmtInstant(s) || '—'; },
      levelName: function (code) { return D.levelName(code); },
      typeName: function (t) { return D.assigneeTypeName(t); },
      actionNameOf: function (code) {
        var hit = D.NODE_ACTIONS.filter(function (a) { return a.code === code; })[0];
        return hit ? hit.name : code;
      },
      cardStyle: function (r) {
        return r.level === 'special'
          ? { borderLeft: '4px solid #d92d20', background: '#fffafa' }
          : { borderLeft: '4px solid var(--primary)' };
      },
      stateClass: function (n) {
        return n.state === 'passed' ? 'approved'
          : (n.state === 'doing' || n.state === 'returned') ? 'current'
            : (n.state === 'rejected' || n.state === 'cancelled') ? 'rejected' : '';
      },
      purposeText: function (p) {
        if (!p) return '（开单时未选择用药目的）';
        return p.name + (p.note ? '；补充说明：' + p.note : '');
      },
      authzText: function (hit) {
        if (!hit) return '—';
        return (hit.srcLabel || '') + (hit.ruleText ? '：' + hit.ruleText : '');
      },

      /* ---------------- FR-017.4 / .5 审批操作 ---------------- */
      act: function (action) {
        var node = this.actionNode;
        if (!node) {
          App.toast('当前节点不由本人处理，移动端不显示操作按钮', 'error');
          return;
        }
        var text = (this.comment || '').trim();
        if (action === 'reject' && !text) {
          this.errComment = true;
          App.toast('驳回必须填写原因（SRS FR-017.5）', 'error');
          return;
        }
        this.errComment = false;
        var cm = text || (action === 'approve' ? '同意' : '');
        try {
          var r = Svc.srs.act({
            nodeTaskId: node.id, action: action,
            operatorPractId: this.pract, comment: cm
          });
          var m = r.mainTask || {};
          var ext = m.ext || {};
          this.lastAct = {
            sqno: ext.sqno || '', drug: ext.drug || '', actionName: this.actionNameOf(action),
            nodeName: node.name, comment: cm,
            flowStatusName: D.flowStatusName(r.flowStatus),
            nextText: r.next
              ? '已流转至「' + r.next.name + '」，待办人：'
                + ((r.next.assignees || []).map(function (a) { return a.name; }).join('、') || '—')
              : (action === 'approve'
                ? '全部审核节点已通过；医嘱状态「可提交临床系统」仅代表本演示流程已满足审批条件，不代表已发药或实际执行'
                : '流程已结束（后续节点未执行）')
          };
          this.mode = 'list'; this.mainId = ''; this.comment = '';
          App.toast('已提交' + this.lastAct.actionName + '，流程状态：' + this.lastAct.flowStatusName);
        } catch (e) {
          App.toast('提交失败：' + e.message, 'error');
        }
      },
      clearLast: function () { this.lastAct = null; }
    },
    template: `
    <div v-if="!canView" class="card"><div class="card-body">
      <empty-state icon="🔒" text="本页面仅对「审批人员 / 药学部门 / 医师 / 系统管理员 / 规则管理员」角色开放。请使用顶部演示身份切换。"></empty-state>
    </div></div>

    <!-- 手机外框：外层沿用桌面端 card，内层 414px 容器模拟移动屏（FR-017.1） -->
    <div v-else class="card">
      <div class="card-head">
        <h3>📱 移动端审批</h3>
        <button class="btn sm ghost" @click="desktop">回到桌面端审批中心 ›</button>
      </div>
      <div class="card-body">
        <div class="alert info" style="display:block;margin-bottom:12px">
          <div>移动端与桌面端共用同一条 FHIR Task 数据；本页是同一前端程序的响应式路由（SRS FR-017.8）。</div>
        </div>

        <div style="max-width:414px;margin:0 auto;border:10px solid #24344d;border-radius:26px;background:#eef2f7;padding:10px">
          <!-- ① 移动端顶栏：身份 + 待办徽标 + 刷新 -->
          <div class="card" style="border-radius:12px">
            <div class="card-body" style="padding:10px 12px">
              <div class="flex-between">
                <div>
                  <b>{{ user.display }}</b>
                  <div class="muted" style="font-size:12px">{{ user.dept }} · {{ D.roleName(user.role) }}</div>
                </div>
                <div style="text-align:right">
                  <span class="tag red" style="font-size:13px">待办 {{ counters.todo }}</span>
                  <div class="muted" style="font-size:11px">特殊使用级 {{ counters.special }} · 超时 {{ counters.timeout }}</div>
                </div>
              </div>
              <div class="btn-row mt8">
                <button class="btn sm" @click="refresh()">🔄 刷新</button>
                <span class="muted" style="font-size:11px">待办在进入本页或点「刷新」时重新查询 FHIR 服务端获得（SRS FR-009.8），系统不承诺短信/消息推送。</span>
              </div>
            </div>
          </div>

          <!-- ② 提交结果回显 -->
          <div v-if="lastAct" class="card mt8" style="border-radius:12px">
            <div class="card-body" style="padding:10px 12px">
              <div class="alert success" style="display:block">
                <div><b>✅ {{ lastAct.actionName }}已提交</b>
                  <div class="kv mt8">
                    <span class="k">申请编号</span><span>{{ lastAct.sqno }}</span>
                    <span class="k">药品</span><span>{{ lastAct.drug }}</span>
                    <span class="k">处理节点</span><span>{{ lastAct.nodeName }}</span>
                    <span class="k">审批意见</span><span>{{ lastAct.comment || '—' }}</span>
                    <span class="k">最新流程状态</span><span><b>{{ lastAct.flowStatusName }}</b></span>
                    <span class="k">下一步</span><span>{{ lastAct.nextText }}</span>
                  </div>
                </div>
              </div>
              <div class="btn-row mt8">
                <button class="btn primary sm" @click="desktop">回到桌面端查看</button>
                <button class="btn sm ghost" @click="clearLast">收起</button>
              </div>
              <div class="muted mt8" style="font-size:11px">桌面端「审批中心」点顶部刷新后即可看到本次审批结果（DEMO-11 第 6 步）：双方访问的是同一条 FHIR Task。</div>
            </div>
          </div>

          <!-- ③ 待办卡片列表（FR-017.2 / .3 摘要字段） -->
          <div v-if="mode === 'list'">
            <div class="divider-label" style="margin:12px 0 8px">待我审批（{{ todos.length }}）</div>
            <div v-for="r in todos" :key="r.id" class="card mb8" style="border-radius:12px"
                 :style="cardStyle(r)" @click="openTask(r)" role="button">
              <div class="card-body" style="padding:10px 12px">
                <div class="flex-between">
                  <b>{{ r.patient }}</b>
                  <span class="tag" :class="r.tone">{{ r.flowStatusName }}</span>
                </div>
                <div class="muted" style="font-size:11px">住院号 {{ r.mrn }} · {{ r.dept }}</div>
                <div class="mt8">
                  <b>{{ r.drug }}</b> <level-tag :level="r.level"></level-tag>
                  <span v-if="r.level === 'special'" class="tag red">特殊使用级 · 需及时处理</span>
                </div>
                <div class="kv" style="grid-template-columns:max-content 1fr;gap:2px 8px;font-size:12px;margin-top:6px">
                  <span class="k">开单医师</span><span>{{ r.requester }}</span>
                  <span class="k">申请时间</span><span>{{ fmt(r.createdAt) }}</span>
                  <span class="k">当前节点</span><span>{{ r.currentNode }}</span>
                  <span class="k">等待时长</span><span>{{ r.waitingHours }} 小时</span>
                  <span class="k">编号</span><span>{{ r.sqno }} · {{ r.version }}</span>
                </div>
                <div v-if="r.purpose === 'emergency-review' || r.emergency" class="mt8" style="font-size:12px">
                  <span class="tag orange">紧急越级补审核</span>
                  <span v-if="r.timeout && r.timeout.deadline" class="nowrap">截止 {{ fmt(r.timeout.deadline) }}</span>
                  <span v-if="r.timeout && r.timeout.timeout" class="tag red">已超时</span>
                  <span v-else-if="r.timeout && r.timeout.text" class="muted">{{ r.timeout.text }}</span>
                </div>
                <div class="muted mt8" style="font-size:11px">点击查看申请详情与审批意见 ›</div>
              </div>
            </div>

            <div v-if="!todos.length" class="card" style="border-radius:12px">
              <div class="card-body" style="padding:10px 12px">
                <empty-state icon="📭" text="当前身份没有待审批任务。"></empty-state>
                <div class="muted" style="font-size:12px;text-align:center">
                  可用顶部身份切换条换成「审批人员·张玉梅（药学）」、「审批人员·陈慧兰（科室）」、
                  「审批人员·陈志远（角色）」等承担审批职责的身份，再点「🔄 刷新」体验移动端审批（DEMO-11）。
                </div>
              </div>
            </div>
          </div>

          <!-- ④ 申请详情（同页切换，FR-017.3 全字段） -->
          <div v-else>
            <div v-if="!detail" class="card mt8" style="border-radius:12px"><div class="card-body">
              <empty-state icon="⚠️" text="该申请实例已无法读取，请返回列表或刷新后重试。"></empty-state>
              <div class="btn-row" style="justify-content:center"><button class="btn sm" @click="backList">‹ 返回待办</button></div>
            </div></div>

            <div v-else>
              <div class="btn-row mt8">
                <button class="btn sm" @click="backList">‹ 返回待办</button>
                <span class="muted" style="font-size:11px">{{ detail.sqno }}</span>
              </div>

              <div class="card mt8" style="border-radius:12px">
                <div class="card-body" style="padding:10px 12px">
                  <div class="flex-between"><b>患者与就诊摘要</b><span class="tag" :class="detail.tone">{{ detail.flowStatusName }}</span></div>
                  <div class="kv" style="gap:2px 8px;font-size:12px;margin-top:6px">
                    <span class="k">患者</span><span>{{ req.patient }}（住院号 {{ req.mrn }}）</span>
                    <span class="k">就诊</span><span>{{ req.encounter || '—' }} · 诊断 {{ req.diagnosis || '—' }}</span>
                    <span class="k">抗菌药物</span><span>{{ req.drug }} <level-tag :level="req.level"></level-tag></span>
                    <span class="k">等级判定来源</span><span>{{ req.gradeSnapshot ? (req.gradeSnapshot.name + ' · ' + req.gradeSnapshot.at) : '—' }}</span>
                    <span class="k">开单医师</span><span>{{ req.requester }} · {{ req.requesterTitle || '职称未填' }} · {{ req.dept }}</span>
                    <span class="k">用药目的</span><span>{{ purposeText(req.purpose) }}</span>
                    <span class="k">用药方案</span><span>{{ (req.dosage && req.dosage.text) || '—' }}
                      <span v-if="req.dosage && req.dosage.frequency"> · {{ req.dosage.frequency }}</span>
                      <span v-if="req.dosage && req.dosage.days"> · {{ req.dosage.days }} 天</span></span>
                    <span class="k">申请原因</span><span>{{ req.reason || '—' }}</span>
                    <span class="k">权限判定</span><span>{{ authzText(req.authzHit) }}</span>
                    <span class="k">申请时间</span><span>{{ fmt(req.authoredAt) }}</span>
                    <span class="k">流程版本 / 用途</span><span><b>{{ detail.versionLabel }}</b> · {{ detail.purposeName }}</span>
                    <span class="k">当前节点</span><span>{{ currentNode ? (mark(currentNode.seq) + ' ' + currentNode.name) : (detail.currentSeq ? ('第 ' + detail.currentSeq + ' 节点') : '—') }}</span>
                    <span class="k">关联 FHIR 资源</span><span class="muted" style="font-size:11px">Task/{{ detail.mainId }} · MedicationRequest/{{ req.mrId || '—' }}</span>
                  </div>
                </div>
              </div>

              <!-- 流程节点（含新发布流程新增的节点，SRS FR-016.4） -->
              <div class="card mt8" style="border-radius:12px">
                <div class="card-body" style="padding:10px 12px">
                  <b>流程节点（{{ nodes.length }} 个，绑定 {{ detail.pdId }}）</b>
                  <div v-for="n in nodes" :key="n.nodeTaskId" class="mt8"
                       style="border:1px solid var(--border);border-radius:10px;padding:8px 10px;background:#fff">
                    <div class="flex-between">
                      <span>{{ mark(n.seq) }} <b>{{ n.name }}</b></span>
                      <span class="tag" :class="n.state==='passed' ? 'green' : (n.state==='rejected' || n.state==='cancelled' ? 'red' : (n.state==='doing' ? 'orange' : 'gray'))">{{ n.stateName }}</span>
                    </div>
                    <div class="muted" style="font-size:11px">
                      {{ typeName(n.assigneeType) }} · {{ n.assigneeLabel }} · {{ n.modeName }} · 时限 {{ n.deadlineHours || 24 }} 小时
                      <span v-if="n.isPostReview"> · 补审核节点</span>
                    </div>
                    <div v-if="n.actedBy" style="font-size:12px;margin-top:4px">
                      历史审批意见：<b>{{ n.actedBy }}</b> 于 {{ n.actedAt }} {{ n.actionKind ? '（' + n.actionKind + '）' : '' }} —— {{ n.comment || '（未填写意见）' }}
                    </div>
                    <div v-else-if="n.state === 'doing'" style="font-size:12px" class="muted">
                      待办人：{{ (n.assignees || []).map(function (a) { return a.name; }).join('、') || '—' }}
                      <span v-if="n.remaining"> · {{ n.remaining }}</span>
                    </div>
                  </div>
                  <div class="muted mt8" style="font-size:11px">
                    节点清单取自该实例绑定的 {{ detail.versionLabel }} 流程定义，新发布流程中新增的审核节点会在实例创建后完整出现在这里（SRS FR-016.4）。
                  </div>
                </div>
              </div>

              <!-- 审批操作区（按钮集合来自节点配置，FR-022.3） -->
              <div class="card mt8 mb12" style="border-radius:12px">
                <div class="card-body" style="padding:10px 12px">
                  <template v-if="actionNode">
                    <b>可执行操作 · {{ mark(actionNode.seq) }} {{ actionNode.name }}</b>
                    <div class="form-row" style="grid-template-columns:70px 1fr;margin-top:8px">
                      <label>审批意见</label>
                      <div class="ctrl">
                        <textarea v-model="comment" :class="{invalid: errComment}"
                                  placeholder="通过可留空（默认「同意」）；驳回必须填写原因"></textarea>
                        <span class="err-text" v-if="errComment">驳回必须填写原因（SRS FR-017.5）</span>
                      </div>
                    </div>
                    <div class="btn-row">
                      <button v-for="a in actionButtons" :key="a.code" class="btn sm"
                              :class="a.danger ? 'danger' : 'primary'" @click="act(a.code)">{{ a.name }}</button>
                    </div>
                    <div class="muted mt8" style="font-size:11px">
                      按钮仅显示该节点在流程定义中配置的动作；提交后写入同一条 FHIR Task 的 output 与状态，
                      桌面端审批中心刷新即可看到（FR-017.6 / .7）。
                    </div>
                  </template>
                  <template v-else>
                    <div class="alert warn"><span>⏳</span>
                      <div>当前节点不在本人待办中（可能已由其他审批人处理，或该节点按会签/或签规则不分配给您）。
                        可点「🔄 刷新」重新查询服务端，或返回列表查看其它待办。</div>
                    </div>
                  </template>
                  <div class="btn-row mt8">
                    <button class="btn sm" @click="backList">‹ 返回待办</button>
                    <button class="btn sm ghost" @click="desktop">回到桌面端查看</button>
                  </div>
                </div>
              </div>
            </div>
          </div>
        </div>
      </div>
    </div>`
  };
})(window);
