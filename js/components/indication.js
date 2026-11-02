/* =====================================================================
 * indication.js —— L3-2-3 适应症知识库（系统管理员 / 药学部门）
 * 维护药品适应症审核标准库，为处方权限审批中的适应症校验提供标准依据；
 * 支持标准的增删改查、参考依据管理与知识库同步。
 * ===================================================================== */
(function (global) {
  'use strict';
  var AMS = global.AMS, Svc = global.Svc, D = global.Domain, App = global.App;

  AMS.pages['indication'] = {
    data: function () {
      return {
        filter: { drug: '', keyword: '' },
        query: { drug: '', keyword: '' },
        page: 1, size: 20,
        // 适应症编辑弹框
        showEdit: false, editIsNew: true, editForm: this.blankIndication(), editErrors: {},
        // 关联参考依据弹框
        showLink: false, linkSearch: '', linkSelected: [],
        // 参考依据管理弹框
        showManage: false,
        // 新增/编辑依据子弹框
        showCitation: false, citationIsNew: true, citationForm: this.blankCitation(), citationErrors: {}
      };
    },
    computed: {
      isAdmin: function () { return App.state.roleCode === 'admin'; },
      kb: function () { App.state.refresh; return Svc.kbVersion(); },
      allIndications: function () { App.state.refresh; return Svc.indications(); },
      stdCount: function () { return this.allIndications.length; },
      citations: function () { App.state.refresh; return Svc.citations(); },
      auditStats: function () { return Svc.indicationAuditStats(); },
      passRateBars: function () { return this.auditStats.passRates.map(function (p) { return { label: p.drug, value: p.rate }; }); },
      filtered: function () {
        App.state.refresh;
        return Svc.indications({ drug: this.query.drug, keyword: this.query.keyword });
      },
      paged: function () { var s = (this.page - 1) * this.size; return this.filtered.slice(s, s + this.size); },
      drugOptions: function () {
        // 模糊搜索来源：分级目录中已录入的药品名称
        return Svc.medications().map(function (m) { return m.code.text; });
      },
      linkList: function () {
        var kw = this.linkSearch.trim();
        return this.citations.filter(function (c) {
          if (!kw) return true;
          return (c.title || '').indexOf(kw) >= 0 || ((c.ext && c.ext.publisher) || '').indexOf(kw) >= 0;
        });
      }
    },
    methods: {
      blankIndication: function () { return { id: null, drug: '', description: '', standard: '', citations: [] }; },
      blankCitation: function () { return { id: null, title: '', publisher: '', date: '', url: '' }; },

      /* ---- 筛选 ---- */
      doQuery: function () { this.query = { drug: this.filter.drug.trim(), keyword: this.filter.keyword.trim() }; this.page = 1; },
      doReset: function () { this.filter = { drug: '', keyword: '' }; this.query = { drug: '', keyword: '' }; this.page = 1; },

      /* ---- 同步 ---- */
      sync: function () { Svc.syncKb(); App.bump(); App.toast('知识库已同步至最新分级目录'); },

      /* ---- 参考依据标题解析 ---- */
      citationTitle: function (id) {
        var c = this.citations.filter(function (x) { return x.id === id; })[0];
        return c ? c.title : '（依据已删除）';
      },
      citationCount: function (ind) { return (ind.ext.citations || []).length; },

      /* ---- 适应症编辑 ---- */
      openCreate: function () { this.editForm = this.blankIndication(); this.editErrors = {}; this.editIsNew = true; this.showEdit = true; },
      openEdit: function (ind) {
        this.editForm = {
          id: ind.id,
          drug: ind.ext.drug || '',
          description: ind.ext.description || '',
          standard: ind.ext.standard || '',
          citations: (ind.ext.citations || []).slice()
        };
        this.editErrors = {}; this.editIsNew = false; this.showEdit = true;
      },
      removeCitation: function (id) {
        this.editForm.citations = this.editForm.citations.filter(function (x) { return x !== id; });
      },
      validateIndication: function () {
        var e = {}, f = this.editForm;
        if (!f.drug.trim()) e.drug = '请输入或搜索药品名称';
        if (!f.description.trim()) e.description = '请输入适应症描述';
        if (!f.standard.trim()) e.standard = '请输入审核要点';
        this.editErrors = e; return Object.keys(e).length === 0;
      },
      saveIndication: function () {
        if (!this.validateIndication()) { App.toast('请完善必填信息', 'error'); return; }
        var f = this.editForm;
        var payload = { ext: { drug: f.drug.trim(), description: f.description.trim(), standard: f.standard.trim(), citations: f.citations.slice() } };
        if (!this.editIsNew) payload.id = f.id;
        Svc.saveIndication(payload, this.editIsNew);
        App.bump();
        this.showEdit = false;
        App.toast(this.editIsNew ? '适应症标准已新增' : '适应症标准已更新');
      },
      deleteIndication: function (ind) {
        if (!confirm('确认删除该适应症标准？')) return;
        Svc.deleteIndication(ind.id); App.bump(); App.toast('适应症标准已删除');
      },

      /* ---- 关联参考依据子弹框 ---- */
      openLink: function () { this.linkSearch = ''; this.linkSelected = this.editForm.citations.slice(); this.showLink = true; },
      toggleLink: function (id) {
        var i = this.linkSelected.indexOf(id);
        if (i >= 0) this.linkSelected.splice(i, 1); else this.linkSelected.push(id);
      },
      confirmLink: function () { this.editForm.citations = this.linkSelected.slice(); this.showLink = false; App.toast('参考依据已关联'); },

      /* ---- 参考依据管理 ---- */
      openManage: function () { this.showManage = true; },
      openCitationCreate: function () { this.citationForm = this.blankCitation(); this.citationErrors = {}; this.citationIsNew = true; this.showCitation = true; },
      openCitationEdit: function (c) {
        this.citationForm = { id: c.id, title: c.title || '', publisher: (c.ext && c.ext.publisher) || '', date: (c.ext && c.ext.date) || '', url: (c.ext && c.ext.url) || '' };
        this.citationErrors = {}; this.citationIsNew = false; this.showCitation = true;
      },
      validateCitation: function () {
        var e = {}, f = this.citationForm;
        if (!f.title.trim()) e.title = '请输入指南/共识名称';
        if (!f.publisher.trim()) e.publisher = '请输入发布机构';
        if (!f.date.trim()) e.date = '请选择发布时间';
        this.citationErrors = e; return Object.keys(e).length === 0;
      },
      saveCitation: function () {
        if (!this.validateCitation()) { App.toast('请完善必填信息', 'error'); return; }
        var f = this.citationForm;
        var cur = f.id ? this.citations.filter(function (x) { return x.id === f.id; })[0] : null;
        var linked = cur && cur.ext ? (cur.ext.linked || 0) : 0;
        var payload = { title: f.title.trim(), ext: { publisher: f.publisher.trim(), date: f.date.trim(), url: f.url.trim(), linked: linked } };
        if (!this.citationIsNew) payload.id = f.id;
        Svc.saveCitation(payload, this.citationIsNew);
        App.bump();
        this.showCitation = false;
        App.toast(this.citationIsNew ? '参考依据已新增' : '参考依据已更新');
      }
    },
    template: `
    <div>
      <!-- C 知识库版本信息栏 -->
      <div class="card">
        <div class="card-body">
          <div class="info-bar">
            <span>📚 当前版本：<b>{{ kb.version }}</b></span>
            <span class="sep">│</span>
            <span>更新时间：{{ kb.updatedAt }}</span>
            <span class="sep">│</span>
            <span>适应症标准数：<b>{{ stdCount }}</b> 条</span>
          </div>
          <div class="alert warn" style="margin-top:12px" v-if="kb.pendingSync">
            <span>⚠️</span>
            <div style="flex:1;display:flex;align-items:center;gap:12px;flex-wrap:wrap">
              <span>分级目录已于 {{ kb.catalogUpdatedAt }} 更新，知识库待同步</span>
              <button class="btn sm primary" @click="sync">立即同步</button>
            </div>
          </div>
        </div>
      </div>

      <!-- D 筛选与操作区 -->
      <div class="card mt16">
        <div class="card-body">
          <div class="filter-bar">
            <div class="field"><label>药品名称</label>
              <input type="text" v-model="filter.drug" placeholder="请输入药品名称" @keyup.enter="doQuery">
            </div>
            <div class="field"><label>适应症关键词</label>
              <input type="text" v-model="filter.keyword" placeholder="请输入适应症关键词" @keyup.enter="doQuery">
            </div>
            <button class="btn primary" @click="doQuery">查询</button>
            <button class="btn" @click="doReset">重置</button>
            <div style="flex:1"></div>
            <button class="btn primary" @click="openCreate">+ 新增标准</button>
            <button class="btn" @click="openManage">📎 参考依据管理</button>
          </div>
        </div>
      </div>

      <!-- E 适应症列表 -->
      <div class="card mt16">
        <div class="card-head"><h3>📖 适应症标准列表</h3></div>
        <div class="card-body" style="padding:0">
          <div class="table-wrap">
            <table class="tbl" v-if="paged.length">
              <thead><tr><th>药品名称</th><th>适应症内容</th><th>审核标准</th><th>参考依据</th><th>操作</th></tr></thead>
              <tbody>
                <tr v-for="ind in paged">
                  <td class="nowrap">{{ ind.ext.drug }}</td>
                  <td>{{ ind.ext.description }}</td>
                  <td>{{ ind.ext.standard }}</td>
                  <td class="nowrap">{{ citationCount(ind) }} 篇</td>
                  <td class="actions">
                    <a class="btn-link" @click="openEdit(ind)">编辑</a>
                    <a class="btn-link danger" v-if="isAdmin" @click="deleteIndication(ind)">删除</a>
                  </td>
                </tr>
              </tbody>
            </table>
            <empty-state v-else text="暂无适应症标准，请新增"><button class="btn primary" @click="openCreate">+ 新增标准</button></empty-state>
          </div>
          <div class="card-body" v-if="filtered.length"><ui-pager :total="filtered.length" v-model:page="page" :size="size"></ui-pager></div>
        </div>
      </div>

      <!-- 审核结果统计 -->
      <div class="card mt16">
        <div class="card-head"><h3>📊 审核结果统计</h3><span class="muted">辅助优化知识库</span></div>
        <div class="card-body">
          <div class="chart-grid">
            <div class="chart-box">
              <h4>各药品适应症审核通过率（%）</h4>
              <bar-chart :data="passRateBars"></bar-chart>
            </div>
            <div class="chart-box">
              <h4>驳回原因分布</h4>
              <div class="rank-list">
                <div class="r" v-for="(r,i) in auditStats.rejectReasons">
                  <span class="idx" :class="{top:i===0}">{{ i+1 }}</span>
                  <span class="nm">{{ r.reason }}</span>
                  <b>{{ r.count }} 例</b>
                </div>
              </div>
            </div>
          </div>
        </div>
      </div>

      <!-- 适应症编辑弹框 -->
      <ui-modal v-if="showEdit" :title="editIsNew ? '新增适应症标准' : '编辑适应症标准'" @close="showEdit=false">
        <div class="divider-label">药品关联</div>
        <div class="form-row">
          <label class="req">药品名称</label>
          <div class="ctrl">
            <input type="text" v-model="editForm.drug" list="ind-drug-list" placeholder="请输入或搜索药品名称" :class="{invalid:editErrors.drug}">
            <datalist id="ind-drug-list"><option v-for="d in drugOptions" :value="d"></option></datalist>
            <span class="err-text" v-if="editErrors.drug">{{ editErrors.drug }}</span>
          </div>
        </div>

        <div class="divider-label">适应症信息</div>
        <div class="form-row">
          <label class="req">适应症描述</label>
          <div class="ctrl">
            <textarea v-model="editForm.description" placeholder="请输入适应症描述" :class="{invalid:editErrors.description}"></textarea>
            <span class="err-text" v-if="editErrors.description">{{ editErrors.description }}</span>
          </div>
        </div>

        <div class="divider-label">审核标准</div>
        <div class="form-row">
          <label class="req">审核要点</label>
          <div class="ctrl">
            <textarea v-model="editForm.standard" placeholder="请输入审核要点，如：需确诊+药敏试验" :class="{invalid:editErrors.standard}"></textarea>
            <span class="err-text" v-if="editErrors.standard">{{ editErrors.standard }}</span>
          </div>
        </div>

        <div class="divider-label">参考依据</div>
        <div class="chip-row" v-if="editForm.citations.length" style="margin-bottom:10px">
          <span class="chip" v-for="id in editForm.citations">📄 {{ citationTitle(id) }}
            <a class="btn-link danger" style="margin-left:6px" @click="removeCitation(id)">✕</a>
          </span>
        </div>
        <div class="muted" style="font-size:13px;margin-bottom:10px" v-else>暂未关联参考依据</div>
        <button class="btn sm" @click="openLink">+ 关联参考依据</button>

        <template #foot>
          <button class="btn" @click="showEdit=false">取消</button>
          <button class="btn primary" @click="saveIndication">保存</button>
        </template>
      </ui-modal>

      <!-- 参考依据管理弹框 -->
      <ui-modal v-if="showManage" title="参考依据管理" width="wide" @close="showManage=false">
        <div class="btn-row" style="margin-bottom:12px">
          <button class="btn primary" @click="openCitationCreate">+ 新增依据</button>
        </div>
        <div class="table-wrap">
          <table class="tbl" v-if="citations.length">
            <thead><tr><th>指南名称</th><th>发布机构</th><th>发布时间</th><th>关联数</th><th>操作</th></tr></thead>
            <tbody>
              <tr v-for="c in citations">
                <td>{{ c.title }}</td>
                <td class="nowrap">{{ c.ext.publisher }}</td>
                <td class="nowrap">{{ c.ext.date }}</td>
                <td class="nowrap">{{ c.ext.linked || 0 }}</td>
                <td class="actions">
                  <a class="btn-link" @click="openCitationEdit(c)">编辑</a>
                </td>
              </tr>
            </tbody>
          </table>
          <empty-state v-else text="暂无参考依据，请先添加"><button class="btn primary" @click="openCitationCreate">+ 新增依据</button></empty-state>
        </div>
        <template #foot>
          <button class="btn" @click="showManage=false">关闭</button>
        </template>
      </ui-modal>

      <!-- 关联参考依据弹框（适应症编辑的子弹框，后渲染以叠加在上层） -->
      <ui-modal v-if="showLink" title="关联参考依据" @close="showLink=false">
        <div class="filter-bar" style="margin-bottom:12px">
          <div class="field" style="flex:1"><label>搜索</label>
            <input type="text" v-model="linkSearch" placeholder="指南名称 / 发布机构">
          </div>
        </div>
        <div class="checks" style="flex-direction:column;gap:12px" v-if="linkList.length">
          <label v-for="c in linkList" style="align-items:flex-start;gap:10px">
            <input type="checkbox" :checked="linkSelected.indexOf(c.id)>=0" @change="toggleLink(c.id)" style="margin-top:3px">
            <span>
              <div><b>{{ c.title }}</b></div>
              <div class="muted" style="font-size:12px">{{ c.ext.publisher }} · {{ c.ext.date }} · 已关联 {{ c.ext.linked || 0 }} 条标准</div>
            </span>
          </label>
        </div>
        <empty-state v-else text="未检索到参考依据"></empty-state>
        <template #foot>
          <button class="btn" @click="showLink=false">取消</button>
          <button class="btn primary" @click="confirmLink">确认关联</button>
        </template>
      </ui-modal>

      <!-- 新增/编辑参考依据子弹框（参考依据管理的子弹框，最后渲染叠加在最上层） -->
      <ui-modal v-if="showCitation" :title="citationIsNew ? '新增参考依据' : '编辑参考依据'" @close="showCitation=false">
        <div class="form-row">
          <label class="req">指南名称</label>
          <div class="ctrl">
            <input type="text" v-model="citationForm.title" placeholder="请输入指南/共识名称" :class="{invalid:citationErrors.title}">
            <span class="err-text" v-if="citationErrors.title">{{ citationErrors.title }}</span>
          </div>
        </div>
        <div class="form-row">
          <label class="req">发布机构</label>
          <div class="ctrl">
            <input type="text" v-model="citationForm.publisher" placeholder="请输入发布机构" :class="{invalid:citationErrors.publisher}">
            <span class="err-text" v-if="citationErrors.publisher">{{ citationErrors.publisher }}</span>
          </div>
        </div>
        <div class="form-row">
          <label class="req">发布时间</label>
          <div class="ctrl">
            <input type="date" v-model="citationForm.date" :class="{invalid:citationErrors.date}">
            <span class="err-text" v-if="citationErrors.date">{{ citationErrors.date }}</span>
          </div>
        </div>
        <div class="form-row">
          <label>文件链接</label>
          <div class="ctrl">
            <input type="text" v-model="citationForm.url" placeholder="请输入文件 URL 或上传附件（选填）">
          </div>
        </div>
        <template #foot>
          <button class="btn" @click="showCitation=false">取消</button>
          <button class="btn primary" @click="saveCitation">保存</button>
        </template>
      </ui-modal>
    </div>`
  };
})(window);
