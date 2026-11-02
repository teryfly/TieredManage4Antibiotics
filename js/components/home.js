/* =====================================================================
 * home.js —— L1 抗菌药物分级管理制度闭环管理（首页）
 * 系统统一入口：模块快捷入口 + 审批数据 + 核心指标 + 近期动态 + 公告
 * 内容按当前角色差异化展示。
 * ===================================================================== */
(function (global) {
  'use strict';
  var AMS = global.AMS, Svc = global.Svc, D = global.Domain, App = global.App;

  AMS.pages['home'] = {
    data: function () { return { lastRefresh: Svc.now() }; },
    computed: {
      role: function () { return App.state.roleCode; },
      user: function () { return App.currentUser ? App.currentUser() : App.currentUser; },
      modules: function () { App.state.refresh; return D.visibleModules(this.role); },
      approval: function () { App.state.refresh; return Svc.homeApprovalData(this.role, App.currentUser()); },
      indicators: function () { App.state.refresh; return Svc.homeIndicators(this.role); },
      dynamics: function () { App.state.refresh; return Svc.dynamics(this.role).slice(0, 6); },
      announcements: function () { App.state.refresh; return Svc.announcements(); },
      greeting: function () { var u = App.currentUser(); return u.display; }
    },
    methods: {
      go: function (r) { App.navigate(r); },
      modulePages: function (m) { var role = this.role; return m.pages.filter(function (p) { return D.pageRoles(p.route).indexOf(role) >= 0; }); },
      refresh: function () { this.lastRefresh = Svc.now(); App.bump(); App.toast('数据已刷新'); },
      dynTagCls: function (t) { return { '通过': 'green', '驳回': 'red', '预警': 'orange', '提交': 'blue' }[t] || 'gray'; }
    },
    template: `
    <div>
      <!-- 欢迎 + 刷新 -->
      <div class="flex-between mb12">
        <div>
          <h2 style="margin:0;font-size:20px">欢迎，{{ greeting }}</h2>
          <div class="muted" style="font-size:13px">抗菌药物分级管理制度闭环管理 · 当前身份可见以下功能模块</div>
        </div>
        <button class="btn" @click="refresh">🔄 刷新 <span class="muted" style="font-size:11px">{{ lastRefresh }}</span></button>
      </div>

      <!-- B 模块快捷入口 -->
      <div class="module-grid">
        <div class="module-card" v-for="m in modules">
          <div class="m-icon">{{ m.icon }}</div>
          <h4>{{ m.name }}</h4>
          <div class="m-links">
            <a v-for="p in modulePages(m)" @click="go(p.route)">{{ p.name }}</a>
          </div>
        </div>
        <div class="module-card" v-if="!modules.length">
          <empty-state text="当前角色暂无可见业务模块"></empty-state>
        </div>
      </div>

      <!-- C 审批数据 -->
      <div class="card mt16" v-if="approval">
        <div class="card-head"><h3>📌 {{ approval.title }}</h3></div>
        <div class="card-body">
          <div class="stat-grid cols-3">
            <div class="stat-card" v-for="c in approval.cards">
              <div class="label">{{ c.label }}</div>
              <div class="value">{{ c.value }}<small>{{ c.unit }}</small></div>
            </div>
          </div>
        </div>
      </div>

      <!-- D 核心指标卡片 -->
      <div class="card mt16">
        <div class="card-head"><h3>📈 核心指标</h3></div>
        <div class="card-body">
          <div class="stat-grid cols-3">
            <div class="stat-card" v-for="c in indicators">
              <div class="label">{{ c.label }}</div>
              <div class="value">{{ c.value }}<small v-if="c.unit"> {{ c.unit }}</small></div>
              <div class="delta" :class="c.dir" v-if="c.delta!=null">
                {{ c.dir==='up'?'↑':(c.dir==='down'?'↓':'→') }} {{ c.delta }}% 较上月
              </div>
            </div>
          </div>
        </div>
      </div>

      <div class="row mt16">
        <!-- E 近期动态 -->
        <div class="col card" style="min-width:380px">
          <div class="card-head"><h3>🕒 近期动态</h3><a class="btn-link">查看全部</a></div>
          <div class="card-body" style="padding:0">
            <table class="tbl" v-if="dynamics.length">
              <tbody>
                <tr v-for="d in dynamics">
                  <td class="muted nowrap" style="width:120px">{{ d.ext.time.slice(5) }}</td>
                  <td style="width:70px"><span class="tag" :class="dynTagCls(d.ext.type)">{{ d.ext.type }}</span></td>
                  <td>{{ d.ext.content }}</td>
                </tr>
              </tbody>
            </table>
            <empty-state v-else text="暂无动态记录"></empty-state>
          </div>
        </div>

        <!-- F 系统公告 -->
        <div class="col card" style="min-width:320px">
          <div class="card-head"><h3>📢 系统公告</h3></div>
          <div class="card-body">
            <div v-for="a in announcements" style="padding:10px 0;border-bottom:1px solid #eef1f5">
              <div>{{ a.ext.content }}</div>
              <div class="muted" style="font-size:12px;margin-top:3px">{{ a.ext.time }}</div>
            </div>
          </div>
        </div>
      </div>
    </div>`
  };
})(window);
