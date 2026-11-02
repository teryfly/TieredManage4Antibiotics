/* =====================================================================
 * auth-apply.js —— L3-1-1 处方权限申请（医师）
 * 医师查看本人申请记录并提交新申请；按申请类型动态展示审批流程节点。
 * ===================================================================== */
(function (global) {
  'use strict';
  var AMS = global.AMS, Svc = global.Svc, D = global.Domain, App = global.App;

  var NODE_NAME = { dept: '科室负责人', pharmacy: '药学部门', expert: '审批专家' };

  AMS.pages['auth-apply'] = {
    data: function () {
      return {
        filter: { status: 'all', type: 'all' },
        page: 1, size: 10,
        showCreate: false, showDetail: false, current: null,
        form: this.blank(),
        errors: {}
      };
    },
    computed: {
      isDoctor: function () { return App.state.roleCode === 'doctor'; },
      all: function () { App.state.refresh; return Svc.applicationsForDoctor(App.currentUser().practitioner); },
      filtered: function () {
        var f = this.filter;
        return this.all.filter(function (t) {
          if (f.status !== 'all' && t.status !== f.status) return false;
          if (f.type !== 'all' && t.ext.type !== f.type) return false;
          return true;
        });
      },
      paged: function () { var s = (this.page - 1) * this.size; return this.filtered.slice(s, s + this.size); },
      drugOptions: function () {
        if (!this.form.type) return [];
        return Svc.medications({ level: this.form.type }).map(function (m) { return m.code.text; });
      },
      depts: function () { return D.DEPARTMENTS; },
      flowNodes: function () {
        if (!this.form.type) return [];
        var roles = this.form.type === 'special' ? ['dept', 'pharmacy', 'expert'] : ['dept', 'pharmacy'];
        return roles.map(function (r) { return NODE_NAME[r]; });
      }
    },
    methods: {
      blank: function () {
        return {
          type: '', drug: '', dept: '', useStart: '', useEnd: '', reason: '',
          patientName: '', mrn: '', diagnosis: '', infection: '',
          patientAge: '', patientGender: '', patientDept: '', attachments: []
        };
      },
      reset: function () { this.filter = { status: 'all', type: 'all' }; this.page = 1; },
      openCreate: function () { this.form = this.blank(); this.errors = {}; this.showCreate = true; },
      onTypeChange: function () { this.form.drug = ''; }, // 切换类型清空已选药品
      detail: function (t) { this.current = t; this.showDetail = true; },
      withdraw: function (t) { if (confirm('确认撤回该申请？')) { Svc.withdrawApplication(t.id); App.toast('申请已撤回'); } },
      // 已撤回的申请可编辑后重新提交（基于原申请内容预填，提交后生成新的申请记录）
      editWithdrawn: function (t) {
        this.form = {
          type: t.ext.type, drug: t.ext.drug, dept: t.ext.dept,
          useStart: t.ext.useStart || '', useEnd: t.ext.useEnd || '', reason: t.ext.reason || '',
          patientName: t.ext.patientName || '', mrn: t.ext.mrn || '', diagnosis: t.ext.diagnosis || '', infection: t.ext.infection || '',
          patientAge: t.ext.patientAge || '', patientGender: t.ext.patientGender || '', patientDept: t.ext.patientDept || '',
          attachments: (t.ext.attachments || []).slice()
        };
        this.errors = {};
        this.showCreate = true;
      },
      // 附件上传（患者药敏报告 / 检查检验报告等），演示环境以浏览器本地读取为 dataURL 实现真实可查看
      onAttachChange: function (e) {
        var files = Array.prototype.slice.call(e.target.files || []);
        var self = this;
        files.forEach(function (file) {
          if (file.size > 5 * 1024 * 1024) { App.toast('文件「' + file.name + '」超过 5MB，未上传', 'error'); return; }
          var reader = new FileReader();
          reader.onload = function (ev) { self.form.attachments.push({ name: file.name, size: file.size, type: file.type, dataUrl: ev.target.result }); };
          reader.readAsDataURL(file);
        });
        e.target.value = '';
      },
      removeAttachment: function (i) { this.form.attachments.splice(i, 1); },
      viewAttachment: function (a) { if (a.dataUrl) window.open(a.dataUrl, '_blank'); else App.toast('该附件无法预览', 'error'); },
      validate: function () {
        var e = {}, f = this.form;
        ['type', 'drug', 'dept', 'reason', 'patientName', 'mrn', 'diagnosis'].forEach(function (k) { if (!f[k]) e[k] = '必填'; });
        this.errors = e; return Object.keys(e).length === 0;
      },
      submit: function () {
        if (!this.validate()) { App.toast('请完善必填信息', 'error'); return; }
        Svc.submitApplication(this.form);
        this.showCreate = false;
        this.page = 1;
        App.toast('申请已提交，等待药学部门审批' + (this.form.type === 'special' ? '（通过后还需审批专家终审）' : ''));
      },
      saveDraft: function () {
        if (!this.form.type) { App.toast('请先选择申请类型', 'error'); return; }
        App.toast('草稿已保存，可稍后在「我的申请记录」中继续编辑（演示）');
        this.showCreate = false;
      },
      indicationRef: function () {
        if (!this.form.drug) return [];
        return Svc.indications({ drug: this.form.drug });
      },
      levelName: D.levelName
    },
    template: `
    <div v-if="!isDoctor" class="card"><div class="card-body"><empty-state icon="🔒" text="本页面仅对「医师」角色开放。请使用顶部演示角色切换为「医师」。"></empty-state></div></div>
    <div v-else>
      <!-- 筛选与操作 -->
      <div class="card">
        <div class="card-body">
          <div class="filter-bar">
            <div class="field"><label>审批状态</label>
              <select v-model="filter.status">
                <option value="all">全部</option><option value="completed">已通过</option>
                <option value="in-progress">审批中</option><option value="rejected">已驳回</option><option value="cancelled">已撤回</option>
              </select>
            </div>
            <div class="field"><label>申请类型</label>
              <select v-model="filter.type"><option value="all">全部</option><option value="restricted">限制使用级</option><option value="special">特殊使用级</option></select>
            </div>
            <button class="btn" @click="page=1">查询</button>
            <button class="btn" @click="reset">重置</button>
            <div style="flex:1"></div>
            <button class="btn primary" @click="openCreate">+ 新建申请</button>
          </div>
        </div>
      </div>

      <!-- 申请须知 -->
      <div class="card mt16">
        <div class="card-head"><h3>📌 申请须知</h3></div>
        <div class="card-body">
          <div class="alert info" style="display:block">
            <div style="margin-bottom:4px"><b>申请条件：</b>限制使用级需主治及以上职称；特殊使用级需副主任及以上职称，且患者具备明确用药指征（病原学/药敏依据）。</div>
            <div style="margin-bottom:4px"><b>审批时长：</b>限制使用级为二级审批（约 1 个工作日）；特殊使用级为三级审批（约 1~3 个工作日），紧急情况可走紧急用药流程。</div>
            <div><b>权限有效期：</b>审批通过后处方权即时生效，单次特殊使用级授权有效期默认 3 个月，到期需重新申请。</div>
          </div>
        </div>
      </div>

      <!-- 申请列表 -->
      <div class="card mt16">
        <div class="card-head"><h3>📋 我的申请记录</h3></div>
        <div class="card-body" style="padding:0">
          <div class="table-wrap">
          <table class="tbl" v-if="paged.length">
            <thead><tr><th>申请编号</th><th>申请类型</th><th>申请药品</th><th>患者姓名</th><th>申请时间</th><th>审批状态</th><th>操作</th></tr></thead>
            <tbody>
              <tr v-for="t in paged">
                <td class="nowrap">{{ t.identifier[0].value }}</td>
                <td><level-tag :level="t.ext.type"></level-tag></td>
                <td>{{ t.ext.drug }}</td>
                <td>{{ t.ext.patientName }}</td>
                <td class="nowrap">{{ t.authoredOn.slice(5,10) }}</td>
                <td><status-tag :status="t.status"></status-tag></td>
                <td class="actions">
                  <a class="btn-link" @click="detail(t)">详情</a>
                  <a class="btn-link" v-if="t.status==='in-progress'" @click="withdraw(t)">撤回</a>
                  <a class="btn-link" v-if="t.status==='cancelled'" @click="editWithdrawn(t)">编辑</a>
                </td>
              </tr>
            </tbody>
          </table>
          <empty-state v-else text="暂无申请记录"><button class="btn primary" @click="openCreate">+ 新建申请</button></empty-state>
          </div>
          <div class="card-body" v-if="filtered.length"><ui-pager :total="filtered.length" v-model:page="page" :size="size"></ui-pager></div>
        </div>
      </div>

      <!-- 新建申请弹框 -->
      <ui-modal v-if="showCreate" title="新建处方权限申请" @close="showCreate=false">
        <div class="form-row">
          <label class="req">申请类型</label>
          <div class="ctrl">
            <select v-model="form.type" @change="onTypeChange" :class="{invalid:errors.type}">
              <option value="">请选择申请类型</option><option value="restricted">限制使用级申请</option><option value="special">特殊使用级申请</option>
            </select>
            <span class="err-text" v-if="errors.type">请选择申请类型</span>
          </div>
        </div>

        <template v-if="form.type">
          <div class="divider-label">申请信息</div>
          <div class="form-row">
            <label class="req">申请药品</label>
            <div class="ctrl"><select v-model="form.drug" :class="{invalid:errors.drug}"><option value="">请选择药品（{{ levelName(form.type) }}）</option><option v-for="d in drugOptions" :value="d">{{ d }}</option></select>
              <span class="err-text" v-if="errors.drug">请选择药品</span></div>
          </div>
          <div class="form-row"><label class="req">用药科室</label><div class="ctrl"><select v-model="form.dept" :class="{invalid:errors.dept}"><option value="">请选择科室</option><option v-for="d in depts" :value="d">{{ d }}</option></select></div></div>
          <div class="form-row"><label>预计使用时间</label><div class="ctrl" style="flex-direction:row;gap:8px;align-items:center"><input type="date" v-model="form.useStart"> ~ <input type="date" v-model="form.useEnd"></div></div>
          <div class="form-row"><label class="req">申请理由</label><div class="ctrl"><textarea v-model="form.reason" :class="{invalid:errors.reason}" placeholder="请简述用药指征及申请理由..."></textarea></div></div>

          <div class="divider-label">患者信息</div>
          <div class="form-row"><label class="req">患者姓名</label><div class="ctrl"><input type="text" v-model="form.patientName" :class="{invalid:errors.patientName}"></div></div>
          <div class="form-row">
            <label>年龄 / 性别</label>
            <div class="ctrl" style="flex-direction:row;gap:8px">
              <input type="number" min="0" max="120" v-model.number="form.patientAge" placeholder="年龄" style="width:90px">
              <select v-model="form.patientGender" style="width:110px"><option value="">性别</option><option value="male">男</option><option value="female">女</option></select>
            </div>
          </div>
          <div class="form-row"><label>患者科室</label><div class="ctrl"><select v-model="form.patientDept"><option value="">请选择科室</option><option v-for="d in depts" :value="d">{{ d }}</option></select></div></div>
          <div class="form-row"><label class="req">住院号</label><div class="ctrl"><input type="text" v-model="form.mrn" :class="{invalid:errors.mrn}" placeholder="如 ZY20260622001"></div></div>
          <div class="form-row"><label class="req">诊断</label><div class="ctrl"><input type="text" v-model="form.diagnosis" :class="{invalid:errors.diagnosis}"></div></div>
          <div class="form-row"><label>主要感染情况</label><div class="ctrl"><textarea v-model="form.infection" placeholder="请描述感染部位、病原学结果等..."></textarea></div></div>
          <div class="form-row">
            <label>附件</label>
            <div class="ctrl">
              <input type="file" ref="attachInput" multiple style="display:none" @change="onAttachChange">
              <button type="button" class="btn sm" @click="$refs.attachInput.click()">📎 上传附件</button>
              <div class="muted" style="font-size:12px;margin-top:4px">可上传药敏报告、检查检验报告等资料，单个文件不超过 5MB</div>
              <div class="chip-row mt8" v-if="form.attachments.length">
                <span class="chip" v-for="(a,i) in form.attachments">📄 {{ a.name }} <a class="btn-link danger" style="padding:0 2px" @click="removeAttachment(i)">✕</a></span>
              </div>
            </div>
          </div>

          <div class="alert info" v-if="indicationRef().length" style="margin-bottom:12px">
            <span>💡</span><div><b>适应症参考</b>（来自知识库）：<span v-for="(i,idx) in indicationRef()">{{ idx?'、':'' }}{{ i.ext.description }}（{{ i.ext.standard }}）</span></div>
          </div>

          <div class="divider-label">审批流程</div>
          <div class="steps" style="margin:6px 0 10px">
            <div class="step" v-for="(n,i) in flowNodes">
              <div class="dot">{{ i+1 }}</div><div class="bar" v-if="i<flowNodes.length-1"></div>
              <div class="s-name">{{ n }}</div><div class="s-meta">待审核</div>
            </div>
          </div>
          <div class="alert warn"><span>💡</span><div>当前申请类型为「{{ levelName(form.type) }}申请」，需经{{ flowNodes.length===3?'三':'二' }}级审批</div></div>
        </template>

        <template #foot>
          <button class="btn" @click="showCreate=false">取消</button>
          <button class="btn" @click="saveDraft">保存草稿</button>
          <button class="btn primary" @click="submit">提交申请</button>
        </template>
      </ui-modal>

      <!-- 详情弹框 -->
      <ui-modal v-if="showDetail && current" :title="'申请详情 - '+current.identifier[0].value" width="wide" @close="showDetail=false">
        <div class="divider-label">基本信息</div>
        <div class="kv">
          <span class="k">申请类型</span><span><level-tag :level="current.ext.type"></level-tag></span>
          <span class="k">申请药品</span><span>{{ current.ext.drug }}</span>
          <span class="k">用药科室</span><span>{{ current.ext.dept }}</span>
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
          <span class="k">感染情况</span><span>{{ current.ext.infection || '—' }}</span>
          <span class="k">附件</span><span>
            <template v-if="current.ext.attachments && current.ext.attachments.length">
              <a class="btn-link" v-for="a in current.ext.attachments" @click="viewAttachment(a)">📄 {{ a.name }}</a>
            </template>
            <template v-else>—</template>
          </span>
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
        <div class="alert" :class="current.ext.decision && current.ext.decision.result==='approved' ? 'success' : (current.ext.decision && current.ext.decision.result==='rejected' ? 'danger':'info')" style="margin-top:16px" v-if="current.ext.decision">
          <span>{{ current.ext.decision.result==='approved'?'✅':'❌' }}</span>
          <div><b>审批结果：{{ current.ext.decision.result==='approved'?'已通过':'已驳回' }}</b>（{{ current.ext.decision.by }} · {{ current.ext.decision.time }}）
            <div v-if="current.ext.decision.reason">驳回理由：{{ current.ext.decision.reason }}</div></div>
        </div>
        <template #foot><button class="btn" @click="showDetail=false">关闭</button></template>
      </ui-modal>
    </div>`
  };
})(window);
