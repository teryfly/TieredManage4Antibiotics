/* =====================================================================
 * home.js —— L1 工作台
 * 既有原型的首页（模块入口 / 核心指标 / 近期动态 / 公告）
 * ∪ SRS §6.2 要求：当前登录用户角色、待审批任务、我发起的申请、
 *   特殊使用药物待审批提醒、紧急补审核剩余时间、最近流程变更。
 * ===================================================================== */
(function (global) {
  'use strict';
  var AMS = global.AMS, Svc = global.Svc, D = global.Domain, App = global.App;

  AMS.pages['home'] = {
    data: function () { return { lastRefresh: Svc.now(), tab: 'work' }; },
    computed: {
      D: function () { return D; },
      role: function () { return App.state.roleCode; },
      user: function () { return App.currentUser(); },
      modules: function () { App.state.refresh; return D.visibleModules(this.role); },
      wb: function () { App.state.refresh; return Svc.srs.workbench(App.currentUser()); },
      approval: function () { App.state.refresh; return Svc.homeApprovalData(this.role, App.currentUser()); },
      indicators: function () { App.state.refresh; return Svc.homeIndicators(this.role); },
      dynamics: function () { App.state.refresh; return Svc.dynamics(this.role).slice(0, 6); },
      announcements: function () { App.state.refresh; return Svc.announcements(); },
      messages: function () { App.state.refresh; return Svc.srs.messages(App.currentUser()).slice(0, 8); },
      clock: function () { App.state.refresh; return global.Clock.state(); },
      greeting: function () { return this.user.display; }
    },
    methods: {
      go: function (r) { App.navigate(r); },
      modulePages: function (m) {
        var role = this.role;
        return m.pages.filter(function (p) { return D.pageRoles(p.route).indexOf(role) >= 0; });
      },
      refresh: function () {
        var self = this;
        this.lastRefresh = Svc.now();
        App.refreshFromServer().then(function () { self.lastRefresh = Svc.now(); });
      },
      dynTagCls: function (t) {
        return { '通过': 'green', '驳回': 'red', '预警': 'orange', '提交': 'blue', '发布': 'blue', '回退': 'orange' }[t] || 'gray';
      }
    },
    template: `
    <div>
      <div class="flex-between mb12">
        <div>
          <h2 style="margin:0;font-size:20px">欢迎，{{ greeting }}</h2>
          <div class="muted" style="font-size:13px">
            角色：{{ D.roleName(role) }} · 科室：{{ user.dept }}
            <template v-if="user.title"> · 职称：{{ D.titleName(user.title) }}</template>
            · 演示时钟：{{ clock.now }}
            <span class="tag orange" v-if="clock.mode!=='live'">
              {{ clock.mode==='frozen' ? ('已冻结在 '+String(clock.frozenAt||'').replace('T',' ').slice(0,16)) : ('偏移 '+(clock.offsetMinutes/60).toFixed(1)+' 小时') }}</span>
          </div>
        </div>
        <button class="btn" @click="refresh">🔄 刷新 <span class="muted" style="font-size:11px">{{ lastRefresh }}</span></button>
      </div>

      <div class="tabs-top" style="margin-bottom:12px">
        <button class="btn" :class="{primary: tab==='work'}" @click="tab='work'">工作台</button>
        <button class="btn" :class="{primary: tab==='nav'}" @click="tab='nav'">功能模块入口</button>
        <button class="btn" :class="{primary: tab==='metric'}" @click="tab='metric'">监测与动态</button>
      </div>

      <div v-if="tab==='work'">
        <div class="stat-grid cols-4" style="margin-bottom:14px">
          <div class="stat-card"><div class="label">待我审批</div>
            <div class="value">{{ wb.counters.todo }}<small>件</small></div>
            <div class="delta up" v-if="wb.counters.todo">点击进入审批中心</div></div>
          <div class="stat-card"><div class="label">我已发起 · 进行中</div>
            <div class="value">{{ wb.counters.mine }}<small>件</small></div></div>
          <div class="stat-card"><div class="label">特殊使用级待审批</div>
            <div class="value">{{ wb.counters.special }}<small>件</small></div>
            <div class="delta up" v-if="wb.counters.special">🔴 需及时处理</div></div>
          <div class="stat-card"><div class="label">超时 / 紧急待补审核</div>
            <div class="value">{{ wb.counters.timeout }}<small>件</small> / {{ wb.counters.emergency }}<small>件</small></div>
            <div class="delta up" v-if="wb.counters.timeout">已超时</div></div>
        </div>

        <div class="alert danger" v-if="wb.specialWaiting.length" style="display:block">
          <div><b>🔴 特殊使用级药物待审批提醒（FR-009.6）</b></div>
          <ul style="margin:6px 0 0 18px">
            <li v-for="r in wb.specialWaiting" :key="r.id">
              {{ r.sqno }} · {{ r.patient }} · {{ r.drug }} · 当前节点 {{ r.currentNode }} · 等待 {{ r.waitingHours }} 小时
              <a class="btn-link" @click="go('approval-center')">处理</a></li>
          </ul>
        </div>

        <div class="row">
          <div class="col card" style="min-width:420px">
            <div class="card-head"><h3>📝 待我审批的任务</h3>
              <a class="btn-link" @click="go('approval-center')">进入审批中心 ›</a></div>
            <div class="card-body" style="padding:0">
              <div class="table-wrap">
                <table class="tbl" v-if="wb.todo.length">
                  <thead><tr><th>患者 / 药品</th><th>开单医师</th><th>当前节点</th><th>剩余时间</th><th>状态</th></tr></thead>
                  <tbody>
                    <tr v-for="r in wb.todo" :key="r.id">
                      <td>{{ r.patient }} · {{ r.drug }} <level-tag :level="r.level"></level-tag></td>
                      <td>{{ r.requester }}</td>
                      <td>{{ r.currentNode }}</td>
                      <td><span v-if="r.timeout.timeout" class="tag red">{{ r.timeout.text }}</span>
                        <span v-else-if="r.timeout.kind==='near'" class="tag orange">{{ r.timeout.text }}</span>
                        <span v-else class="muted">等待 {{ r.waitingHours }}h</span></td>
                      <td><span class="tag" :class="r.tone">{{ r.flowStatusName }}</span></td>
                    </tr>
                  </tbody>
                </table>
                <empty-state v-else text="暂无待您审批的任务"></empty-state>
              </div>
            </div>
          </div>

          <div class="col card" style="min-width:380px">
            <div class="card-head"><h3>📤 我发起的申请</h3>
              <a class="btn-link" @click="go('order-demo')">去临床开单 ›</a></div>
            <div class="card-body" style="padding:0">
              <div class="table-wrap">
                <table class="tbl" v-if="wb.mine.length">
                  <thead><tr><th>申请编号</th><th>药品 / 等级</th><th>当前节点</th><th>版本</th><th>状态</th></tr></thead>
                  <tbody>
                    <tr v-for="r in wb.mine" :key="r.id">
                      <td>{{ r.sqno }}</td>
                      <td>{{ r.drug }} <level-tag :level="r.level"></level-tag></td>
                      <td>{{ r.currentNode }}</td>
                      <td>{{ r.version }}</td>
                      <td><span class="tag" :class="r.tone">{{ r.flowStatusName }}</span>
                        <div class="muted" style="font-size:11px">{{ D.orderStatusName(r.orderStatus) }}</div></td>
                    </tr>
                  </tbody>
                </table>
                <empty-state v-else text="您还没有发起过抗菌药物申请"></empty-state>
              </div>
            </div>
          </div>
        </div>

        <div class="row">
          <div class="col card" style="min-width:380px">
            <div class="card-head"><h3>🚨 紧急补审核剩余时间</h3>
              <a class="btn-link" @click="go('emergency-review')">补审核工作台 ›</a></div>
            <div class="card-body" style="padding:0">
              <div class="table-wrap">
                <table class="tbl" v-if="wb.emergencyDue.length">
                  <thead><tr><th>患者 / 药品</th><th>发起时间</th><th>剩余</th><th>状态</th></tr></thead>
                  <tbody>
                    <tr v-for="e in wb.emergencyDue" :key="e.id">
                      <td>{{ e.patient }} · {{ e.drug }} <level-tag :level="e.level"></level-tag></td>
                      <td class="nowrap">{{ e.createdAt }}</td>
                      <td><span class="tag" :class="e.timeout.timeout?'red':'orange'">{{ e.timeout.text }}</span></td>
                      <td><span class="tag" :class="e.tone">{{ e.flowStatusName }}</span></td>
                    </tr>
                  </tbody>
                </table>
                <empty-state v-else text="暂无临近或超时的补审核任务"></empty-state>
              </div>
            </div>
          </div>

          <div class="col card" style="min-width:380px">
            <div class="card-head"><h3>🗂️ 最近流程与规则变更</h3>
              <a class="btn-link" @click="go('workflow-versions')">流程版本 ›</a></div>
            <div class="card-body" style="padding:0">
              <div class="table-wrap">
                <table class="tbl" v-if="wb.flowChanges.length">
                  <tbody>
                    <tr v-for="p in wb.flowChanges" :key="p.id">
                      <td class="muted nowrap" style="width:110px">{{ p.time.slice(5) }}</td>
                      <td style="width:88px"><span class="tag blue">{{ p.changeType }}</span></td>
                      <td>{{ p.content }}</td>
                    </tr>
                  </tbody>
                </table>
                <empty-state v-else text="暂无变更留痕"></empty-state>
              </div>
            </div>
          </div>
        </div>

        <div class="card mt16">
          <div class="card-head"><h3>🛡️ 我的抗菌药物使用权限</h3>
            <a class="btn-link" @click="go('physician-perm')">权限管理 ›</a></div>
            <div class="card-body">
              <div class="kv">
                <span class="k">当前可开等级</span>
                <span><span v-if="!wb.authz.levels.length" class="tag red">无有效授权</span>
                  <span v-for="lv in wb.authz.levels" :key="lv" class="tag" :class="D.levelTone(lv)" style="margin-right:4px">{{ D.levelName(lv) }}</span></span>
                <span class="k">命中的授权层</span><span>{{ wb.authz.hit.srcLabel }} — {{ wb.authz.hit.ruleText }}</span>
                <span class="k">合并优先级</span><span class="muted">{{ wb.authz.priorityLabel }}</span>
              </div>
            </div>
        </div>

        <div class="card mt16">
          <div class="card-head"><h3>🔔 与审批有关的消息</h3>
            <a class="btn-link" @click="go('approval-center')">全部 ›</a></div>
          <div class="card-body" style="padding:0">
            <div class="table-wrap">
              <table class="tbl" v-if="messages.length">
                <tbody>
                  <tr v-for="m in messages" :key="m.id">
                    <td class="muted nowrap" style="width:110px">{{ m.ext.time.slice(5) }}</td>
                    <td style="width:88px"><span class="tag blue">{{ m.ext.type }}</span></td>
                    <td>{{ m.ext.content }} <span class="tag red" v-if="m.ext.unread">未读</span></td>
                  </tr>
                </tbody>
              </table>
              <empty-state v-else text="暂无消息"></empty-state>
            </div>
          </div>
          <div class="card-body">
            <div class="muted" style="font-size:12px">
              消息为应用内提醒。本演示的跨身份同步通过「重新查询 FHIR 服务端」实现（顶部 🔄 刷新数据），
              不包含医院短信或统一消息平台（SRS FR-009.8）。
            </div>
          </div>
        </div>
      </div>

      <div v-else-if="tab==='nav'">
        <div class="module-grid">
          <div class="module-card" v-for="m in modules">
            <div class="m-icon">{{ m.icon }}</div>
            <h4>{{ m.name }}</h4>
            <div class="m-links"><a v-for="p in modulePages(m)" @click="go(p.route)">{{ p.name }}</a></div>
          </div>
          <div class="module-card" v-if="!modules.length"><empty-state text="当前角色暂无可见业务模块"></empty-state></div>
        </div>
        <div class="alert info" style="display:block">
          <div>SRS §6.1 要求的 10 个功能入口：工作台、抗菌药物目录、抗菌药物等级规则、医师权限管理、审批流程设计、
            流程版本管理、审批中心、临床开单演示、紧急越级补审核、演示数据管理；另保留既有原型的权限映射配置、
            适应症知识库、监测分析、权限卡控规则、系统参数与处方权限申请/审批。</div>
        </div>
      </div>

      <div v-else>
        <div class="card">
          <div class="card-head"><h3>📈 核心指标</h3></div>
          <div class="card-body">
            <div class="stat-grid cols-3">
              <div class="stat-card" v-for="c in indicators" :key="c.label">
                <div class="label">{{ c.label }}</div>
                <div class="value">{{ c.value }}<small v-if="c.unit"> {{ c.unit }}</small></div>
                <div class="delta" :class="c.dir" v-if="c.delta!=null">
                  {{ c.dir==='up'?'↑':(c.dir==='down'?'↓':'→') }} {{ c.delta }}% 较上月</div>
              </div>
            </div>
          </div>
        </div>

        <div class="card mt16" v-if="approval">
          <div class="card-head"><h3>📌 {{ approval.title }}</h3></div>
          <div class="card-body">
            <div class="stat-grid cols-3">
              <div class="stat-card" v-for="c in approval.cards" :key="c.label">
                <div class="label">{{ c.label }}</div>
                <div class="value">{{ c.value }}<small>{{ c.unit }}</small></div>
              </div>
            </div>
          </div>
        </div>

        <div class="row mt16">
          <div class="col card" style="min-width:380px">
            <div class="card-head"><h3>🕒 近期动态</h3></div>
            <div class="card-body" style="padding:0">
              <div class="table-wrap">
                <table class="tbl" v-if="dynamics.length">
                  <tbody>
                    <tr v-for="d in dynamics" :key="d.id">
                      <td class="muted nowrap" style="width:120px">{{ d.ext.time.slice(5) }}</td>
                      <td style="width:70px"><span class="tag" :class="dynTagCls(d.ext.type)">{{ d.ext.type }}</span></td>
                      <td>{{ d.ext.content }}</td>
                    </tr>
                  </tbody>
                </table>
                <empty-state v-else text="暂无动态记录"></empty-state>
              </div>
            </div>
          </div>
          <div class="col card" style="min-width:320px">
            <div class="card-head"><h3>📢 系统公告</h3></div>
            <div class="card-body">
              <div v-for="a in announcements" :key="a.id" style="padding:10px 0;border-bottom:1px solid #eef1f5">
                <div>{{ a.ext.content }}</div>
                <div class="muted" style="font-size:12px;margin-top:3px">{{ a.ext.time }}</div>
              </div>
            </div>
          </div>
        </div>
      </div>
    </div>`
  };
})(window);
