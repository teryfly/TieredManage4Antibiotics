/* =====================================================================
 * gatekeep.js —— L3-4-1 权限卡控规则（系统管理员）
 * 配置不同分级级别抗菌药物开具时的校验条件与拦截动作；与权限映射、
 * 审批流程联动；支持拦截策略配置与规则模拟测试。
 * ===================================================================== */
(function (global) {
  'use strict';
  var AMS = global.AMS, Svc = global.Svc, D = global.Domain, App = global.App;

  var APPROVAL_NAME = { dept: '科室负责人', pharmacy: '药学部门', expert: '审批专家' };

  AMS.pages['gatekeep'] = {
    data: function () {
      return {
        showEdit: false,
        editLevel: '',
        editLevelName: '',
        editForm: { approvalCheck: [], interceptOnTitleMismatch: 'block', interceptOnNotApproved: 'block' },
        editOriginalApprovals: [],
        strategy: { interceptMode: 'popup', insufficientText: '', notApprovedText: '' }
      };
    },
    created: function () {
      this.D = D;
      var st = Svc.gatekeepStatus();
      this.strategy = { interceptMode: st.interceptMode, insufficientText: st.insufficientText, notApprovedText: st.notApprovedText };
    },
    computed: {
      status: function () { App.state.refresh; return Svc.gatekeepStatus(); },
      rules: function () { App.state.refresh; return Svc.gatekeepRules(); },
      mappings: function () { App.state.refresh; return Svc.mappingRules(); },
      logs: function () { App.state.refresh; return Svc.gatekeepLogs(); },
      titles: function () { return D.TITLES; },
      levels: function () { return D.LEVELS; }
    },
    methods: {
      // 卡控条件：审批要求文案（取自权限映射）
      approvalReq: function (level) {
        var m = this.mappings.filter(function (r) { return r.level === level; })[0];
        if (!m || !m.approvals.length) return '无额外审批要求';
        return '需' + m.approvals.map(function (a) { return APPROVAL_NAME[a]; }).join('+') + '审批';
      },
      hasApproval: function (level) {
        var m = this.mappings.filter(function (r) { return r.level === level; })[0];
        return !!(m && m.approvals.length);
      },
      intLabel: function (mode) { return mode === 'block' ? '拦截提交' : '仅提示不拦截'; },
      openEdit: function (rule) {
        this.editLevel = rule.level;
        this.editLevelName = rule.levelName;
        this.editForm = {
          approvalCheck: (rule.approvalCheck || []).slice(),
          interceptOnTitleMismatch: rule.interceptOnTitleMismatch || 'block',
          interceptOnNotApproved: rule.interceptOnNotApproved === 'none' ? 'block' : (rule.interceptOnNotApproved || 'block')
        };
        this.editOriginalApprovals = (rule.approvalCheck || []).slice();
        this.showEdit = true;
      },
      saveEdit: function () {
        var newApprovals = this.editForm.approvalCheck.slice();
        var orig = this.editOriginalApprovals;
        var approvalsChanged = newApprovals.length !== orig.length || newApprovals.some(function (a) { return orig.indexOf(a) < 0; });
        if (approvalsChanged) {
          var ok = confirm('调整"审批状态校验"将同步更新「' + this.editLevelName + '」在目录综合管理→权限映射规则表中的审批要求，以及该分级下未单独调整权限的药品，是否继续？');
          if (!ok) return;
        }
        Svc.saveGatekeepRule(this.editLevel, {
          approvalCheck: newApprovals,
          interceptOnTitleMismatch: this.editForm.interceptOnTitleMismatch,
          interceptOnNotApproved: newApprovals.length ? this.editForm.interceptOnNotApproved : 'none'
        });
        this.showEdit = false;
        App.toast('卡控规则已保存并即时生效' + (approvalsChanged ? '，权限映射已同步更新' : ''));
      },
      saveStrategy: function () {
        Svc.saveGatekeepStatus({
          interceptMode: this.strategy.interceptMode,
          insufficientText: this.strategy.insufficientText,
          notApprovedText: this.strategy.notApprovedText
        });
        App.toast('拦截策略已保存');
      }
    },
    template: `
    <div>
      <!-- C 规则生效状态 -->
      <div class="info-bar">
        <span>{{ status.active ? '🟢 卡控规则已生效' : '🔴 卡控规则未启用' }}</span>
        <span class="sep">│</span>
        <span>最后修改：{{ status.lastModified }}</span>
        <span class="sep">│</span>
        <span>操作人：{{ status.operator }}</span>
      </div>
      <div class="muted" style="font-size:13px;margin:8px 2px 0">影响范围：{{ status.scope }}</div>

      <!-- D 卡控规则配置表 -->
      <div class="card mt16">
        <div class="card-head"><h3>🛡️ 卡控规则配置表</h3></div>
        <div class="card-body" style="padding:0">
          <div class="table-wrap">
          <table class="tbl">
            <thead><tr><th style="width:140px">分级级别</th><th>卡控条件</th><th>拦截动作</th><th style="width:80px">操作</th></tr></thead>
            <tbody>
              <tr v-for="r in rules">
                <td><level-tag :level="r.level"></level-tag></td>
                <td>
                  <div>· 职称不匹配</div>
                  <div>· {{ approvalReq(r.level) }}</div>
                  <div v-if="hasApproval(r.level)">· 审批未通过</div>
                </td>
                <td>
                  <div>{{ r.interceptOnTitleMismatch==='block' ? '拦截提交，提示权限不足' : '仅提示不拦截（权限不足）' }}</div>
                  <div>引导申请对应处方权</div>
                  <div v-if="hasApproval(r.level)">{{ r.interceptOnNotApproved==='block' ? '拦截提交，提示审批未通过' : (r.interceptOnNotApproved==='warn' ? '仅提示不拦截（审批未通过）' : '—') }}</div>
                </td>
                <td class="actions"><a class="btn-link" @click="openEdit(r)">编辑</a></td>
              </tr>
            </tbody>
          </table>
          </div>
        </div>
      </div>
      <div class="alert info mt12"><span>💡</span><div>卡控规则与权限映射配置联动，修改映射规则后卡控条件自动同步更新。</div></div>

      <!-- E 拦截策略配置 -->
      <div class="card mt16">
        <div class="card-head"><h3>⚙️ 拦截策略配置</h3></div>
        <div class="card-body">
          <div class="form-row">
            <label>拦截提示方式</label>
            <div class="ctrl">
              <div class="radios" style="flex-direction:row;gap:18px">
                <label><input type="radio" value="popup" v-model="strategy.interceptMode"> 弹窗提示</label>
                <label><input type="radio" value="silent" v-model="strategy.interceptMode"> 静默拦截</label>
              </div>
            </div>
          </div>
          <div class="divider-label">拦截提示内容</div>
          <div class="form-row">
            <label>权限不足时</label>
            <div class="ctrl"><textarea rows="3" v-model="strategy.insufficientText" placeholder="权限不足时的提示文案..."></textarea></div>
          </div>
          <div class="form-row">
            <label>审批未通过时</label>
            <div class="ctrl"><textarea rows="3" v-model="strategy.notApprovedText" placeholder="审批未通过时的提示文案..."></textarea></div>
          </div>
          <div style="text-align:right"><button class="btn primary" @click="saveStrategy">保存策略</button></div>
        </div>
      </div>

      <!-- 规则变更日志 -->
      <div class="card mt16">
        <div class="card-head"><h3>📜 规则变更日志</h3></div>
        <div class="card-body" style="padding:0">
          <div class="table-wrap">
            <table class="tbl" v-if="logs.length">
              <thead><tr><th>修改时间</th><th>变更内容</th><th>操作人</th></tr></thead>
              <tbody>
                <tr v-for="l in logs"><td class="nowrap">{{ l.recorded }}</td><td>{{ l.ext.content }}</td><td class="nowrap">{{ l.ext.operator }}</td></tr>
              </tbody>
            </table>
            <empty-state v-else text="暂无变更记录"></empty-state>
          </div>
        </div>
      </div>

      <!-- 卡控规则编辑弹框 -->
      <ui-modal v-if="showEdit" :title="'编辑卡控规则 - '+editLevelName" @close="showEdit=false">
        <div class="divider-label">基本信息</div>
        <div class="form-row">
          <label>分级级别</label>
          <div class="ctrl"><span style="padding-top:7px">{{ editLevelName }}（不可修改）</span></div>
        </div>

        <div class="divider-label">卡控条件</div>
        <div class="form-row">
          <label>职称校验</label>
          <div class="ctrl">
            <label style="display:inline-flex;align-items:center;gap:6px;font-size:13px;cursor:not-allowed">
              <input type="checkbox" checked disabled> 启用职称匹配校验（系统自动按权限映射校验，不可关闭）
            </label>
          </div>
        </div>
        <div class="form-row">
          <label>审批状态校验</label>
          <div class="ctrl">
            <div class="checks" style="flex-direction:column;gap:8px">
              <label><input type="checkbox" value="dept" v-model="editForm.approvalCheck"> 需科室负责人审批通过</label>
              <label><input type="checkbox" value="pharmacy" v-model="editForm.approvalCheck"> 需药学部门审批通过</label>
              <label><input type="checkbox" value="expert" v-model="editForm.approvalCheck"> 需审批专家审批通过</label>
            </div>
            <div class="muted mt8" style="font-size:12px">调整以上勾选项并保存后，将同步更新目录综合管理→权限映射规则表中的审批要求，及该分级下未单独设置权限映射的药品。</div>
          </div>
        </div>

        <div class="divider-label">拦截动作</div>
        <div class="form-row">
          <label>职称不匹配时</label>
          <div class="ctrl">
            <div class="radios">
              <label><input type="radio" value="block" v-model="editForm.interceptOnTitleMismatch"> 拦截提交并提示</label>
              <label><input type="radio" value="warn" v-model="editForm.interceptOnTitleMismatch"> 仅提示不拦截（允许提交）</label>
            </div>
          </div>
        </div>
        <div class="form-row">
          <label>审批未通过时</label>
          <div class="ctrl">
            <div class="radios">
              <label><input type="radio" value="block" v-model="editForm.interceptOnNotApproved"> 拦截提交并提示</label>
              <label><input type="radio" value="warn" v-model="editForm.interceptOnNotApproved"> 仅提示不拦截（允许提交）</label>
            </div>
            <span class="muted" style="font-size:12px" v-if="!editForm.approvalCheck.length">未勾选审批节点时该设置不生效</span>
          </div>
        </div>

        <div class="alert warn"><span>⚠️</span><div>卡控规则变更后即时生效，影响后续所有抗菌药物医嘱的权限校验。</div></div>

        <template #foot>
          <button class="btn" @click="showEdit=false">取消</button>
          <button class="btn primary" @click="saveEdit">确认保存</button>
        </template>
      </ui-modal>
    </div>`
  };
})(window);
