/* =====================================================================
 * report.js —— L3-3-2 统计报表
 * 生成抗菌药物使用统计报表，支持按科室、医师、药品等多维度查看，
 * 提供图表可视化与报表导出。
 * 权限差异：医疗质量管理部门(quality)可查看全部 4 种报表；
 *          药学部门(pharmacy)仅可查看 使用汇总报表 与 药品使用报表。
 * ===================================================================== */
(function (global) {
  'use strict';
  var AMS = global.AMS, Svc = global.Svc, D = global.Domain, App = global.App;

  var TAB_DEFS = [
    { code: 'summary', name: '使用汇总报表' },
    { code: 'deptDetail', name: '科室明细报表' },
    { code: 'doctorRx', name: '医师处方报表' },
    { code: 'drugUse', name: '药品使用报表' }
  ];

  AMS.pages['report'] = {
    data: function () {
      var range = Svc.usageDateRange();
      var blank = { dept: 'all', dateStart: range.start, dateEnd: range.end, drugClass: 'all', level: 'all', title: 'all' };
      return {
        tab: 'summary',
        _blank: blank,
        filter: Object.assign({}, blank),
        query: Object.assign({}, blank)
      };
    },
    computed: {
      isPharmacy: function () { return App.state.roleCode === 'pharmacy'; },
      // 药学部门仅见 使用汇总 与 药品使用
      tabs: function () {
        if (this.isPharmacy) {
          return TAB_DEFS.filter(function (t) { return t.code === 'summary' || t.code === 'drugUse'; });
        }
        return TAB_DEFS;
      },
      tabName: function () {
        var tab = this.tab;
        var t = TAB_DEFS.filter(function (x) { return x.code === tab; })[0];
        return t ? t.name : '';
      },
      departments: function () { return D.DEPARTMENTS; },
      titles: function () { return D.TITLES; },
      drugClassOptions: function () { App.state.refresh; return Svc.drugClasses(); },
      // 报表数据集：由真实用药记录按当前查询条件实时聚合计算（而非写死数据）
      data: function () { App.state.refresh; return Svc.reports(this.query); },
      // E1 柱状图数据
      barData: function () {
        var t = this.tab;
        if (t === 'summary' || t === 'deptDetail') {
          return this.data.summary.filter(function (r) { return !r.total; }).map(function (d) { return { label: d.dept, value: parseFloat(d.ddd) }; });
        }
        if (t === 'doctorRx') {
          return this.data.doctorRx.map(function (r) { return { label: r.doctor, value: r.total }; });
        }
        // drugUse
        return this.data.drugUse.map(function (r) { return { label: r.drug, value: r.ddd }; });
      },
      barTitle: function () {
        if (this.tab === 'doctorRx') return '各医师处方数';
        if (this.tab === 'drugUse') return '各药品使用量(DDD)';
        return '各科室用药强度(DDD)';
      },
      // E2 饼图数据
      pieData: function () {
        if (this.tab === 'drugUse') {
          var buckets = {};
          this.data.drugUse.forEach(function (r) {
            buckets[r.drugClass] = (buckets[r.drugClass] || 0) + r.ddd;
          });
          var palette = ['#1769c0', '#16a34a', '#d97706', '#dc2626', '#7c3aed', '#0891b2'];
          var i = 0, out = [];
          for (var k in buckets) {
            out.push({ label: k, value: Math.round(buckets[k] * 10) / 10, color: palette[i % palette.length] });
            i++;
          }
          return out;
        }
        // 使用汇总 / 科室明细 / 医师处方 → 分级使用占比（按当前查询条件实时计算）
        return this.data.levelSplit;
      },
      pieTitle: function () {
        return this.tab === 'drugUse' ? '各药品分类占比' : '分级使用占比';
      },
      // F 表格列与行
      tableColumns: function () {
        return {
          summary: ['科室', '使用量(DDD)', '用药强度(DDD/百床日)', '送检率', '特殊使用级占比'],
          deptDetail: ['科室', '医师姓名', '职称', '处方数', '使用量(DDD)', '送检率', '特殊使用级处方数'],
          doctorRx: ['医师姓名', '职称', '科室', '处方总数', '非限制级', '限制级', '特殊使用级', '送检率'],
          drugUse: ['药品名称', '药品分类', '分级级别', '使用量(DDD)', '使用人次', '送检率', '科室覆盖数']
        }[this.tab];
      }
    },
    methods: {
      switchTab: function (code) { this.tab = code; },
      titleName: function (code) { return D.titleName(code); },
      runQuery: function () { this.query = Object.assign({}, this.filter); App.toast('已按条件查询'); },
      resetFilter: function () {
        this.filter = Object.assign({}, this._blank);
        this.query = Object.assign({}, this._blank);
        App.toast('查询条件已重置');
      },
      dateTag: function () {
        return (this.filter.dateStart + '-' + this.filter.dateEnd).replace(/-/g, '').replace(/(\d{8})(\d{8})/, '$1-$2');
      },
      exportFile: function (ext) {
        var range = this.filter.dateStart.replace(/-/g, '') + '-' + this.filter.dateEnd.replace(/-/g, '');
        App.toast('抗菌药物' + this.tabName + '_' + range + '_导出（演示）');
      }
    },
    template: `
    <div>
      <!-- C 报表类型选择 -->
      <div class="card">
        <div class="card-body">
          <div class="tabs-top">
            <div class="t" v-for="t in tabs" :class="{active:tab===t.code}" @click="switchTab(t.code)">{{ t.name }}</div>
          </div>

          <!-- D 查询条件 -->
          <div class="filter-bar mt16">
            <div class="field" v-if="tab!=='drugUse'"><label>科室</label>
              <select v-model="filter.dept">
                <option value="all">全部</option>
                <option v-for="d in departments" :value="d">{{ d }}</option>
              </select>
            </div>
            <div class="field"><label>时间范围</label>
              <div class="field inline">
                <input type="date" v-model="filter.dateStart">
                <span>~</span>
                <input type="date" v-model="filter.dateEnd">
              </div>
            </div>
            <div class="field" v-if="tab==='drugUse'"><label>药品分类</label>
              <select v-model="filter.drugClass">
                <option value="all">全部</option>
                <option v-for="c in drugClassOptions" :value="c">{{ c }}</option>
              </select>
            </div>
            <div class="field" v-if="tab==='drugUse'"><label>分级级别</label>
              <select v-model="filter.level">
                <option value="all">全部</option>
                <option value="unrestricted">非限制使用级</option>
                <option value="restricted">限制使用级</option>
                <option value="special">特殊使用级</option>
              </select>
            </div>
            <div class="field" v-if="tab==='doctorRx'"><label>医师职称</label>
              <select v-model="filter.title">
                <option value="all">全部</option>
                <option v-for="t in titles" :value="t.code">{{ t.name }}</option>
              </select>
            </div>
            <button class="btn primary" @click="runQuery">查询</button>
            <button class="btn" @click="resetFilter">重置</button>
          </div>
        </div>
      </div>

      <!-- E 图表可视化区 -->
      <div class="card mt16">
        <div class="card-head"><h3>📊 图表可视化</h3></div>
        <div class="card-body">
          <div class="chart-grid">
            <div class="chart-box">
              <h4>{{ barTitle }}</h4>
              <bar-chart v-if="barData.length" :data="barData"></bar-chart>
              <empty-state v-else text="所选条件下暂无数据，请调整查询条件"></empty-state>
            </div>
            <div class="chart-box">
              <h4>{{ pieTitle }}</h4>
              <pie-chart v-if="pieData.length" :data="pieData"></pie-chart>
              <empty-state v-else text="所选条件下暂无数据，请调整查询条件"></empty-state>
            </div>
          </div>
        </div>
      </div>

      <!-- F 报表数据 -->
      <div class="card mt16">
        <div class="card-head">
          <h3>📋 报表数据 · {{ tabName }}</h3>
        </div>
        <div class="card-body" style="padding:0">

          <!-- 使用汇总报表 -->
          <table class="tbl" v-if="tab==='summary' && data.summary.length">
            <thead><tr><th v-for="c in tableColumns">{{ c }}</th></tr></thead>
            <tbody>
              <tr v-for="r in data.summary" :class="{'total-row':r.total}">
                <td>{{ r.total ? '合计' : r.dept }}</td>
                <td>{{ r.ddd }}</td>
                <td>{{ r.intensity }}</td>
                <td>{{ r.submission }}</td>
                <td>{{ r.specialRatio }}</td>
              </tr>
            </tbody>
          </table>

          <!-- 科室明细报表 -->
          <table class="tbl" v-else-if="tab==='deptDetail' && data.deptDetail.length">
            <thead><tr><th v-for="c in tableColumns">{{ c }}</th></tr></thead>
            <tbody>
              <tr v-for="r in data.deptDetail">
                <td>{{ r.dept }}</td>
                <td>{{ r.doctor }}</td>
                <td>{{ titleName(r.title) }}</td>
                <td>{{ r.rx }}</td>
                <td>{{ r.ddd }}</td>
                <td>{{ r.submission }}</td>
                <td>{{ r.special }}</td>
              </tr>
            </tbody>
          </table>

          <!-- 医师处方报表 -->
          <table class="tbl" v-else-if="tab==='doctorRx' && data.doctorRx.length">
            <thead><tr><th v-for="c in tableColumns">{{ c }}</th></tr></thead>
            <tbody>
              <tr v-for="r in data.doctorRx">
                <td>{{ r.doctor }}</td>
                <td>{{ titleName(r.title) }}</td>
                <td>{{ r.dept }}</td>
                <td>{{ r.total }}</td>
                <td>{{ r.unrestricted }}</td>
                <td>{{ r.restricted }}</td>
                <td>{{ r.special }}</td>
                <td>{{ r.submission }}</td>
              </tr>
            </tbody>
          </table>

          <!-- 药品使用报表 -->
          <table class="tbl" v-else-if="tab==='drugUse' && data.drugUse.length">
            <thead><tr><th v-for="c in tableColumns">{{ c }}</th></tr></thead>
            <tbody>
              <tr v-for="r in data.drugUse">
                <td>{{ r.drug }}</td>
                <td>{{ r.drugClass }}</td>
                <td><level-tag :level="r.level"></level-tag></td>
                <td>{{ r.ddd }}</td>
                <td>{{ r.persons }}</td>
                <td>{{ r.submission }}</td>
                <td>{{ r.depts }}</td>
              </tr>
            </tbody>
          </table>

          <empty-state v-else text="所选条件下暂无数据，请调整查询条件"></empty-state>
        </div>
      </div>

      <!-- G 操作区 -->
      <div class="card mt16">
        <div class="card-body flex-between" style="gap:12px;flex-wrap:wrap">
          <div class="muted" style="font-size:13px">按当前报表类型与查询条件导出</div>
          <div class="btn-row">
            <button class="btn" @click="exportFile('xlsx')">↓ 导出Excel</button>
            <button class="btn" @click="exportFile('pdf')">↓ 导出PDF</button>
          </div>
        </div>
      </div>
    </div>`
  };
})(window);
