/* =====================================================================
 * monitor.js —— L3-3-1 监测概览
 * 实时监控院内抗菌药物使用情况：监测指标 + 趋势图 + 科室排名 +
 * 手术预防用药监测 + 预警信息列表。
 * 权限差异：医疗质量管理部门(quality)可见全部；
 *          药学部门(pharmacy)不可见 (F)手术预防用药监测 与 (G)预警信息列表。
 * ===================================================================== */
(function (global) {
  'use strict';
  var AMS = global.AMS, Svc = global.Svc, D = global.Domain, App = global.App;

  AMS.pages['monitor'] = {
    data: function () {
      return {
        range: 'month',          // 时间范围
        customStart: '', customEnd: '', // 自定义时间范围
        trendMetric: 'ddd',      // 趋势图当前指标
        alertModal: null,        // 预警详情弹框
        surgeryModal: null,      // 手术详情弹框
        alertType: 'all',        // 预警类型筛选
        alertDept: 'all'         // 预警科室筛选
      };
    },
    computed: {
      role: function () { return App.state.roleCode; },
      isPharmacy: function () { return App.state.roleCode === 'pharmacy'; },
      // 数据集"当前时间"对齐全局演示日期 2026-06-15；时间范围切换时联动重新计算监测指标/趋势/科室排名
      rangeFilter: function () {
        if (this.range === 'custom') return { dateStart: this.customStart || undefined, dateEnd: this.customEnd || undefined };
        var end = new Date(2026, 5, 15), start = new Date(end);
        if (this.range === 'week') start.setDate(end.getDate() - 6);
        else if (this.range === 'month') start.setDate(end.getDate() - 29);
        else if (this.range === 'quarter') start.setDate(end.getDate() - 89);
        function fmt(d) { function p(n) { return String(n).padStart(2, '0'); } return d.getFullYear() + '-' + p(d.getMonth() + 1) + '-' + p(d.getDate()); }
        return { dateStart: fmt(start), dateEnd: fmt(end) };
      },
      ov: function () { App.state.refresh; return Svc.overview(this.rangeFilter); },
      indicators: function () {
        var i = this.ov.indicators;
        return [
          { label: '本月用药强度', value: i.ddd.value, unit: 'DDD', delta: i.ddd.delta, dir: i.ddd.dir },
          { label: '送检率', value: i.submissionRate.value + '%', delta: i.submissionRate.delta, dir: i.submissionRate.dir },
          { label: '特殊使用级使用占比', value: i.specialRatio.value + '%', delta: i.specialRatio.delta, dir: i.specialRatio.dir }
        ];
      },
      ranking: function () { return this.ov.departmentRanking; },
      trendValues: function () { return this.ov.trend[this.trendMetric] || []; },
      surgeries: function () { App.state.refresh; return Svc.surgeries(); },
      alertsAll: function () { App.state.refresh; return Svc.alerts(); },
      alertTypes: function () { var s = {}; this.alertsAll.forEach(function (a) { s[a.ext.type] = 1; }); return Object.keys(s); },
      alertDepts: function () { var s = {}; this.alertsAll.forEach(function (a) { s[a.ext.dept] = 1; }); return Object.keys(s); },
      alerts: function () {
        var t = this.alertType, d = this.alertDept;
        return this.alertsAll.filter(function (a) {
          if (t !== 'all' && a.ext.type !== t) return false;
          if (d !== 'all' && a.ext.dept !== d) return false;
          return true;
        });
      }
    },
    methods: {
      setRange: function (r) {
        this.range = r;
        if (r === 'custom' && !this.customStart) { this.customStart = '2026-06-09'; this.customEnd = '2026-06-15'; }
      },
      applyCustomRange: function () {
        if (!this.customStart || !this.customEnd) { App.toast('请选择起止日期', 'error'); return; }
        if (this.customStart > this.customEnd) { App.toast('起始日期不能晚于结束日期', 'error'); return; }
        App.toast('已按自定义时段查询');
      },
      refresh: function () { App.bump(); App.toast('数据已刷新'); },
      arrow: function (dir) { return dir === 'up' ? '↑' : (dir === 'down' ? '↓' : '→'); },
      gotoReport: function () { App.navigate('report'); },
      // 合理性标签
      ratCls: function (r) { return { reasonable: 'green', long: 'orange', violation: 'red' }[r] || 'gray'; },
      ratText: function (r) { return { reasonable: '✅ 合理', long: '⚠️ 偏长', violation: '❌ 违规' }[r] || r; },
      // 预警严重度标签
      sevCls: function (s) { return { high: 'red', moderate: 'orange', low: 'gray' }[s] || 'gray'; },
      sevText: function (s) { return { high: '严重', moderate: '关注', low: '提示' }[s] || s; },
      openSurgery: function (s) { this.surgeryModal = s; },
      openAlert: function (a) { this.alertModal = a; },
      handle: function (a) {
        Svc.handleAlert(a.id);
        App.toast('预警已标记为已处理');
        this.alertModal = null;
      },
      ignore: function (a) {
        var reason = window.prompt('忽略该预警需填写理由：', '');
        if (reason === null) return;
        if (!reason.trim()) { App.toast('忽略预警必须填写理由', 'error'); return; }
        Svc.handleAlert(a.id);
        App.toast('预警已忽略：' + reason.trim());
        this.alertModal = null;
      }
    },
    template: `
    <div>
      <!-- C 时间范围选择 -->
      <div class="card">
        <div class="card-body flex-between" style="gap:12px;flex-wrap:wrap">
          <div class="chip-row">
            <span class="chip" :class="{active:range==='today'}" @click="setRange('today')">今日</span>
            <span class="chip" :class="{active:range==='week'}" @click="setRange('week')">本周</span>
            <span class="chip" :class="{active:range==='month'}" @click="setRange('month')">本月</span>
            <span class="chip" :class="{active:range==='quarter'}" @click="setRange('quarter')">本季度</span>
            <span class="chip" :class="{active:range==='custom'}" @click="setRange('custom')">自定义</span>
            <template v-if="range==='custom'">
              <span class="field inline"><input type="date" v-model="customStart"> ~ <input type="date" v-model="customEnd"></span>
              <button class="btn sm primary" @click="applyCustomRange">查询</button>
            </template>
          </div>
          <button class="btn" @click="refresh">🔄 刷新</button>
        </div>
      </div>

      <!-- D 监测指标卡片 -->
      <div class="card mt16">
        <div class="card-head"><h3>📊 监测指标</h3></div>
        <div class="card-body">
          <div class="stat-grid cols-3">
            <div class="stat-card" v-for="c in indicators">
              <div class="label">{{ c.label }}</div>
              <div class="value">{{ c.value }}<small v-if="c.unit"> {{ c.unit }}</small></div>
              <div class="delta" :class="c.dir" v-if="c.delta!=null">
                {{ arrow(c.dir) }} {{ c.delta }}% 较上月
              </div>
            </div>
          </div>
        </div>
      </div>

      <!-- E 趋势图与科室排名 -->
      <div class="card mt16">
        <div class="card-head"><h3>📈 趋势图与科室排名</h3></div>
        <div class="card-body">
          <div class="chart-grid">
            <!-- E1 指标趋势 -->
            <div class="chart-box">
              <div class="flex-between mb12">
                <h4 style="margin:0">{{ trendMetric==='ddd' ? '用药强度(DDD)趋势（近30天）' : '送检率趋势（近30天）' }}</h4>
                <div class="btn-row">
                  <button class="btn sm" :class="{primary:trendMetric==='ddd'}" @click="trendMetric='ddd'">用药强度</button>
                  <button class="btn sm" :class="{primary:trendMetric==='submissionRate'}" @click="trendMetric='submissionRate'">送检率</button>
                </div>
              </div>
              <line-chart :values="trendValues" color="#1769c0"></line-chart>
              <div class="flex-between muted" style="font-size:12px;margin-top:4px">
                <span>06-01</span><span>06-10</span><span>06-20</span>
              </div>
            </div>
            <!-- E2 科室排名 -->
            <div class="chart-box">
              <h4>科室抗菌药物使用量排名</h4>
              <div class="rank-list">
                <div class="r" v-for="(d,i) in ranking" @click="gotoReport">
                  <span class="idx" :class="{top:i<3}">{{ i+1 }}</span>
                  <span class="nm">{{ d.dept }}</span>
                  <span class="muted">{{ d.ddd }} DDD</span>
                  <span class="delta" :class="d.dir">{{ arrow(d.dir) }}</span>
                </div>
              </div>
              <empty-state v-if="!ranking.length" text="所选时间范围内暂无排名数据"></empty-state>
            </div>
          </div>
        </div>
      </div>

      <!-- F 手术预防用药监测（药学部门不可见） -->
      <div class="card mt16" v-if="!isPharmacy">
        <div class="card-head"><h3>🩺 手术预防用药监测</h3></div>
        <div class="card-body" style="padding:0">
          <table class="tbl" v-if="surgeries.length">
            <thead>
              <tr>
                <th>科室</th><th>手术类型</th><th>用药时机</th><th>持续时间</th><th>合理性</th><th style="width:80px">操作</th>
              </tr>
            </thead>
            <tbody>
              <tr v-for="s in surgeries">
                <td>{{ s.ext.dept }}</td>
                <td>{{ s.ext.surgeryType }}</td>
                <td>{{ s.ext.timing }}</td>
                <td>{{ s.ext.duration }}</td>
                <td><span class="tag" :class="ratCls(s.ext.rational)">{{ ratText(s.ext.rational) }}</span></td>
                <td><a class="btn-link" @click="openSurgery(s)">详情</a></td>
              </tr>
            </tbody>
          </table>
          <empty-state v-else text="所选时间范围内暂无手术预防用药记录"></empty-state>
        </div>
      </div>

      <!-- G 预警信息列表（药学部门不可见） -->
      <div class="card mt16" v-if="!isPharmacy">
        <div class="card-head">
          <h3>⚠️ 预警信息列表</h3>
          <div class="btn-row">
            <div class="field inline"><label>预警类型</label>
              <select v-model="alertType"><option value="all">全部</option><option v-for="t in alertTypes" :value="t">{{ t }}</option></select>
            </div>
            <div class="field inline"><label>科室</label>
              <select v-model="alertDept"><option value="all">全部</option><option v-for="d in alertDepts" :value="d">{{ d }}</option></select>
            </div>
          </div>
        </div>
        <div class="card-body" style="padding:0">
          <table class="tbl" v-if="alerts.length">
            <thead>
              <tr>
                <th style="width:150px">预警时间</th><th>预警类型</th><th>科室</th><th>详情摘要</th><th style="width:90px">操作</th>
              </tr>
            </thead>
            <tbody>
              <tr v-for="a in alerts">
                <td class="nowrap">{{ a.ext.time }}</td>
                <td>
                  <span class="tag" :class="sevCls(a.severity)">{{ sevText(a.severity) }}</span>
                  {{ a.ext.type }}
                </td>
                <td>{{ a.ext.dept }}</td>
                <td>{{ a.ext.summary }}</td>
                <td>
                  <span class="tag green" v-if="a.ext.handled">已处理</span>
                  <a class="btn-link" @click="openAlert(a)">详情</a>
                </td>
              </tr>
            </tbody>
          </table>
          <empty-state v-else text="所选时间范围内暂无预警信息"></empty-state>
        </div>
      </div>

      <!-- 手术详情弹框 -->
      <ui-modal v-if="surgeryModal" title="手术预防用药详情" @close="surgeryModal=null">
        <div class="info-bar" style="margin-bottom:12px">
          <span>科室：{{ surgeryModal.ext.dept }}</span><span class="sep">|</span>
          <span>合理性：<span class="tag" :class="ratCls(surgeryModal.ext.rational)">{{ ratText(surgeryModal.ext.rational) }}</span></span>
        </div>
        <table class="tbl">
          <tbody>
            <tr><td style="width:120px" class="muted">手术类型</td><td>{{ surgeryModal.ext.surgeryType }}</td></tr>
            <tr><td class="muted">用药时机</td><td>{{ surgeryModal.ext.timing }}</td></tr>
            <tr><td class="muted">持续时间</td><td>{{ surgeryModal.ext.duration }}</td></tr>
            <tr><td class="muted">合理性判定</td><td>{{ ratText(surgeryModal.ext.rational) }}</td></tr>
          </tbody>
        </table>
      </ui-modal>

      <!-- 预警详情弹框 -->
      <ui-modal v-if="alertModal" title="预警详情" @close="alertModal=null">
        <div class="info-bar" style="margin-bottom:12px">
          <span><span class="tag" :class="sevCls(alertModal.severity)">{{ sevText(alertModal.severity) }}</span> {{ alertModal.ext.type }}</span>
          <span class="sep">|</span>
          <span>{{ alertModal.ext.time }}</span>
          <span class="sep">|</span>
          <span>{{ alertModal.ext.dept }}</span>
        </div>
        <table class="tbl">
          <tbody>
            <tr v-if="alertModal.ext.detail.patient"><td style="width:120px" class="muted">患者</td><td>{{ alertModal.ext.detail.patient }}</td></tr>
            <tr v-if="alertModal.ext.detail.drug"><td class="muted">药品</td><td>{{ alertModal.ext.detail.drug }}</td></tr>
            <tr v-if="alertModal.ext.detail.dept"><td class="muted">科室</td><td>{{ alertModal.ext.detail.dept }}</td></tr>
            <tr><td class="muted">违规原因</td><td>{{ alertModal.ext.detail.reason }}</td></tr>
            <tr><td class="muted">建议处理措施</td><td>{{ alertModal.ext.detail.advice }}</td></tr>
          </tbody>
        </table>
        <template #foot>
          <span class="tag green" v-if="alertModal.ext.handled">该预警已处理</span>
          <template v-else>
            <button class="btn primary" @click="handle(alertModal)">标记已处理</button>
            <button class="btn" @click="ignore(alertModal)">忽略预警</button>
          </template>
          <button class="btn" @click="alertModal=null">关闭</button>
        </template>
      </ui-modal>
    </div>`
  };
})(window);
