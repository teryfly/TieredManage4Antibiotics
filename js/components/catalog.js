/* =====================================================================
 * catalog.js —— L3-2-1 分级目录管理（系统管理员 / 药学部门）
 * 维护抗菌药物分级目录：按三级分类增删改查、批量导入、版本管理。
 * 药学部门不可删除药品（删除需系统管理员二次确认）。
 * ===================================================================== */
(function (global) {
  'use strict';
  var AMS = global.AMS, Svc = global.Svc, D = global.Domain, App = global.App;

  var APPROVAL_NAME = { dept: '科室负责人', pharmacy: '药学部门', expert: '审批专家' };
  var APPROVAL_LABEL = { dept: '需科室负责人审批', pharmacy: '需药学部门审批', expert: '需审批专家审批' };

  AMS.pages['catalog'] = {
    data: function () {
      return {
        filter: { keyword: '', drugClass: 'all', level: 'all' },
        query: { keyword: '', drugClass: 'all', level: 'all' },
        page: 1, size: 20,
        showHistory: false,
        showEdit: false, showDetail: false, showImport: false,
        isNew: true, editLevelOriginal: '',
        current: null,
        form: this.blank(),
        errors: {},
        // 适应症关联子弹框（支持多选）
        showIndPicker: false, indPickerSelected: [],
        // 批量导入
        importFile: null, importRows: null, importSummary: null
      };
    },
    computed: {
      role: function () { return App.state.roleCode; },
      canDelete: function () { return App.state.roleCode === 'admin'; },
      version: function () { App.state.refresh; return Svc.catalogVersion(); },
      counts: function () { App.state.refresh; return Svc.levelCounts(); },
      history: function () { App.state.refresh; return Svc.provenance('目录版本'); },
      classOptions: function () {
        App.state.refresh;
        var set = {};
        Svc.medications().forEach(function (m) { if (m.ext.drugClass) set[m.ext.drugClass] = true; });
        return Object.keys(set).sort();
      },
      list: function () {
        App.state.refresh;
        return Svc.medications({ keyword: this.query.keyword, drugClass: this.query.drugClass, level: this.query.level });
      },
      paged: function () { var s = (this.page - 1) * this.size; return this.list.slice(s, s + this.size); },
      // 药品分类下拉：已有分类可直接选择，未匹配到已有分类时（含正在输入自定义分类）显示为"自定义"
      drugClassChoice: {
        get: function () {
          var v = this.form.ext.drugClass;
          if (!v) return '';
          return this.classOptions.indexOf(v) >= 0 ? v : '__custom__';
        },
        set: function (v) {
          if (v === '__custom__') {
            if (this.classOptions.indexOf(this.form.ext.drugClass) >= 0 || !this.form.ext.drugClass) this.form.ext.drugClass = '';
          } else {
            this.form.ext.drugClass = v;
          }
        }
      },
      // 当前药品名称在适应症知识库中已登记的标准（适应症关联仅能关联"本药品"的知识库标准）
      drugIndicationChoices: function () {
        App.state.refresh;
        if (!this.form.name) return [];
        return Svc.indications({ drug: this.form.name });
      }
    },
    methods: {
      blank: function () {
        return {
          id: null, name: '',
          ext: {
            drugClass: '', spec: '', brand: '', manufacturer: '', level: '', indicationSummary: '', usage: '',
            indications: [], allowedTitles: [], approvals: [], insurance: '医保乙类', stock: '充足'
          }
        };
      },
      // 分级级别默认权限映射：取自权限映射配置的实时规则（而非本页写死的副本），
      // 保证权限映射规则表调整后，此处新增药品的默认值同步生效
      liveLevelDefault: function (level) {
        var r = Svc.mappingRules().filter(function (x) { return x.level === level; })[0];
        return r ? { allowedTitles: r.allowedTitles.slice(), approvals: r.approvals.slice() } : { allowedTitles: [], approvals: [] };
      },
      levelName: D.levelName,
      titleName: D.titleName,
      approvalName: function (c) { return APPROVAL_NAME[c]; },
      approvalLabel: function (c) { return APPROVAL_LABEL[c]; },
      titles: function () { return D.TITLES; },
      levels: function () { return D.LEVELS; },
      approvalCodes: function () { return ['dept', 'pharmacy', 'expert']; },
      // 筛选
      runQuery: function () { this.query = { keyword: this.filter.keyword, drugClass: this.filter.drugClass, level: this.filter.level }; this.page = 1; },
      resetFilter: function () {
        this.filter = { keyword: '', drugClass: 'all', level: 'all' };
        this.query = { keyword: '', drugClass: 'all', level: 'all' };
        this.page = 1;
      },
      pickLevel: function (lv) {
        this.filter.level = lv; this.query = { keyword: this.query.keyword, drugClass: this.query.drugClass, level: lv }; this.page = 1;
      },
      // 新增 / 编辑
      openCreate: function () {
        this.isNew = true; this.editLevelOriginal = ''; this.errors = {};
        this.form = this.blank();
        this.showEdit = true;
      },
      openEdit: function (m) {
        this.isNew = false; this.errors = {};
        this.editLevelOriginal = m.ext.level;
        this.form = {
          id: m.id, name: m.code.text,
          ext: {
            drugClass: m.ext.drugClass || '',
            spec: m.ext.spec || '', brand: m.ext.brand || '', manufacturer: m.ext.manufacturer || '',
            level: m.ext.level || '',
            indicationSummary: m.ext.indicationSummary || '',
            usage: m.ext.usage || '',
            indications: (m.ext.indications || []).slice(),
            allowedTitles: (m.ext.allowedTitles || []).slice(),
            approvals: (m.ext.approvals || []).slice(),
            insurance: m.ext.insurance || '医保乙类', stock: m.ext.stock || '充足'
          }
        };
        this.showEdit = true;
      },
      onLevelChange: function () {
        // 新增时按级别填充权限映射规则表中的实时默认值
        if (this.isNew && this.form.ext.level) {
          var def = this.liveLevelDefault(this.form.ext.level);
          this.form.ext.allowedTitles = def.allowedTitles.slice();
          this.form.ext.approvals = def.approvals.slice();
        }
      },
      // 适应症关联：多选弹框（同一入口既可新增单条也可一次关联多条）
      openIndPicker: function () { this.indPickerSelected = (this.form.ext.indications || []).slice(); this.showIndPicker = true; },
      confirmIndPicker: function () { this.form.ext.indications = this.indPickerSelected.slice(); this.showIndPicker = false; },
      removeIndication: function (id) {
        var i = this.form.ext.indications.indexOf(id);
        if (i >= 0) this.form.ext.indications.splice(i, 1);
      },
      indDesc: function (id) {
        App.state.refresh;
        var i = Svc.indications({}).filter(function (x) { return x.id === id; })[0];
        return i ? i.ext.description : '（标准已删除）';
      },
      validate: function () {
        var e = {}, f = this.form;
        if (!f.name) e.name = 1;
        if (!f.ext.drugClass) e.drugClass = 1;
        if (!f.ext.level) e.level = 1;
        if (!f.ext.indicationSummary) e.indicationSummary = 1;
        if (!f.ext.usage) e.usage = 1;
        if (!f.ext.allowedTitles.length) e.allowedTitles = 1;
        this.errors = e;
        return Object.keys(e).length === 0;
      },
      save: function () {
        if (!this.validate()) { App.toast('请完善必填信息', 'error'); return; }
        // 编辑模式下级别变更需二次确认
        if (!this.isNew && this.form.ext.level !== this.editLevelOriginal) {
          if (!confirm('变更分类级别将影响已关联的权限映射规则和适应症校验，是否继续？')) return;
        }
        Svc.saveMedication({ id: this.form.id, name: this.form.name, ext: this.form.ext }, this.isNew);
        this.showEdit = false;
        App.toast(this.isNew ? '药品已新增，目录版本已更新' : '药品已保存，目录版本已更新');
        if (this.isNew) this.page = 1;
      },
      // 详情
      openDetail: function (m) { this.current = m; this.showDetail = true; },
      editFromDetail: function () {
        var m = this.current;
        this.showDetail = false;
        this.openEdit(m);
      },
      remove: function (m) {
        if (!this.canDelete) { App.toast('药学部门无删除权限，删除需系统管理员操作', 'error'); return; }
        if (!confirm('确认删除药品「' + m.code.text + '」？该操作将更新目录版本。')) return;
        Svc.deleteMedication(m.id);
        App.toast('药品已删除，目录版本已更新');
        this.page = 1;
      },
      // 导出（演示）
      exportCatalog: function () { App.toast('已按当前筛选条件导出目录 xlsx（演示）'); },
      // 下载真实可用的 csv 模板，可直接编辑后再上传解析
      downloadTemplate: function () {
        var header = ['药品名称', '药品分类', '分级级别', '适应症', '用法用量'];
        var sample = [
          ['头孢克肟', '头孢菌素类（三代）', '限制使用级', '敏感菌感染', '口服，0.1~0.2g/次'],
          ['厄他培南', '碳青霉烯类', '特殊使用级', '复杂腹腔感染', '静滴，1g/日']
        ];
        var csv = [header].concat(sample).map(function (r) { return r.join(','); }).join('\r\n');
        var blob = new Blob(['﻿' + csv], { type: 'text/csv;charset=utf-8;' });
        var url = URL.createObjectURL(blob);
        var a = document.createElement('a');
        a.href = url; a.download = '抗菌药物分级目录导入模板.csv';
        document.body.appendChild(a); a.click(); document.body.removeChild(a);
        setTimeout(function () { URL.revokeObjectURL(url); }, 2000);
        App.toast('模板已下载：抗菌药物分级目录导入模板.csv');
      },
      openImport: function () { this.importFile = null; this.importRows = null; this.importSummary = null; this.showImport = true; },
      closeImport: function () { this.showImport = false; },
      triggerFileSelect: function () { this.$refs.importInput.click(); },
      onFileChange: function (e) { var f = e.target.files && e.target.files[0]; if (f) this.handleFile(f); e.target.value = ''; },
      onDrop: function (e) { var f = e.dataTransfer && e.dataTransfer.files && e.dataTransfer.files[0]; if (f) this.handleFile(f); },
      handleFile: function (file) {
        this.importFile = file;
        if (!/\.(csv|txt)$/i.test(file.name)) {
          this.importRows = []; this.importSummary = { total: 0, matched: 0, needConfirm: 0, error: 0, unsupported: true };
          return;
        }
        var reader = new FileReader();
        reader.onload = (function (ev) { this.parseCsv(String(ev.target.result || '')); }).bind(this);
        reader.readAsText(file);
      },
      // 解析上传的 csv/txt 文件内容，生成真实的导入预览（而非写死数据）
      parseCsv: function (text) {
        var lines = text.split(/\r\n|\n|\r/).filter(function (l) { return l.trim().length; });
        if (!lines.length) { this.importRows = []; this.importSummary = { total: 0, matched: 0, needConfirm: 0, error: 0 }; return; }
        var header = lines[0].split(/[,\t]/).map(function (s) { return s.trim(); });
        var LEVEL_MAP = { '非限制使用级': 'unrestricted', '限制使用级': 'restricted', '特殊使用级': 'special', unrestricted: 'unrestricted', restricted: 'restricted', special: 'special' };
        var rows = lines.slice(1).map(function (line) {
          var cols = line.split(/[,\t]/).map(function (s) { return s.trim(); });
          var row = {}; header.forEach(function (h, i) { row[h] = cols[i] || ''; });
          var name = row['药品名称'] || '', drugClass = row['药品分类'] || '', level = LEVEL_MAP[row['分级级别']] || '';
          var status = !name ? 'error' : (!drugClass || !level) ? 'confirm' : 'ok';
          return { name: name, drugClass: drugClass, level: level, indicationSummary: row['适应症'] || '', usage: row['用法用量'] || '', status: status };
        });
        this.importRows = rows;
        this.importSummary = {
          total: rows.length,
          matched: rows.filter(function (r) { return r.status === 'ok'; }).length,
          needConfirm: rows.filter(function (r) { return r.status === 'confirm'; }).length,
          error: rows.filter(function (r) { return r.status === 'error'; }).length
        };
      },
      confirmImport: function () {
        if (!this.importSummary || !this.importSummary.matched) { App.toast('暂无可导入的匹配数据', 'error'); return; }
        var n = 0;
        this.importRows.filter(function (r) { return r.status === 'ok'; }).forEach((function (r) {
          var def = this.liveLevelDefault(r.level);
          Svc.saveMedication({
            name: r.name,
            ext: {
              drugClass: r.drugClass, level: r.level,
              indicationSummary: r.indicationSummary || '待补充', usage: r.usage || '待补充',
              indications: [], allowedTitles: def.allowedTitles.slice(), approvals: def.approvals.slice(),
              insurance: '医保乙类', stock: '充足'
            }
          }, true);
          n++;
        }).bind(this));
        this.showImport = false;
        this.page = 1;
        App.toast('导入完成，成功新增 ' + n + ' 条药品，目录版本已更新');
      }
    },
    template: `
    <div>
      <!-- C 目录版本信息栏 -->
      <div class="card">
        <div class="card-body">
          <div class="info-bar">
            <span>📋 当前版本：<b>{{ version.version }}</b></span>
            <span class="sep">│</span>
            <span>更新时间：{{ version.updatedAt }}</span>
            <span class="sep">│</span>
            <span>来源：{{ version.source }}</span>
            <div style="flex:1"></div>
            <a class="btn-link" @click="showHistory=true">查看版本历史 →</a>
          </div>
        </div>
      </div>

      <!-- D 筛选与操作区 -->
      <div class="card mt16">
        <div class="card-body">
          <div class="filter-bar">
            <div class="field"><label>药品名称</label>
              <input type="text" v-model="filter.keyword" placeholder="请输入药品名称" @keyup.enter="runQuery">
            </div>
            <div class="field"><label>药品分类</label>
              <select v-model="filter.drugClass">
                <option value="all">全部</option>
                <option v-for="c in classOptions" :value="c">{{ c }}</option>
              </select>
            </div>
            <div class="field"><label>分级级别</label>
              <select v-model="filter.level">
                <option value="all">全部</option>
                <option v-for="lv in levels()" :value="lv.code">{{ lv.name }}</option>
              </select>
            </div>
            <button class="btn primary" @click="runQuery">查询</button>
            <button class="btn" @click="resetFilter">重置</button>
          </div>
          <div class="filter-bar mt12">
            <button class="btn primary" @click="openCreate">+ 新增药品</button>
            <button class="btn" @click="openImport">↑ 批量导入</button>
            <button class="btn" @click="exportCatalog">↓ 导出目录</button>
          </div>
        </div>
      </div>

      <!-- E 分级筛选标签 -->
      <div class="card mt16">
        <div class="card-body">
          <div class="filter-bar">
            <button class="chip" :class="{active:filter.level==='all'}" @click="pickLevel('all')">全部 ({{ counts.all }})</button>
            <button class="chip" :class="{active:filter.level==='unrestricted'}" @click="pickLevel('unrestricted')">非限制使用级 ({{ counts.unrestricted }})</button>
            <button class="chip" :class="{active:filter.level==='restricted'}" @click="pickLevel('restricted')">限制使用级 ({{ counts.restricted }})</button>
            <button class="chip" :class="{active:filter.level==='special'}" @click="pickLevel('special')">特殊使用级 ({{ counts.special }})</button>
          </div>
        </div>
      </div>

      <!-- F 药品列表 -->
      <div class="card mt16">
        <div class="card-head"><h3>📑 药品目录</h3></div>
        <div class="card-body" style="padding:0">
          <div class="table-wrap">
            <table class="tbl" v-if="paged.length">
              <thead><tr><th>药品名称</th><th>药品分类</th><th>分级级别</th><th>适应症摘要</th><th>操作</th></tr></thead>
              <tbody>
                <tr v-for="m in paged">
                  <td>{{ m.code.text }}<span class="muted" v-if="m.ext.brand && m.ext.brand!=='—'" style="font-size:11px"> · {{ m.ext.brand }}</span></td>
                  <td>{{ m.ext.drugClass }}</td>
                  <td><level-tag :level="m.ext.level"></level-tag></td>
                  <td>{{ m.ext.indicationSummary }}</td>
                  <td class="actions">
                    <a class="btn-link" @click="openDetail(m)">详情</a>
                    <a class="btn-link" @click="openEdit(m)">编辑</a>
                    <a class="btn-link danger" v-if="canDelete" @click="remove(m)">删除</a>
                  </td>
                </tr>
              </tbody>
            </table>
            <empty-state v-else text="暂无药品数据，请新增或批量导入">
              <button class="btn primary" @click="openCreate">+ 新增药品</button>
            </empty-state>
          </div>
          <div class="card-body" v-if="list.length"><ui-pager :total="list.length" v-model:page="page" :size="size"></ui-pager></div>
        </div>
      </div>

      <!-- 版本历史弹框 -->
      <ui-modal v-if="showHistory" title="目录版本历史" width="wide" @close="showHistory=false">
        <table class="tbl" v-if="history.length">
          <thead><tr><th>变更时间</th><th>操作人</th><th>变更内容</th></tr></thead>
          <tbody>
            <tr v-for="h in history">
              <td class="nowrap">{{ h.recorded }}</td>
              <td class="nowrap">{{ h.ext.operator }}</td>
              <td>{{ h.ext.content }}</td>
            </tr>
          </tbody>
        </table>
        <empty-state v-else text="暂无版本变更记录"></empty-state>
        <template #foot><button class="btn" @click="showHistory=false">关闭</button></template>
      </ui-modal>

      <!-- 新增 / 编辑药品弹框 -->
      <ui-modal v-if="showEdit" :title="isNew ? '新增药品' : '编辑药品'" width="wide" @close="showEdit=false">
        <div class="divider-label">基本信息</div>
        <div class="form-row">
          <label class="req">药品名称</label>
          <div class="ctrl">
            <input type="text" v-model="form.name" :class="{invalid:errors.name}" placeholder="请输入药品通用名称">
            <span class="err-text" v-if="errors.name">请输入药品名称</span>
          </div>
        </div>
        <div class="form-row">
          <label class="req">药品分类</label>
          <div class="ctrl">
            <select v-model="drugClassChoice" :class="{invalid:errors.drugClass}">
              <option value="">请选择</option>
              <option v-for="c in classOptions" :value="c">{{ c }}</option>
              <option value="__custom__">+ 自定义分类…</option>
            </select>
            <input type="text" v-if="drugClassChoice==='__custom__'" v-model="form.ext.drugClass" placeholder="请输入新的药品分类名称，如：头孢菌素类" style="margin-top:6px">
            <span class="err-text" v-if="errors.drugClass">请选择药品分类</span>
          </div>
        </div>
        <div class="form-row">
          <label>规格 / 商品名</label>
          <div class="ctrl" style="flex-direction:row;gap:8px">
            <input type="text" v-model="form.ext.spec" placeholder="如 0.5g×10支">
            <input type="text" v-model="form.ext.brand" placeholder="商品名（选填）">
          </div>
        </div>
        <div class="form-row">
          <label>医保类别</label>
          <div class="ctrl">
            <select v-model="form.ext.insurance" style="max-width:200px">
              <option>医保甲类</option><option>医保乙类</option><option>医保乙类（限二线）</option><option>自费</option>
            </select>
          </div>
        </div>
        <div class="form-row">
          <label class="req">分级级别</label>
          <div class="ctrl">
            <div class="radios" :class="{invalid:errors.level}">
              <label v-for="lv in levels()"><input type="radio" v-model="form.ext.level" :value="lv.code" @change="onLevelChange">{{ lv.name }}</label>
            </div>
            <span class="err-text" v-if="errors.level">请选择分级级别</span>
          </div>
        </div>

        <div class="divider-label">用药信息</div>
        <div class="form-row">
          <label class="req">适应症</label>
          <div class="ctrl">
            <textarea v-model="form.ext.indicationSummary" :class="{invalid:errors.indicationSummary}" placeholder="请输入适应症描述（用于列表摘要展示）"></textarea>
            <span class="err-text" v-if="errors.indicationSummary">请输入适应症</span>
          </div>
        </div>
        <div class="form-row">
          <label class="req">用法用量</label>
          <div class="ctrl">
            <textarea v-model="form.ext.usage" :class="{invalid:errors.usage}" placeholder="请输入用法用量说明"></textarea>
            <span class="err-text" v-if="errors.usage">请输入用法用量</span>
          </div>
        </div>
        <div class="form-row">
          <label>适应症关联</label>
          <div class="ctrl">
            <div class="chip-row mb8" v-if="form.ext.indications.length">
              <span class="chip" v-for="id in form.ext.indications">📄 {{ indDesc(id) }} <a class="btn-link danger" style="padding:0 2px" @click="removeIndication(id)">✕</a></span>
            </div>
            <span class="muted" v-else style="font-size:12px">暂未关联适应症标准</span>
            <div class="mt8"><button class="btn sm" type="button" @click="openIndPicker">+ 关联适应症知识库标准</button></div>
          </div>
        </div>

        <div class="divider-label">权限映射</div>
        <div class="form-row">
          <label class="req">可开具职称</label>
          <div class="ctrl">
            <div class="checks" :class="{invalid:errors.allowedTitles}">
              <label v-for="t in titles()"><input type="checkbox" v-model="form.ext.allowedTitles" :value="t.code">{{ t.name }}</label>
            </div>
            <span class="err-text" v-if="errors.allowedTitles">请至少选择一个可开具职称</span>
          </div>
        </div>
        <div class="form-row">
          <label>审批要求</label>
          <div class="ctrl">
            <div class="checks">
              <label v-for="c in approvalCodes()"><input type="checkbox" v-model="form.ext.approvals" :value="c">{{ approvalLabel(c) }}</label>
            </div>
          </div>
        </div>

        <div class="alert warn"><span>⚠️</span><div>权限映射规则保存后即时生效，影响该药品的处方权限校验。</div></div>

        <template #foot>
          <button class="btn" @click="showEdit=false">取消</button>
          <button class="btn primary" @click="save">保存</button>
        </template>
      </ui-modal>

      <!-- 药品详情弹框 -->
      <ui-modal v-if="showDetail && current" :title="'药品详情 - '+current.code.text" width="wide" @close="showDetail=false">
        <div class="divider-label">基本信息</div>
        <div class="kv">
          <span class="k">药品名称</span><span>{{ current.code.text }}</span>
          <span class="k">商品名</span><span>{{ current.ext.brand && current.ext.brand!=='—' ? current.ext.brand : '—' }}</span>
          <span class="k">规格</span><span>{{ current.ext.spec || '—' }}</span>
          <span class="k">药品分类</span><span>{{ current.ext.drugClass }}</span>
          <span class="k">生产企业</span><span>{{ current.ext.manufacturer && current.ext.manufacturer!=='—' ? current.ext.manufacturer : '—' }}</span>
          <span class="k">分级级别</span><span><level-tag :level="current.ext.level"></level-tag></span>
        </div>
        <div class="divider-label">用药信息</div>
        <div class="kv">
          <span class="k">适应症</span><span>{{ current.ext.indicationSummary }}</span>
          <span class="k">用法用量</span><span>{{ current.ext.usage }}</span>
          <span class="k">适应症关联</span><span>{{ (current.ext.indications && current.ext.indications.length) ? current.ext.indications.map(indDesc).join(' / ') : '—' }}</span>
          <span class="k">医保类别</span><span>{{ current.ext.insurance || '—' }}</span>
          <span class="k">库存状态</span><span><span class="tag" :class="current.ext.stock==='紧张'?'orange':'green'">{{ current.ext.stock || '充足' }}</span></span>
        </div>
        <div class="divider-label">权限映射</div>
        <div class="kv">
          <span class="k">可开具职称</span><span>{{ (current.ext.allowedTitles||[]).map(titleName).join('、') || '—' }}</span>
          <span class="k">审批要求</span><span>{{ (current.ext.approvals||[]).map(approvalName).join('、') || '无需审批' }}</span>
        </div>
        <template #foot>
          <button class="btn" @click="editFromDetail">编辑</button>
          <div style="flex:1"></div>
          <button class="btn primary" @click="showDetail=false">关闭</button>
        </template>
      </ui-modal>

      <!-- 批量导入弹框 -->
      <ui-modal v-if="showImport" title="批量导入" width="wide" @close="closeImport">
        <div class="divider-label">第一步：下载模板</div>
        <div class="alert info" style="justify-content:space-between;align-items:center">
          <div><span>📄</span> 抗菌药物分级目录导入模板.csv</div>
          <button class="btn sm" @click="downloadTemplate">下载模板</button>
        </div>

        <div class="divider-label">第二步：上传文件</div>
        <input type="file" ref="importInput" accept=".csv,.txt" style="display:none" @change="onFileChange">
        <div class="empty" style="border:1px dashed var(--border);border-radius:9px;cursor:pointer" @click="triggerFileSelect" @dragover.prevent @drop.prevent="onDrop">
          <div class="ico">📁</div>
          <p v-if="!importFile">将文件拖拽到此处，或点击选择文件</p>
          <p v-else>已选择：{{ importFile.name }}</p>
          <div class="muted" style="font-size:12px">支持 .csv / .txt 文本模板（表头：药品名称,药品分类,分级级别,适应症,用法用量），单次最多 500 条</div>
        </div>

        <template v-if="importSummary">
          <div class="divider-label">第三步：导入预览</div>
          <div class="alert warn" v-if="importSummary.unsupported"><span>⚠️</span><div>演示环境暂不支持解析该文件格式，请下载模板后按格式填写并另存为 .csv 上传。</div></div>
          <div class="alert info" style="display:block" v-else-if="importSummary.total">
            <div style="margin-bottom:6px"><b>解析结果：共 {{ importSummary.total }} 条药品数据</b></div>
            <div>✅ 匹配成功：{{ importSummary.matched }} 条（将自动关联分类和权限映射）</div>
            <div>⚠️ 需确认：{{ importSummary.needConfirm }} 条（分类或级别未匹配，将被跳过，请手动新增）</div>
            <div>❌ 数据异常：{{ importSummary.error }} 条（缺少药品名称，将被跳过）</div>
          </div>
          <div class="alert warn" v-else><span>⚠️</span><div>未解析到有效数据行，请检查文件内容是否符合模板格式。</div></div>
        </template>

        <template #foot>
          <button class="btn" @click="closeImport">取消</button>
          <button class="btn primary" :disabled="!importSummary || !importSummary.matched" @click="confirmImport">确认导入{{ importSummary && importSummary.matched ? '（'+importSummary.matched+' 条）' : '' }}</button>
        </template>
      </ui-modal>

      <!-- 适应症关联选择弹框（支持一次关联多条） -->
      <ui-modal v-if="showIndPicker" title="关联适应症知识库标准" @close="showIndPicker=false">
        <div class="alert info" v-if="!form.name">请先填写药品名称，再关联该药品在知识库中的适应症标准。</div>
        <div class="checks" style="flex-direction:column;gap:12px" v-else-if="drugIndicationChoices.length">
          <label v-for="i in drugIndicationChoices" style="align-items:flex-start;gap:10px">
            <input type="checkbox" :value="i.id" v-model="indPickerSelected" style="margin-top:3px">
            <span>
              <div><b>{{ i.ext.description }}</b></div>
              <div class="muted" style="font-size:12px">审核标准：{{ i.ext.standard }}</div>
            </span>
          </label>
        </div>
        <empty-state v-else text="知识库中暂无该药品的适应症标准，可前往「适应症知识库」新增后再关联"></empty-state>
        <template #foot>
          <button class="btn" @click="showIndPicker=false">取消</button>
          <button class="btn primary" @click="confirmIndPicker">确认关联（已选 {{ indPickerSelected.length }} 条）</button>
        </template>
      </ui-modal>
    </div>`
  };
})(window);
