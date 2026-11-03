/* =====================================================================
 * workflow-designer.js —— 审批流程可视化设计器
 * SRS FR-011 拖选配置审核节点 / FR-012 按人员 / FR-013 按科室 / FR-014 按角色
 *           FR-015 保存草稿与无感发布 / §6.4 页面构成
 * ---------------------------------------------------------------------
 * 页面构成（SRS §6.4）：流程节点工具栏 + 流程画布 + 节点属性编辑区 +
 * 版本信息区 + 发布操作区。新增审核节点通过拖拽放入画布。
 * ===================================================================== */
(function (global) {
  'use strict';
  var AMS = global.AMS, Svc = global.Svc, D = global.Domain, App = global.App;
  var Ap = global.Approval, F = global.FHIR;

  var PALETTE = [
    { type: 'person', name: '审核节点 · 按人员', icon: '👤', hint: 'FR-012 指定到具体人员' },
    { type: 'department', name: '审核节点 · 按科室', icon: '🏥', hint: 'FR-013 指定到组织科室' },
    { type: 'role', name: '审核节点 · 按角色', icon: '🎖️', hint: 'FR-014 指定到岗位角色' },
    { type: 'auto', name: '审核节点 · 自动匹配', icon: '🔄', hint: '按开单医师科室匹配科室负责人' }
  ];

  AMS.pages['workflow-designer'] = {
    data: function () {
      return {
        purpose: 'tier-approval',
        level: 'special',
        pdId: '',
        title: '',
        nodes: [],
        selected: -1,
        dragFrom: null,
        dragOver: null,
        versions: [],
        showPublish: false,
        publishNote: '',
        validateResult: null,
        savedInfo: null,
        peopleKeyword: ''
      };
    },
    computed: {
      D: function () { return D; },
      Ap: function () { return Ap; },
      user: function () { return App.currentUser(); },
      role: function () { return App.state.roleCode; },
      canView: function () { return D.canAccess(this.role, 'workflow-designer'); },
      levelBound: function () { var p = D.flowPurpose(this.purpose); return p ? p.levelBound : false; },
      purposes: function () { return D.FLOW_PURPOSES; },
      palette: function () { return PALETTE; },
      pd: function () { App.state.refresh; return this.pdId ? F.read('PlanDefinition', this.pdId) : null; },
      isPublished: function () { return !!this.pd && this.pd.status === 'active'; },
      isEditable: function () { return !!this.pd && this.pd.status !== 'active'; },
      approvalNodes: function () {
        return this.nodes.filter(function (n) { return n.type !== 'start' && n.type !== 'end'; });
      },
      /* 版本信息区 */
      versionList: function () {
        App.state.refresh;
        return Ap.versions(this.purpose, this.levelField).slice().reverse();
      },
      levelField: function () { return this.levelBound ? this.level : ''; },
      currentPublished: function () {
        App.state.refresh;
        return Ap.currentVersion(this.purpose, this.levelField);
      },
      /* 属性编辑区的数据源 */
      selectedNode: function () { return this.selected >= 0 ? this.nodes[this.selected] : null; },
      people: function () {
        App.state.refresh;
        return F.search('Practitioner').map(function (p) {
          var i = Ap.practitionerInfo(p.id);
          return i ? { id: p.id, name: i.name, dept: i.dept, titleName: D.titleName(i.title),
            roles: (F.read('PractitionerRole', i.roleId) || { ext: {} }).ext.roles || [] } : null;
        }).filter(Boolean).sort(function (a, b) { return a.dept.localeCompare(b.dept, 'zh'); });
      },
      orgs: function () {
        App.state.refresh;
        return F.search('Organization', function (o) { return o.ext && o.ext.orgKind === 'department'; });
      },
      rolesForNode: function () { return D.APPROVAL_ROLES; },
      assigneeOptions: function () {
        var n = this.selectedNode;
        if (!n) return [];
        if (n.assigneeType === 'person') return this.people.map(function (p) { return { code: p.id, name: p.name + '（' + p.dept + ' · ' + (p.titleName || '—') + '）' }; });
        if (n.assigneeType === 'department') return this.orgs.map(function (o) { return { code: o.id, name: o.name }; });
        if (n.assigneeType === 'role') return this.rolesForNode.map(function (r) { return { code: r.code, name: r.name }; });
        return [];
      },
      resolvedAssignees: function () {
        var n = this.selectedNode;
        if (!n || n.assigneeType === 'auto') return [];
        return Ap.resolveAssignees(n, {});
      },
      publishSummary: function () { return Ap.diffSummary(this.nodes); },
      actionDefs: function () { return D.NODE_ACTIONS; },
      timeoutOptions: function () {
        return ['仅提醒', '提醒并转交上级', '提醒并标记超时待办', '自动通过'];
      }
    },
    methods: {
      /* ---------------- 版本装载 ---------------- */
      loadVersions: function () {
        this.versions = Ap.versions(this.purpose, this.levelField);
      },
      openLatestDraft: function () {
        var list = Ap.versions(this.purpose, this.levelField);
        var draft = list.filter(function (p) { return p.status === 'draft'; }).pop();
        var active = Ap.currentVersion(this.purpose, this.levelField);
        var target = draft || active;
        if (!target) { App.toast('该用途还没有任何流程版本，点「新建草稿」创建', 'error'); return; }
        if (draft) { this.pick(draft.id); }
        else {
          var d = Ap.newDraft({ purpose: this.purpose, level: this.levelField, title: active.ext.title, fromId: active.id });
          this.pick(d.id);
          App.toast('已基于当前发布版本 ' + active.version + ' 创建新草稿 ' + d.version, 'info');
        }
      },
      newDraft: function () {
        var d = Ap.newDraft({ purpose: this.purpose, level: this.levelField,
          title: D.flowPurposeName(this.purpose) + (this.levelField ? '（' + D.levelName(this.levelField) + '）' : '') });
        this.pick(d.id);
        App.toast('已创建草稿版本 V' + d.version);
      },
      pick: function (pdId) {
        var pd = F.read('PlanDefinition', pdId);
        if (!pd) return;
        this.pdId = pdId;
        this.title = pd.ext.title;
        this.purpose = pd.ext.purpose;
        if (pd.ext.level) this.level = pd.ext.level;
        this.nodes = Ap.nodesFromActions(pd);
        this.selected = this.nodes.length ? 0 : -1;
        this.validateResult = null; this.savedInfo = null;
        App.bump();
      },
      onPurposeChange: function () { this.pdId = ''; this.nodes = []; this.selected = -1; this.loadVersions(); },

      /* ---------------- 拖拽：工具栏 → 画布（FR-011.2） ---------------- */
      onPaletteDragStart: function (ev, item) {
        this.dragFrom = { kind: 'palette', item: item };
        ev.dataTransfer.effectAllowed = 'copy';
        try { ev.dataTransfer.setData('text/plain', item.type); } catch (e) {}
      },
      /* ---------------- 拖拽：画布内调序（FR-011.3） ---------------- */
      onNodeDragStart: function (ev, idx) {
        if (!this.isEditable) { ev.preventDefault(); return; }
        this.dragFrom = { kind: 'canvas', idx: idx };
        ev.dataTransfer.effectAllowed = 'move';
      },
      onDropOn: function (idx) {
        this.dragOver = null;
        var src = this.dragFrom;
        if (!src) return;
        if (!this.isEditable) { App.toast('已发布版本不可直接编辑，请「基于此版本新建草稿」', 'error'); this.dragFrom = null; return; }
        if (src.kind === 'palette') {
          var item = src.item;
          var node = Ap.mkNode(1, this.defaultName(item.type), item.type, [],
            { description: item.hint, deadlineHours: item.type === 'auto' ? 24 : 48 });
          this.nodes.splice(idx, 0, node);
          this.nodes = Ap.renumber(this.nodes);
          this.selected = this.nodes.indexOf(node);
          App.toast('已拖入新审核节点「' + node.name + '」，请在右侧配置审批对象');
        } else {
          var from = src.idx, to = idx > from ? idx - 1 : idx;
          if (from === to) return;
          var moved = this.nodes.splice(from, 1)[0];
          this.nodes.splice(to, 0, moved);
          this.nodes = Ap.renumber(this.nodes);
          this.selected = to;
          App.toast('节点顺序已调整为第 ' + (to + 1) + ' 位');
        }
        this.dragFrom = null;
      },
      defaultName: function (type) {
        return { person: '指定人员审核', department: '科室审核', role: '角色审核', auto: '科室负责人审核' }[type];
      },
      /* 无拖拽环境（或触屏）时的等价按钮 */
      appendNode: function (item) {
        var node = Ap.mkNode(this.nodes.length + 1, this.defaultName(item.type), item.type, [],
          { description: item.hint, deadlineHours: item.type === 'auto' ? 24 : 48 });
        this.nodes = Ap.renumber(this.nodes.concat([node]));
        this.selected = this.nodes.length - 1;
        App.toast('已新增审核节点「' + node.name + '」');
      },
      moveNode: function (idx, dir) {
        var j = idx + dir;
        if (j < 0 || j >= this.nodes.length) return;
        var t = this.nodes[idx]; this.nodes[idx] = this.nodes[j]; this.nodes[j] = t;
        this.nodes = Ap.renumber(this.nodes);
        this.selected = j;
      },
      /* FR-011.6：只允许删除尚未发布的新增节点 */
      removeNode: function (idx) {
        if (!this.isEditable) { App.toast('已发布流程的节点不可删除，请新建草稿版本', 'error'); return; }
        if (this.approvalNodes.length <= 1) { App.toast('流程至少应保留一个审核节点（FR-011.9）', 'error'); return; }
        if (!confirm('确认删除节点「' + this.nodes[idx].name + '」？')) return;
        this.nodes.splice(idx, 1);
        this.nodes = Ap.renumber(this.nodes);
        this.selected = Math.min(idx, this.nodes.length - 1);
        App.toast('节点已删除');
      },
      /* ---------------- 属性编辑（FR-011.5、FR-012/13/14） ---------------- */
      setAssigneeType: function (type) {
        var n = this.selectedNode; if (!n) return;
        n.assigneeType = type;
        n.assignees = [];
        n.nodeCode = type === 'role' ? '' : (type === 'auto' ? 'leader' : 'approval');
        if (!n.name) n.name = this.defaultName(type);
      },
      toggleAssignee: function (code) {
        var n = this.selectedNode; if (!n) return;
        var arr = (n.assignees || []).slice();
        var i = arr.indexOf(code);
        if (i >= 0) arr.splice(i, 1); else arr.push(code);
        n.assignees = arr;
        if (n.assigneeType === 'role' && arr.length) n.nodeCode = arr[0];
      },
      toggleAction: function (code) {
        var n = this.selectedNode; if (!n) return;
        var arr = (n.actions || []).slice();
        var i = arr.indexOf(code);
        if (i >= 0) arr.splice(i, 1); else arr.push(code);
        n.actions = arr;
      },
      isSelected: function (code) {
        var n = this.selectedNode;
        return !!(n && (n.assignees || []).indexOf(code) >= 0);
      },
      saveDraft: function () {
        if (!this.pdId) { App.toast('请先选择或新建一个流程版本', 'error'); return; }
        if (!this.isEditable) { App.toast('当前版本已发布，点「基于此版本新建草稿」后再编辑', 'error'); return; }
        try {
          var pd = Ap.saveDraft(this.pdId, { title: this.title, nodes: this.nodes });
          this.nodes = Ap.nodesFromActions(pd);
          this.savedInfo = { version: pd.version, at: (pd.date || '').replace('T', ' ').slice(0, 16), id: pd.id };
          App.toast('草稿已保存（V' + pd.version + '），尚未发布');
          App.bump();
        } catch (e) { App.toast(e.message, 'error'); }
      },
      doValidate: function () {
        this.validateResult = Ap.validate(this.nodes);
        App.toast(this.validateResult.ok ? '流程完整性检查通过' : '检查未通过：' + this.validateResult.errors[0].message,
          this.validateResult.ok ? 'success' : 'error');
      },
      openPublish: function () {
        this.doValidate();
        if (!this.validateResult.ok) return;
        if (!this.savedInfo) { this.saveDraft(); }
        this.showPublish = true;
      },
      publish: function () {
        try {
          var r = Ap.publish(this.pdId, { operator: this.user.display, note: this.publishNote });
          this.showPublish = false;
          this.savedInfo = null;
          this.pick(r.pd.id);
          App.toast('发布成功：版本号 V' + r.version + '，生效时间 ' + r.publishedAt + '，发布人 ' + this.user.display);
          App.bump();
        } catch (e) { App.toast(e.message, 'error'); }
      },
      copyVersion: function () {
        if (!this.pd) return;
        var d = Ap.newDraft({ purpose: this.purpose, level: this.levelField, title: this.pd.ext.title, fromId: this.pd.id });
        this.pick(d.id);
        App.toast('已创建新草稿版本 V' + d.version + '（原发布版本保持不变）');
      },
      goVersions: function () { App.navigate('workflow-versions'); },
      nodeIcon: function (n) {
        return { person: '👤', department: '🏥', role: '🎖️', auto: '🔄' }[n.assigneeType] || '🧩';
      },
      assigneeText: function (n) {
        if (n.assigneeType === 'auto') return '自动匹配开单医师所属科室负责人';
        var list = (n.assignees || []).map(function (c) {
          if (n.assigneeType === 'person') { var p = Ap.practitionerInfo(c); return p ? p.name + '（' + p.dept + '）' : c; }
          if (n.assigneeType === 'department') return Ap.orgName(c);
          return D.approvalRoleName(c);
        });
        return D.assigneeTypeName(n.assigneeType) + '：' + (list.join('、') || '未指定');
      },
      previewNames: function (n) {
        return Ap.resolveAssignees(n, {}).map(function (p) { return p.name; });
      }
    },
    created: function () { this.loadVersions(); },
    template: `
    <div v-if="!canView" class="card"><div class="card-body">
      <empty-state icon="🔒" text="本页面仅对「系统管理员 / 规则管理员」开放。请使用顶部演示身份切换。"></empty-state>
    </div></div>

    <div v-else>
      <div class="alert info" style="display:block">
        <div>采购要求原文：<b>「在流程引擎中可拖选配置新的审核节点，支持按人员/科室/角色进行配置，保存发布之后进行开单操作，在审核中心模块可查看流程中新增节点的展示」</b>。
        本页即该要求的实现；流程定义与版本以 FHIR <b>PlanDefinition</b> 存储，发布后临床开单<b>无需退出或重新登录</b>即使用新版本（BR-007）。</div>
      </div>

      <!-- 顶部：用途/等级 + 版本选择 -->
      <div class="card">
        <div class="card-body">
          <div class="filter-bar">
            <div class="field"><label>流程用途</label>
              <select v-model="purpose" @change="onPurposeChange">
                <option v-for="p in purposes" :value="p.code">{{ p.name }}</option>
              </select>
            </div>
            <div class="field" v-if="levelBound"><label>适用等级</label>
              <select v-model="level" @change="onPurposeChange">
                <option v-for="lv in D.LEVELS" :value="lv.code">{{ lv.name }}</option>
              </select>
            </div>
            <div class="field" style="flex:1"><label>编辑中的版本</label>
              <select v-model="pdId" @change="pick(pdId)">
                <option value="">请选择版本</option>
                <option v-for="v in versionList" :value="v.id">V{{ v.version }} · {{ v.status==='draft'?'草稿':(v.status==='active'?'当前发布':'历史版本') }} · {{ v.ext.title }}</option>
              </select>
            </div>
            <button class="btn" @click="openLatestDraft">打开最新草稿</button>
            <button class="btn" @click="newDraft">+ 新建草稿</button>
            <button class="btn ghost" @click="goVersions">流程版本管理 ›</button>
          </div>
        </div>
      </div>

      <div v-if="!pd" class="card"><div class="card-body">
        <empty-state icon="🧩" text="还没有选择流程版本。点「新建草稿」或「打开最新草稿」开始设计。"></empty-state>
      </div></div>

      <div v-else class="row">
        <!-- ① 节点工具栏 -->
        <div class="col card" style="min-width:250px;max-width:280px">
          <div class="card-head"><h3>🧰 节点工具栏</h3></div>
          <div class="card-body">
            <div class="muted" style="margin-bottom:8px">把下面的审核节点<b>拖拽</b>到右侧画布的缝隙处即可插入（也可用「+」按钮追加）。</div>
            <div v-for="p in palette" :key="p.type"
                 class="chip" draggable="true" @dragstart="onPaletteDragStart($event,p)" @dblclick="appendNode(p)"
                 style="display:flex;align-items:center;gap:6px;padding:9px 10px;margin-bottom:8px;cursor:grab;border:1px solid var(--border);width:100%;justify-content:flex-start">
              <span>{{ p.icon }}</span>
              <span style="flex:1">
                <b>{{ p.name }}</b>
                <div class="muted" style="font-size:11px">{{ p.hint }}</div>
              </span>
              <button class="btn sm ghost" @click="appendNode(p)" title="追加到流程末尾">＋</button>
            </div>
            <div class="divider-label">固定节点</div>
            <div class="kv"><span class="k">开始</span><span>医师提交抗菌药物开单</span>
              <span class="k">结束</span><span>全部节点通过后医嘱可提交临床系统</span></div>
            <div class="alert warn" v-if="isPublished" style="display:block">
              <div>当前版本<b>已发布</b>，画布为只读（FR-011.10）。点「基于此版本新建草稿」再修改。</div>
            </div>
          </div>
        </div>

        <!-- ② 流程画布 -->
        <div class="col card" style="flex:2;min-width:420px">
          <div class="card-head">
            <h3>🗺️ 流程画布</h3>
            <span class="muted">共 {{ approvalNodes.length }} 个审核节点 ·
              <span class="tag" :class="pd.status==='draft'?'gray':(pd.status==='active'?'green':'orange')">
                {{ pd.status==='draft'?'草稿':(pd.status==='active'?'当前发布':'历史版本') }}</span></span>
          </div>
          <div class="card-body">
            <div class="flow-canvas" style="display:flex;flex-direction:column;gap:0">
              <div class="flow-node fixed" style="border:1px dashed #94a3b8;border-radius:8px;padding:8px 12px;background:#f8fbff">
                ▶ <b>开始</b> <span class="muted">医师提交抗菌药物开单（等级 {{ levelBound ? D.levelName(level) : '不限' }}）</span>
              </div>
              <template v-for="(n,i) in nodes" :key="n.key">
                <div class="flow-drop" @dragover.prevent="dragOver=i" @dragleave="dragOver=null" @drop.prevent="onDropOn(i)"
                     :style="{height: dragOver===i?'26px':'10px', background: dragOver===i?'#dbeafe':'transparent', borderRadius:'6px', transition:'all .12s'}"></div>
                <div class="flow-node" draggable="{{ isEditable ? 'true':'false' }}" @dragstart="onNodeDragStart($event,i)"
                     @click="selected=i"
                     :class="{selected: selected===i}"
                     :style="{border:'1px solid '+(selected===i?'#1769c0':'var(--border)'),
                              borderLeft:'5px solid '+(n.isPostReview?'#dc2626':'#1769c0'),
                              borderRadius:'10px',padding:'10px 12px',background: selected===i?'#f2f7ff':'#fff',
                              cursor: isEditable?'grab':'default'}">
                  <div style="display:flex;align-items:center;gap:8px">
                    <span class="tag blue">{{ i+1 }}</span>
                    <span>{{ nodeIcon(n) }}</span>
                    <b>{{ n.name }}</b>
                    <span class="tag gray" v-if="n.isPostReview">补审核节点</span>
                    <span class="muted">{{ n.mode==='and'?'会签':'或签' }} · {{ n.deadlineHours }}h</span>
                    <span style="flex:1"></span>
                    <button class="btn sm ghost" @click.stop="moveNode(i,-1)" :disabled="i===0||!isEditable" title="上移">↑</button>
                    <button class="btn sm ghost" @click.stop="moveNode(i,1)" :disabled="i===nodes.length-1||!isEditable" title="下移">↓</button>
                    <button class="btn sm ghost danger" @click.stop="removeNode(i)" :disabled="!isEditable" title="删除未发布的新增节点">✕</button>
                  </div>
                  <div class="muted" style="margin-top:4px">{{ assigneeText(n) }}</div>
                  <div class="muted" style="font-size:11px" v-if="previewNames(n).length">
                    将分配给：{{ previewNames(n).join('、') }}
                  </div>
                  <div class="muted" style="font-size:11px" v-else-if="n.assigneeType!=='auto'">
                    ⚠️ 当前解析不到审批人，发布会导致无人可处理
                  </div>
                </div>
              </template>
              <div class="flow-drop" @dragover.prevent="dragOver=nodes.length" @dragleave="dragOver=null" @drop.prevent="onDropOn(nodes.length)"
                   :style="{height: dragOver===nodes.length?'26px':'10px', background: dragOver===nodes.length?'#dbeafe':'transparent', borderRadius:'6px'}"></div>
              <div class="flow-node fixed" style="border:1px dashed #94a3b8;border-radius:8px;padding:8px 12px;background:#f6fef9">
                ⏹ <b>结束</b> <span class="muted">全部审核节点通过 → 医嘱状态「可提交临床系统」（仅代表本演示已满足审批条件）</span>
              </div>
            </div>
            <div class="btn-row" style="justify-content:flex-end;margin-top:12px">
              <button class="btn" @click="doValidate">校验流程</button>
              <button class="btn" @click="saveDraft" :disabled="!isEditable">保存草稿</button>
              <button class="btn" @click="copyVersion">基于此版本新建草稿</button>
              <button class="btn primary" @click="openPublish" :disabled="!isEditable">校验并发布</button>
            </div>
            <div class="alert success" v-if="validateResult && validateResult.ok" style="display:block"><div>✓ 流程完整性检查通过（有开始、{{ approvalNodes.length }} 个审核节点与结束节点）。</div></div>
            <div class="alert danger" v-if="validateResult && !validateResult.ok" style="display:block">
              <div><b>✗ 禁止发布：</b></div>
              <ul style="margin:6px 0 0 18px"><li v-for="e in validateResult.errors" :key="e.field">{{ e.message }}</li></ul>
            </div>
            <div class="kv" v-if="savedInfo" style="margin-top:10px">
              <span class="k">草稿已保存</span><span>V{{ savedInfo.version }} · {{ savedInfo.at }} · {{ savedInfo.id }}</span>
            </div>
          </div>
        </div>

        <!-- ③ 节点属性编辑区 + ④ 版本信息区 -->
        <div class="col card" style="min-width:330px;max-width:390px">
          <div class="card-head"><h3>⚙️ 节点属性 / 版本信息</h3></div>
          <div class="card-body">
            <div v-if="!selectedNode"><empty-state icon="👆" text="在画布中点选一个节点后编辑属性"></empty-state></div>
            <template v-else>
              <div class="form-row"><label class="req">节点名称</label>
                <div class="ctrl"><input type="text" v-model="selectedNode.name" :disabled="!isEditable" placeholder="如：药学部门审核"></div></div>
              <div class="form-row"><label class="req">审批对象类型</label>
                <div class="ctrl">
                  <div class="radios" style="flex-direction:column;gap:6px">
                    <label v-for="t in D.ASSIGNEE_TYPES" :key="t.code" style="display:block">
                      <input type="radio" name="atype" :value="t.code" :disabled="!isEditable"
                             :checked="selectedNode.assigneeType===t.code" @change="setAssigneeType(t.code)">
                      {{ t.name }} <span class="muted" style="font-size:11px">{{ t.hint }}</span>
                    </label>
                  </div>
                </div>
              </div>

              <div class="form-row" v-if="selectedNode.assigneeType!=='auto'">
                <label class="req">审批对象（可多选）</label>
                <div class="ctrl">
                  <input v-if="selectedNode.assigneeType==='person'" type="text" v-model="peopleKeyword" placeholder="按姓名/科室检索" style="margin-bottom:6px">
                  <div class="checks" style="flex-direction:column;gap:6px;max-height:190px;overflow:auto;border:1px solid var(--border);border-radius:8px;padding:8px">
                    <label v-for="o in assigneeOptions" :key="o.code" style="display:block"
                           v-show="!peopleKeyword || o.name.indexOf(peopleKeyword)>=0">
                      <input type="checkbox" :checked="isSelected(o.code)" :disabled="!isEditable" @change="toggleAssignee(o.code)"> {{ o.name }}
                    </label>
                    <span class="muted" v-if="!assigneeOptions.length">该类型暂无可选项</span>
                  </div>
                  <div class="muted" style="margin-top:6px" v-if="resolvedAssignees.length">
                    实例到达本节点时将生成待办给：<b>{{ resolvedAssignees.map(function(p){return p.name+'（'+(p.via||'')+'）';}).join('；') }}</b>
                  </div>
                </div>
              </div>

              <div class="form-row"><label>审批方式</label>
                <div class="ctrl"><div class="radios">
                  <label><input type="radio" value="or" v-model="selectedNode.mode" :disabled="!isEditable"> 或签（任一通过）</label>
                  <label><input type="radio" value="and" v-model="selectedNode.mode" :disabled="!isEditable"> 会签（全部通过）</label>
                </div></div></div>
              <div class="form-row"><label class="req">办理时限（小时）</label>
                <div class="ctrl" style="flex-direction:row;align-items:center;gap:6px">
                  <input type="number" min="1" v-model.number="selectedNode.deadlineHours" :disabled="!isEditable" style="width:100px"> 小时</div></div>
              <div class="form-row"><label>超时处理</label>
                <div class="ctrl"><select v-model="selectedNode.onTimeout" :disabled="!isEditable">
                  <option v-for="o in timeoutOptions()" :value="o">{{ o }}</option></select></div></div>
              <div class="form-row"><label>允许的处理动作</label>
                <div class="ctrl"><div class="checks">
                  <label v-for="a in actionDefs" :key="a.code">
                    <input type="checkbox" :checked="(selectedNode.actions||[]).indexOf(a.code)>=0" :disabled="!isEditable"
                           @change="toggleAction(a.code)"> {{ a.name }}
                  </label>
                </div>
                <div class="muted" style="font-size:11px">未勾选的动作，审批界面不会出现对应按钮（FR-022.3）。</div></div></div>
              <div class="form-row"><label>节点说明</label>
                <div class="ctrl"><textarea v-model="selectedNode.description" :disabled="!isEditable" placeholder="选填"></textarea></div></div>
              <div class="form-row"><label>是否为补审核节点</label>
                <div class="ctrl"><label><input type="checkbox" v-model="selectedNode.isPostReview" :disabled="!isEditable">
                  勾选后本节点按「事后补审核」处理（紧急越级使用场景）</label></div></div>
            </template>

            <div class="divider-label">版本信息</div>
            <div class="kv">
              <span class="k">业务键</span><span class="muted">{{ pd.ext.purposeKey }}</span>
              <span class="k">canonical</span><span class="muted" style="word-break:break-all">{{ pd.url }}</span>
              <span class="k">版本号</span><span>V{{ pd.version }}</span>
              <span class="k">状态</span><span>{{ pd.status==='draft'?'草稿':(pd.status==='active'?'已发布（当前有效）':'已停用/被替代') }}</span>
              <span class="k">流程名称</span><span><input type="text" v-model="title" :disabled="!isEditable" style="width:100%"></span>
              <span class="k">发布时间</span><span>{{ pd.ext.publishedAt || '—' }}</span>
              <span class="k">发布人</span><span>{{ pd.ext.publishedBy || '—' }}</span>
              <span class="k">回退来源</span><span>{{ pd.ext.rollbackFrom ? ('由 V'+pd.ext.rollbackFrom.fromVersion+' 恢复') : '—' }}</span>
              <span class="k">当前生效版本</span><span>{{ currentPublished ? 'V'+currentPublished.version : '（尚未发布）' }}</span>
            </div>
          </div>
        </div>
      </div>

      <!-- 发布确认：FR-011.8 发布前显示节点清单与配置摘要 -->
      <ui-modal v-if="showPublish" title="发布流程版本" width="wide" @close="showPublish=false">
        <div class="alert info" style="display:block">
          <div>发布后：本版本立即成为<b>当前有效版本</b>，后续新发起的申请使用它；<b>已发起的审批实例继续执行其绑定的版本</b>（FR-015.5/6、BR-006）。</div>
        </div>
        <div class="divider-label">节点清单</div>
        <div class="table-wrap"><table class="tbl">
          <thead><tr><th>顺序</th><th>节点名称</th><th>审批对象</th><th>方式</th><th>时限</th><th>允许动作</th><th>补审核</th></tr></thead>
          <tbody>
            <tr v-for="(n,i) in approvalNodes" :key="n.key">
              <td>{{ i+1 }}</td><td>{{ n.name }}</td><td>{{ assigneeText(n) }}</td>
              <td>{{ n.mode==='and'?'会签':'或签' }}</td><td class="nowrap">{{ n.deadlineHours }}h</td>
              <td>{{ (n.actions||[]).map(function(c){return (D.NODE_ACTIONS.filter(function(a){return a.code===c;})[0]||{}).name||c;}).join('、') }}</td>
              <td>{{ n.isPostReview?'是':'否' }}</td>
            </tr>
          </tbody>
        </table></div>
        <div class="divider-label">配置摘要</div>
        <div class="kv">
          <span v-for="s in publishSummary" :key="s.label" class="k">{{ s.label }}</span>
          <span v-for="s in publishSummary" :key="'v'+s.label">{{ s.value }}</span>
        </div>
        <div class="form-row"><label>发布说明</label>
          <div class="ctrl"><input type="text" v-model="publishNote" placeholder="如：新增院感专家节点（选填）"></div></div>
        <template #foot>
          <button class="btn" @click="showPublish=false">取消</button>
          <button class="btn primary" @click="publish">确认发布</button>
        </template>
      </ui-modal>
    </div>`
  };
})(window);
