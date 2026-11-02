/* =====================================================================
 * workflow-config.js —— L3-4-2 审批流程配置（系统管理员）
 * 配置抗菌药物处方权的在线审批流程：审批节点、审批人、时限与生效范围，
 * 支持新增自定义流程、编辑/添加节点、编辑生效范围、启停用流程。
 * ===================================================================== */
(function (global) {
  'use strict';
  var AMS = global.AMS, Svc = global.Svc, D = global.Domain, App = global.App;

  var ROLE_OPTS = [
    { code: 'dept', name: '科室负责人' },
    { code: 'pharmacy', name: '药学部门' },
    { code: 'expert', name: '审批专家' }
  ];
  var TIMEOUTS = ['仅提醒', '提醒并转交上级', '提醒并标记超时待办', '自动通过'];

  function roleName(code) { for (var i = 0; i < ROLE_OPTS.length; i++) if (ROLE_OPTS[i].code === code) return ROLE_OPTS[i].name; return code; }

  AMS.pages['workflow-config'] = {
    data: function () {
      return {
        showDetail: false, showNew: false, showNode: false, showScope: false,
        current: null,            // 当前查看/编辑的流程（store 引用）
        nodeForm: null,           // 节点编辑工作副本
        nodeIsNew: false,         // 节点是新增还是编辑
        nodeIndex: -1,            // 编辑时的节点下标
        scopeForm: null,          // 生效范围工作副本
        newForm: this.blankNew(),
        newErr: {}
      };
    },
    created: function () { this.D = D; },
    computed: {
      // 模板里裸用 D.xxx() 取不到值（Vue 只在实例上查找），显式暴露领域常量
      D: function () { return D; },
      isAdmin: function () { return App.state.roleCode === 'admin'; },
      flows: function () { App.state.refresh; return Svc.workflows(); }
    },
    methods: {
      /* -------- 公共数据 -------- */
      levels: function () { return D.LEVELS; },
      titles: function () { return D.TITLES; },
      roleOpts: function () { return ROLE_OPTS; },
      timeoutOpts: function () { return TIMEOUTS; },
      modeName: function (m) { return m === 'and' ? '会签' : '或签'; },
      approverText: function (n) {
        return n.approverType === 'auto'
          ? '自动匹配申请人所属科室负责人'
          : '指定：' + (n.approvers && n.approvers.length ? n.approvers.join('、') : '—');
      },
      seqMark: function (seq) { var m = ['①', '②', '③', '④', '⑤', '⑥', '⑦', '⑧', '⑨']; return m[seq - 1] || ('(' + seq + ')'); },
      specialDrugs: function () {
        return Svc.medications({ level: 'special' }).map(function (m) { return m.code.text; });
      },

      /* -------- 列表操作 -------- */
      openDetail: function (f) { this.current = f; this.showDetail = true; },
      openEdit: function (f) { this.openDetail(f); },
      toggle: function (f) {
        if (f.status === 'active') {
          var running = Svc.runningApprovalCount(f.ext.level);
          var msg = running > 0
            ? '该流程下当前有 ' + running + ' 件进行中的审批，停用后这些审批将继续完成，新申请不再进入该流程。确认停用？'
            : '停用后新申请不再进入该流程，已在流程中的审批继续完成，确认停用？';
          if (!confirm(msg)) return;
        }
        Svc.toggleWorkflow(f.id);
        App.toast(f.status === 'active' ? '流程已停用' : '流程已启用');
      },

      /* -------- 新增流程 -------- */
      blankNew: function () {
        return {
          title: '', level: '',
          role: 'dept', approverType: 'auto', approvers: '',
          mode: 'or', hours: 24, timeout: '仅提醒',
          scopeDrug: '该分级级别全部药品', scopeDept: '全院',
          applyTitles: [], extraCond: ''
        };
      },
      openNew: function () { this.newForm = this.blankNew(); this.newErr = {}; this.showNew = true; },
      // 选择适用药品分类后，"申请条件"的职称要求默认按权限映射配置中该分级的可开具职称勾选
      onNewLevelChange: function () {
        if (!this.newForm.level) return;
        var rule = Svc.mappingRules().filter(function (r) { return r.level === this.newForm.level; }.bind(this))[0];
        if (rule) this.newForm.applyTitles = rule.allowedTitles.slice();
      },
      validateNew: function () {
        var e = {}, f = this.newForm;
        if (!f.title) e.title = 1;
        if (!f.level) e.level = 1;
        if (!f.role) e.role = 1;
        if (!f.hours) e.hours = 1;
        this.newErr = e; return Object.keys(e).length === 0;
      },
      createFlow: function () {
        if (!this.validateNew()) { App.toast('请完善必填信息', 'error'); return; }
        var f = this.newForm;
        var approvers = f.approverType === 'assigned'
          ? f.approvers.split(/[,，、\s]+/).filter(function (s) { return s; })
          : [];
        var node = {
          seq: 1, role: f.role, roleName: roleName(f.role), mode: f.mode,
          approverType: f.approverType, approvers: approvers,
          hours: Number(f.hours), timeout: f.timeout
        };
        var ext = {
          level: f.level, nodes: [node],
          scopeDrug: f.scopeDrug, scopeDept: f.scopeDept,
          applyTitles: f.applyTitles.slice(), extraCond: f.extraCond
        };
        Svc.saveWorkflow({ title: f.title, ext: ext }, true);
        this.showNew = false;
        App.toast('审批流程已创建');
      },

      /* -------- 节点编辑 / 添加 -------- */
      blankNode: function () {
        return { role: 'dept', approverType: 'auto', approvers: '', mode: 'or', hours: 24, timeout: '仅提醒', remindFreq: 12 };
      },
      openNodeEdit: function (n, idx) {
        this.nodeIsNew = false; this.nodeIndex = idx;
        this.nodeForm = {
          role: n.role, approverType: n.approverType,
          approvers: (n.approvers || []).join('、'),
          mode: n.mode, hours: n.hours, timeout: n.timeout,
          remindFreq: n.remindFreq || 12
        };
        this.showNode = true;
      },
      openNodeAdd: function () {
        this.nodeIsNew = true; this.nodeIndex = -1;
        this.nodeForm = this.blankNode();
        this.showNode = true;
      },
      saveNode: function () {
        var f = this.nodeForm;
        if (!f.role || !f.hours) { App.toast('请完善节点必填信息', 'error'); return; }
        var approvers = f.approverType === 'assigned'
          ? f.approvers.split(/[,，、\s]+/).filter(function (s) { return s; })
          : [];
        var nodes = this.current.ext.nodes.slice();
        var data = {
          role: f.role, roleName: roleName(f.role), mode: f.mode,
          approverType: f.approverType, approvers: approvers,
          hours: Number(f.hours), timeout: f.timeout, remindFreq: Number(f.remindFreq)
        };
        if (this.nodeIsNew) {
          data.seq = nodes.length + 1;
          nodes.push(data);
        } else {
          data.seq = nodes[this.nodeIndex].seq;
          nodes[this.nodeIndex] = data;
        }
        // 重新编号
        nodes.forEach(function (nd, i) { nd.seq = i + 1; });
        var ext = Object.assign({}, this.current.ext, { nodes: nodes });
        this.current = Svc.saveWorkflow({ id: this.current.id, title: this.current.title, ext: ext }, false);
        this.showNode = false;
        App.toast(this.nodeIsNew ? '节点已添加' : '节点已保存');
      },
      removeNode: function (idx) {
        if (this.current.ext.nodes.length <= 1) { App.toast('每个流程至少保留 1 个审批节点', 'error'); return; }
        if (!confirm('确认删除该审批节点？')) return;
        var nodes = this.current.ext.nodes.slice();
        nodes.splice(idx, 1);
        nodes.forEach(function (nd, i) { nd.seq = i + 1; });
        var ext = Object.assign({}, this.current.ext, { nodes: nodes });
        this.current = Svc.saveWorkflow({ id: this.current.id, title: this.current.title, ext: ext }, false);
        App.toast('节点已删除');
      },
      // 节点顺序调整（上移 / 下移）
      moveNode: function (idx, dir) {
        var nodes = this.current.ext.nodes.slice();
        var j = idx + dir;
        if (j < 0 || j >= nodes.length) return;
        var tmp = nodes[idx]; nodes[idx] = nodes[j]; nodes[j] = tmp;
        nodes.forEach(function (nd, i) { nd.seq = i + 1; });
        var ext = Object.assign({}, this.current.ext, { nodes: nodes });
        this.current = Svc.saveWorkflow({ id: this.current.id, title: this.current.title, ext: ext }, false);
        App.toast('节点顺序已调整');
      },

      /* -------- 生效范围编辑 -------- */
      openScope: function () {
        var ext = this.current.ext;
        this.scopeForm = {
          scopeDrug: ext.scopeDrug === '指定药品' ? '指定药品' : '该分级级别全部药品',
          scopeDrugList: [],
          scopeDept: ext.scopeDept === '全院' ? '全院' : '指定科室',
          applyTitles: (ext.applyTitles || []).slice(),
          extraCond: ext.extraCond || ''
        };
        this.showScope = true;
      },
      saveScope: function () {
        var s = this.scopeForm;
        var ext = Object.assign({}, this.current.ext, {
          scopeDrug: s.scopeDrug, scopeDept: s.scopeDept,
          applyTitles: s.applyTitles.slice(), extraCond: s.extraCond
        });
        this.current = Svc.saveWorkflow({ id: this.current.id, title: this.current.title, ext: ext }, false);
        this.showScope = false;
        App.toast('生效范围已更新');
      },
      titleNames: function (codes) {
        return (codes || []).map(function (c) { return D.titleName(c); }).join('、');
      }
    },
    template: `
    <div v-if="!isAdmin" class="card"><div class="card-body"><empty-state icon="🔒" text="本页面仅对「系统管理员」角色开放。请使用顶部演示角色切换为「系统管理员」。"></empty-state></div></div>
    <div v-else>
      <!-- C 审批流程列表 -->
      <div class="card">
        <div class="card-head">
          <h3>⚙️ 审批流程列表</h3>
          <button class="btn primary" @click="openNew">+ 新增流程</button>
        </div>
        <div class="card-body" style="padding:0">
          <div class="table-wrap">
            <table class="tbl" v-if="flows.length">
              <thead><tr><th>流程名称</th><th>适用药品分类</th><th>审批节点数</th><th>状态</th><th>操作</th></tr></thead>
              <tbody>
                <tr v-for="f in flows">
                  <td>{{ f.title }}</td>
                  <td>{{ D.levelName(f.ext.level) }}</td>
                  <td>{{ f.ext.nodes.length }}</td>
                  <td>{{ f.status==='active' ? '🟢 启用' : '🔴 停用' }}</td>
                  <td class="actions">
                    <a class="btn-link" @click="openDetail(f)">详情</a>
                    <a class="btn-link" @click="openEdit(f)">编辑</a>
                    <a class="btn-link" :class="{danger:f.status==='active'}" @click="toggle(f)">{{ f.status==='active' ? '停用' : '启用' }}</a>
                  </td>
                </tr>
              </tbody>
            </table>
            <empty-state v-else text="暂无审批流程"><button class="btn primary" @click="openNew">+ 新增流程</button></empty-state>
          </div>
        </div>
      </div>

      <!-- 流程详情弹框 -->
      <ui-modal v-if="showDetail && current" :title="'流程详情 - '+current.title" width="wide" @close="showDetail=false">
        <div class="divider-label">流程节点</div>
        <div class="steps" style="margin:6px 0 14px">
          <div class="step approved">
            <div class="dot">▶</div><div class="bar"></div>
            <div class="s-name">提交申请</div><div class="s-meta">起始</div>
          </div>
          <div class="step" v-for="(n,i) in current.ext.nodes">
            <div class="dot">{{ n.seq }}</div><div class="bar" v-if="i<current.ext.nodes.length-1"></div>
            <div class="s-name">{{ n.roleName }}</div><div class="s-meta">{{ modeName(n.mode) }} · {{ n.hours }}h</div>
          </div>
        </div>

        <div class="table-wrap">
          <table class="tbl">
            <thead><tr><th>节点</th><th>审批角色</th><th>审批人设置</th><th>会签/或签</th><th>办理时限</th><th>超时处理</th><th>操作</th></tr></thead>
            <tbody>
              <tr v-for="(n,i) in current.ext.nodes">
                <td>{{ seqMark(n.seq) }}</td>
                <td>{{ n.roleName }}</td>
                <td>{{ approverText(n) }}</td>
                <td>{{ modeName(n.mode) }}</td>
                <td class="nowrap">{{ n.hours }}h</td>
                <td>{{ n.timeout }}</td>
                <td class="actions">
                  <a class="btn-link" v-if="i>0" @click="moveNode(i,-1)" title="上移">↑</a>
                  <a class="btn-link" v-if="i<current.ext.nodes.length-1" @click="moveNode(i,1)" title="下移">↓</a>
                  <a class="btn-link" @click="openNodeEdit(n,i)">编辑</a>
                  <a class="btn-link danger" @click="removeNode(i)">删除</a>
                </td>
              </tr>
            </tbody>
          </table>
        </div>
        <div class="btn-row" style="justify-content:flex-end;margin-top:12px">
          <button class="btn" @click="openNodeAdd">+ 添加节点</button>
        </div>

        <div class="divider-label">生效范围</div>
        <div class="kv">
          <span class="k">适用药品范围</span><span>{{ current.ext.scopeDrug }}</span>
          <span class="k">适用科室范围</span><span>{{ current.ext.scopeDept }}</span>
          <span class="k">申请条件</span><span>
            <template v-if="current.ext.applyTitles && current.ext.applyTitles.length">职称要求：{{ titleNames(current.ext.applyTitles) }}</template>
            <template v-else>职称不限</template>
            <template v-if="current.ext.extraCond">；{{ current.ext.extraCond }}</template>
          </span>
        </div>
        <div class="btn-row" style="justify-content:flex-end;margin-top:12px">
          <button class="btn" @click="openScope">编辑生效范围</button>
        </div>

        <template #foot><button class="btn" @click="showDetail=false">关闭</button></template>
      </ui-modal>

      <!-- 新增流程弹框 -->
      <ui-modal v-if="showNew" title="新增审批流程" @close="showNew=false">
        <div class="divider-label">基本信息</div>
        <div class="form-row">
          <label class="req">流程名称</label>
          <div class="ctrl"><input type="text" v-model="newForm.title" :class="{invalid:newErr.title}" placeholder="请输入审批流程名称">
            <span class="err-text" v-if="newErr.title">请输入流程名称</span></div>
        </div>
        <div class="form-row">
          <label class="req">适用药品分类</label>
          <div class="ctrl"><select v-model="newForm.level" :class="{invalid:newErr.level}" @change="onNewLevelChange">
            <option value="">请选择</option>
            <option v-for="lv in levels()" :value="lv.code">{{ lv.name }}</option>
          </select><span class="err-text" v-if="newErr.level">请选择适用药品分类</span></div>
        </div>

        <div class="divider-label">初始节点</div>
        <div class="alert warn" style="margin-bottom:12px"><span>⚠️</span><div>流程创建后至少需要一个审批节点，可在详情中继续添加和编辑。</div></div>
        <div class="form-row">
          <label class="req">审批角色</label>
          <div class="ctrl"><select v-model="newForm.role" :class="{invalid:newErr.role}">
            <option v-for="r in roleOpts()" :value="r.code">{{ r.name }}</option>
          </select></div>
        </div>
        <div class="form-row">
          <label class="req">审批人方式</label>
          <div class="ctrl"><div class="radios">
            <label><input type="radio" value="auto" v-model="newForm.approverType"> 自动匹配（根据审批角色和申请人科室自动分配）</label>
            <label><input type="radio" value="assigned" v-model="newForm.approverType"> 指定人员</label>
          </div>
          <input type="text" v-if="newForm.approverType==='assigned'" v-model="newForm.approvers" placeholder="输入审批人姓名，多人用顿号或逗号分隔" style="margin-top:6px">
          </div>
        </div>
        <div class="form-row">
          <label class="req">审批方式</label>
          <div class="ctrl"><div class="radios">
            <label><input type="radio" value="and" v-model="newForm.mode"> 会签（所有审批人均需通过）</label>
            <label><input type="radio" value="or" v-model="newForm.mode"> 或签（任一审批人通过即可）</label>
          </div></div>
        </div>
        <div class="form-row">
          <label class="req">办理时限</label>
          <div class="ctrl" style="flex-direction:row;align-items:center;gap:6px">
            <input type="number" min="1" v-model.number="newForm.hours" :class="{invalid:newErr.hours}" style="width:90px"> 小时</div>
        </div>
        <div class="form-row">
          <label>超时处理</label>
          <div class="ctrl"><select v-model="newForm.timeout">
            <option v-for="t in timeoutOpts()" :value="t">{{ t }}</option>
          </select></div>
        </div>

        <div class="divider-label">生效范围</div>
        <div class="form-row">
          <label>适用药品范围</label>
          <div class="ctrl"><div class="radios">
            <label><input type="radio" value="该分级级别全部药品" v-model="newForm.scopeDrug"> 该分级级别全部药品</label>
            <label><input type="radio" value="指定药品" v-model="newForm.scopeDrug"> 指定药品</label>
          </div></div>
        </div>
        <div class="form-row">
          <label>适用科室范围</label>
          <div class="ctrl"><div class="radios">
            <label><input type="radio" value="全院" v-model="newForm.scopeDept"> 全院</label>
            <label><input type="radio" value="指定科室" v-model="newForm.scopeDept"> 指定科室</label>
          </div></div>
        </div>
        <div class="form-row">
          <label>申请条件</label>
          <div class="ctrl">
            <div class="checks">
              <label v-for="t in titles()"><input type="checkbox" :value="t.code" v-model="newForm.applyTitles"> {{ t.name }}</label>
            </div>
            <span class="muted" style="font-size:12px">选择适用药品分类后，已按权限映射配置中该分级的可开具职称默认勾选，可按需调整</span>
            <textarea v-model="newForm.extraCond" placeholder="其他条件（选填）" style="margin-top:8px"></textarea>
          </div>
        </div>

        <template #foot>
          <button class="btn" @click="showNew=false">取消</button>
          <button class="btn primary" @click="createFlow">确认创建</button>
        </template>
      </ui-modal>

      <!-- 节点编辑 / 添加弹框 -->
      <ui-modal v-if="showNode && nodeForm" :title="nodeIsNew ? '添加审批节点' : '编辑审批节点'" @close="showNode=false">
        <div class="form-row">
          <label class="req">审批角色</label>
          <div class="ctrl"><select v-model="nodeForm.role">
            <option v-for="r in roleOpts()" :value="r.code">{{ r.name }}</option>
          </select></div>
        </div>
        <div class="form-row">
          <label class="req">审批人方式</label>
          <div class="ctrl"><div class="radios">
            <label><input type="radio" value="auto" v-model="nodeForm.approverType"> 自动匹配（根据审批角色和申请人科室自动分配）</label>
            <label><input type="radio" value="assigned" v-model="nodeForm.approverType"> 指定人员</label>
          </div>
          <input type="text" v-if="nodeForm.approverType==='assigned'" v-model="nodeForm.approvers" placeholder="输入审批人姓名，多人用顿号或逗号分隔" style="margin-top:6px">
          </div>
        </div>
        <div class="form-row">
          <label class="req">审批方式</label>
          <div class="ctrl"><div class="radios">
            <label><input type="radio" value="and" v-model="nodeForm.mode"> 会签（所有审批人均需通过）</label>
            <label><input type="radio" value="or" v-model="nodeForm.mode"> 或签（任一审批人通过即可）</label>
          </div></div>
        </div>
        <div class="form-row">
          <label class="req">办理时限</label>
          <div class="ctrl" style="flex-direction:row;align-items:center;gap:6px">
            <input type="number" min="1" v-model.number="nodeForm.hours" style="width:90px"> 小时</div>
        </div>
        <div class="form-row">
          <label>超时处理</label>
          <div class="ctrl"><select v-model="nodeForm.timeout">
            <option v-for="t in timeoutOpts()" :value="t">{{ t }}</option>
          </select></div>
        </div>
        <div class="form-row" v-if="nodeForm.timeout!=='自动通过'">
          <label>超时提醒频率</label>
          <div class="ctrl" style="flex-direction:row;align-items:center;gap:6px">
            每 <input type="number" min="1" v-model.number="nodeForm.remindFreq" style="width:80px"> 小时提醒一次</div>
        </div>

        <template #foot>
          <button class="btn" @click="showNode=false">取消</button>
          <button class="btn primary" @click="saveNode">{{ nodeIsNew ? '确认添加' : '确认保存' }}</button>
        </template>
      </ui-modal>

      <!-- 生效范围编辑弹框 -->
      <ui-modal v-if="showScope && scopeForm" title="编辑生效范围" @close="showScope=false">
        <div class="divider-label">适用药品范围</div>
        <div class="radios" style="margin-bottom:10px">
          <label><input type="radio" value="该分级级别全部药品" v-model="scopeForm.scopeDrug"> 该分级级别全部药品</label>
          <label><input type="radio" value="指定药品" v-model="scopeForm.scopeDrug"> 指定药品</label>
        </div>
        <div class="checks" v-if="scopeForm.scopeDrug==='指定药品'" style="flex-direction:column;gap:8px;padding:10px 12px;border:1px solid var(--border);border-radius:8px;margin-bottom:6px">
          <label v-for="d in specialDrugs()"><input type="checkbox" :value="d" v-model="scopeForm.scopeDrugList"> {{ d }}</label>
          <span class="muted" v-if="!specialDrugs().length" style="font-size:12px">暂无可选药品</span>
        </div>

        <div class="divider-label">适用科室范围</div>
        <div class="radios" style="margin-bottom:10px">
          <label><input type="radio" value="全院" v-model="scopeForm.scopeDept"> 全院</label>
          <label><input type="radio" value="指定科室" v-model="scopeForm.scopeDept"> 指定科室</label>
        </div>

        <div class="divider-label">申请条件</div>
        <div class="form-row">
          <label>职称要求</label>
          <div class="ctrl"><div class="checks">
            <label v-for="t in titles()"><input type="checkbox" :value="t.code" v-model="scopeForm.applyTitles"> {{ t.name }}</label>
          </div></div>
        </div>
        <div class="form-row">
          <label>其他条件</label>
          <div class="ctrl"><textarea v-model="scopeForm.extraCond" placeholder="（选填）"></textarea></div>
        </div>

        <template #foot>
          <button class="btn" @click="showScope=false">取消</button>
          <button class="btn primary" @click="saveScope">确认保存</button>
        </template>
      </ui-modal>
    </div>`
  };
})(window);
