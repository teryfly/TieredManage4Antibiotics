/* =====================================================================
 * perm-mapping.js —— L3-2-2 权限映射配置
 * 配置药品分级与医师处方权限的默认映射关系；提供权限预览与冲突检测。
 * 系统管理员可编辑映射规则与导出；药学部门仅可查看。
 * ===================================================================== */
(function (global) {
  'use strict';
  var AMS = global.AMS, Svc = global.Svc, D = global.Domain, App = global.App;

  var APPROVAL_NAME = { dept: '科室负责人', pharmacy: '药学部门', expert: '审批专家' };
  var APPROVAL_LABEL = { dept: '需科室负责人审批', pharmacy: '需药学部门审批', expert: '需审批专家审批' };
  var APPROVAL_ORDER = ['dept', 'pharmacy', 'expert'];

  AMS.pages['perm-mapping'] = {
    data: function () {
      return {
        previewTitle: 'attending',
        // 编辑弹框
        showEdit: false,
        edit: null, // { level, levelName, titles:[], approvals:[], origTitles:[] }
        // 冲突检测弹框
        showConflict: false,
        conflict: null, // { hard:[], warn:[], choice:'' }
        // 药品明细弹框
        showDetail: false,
        detailPage: 1,
        detailSize: 8
      };
    },
    created: function () { this.D = D; },
    computed: {
      // 模板里裸用 D.xxx() 取不到值（Vue 只在实例上查找），显式暴露领域常量
      D: function () { return D; },
      isAdmin: function () { return App.state.roleCode === 'admin'; },
      rules: function () { App.state.refresh; return Svc.mappingRules(); },
      titleOptions: function () { return D.TITLES; },
      titleMatrix: function () { App.state.refresh; return Svc.titleMatrix(); },
      previewTitleName: function () { return D.titleName(this.previewTitle); },
      approvableLevelText: function () {
        var names = this.previewLevels.filter(function (l) { return l.ok; }).map(function (l) { return l.name; });
        return names.length ? names.join('、') : '无';
      },
      // 当前预览职称的分级可开具情况
      previewLevels: function () {
        App.state.refresh;
        var row = this.titleMatrix.filter(function (r) { return r.title === this.previewTitle; }.bind(this))[0];
        return D.LEVELS.map(function (lv) {
          return { code: lv.code, name: lv.name, ok: row ? !!row[lv.code] : false };
        });
      },
      previewDrugs: function () {
        App.state.refresh;
        return Svc.previewDrugsForTitle(this.previewTitle);
      },
      // 去重后的药品分类（含分级），用于预览列表
      previewClasses: function () {
        var seen = {}, list = [];
        this.previewDrugs.forEach(function (m) {
          var key = m.ext.drugClass + '|' + m.ext.level;
          if (!seen[key]) { seen[key] = true; list.push({ drugClass: m.ext.drugClass, level: m.ext.level }); }
        });
        return list;
      },
      // 按分级级别分组的药品明细
      detailGroups: function () {
        var drugs = this.previewDrugs;
        return D.LEVELS.map(function (lv) {
          return {
            level: lv.code,
            name: lv.name,
            drugs: drugs.filter(function (m) { return m.ext.level === lv.code; })
          };
        }).filter(function (g) { return g.drugs.length; });
      },
      history: function () { App.state.refresh; return Svc.provenance('权限映射'); }
    },
    methods: {
      titleNames: function (codes) {
        return (codes || []).map(function (c) { return D.titleName(c); });
      },
      approvalNames: function (codes) {
        var ordered = APPROVAL_ORDER.filter(function (c) { return (codes || []).indexOf(c) >= 0; });
        return ordered.map(function (c) { return APPROVAL_NAME[c]; });
      },
      approvalLabel: function (code) { return APPROVAL_LABEL[code]; },
      // ---- 编辑映射规则 ----
      openEdit: function (rule) {
        if (!this.isAdmin) return;
        this.edit = {
          level: rule.level,
          levelName: rule.levelName,
          titles: rule.allowedTitles.slice(),
          approvals: rule.approvals.slice(),
          origTitles: rule.allowedTitles.slice()
        };
        this.showEdit = true;
      },
      // 保存映射规则：先做冲突检测
      saveEdit: function () {
        var e = this.edit, hard = [], warn = [];
        // 硬冲突：限制使用级勾选了"需审批专家审批"
        if (e.level === 'restricted' && e.approvals.indexOf('expert') >= 0) {
          hard.push({
            title: '限制使用级勾选了"需审批专家审批"，但特殊使用级同样要求审批专家审批，可能导致审批流程冗余',
            tip: '移除限制使用级的"需审批专家审批"选项'
          });
        }
        // 警告：移除了原先勾选的职称（处方权将被收回）
        var removed = e.origTitles.filter(function (t) { return e.titles.indexOf(t) < 0; });
        if (removed.length) {
          var names = removed.map(function (t) { return D.titleName(t); }).join('、');
          warn.push({
            title: e.levelName + '取消"' + names + '"开具权限后，相关在岗医师持有的' + e.levelName + '处方权将被收回',
            tip: '确认是否已通知相关医师'
          });
        }
        if (hard.length || warn.length) {
          this.conflict = { hard: hard, warn: warn, choice: '' };
          this.showConflict = true;
          return;
        }
        this.commitSave(e.titles, e.approvals);
      },
      // 冲突弹框确认
      confirmConflict: function () {
        var c = this.conflict, e = this.edit;
        if (!c.choice) { App.toast('请选择处理方式', 'error'); return; }
        if (c.choice === 'cancel') {
          this.showConflict = false; // 返回编辑弹框
          return;
        }
        var titles = e.titles.slice(), approvals = e.approvals.slice();
        if (c.choice === 'adjust') {
          // 按建议调整：移除限制使用级的审批专家
          if (e.level === 'restricted') {
            approvals = approvals.filter(function (a) { return a !== 'expert'; });
          }
        }
        // ignore / adjust 均执行保存
        this.showConflict = false;
        this.commitSave(titles, approvals);
      },
      commitSave: function (titles, approvals) {
        var ordered = APPROVAL_ORDER.filter(function (c) { return approvals.indexOf(c) >= 0; });
        Svc.saveMappingRule(this.edit.level, titles, ordered);
        this.showEdit = false;
        this.edit = null;
        this.conflict = null;
        App.bump();
        App.toast('映射规则已保存并即时生效');
      },
      // ---- 导出 ----
      exportConfig: function () {
        if (!this.isAdmin) return;
        App.toast('配置已导出（演示）');
      },
      // ---- 预览明细 ----
      openDetail: function () { this.detailPage = 1; this.showDetail = true; },
      overrideText: function (m) { return m.ext.overridden ? '需专家审批' : '无'; },
      onPreviewChange: function () { this.detailPage = 1; }
    },
    template: `
    <div>
      <!-- C 映射规则表 -->
      <div class="card">
        <div class="card-head"><h3>🔗 映射规则表</h3></div>
        <div class="card-body" style="padding:0">
          <div class="table-wrap">
          <table class="tbl">
            <thead><tr>
              <th style="width:150px">分级级别</th>
              <th style="width:240px">可开具职称</th>
              <th>审批要求</th>
              <th style="width:90px" v-if="isAdmin">操作</th>
            </tr></thead>
            <tbody>
              <tr v-for="r in rules">
                <td><level-tag :level="r.level"></level-tag></td>
                <td>
                  <div v-for="n in titleNames(r.allowedTitles)">{{ n }}</div>
                  <span class="muted" v-if="!r.allowedTitles.length">无</span>
                </td>
                <td>
                  <div v-for="n in approvalNames(r.approvals)">{{ n }}</div>
                  <span class="muted" v-if="!r.approvals.length">无</span>
                </td>
                <td v-if="isAdmin"><a class="btn-link" @click="openEdit(r)">编辑</a></td>
              </tr>
            </tbody>
          </table>
          </div>
          <div class="card-body">
            <div class="alert info">
              <span>💡</span>
              <div>此表为分级级别默认映射规则，分级目录管理中新增药品时将自动套用对应规则。单个药品的特殊映射可在药品编辑弹框的"权限映射"区域单独调整。</div>
            </div>
          </div>
        </div>
      </div>

      <!-- D 权限预览 + E 操作区 -->
      <div class="row mt16">
        <div class="col card" style="min-width:420px">
          <div class="card-head"><h3>👁 权限预览</h3></div>
          <div class="card-body">
            <div class="field inline mb12">
              <label>选择职称</label>
              <select v-model="previewTitle" @change="onPreviewChange">
                <option v-for="t in titleOptions" :value="t.code">{{ t.name }}</option>
              </select>
            </div>

            <div class="section-title">可开具分级级别</div>
            <div style="margin-bottom:14px">
              <div v-for="l in previewLevels" style="padding:3px 0">
                {{ l.ok ? '✅' : '❌' }} {{ l.name }}
              </div>
            </div>

            <div class="section-title">可开具药品分类</div>
            <div v-if="previewClasses.length">
              <div v-for="c in previewClasses" style="padding:3px 0">
                · {{ c.drugClass }}（{{ D.levelName(c.level) }}）
              </div>
              <div class="muted" style="padding:6px 0 2px">
                共 {{ previewClasses.length }} 个药品分类，涉及 {{ previewDrugs.length }} 种药品
              </div>
            </div>
            <empty-state v-else text="该职称暂无可开具药品"></empty-state>

            <div class="mt12">
              <button class="btn" :disabled="!previewDrugs.length" @click="openDetail">查看药品明细 →</button>
            </div>
          </div>
        </div>

        <div class="col card" style="max-width:280px;min-width:220px" v-if="isAdmin">
          <div class="card-head"><h3>⚙️ 操作区</h3></div>
          <div class="card-body">
            <button class="btn primary" @click="exportConfig">↓ 导出配置</button>
            <div class="hint mt8">导出当前全部映射规则为 xlsx 文件。</div>
          </div>
        </div>
      </div>

      <!-- 变更历史 -->
      <div class="card mt16">
        <div class="card-head"><h3>🕒 变更历史</h3></div>
        <div class="card-body" style="padding:0">
          <div class="table-wrap">
          <table class="tbl" v-if="history.length">
            <thead><tr><th style="width:170px">变更时间</th><th>变更内容</th><th style="width:160px">操作人</th></tr></thead>
            <tbody>
              <tr v-for="h in history">
                <td class="nowrap">{{ h.recorded }}</td>
                <td>{{ h.ext.content }}</td>
                <td>{{ h.ext.operator }}</td>
              </tr>
            </tbody>
          </table>
          <empty-state v-else text="暂无变更记录"></empty-state>
          </div>
        </div>
      </div>

      <!-- 映射规则编辑弹框 -->
      <ui-modal v-if="showEdit && edit" :title="'编辑映射规则 - '+edit.levelName" @close="showEdit=false">
        <div class="divider-label">基本信息</div>
        <div class="form-row">
          <label>分级级别</label>
          <div class="ctrl" style="padding-top:6px"><level-tag :level="edit.level"></level-tag></div>
        </div>

        <div class="divider-label">可开具职称</div>
        <div class="checks" style="margin-bottom:6px">
          <label v-for="t in titleOptions">
            <input type="checkbox" :value="t.code" v-model="edit.titles"> {{ t.name }}
          </label>
        </div>

        <div class="divider-label">审批要求</div>
        <div class="checks" style="margin-bottom:6px">
          <label v-for="a in ['dept','pharmacy','expert']">
            <input type="checkbox" :value="a" v-model="edit.approvals"> {{ approvalLabel(a) }}
          </label>
        </div>

        <div class="divider-label">变更提示</div>
        <div class="alert warn">
          <span>⚠️</span>
          <div>规则变更将影响该分级下所有药品的默认权限映射。已单独调整过权限的药品不受影响，维持原有配置。</div>
        </div>

        <template #foot>
          <button class="btn" @click="showEdit=false">取消</button>
          <button class="btn primary" @click="saveEdit">确认保存</button>
        </template>
      </ui-modal>

      <!-- 规则冲突检测弹框 -->
      <ui-modal v-if="showConflict && conflict" title="⚠️ 规则冲突检测" @close="showConflict=false">
        <p style="margin-top:0">检测到以下规则冲突：</p>

        <div class="alert danger" v-for="(h,i) in conflict.hard" style="margin-bottom:12px;flex-direction:column;align-items:stretch">
          <div><b>❌ 冲突{{ i+1 }}</b></div>
          <div style="margin-top:4px">{{ h.title }}</div>
          <div class="muted" style="margin-top:6px">建议：{{ h.tip }}</div>
        </div>

        <div class="alert warn" v-for="(w,i) in conflict.warn" style="margin-bottom:12px;flex-direction:column;align-items:stretch">
          <div><b>⚠️ 警告{{ i+1 }}</b></div>
          <div style="margin-top:4px">{{ w.title }}</div>
          <div class="muted" style="margin-top:6px">建议：{{ w.tip }}</div>
        </div>

        <div class="radios" style="margin-top:8px">
          <label v-if="conflict.hard.length"><input type="radio" value="adjust" v-model="conflict.choice"> 按建议调整后保存</label>
          <label><input type="radio" value="ignore" v-model="conflict.choice"> 忽略冲突，仍按当前配置保存</label>
          <label><input type="radio" value="cancel" v-model="conflict.choice"> 取消保存，返回编辑</label>
        </div>

        <template #foot>
          <button class="btn primary" @click="confirmConflict">确认</button>
        </template>
      </ui-modal>

      <!-- 权限预览药品明细弹框 -->
      <ui-modal v-if="showDetail" :title="'权限预览 - '+previewTitleName+'可开具药品'" width="wide" @close="showDetail=false">
        <div class="kv mb12">
          <span class="k">当前职称</span><span>{{ previewTitleName }}</span>
          <span class="k">可开具分级</span><span>{{ approvableLevelText }}</span>
        </div>

        <template v-for="g in detailGroups">
          <div class="divider-label">{{ g.name }}</div>
          <div class="table-wrap">
          <table class="tbl">
            <thead><tr><th>药品名称</th><th style="width:160px">药品分类</th><th>适应症摘要</th><th style="width:120px">单独调整权限</th></tr></thead>
            <tbody>
              <tr v-for="m in g.drugs">
                <td>{{ m.code.text }}</td>
                <td>{{ m.ext.drugClass }}</td>
                <td>{{ m.ext.indicationSummary }}</td>
                <td>
                  <span v-if="m.ext.overridden" class="tag orange">需专家审批</span>
                  <span v-else class="muted">无</span>
                </td>
              </tr>
            </tbody>
          </table>
          </div>
        </template>

        <div class="alert info mt12">
          <span>💡</span>
          <div>"单独调整权限"列显示该药品在分级目录管理中单独配置的权限覆盖；如需修改请前往分级目录管理的药品编辑弹框。</div>
        </div>

        <template #foot><button class="btn" @click="showDetail=false">关闭</button></template>
      </ui-modal>
    </div>`
  };
})(window);
