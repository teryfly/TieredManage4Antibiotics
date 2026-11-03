/* =====================================================================
 * demo-data.js —— 演示数据管理（SRS §2.1、§6.1 第 10 项、DEMO-01、§10.2、DEMO-15）
 * ---------------------------------------------------------------------
 * 系统管理员在这里看得见「连的是哪个 FHIR 服务端、能力是否够用、演示数据有
 * 多少、数据之间能不能关联、怎么初始化和清理」。所有涉及服务端的读取都是
 * 异步 Promise，只在按钮方法里触发；界面一律同步取本地镜像，遵守数据层约定。
 * 诚实性优先：服务端不支持的交互标红，不假装写入成功（SRS §10.2）。
 * ===================================================================== */
(function (global) {
  'use strict';
  var AMS = global.AMS, Svc = global.Svc, D = global.Domain, App = global.App;
  var Ap = global.Approval, F = global.FHIR;

  /* SRS §10.2 明确列出的 15 种 + SRS §9.2 本演示实际读写的 4 种 = 19 种资源类型 */
  var CAP_TYPES = [
    { type: 'Patient', why: '患者身份与演示业务标识', req: true },
    { type: 'Encounter', why: '门诊/住院/急诊就诊背景', req: true },
    { type: 'Practitioner', why: '医师身份与职称', req: true },
    { type: 'PractitionerRole', why: '医师与科室、岗位角色的关联', req: true },
    { type: 'Organization', why: '医院、临床科室与审批科室', req: true },
    { type: 'Medication', why: '被 MedicationRequest 引用的药品实体', req: true },
    { type: 'MedicationKnowledge', why: '药品知识与分级属性', req: true },
    { type: 'MedicationRequest', why: '抗菌药物开单', req: true },
    { type: 'PlanDefinition', why: '审批流程定义与版本', req: true },
    { type: 'Task', why: '审批主任务与节点任务', req: true },
    { type: 'Communication', why: '应用内通知与回执', req: true },
    { type: 'CommunicationRequest', why: '审批通知请求记录', req: true },
    { type: 'Provenance', why: '规则/发布/审批的来源记录', req: true },
    { type: 'AuditEvent', why: '关键操作审计（服务器支持时）', req: true },
    { type: 'Bundle', why: '事务 Bundle 批量创建相互引用的演示资源', req: true },
    { type: 'Basic', why: '授权规则、时钟、目录版本等配置载体（SRS §9.4）', req: false },
    { type: 'CodeSystem', why: '等级/用药目的/岗位角色字典', req: false },
    { type: 'ValueSet', why: '字典对应的值集', req: false },
    { type: 'StructureDefinition', why: '自定义 Extension 与 Profile 定义', req: false }
  ];
  /* R4 里"类型级条件搜索"这个 interaction 的实际码值是 search-type（实测 HAPI 8.13 上
   * 资源级列的是 search-type，system 级才有 search），只查 search 会把能力齐全的服务端
   * 判成"全部不支持检索"，因此两个码值都认。 */
  var INTERACTIONS = [
    { code: 'read', name: '读取单条' },
    { code: 'search-type', alt: 'search', name: '条件搜索' },
    { code: 'create', name: '新建' },
    { code: 'update', name: '整体更新' }
  ];

  function clockView() {
    global.App.state.refresh;
    var c = global.Svc.srs.clock();
    var fhirMode = c.mode;
    global.Clock.reload();
    var st = global.Clock.state();
    return {
      now: c.now, instant: c.instant, scope: c.scope, base: c.base, server: c.server,
      fhirMode: fhirMode, mode: st.mode, offsetMinutes: st.offsetMinutes,
      frozenAt: st.frozenAt, setBy: st.setBy, setAt: st.setAt
    };
  }

  AMS.pages['demo-data'] = {
    data: function () {
      return {
        tab: 'server',
        tabs: [
          { code: 'server', name: '服务端与能力' },
          { code: 'base', name: '演示基础数据' },
          { code: 'clock', name: '演示时钟' },
          { code: 'trace', name: '数据关联核查' },
          { code: 'init', name: '初始化与清理' }
        ],
        showTypes: false,
        /* 服务端与能力 */
        capLoading: false, caps: null, capError: '',
        countLoading: false, counts: null, countError: '',
        /* 演示基础数据 */
        groups: { org: false, pract: false, patient: false, drug: false, flow: false },
        checked: false, checks: [],
        /* 演示时钟 */
        clockForm: { hours: 25, frozenAt: '' },
        clockMsg: '',
        /* 数据关联核查 */
        tracePatient: '',
        /* 初始化与清理 */
        busy: '', initMsg: '', initState: null
      };
    },
    computed: {
      D: function () { return D; },
      capTypes: function () { return CAP_TYPES; },
      interactions: function () { return INTERACTIONS; },
      canView: function () { return D.canAccess(App.state.roleCode, 'demo-data'); },
      /* Svc.srs.clock() 内部是 Object.assign(Clock.state(), {...})：它把 FHIR 读写模式
       * 写进了时钟自身的缓存对象，冻结/偏移模式会被顶成 local，之后 Clock.now() 就退回
       * 真实时间（实测：冻结在 07-01 后调用一次，Clock.text() 变成当天时间）。
       * 本函数读完立刻 Clock.reload()，既显示正确，也把缓存还给数据层。 */
      clock: function () { return clockView(); },
      clockModeName: function () {
        var m = this.clock.mode;
        return m === 'live' ? '实时' : (m === 'frozen' ? '冻结于设定时刻' : '按偏移量前进');
      },
      cfg: function () { App.state.refresh; return Svc.srs.demoConfig(); },
      stats: function () { App.state.refresh; return App.state.sync || FHIR.stats(); },
      /* 页面顶部：本地镜像资源总量与按类型明细 */
      dataset: function () {
        App.state.refresh;
        var d = Svc.srs.dataset();
        d.list = Object.keys(d.counts).sort(function (a, b) { return d.counts[b] - d.counts[a] || a.localeCompare(b); })
          .map(function (t) { return { type: t, n: d.counts[t] }; });
        return d;
      },

      /* ---------- 服务端与能力 ---------- */
      capUnsupported: function () { return (this.caps && this.caps.unsupported) || []; },

      /* ---------- 演示基础数据（SRS §11） ---------- */
      orgs: function () {
        App.state.refresh;
        return F.search('Organization').map(function (o) {
          return { id: o.id, name: o.name, kind: (o.type && o.type[0] && o.type[0].text) || '—',
            demo: !!(o.ext && (o.ext.demo || o.ext.orgKind === 'hospital')),
            orgKind: (o.ext && o.ext.orgKind) || '', parentId: (o.partOf && o.partOf.reference) || '' };
        }).sort(function (a, b) { return (b.demo ? 1 : 0) - (a.demo ? 1 : 0) || a.name.localeCompare(b.name, 'zh'); });
      },
      demoOrgCount: function () { return this.orgs.filter(function (o) { return o.demo; }).length; },
      doctors: function () {
        App.state.refresh;
        return F.search('Practitioner').map(function (p) {
          var r = Ap.practitionerRole(p.id);
          var info = Ap.practitionerInfo(p.id) || {};
          var authz = Ap.authorizations(p.id);
          return {
            id: p.id, name: (p.name && p.name[0] && p.name[0].text) || p.id,
            title: D.titleName(info.title), dept: (r && r.ext.orgName) || info.dept || '—',
            roles: r ? (r.ext.roles || [r.ext.roleType]) : [],
            canApprove: r ? !!r.ext.canApprove : false,
            roleId: r ? r.id : '', orgId: (r && r.ext.orgId) || '',
            levels: authz ? authz.levels.map(D.levelName) : [],
            demo: !!(p.ext && p.ext.demo),
            identities: D.identitiesOfPractitioner(p.id).map(function (u) { return u.display; })
          };
        }).filter(function (x) { return x.roleId; }).sort(function (a, b) { return a.dept.localeCompare(b.dept, 'zh') || a.name.localeCompare(b.name, 'zh'); });
      },
      patients: function () {
        App.state.refresh;
        var self = this;
        return F.search('Patient').map(function (p) {
          return { id: p.id, name: (p.name[0] || {}).text, mrn: (p.ext || {}).mrn || '',
            diagnosis: (p.ext || {}).diagnosis || '',
            encounters: F.search('Encounter', function (e) { return e.subject.reference === 'Patient/' + p.id; })
              .map(function (e) { return { id: e.id, kind: e.ext.kindName, visitNo: e.ext.visitNo, start: (e.period.start || '').replace('T', ' ').slice(0, 16) }; }) };
        });
      },
      encounterCount: function () {
        App.state.refresh;
        return F.count('Encounter');
      },
      drugs: function () {
        App.state.refresh;
        var list = Svc.srs.searchDrugs();
        var byLevel = {};
        D.LEVELS.forEach(function (lv) {
          byLevel[lv.code] = { code: lv.code, name: lv.name, n: 0, demo: [] };
        });
        list.forEach(function (d) {
          var k = D.normalizeLevel(d.level);
          if (!byLevel[k]) byLevel[k] = { code: k, name: D.levelName(k), n: 0, demo: [] };
          byLevel[k].n++;
          if (d.demoMark) byLevel[k].demo.push(d.name + '（' + d.demoMark + '）');
        });
        var rows = list.map(function (d) {
          return { id: d.id, name: d.name, code: d.drugCode, level: d.level, levelName: d.levelName,
            demoMark: d.demoMark, spec: d.spec, usage: d.usage, enabled: d.enabled };
        });
        return { total: rows.length, rows: rows, levels: D.LEVELS.map(function (lv) { return byLevel[lv.code]; }),
          demoRows: rows.filter(function (d) { return d.demoMark; }) };
      },
      flowVersions: function () {
        App.state.refresh;
        return Ap.allVersions().map(function (pd) {
          return { id: pd.id, key: (pd.ext && pd.ext.purposeKey) || '', title: (pd.ext && pd.ext.title) || pd.title,
            version: pd.version, status: pd.status, nodes: ((pd.ext && pd.ext.nodes) || []).length,
            url: pd.url, publishedAt: (pd.ext && pd.ext.publishInfo && pd.ext.publishInfo.publishedAt) || '',
            operator: (pd.ext && pd.ext.publishInfo && pd.ext.publishInfo.operator) || '' };
        });
      },
      publishedFlows: function () { return this.flowVersions.filter(function (v) { return v.status === 'active'; }); },

      /* ---------- 数据关联核查（DEMO-15） ---------- */
      tracePatients: function () {
        App.state.refresh;
        return F.search('Patient').map(function (p) {
          return { id: p.id, name: (p.name[0] || {}).text, mrn: (p.ext || {}).mrn || '' };
        });
      },
      trace: function () {
        App.state.refresh;
        if (!this.tracePatient) return null;
        var t = Svc.srs.trace(this.tracePatient);
        return t && t.patient ? t : null;
      },

      /* ---------- 初始化与清理：脚本用法按当前配置实例化 ---------- */
      scriptLines: function () {
        var c = this.cfg;
        return [
          { name: '初始化演示数据（把本系统演示资源灌入服务端）', text: 'python3 scripts/init_demo_data.py --base ' + c.base + ' --scope ' + c.scope + ' --yes' },
          { name: '清理演示数据（只删带本 demo-scope 标签的资源）', text: 'python3 scripts/clean_demo_data.py --base ' + c.base + ' --scope ' + c.scope + ' --yes' },
          { name: '一键复位（清理后重新初始化）', text: c.scriptHint }
        ];
      }
    },
    methods: {
      switchTab: function (code) { this.tab = code; },

      /* ---------- Tab1 服务端能力（SRS §10.2） ---------- */
      readCapabilities: function () {
        var self = this;
        this.capLoading = true; this.capError = ''; this.caps = null;
        return Svc.srs.capabilities(true).then(function (md) {
          self.capLoading = false;
          if (md && md.local) { self.caps = { local: true }; return; }
          var rows = [], unsupported = [];
          CAP_TYPES.forEach(function (t) {
            var one = { type: t.type, why: t.why, required: t.req, present: false, acts: {} };
            var declared = (md.types || {})[t.type];
            INTERACTIONS.forEach(function (i) {
              var okv = !!(declared && (declared.interactions[i.code]
                || (i.alt && declared.interactions[i.alt])));
              one.acts[i.code] = okv;
              if (!okv) unsupported.push(t.type + ' · ' + i.name + '（' + i.code + '）');
            });
            // 本系统的数据隔离全靠 meta.tag 检索，服务端不认 _tag 时要显式说清楚
            one.tagSearch = !!(declared && declared.searchParams && declared.searchParams._tag);
            if (declared && !one.tagSearch) unsupported.push(t.type + ' · 不支持按 _tag 检索（无法只取本系统数据）');
            one.present = !!declared;
            rows.push(one);
          });
          var sys = md.system || [];
          var hasTx = sys.indexOf('transaction') >= 0;
          if (!hasTx) unsupported.push('服务端 system 级 transaction（事务 Bundle 提交）');
          self.caps = {
            local: false, fhirVersion: md.fhirVersion || '', software: md.software || '',
            base: self.cfg.base, server: self.stats.server || self.cfg.base,
            rows: rows, unsupported: unsupported, system: sys, transaction: hasTx,
            readAt: global.Clock.text()
          };
          App.toast('CapabilityStatement 已读取，不支持项 ' + unsupported.length + ' 条',
            unsupported.length ? 'error' : 'success');
        }, function (err) {
          self.capLoading = false;
          self.capError = (err && err.message) || '读取失败';
          self.caps = null;
        });
      },
      countServer: function () {
        var self = this;
        this.countLoading = true; this.countError = ''; this.counts = null;
        return Svc.srs.serverStatus().then(function (r) {
          self.countLoading = false;
          if (r && r.local) { self.counts = { local: true }; return; }
          var c = r.counts || {}, errMap = c.__error || {};
          var list = Object.keys(c).filter(function (t) { return t !== '__error'; })
            .map(function (t) { return { type: t, n: c[t], error: errMap[t] || '' }; })
            .sort(function (a, b) { return b.n - a.n || a.type.localeCompare(b.type); });
          self.counts = { local: false, list: list, scope: r.scope || '', total: list.reduce(function (s, x) { return s + (x.n > 0 ? x.n : 0); }, 0) };
          App.toast('服务端演示资源共 ' + self.counts.total + ' 条', 'success');
        }, function (err) {
          self.countLoading = false;
          self.countError = (err && err.message) || '统计失败';
          self.counts = null;
        });
      },

      /* ---------- Tab2 DEMO-01 一键核对（SRS §11.1~11.5） ---------- */
      runDemo01: function () {
        var checks = [];
        /* §11.1 虚构医院与至少三个演示科室 */
        var hospital = F.search('Organization', function (o) { return o.ext && o.ext.orgKind === 'hospital'; });
        var depts = F.search('Organization', function (o) { return o.ext && o.ext.orgKind === 'department'; });
        checks.push({
          ref: 'SRS §11.1', name: '虚构医院与至少 3 个演示科室', need: '1 个医院 + ≥3 个科室，名称带「演示」标识',
          ok: hospital.length >= 1 && depts.length >= 3,
          actual: '医院 ' + hospital.length + ' 个（' + hospital.map(function (o) { return o.name; }).join('、') + '）；科室 ' + depts.length + ' 个',
          missing: (hospital.length ? '' : '缺少 ext.orgKind=hospital 的演示医院；') + (depts.length >= 3 ? '' : '演示科室不足 3 个，当前 ' + depts.length + ' 个')
        });

        /* §11.2 六类演示用户 */
        var doctors = D.identities('doctor');
        var rich = doctors.filter(function (u) {
          var a = Ap.authorizations(u.practitioner);
          return a && a.levels.indexOf('special') >= 0;
        });
        var poor = doctors.filter(function (u) {
          var a = Ap.authorizations(u.practitioner);
          return a && a.levels.indexOf('special') < 0;
        });
        /* 「按人员 / 按科室 / 按角色」三类审批人：先看有没有可被指定的人，
         * 再附带说明当前已发布流程里是否已经出现该类型的审批节点（演示配置项）。 */
        var nodeTypeUsed = {};
        Ap.allVersions().filter(function (pd) { return pd.status === 'active'; }).forEach(function (pd) {
          ((pd.ext && pd.ext.nodes) || []).forEach(function (n) { nodeTypeUsed[n.assigneeType] = true; });
        });
        var approvable = this.doctors.filter(function (p) { return p.canApprove; });
        var byPerson = approvable.filter(function (p) { return p.roles.indexOf('expert') >= 0; });
        var byDept = approvable.filter(function (p) { return p.roles.indexOf('leader') >= 0 && p.orgId; });
        var byRole = approvable.filter(function (p) {
          return p.roles.some(function (r) { return ['pharmacy', 'expert', 'infection'].indexOf(r) >= 0; });
        });
        var ruleadmin = D.identities('ruleadmin');
        function usedNote(t) {
          return nodeTypeUsed[t] ? '（已发布流程中已有「' + D.assigneeTypeName(t) + '」节点）'
            : '（当前已发布流程尚未使用该审批对象，可在「审批流程设计」中按此类型配置后发布）';
        }
        var six = [
          { k: '权限满足的开单医师', list: rich.map(function (u) { return u.name; }), hint: '' },
          { k: '权限不足的开单医师', list: poor.map(function (u) { return u.name; }), hint: '' },
          { k: '按人员指定的审批人', list: byPerson.map(function (p) { return p.name; }), hint: usedNote('person') },
          { k: '按科室指定的审批人', list: byDept.map(function (p) { return p.name; }), hint: usedNote('department') },
          { k: '按角色指定的审批人', list: byRole.map(function (p) { return p.name; }), hint: usedNote('role') },
          { k: '流程管理员（规则管理员）', list: ruleadmin.map(function (u) { return u.name; }), hint: '' }
        ];
        six.forEach(function (s) {
          checks.push({
            ref: 'SRS §11.2', name: '演示用户：' + s.k,
            need: '至少 1 名（当前共 ' + doctors.length + ' 名医师身份、' + D.DEMO_IDENTITIES.length + ' 个演示身份、' + approvable.length + ' 名可承担审批）',
            ok: s.list.length >= 1,
            actual: (s.list.length ? s.list.slice(0, 4).join('、') + (s.list.length > 4 ? ' 等 ' + s.list.length + ' 名' : '') : '未找到') + s.hint,
            missing: s.list.length ? '' : '缺少' + s.k + '：请补齐 Practitioner 与 PractitionerRole（岗位角色需承担审批职责），并在流程节点中按该类型配置审批对象'
          });
        });

        /* §11.3 至少两名患者与相应门诊/住院就诊 */
        var pts = this.patients;
        var withEnc = pts.filter(function (p) { return p.encounters.length; });
        var outIn = F.search('Encounter', function (e) { return ['outpatient', 'inpatient'].indexOf(e.ext.kind) >= 0; });
        checks.push({
          ref: 'SRS §11.3', name: '演示患者与门诊/住院就诊', need: '≥2 名患者，且各有可关联的 Encounter',
          ok: pts.length >= 2 && withEnc.length >= 2 && outIn.length >= 2,
          actual: '患者 ' + pts.length + ' 名（其中 ' + withEnc.length + ' 名有就诊记录）；门诊/住院就诊 ' + outIn.length + ' 条',
          missing: pts.length >= 2 ? (withEnc.length >= 2 ? '' : '有患者没有关联任何 Encounter') : '患者不足 2 名'
        });

        /* §11.4 三种等级各至少一种演示药品 */
        var drugList = Svc.srs.searchDrugs();
        var missLevels = [];
        var detail = D.LEVELS.map(function (lv) {
          var hit = drugList.filter(function (d) { return d.level === lv.code; });
          if (!hit.length) missLevels.push(lv.name);
          return lv.name + ' ' + hit.length + ' 种' + (hit.length ? '（' + hit.slice(0, 3).map(function (d) { return d.name + (d.demoMark ? '·' + d.demoMark : ''); }).join('、') + (hit.length > 3 ? ' 等' : '') + '）' : '');
        });
        checks.push({
          ref: 'SRS §11.4', name: '三种等级的演示抗菌药物', need: '非限制/限制/特殊使用各 ≥1 种，且带演示标记',
          ok: missLevels.length === 0,
          actual: detail.join('；') + '；目录合计 ' + drugList.length + ' 种',
          missing: missLevels.length ? '以下等级没有药品：' + missLevels.join('、') : ''
        });

        /* §11.5 至少一个已发布流程版本 */
        var all = this.flowVersions;
        var act = all.filter(function (v) { return v.status === 'active'; });
        var em = act.filter(function (v) { return v.key === 'amr-emergency-review'; });
        checks.push({
          ref: 'SRS §11.5', name: '至少 1 个已发布流程版本', need: 'status=active 的 PlanDefinition ≥1（演示主线还需在流程设计中发布 V2 并回退）',
          ok: act.length >= 1,
          actual: '版本共 ' + all.length + ' 个，其中已发布 ' + act.length + ' 个' + (em.length ? '；含紧急越级补审核流程 ' + em.length + ' 个' : ''),
          missing: act.length ? '' : '没有已发布版本：请到「审批流程设计」校验并发布'
        });

        this.checks = checks;
        this.checked = true;
        var bad = checks.filter(function (c) { return !c.ok; }).length;
        App.toast(bad ? 'DEMO-01 核对未通过：' + bad + ' 项缺项' : 'DEMO-01 核对通过：' + checks.length + ' 项全部满足', bad ? 'error' : 'success');
      },

      /* ---------- Tab3 演示时钟 ---------- */
      advance: function () {
        var h = Number(this.clockForm.hours);
        if (!isFinite(h) || h <= 0) { App.toast('推进小时数须为正数', 'error'); return; }
        Svc.srs.advanceClock(Math.round(h * 60));
        App.bump();
        this.clockMsg = '演示时钟已推进 ' + h + ' 小时，当前时钟时刻 ' + global.Clock.text()
          + '。超时状态是计算结果，不写库、不改变任务状态。';
        App.toast('演示时钟已推进 ' + h + ' 小时', 'info');
      },
      freeze: function () {
        if (!this.clockForm.frozenAt) { App.toast('请先选择要冻结到的时刻', 'error'); return; }
        Svc.srs.setClock({ mode: 'frozen', frozenAt: this.clockForm.frozenAt });
        App.bump();
        this.clockMsg = '演示时钟已冻结在 ' + this.clockForm.frozenAt.replace('T', ' ') + '，可用于让补审核截止时间固定复现。';
        App.toast('演示时钟已冻结', 'info');
      },
      toLive: function () {
        Svc.srs.setClock({ mode: 'live' });
        App.bump();
        this.clockMsg = '演示时钟已恢复为实时时钟（偏移清零、取消冻结）。';
        App.toast('已恢复实时时钟', 'info');
      },
      toggleGroup: function (k) { this.groups[k] = !this.groups[k]; },
      toggleTypes: function () { this.showTypes = !this.showTypes; },

      /* ---------- Tab5 初始化与清理 ---------- */
      requery: function () {
        var self = this;
        var wasRemote = FHIR.stats().mode === 'remote';
        this.busy = 'requery';
        return App.refreshFromServer().then(function (r) {
          self.busy = '';
          self.initState = r;
          if (!wasRemote) {
            self.initMsg = '本地内存模式：没有向服务端发起任何查询，界面数据只在当前浏览器内存中。';
            return;
          }
          self.initMsg = '已从服务端重新读取 ' + ((r && r.refreshed) || 0) + ' 条资源'
            + (r && r.failed && r.failed.length ? '；' + r.failed.length + ' 个类型读取失败：'
              + r.failed.map(function (x) { return x.type + '（' + x.message + '）'; }).join('、') : '')
            + '；读取失败的资源不会被写成「已同步」。';
        }, function (err) {
          self.busy = ''; self.initMsg = '重新查询失败：' + (err && err.message ? err.message : '未知错误');
        });
      },
      pushToServer: function () {
        var self = this;
        this.busy = 'push';
        return App.reload().then(function (st) {
          self.busy = '';
          self.initState = st;
          var last = FHIR.stats().lastError;
          if (st.mode !== 'remote') {
            self.initMsg = '当前是本地内存模式，未向服务端写入任何数据。';
            return;
          }
          if (st.failed || last) {
            self.initMsg = '写入未全部成功：失败 ' + (st.failed || 0) + ' 条'
              + (last ? '；最近一次错误 ' + last.type + '/' + last.id + '（' + last.action + '）：' + last.message : '')
              + '。界面不会把失败显示为成功。';
            App.toast('部分资源写入失败，请查看结果说明', 'error');
            return;
          }
          self.initMsg = '重新装载完成：服务端为空时已灌入初始资源 ' + (st.pushed || 0) + ' 条；'
            + '本次从服务端读取 ' + (st.loadedCount || 0) + ' 条；写队列累计成功 ' + (st.done || 0) + ' 条，失败 ' + (st.failed || 0) + ' 条。'
            + '写入是「先落本地镜像、再按引用顺序穿透服务端」，服务端只存资源，不执行审批流程（SRS §10.7）。';
        }, function (err) {
          self.busy = '';
          self.initState = null;
          self.initMsg = '连不上服务端，写入未执行：' + (err && err.message ? err.message : '未知错误') + '。可先用「以本地演示模式继续」再操作。';
          App.toast('写入服务端失败', 'error');
        });
      },
      hardReset: function () {
        var ok = confirm('「恢复演示初始状态」会清空当前浏览器内的 FHIR 本地镜像并重新灌入演示种子数据（相当于刷新页面）。服务端数据保持不变。是否继续？');
        if (!ok) return;
        global.location.reload();
      }
    },
    template: `
    <div>
      <div v-if="!canView" class="card"><div class="card-body">
        <empty-state icon="🔒" text="本页面仅对「系统管理员 / 规则管理员 / 流程审阅人员」角色开放。请使用顶部演示角色切换。"></empty-state>
      </div></div>

      <div v-else>
        <!-- 顶部：本地镜像总量 -->
        <div class="info-bar">
          <span>💾 本地镜像资源总量：<b>{{ dataset.total }}</b> 条</span>
          <span class="sep">│</span>
          <span>{{ stats.mode === 'remote' ? '🟢 已连接 FHIR ' + (stats.fhirVersion || '') : '📴 本地内存模式' }}</span>
          <span class="sep">│</span>
          <span>演示数据作用域：{{ cfg.scope }}</span>
          <span class="sep">│</span>
          <span>演示时钟：{{ clock.now }}</span>
          <span class="sep">│</span>
          <a class="btn-link" @click="toggleTypes">{{ showTypes ? '收起按类型明细' : '展开按类型明细' }}</a>
        </div>
        <div v-if="showTypes" class="chip-row mt8">
          <span class="chip" v-for="t in dataset.list">{{ t.type }} <b>{{ t.n }}</b></span>
        </div>
        <div class="alert warn mt8"><span>⚠️</span>
          <div>本页所有医院、科室、人员、患者、就诊、药品与流程均为<b>虚构演示数据</b>，不代表医院真实目录、真实人员与真实用药制度（SRS BR-010）。公共演示服务器无鉴权、数据公开，可能被他人读写或定期清库。</div>
        </div>

        <div class="card mt16">
          <div class="card-body" style="padding:0 18px">
            <div class="tabs-top">
              <a v-for="t in tabs" class="t" :class="{active: tab===t.code}" @click="switchTab(t.code)">{{ t.name }}</a>
            </div>
          </div>
        </div>

        <!-- ================= 服务端与能力 ================= -->
        <div class="card mt12" v-if="tab==='server'">
          <div class="card-head"><h3>🔌 服务端配置与运行状态</h3></div>
          <div class="card-body">
            <div class="kv">
              <span class="k">FHIR Base URL</span><span>{{ cfg.base }}</span>
              <span class="k">读写模式</span><span>{{ cfg.mode }}（当前运行：{{ stats.mode }} · {{ stats.status }}）</span>
              <span class="k">演示数据作用域</span><span>{{ cfg.scope }}（写入时打在 meta.tag 上，清理脚本据此定位）</span>
              <span class="k">服务端为空时自动灌入初始数据</span><span>{{ cfg.autoSeed ? '是' : '否' }}</span>
              <span class="k">用药记录是否落库</span><span>{{ cfg.persistUsageRecords ? '是（约 4870 条 MedicationAdministration 会写入服务端）' : '否（仅存本地镜像，统计页照常工作）' }}</span>
              <span class="k">探活锚点</span><span>{{ cfg.anchor }}</span>
              <span class="k">实际连接的服务端</span><span>{{ stats.server || '—' }}</span>
              <span class="k">服务端 FHIR 版本</span><span>{{ stats.fhirVersion || '—' }}</span>
              <span class="k">已读取 / 已写入 / 待写 / 失败</span>
              <span>{{ stats.loadedCount }} / {{ stats.done }} / {{ stats.queued + stats.inflight }} / <b :class="stats.failed ? 'txt-err' : ''">{{ stats.failed }}</b></span>
              <span class="k">最近写入错误</span><span class="muted">{{ stats.lastError ? (stats.lastError.type + '/' + stats.lastError.id + '：' + stats.lastError.message) : '无' }}</span>
            </div>

            <div class="divider-label">CapabilityStatement（SRS §10.2 启动时读取服务能力）</div>
            <div class="btn-row">
              <button class="btn primary" :disabled="capLoading" @click="readCapabilities">{{ capLoading ? '正在读取…' : '📡 读取 CapabilityStatement' }}</button>
              <button class="btn" :disabled="countLoading" @click="countServer">{{ countLoading ? '正在统计…' : '📊 统计服务端各类型条数' }}</button>
            </div>
            <div class="alert info mt8"><span>💡</span>
              <div>本演示的读写方式是「本地镜像 + 异步写穿」：界面同步读镜像，写入排队 PUT 到服务端。读取能力清单会<b>逐资源类型、逐 RESTful interaction</b> 检查，服务端不支持的项会标红列出——<b>不支持的写入不会假装成功</b>（SRS §10.2 原文要求）。此按钮只在点击时发起一次 GET /metadata，不在页面渲染时自动请求。</div>
            </div>
            <div class="alert danger mt8" v-if="capError"><span>⛔</span><div>读取 CapabilityStatement 失败：{{ capError }}</div></div>

            <div v-if="caps && caps.local" class="alert warn mt12" style="display:block"><span>📴</span>
              <div><b>当前为本地内存模式，未与服务端交互</b>，因此没有能力清单可读，也不存在「服务端是否支持」的结论。请在顶部「FHIR 服务端设置」切到连接服务端模式后重连，再点此按钮核对。</div>
            </div>

            <template v-if="caps && !caps.local">
              <div class="kv mt12">
                <span class="k">服务端软件 / FHIR 版本</span><span>{{ caps.software || '—' }} ｜ {{ caps.fhirVersion || '—' }}</span>
                <span class="k">system 级交互</span><span>{{ caps.system.length ? caps.system.join('、') : '（服务端未声明 system 级交互）' }}</span>
                <span class="k">事务 Bundle（transaction）</span>
                <span><span class="tag" :class="caps.transaction ? 'green' : 'red'">{{ caps.transaction ? '支持' : '不支持' }}</span>
                  <span class="hint">不支持时，SRS §10.5 的「一次事务创建相互引用的演示资源」只能退化为逐条 PUT</span></span>
                <span class="k">读取时刻</span><span>{{ caps.readAt }}（演示时钟）</span>
              </div>

              <div class="alert danger mt12" v-if="caps.unsupported.length" style="display:block"><span>⛔</span>
                <div>
                  <div><b>服务端不支持以下项，共 {{ caps.unsupported.length }} 条：</b></div>
                  <div class="mt8">
                    <span class="tag red" v-for="u in caps.unsupported">{{ u }}</span>
                  </div>
                  <div class="mt8">这些项<b>不会被假装成写入成功</b>：本系统写穿时逐条 PUT 到服务端，服务端拒绝或不可达会计入「失败」并显示 sync 最近错误原文（见上方统计行）；需要该能力时请换用支持的服务端实例，或在服务端配置中开放对应 interaction。</div>
                </div>
              </div>
              <div class="alert success mt12" v-else><span>✅</span><div>SRS §10.2 列出的资源类型与 read/search/create/update 交互、以及 system 级 transaction 均可用。</div></div>

              <div class="table-wrap mt12">
                <table class="tbl">
                  <thead><tr><th>资源类型</th><th>用途</th><th>来源</th><th>类型已发布</th>
                    <th v-for="i in interactions" class="text-c">{{ i.name }}</th></tr></thead>
                  <tbody>
                    <tr v-for="r in caps.rows">
                      <td><b>{{ r.type }}</b></td>
                      <td class="muted" style="font-size:12px">{{ r.why }}</td>
                      <td><span class="tag" :class="r.required ? 'blue' : 'gray'">{{ r.required ? '§10.2 明确列出' : '§9.2 演示需要' }}</span></td>
                      <td><span class="tag" :class="r.present ? 'green' : 'red'">{{ r.present ? '有' : '无' }}</span></td>
                      <td class="text-c" v-for="i in interactions">
                        <span :class="r.acts[i.code] ? '' : 'tag red'">{{ r.acts[i.code] ? '✔' : '不支持' }}</span>
                      </td>
                    </tr>
                  </tbody>
                </table>
              </div>
              <div class="muted mt8" style="font-size:12px">✔ = 服务端 CapabilityStatement 声明支持；红色「不支持」= 该项在本服务端不可用，本系统不会把它显示为写入成功。</div>
            </template>

            <div class="alert warn mt8" v-if="countError"><span>⚠️</span><div>统计服务端条数失败：{{ countError }}</div></div>
            <div v-if="counts && counts.local" class="alert warn mt12" style="display:block"><span>📴</span>
              <div>本地内存模式，未向服务端发起任何统计请求。</div>
            </div>
            <template v-if="counts && !counts.local">
              <div class="divider-label">服务端「本系统」资源条数（按 demo-scope 标签统计，作用域 {{ counts.scope }}）</div>
              <div class="table-wrap">
                <table class="tbl">
                  <thead><tr><th>资源类型</th><th class="text-r">条数</th><th>说明</th></tr></thead>
                  <tbody>
                    <tr v-for="c in counts.list">
                      <td>{{ c.type }}</td>
                      <td class="text-r"><b :class="c.n < 0 ? 'txt-err' : ''">{{ c.n < 0 ? '读取失败' : c.n }}</b></td>
                      <td class="muted" style="font-size:12px">{{ c.error ? c.error : (c.n === 0 ? '服务端当前没有该类型的演示资源' : '') }}</td>
                    </tr>
                    <tr class="total-row"><td>合计</td><td class="text-r">{{ counts.total }}</td><td class="muted" style="font-size:12px">公共服务器上其他使用者写的资源不在统计口径内</td></tr>
                  </tbody>
                </table>
              </div>
            </template>
          </div>
        </div>

        <!-- ================= 演示基础数据 ================= -->
        <div class="card mt12" v-if="tab==='base'">
          <div class="card-head"><h3>🧪 演示基础数据（SRS §11 最小集）</h3>
            <div class="btn-row" style="margin:0"><button class="btn primary" @click="runDemo01">✅ DEMO-01 一键核对</button></div>
          </div>
          <div class="card-body">
            <div class="alert info"><span>💡</span>
              <div>以下按「医院与科室 / 人员与岗位 / 患者与就诊 / 药品目录与等级 / 流程版本」分组列出本地镜像中的演示数据。
              <b>全部为虚构演示数据，不代表医院真实目录与人员</b>（SRS BR-010）；名称均带「演示」标识或位于演示作用域内。</div>
            </div>

            <div class="divider-label">数据分组条数</div>
            <div class="stat-grid cols-4">
              <div class="stat-card"><div class="label">医院与科室</div><div class="value">{{ orgs.length }}<small>条</small></div>
                <div class="delta flat">其中带演示标识 {{ demoOrgCount }} 条</div></div>
              <div class="stat-card"><div class="label">人员与岗位</div><div class="value">{{ doctors.length }}<small>人</small></div>
                <div class="delta flat">演示身份 {{ D.DEMO_IDENTITIES.length }} 个</div></div>
              <div class="stat-card"><div class="label">患者与就诊</div><div class="value">{{ patients.length }}<small>人</small></div>
                <div class="delta flat">Encounter {{ encounterCount }} 条</div></div>
              <div class="stat-card"><div class="label">药品与流程版本</div><div class="value">{{ drugs.total }}<small>种</small></div>
                <div class="delta flat">流程版本 {{ flowVersions.length }} 个（已发布 {{ publishedFlows.length }}）</div></div>
            </div>

            <!-- 医院与科室 -->
            <div class="divider-label">演示医院与科室（Organization）</div>
            <a class="btn-link" @click="toggleGroup('org')">{{ groups.org ? '收起清单' : '展开清单（' + orgs.length + ' 条）' }}</a>
            <div class="table-wrap mt8" v-if="groups.org">
              <table class="tbl">
                <thead><tr><th>资源 ID</th><th>名称</th><th>类型</th><th>层级</th><th>演示标识</th></tr></thead>
                <tbody>
                  <tr v-for="o in orgs">
                    <td>{{ o.id }}</td><td><b>{{ o.name }}</b></td><td>{{ o.kind }}</td>
                    <td class="muted" style="font-size:12px">{{ o.orgKind === 'hospital' ? '医院（顶层）' : (o.parentId ? '隶属 ' + o.parentId : '未挂父级') }}</td>
                    <td><span class="tag" :class="o.demo ? 'green' : 'gray'">{{ o.demo ? '演示' : '既有原型数据' }}</span></td>
                  </tr>
                </tbody>
              </table>
            </div>

            <!-- 人员与岗位 -->
            <div class="divider-label">演示人员与岗位（Practitioner + PractitionerRole）</div>
            <a class="btn-link" @click="toggleGroup('pract')">{{ groups.pract ? '收起清单' : '展开清单（' + doctors.length + ' 人）' }}</a>
            <div class="table-wrap mt8" v-if="groups.pract">
              <table class="tbl">
                <thead><tr><th>Practitioner</th><th>姓名</th><th>职称</th><th>科室（PractitionerRole.organization）</th><th>岗位角色</th><th>可承担审批</th><th>可用等级</th><th>对应演示身份</th></tr></thead>
                <tbody>
                  <tr v-for="p in doctors">
                    <td class="muted" style="font-size:12px">{{ p.id }}</td><td><b>{{ p.name }}</b></td><td>{{ p.title }}</td>
                    <td>{{ p.dept }}</td>
                    <td><span class="tag blue" v-for="r in p.roles">{{ r }}</span></td>
                    <td>{{ p.canApprove ? '是' : '—' }}</td>
                    <td class="muted" style="font-size:12px">{{ p.levels.join('、') || '无授权' }}</td>
                    <td class="muted" style="font-size:12px">{{ p.identities.join('、') || '—' }}</td>
                  </tr>
                </tbody>
              </table>
              <div class="muted mt8" style="font-size:12px">岗位角色编码来自 CodeSystem/amr-role（审批节点可按「人员 / 科室 / 角色」引用），科室来自 PractitionerRole.organization 引用 Organization。</div>
            </div>

            <!-- 患者与就诊 -->
            <div class="divider-label">演示患者与就诊（Patient + Encounter）</div>
            <a class="btn-link" @click="toggleGroup('patient')">{{ groups.patient ? '收起清单' : '展开清单（' + patients.length + ' 人）' }}</a>
            <div class="table-wrap mt8" v-if="groups.patient">
              <table class="tbl">
                <thead><tr><th>患者</th><th>病历号</th><th>诊断</th><th>就诊</th></tr></thead>
                <tbody>
                  <tr v-for="p in patients">
                    <td><b>{{ p.name }}</b><div class="muted" style="font-size:12px">{{ p.id }}</div></td>
                    <td>{{ p.mrn }}</td><td class="muted" style="font-size:12px">{{ p.diagnosis }}</td>
                    <td>
                      <div v-for="e in p.encounters" style="font-size:12px"><span class="tag gray">{{ e.kind }}</span> {{ e.visitNo }} ｜ {{ e.start }} <span class="muted">（{{ e.id }}）</span></div>
                      <span v-if="!p.encounters.length" class="err-text">该患者没有关联 Encounter</span>
                    </td>
                  </tr>
                </tbody>
              </table>
            </div>

            <!-- 药品目录与等级 -->
            <div class="divider-label">抗菌药物目录与等级（Medication / MedicationKnowledge）</div>
            <a class="btn-link" @click="toggleGroup('drug')">{{ groups.drug ? '收起清单' : '展开按等级清单' }}</a>
            <div class="table-wrap mt8">
              <table class="tbl">
                <thead><tr><th>等级</th><th class="text-r">目录内药品数</th><th>SRS §11.4 指定的演示用药</th></tr></thead>
                <tbody>
                  <tr v-for="l in drugs.levels">
                    <td><level-tag :level="l.code"></level-tag></td>
                    <td class="text-r">{{ l.n }}</td>
                    <td class="muted" style="font-size:12px">{{ l.demo.join('、') || '（无演示标记药品）' }}</td>
                  </tr>
                </tbody>
              </table>
            </div>
            <div class="table-wrap mt8" v-if="groups.drug">
              <table class="tbl">
                <thead><tr><th>SRS §11.4 演示用药</th><th>演示编码</th><th>等级</th><th>规格</th><th>用法（演示）</th></tr></thead>
                <tbody>
                  <tr v-for="d in drugs.demoRows">
                    <td><b>{{ d.name }}</b><div class="muted" style="font-size:12px">{{ d.id }}</div></td>
                    <td>{{ d.code }}</td>
                    <td><level-tag :level="d.level"></level-tag></td>
                    <td class="muted" style="font-size:12px">{{ d.spec }}</td>
                    <td class="muted" style="font-size:12px">{{ d.usage || '—' }}</td>
                  </tr>
                </tbody>
              </table>
              <div class="muted mt8" style="font-size:12px">以上为带演示标记的三种等级用药；目录共 {{ drugs.total }} 条抗菌药物（含既有原型目录数据），完整清单请到「抗菌药物目录」页按等级检索。</div>
            </div>

            <!-- 流程定义版本 -->
            <div class="divider-label">流程定义版本（PlanDefinition）</div>
            <a class="btn-link" @click="toggleGroup('flow')">{{ groups.flow ? '收起清单' : '展开清单（' + flowVersions.length + ' 个版本）' }}</a>
            <div class="table-wrap mt8" v-if="groups.flow">
              <table class="tbl">
                <thead><tr><th>业务键</th><th>流程标题</th><th>版本</th><th>状态</th><th class="text-c">节点数</th><th>发布人 / 时间</th><th>canonical</th></tr></thead>
                <tbody>
                  <tr v-for="v in flowVersions">
                    <td>{{ v.key }}</td><td>{{ v.title }}</td><td>V{{ v.version }}</td>
                    <td><span class="tag" :class="v.status==='active' ? 'green' : (v.status==='draft' ? 'orange' : 'gray')">{{ v.status==='active' ? '已发布' : (v.status==='draft' ? '草稿' : v.status) }}</span></td>
                    <td class="text-c">{{ v.nodes }}</td>
                    <td class="muted" style="font-size:12px">{{ v.operator || '—' }}<span v-if="v.publishedAt"> ｜ {{ v.publishedAt }}</span></td>
                    <td class="muted" style="font-size:12px">{{ v.url }}|V{{ v.version }}</td>
                  </tr>
                </tbody>
              </table>
            </div>

            <!-- DEMO-01 核对结果 -->
            <div class="divider-label">DEMO-01 一键核对结果</div>
            <div v-if="!checked" class="alert info"><span>ℹ️</span>
              <div>点右上角「DEMO-01 一键核对」，逐项断言 SRS §11.1~11.5 的演示数据最小集是否满足（≥3 个科室、6 类演示用户、≥2 名患者与就诊、三个等级各至少 1 种药品、≥1 个已发布流程版本）。</div>
            </div>
            <div class="table-wrap" v-else>
              <table class="tbl">
                <thead><tr><th class="text-c" style="width:60px">结果</th><th>SRS 依据</th><th>核对项</th><th>要求</th><th>实际</th></tr></thead>
                <tbody>
                  <tr v-for="c in checks">
                    <td class="text-c"><span class="tag" :class="c.ok ? 'green' : 'red'">{{ c.ok ? '✓ 满足' : '✗ 缺项' }}</span></td>
                    <td class="nowrap">{{ c.ref }}</td><td><b>{{ c.name }}</b></td>
                    <td class="muted" style="font-size:12px">{{ c.need }}</td>
                    <td>{{ c.actual }}<div class="err-text" v-if="!c.ok">{{ c.missing }}</div></td>
                  </tr>
                </tbody>
              </table>
            </div>
          </div>
        </div>

        <!-- ================= 演示时钟 ================= -->
        <div class="card mt12" v-if="tab==='clock'">
          <div class="card-head"><h3>⏱️ 演示时钟（js/clock.js）</h3></div>
          <div class="card-body">
            <div class="kv">
              <span class="k">当前时钟时刻</span><span><b>{{ clock.now }}</b>（instant {{ clock.instant }}）</span>
              <span class="k">时钟模式</span><span>{{ clockModeName }}（数据读写模式 {{ clock.fhirMode }}，两者含义不同）</span>
              <span class="k">偏移分钟</span><span>{{ clock.offsetMinutes }}</span>
              <span class="k">冻结时刻</span><span>{{ clock.frozenAt || '—' }}</span>
              <span class="k">设置人 / 设置时间</span><span>{{ clock.setBy || '—' }} ｜ {{ clock.setAt || '—' }}</span>
              <span class="k">持久化位置</span><span>FHIR Basic/Basic-demo-clock（写穿透服务端，换浏览器仍是同一个演示时钟）</span>
              <span class="k">作用域 / 服务端</span><span>{{ clock.scope }} ｜ {{ clock.server || cfg.base }}</span>
            </div>

            <div class="alert info mt12"><span>💡</span>
              <div>用途：复现 SRS FR-008 的「24 小时内补审核」与超时。24 小时期限 = 补审核任务发起时间 + 流程节点配置的 deadlineHours，写入 Task.restriction.period.end；剩余时间与超时状态是<b>当前演示时钟与截止时间的比较结果</b>，不写库、不会自动改变任务状态，也不会自动写成「补审核完成」（FR-008.8）。演示中把时钟推进 25 小时即可看到「补审核超时」。</div>
            </div>

            <div class="divider-label">推进小时数</div>
            <div class="form-row">
              <label>推进</label>
              <div class="ctrl" style="flex-direction:row;align-items:center;gap:8px">
                <input type="number" min="1" v-model.number="clockForm.hours" style="width:100px"> <span class="hint">小时</span>
                <button class="btn primary" @click="advance">⏩ 推进演示时钟</button>
              </div>
            </div>
            <div class="divider-label">设为冻结时刻</div>
            <div class="form-row">
              <label>冻结到</label>
              <div class="ctrl" style="flex-direction:row;align-items:center;gap:8px">
                <input type="datetime-local" v-model="clockForm.frozenAt">
                <button class="btn" @click="freeze">❄️ 冻结</button>
                <button class="btn ghost" @click="toLive">▶ 恢复实时时钟</button>
              </div>
            </div>
            <div class="alert success mt8" v-if="clockMsg"><span>✅</span><div>{{ clockMsg }}</div></div>
            <div class="muted mt8" style="font-size:12px">时钟状态写在 Basic/Basic-demo-clock 里并随写穿落到服务端；其他浏览器或身份通过「重新查询服务端」即可读到同一个演示时钟（跨身份同步靠重新查询，不依赖任何消息推送能力）。</div>
          </div>
        </div>

        <!-- ================= 数据关联核查（DEMO-15） ================= -->
        <div class="card mt12" v-if="tab==='trace'">
          <div class="card-head"><h3>🔗 数据关联核查（FHIR Reference / Identifier）</h3></div>
          <div class="card-body">
            <div class="filter-bar mb12">
              <div class="field"><label>选择演示患者</label>
                <select v-model="tracePatient">
                  <option value="">请选择患者</option>
                  <option v-for="p in tracePatients" :value="p.id">{{ p.name }} ｜ {{ p.mrn }}（{{ p.id }}）</option>
                </select>
              </div>
            </div>
            <div class="alert info"><span>💡</span>
              <div>核查顺序：患者 → 就诊 → 抗菌药物开单（等级快照 / 用药目的 / 权限命中来源）→ 审批实例（绑定流程版本与节点数、instantiatesCanonical）→ 流程定义版本 → Provenance / AuditEvent 留痕。
              这些关联全部靠 FHIR <b>Reference</b>（Patient/Encounter/MedicationRequest/Task 互相引用）与 <b>Identifier</b>（演示业务编号，不依赖公共服务器可能变化的资源 ID）建立（SRS §9.1、DEMO-15 预期结果）。</div>
            </div>

            <empty-state v-if="!trace" text="请选择一名演示患者后开始逐层核查。"></empty-state>

            <template v-if="trace">
              <div class="alert danger mt8" v-if="trace.unlinked.length" style="display:block"><span>⛔</span>
                <div><b>以下开单未能关联到审批实例（异常）：</b>{{ trace.unlinked.join('、') }}。正常闭环中，需要审批的开单必须能通过 Task.focus 反查到 MedicationRequest、通过 Task.partOf 归到主任务；出现本提示请到审批中心核对，系统不会把它当作已审批通过。</div>
              </div>

              <div class="divider-label">① 患者</div>
              <div class="kv">
                <span class="k">Patient</span><span>{{ trace.patient.id }} ｜ {{ trace.patient.name }}</span>
                <span class="k">演示病历号（Identifier 口径）</span><span>{{ trace.patient.mrn }}</span>
                <span class="k">诊断</span><span>{{ trace.patient.diagnosis }}</span>
              </div>

              <div class="divider-label">② 就诊（Encounter.subject → Patient）</div>
              <div class="table-wrap">
                <table class="tbl" v-if="trace.encounters.length">
                  <thead><tr><th>Encounter</th><th>类别</th><th>就诊号</th><th>开始时间</th></tr></thead>
                  <tbody><tr v-for="e in trace.encounters"><td>{{ e.id }}</td><td>{{ e.kind }}</td><td>{{ e.visitNo }}</td><td class="nowrap">{{ e.start }}</td></tr></tbody>
                </table>
                <empty-state v-else text="该患者没有 Encounter 记录"></empty-state>
              </div>

              <div class="divider-label">③ 抗菌药物开单（MedicationRequest.subject / encounter / medicationReference）</div>
              <div class="table-wrap">
                <table class="tbl" v-if="trace.orders.length">
                  <thead><tr><th>开单号</th><th>药品</th><th>等级快照</th><th>用药目的</th><th>权限命中来源</th><th>医嘱状态</th><th>开单时间</th></tr></thead>
                  <tbody>
                    <tr v-for="o in trace.orders">
                      <td>{{ o.no }}<div class="muted" style="font-size:12px">{{ o.id }}</div></td>
                      <td><b>{{ o.drug }}</b> <level-tag :level="o.grade.level"></level-tag><div class="muted" style="font-size:12px">快照时间 {{ o.grade.at }} ｜ 来源 {{ o.grade.source }}</div></td>
                      <td class="muted" style="font-size:12px">{{ o.grade.name }}</td>
                      <td>{{ o.purpose ? o.purpose.name : '—' }}<div class="muted" style="font-size:12px">{{ o.purpose ? o.purpose.note : '' }}</div></td>
                      <td class="muted" style="font-size:12px">{{ o.authzHit ? (o.authzHit.srcLabel + ' — ' + o.authzHit.ruleText) : '—' }}</td>
                      <td><span class="tag" :class="o.emergency ? 'red' : 'gray'">{{ o.emergency ? '紧急越级' : '普通开单' }}</span>
                        <div class="muted" style="font-size:12px">{{ D.orderStatusName(o.status) }}</div></td>
                      <td class="nowrap">{{ o.authoredOn }}</td>
                    </tr>
                  </tbody>
                </table>
                <empty-state v-else text="该患者没有抗菌药物开单记录"></empty-state>
              </div>

              <div class="divider-label">④ 审批实例（Task.focus → MedicationRequest，Task.partOf → 主任务）</div>
              <div class="table-wrap">
                <table class="tbl" v-if="trace.tasks.length">
                  <thead><tr><th>主任务</th><th>申请编号</th><th>流程用途</th><th>绑定版本</th><th class="text-c">节点任务数</th><th>instantiatesCanonical</th><th>实例状态</th></tr></thead>
                  <tbody>
                    <tr v-for="t in trace.tasks">
                      <td>{{ t.id }}</td><td>{{ t.sqno }}</td>
                      <td><span class="tag blue">{{ D.flowPurposeName(t.purpose) }}</span></td>
                      <td>{{ t.version }}</td><td class="text-c">{{ t.nodes }}</td>
                      <td class="muted" style="font-size:12px">{{ t.canonical }}</td>
                      <td><span class="tag gray">{{ t.statusName }}</span></td>
                    </tr>
                  </tbody>
                </table>
                <empty-state v-else text="该患者的开单没有关联审批实例（若为直接开单则属正常）"></empty-state>
              </div>

              <div class="divider-label">⑤ 流程定义版本（PlanDefinition）</div>
              <div class="table-wrap">
                <table class="tbl" v-if="trace.flows.length">
                  <thead><tr><th>PlanDefinition</th><th>标题</th><th>业务版本</th><th>状态</th></tr></thead>
                  <tbody><tr v-for="f in trace.flows"><td>{{ f.id }}</td><td>{{ f.title }}</td><td>V{{ f.version }}</td>
                    <td><span class="tag" :class="f.status==='active' ? 'green' : (f.status==='draft' ? 'orange' : 'gray')">{{ f.status }}</span></td></tr></tbody>
                </table>
                <empty-state v-else text="无关联流程定义"></empty-state>
              </div>

              <div class="divider-label">⑥ 留痕（Provenance / AuditEvent，服务器支持时保留）</div>
              <div class="table-wrap">
                <table class="tbl" v-if="trace.provenance.length">
                  <thead><tr><th>时间</th><th>类型</th><th>内容</th><th>操作人</th></tr></thead>
                  <tbody><tr v-for="p in trace.provenance"><td class="nowrap">{{ p.time }}</td><td><span class="tag blue">{{ p.type }}</span></td><td>{{ p.content }}</td><td class="nowrap">{{ p.operator }}</td></tr></tbody>
                </table>
                <empty-state v-else text="该患者的关联资源尚无 Provenance 留痕"></empty-state>
              </div>
              <div class="table-wrap mt8" v-if="trace.auditEvents.length">
                <table class="tbl">
                  <thead><tr><th>审计时间</th><th>动作编码</th><th>内容</th><th>操作人</th></tr></thead>
                  <tbody><tr v-for="a in trace.auditEvents"><td class="nowrap">{{ a.time }}</td><td>{{ a.type }}</td><td>{{ a.content }}</td><td class="nowrap">{{ a.operator }}</td></tr></tbody>
                </table>
              </div>
              <div class="alert info mt8"><span>ℹ️</span>
                <div>DEMO-15 预期结果：<b>患者、就诊、药品、开单、审批任务与流程版本之间可以通过 FHIR Reference 或 Identifier 关联并查询到</b>。留痕数量与公共测试服务器的保留策略有关，读不到不代表业务未发生——本演示不把它写成「已审计」。</div>
              </div>
            </template>
          </div>
        </div>

        <!-- ================= 初始化与清理 ================= -->
        <div class="card mt12" v-if="tab==='init'">
          <div class="card-head"><h3>🧰 演示数据初始化与清理</h3></div>
          <div class="card-body">
            <div class="divider-label">前端动作</div>
            <div class="btn-row">
              <button class="btn" :disabled="busy==='requery'" @click="requery">{{ busy==='requery' ? '正在读取…' : '🔄 重新查询服务端' }}</button>
              <button class="btn primary" :disabled="busy==='push'" @click="pushToServer">{{ busy==='push' ? '正在装载…' : '⬆️ 把当前演示数据写入服务端' }}</button>
              <button class="btn danger" @click="hardReset">♻️ 恢复演示初始状态</button>
            </div>
            <div class="alert info mt12" style="display:block"><span>💡</span>
              <div>
                <div>· <b>重新查询服务端</b>：按 demo-scope 标签重新读取各类型资源替换本地镜像中来自服务端的条目（SRS FR-009.8：跨身份同步靠重新查询实现，本系统不虚构短信或消息推送）。</div>
                <div class="mt8">· <b>把当前演示数据写入服务端</b>：执行的是重新装载（App.reload）。服务端为空时会把本系统初始资源逐条 PUT 进去（保留语义化 ID），结果中的 pushed / loadedCount / failed 即本次真实情况；<b>若有失败会显示 sync.lastError 原文，不显示成功</b>。写入 HAPI 成功不等于服务端执行了审批流程（SRS §10.7）。</div>
                <div class="mt8">· <b>恢复演示初始状态</b>：这是<b>内存镜像级复位</b>——FHIR.reset() 会清空本地镜像并重新 seed 演示种子，本按钮用刷新页面实现最彻底的复位；<b>服务端数据保持不变</b>，如需清服务端数据请用下面的清理脚本。</div>
              </div>
            </div>
            <div class="alert" :class="initState && initState.failed ? 'danger' : 'success'" v-if="initMsg" style="display:block">
              <span>{{ initState && initState.failed ? '⛔' : '✅' }}</span><div>{{ initMsg }}</div>
            </div>
            <div class="alert danger mt8" v-if="stats.lastError"><span>⛔</span>
              <div>最近一次写穿透失败（真实错误，未重试成功）：<b>{{ stats.lastError.type }}/{{ stats.lastError.id }}</b>（{{ stats.lastError.action }}）——{{ stats.lastError.message }}<span v-if="stats.lastError.hapiCode"> ｜ HAPI 错误码 {{ stats.lastError.hapiCode }}</span></div>
            </div>

            <div class="divider-label">Python 脚本用法（与前端同一套资源，便于批量初始化/清理）</div>
            <div v-for="s in scriptLines" class="mt8">
              <div class="muted" style="font-size:12px;margin-bottom:4px">{{ s.name }}</div>
              <pre style="background:#0f1b2d;color:#cfe3ff;padding:10px 12px;border-radius:8px;font-size:12px;overflow:auto;white-space:pre-wrap">{{ s.text }}</pre>
            </div>
            <div class="alert warn mt12" style="display:block"><span>⚠️</span>
              <div>
                <div>· 清理脚本<b>只删除带本演示 demo-scope（{{ cfg.scope }}）标签的资源</b>，不会按类型全量清空公共服务器；未打标签的资源一律保留。</div>
                <div class="mt8">· {{ cfg.base }} 是<b>公共演示服务器</b>：无鉴权、数据公开，同一 scope 的数据可能被其他使用者读写，也可能被定期清库；本演示不保证数据长期存在，读不到时请重新初始化。</div>
                <div class="mt8">· 不要把真实患者数据写入该地址。演示数据全部为虚构（SRS BR-010），任何结果都不构成真实临床处方或真实审批决定。</div>
              </div>
            </div>

            <div class="divider-label">当前配置（供脚本参数复制）</div>
            <div class="kv">
              <span class="k">--base</span><span>{{ cfg.base }}</span>
              <span class="k">--scope</span><span>{{ cfg.scope }}</span>
              <span class="k">运行模式</span><span>{{ cfg.mode }}（服务端要求 FHIR R4 4.0.1，版本不符时前端会拒绝连接）</span>
              <span class="k">本地镜像总量</span><span>{{ dataset.total }} 条，共 {{ dataset.list.length }} 种资源类型</span>
            </div>
          </div>
        </div>
      </div>
    </div>`
  };
})(window);
