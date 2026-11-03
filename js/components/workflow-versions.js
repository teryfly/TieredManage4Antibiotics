/* =====================================================================
 * workflow-versions.js —— L3-4-3 流程版本管理（SRS FR-018 / FR-019，§6.8）
 * ---------------------------------------------------------------------
 * 以时间顺序列出某「流程用途」的全部 PlanDefinition 版本，支持
 *   ① 查看历史版本的节点结构与节点配置（FR-018.3）
 *   ② 任意两个版本比较新增/删除/顺序/审批对象变化（FR-018.4）
 *   ③ 从历史版本回退恢复为新的当前发布版本（FR-019）
 *   ④ 查看每条审批实例实际绑定的流程版本（FR-018.6 / DEMO-13.5）
 * 数据全部来自 window.Approval（FHIR R4 PlanDefinition + Basic 版本指针），
 * 本页不重写任何业务规则。
 * ===================================================================== */
(function (global) {
  'use strict';
  var AMS = global.AMS, D = global.Domain, App = global.App;
  var Ap = global.Approval, F = global.FHIR;

  var MARKS = ['①', '②', '③', '④', '⑤', '⑥', '⑦', '⑧', '⑨', '⑩'];

  function approvalNodes(pd) {
    var ns = (pd && pd.ext && pd.ext.nodes) || [];
    return ns.filter(function (n) { return n.type !== 'start' && n.type !== 'end'; });
  }
  /* FHIR instant（'YYYY-MM-DDTHH:mm:ss'）→ 展示用本地时间串 */
  function fmtInstant(s) { return (s || '').replace('T', ' ').slice(0, 16); }

  AMS.pages['workflow-versions'] = {
    data: function () {
      return {
        purpose: 'tier-approval',
        level: 'special',
        /* ① 版本结构查看弹框 */
        showView: false, viewPdId: '',
        /* ② 版本比较 */
        cmpA: '', cmpB: '',
        /* ③ 回退恢复 */
        showRollback: false, rbTargetId: '', rbNote: '', rbNoteErr: false, rbResult: null,
        /* ④ 审批实例绑定版本 */
        openTaskId: ''
      };
    },
    computed: {
      D: function () { return D; },
      Ap: function () { return Ap; },
      user: function () { return App.currentUser(); },
      role: function () { return App.state.roleCode; },
      canView: function () { return D.canAccess(this.role, 'workflow-versions'); },

      purposes: function () { return D.FLOW_PURPOSES; },
      levels: function () { return D.LEVELS; },
      purposeDef: function () { return D.flowPurpose(this.purpose) || null; },
      levelBound: function () { return !!(this.purposeDef && this.purposeDef.levelBound); },
      /* 非分级绑定的用途（紧急越级补审核）不参与等级维度 */
      levelField: function () { return this.levelBound ? this.level : ''; },

      /* FR-018.1：按业务版本号顺序列出全部已保存/已发布版本 */
      list: function () {
        App.state.refresh;
        return Ap.versions(this.purpose, this.levelField).slice().sort(function (a, b) {
          return (parseInt(a.version, 10) || 0) - (parseInt(b.version, 10) || 0);
        });
      },
      /* FR-018 顶部状态条 / FR-019.2 回退基准 */
      current: function () {
        App.state.refresh;
        return Ap.currentVersion(this.purpose, this.levelField);
      },
      historyCount: function () {
        return this.list.filter(function (p) { return p.status === 'retired'; }).length;
      },
      activeCount: function () {
        return this.list.filter(function (p) { return p.status === 'active'; }).length;
      },
      draftCount: function () {
        return this.list.filter(function (p) { return p.status === 'draft'; }).length;
      },

      viewPd: function () {
        App.state.refresh;
        var pd = this.viewPdId ? F.read('PlanDefinition', this.viewPdId) : null;
        return (pd && pd.ext) ? pd : null;
      },
      viewNodes: function () { return this.viewPd ? Ap.nodesFromActions(this.viewPd) : []; },

      cmp: function () {
        App.state.refresh;
        if (!this.cmpA || !this.cmpB || this.cmpA === this.cmpB) return null;
        var a = F.read('PlanDefinition', this.cmpA), b = F.read('PlanDefinition', this.cmpB);
        if (!a || !b || !a.ext || !b.ext) return null;
        return Ap.compare(this.cmpA, this.cmpB);
      },

      rbTarget: function () {
        App.state.refresh;
        return this.rbTargetId ? F.read('PlanDefinition', this.rbTargetId) : null;
      },
      /* FR-019.2：回退前必须先看到「当前版本 vs 目标版本」差异 */
      rbDiff: function () {
        if (!this.rbTarget || !this.current) return null;
        return Ap.compare(this.current.id, this.rbTarget.id);
      },

      /* FR-018.6 / DEMO-13.5：本用途下已产生的审批实例 */
      instances: function () {
        App.state.refresh;
        return Ap.mainTasks({ purpose: this.purpose });
      },
      instanceView: function () {
        App.state.refresh;
        return this.openTaskId ? Ap.flowView(this.openTaskId) : null;
      }
    },
    methods: {
      /* ---------------- 展示辅助 ---------------- */
      mark: function (seq) { return MARKS[(Number(seq) || 1) - 1] || ('(' + seq + ')'); },
      fmt: function (s) { return fmtInstant(s) || '—'; },
      titleOf: function (pd) { return (pd.ext && pd.ext.title) || pd.title || '（未命名流程）'; },
      publishedAtOf: function (pd) { return (pd.ext && pd.ext.publishedAt) || '未发布'; },
      publishedByOf: function (pd) { return (pd.ext && pd.ext.publishedBy) || '—'; },
      nodeCount: function (pd) { return approvalNodes(pd).length; },
      actionCount: function (pd) { return ((pd && pd.action) || []).length; },
      statusOf: function (pd) {
        if (pd.status === 'draft') return { t: '草稿', c: 'gray' };
        if (pd.status === 'active') return { t: '当前发布', c: 'green' };
        return { t: '已停用/被替代', c: 'orange' };
      },
      replacedByLabel: function (pd) {
        var rid = (pd.ext && pd.ext.replacedBy) || pd.replacedBy;
        if (!rid) return '';
        var r = F.read('PlanDefinition', rid);
        return r ? '已被 V' + r.version + ' 替代' : '已被后续版本替代';
      },
      /* FR-019.5：由回退产生的版本要标明来源版本 */
      rollbackLabel: function (pd) {
        var rf = pd.ext && pd.ext.rollbackFrom;
        return rf ? '由 V' + rf.fromVersion + ' 回退恢复' : '';
      },
      rollbackNote: function (pd) {
        var rf = pd.ext && pd.ext.rollbackFrom;
        return (rf && rf.note) || '';
      },
      typeName: function (t) { return D.assigneeTypeName(t); },
      actionNames: function (node) {
        var acts = node.actions || [];
        if (!acts.length) return '—';
        return acts.map(function (c) {
          var hit = D.NODE_ACTIONS.filter(function (a) { return a.code === c; })[0];
          return hit ? hit.name : c;
        }).join('、');
      },
      /* 节点上「配置的对象」原文：人员 / 科室 / 角色（科室名从 Organization 资源取） */
      assigneeConfig: function (node) {
        var ids = node.assignees || [];
        if (node.assigneeType === 'auto' || !ids.length) {
          return node.assigneeType === 'auto'
            ? '自动匹配开单医师所属科室负责人' : '（未配置对象）';
        }
        if (node.assigneeType === 'person') {
          return ids.map(function (id) {
            var p = Ap.practitionerInfo(id); return p ? p.name : id;
          }).join('、');
        }
        if (node.assigneeType === 'department') {
          return ids.map(function (id) {
            var o = F.read('Organization', id); return o ? o.name : id;
          }).join('、');
        }
        return ids.map(function (c) { return D.approvalRoleName(c); }).join('、');
      },
      /* 该配置在演示数据里实际解析到的审批人（BR-008 同一解析口径） */
      resolvedPeople: function (node) {
        var who = Ap.resolveAssignees(node, {});
        if (!who.length) return '当前解析不到在岗人员';
        return who.map(function (p) {
          return p.name + (p.dept ? '（' + p.dept + '）' : '');
        }).join('、');
      },
      seqChain: function (nodes) {
        if (!nodes || !nodes.length) return '（无审核节点）';
        return nodes.map(function (n) { return this.mark(n.seq) + ' ' + n.name; }, this).join(' → ');
      },

      /* ---------------- ① 查看版本 ---------------- */
      openView: function (pd) { this.viewPdId = pd.id; this.showView = true; },

      /* ---------------- ② 版本比较 ---------------- */
      pickDefaultCompare: function () {
        var cur = this.current;
        var pool = this.list;
        if (!pool.length) { App.toast('该用途还没有任何版本（含草稿），无法比较', 'error'); return; }
        /* 优先用「已发布版本」组对比；只有 1 个已发布版本时，退回用草稿参与比较 */
        var published = pool.filter(function (p) { return p.status !== 'draft'; });
        var base = cur || published[0] || pool[0];
        var others = published.filter(function (p) { return p.id !== base.id; });
        if (!others.length) others = pool.filter(function (p) { return p.id !== base.id; });
        if (!others.length) { App.toast('该用途只有一个版本，暂无可比较对象', 'error'); return; }
        this.cmpA = others[0].id;
        this.cmpB = base.id;
      },
      doCompare: function () {
        if (!this.cmpA || !this.cmpB) { App.toast('请先选择要比较的两个版本', 'error'); return; }
        if (this.cmpA === this.cmpB) { App.toast('请选择两个不同的版本', 'error'); return; }
        var c = this.cmp;
        if (!c) { App.toast('版本读取失败，请重新选择要比较的两个版本', 'error'); return; }
        App.toast('已比较 V' + (c.a.version) + ' 与 V' + (c.b.version)
          + '：新增 ' + c.added.length + '、删除 ' + c.removed.length
          + '、顺序变化 ' + c.moved.length + '、配置变化 ' + c.changed.length, 'info');
      },

      /* ---------------- ③ 回退恢复 ---------------- */
      canRollback: function (pd) { return pd.status === 'retired'; },
      openRollback: function (pd) {
        if (!this.canRollback(pd)) { App.toast('只有已停用（历史发布）的版本才能回退恢复；草稿未发布过，不构成历史版本', 'error'); return; }
        this.rbTargetId = pd.id; this.rbNote = ''; this.rbNoteErr = false;
        this.showRollback = true;
      },
      doRollback: function () {
        var note = (this.rbNote || '').trim();
        if (!note) {
          this.rbNoteErr = true;
          App.toast('回退说明为必填项（FR-019.8 须留痕）', 'error');
          return;
        }
        if (!confirm('确认把 ' + (this.rbTarget ? this.titleOf(this.rbTarget) : '') + ' V'
          + (this.rbTarget ? this.rbTarget.version : '') + ' 恢复为新的当前发布版本？\n'
          + '当前发布版本将被标记为「已停用/被替代」，但不会被删除。')) return;
        try {
          var r = Ap.rollback(this.rbTargetId, { operator: this.user.display, note: note });
          this.rbResult = r;
          this.showRollback = false;
          this.rbTargetId = ''; this.rbNote = ''; this.rbNoteErr = false;
          App.toast('回退恢复完成，当前发布版本已更新为 V' + r.version);
        } catch (e) {
          App.toast('回退失败：' + e.message, 'error');
        }
      },
      closeResult: function () { this.rbResult = null; },

      /* ---------------- ④ 实例绑定版本 ---------------- */
      toggleInstance: function (m) { this.openTaskId = this.openTaskId === m.id ? '' : m.id; },
      flowStatusName: function (code) { return D.flowStatusName(code); },
      levelName: function (code) { return D.levelName(code); },
      goDesigner: function () {
        if (!D.canAccess(this.role, 'workflow-designer')) {
          App.toast('当前身份（' + D.roleName(this.role) + '）没有流程设计权限，请切换为系统管理员或规则管理员', 'error');
          return;
        }
        App.navigate('workflow-designer');
      },
      goCenter: function () {
        if (!D.canAccess(this.role, 'approval-center')) {
          App.toast('当前身份没有审批中心权限', 'error');
          return;
        }
        App.navigate('approval-center');
      }
    },
    template: `
    <div v-if="!canView" class="card"><div class="card-body">
      <empty-state icon="🔒" text="本页面仅对「系统管理员 / 规则管理员 / 流程审阅人员」角色开放。请使用顶部演示身份切换。"></empty-state>
    </div></div>

    <div v-else>
      <div class="alert info" style="display:block">
        <div>采购要求原文：<b>「查看流程历史版本」「支持将审批流程回退恢复到历史版本」</b>（SRS FR-018 / FR-019）。
        流程版本以 FHIR R4 <b>PlanDefinition</b> 存储，当前发布指针为 <b>Basic/Basic-workflow-current-*</b>；
        回退恢复<b>不删除任何中间版本、不改写历史审批实例</b>，而是把目标版本内容发布为一个新的当前版本。</div>
      </div>

      <!-- FR-019.5 / FR-019.8 回退结果 -->
      <div v-if="rbResult" class="alert success mt12" style="display:block">
        <div>
          <b>✅ 回退恢复已完成</b>
          <div class="kv mt8">
            <span class="k">新产生的发布版本</span><span><b>V{{ rbResult.version }}</b>（{{ rbResult.pd.id }}，状态：当前发布）</span>
            <span class="k">来源版本</span><span>V{{ rbResult.fromVersion }}（{{ rbResult.fromId }}）</span>
            <span class="k">操作人</span><span>{{ rbResult.operator }}</span>
            <span class="k">操作时间</span><span>{{ rbResult.at }}</span>
            <span class="k">回退说明</span><span>{{ (rbResult.pd.ext && rbResult.pd.ext.rollbackFrom && rbResult.pd.ext.rollbackFrom.note) || '—' }}</span>
            <span class="k">被替代的版本</span><span>{{ rbResult.retiredId ? rbResult.retiredId + '（仅标记为已停用，资源未删除）' : '无（此前没有发布版本）' }}</span>
          </div>
          <div class="mt8">中间历史版本未被删除；已运行中的审批实例仍按其原绑定版本执行（FR-019.4 / FR-019.7）。
            本次回退已写入 AuditEvent / Provenance 留痕。</div>
          <div class="btn-row mt8"><button class="btn sm" @click="closeResult">知道了</button></div>
        </div>
      </div>

      <!-- 用途 / 等级筛选 + 当前生效版本状态条 -->
      <div class="card mt12">
        <div class="card-head">
          <h3>🗂️ 流程版本管理</h3>
          <div class="btn-row">
            <button class="btn sm ghost" @click="goDesigner">前往审批流程设计 ›</button>
          </div>
        </div>
        <div class="card-body">
          <div class="filter-bar">
            <div class="field"><label>流程用途</label>
              <select v-model="purpose" @change="cmpA=''; cmpB=''; openTaskId=''">
                <option v-for="p in purposes" :value="p.code">{{ p.name }}</option>
              </select>
            </div>
            <div class="field" v-if="levelBound"><label>适用药品等级</label>
              <select v-model="level" @change="cmpA=''; cmpB=''; openTaskId=''">
                <option v-for="lv in levels" :value="lv.code">{{ lv.name }}</option>
              </select>
            </div>
            <div class="field" v-else><label>适用药品等级</label>
              <div class="hint" style="padding-top:8px">该用途不按药品分级绑定流程</div>
            </div>
          </div>

          <div v-if="current" class="info-bar mt12">
            <span>当前生效版本 <b>V{{ current.version }}</b></span>
            <span class="sep">|</span><span>{{ titleOf(current) }}</span>
            <span class="sep">|</span><span>审核节点 {{ nodeCount(current) }} 个</span>
            <span class="sep">|</span><span>发布 {{ publishedAtOf(current) }}</span>
            <span class="sep">|</span><span>发布人 {{ publishedByOf(current) }}</span>
          </div>
          <div v-else class="alert warn mt12"><span>⚠️</span>
            <div>该用途（{{ D.flowPurposeName(purpose) }}{{ levelBound ? ' · ' + D.levelName(level) : '' }}）
            当前<b>没有已发布的流程版本</b>，新申请无法进入审批。请到「审批流程设计」页新建草稿并发布。</div>
          </div>
          <div class="muted mt8" style="font-size:12px">
            发布或回退后，后续新申请立即使用新版本，无需退出或重新登录（BR-007）。
            本页共 {{ list.length }} 个版本：当前发布 {{ activeCount }} 个 / 历史版本 {{ historyCount }} 个 / 草稿 {{ draftCount }} 个。
          </div>
        </div>
      </div>

      <!-- FR-018.1 / .2 版本列表（按业务版本号顺序） -->
      <div class="card">
        <div class="card-head"><h3>📜 版本列表（按业务版本号顺序）</h3></div>
        <div class="card-body" style="padding:0">
          <div class="table-wrap">
            <table class="tbl" v-if="list.length">
              <thead><tr>
                <th>版本号</th><th>状态</th><th>流程标题</th><th>节点数</th>
                <th>创建时间</th><th>发布时间</th><th>发布人</th><th>操作</th>
              </tr></thead>
              <tbody>
                <tr v-for="pd in list" :key="pd.id">
                  <td class="nowrap"><b>V{{ pd.version }}</b>
                    <div v-if="rollbackLabel(pd)" class="muted" style="font-size:11px">↩ {{ rollbackLabel(pd) }}</div>
                  </td>
                  <td class="nowrap"><span class="tag" :class="statusOf(pd).c">{{ statusOf(pd).t }}</span>
                    <div v-if="replacedByLabel(pd)" class="muted" style="font-size:11px">{{ replacedByLabel(pd) }}</div>
                  </td>
                  <td>{{ titleOf(pd) }}
                    <div class="muted" style="font-size:11px">{{ pd.id }}</div>
                  </td>
                  <td class="text-c">{{ nodeCount(pd) }}</td>
                  <td class="nowrap">{{ fmt(pd.date) }}</td>
                  <td class="nowrap">{{ publishedAtOf(pd) }}</td>
                  <td class="nowrap">{{ publishedByOf(pd) }}</td>
                  <td class="actions">
                    <a class="btn-link" @click="openView(pd)">查看版本</a>
                    <a v-if="canRollback(pd)" class="btn-link" @click="openRollback(pd)">回退恢复</a>
                    <span v-else class="muted nowrap" style="font-size:12px" title="回退恢复只对已停用（历史发布）版本开放">回退恢复不可用</span>
                  </td>
                </tr>
              </tbody>
            </table>
            <empty-state v-else icon="📭" text="该用途还没有任何流程版本（含草稿）。请先到「审批流程设计」页新建并发布。"></empty-state>
          </div>
        </div>
        <div class="card-body" v-if="list.length" style="padding-top:0">
          <div class="muted" style="font-size:12px">
            「回退恢复」只对<b>已停用（历史发布）</b>版本开放：草稿从未生效，不构成历史版本；
            当前发布版本本身就是生效版本，无需回退。<br>
            关于 SRS FR-018.2 的「创建人」：草稿阶段只在 PlanDefinition.publisher 记录责任方，未单独记录创建人；
            发布时把发布人写入 <span class="nowrap">pd.ext.publishedBy</span> 与当前版本指针 Basic 资源，界面按此如实展示。
          </div>
        </div>
      </div>

      <!-- FR-018.4 版本比较 -->
      <div class="card">
        <div class="card-head">
          <h3>🆚 版本比较</h3>
          <button class="btn sm" @click="pickDefaultCompare">用「另一版本 vs 当前生效版本」填充</button>
        </div>
        <div class="card-body">
          <div class="filter-bar">
            <div class="field" style="min-width:240px"><label>版本 A（基准）</label>
              <select v-model="cmpA">
                <option value="">请选择版本 A</option>
                <option v-for="pd in list" :value="pd.id">V{{ pd.version }} · {{ statusOf(pd).t }} · {{ titleOf(pd) }}</option>
              </select>
            </div>
            <div class="field" style="min-width:240px"><label>版本 B（对比）</label>
              <select v-model="cmpB">
                <option value="">请选择版本 B</option>
                <option v-for="pd in list" :value="pd.id">V{{ pd.version }} · {{ statusOf(pd).t }} · {{ titleOf(pd) }}</option>
              </select>
            </div>
            <button class="btn primary" @click="doCompare">开始比较</button>
          </div>

          <div v-if="!cmp" class="muted mt12" style="font-size:12px">
            选择同一用途下的两个版本后点「开始比较」，可看到节点的新增、删除、顺序变化与配置变化（FR-018.4）。
          </div>

          <div v-else>
            <div class="grid-2 mt16">
              <div>
                <div class="divider-label">版本 A：V{{ cmp.a.version }}（{{ statusOf(cmp.a).t }}）</div>
                <div class="kv">
                  <span class="k">标题</span><span>{{ titleOf(cmp.a) }}</span>
                  <span class="k">节点数</span><span>{{ cmp.aNodes.length }} 个</span>
                  <span class="k">发布时间</span><span>{{ publishedAtOf(cmp.a) }}</span>
                </div>
                <div class="steps mt8">
                  <div class="step" v-for="n in cmp.aNodes" :key="'a'+n.key">
                    <div class="dot">{{ mark(n.seq) }}</div><div class="bar"></div>
                    <div class="s-name">{{ n.name }}</div>
                    <div class="s-meta">{{ typeName(n.assigneeType) }}</div>
                  </div>
                </div>
                <div class="muted mt8" style="font-size:12px">{{ seqChain(cmp.aNodes) }}</div>
              </div>
              <div>
                <div class="divider-label">版本 B：V{{ cmp.b.version }}（{{ statusOf(cmp.b).t }}）</div>
                <div class="kv">
                  <span class="k">标题</span><span>{{ titleOf(cmp.b) }}</span>
                  <span class="k">节点数</span><span>{{ cmp.bNodes.length }} 个</span>
                  <span class="k">发布时间</span><span>{{ publishedAtOf(cmp.b) }}</span>
                </div>
                <div class="steps mt8">
                  <div class="step" v-for="n in cmp.bNodes" :key="'b'+n.key">
                    <div class="dot">{{ mark(n.seq) }}</div><div class="bar"></div>
                    <div class="s-name">{{ n.name }}</div>
                    <div class="s-meta">{{ typeName(n.assigneeType) }}</div>
                  </div>
                </div>
                <div class="muted mt8" style="font-size:12px">{{ seqChain(cmp.bNodes) }}</div>
              </div>
            </div>

            <div class="divider-label">差异明细（以 A 为基准看 B）</div>
            <div class="stat-grid cols-4">
              <div class="stat-card"><div class="label">新增节点</div><div class="value">{{ cmp.added.length }}<small>个</small></div></div>
              <div class="stat-card"><div class="label">删除节点</div><div class="value">{{ cmp.removed.length }}<small>个</small></div></div>
              <div class="stat-card"><div class="label">顺序变化</div><div class="value">{{ cmp.moved.length }}<small>处</small></div></div>
              <div class="stat-card"><div class="label">配置变化</div><div class="value">{{ cmp.changed.length }}<small>处</small></div></div>
            </div>

            <div class="table-wrap mt12">
              <table class="tbl">
                <thead><tr><th>差异类型</th><th>节点</th><th>说明</th></tr></thead>
                <tbody>
                  <tr v-for="n in cmp.added" :key="'ad'+n.key">
                    <td><span class="tag green">新增</span></td>
                    <td class="nowrap">{{ mark(n.seq) }} {{ n.name }}</td>
                    <td>{{ typeName(n.assigneeType) }}：{{ assigneeConfig(n) }} · 时限 {{ n.deadlineHours || 24 }} 小时 · 动作 {{ actionNames(n) }}</td>
                  </tr>
                  <tr v-for="n in cmp.removed" :key="'rm'+n.key">
                    <td><span class="tag red">删除</span></td>
                    <td class="nowrap">{{ mark(n.seq) }} {{ n.name }}</td>
                    <td>B 版本中已不存在该节点（{{ typeName(n.assigneeType) }}：{{ assigneeConfig(n) }}）</td>
                  </tr>
                  <tr v-for="m in cmp.moved" :key="'mv'+m.node.key">
                    <td><span class="tag orange">顺序</span></td>
                    <td class="nowrap">{{ mark(m.node.seq) }} {{ m.node.name }}</td>
                    <td>由第 {{ m.from }} 位调整为第 {{ m.to }} 位</td>
                  </tr>
                  <tr v-for="c in cmp.changed" :key="'ch'+c.node.key">
                    <td><span class="tag blue">配置</span></td>
                    <td class="nowrap">{{ mark(c.node.seq) }} {{ c.node.name }}</td>
                    <td>变化项：{{ c.fields.join('、') }}
                      <span class="muted">（A：{{ typeName(c.from.assigneeType) }} {{ assigneeConfig(c.from) }} / {{ c.from.deadlineHours || 24 }}h
                      → B：{{ typeName(c.node.assigneeType) }} {{ assigneeConfig(c.node) }} / {{ c.node.deadlineHours || 24 }}h）</span>
                    </td>
                  </tr>
                  <tr v-if="!cmp.added.length && !cmp.removed.length && !cmp.moved.length && !cmp.changed.length">
                    <td colspan="3" class="text-c muted">两个版本的节点结构与配置完全一致（无新增、删除、顺序与审批对象差异）</td>
                  </tr>
                </tbody>
              </table>
            </div>
          </div>
        </div>
      </div>

      <!-- FR-018.6 / DEMO-13.5 审批实例绑定的版本 -->
      <div class="card">
        <div class="card-head">
          <h3>🔗 审批实例绑定的版本</h3>
          <span class="muted" style="font-size:12px">用途：{{ D.flowPurposeName(purpose) }}（共 {{ instances.length }} 条实例）</span>
        </div>
        <div class="card-body" style="padding:0">
          <div class="table-wrap">
            <table class="tbl" v-if="instances.length">
              <thead><tr><th>申请编号</th><th>患者</th><th>药品</th><th>等级</th><th>绑定版本</th><th>流程状态</th><th>操作</th></tr></thead>
              <tbody>
                <tr v-for="m in instances" :key="m.id">
                  <td class="nowrap">{{ m.ext.sqno }}</td>
                  <td>{{ m.ext.patientName }}<span class="muted" style="font-size:11px"> / {{ m.ext.mrn }}</span></td>
                  <td>{{ m.ext.drug }}</td>
                  <td><level-tag :level="m.ext.level"></level-tag></td>
                  <td class="nowrap"><b>V{{ m.ext.version }}</b>
                    <div class="muted" style="font-size:11px">{{ m.ext.pdId }}</div>
                  </td>
                  <td class="nowrap"><span class="tag" :class="D.flowStatus(m.ext.flowStatus).tone">{{ flowStatusName(m.ext.flowStatus) }}</span></td>
                  <td class="actions"><a class="btn-link" @click="toggleInstance(m)">{{ openTaskId === m.id ? '收起' : '查看绑定详情' }}</a></td>
                </tr>
              </tbody>
            </table>
            <empty-state v-else icon="📭" text="该用途下还没有审批实例（医生开单触发审批后即产生）。"></empty-state>
          </div>
        </div>
        <div class="card-body" v-if="instanceView">
          <div class="divider-label">{{ instanceView.sqno }} · {{ instanceView.purposeName }}</div>
          <div class="kv">
            <span class="k">绑定版本标识</span><span><b>{{ instanceView.versionLabel }}</b>（实例创建时写入 Task.instantiatesCanonical，此后不随版本发布而变化）</span>
            <span class="k">流程定义 URL</span><span>{{ instanceView.pdUrl || '—' }}</span>
            <span class="k">流程定义资源</span><span>{{ instanceView.pdId }} · {{ instanceView.pdTitle || '—' }}</span>
            <span class="k">该版本当前是否仍是发布态</span>
            <span>
              <span class="tag" :class="instanceView.boundVersionStillActive ? 'green' : 'orange'">
                {{ instanceView.boundVersionStillActive ? '是：仍为当前发布版本' : '否：已被新版本替代（本实例仍按原绑定版本继续执行）' }}
              </span>
            </span>
            <span class="k">实例节点数</span><span>{{ instanceView.nodes.length }} 个（当前节点序号 {{ instanceView.currentSeq || '—' }}，状态 {{ instanceView.flowStatusName }}）</span>
          </div>
          <div class="steps mt12">
            <div class="step" v-for="n in instanceView.nodes" :key="n.nodeTaskId"
                 :class="n.state==='passed' ? 'approved' : (n.state==='doing' ? 'current' : (n.state==='rejected' ? 'rejected' : ''))">
              <div class="dot">{{ mark(n.seq) }}</div><div class="bar"></div>
              <div class="s-name">{{ n.name }}</div>
              <div class="s-meta">{{ n.stateName }}<span v-if="n.actedBy"> · {{ n.actedBy }}</span></div>
            </div>
          </div>
          <div class="btn-row mt12">
            <button class="btn sm" @click="goCenter">在审批中心查看完整流程</button>
            <button class="btn sm ghost" @click="openTaskId=''">收起</button>
          </div>
        </div>
      </div>

      <!-- FR-018.3 版本结构查看弹框 -->
      <ui-modal v-if="showView && viewPd" :title="'版本结构 - V'+viewPd.version+' · '+titleOf(viewPd)" width="wide" @close="showView=false">
        <div class="kv">
          <span class="k">流程用途</span><span>{{ D.flowPurposeName(viewPd.ext.purpose) }}{{ viewPd.ext.level ? '（' + D.levelName(viewPd.ext.level) + '）' : '' }}</span>
          <span class="k">状态</span><span class="tag" :class="statusOf(viewPd).c">{{ statusOf(viewPd).t }}</span>
          <span class="k">创建时间</span><span>{{ fmt(viewPd.date) }}</span>
          <span class="k">发布时间 / 发布人</span><span>{{ publishedAtOf(viewPd) }} / {{ publishedByOf(viewPd) }}</span>
          <span class="k">回退来源</span><span>{{ rollbackLabel(viewPd) ? rollbackLabel(viewPd) + (rollbackNote(viewPd) ? '：' + rollbackNote(viewPd) : '') : '非回退产生的版本' }}</span>
          <span class="k">生效范围</span><span>{{ viewPd.ext.scopeDrug || '该分级全部药品' }} · {{ viewPd.ext.scopeDept || '全院' }}</span>
          <span class="k">资源责任方</span><span>{{ viewPd.publisher || '—' }}（PlanDefinition.publisher；发布人取 ext.publishedBy）</span>
          <span class="k">FHIR 可追溯性</span>
          <span>PlanDefinition.action 标准投影 <b>{{ actionCount(viewPd) }}</b> 条，审核节点 <b>{{ nodeCount(viewPd) }}</b> 个
            <span class="tag" :class="actionCount(viewPd) === nodeCount(viewPd) ? 'green' : 'orange'">
              {{ actionCount(viewPd) === nodeCount(viewPd) ? '数量一致：每个节点都有对应 action 条目' : '数量不一致，请到流程设计页重新保存草稿后发布' }}
            </span>
          </span>
        </div>

        <div class="divider-label">节点结构（共 {{ viewNodes.length }} 个节点）</div>
        <div class="steps mb12">
          <div class="step" v-for="n in viewNodes" :key="'v'+n.key">
            <div class="dot">{{ mark(n.seq) }}</div><div class="bar"></div>
            <div class="s-name">{{ n.name }}</div>
            <div class="s-meta">{{ typeName(n.assigneeType) }} · {{ n.deadlineHours || 24 }}h</div>
          </div>
        </div>
        <div class="table-wrap">
          <table class="tbl">
            <thead><tr><th>顺序</th><th>节点名称</th><th>审批对象</th><th>办理时限</th><th>允许动作</th><th>补审核</th></tr></thead>
            <tbody>
              <tr v-for="n in viewNodes" :key="'vn'+n.key">
                <td class="text-c">{{ mark(n.seq) }}</td>
                <td><b>{{ n.name }}</b><div class="muted" style="font-size:11px">{{ n.description || '（无节点说明）' }}</div></td>
                <td>{{ typeName(n.assigneeType) }}：{{ assigneeConfig(n) }}
                  <div class="muted" style="font-size:11px">解析到的在岗人员：{{ resolvedPeople(n) }}</div>
                </td>
                <td class="nowrap">{{ n.deadlineHours || 24 }} 小时</td>
                <td class="nowrap">{{ actionNames(n) }}</td>
                <td class="nowrap"><span v-if="n.isPostReview" class="tag red">补审核节点</span><span v-else class="muted">否</span></td>
              </tr>
            </tbody>
          </table>
        </div>
        <div class="muted mt8" style="font-size:12px">
          历史版本的节点内容不可编辑（SRS FR-011.10）；如需调整，请基于该版本新建草稿后发布新版本。
        </div>
        <template #foot>
          <button class="btn" @click="showView=false">关闭</button>
          <button class="btn" v-if="canRollback(viewPd)" @click="showView=false; openRollback(viewPd)">回退恢复到该版本</button>
        </template>
      </ui-modal>

      <!-- FR-019.2 / .3 回退恢复确认 -->
      <ui-modal v-if="showRollback && rbTarget" :title="'回退恢复 - 目标版本 V'+rbTarget.version" width="wide" @close="showRollback=false">
        <div class="alert warn"><span>⚠️</span>
          <div>回退恢复会把目标版本内容复制为<b>一个新的当前发布版本</b>（FR-019.3）；
            目标版本与中间历史版本都<b>不会被删除</b>，已运行中的审批实例<b>仍按其原绑定版本执行</b>（FR-019.4 / FR-019.7）。</div>
        </div>

        <div class="divider-label">回退前差异（当前版本 vs 目标版本）</div>
        <div v-if="!current" class="muted" style="font-size:12px">
          该用途当前没有已发布版本，回退后将直接把 V{{ rbTarget.version }} 的内容发布为新的当前版本。
        </div>
        <div v-else-if="rbDiff" class="table-wrap">
          <div class="kv mb8">
            <span class="k">当前发布版本</span><span>V{{ current.version }} · {{ titleOf(current) }} · {{ rbDiff.aNodes.length }} 个节点</span>
            <span class="k">目标历史版本</span><span>V{{ rbTarget.version }} · {{ titleOf(rbTarget) }} · {{ rbDiff.bNodes.length }} 个节点</span>
            <span class="k">节点序列</span><span>{{ seqChain(rbDiff.aNodes) }}</span>
            <span class="k">恢复后序列</span><span>{{ seqChain(rbDiff.bNodes) }}</span>
          </div>
          <table class="tbl">
            <thead><tr><th>差异类型</th><th>数量</th><th>明细</th></tr></thead>
            <tbody>
              <tr><td><span class="tag green">目标版本独有</span></td><td class="text-c">{{ rbDiff.added.length }}</td>
                  <td>{{ rbDiff.added.map(function (n) { return mark(n.seq) + ' ' + n.name; }).join(' → ') || '无' }}</td></tr>
              <tr><td><span class="tag red">当前版本独有</span></td><td class="text-c">{{ rbDiff.removed.length }}</td>
                  <td>{{ rbDiff.removed.map(function (n) { return mark(n.seq) + ' ' + n.name; }).join(' → ') || '无' }}</td></tr>
              <tr><td><span class="tag orange">顺序变化</span></td><td class="text-c">{{ rbDiff.moved.length }}</td>
                  <td><span v-for="m in rbDiff.moved" :key="m.node.key" class="nowrap">{{ m.node.name }} 第{{ m.from }}位→第{{ m.to }}位；</span>
                      <span v-if="!rbDiff.moved.length">无</span></td></tr>
              <tr><td><span class="tag blue">配置变化</span></td><td class="text-c">{{ rbDiff.changed.length }}</td>
                  <td><span v-for="c in rbDiff.changed" :key="c.node.key" class="nowrap">{{ c.node.name }}（{{ c.fields.join('、') }}）；</span>
                      <span v-if="!rbDiff.changed.length">无</span></td></tr>
            </tbody>
          </table>
          <div class="muted mt8" style="font-size:12px">
            说明：表中「当前版本独有」的节点在恢复后的新流程里不再出现（仅影响<b>之后新发起</b>的申请）。
          </div>
        </div>
        <div v-else class="muted" style="font-size:12px">无法取得差异数据（当前版本或目标版本读取失败），请刷新后重试。</div>

        <div class="divider-label">回退说明（必填，将写入 AuditEvent 留痕）</div>
        <div class="form-row">
          <label class="req">回退说明</label>
          <div class="ctrl">
            <textarea v-model="rbNote" :class="{invalid: rbNoteErr}" placeholder="例如：V3 新增的感染科会诊节点临床反馈过于冗长，先恢复 V2 的三节点流程"></textarea>
            <span class="err-text" v-if="rbNoteErr">请填写回退说明（FR-019.8 要求记录回退说明）</span>
            <span class="hint">操作人取当前演示身份：{{ user.display }}；新版本号 = 该用途最大版本号 + 1</span>
          </div>
        </div>

        <template #foot>
          <button class="btn" @click="showRollback=false">取消</button>
          <button class="btn primary" @click="doRollback">确认回退恢复</button>
        </template>
      </ui-modal>
    </div>`
  };
})(window);
