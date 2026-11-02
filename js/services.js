/* =====================================================================
 * services.js —— 业务服务层
 * 在 FHIR CRUD 之上封装业务操作，维护跨资源的业务一致性（联动逻辑），
 * 并为各页面提供易用的数据查询。所有写操作最终落到 FHIR 内存库。
 * ===================================================================== */
(function (global) {
  'use strict';
  var F = global.FHIR, D = global.Domain, R4 = global.FHIRR4;

  function now() {
    var d = new Date();
    function p(n) { return String(n).padStart(2, '0'); }
    return d.getFullYear() + '-' + p(d.getMonth() + 1) + '-' + p(d.getDate()) + ' ' + p(d.getHours()) + ':' + p(d.getMinutes());
  }
  // 展示用 'YYYY-MM-DD HH:mm'；写入 FHIR 的 instant 元素必须用 ISO 形态，
  // 否则服务端报 HAPI-1821 Invalid date/time format
  function nowInstant() {
    var d = new Date();
    function p(n) { return String(n).padStart(2, '0'); }
    // 带秒：分钟级时间戳会让同一分钟内的两条同内容审计记录被服务端判为重复而丢弃
    return d.getFullYear() + '-' + p(d.getMonth() + 1) + '-' + p(d.getDate())
      + 'T' + p(d.getHours()) + ':' + p(d.getMinutes()) + ':' + p(d.getSeconds());
  }
  function fmtInstant(s) { return (s || '').replace('T', ' ').slice(0, 16); }

  /* 变更记录：changeType 同时落到 Provenance.activity（R4 对该元素的语义即
   * 「发生的活动」），既比塞在扩展里规范，也让相邻两条记录内容不同。 */
  function audit(changeType, content) {
    return F.create({
      resourceType: 'Provenance', recorded: nowInstant(),
      activity: { coding: [{ code: 'amr-' + changeType, display: changeType }] },
      ext: { changeType: changeType, content: content, operator: global.App.currentUser().display }
    });
  }
  function genSqno() {
    var n = F.count('Task') + 1000;
    var d = new Date();
    function p(x) { return String(x).padStart(2, '0'); }
    return 'SQ-' + d.getFullYear() + p(d.getMonth() + 1) + p(d.getDate()) + '-' + n;
  }

  /* 服务端开启引用完整性校验：Task.for 必须指向已存在的 Patient，否则整单写入被
   * 400 拒收。按病案号找回患者，找不到就补建一个 Patient 资源，让申请与患者之间
   * 是可追溯的真实关联，而不是原型里的占位 'Patient/new'。 */
  function patientFor(payload) {
    if (!payload.mrn) return undefined;
    var hit = F.search('Patient', function (p) { return p.ext && p.ext.mrn === payload.mrn; })[0];
    if (hit) return { reference: 'Patient/' + hit.id, display: (hit.name[0] || {}).text };
    var created = F.create({
      resourceType: 'Patient',
      name: [{ text: payload.patientName || '未知患者' }],
      identifier: [{ value: payload.mrn }],
      ext: { mrn: payload.mrn, diagnosis: payload.diagnosis || '', infection: payload.infection || '' }
    });
    return { reference: 'Patient/' + created.id, display: created.name[0].text };
  }

  var Svc = {
    now: now,
    nowInstant: nowInstant,
    fmtInstant: fmtInstant,

    /* ============ 分级目录（Medication） ============ */
    medications: function (filter) {
      filter = filter || {};
      return F.search('Medication', function (m) {
        if (filter.keyword && (m.code.text || '').indexOf(filter.keyword) < 0) return false;
        if (filter.drugClass && filter.drugClass !== 'all' && m.ext.drugClass.indexOf(filter.drugClass) < 0) return false;
        if (filter.level && filter.level !== 'all' && m.ext.level !== filter.level) return false;
        return true;
      }).sort(function (a, b) { return a.id.localeCompare(b.id); });
    },
    levelCounts: function () {
      var all = F.search('Medication');
      var c = { all: all.length, unrestricted: 0, restricted: 0, special: 0 };
      all.forEach(function (m) { c[m.ext.level]++; });
      return c;
    },
    saveMedication: function (data, isNew) {
      var res;
      if (isNew) {
        res = F.create({ resourceType: 'Medication', code: { text: data.name }, status: 'active', ext: data.ext });
        this.bumpCatalogVersion('新增药品「' + data.name + '」');
        this.markKbPendingSync();
      } else {
        var cur = F.read('Medication', data.id);
        cur.code.text = data.name; cur.ext = data.ext;
        res = F.update(cur);
        this.bumpCatalogVersion('编辑药品「' + data.name + '」');
      }
      return res;
    },
    deleteMedication: function (id) {
      var m = F.read('Medication', id);
      F.remove('Medication', id);
      if (m) this.bumpCatalogVersion('删除药品「' + m.code.text + '」');
    },
    bumpCatalogVersion: function (note) {
      var b = F.read('Basic', 'Basic-catalog-version');
      var parts = b.ext.version.replace('v', '').split('.');
      parts[1] = String(parseInt(parts[1], 10) + 1);
      b.ext.version = 'v' + parts.join('.');
      b.ext.updatedAt = now().split(' ')[0];
      F.update(b);
      audit('目录版本', note + '，更新至 ' + b.ext.version);
    },
    catalogVersion: function () { return F.read('Basic', 'Basic-catalog-version').ext; },

    /* ============ 权限映射（Permission level-mapping）============ */
    mappingRules: function () {
      return D.LEVELS.map(function (lv) {
        var p = F.read('Permission', 'Permission-map-' + lv.code);
        return { level: lv.code, levelName: lv.name, allowedTitles: p.ext.allowedTitles, approvals: p.ext.approvals };
      });
    },
    saveMappingRule: function (level, allowedTitles, approvals) {
      var p = F.read('Permission', 'Permission-map-' + level);
      p.ext.allowedTitles = allowedTitles; p.ext.approvals = approvals;
      F.update(p);
      // 联动卡控规则：审批校验项随映射同步
      var g = F.read('Permission', 'Permission-gate-' + level);
      g.ext.approvalCheck = approvals.slice();
      g.ext.interceptOnNotApproved = approvals.length ? g.ext.interceptOnNotApproved : 'none';
      F.update(g);
      audit('权限映射', D.levelName(level) + '映射规则更新');
    },
    // 职称 -> 可开具分级（由映射规则派生）
    titleMatrix: function () {
      var rules = this.mappingRules();
      return D.TITLES.map(function (t) {
        var row = { title: t.code, titleName: t.name };
        D.LEVELS.forEach(function (lv) {
          var r = rules.filter(function (x) { return x.level === lv.code; })[0];
          row[lv.code] = r.allowedTitles.indexOf(t.code) >= 0;
        });
        return row;
      });
    },
    // 编辑职称权限 -> 反写映射规则（联动）
    saveTitlePrivilege: function (title, levels) {
      D.LEVELS.forEach(function (lv) {
        var p = F.read('Permission', 'Permission-map-' + lv.code);
        var has = p.ext.allowedTitles.indexOf(title) >= 0;
        var want = levels.indexOf(lv.code) >= 0;
        if (want && !has) p.ext.allowedTitles.push(title);
        if (!want && has) p.ext.allowedTitles.splice(p.ext.allowedTitles.indexOf(title), 1);
        F.update(p);
      });
      audit('职称权限', D.titleName(title) + '处方权限范围调整');
    },
    // 职称变更影响预览：在岗医师数 + 科室分布（演示用真实化数据）
    titleImpact: function (title) {
      var data = {
        chief: { total: 18, byDept: [{ dept: '内科', count: 4, holding: 4 }, { dept: '外科', count: 3, holding: 3 }, { dept: '其他科室', count: 11, holding: 11 }] },
        associate: { total: 24, byDept: [{ dept: '呼吸内科', count: 6, holding: 6 }, { dept: '普外科', count: 5, holding: 5 }, { dept: '其他科室', count: 13, holding: 13 }] },
        attending: { total: 56, byDept: [{ dept: '内科', count: 12, holding: 12 }, { dept: '外科', count: 10, holding: 10 }, { dept: '其他科室', count: 34, holding: 34 }] },
        resident: { total: 73, byDept: [{ dept: '内科', count: 15, holding: 0 }, { dept: '外科', count: 14, holding: 0 }, { dept: '其他科室', count: 44, holding: 0 }] }
      };
      return data[title] || { total: 0, byDept: [] };
    },
    // 权限预览：某职称可开具的药品
    previewDrugsForTitle: function (title) {
      var matrix = this.titleMatrix().filter(function (r) { return r.title === title; })[0];
      var levels = D.LEVELS.filter(function (lv) { return matrix[lv.code]; }).map(function (lv) { return lv.code; });
      return F.search('Medication', function (m) {
        return levels.indexOf(m.ext.level) >= 0 && m.ext.allowedTitles.indexOf(title) >= 0;
      });
    },

    /* ============ 卡控规则（Permission gatekeeping）============ */
    gatekeepRules: function () {
      return D.LEVELS.map(function (lv) {
        var p = F.read('Permission', 'Permission-gate-' + lv.code);
        return Object.assign({ level: lv.code, levelName: lv.name }, p.ext);
      });
    },
    saveGatekeepRule: function (level, data) {
      var p = F.read('Permission', 'Permission-gate-' + level);
      var oldApprovals = (p.ext.approvalCheck || []).slice();
      Object.assign(p.ext, data);
      F.update(p);
      var st = F.read('Basic', 'Basic-gatekeep-status');
      st.ext.lastModified = now(); st.ext.operator = global.App.currentUser().display;
      F.update(st);
      audit('卡控规则', D.levelName(level) + '卡控规则调整（职称校验/审批校验/拦截动作）');

      // 审批状态校验项变更时，同步权限映射规则表与该分级下未单独调整权限的药品，保持三处数据一致
      if (data.approvalCheck) {
        var newApprovals = data.approvalCheck.slice();
        var changed = newApprovals.length !== oldApprovals.length || newApprovals.some(function (a) { return oldApprovals.indexOf(a) < 0; });
        if (changed) {
          var mp = F.read('Permission', 'Permission-map-' + level);
          mp.ext.approvals = newApprovals.slice();
          F.update(mp);
          var affected = 0;
          F.search('Medication', function (m) { return m.ext.level === level && !m.ext.overridden; }).forEach(function (m) {
            m.ext.approvals = newApprovals.slice();
            F.update(m);
            affected++;
          });
          audit('权限映射', D.levelName(level) + '审批要求由卡控规则同步调整，已联动更新 ' + affected + ' 个药品的权限映射');
        }
      }
    },
    gatekeepLogs: function () { return this.provenance('卡控规则'); },
    gatekeepStatus: function () { return F.read('Basic', 'Basic-gatekeep-status').ext; },
    saveGatekeepStatus: function (ext) { var b = F.read('Basic', 'Basic-gatekeep-status'); Object.assign(b.ext, ext); return F.update(b); },

    /* ============ 适应症知识库（ClinicalUseDefinition / Citation）============ */
    indications: function (filter) {
      filter = filter || {};
      return F.search('ClinicalUseDefinition', function (c) {
        if (filter.drug && (c.ext.drug || '').indexOf(filter.drug) < 0) return false;
        if (filter.keyword && (c.ext.description || '').indexOf(filter.keyword) < 0) return false;
        return true;
      });
    },
    saveIndication: function (data, isNew) {
      if (isNew) return F.create({ resourceType: 'ClinicalUseDefinition', type: 'indication', ext: data.ext });
      var cur = F.read('ClinicalUseDefinition', data.id); cur.ext = data.ext; return F.update(cur);
    },
    deleteIndication: function (id) { F.remove('ClinicalUseDefinition', id); },
    citations: function () { return F.search('Citation'); },
    saveCitation: function (data, isNew) {
      if (isNew) return F.create({ resourceType: 'Citation', title: data.title, status: 'active', ext: data.ext });
      var cur = F.read('Citation', data.id); cur.title = data.title; cur.ext = data.ext; return F.update(cur);
    },
    // 审核结果统计（演示用：各药品适应症审核通过率 + 驳回原因分布）
    indicationAuditStats: function () {
      return {
        passRates: [
          { drug: '美罗培南', rate: 86 }, { drug: '亚胺培南', rate: 82 },
          { drug: '万古霉素', rate: 90 }, { drug: '利奈唑胺', rate: 78 }, { drug: '左氧氟沙星', rate: 71 }
        ],
        rejectReasons: [
          { reason: '缺少药敏/病原学依据', count: 38 },
          { reason: '用药指征不符', count: 21 },
          { reason: '用药时长偏长', count: 14 },
          { reason: '可降阶梯治疗', count: 9 }
        ]
      };
    },
    kbVersion: function () { return F.read('Basic', 'Basic-kb-version').ext; },
    markKbPendingSync: function () { var b = F.read('Basic', 'Basic-kb-version'); b.ext.pendingSync = true; b.ext.catalogUpdatedAt = now().split(' ')[0]; F.update(b); },
    syncKb: function () {
      var b = F.read('Basic', 'Basic-kb-version');
      b.ext.pendingSync = false; b.ext.updatedAt = now().split(' ')[0];
      b.ext.count = F.count('ClinicalUseDefinition');
      var parts = b.ext.version.replace('v', '').split('.'); parts[1] = String(parseInt(parts[1], 10) + 1);
      b.ext.version = 'v' + parts.join('.');
      return F.update(b);
    },
    // 适应症校验（供审批页调用）
    validateIndication: function (drug, infection) {
      var stds = this.indications({ drug: drug });
      var results = [];
      if (stds.length) {
        var matched = stds.filter(function (s) { return (infection || '').indexOf(s.ext.description.slice(0, 2)) >= 0 || (s.ext.description.indexOf('ESBLs') >= 0 && (infection || '').indexOf('ESBLs') >= 0) || (s.ext.description.indexOf('MRSA') >= 0 && (infection || '').indexOf('MRSA') >= 0); });
        results.push({ icon: matched.length ? 'ok' : 'warn', text: matched.length ? '适应症匹配：' + matched[0].ext.description : '适应症待人工复核：未自动匹配到标准条目' });
      } else {
        results.push({ icon: 'warn', text: '知识库暂无该药品适应症标准，需人工判断' });
      }
      results.push({ icon: (infection || '').match(/培养|药敏|ESBLs|MRSA/) ? 'ok' : 'warn', text: (infection || '').match(/培养|药敏|ESBLs|MRSA/) ? '病原学送检：已有送检/药敏记录' : '病原学送检：未见明确送检记录，建议补充' });
      return results;
    },

    /* ============ 处方权限申请（Task）============ */
    applicationsForDoctor: function (practitionerId) {
      return F.search('Task', function (t) { return t.requester.reference === 'Practitioner/' + practitionerId; })
        .sort(function (a, b) { return (b.authoredOn || '').localeCompare(a.authoredOn || ''); });
    },
    // 审批人可见：流转经过该角色节点的申请（待处理 + 已处理历史）
    applicationsForApprover: function (role) {
      return F.search('Task', function (t) {
        var flow = t.ext.flow || [];
        return flow.some(function (n) { return n.role === role; });
      }).sort(function (a, b) { return (b.authoredOn || '').localeCompare(a.authoredOn || ''); });
    },
    // 当前是否轮到该角色处理（流程节点处于 current 状态）
    isMyTurn: function (t, role) {
      return (t.ext.flow || []).some(function (n) { return n.role === role && n.status === 'current'; });
    },
    // 该角色历史审批的平均办理时长（小时，取节点变为 current 到审结的间隔）
    avgApprovalHours: function (role) {
      var tasks = this.applicationsForApprover(role);
      var durations = [];
      tasks.forEach(function (t) {
        var flow = t.ext.flow || [];
        for (var i = 0; i < flow.length; i++) {
          var n = flow[i];
          if (n.role !== role || (n.status !== 'approved' && n.status !== 'rejected') || !n.time) continue;
          var prevTime = i === 0 ? t.authoredOn : (flow[i - 1].time || t.authoredOn);
          if (!prevTime) continue;
          var h = (new Date(n.time.replace(' ', 'T')) - new Date(prevTime.replace(' ', 'T'))) / 36e5;
          if (h >= 0 && isFinite(h)) durations.push(h);
        }
      });
      if (!durations.length) return 0;
      return Math.round(durations.reduce(function (a, b) { return a + b; }, 0) / durations.length * 10) / 10;
    },
    submitApplication: function (payload) {
      var roles = payload.type === 'special' ? ['dept', 'pharmacy', 'expert'] : ['dept', 'pharmacy'];
      var NODE = { dept: '科室负责人', pharmacy: '药学部门', expert: '审批专家' };
      var flow = roles.map(function (r, i) { return { seq: i + 1, role: r, roleName: NODE[r], status: 'pending', approver: '', time: '' }; });
      var u = global.App.currentUser();
      // 演示环境无「科室负责人」独立登录角色，该节点系统自动通过；药学部门（及特殊使用级下的审批专家）需人工审批
      flow[0].status = 'approved'; flow[0].approver = '科室负责人'; flow[0].time = now();
      flow[1].status = 'current';
      var status = 'in-progress', businessStatus = '待药学部门审批';
      var t = F.create({
        resourceType: 'Task', identifier: [{ value: genSqno() }], status: status, intent: 'order', authoredOn: nowInstant(),
        businessStatus: { text: businessStatus },
        for: patientFor(payload),
        requester: { reference: 'Practitioner/' + u.practitioner, display: u.name },
        ext: {
          type: payload.type, drug: payload.drug, dept: payload.dept, requesterTitle: u.title,
          useStart: payload.useStart, useEnd: payload.useEnd, reason: payload.reason,
          patientName: payload.patientName, mrn: payload.mrn, diagnosis: payload.diagnosis, infection: payload.infection,
          patientAge: payload.patientAge || null, patientGender: payload.patientGender || '', patientDept: payload.patientDept || '',
          attachments: payload.attachments || [],
          flow: flow, decision: null
        }
      });
      F.create({ resourceType: 'Communication', status: 'completed', ext: { category: 'dynamic', time: now(), type: '提交', content: u.name + '-' + payload.drug + (payload.type === 'special' ? '特殊' : '限制') + '使用级申请已提交', target: 'doctor,expert,pharmacy' } });
      F.create({ resourceType: 'Communication', status: 'completed', ext: { category: 'notification', time: now(), type: '审批待办', content: '新的' + D.levelName(payload.type) + '申请（' + payload.drug + '）待您审批', target: 'pharmacy', unread: true } });
      return t;
    },
    // 通用审批推进：对当前处于 current 状态、且与操作人角色匹配的节点做出决定；
    // 通过则推进到下一节点（无下一节点则整单通过），驳回则整单驳回
    approveApplication: function (taskId, result, reason) {
      var t = F.read('Task', taskId);
      var u = global.App.currentUser();
      var flow = t.ext.flow || [];
      var idx = -1;
      for (var i = 0; i < flow.length; i++) { if (flow[i].status === 'current') { idx = i; break; } }
      if (idx < 0) return t; // 无待处理节点，直接返回
      var node = flow[idx];
      if (result !== 'approved') {
        node.status = 'rejected'; node.approver = u.name; node.time = now();
        t.status = 'rejected'; t.businessStatus = { text: '已驳回' };
        t.ext.decision = { result: 'rejected', by: u.name, time: now(), reason: reason || '' };
      } else {
        node.status = 'approved'; node.approver = u.name; node.time = now();
        if (idx === flow.length - 1) {
          t.status = 'completed'; t.businessStatus = { text: '已通过' };
          t.ext.decision = { result: 'approved', by: u.name, time: now(), reason: reason || '' };
        } else {
          flow[idx + 1].status = 'current';
          t.status = 'in-progress'; t.businessStatus = { text: '待' + flow[idx + 1].roleName + '审批' };
        }
      }
      t.ext.flow = flow;
      F.update(t);
      F.create({ resourceType: 'Communication', status: 'completed', ext: { category: 'dynamic', time: now(), type: result === 'approved' ? '通过' : '驳回', content: (t.requester.display || '医师') + '-' + t.ext.drug + '申请经' + node.roleName + (result === 'approved' ? '审核通过' : '被驳回'), target: 'expert,pharmacy,admin,doctor' } });
      if (t.status === 'in-progress') {
        F.create({ resourceType: 'Communication', status: 'completed', ext: { category: 'notification', time: now(), type: '审批待办', content: '新的' + D.levelName(t.ext.type) + '申请（' + t.ext.drug + '）待您审批', target: flow[idx + 1].role, unread: true } });
      } else {
        F.create({ resourceType: 'Communication', status: 'completed', ext: { category: 'notification', time: now(), type: '审批结果', content: '您的' + t.ext.drug + '处方权限申请' + (t.status === 'completed' ? '已通过' : '被驳回'), target: 'doctor', unread: true } });
      }
      return t;
    },
    withdrawApplication: function (taskId) {
      var t = F.read('Task', taskId);
      t.status = 'cancelled'; t.businessStatus = { text: '已撤回' };
      return F.update(t);
    },

    /* ============ 审批流程（PlanDefinition）============ */
    workflows: function () { return F.search('PlanDefinition').sort(function (a, b) { return a.id.localeCompare(b.id); }); },
    saveWorkflow: function (data, isNew) {
      if (isNew) return F.create({ resourceType: 'PlanDefinition', status: 'active', title: data.title, ext: data.ext });
      var cur = F.read('PlanDefinition', data.id); cur.title = data.title; cur.ext = data.ext; if (data.status) cur.status = data.status; return F.update(cur);
    },
    toggleWorkflow: function (id) {
      var p = F.read('PlanDefinition', id); p.status = p.status === 'active' ? 'retired' : 'active'; return F.update(p);
    },
    // 某分级下进行中的审批数量（用于流程停用校验）
    runningApprovalCount: function (level) {
      return F.count('Task', function (t) { return t.status === 'in-progress' && t.ext.type === level; });
    },

    /* ============ 监测分析：基于真实用药记录（MedicationAdministration）动态统计 ============ */
    // 原始用药记录检索（可按科室/时间范围/药品分类/分级级别/医师职称过滤）
    usageRecords: function (filter) {
      filter = filter || {};
      return F.search('MedicationAdministration', function (r) {
        var e = r.ext;
        if (filter.dept && filter.dept !== 'all' && e.dept !== filter.dept) return false;
        if (filter.dateStart && e.date < filter.dateStart) return false;
        if (filter.dateEnd && e.date > filter.dateEnd) return false;
        if (filter.drugClass && filter.drugClass !== 'all' && e.drugClass !== filter.drugClass) return false;
        if (filter.level && filter.level !== 'all' && e.level !== filter.level) return false;
        if (filter.title && filter.title !== 'all' && e.doctorTitle !== filter.title) return false;
        return true;
      });
    },
    usageDateRange: function () {
      var dates = F.search('MedicationAdministration').map(function (r) { return r.ext.date; }).sort();
      return { start: dates[0] || '', end: dates[dates.length - 1] || '' };
    },
    drugClasses: function () {
      var set = {};
      F.search('Medication').forEach(function (m) { if (m.ext.drugClass) set[m.ext.drugClass] = true; });
      return Object.keys(set).sort();
    },
    // 监测概览：核心指标 + 趋势 + 科室排名（均由用药记录实时聚合计算，而非写死数据）
    computeOverview: function (filter) {
      var recs = this.usageRecords(filter);
      var beds = D.DEPT_BEDS, depts = Object.keys(beds);
      function sumDdd(arr) { return arr.reduce(function (s, r) { return s + r.ext.ddd; }, 0); }
      function pct(n, d) { return d ? +(n / d * 100).toFixed(1) : 0; }
      var dates = (function () { var set = {}; recs.forEach(function (r) { set[r.ext.date] = true; }); return Object.keys(set).sort(); })();
      var totalDays = dates.length || 1;
      var totalBeds = depts.reduce(function (s, d) { return s + beds[d]; }, 0);
      var totalDDD = sumDdd(recs);
      var intensity = totalBeds ? +(totalDDD / (totalBeds * totalDays) * 100).toFixed(1) : 0;
      var submissionRate = pct(recs.filter(function (r) { return r.ext.submitted; }).length, recs.length);
      var specialRatio = pct(sumDdd(recs.filter(function (r) { return r.ext.level === 'special'; })), totalDDD);

      var mid = dates[Math.floor(dates.length / 2)] || '';
      function half(isFirst) { return recs.filter(function (r) { return isFirst ? r.ext.date < mid : r.ext.date >= mid; }); }
      function trendOf(getVal) {
        var a = getVal(half(true)), b = getVal(half(false));
        if (!a) return { delta: 0, dir: 'flat' };
        var d = +(((b - a) / a) * 100).toFixed(1);
        return { delta: Math.abs(d), dir: d > 0.5 ? 'up' : (d < -0.5 ? 'down' : 'flat') };
      }
      var dddTrend = trendOf(function (arr) { return sumDdd(arr); });
      var srTrend = trendOf(function (arr) { return pct(arr.filter(function (r) { return r.ext.submitted; }).length, arr.length); });
      var spTrend = trendOf(function (arr) { return pct(sumDdd(arr.filter(function (r) { return r.ext.level === 'special'; })), sumDdd(arr)); });

      var departmentRanking = depts.map(function (dept) {
        var dRecs = recs.filter(function (r) { return r.ext.dept === dept; });
        var a = sumDdd(dRecs.filter(function (r) { return r.ext.date < mid; }));
        var b = sumDdd(dRecs.filter(function (r) { return r.ext.date >= mid; }));
        var dir = b > a * 1.05 ? 'up' : (b < a * 0.95 ? 'down' : 'flat');
        return { dept: dept, ddd: +sumDdd(dRecs).toFixed(1), dir: dir };
      }).sort(function (a, b) { return b.ddd - a.ddd; });

      var trendDdd = dates.map(function (ds) { return +sumDdd(recs.filter(function (r) { return r.ext.date === ds; })).toFixed(1); });
      var trendSr = dates.map(function (ds) {
        var dRecs = recs.filter(function (r) { return r.ext.date === ds; });
        return pct(dRecs.filter(function (r) { return r.ext.submitted; }).length, dRecs.length);
      });

      return {
        period: filter && (filter.dateStart || filter.dateEnd) ? (filter.dateStart || '') + ' ~ ' + (filter.dateEnd || '') : '近' + totalDays + '天',
        indicators: {
          ddd: { value: intensity, delta: dddTrend.delta, dir: dddTrend.dir },
          submissionRate: { value: submissionRate, delta: srTrend.delta, dir: srTrend.dir },
          specialRatio: { value: specialRatio, delta: spTrend.delta, dir: spTrend.dir }
        },
        catalogStats: { total: F.count('Medication'), pendingUpdate: F.count('Medication', function (m) { return m.ext.pendingUpdate === true; }) },
        departmentRanking: departmentRanking,
        trend: { days: dates.length, dates: dates, ddd: trendDdd, submissionRate: trendSr }
      };
    },
    overview: function (filter) { return this.computeOverview(filter); },
    alerts: function () { return F.search('DetectedIssue', function (i) { return i.ext.type.indexOf('送检') < 0 || true; }).sort(function (a, b) { return b.ext.time.localeCompare(a.ext.time); }); },
    surgeries: function () { return F.search('Observation', function (o) { return o.ext.category === 'surgical-prophylaxis'; }); },
    // 统计报表 4 张表 + 分级占比（均由用药记录实时聚合计算）
    computeReportTables: function (filter) {
      var recs = this.usageRecords(filter);
      var beds = D.DEPT_BEDS, doctorsMap = D.DEPT_DOCTORS;
      function sumDdd(arr) { return arr.reduce(function (s, r) { return s + r.ext.ddd; }, 0); }
      function pct(n, d) { return d ? +(n / d * 100).toFixed(1) : 0; }
      var dates = (function () { var set = {}; recs.forEach(function (r) { set[r.ext.date] = true; }); return Object.keys(set); })();
      var totalDays = dates.length || 1;

      var depts = Object.keys(beds).filter(function (d) { return !filter || !filter.dept || filter.dept === 'all' || filter.dept === d; });
      var summary = depts.map(function (dept) {
        var dRecs = recs.filter(function (r) { return r.ext.dept === dept; });
        var ddd = sumDdd(dRecs);
        var intensity = beds[dept] ? +(ddd / (beds[dept] * totalDays) * 100).toFixed(1) : 0;
        var submission = pct(dRecs.filter(function (r) { return r.ext.submitted; }).length, dRecs.length);
        var sp = pct(sumDdd(dRecs.filter(function (r) { return r.ext.level === 'special'; })), ddd);
        return { dept: dept, ddd: ddd.toFixed(1), intensity: intensity, submission: submission + '%', specialRatio: sp + '%' };
      });
      var totalDdd = sumDdd(recs);
      var totalBedsAll = Object.keys(beds).reduce(function (s, d) { return s + beds[d]; }, 0);
      summary.push({
        dept: '合计', ddd: totalDdd.toFixed(1),
        intensity: totalBedsAll ? +(totalDdd / (totalBedsAll * totalDays) * 100).toFixed(1) : 0,
        submission: pct(recs.filter(function (r) { return r.ext.submitted; }).length, recs.length) + '%',
        specialRatio: pct(sumDdd(recs.filter(function (r) { return r.ext.level === 'special'; })), totalDdd) + '%',
        total: true
      });

      var deptDetail = [];
      Object.keys(doctorsMap).forEach(function (dept) {
        if (filter && filter.dept && filter.dept !== 'all' && filter.dept !== dept) return;
        doctorsMap[dept].forEach(function (doc) {
          if (filter && filter.title && filter.title !== 'all' && filter.title !== doc.title) return;
          var dRecs = recs.filter(function (r) { return r.ext.dept === dept && r.ext.doctor === doc.name; });
          if (!dRecs.length) return;
          deptDetail.push({
            dept: dept, doctor: doc.name, title: doc.title, rx: dRecs.length,
            ddd: +sumDdd(dRecs).toFixed(1),
            submission: pct(dRecs.filter(function (r) { return r.ext.submitted; }).length, dRecs.length) + '%',
            special: dRecs.filter(function (r) { return r.ext.level === 'special'; }).length
          });
        });
      });

      var doctorRx = deptDetail.map(function (row) {
        var dRecs = recs.filter(function (r) { return r.ext.dept === row.dept && r.ext.doctor === row.doctor; });
        return {
          doctor: row.doctor, title: row.title, dept: row.dept, total: row.rx,
          unrestricted: dRecs.filter(function (r) { return r.ext.level === 'unrestricted'; }).length,
          restricted: dRecs.filter(function (r) { return r.ext.level === 'restricted'; }).length,
          special: dRecs.filter(function (r) { return r.ext.level === 'special'; }).length,
          submission: row.submission
        };
      });

      var drugNames = {}; recs.forEach(function (r) { drugNames[r.ext.drug] = true; });
      var drugUse = Object.keys(drugNames).map(function (name) {
        var dRecs = recs.filter(function (r) { return r.ext.drug === name; });
        var depSet = {}; dRecs.forEach(function (r) { depSet[r.ext.dept] = true; });
        return {
          drug: name, drugClass: dRecs[0].ext.drugClass, level: dRecs[0].ext.level,
          ddd: +sumDdd(dRecs).toFixed(1), persons: dRecs.length,
          submission: pct(dRecs.filter(function (r) { return r.ext.submitted; }).length, dRecs.length) + '%',
          depts: Object.keys(depSet).length
        };
      }).sort(function (a, b) { return b.ddd - a.ddd; });

      var levelDdd = { unrestricted: 0, restricted: 0, special: 0 };
      recs.forEach(function (r) { levelDdd[r.ext.level] += r.ext.ddd; });
      var levelSplit = [
        { label: '非限制使用级', value: pct(levelDdd.unrestricted, totalDdd), color: '#16a34a' },
        { label: '限制使用级', value: pct(levelDdd.restricted, totalDdd), color: '#d97706' },
        { label: '特殊使用级', value: pct(levelDdd.special, totalDdd), color: '#dc2626' }
      ];

      return { summary: summary, deptDetail: deptDetail, doctorRx: doctorRx, drugUse: drugUse, levelSplit: levelSplit };
    },
    reports: function (filter) { return this.computeReportTables(filter); },
    handleAlert: function (id) { var i = F.read('DetectedIssue', id); i.ext.handled = true; i.status = 'mitigated'; return F.update(i); },

    /* ============ 动态 / 公告 / 通知 ============ */
    dynamics: function (role) {
      return F.search('Communication', function (c) { return c.ext.category === 'dynamic' && (c.ext.target === 'all' || c.ext.target.indexOf(role) >= 0); })
        .sort(function (a, b) { return b.ext.time.localeCompare(a.ext.time); });
    },
    announcements: function () { return F.search('Communication', function (c) { return c.ext.category === 'announcement'; }).sort(function (a, b) { return b.ext.time.localeCompare(a.ext.time); }); },
    notifications: function (role) { return F.search('Communication', function (c) { return c.ext.category === 'notification' && (c.ext.target === 'all' || c.ext.target.indexOf(role) >= 0); }).sort(function (a, b) { return b.ext.time.localeCompare(a.ext.time); }); },
    unreadCount: function (role) { return this.notifications(role).filter(function (n) { return n.ext.unread; }).length; },
    markAllRead: function (role) { this.notifications(role).forEach(function (n) { var r = F.read('Communication', n.id); r.ext.unread = false; F.update(r); }); },

    /* ============ 变更记录（Provenance）============ */
    provenance: function (type) { return F.search('Provenance', function (p) { return !type || p.ext.changeType === type; }).sort(function (a, b) { return b.recorded.localeCompare(a.recorded); }); },

    /* ============ 外部系统 / 配置单例 ============ */
    endpoints: function () { return F.search('Endpoint'); },
    saveEndpoint: function (id, ext) { var e = F.read('Endpoint', id); Object.assign(e.ext, ext); return F.update(e); },
    basic: function (code) { var b = F.read('Basic', 'Basic-' + code); return b ? b.ext : null; },
    saveBasic: function (code, ext) { var b = F.read('Basic', 'Basic-' + code); Object.assign(b.ext, ext); return F.update(b); },

    /* ============ 用户角色权限配置（各页面可访问角色） ============ */
    rolePermissions: function () { return this.basic('role-permissions').pages; },
    saveRolePermissions: function (pages) {
      this.saveBasic('role-permissions', { pages: pages });
      audit('角色权限', '用户角色页面访问权限已调整');
    },

    /* ============ 首页统计（按角色差异化）============ */
    homeApprovalData: function (role, user) {
      if (role === 'doctor') {
        var mine = this.applicationsForDoctor(user.practitioner);
        return { title: '我的申请', cards: [
          { label: '已提交申请', value: mine.length, unit: '件' },
          { label: '待审批', value: mine.filter(function (t) { return t.status === 'in-progress' || t.status === 'requested'; }).length, unit: '件' },
          { label: '已通过', value: mine.filter(function (t) { return t.status === 'completed'; }).length, unit: '件' }
        ] };
      }
      if (role === 'expert' || role === 'pharmacy') {
        var self = this, all = this.applicationsForApprover(role);
        return { title: '审批工作量', cards: [
          { label: '待审批', value: all.filter(function (t) { return self.isMyTurn(t, role); }).length, unit: '件' },
          { label: '本月审批', value: all.filter(function (t) { return t.status === 'completed' || t.status === 'rejected'; }).length, unit: '件' },
          { label: '平均审批时长', value: this.avgApprovalHours(role), unit: '小时' }
        ] };
      }
      if (role === 'admin') {
        var wf = this.workflows();
        return { title: '审批流程概览', cards: [
          { label: '审批流程总数', value: wf.length, unit: '个' },
          { label: '进行中审批', value: F.count('Task', function (t) { return t.status === 'in-progress'; }), unit: '件' },
          { label: '已完成审批', value: F.count('Task', function (t) { return t.status === 'completed' || t.status === 'rejected'; }), unit: '件' }
        ] };
      }
      return null; // quality 无审批数据区
    },
    homeIndicators: function (role) {
      var ov = this.overview();
      if (role === 'quality') {
        return [
          { label: '本月用药强度', value: ov.indicators.ddd.value, unit: 'DDD', delta: ov.indicators.ddd.delta, dir: ov.indicators.ddd.dir },
          { label: '送检率', value: ov.indicators.submissionRate.value + '%', delta: ov.indicators.submissionRate.delta, dir: ov.indicators.submissionRate.dir },
          { label: '特殊使用级使用占比', value: ov.indicators.specialRatio.value + '%', delta: ov.indicators.specialRatio.delta, dir: ov.indicators.specialRatio.dir }
        ];
      }
      if (role === 'pharmacy') {
        return [
          { label: '目录药品数', value: ov.catalogStats.total, unit: '种' },
          { label: '待更新药品', value: ov.catalogStats.pendingUpdate, unit: '种' },
          { label: '特殊使用级使用占比', value: ov.indicators.specialRatio.value + '%', delta: ov.indicators.specialRatio.delta, dir: ov.indicators.specialRatio.dir }
        ];
      }
      // 通用统计
      return [
        { label: '本月用药强度', value: ov.indicators.ddd.value, unit: 'DDD', delta: ov.indicators.ddd.delta, dir: ov.indicators.ddd.dir },
        { label: '送检率', value: ov.indicators.submissionRate.value + '%', delta: ov.indicators.submissionRate.delta, dir: ov.indicators.submissionRate.dir },
        { label: '特殊使用级使用占比', value: ov.indicators.specialRatio.value + '%', delta: ov.indicators.specialRatio.delta, dir: ov.indicators.specialRatio.dir }
      ];
    }
  };

  global.Svc = Svc;
})(window);
