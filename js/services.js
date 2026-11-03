/* =====================================================================
 * services.js —— 业务服务层
 * 在 FHIR CRUD 之上封装业务操作，维护跨资源的业务一致性（联动逻辑），
 * 并为各页面提供易用的数据查询。所有写操作最终落到 FHIR 内存库。
 * ===================================================================== */
(function (global) {
  'use strict';
  var F = global.FHIR, D = global.Domain, R4 = global.FHIRR4;

  /* 全系统时间一律取自演示时钟（js/clock.js）。SRS FR-008 的「24 小时内补审核」
   * 与「超时」必须能被演示者推进时钟复现，因此这里不再直接 new Date()。
   * 写入 FHIR 的 instant 元素用 ISO 形态，否则服务端报 HAPI-1821。
   * 带秒：分钟级时间戳会让同一分钟内的两条同内容审计记录被服务端判为重复而丢弃。 */
  function now() { return global.Clock.text(); }
  function nowInstant() { return global.Clock.instant(); }
  function fmtInstant(s) { return (s || '').replace('T', ' ').slice(0, 16); }

  /* 变更记录：委托给 Approval.auditLog，同时形成 Provenance 与 AuditEvent
   * （SRS §9.8 / BR-009：审批、发布、回退、授权变更均须形成可查询记录）。
   * changeType 也落到 Provenance.activity，既比塞扩展规范，也让相邻两条内容不同。 */
  function audit(changeType, content, targets) {
    return global.Approval.auditLog(changeType, content, targets);
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

  function practitionerOrg(practId) {
    var info = global.Approval.practitionerInfo(practId);
    return info ? info.orgId : '';
  }

  var Svc = {
    now: now,
    nowInstant: nowInstant,
    fmtInstant: fmtInstant,

    /* ============ 分级目录（Medication） ============ */
    medications: function (filter) {
      filter = filter || {};
      return F.search('Medication', function (m) {
        // 关键词同时命中名称、通用名（商品名）与药品编码（SRS FR-004.2）
        if (filter.keyword && ((m.code.text || '') + ' ' + (m.ext.brand || '') + ' ' + (m.ext.drugCode || '') + ' ' + m.id).indexOf(filter.keyword) < 0) return false;
        if (filter.code && (m.ext.drugCode || m.id) !== filter.code) return false;
        if (filter.status && filter.status !== 'all') {
          var off = m.ext.enabled === false || m.status !== 'active';
          if ((filter.status === 'disabled') !== off) return false;
        }
        if (filter.drugClass && filter.drugClass !== 'all' && m.ext.drugClass.indexOf(filter.drugClass) < 0) return false;
        if (filter.level && filter.level !== 'all' && m.ext.level !== filter.level) return false;
        return true;
      }).sort(function (a, b) { return a.id.localeCompare(b.id); });
    },
    levelCounts: function () {
      var all = F.search('Medication');
      var c = { all: all.length, 'non-restricted': 0, restricted: 0, special: 0 };
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
    /* 处方权限申请页只看「单 Task 流程」那一批（rx-permission 业务）；
     * 医师在 SRS 临床开单里发起的分级审批实例在「审批中心 / 我发起的」看。 */
    applicationsForDoctor: function (practitionerId) {
      return F.search('Task', function (t) { return !t.ext.taskKind && t.requester.reference === 'Practitioner/' + practitionerId; })
        .sort(function (a, b) { return (b.authoredOn || '').localeCompare(a.authoredOn || ''); });
    },
    // 审批人可见：流转经过该角色节点的申请（待处理 + 已处理历史）
    applicationsForApprover: function (role) {
      return F.search('Task', function (t) {
        if (t.ext.taskKind) return false;
        var flow = t.ext.flow || [];
        return flow.some(function (n) { return n.role === role; });
      }).sort(function (a, b) { return (b.authoredOn || '').localeCompare(a.authoredOn || ''); });
    },
    // 当前是否轮到该角色处理（流程节点处于 current 状态）
    isMyTurn: function (t, role, practitionerId) {
      return (t.ext.flow || []).some(function (n) {
        if (n.status !== 'current') return false;
        if (practitionerId && (n.assigneeIds || []).indexOf(practitionerId) >= 0) return true;
        return !!role && n.role === role;
      });
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
      var u = global.App.currentUser();
      var pd = global.Approval.currentVersion('rx-permission', payload.type);
      var flow;
      if (pd) {
        // 与审批流程设计器共用同一份节点配置（SRS FR-015：发布即生效，无需重新登录）
        flow = global.Approval.renumber((pd.ext.nodes || []).filter(function (n) { return n.type !== 'start' && n.type !== 'end'; }))
          .map(function (n) {
            var who = global.Approval.resolveAssignees(n, { orgId: (practitionerOrg(u.practitioner) || {}) });
            return {
              seq: n.seq, role: n.nodeCode || (n.assigneeType === 'role' ? n.assignees[0] : 'expert'),
              roleName: n.name, mode: n.mode, assigneeType: n.assigneeType,
              assigners: n.assignees || [], assigneeIds: who.map(function (a) { return a.id; }),
              approver: '', time: '', status: 'pending', hours: n.deadlineHours, actions: n.actions || ['approve', 'reject']
            };
          });
        if (!flow.length) throw new Error('流程版本没有可用节点');
        flow[0].status = 'approved'; flow[0].approver = '系统自动匹配'; flow[0].time = now();
        if (flow.length > 1) flow[1].status = 'current';
      } else {
        var roles = payload.type === 'special' ? ['dept', 'pharmacy', 'expert'] : ['dept', 'pharmacy'];
        var NODE = { dept: '科室负责人', pharmacy: '药学部门', expert: '审批专家' };
        flow = roles.map(function (r, i) { return { seq: i + 1, role: r, roleName: NODE[r], status: 'pending', approver: '', time: '', actions: ['approve', 'reject'] }; });
        flow[0].status = 'approved'; flow[0].approver = '科室负责人'; flow[0].time = now();
        flow[1].status = 'current';
      }
      var currentIdx = flow.map(function (n) { return n.status; }).indexOf('current');
      var status = currentIdx < 0 ? 'completed' : 'in-progress';
      var businessStatus = currentIdx < 0 ? '已通过' : '待' + flow[currentIdx].roleName + '审批';
      var t = F.create({
        resourceType: 'Task', identifier: [{ system: global.Approval.SYS.sqno, value: genSqno() }],
        status: status, intent: 'order', authoredOn: nowInstant(),
        businessStatus: { text: businessStatus },
        for: patientFor(payload),
        requester: { reference: 'Practitioner/' + u.practitioner, display: u.name },
        ext: {
          rxPermission: true, workflowVersion: pd ? pd.version : '', pdId: pd ? pd.id : '',
          type: payload.type, drug: payload.drug, dept: payload.dept, requesterTitle: u.title,
          useStart: payload.useStart, useEnd: payload.useEnd, reason: payload.reason,
          patientName: payload.patientName, mrn: payload.mrn, diagnosis: payload.diagnosis, infection: payload.infection,
          patientAge: payload.patientAge || null, patientGender: payload.patientGender || '', patientDept: payload.patientDept || '',
          attachments: payload.attachments || [],
          flow: flow, decision: currentIdx < 0 ? { result: 'approved', by: '系统', time: now(), reason: '' } : null
        }
      });
      F.create({ resourceType: 'Communication', status: 'completed', ext: { category: 'dynamic', time: now(), type: '提交', content: u.name + '-' + payload.drug + (payload.type === 'special' ? '特殊' : '限制') + '使用级申请已提交', target: 'doctor,expert,pharmacy' } });
      if (currentIdx >= 0) {
        F.create({ resourceType: 'Communication', status: 'completed', ext: { category: 'notification', time: now(), type: '审批待办', content: '新的' + D.levelName(payload.type) + '申请（' + payload.drug + '）待您审批', target: flow[currentIdx].role, unread: true } });
      }
      return t;
    },
    /* 处方权限申请流程当前用的版本（页面展示「本次申请走的是哪一版流程」） */
    rxPermissionVersion: function (level) {
      var pd = global.Approval.currentVersion('rx-permission', level);
      return pd ? { id: pd.id, version: pd.version, title: pd.ext.title, nodes: (pd.ext.nodes || []).length } : null;
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
          'non-restricted': dRecs.filter(function (r) { return r.ext.level === 'non-restricted'; }).length,
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

      var levelDdd = { 'non-restricted': 0, restricted: 0, special: 0 };
      recs.forEach(function (r) { levelDdd[r.ext.level] += r.ext.ddd; });
      var levelSplit = [
        { label: '非限制使用级', value: pct(levelDdd['non-restricted'], totalDdd), color: '#16a34a' },
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

  /* =====================================================================
   * SRS 侧服务（页面只调这一层，业务规则一律走 Approval 引擎）
   * 编号与 SRS 第 4 节功能需求一一对应，便于验收对照。
   * ===================================================================== */
  var Ap = global.Approval;

  var srs = {
    /* ---------- FR-001 抗菌药物等级维护 ---------- */
    grades: function () {
      return D.LEVELS.map(function (lv) {
        var rule = F.read('Basic', 'Basic-grade-' + lv.code);
        var drugs = F.search('Medication', function (m) { return D.normalizeLevel(m.ext.level) === lv.code; });
        return {
          code: lv.code, name: lv.name, legacyName: lv.legacy || (lv.name + '级'), desc: lv.desc,
          color: lv.color, rank: lv.rank,
          enabled: !(rule && rule.ext.enabled === false),
          definitionNote: (rule && rule.ext.note) || '',
          updatedBy: (rule && rule.ext.updatedBy) || '', updatedAt: (rule && rule.ext.updatedAt) || '',
          drugCount: drugs.length,
          drugs: drugs.map(function (m) { return { id: m.id, name: m.code.text, code: m.ext.drugCode || m.id }; })
        };
      });
    },
    grade: function (code) { return srs.grades().filter(function (g) { return g.code === D.normalizeLevel(code); })[0] || null; },
    saveGrade: function (code, patch, note) {
      var id = 'Basic-grade-' + code;
      var lv = D.level(code);
      var cur = F.read('Basic', id);
      var ext = Object.assign({
        code: code, name: lv ? lv.name : code, desc: (lv ? lv.desc : ''),
        enabled: true, note: '', updatedBy: global.App.currentUser().display, updatedAt: now()
      }, (cur && cur.ext) || {}, patch || {});
      var res;
      if (cur) { cur.ext = ext; res = F.update(cur); }
      else res = F.create({ resourceType: 'Basic', id: id, created: nowInstant(), code: { text: 'grade-' + code }, ext: ext });
      audit('等级维护', '抗菌药物等级「' + ext.name + '」' + (patch && patch.enabled === false ? '已停用' : '已保存')
        + (note ? '：' + note : ''), ['Basic/' + id]);
      return res;
    },
    /* 新增自定义等级（SRS FR-001.1 支持新增等级分类） */
    addGrade: function (data) {
      var code = (data.code || '').trim() || ('grade-' + Date.now().toString(36));
      var list = D.LEVELS.slice();
      list.push({ code: code, name: data.name, legacy: data.name + '级', rank: Number(data.rank) || (list.length + 1),
        color: data.color || '#7c3aed', desc: data.desc || '' });
      D.LEVELS.length = 0; Array.prototype.push.apply(D.LEVELS, list);
      F.create({ resourceType: 'Basic', id: 'Basic-grade-' + code, created: nowInstant(),
        code: { text: 'grade-' + code },
        ext: { code: code, name: data.name, desc: data.desc || '', enabled: true, note: data.note || '',
          updatedBy: global.App.currentUser().display, updatedAt: now() } });
      // 职称/映射规则同步补一条空规则，避免新等级没有 Permission-map 资源
      if (!F.read('Permission', 'Permission-map-' + code)) {
        F.create({ resourceType: 'Permission', id: 'Permission-map-' + code, status: 'active',
          ext: { category: 'level-mapping', level: code, allowedTitles: [], approvals: [] } });
      }
      if (!F.read('Permission', 'Permission-gate-' + code)) {
        F.create({ resourceType: 'Permission', id: 'Permission-gate-' + code, status: 'active',
          ext: { category: 'gatekeeping', level: code, titleCheck: true, approvalCheck: [],
            interceptOnTitleMismatch: 'block', interceptOnNotApproved: 'none' } });
      }
      audit('等级维护', '新增抗菌药物等级「' + data.name + '」（编码 ' + code + '）', ['Basic/Basic-grade-' + code]);
      return code;
    },
    /* 停用/调整等级前的影响提示（FR-001.7、FR-004.5） */
    gradeImpact: function (code) {
      var drugs = F.search('Medication', function (m) { return D.normalizeLevel(m.ext.level) === code; });
      var running = F.search('Task', function (t) {
        return t.ext.taskKind === 'main' && t.ext.level === code
          && ['approved', 'rejected', 'withdrawn', 'cancelled', 'post-review-done'].indexOf(t.ext.flowStatus) < 0;
      });
      return {
        drugCount: drugs.length, drugs: drugs.map(function (m) { return m.code.text; }),
        runningCount: running.length,
        snapshotNote: '已创建的审批任务保留其开单时所使用的等级快照，不受本次调整影响（FR-001.7）',
        flowNote: running.length ? '该等级下还有 ' + running.length + ' 件进行中的审批，停用等级不会中断它们'
          : '该等级下没有进行中的审批'
      };
    },

    /* ---------- FR-004 抗菌药物目录 ---------- */
    searchDrugs: function (f) {
      f = f || {};
      var list = F.search('Medication', function (m) {
        if (f.keyword && (m.code.text + ' ' + (m.ext.drugCode || '') + ' ' + (m.ext.brand || '')).indexOf(f.keyword) < 0) return false;
        if (f.code && (m.ext.drugCode || m.id) !== f.code) return false;
        if (f.level && f.level !== 'all' && D.normalizeLevel(m.ext.level) !== f.level) return false;
        if (f.status && f.status !== 'all') {
          var disabled = m.ext.enabled === false || m.status === 'entered-in-error' || m.status === 'inactive';
          if ((f.status === 'disabled') !== disabled) return false;
        }
        return true;
      });
      return list.map(function (m) { return srs.drugRow(m); }).sort(function (a, b) { return a.name.localeCompare(b.name, 'zh'); });
    },
    drugRow: function (m) {
      var mk = F.search('MedicationKnowledge', function (k) {
        return (k.associatedMedication || []).some(function (a) { return Ap.idOf(a.reference) === m.id; });
      })[0];
      var grade = Ap.drugGrade(m);
      return {
        id: m.id, name: m.code.text, genericName: m.code.text,
        drugCode: m.ext.drugCode || m.id, demoMark: m.ext.demoMark || '',
        form: m.ext.doseFormCode || (mk && mk.ext && mk.ext.doseFormText) || '—',
        spec: m.ext.spec || '—', brand: m.ext.brand || '—', manufacturer: m.ext.manufacturer || '—',
        drugClass: m.ext.drugClass || (mk && mk.ext && mk.ext.amrClass) || '',
        level: grade.level, levelName: D.levelName(grade.level), levelSource: grade.sourceLabel,
        usage: m.ext.usage || '', insurance: m.ext.insurance || '', stock: m.ext.stock || '',
        enabled: m.ext.enabled !== false && m.status === 'active',
        knowledgeId: mk ? mk.id : '', overridden: !!m.ext.overridden,
        pendingUpdate: !!m.ext.pendingUpdate,
        indication: m.ext.indicationSummary || ''
      };
    },
    drug: function (id) { var m = F.read('Medication', id); return m ? srs.drugRow(m) : null; },
    /* 调整药品等级（FR-004.5：新单用新等级，旧申请保留快照） */
    setDrugGrade: function (medId, level, note) {
      var m = F.read('Medication', medId);
      if (!m) throw new Error('药品不存在');
      var before = D.normalizeLevel(m.ext.level);
      m.ext.level = D.normalizeLevel(level);
      var res = F.update(m);
      var mk = F.read('MedicationKnowledge', m.ext.knowledgeId || '') ||
        F.search('MedicationKnowledge', function (k) {
          return (k.associatedMedication || []).some(function (a) { return Ap.idOf(a.reference) === m.id; });
        })[0];
      if (mk) { mk.ext.level = m.ext.level; mk.medicineClassification = mk.medicineClassification || []; 
        mk.medicineClassification[0] = { type: { coding: [{ system: Ap.CANON + '/activity', code: 'atc', display: 'ATC 分类' }], text: 'ATC 分类' },
          classification: { coding: [{ system: Ap.SYS.level, code: m.ext.level, display: D.levelName(m.ext.level) }] } };
        F.update(mk); }
      audit('等级调整', '药品「' + m.code.text + '」等级由「' + D.levelName(before) + '」调整为「' + D.levelName(level) + '」'
        + (note ? '：' + note : ''), ['Medication/' + m.id]);
      return { before: before, after: m.ext.level, medication: srs.drugRow(res) };
    },
    /* 某药品对某医师的权限规则视图（FR-004.3 选药看规则） */
    drugPermissionView: function (medId, practitionerId) {
      var m = F.read('Medication', medId);
      var grade = Ap.drugGrade(m);
      var map = F.read('Permission', 'Permission-map-' + grade.level);
      var chk = practitionerId ? Ap.check({ practitioner: practitionerId, medicationId: medId }) : null;
      return {
        drug: srs.drugRow(m), grade: grade.level,
        allowedTitles: (map && map.ext.allowedTitles) || [],
        approvalNodes: ((map && map.ext.approvals) || []).map(function (r) { return D.approvalRoleName(r); }),
        flow: Ap.currentVersion('tier-approval', grade.level),
        check: chk
      };
    },

    /* ---------- FR-002 按医生职称设置使用权限 ---------- */
    titleRules: function () {
      return D.TITLES.map(function (t) {
        var matrix = Ap.titleRuleMatrix(t.code);
        var levels = Object.keys(matrix).filter(function (k) { return matrix[k]; });
        var log = srs.ruleChangeLog('职称权限', D.titleName(t.code));
        return {
          title: t.code, titleName: t.name, rank: t.rank,
          levels: levels, matrix: matrix,
          doctors: F.search('Practitioner', function (p) { return p.ext && p.ext.title === t.code; }).length,
          updatedAt: log.length ? log[0].time : '', updatedBy: log.length ? log[0].operator : ''
        };
      });
    },
    /* 保存前展示变更摘要（FR-002.4） */
    titleRuleDiff: function (title, levels) {
      var cur = Ap.titleRuleMatrix(title);
      return D.LEVELS.map(function (lv) {
        var from = !!cur[lv.code], to = (levels || []).indexOf(lv.code) >= 0;
        return from === to ? null : { level: lv.code, levelName: lv.name, from: from, to: to,
          text: lv.name + (to ? ' 新增' : ' 取消') };
      }).filter(Boolean);
    },
    saveTitleRule: function (title, levels, note) {
      var diff = srs.titleRuleDiff(title, levels);
      if (!diff.length) return { changed: [], text: '未发生变更' };
      D.LEVELS.forEach(function (lv) {
        var p = F.read('Permission', 'Permission-map-' + lv.code);
        if (!p) return;
        var arr = (p.ext.allowedTitles || []).slice();
        var has = arr.indexOf(title) >= 0, want = (levels || []).indexOf(lv.code) >= 0;
        if (want && !has) arr.push(title);
        if (!want && has) arr.splice(arr.indexOf(title), 1);
        p.ext.allowedTitles = arr;
        F.update(p);
        // 卡控规则的审批校验项随映射联动（沿用既有原型的联动语义）
        var g = F.read('Permission', 'Permission-gate-' + lv.code);
        if (g) { g.ext.approvalCheck = (p.ext.approvals || []).slice();
          g.ext.interceptOnNotApproved = (p.ext.approvals || []).length ? g.ext.interceptOnNotApproved : 'none';
          F.update(g); }
      });
      var text = diff.map(function (d) { return d.text; }).join('、');
      audit('职称权限', D.titleName(title) + ' 可使用等级调整为：'
        + (levels.length ? levels.map(D.levelName).join('、') : '无') + '（变更：' + text + '）'
        + (note ? '；' + note : ''));
      return { changed: diff, text: text };
    },
    ruleChangeLog: function (changeType, keyword) {
      return F.search('Provenance', function (p) {
        return (!changeType || p.ext.changeType === changeType)
          && (!keyword || (p.ext.content || '').indexOf(keyword) >= 0);
      }).map(function (p) {
        return { id: p.id, time: R4.fromWire ? (p.recorded || '').replace('T', ' ').slice(0, 16) : p.recorded,
          content: p.ext.content, operator: p.ext.operator, changeType: p.ext.changeType };
      }).sort(function (a, b) { return b.time.localeCompare(a.time); });
    },

    /* ---------- FR-003 科室与个人权限维护 ---------- */
    departments: function () {
      return F.search('Organization', function (o) {
        return o.ext && o.ext.orgKind === 'department';
      }).map(function (o) {
        var roles = F.search('PractitionerRole', function (r) {
          return r.organization && r.organization.reference === 'Organization/' + o.id;
        });
        return {
          id: o.id, name: o.name, kind: (o.type && o.type[0] && o.type[0].text) || '',
          doctors: roles.length,
          grant: (function () { var d = Ap.deptRule(o.id); return d ? { levels: d.ext.levels || [], note: d.ext.note, status: d.status } : null; })(),
          approvable: roles.some(function (r) { return r.ext && r.ext.canApprove; })
        };
      }).sort(function (a, b) { return a.name.localeCompare(b.name, 'zh'); });
    },
    /* 按科室查看医生列表、职称与当前授权（FR-003.1） */
    departmentDoctors: function (orgId) {
      return F.search('PractitionerRole', function (r) {
        return r.organization && r.organization.reference === 'Organization/' + orgId;
      }).map(function (r) {
        var pid = Ap.idOf(r.practitioner.reference);
        var info = Ap.practitionerInfo(pid);
        var authz = Ap.authorizations(pid);
        return {
          practitioner: pid, name: info.name, title: info.title, titleName: D.titleName(info.title),
          roleTypes: (r.ext && r.ext.roles) || [r.ext.roleType], canApprove: !!(r.ext && r.ext.canApprove),
          levels: authz.levels.map(function (c) { return D.levelName(c); }),
          hitLayer: authz.hit.srcLabel, identities: D.identitiesOfPractitioner(pid).map(function (u) { return u.id; })
        };
      }).sort(function (a, b) { return D.titleRank(b.title) - D.titleRank(a.title); });
    },
    saveDeptGrant: function (orgId, levels, note) {
      var id = 'Permission-dept-' + orgId;
      var cur = F.read('Permission', id);
      var o = F.read('Organization', orgId);
      var before = cur ? (cur.ext.levels || []).map(D.levelName).join('、') : '（未配置）';
      var ext = Object.assign({}, (cur && cur.ext) || {}, {
        category: 'authorization', subjectType: 'department', level: '',
        subjectRef: 'Organization/' + orgId, deptName: o ? o.name : orgId,
        levels: (levels || []).map(D.normalizeLevel), grantLabel: '科室授权', note: note || '',
        source: o ? o.name : orgId, before: before, after: (levels || []).map(D.levelName).join('、')
      });
      if (cur) { cur.ext = ext; cur.status = 'active'; F.update(cur); }
      else F.create({ resourceType: 'Permission', id: id, status: 'active', ext: ext });
      audit('科室授权', '科室「' + ext.deptName + '」授权等级调整为 ' + ext.after + '（原：' + before + '）'
        + (note ? '；' + note : ''), ['Permission/' + id]);
      return { before: before, after: ext.after };
    },
    savePersonGrant: function (practId, levels, grantLabel, expires, note) {
      var id = 'Permission-person-' + practId;
      var cur = F.read('Permission', id);
      var info = Ap.practitionerInfo(practId);
      var before = cur ? (cur.ext.levels || []).map(D.levelName).join('、') : '（未配置）';
      var ext = Object.assign({}, (cur && cur.ext) || {}, {
        category: 'authorization', subjectType: 'person', level: '',
        subjectRef: 'Practitioner/' + practId, practitionerName: info.name,
        levels: (levels || []).map(D.normalizeLevel), grantLabel: grantLabel || '个人授权',
        expires: expires || '', note: note || '', source: info.name,
        before: before, after: (levels || []).map(D.levelName).join('、')
      });
      if (cur) { cur.ext = ext; cur.status = levels && levels.length ? 'active' : 'inactive'; F.update(cur); }
      else F.create({ resourceType: 'Permission', id: id, status: levels && levels.length ? 'active' : 'inactive', ext: ext });
      audit('个人授权', '医师「' + info.name + '」个人授权调整为 ' + ext.after + '（原：' + before + '）'
        + (ext.expires ? '；有效期至 ' + ext.expires : '') + (note ? '；' + note : ''), ['Permission/' + id]);
      return { before: before, after: ext.after };
    },
    /* 医师权限详情：职称规则 / 科室授权 / 个人授权 / 最终可开等级（FR-003.4、FR-003.5） */
    doctorDetail: function (practId) {
      var authz = Ap.authorizations(practId);
      if (!authz) return null;
      var byLevel = {};
      D.LEVELS.forEach(function (lv) {
        byLevel[lv.code] = {
          level: lv.code, levelName: lv.name,
          allowed: authz.levels.indexOf(lv.code) >= 0,
          drugCount: F.count('Medication', function (m) { return D.normalizeLevel(m.ext.level) === lv.code; })
        };
      });
      return {
        info: authz.practitioner, priority: authz.priority, priorityLabel: authz.priorityLabel,
        layers: authz.layers, hit: authz.hit, levels: authz.levels,
        levelNames: authz.levels.map(D.levelName), byLevel: byLevel,
        missing: D.LEVELS.filter(function (lv) { return authz.levels.indexOf(lv.code) < 0; }).map(function (lv) { return lv.code; }),
        missingNames: D.LEVELS.filter(function (lv) { return authz.levels.indexOf(lv.code) < 0; }).map(function (lv) { return lv.name; }),
        roleGrants: (function () {
          var r = Ap.practitionerRole(practId);
          return r ? { id: r.id, org: r.ext.orgName, roles: r.ext.roles || [], canApprove: !!r.ext.canApprove } : null;
        })(),
        history: srs.ruleChangeLog(null, authz.practitioner.name).slice(0, 8)
      };
    },
    doctorDirectory: function () {
      return F.search('Practitioner').map(function (p) {
        var info = Ap.practitionerInfo(p.id);
        if (!info) return null;
        var authz = Ap.authorizations(p.id);
        return {
          id: p.id, name: info.name, title: info.title, titleName: D.titleName(info.title),
          dept: info.dept, roleTypes: (Ap.practitionerRole(p.id) || { ext: {} }).ext.roles || [info.roleType],
          levels: authz ? authz.levels : [], hit: authz ? authz.hit.srcLabel : '',
          identities: D.identitiesOfPractitioner(p.id).map(function (u) { return u.id; })
        };
      }).filter(Boolean).sort(function (a, b) { return a.dept.localeCompare(b.dept, 'zh') || D.titleRank(b.title) - D.titleRank(a.title); });
    },
    mergePriority: function () { return Ap.mergePriority(); },
    setMergePriority: function (order) { return Ap.setMergePriority(order); },

    /* ---------- FR-005~FR-010 临床开单 ---------- */
    orderPatients: function () {
      return F.search('Patient').map(function (p) {
        return { id: p.id, name: (p.name[0] || {}).text, mrn: (p.ext || {}).mrn || '',
          diagnosis: (p.ext || {}).diagnosis || '', infection: (p.ext || {}).infection || '' };
      });
    },
    encounters: function (patientId) {
      return F.search('Encounter', function (e) {
        return !patientId || (e.subject && e.subject.reference === 'Patient/' + patientId);
      }).map(function (e) {
        return { id: e.id, kindName: e.ext.kindName || ((e.class || {}).text) || '', kind: e.ext.kind,
          visitNo: e.ext.visitNo, bed: e.ext.bed || '', start: (e.period.start || '').replace('T', ' ').slice(0, 16),
          status: e.status, chief: e.ext.chief || '', participant: e.participant && e.participant[0] ? e.participant[0].individual.display : '' };
      });
    },
    purposes: function () {
      var cs = F.read('CodeSystem', 'CodeSystem-amr-purpose');
      var list = (cs && cs.ext && cs.ext.concepts) || null;
      return D.PURPOSES.map(function (p) { return Object.assign({}, p); });
    },
    /* 提交：先做用药目的校验（BR-004），提交时二次权限判定（FR-005.7） */
    submitOrder: function (payload) {
      if (!payload.purposeCode) { var e = new Error('请先选择抗菌药物使用目的'); e.code = 'PURPOSE_REQUIRED'; throw e; }
      var med = F.read('Medication', payload.medicationId);
      if (!med) throw new Error('药品不存在');
      var chk = Ap.check({ practitioner: payload.practitionerId, medicationId: med.id,
        isEmergency: !!payload.emergency });
      if (payload.expectedLevel && chk.grade !== payload.expectedLevel) {
        throw new Error('药品等级已调整为「' + chk.gradeName + '」，请重新确认后再提交');
      }
      if (chk.allowed && !payload.emergency) {
        var mr = Ap.createMedicationRequest({
          medicationId: med.id, requesterPractId: payload.practitionerId, patientId: payload.patientId,
          encounterId: payload.encounterId, patientName: payload.patientName, mrn: payload.mrn,
          diagnosis: payload.diagnosis, purposeCode: payload.purposeCode, purposeNote: payload.purposeNote,
          dosageText: payload.dosageText, frequency: payload.frequency, days: payload.days,
          applicationReason: payload.reason, check: chk, orderStatus: 'ready-to-submit'
        });
        srs.notifyRequester(chk, mr, null, 'direct');
        return { mode: 'direct', check: chk, medicationRequest: mr, instance: null };
      }
      if (payload.emergency) {
        if (!payload.emergencyReason) { var e2 = new Error('紧急情况临时越级使用必须填写原因及临床说明'); e2.code = 'EMERGENCY_REASON'; throw e2; }
        var r = Ap.createEmergency({
          requesterPractId: payload.practitionerId, medicationId: med.id, patientId: payload.patientId,
          encounterId: payload.encounterId, patientName: payload.patientName, mrn: payload.mrn,
          diagnosis: payload.diagnosis, purposeCode: payload.purposeCode, purposeNote: payload.purposeNote,
          dosageText: payload.dosageText, emergencyReason: payload.emergencyReason,
          clinicalNote: payload.clinicalNote, applicationReason: payload.reason, check: chk
        });
        return { mode: 'emergency', check: chk, medicationRequest: r.mr, instance: r.mainTask,
          deadline: r.mainTask.ext.postReviewDeadline };
      }
      if (!chk.route) { var e3 = new Error('该等级尚未发布审批流程，无法发起审批'); e3.code = 'NO_FLOW'; throw e3; }
      var mr2 = Ap.createMedicationRequest({
        medicationId: med.id, requesterPractId: payload.practitionerId, patientId: payload.patientId,
        encounterId: payload.encounterId, patientName: payload.patientName, mrn: payload.mrn,
        diagnosis: payload.diagnosis, purposeCode: payload.purposeCode, purposeNote: payload.purposeNote,
        dosageText: payload.dosageText, frequency: payload.frequency, days: payload.days,
        applicationReason: payload.reason, check: chk, orderStatus: 'pending-approval'
      });
      var inst = Ap.createInstance({ mr: mr2, purpose: 'tier-approval', requesterPractId: payload.practitionerId,
        applicationReason: payload.reason, check: chk });
      return { mode: 'approval', check: chk, medicationRequest: mr2, instance: inst,
        flowTitle: inst.ext.pdTitle, version: inst.ext.version, nodes: inst.ext.flow };
    },
    notifyRequester: function (chk, mr, inst, mode) {
      Ap.notify({ category: 'dynamic', type: '提交', targetRole: 'all',
        content: '『' + mr.ext.drugName + '』（' + mr.ext.gradeSnapshot.name + '）权限符合，已直接提交（用药目的：'
          + (mr.ext.purpose ? mr.ext.purpose.name : '—') + '）', linkRoute: 'order-demo', linkTask: mr.id });
    },

    /* ---------- FR-008 紧急越级补审核 ---------- */
    emergencyRecords: function (practId) {
      return Ap.mainTasks({ purpose: 'emergency-review' }).map(function (m) {
        var t = Ap.timeoutState(m);
        return {
          id: m.id, sqno: m.ext.sqno, patient: m.ext.patientName, mrn: m.ext.mrn,
          drug: m.ext.drug, level: m.ext.level, levelName: D.levelName(m.ext.level),
          requester: m.ext.requesterName, createdAt: m.ext.createdAt,
          reason: m.ext.emergencyReason, clinicalNote: m.ext.clinicalNote,
          deadline: m.ext.postReviewDeadline, timeout: t,
          flowStatus: m.ext.flowStatus, flowStatusName: D.flowStatusName(m.ext.flowStatus),
          tone: D.flowStatus(m.ext.flowStatus).tone,
          postReview: m.ext.postReview || null, submittedAt: m.ext.postReviewSubmittedAt || '',
          materialsMissing: !m.ext.postReview,
          orderStatus: m.ext.orderStatus, mine: Ap.idOf(m.requester.reference) === practId,
          actionable: !!Ap.firstActionableNode(m.id, practId)
        };
      });
    },
    submitEmergencyMaterials: function (mainId, materials) { return Ap.submitPostReviewMaterials(mainId, materials); },

    /* ---------- FR-016/020/021/022 审批中心 ---------- */
    centerScopes: function () {
      return [{ code: 'todo', name: '待我审批' }, { code: 'done', name: '我已审批' },
      { code: 'mine', name: '我发起的' }, { code: 'emergency', name: '紧急越级待补审核' },
      { code: 'all', name: '全部实例' }];
    },
    centerRows: function (practId, scope, filter) { return Ap.rows(practId, scope, filter); },
    centerCounters: function (practId) { return Ap.countersFor(practId); },
    centerDetail: function (mainId) {
      var main = F.read('Task', mainId);
      if (!main) return null;
      var mr = F.read('MedicationRequest', main.ext.mrId);
      var view = Ap.flowView(mainId);
      var who = global.App.currentUser();
      view.actions = {
        canAct: !!Ap.firstActionableNode(mainId, who.practitioner),
        node: (function () {
          var n = Ap.firstActionableNode(mainId, who.practitioner);
          return n ? { id: n.id, seq: n.ext.seq, name: n.ext.node.name, actions: n.ext.node.actions || [],
            deadlineEnd: n.ext.deadlineEnd } : null;
        })(),
        canWithdraw: main.ext.flowStatus === 'waiting-node' && Ap.idOf(main.requester.reference) === who.practitioner,
        canResubmitMaterials: main.ext.purpose === 'emergency-review' && !main.ext.postReview,
        canRevise: main.ext.flowStatus === 'rejected' && Ap.idOf(main.requester.reference) === who.practitioner,
        canResubmit: main.ext.flowStatus === 'returned' && Ap.idOf(main.requester.reference) === who.practitioner
      };
      view.request = {
        sqno: main.ext.sqno, patient: main.ext.patientName, mrn: main.ext.mrn, diagnosis: main.ext.diagnosis,
        encounter: mr && mr.encounter ? mr.encounter.reference : '',
        drug: main.ext.drug, drugCode: main.ext.drugCode, level: main.ext.level,
        levelName: D.levelName(main.ext.level), gradeSnapshot: main.ext.gradeSnapshot,
        purpose: (mr && mr.ext.purpose) || null, reason: main.ext.applicationReason,
        requester: main.ext.requesterName, requesterTitle: D.titleName(main.ext.requesterTitle),
        dept: main.ext.dept, dosage: (mr && mr.ext.dosage) || {}, authoredAt: main.ext.createdAt,
        authzHit: main.ext.authzHit, emergency: !!main.ext.emergency, emergencyReason: main.ext.emergencyReason,
        orderStatus: main.ext.orderStatus, orderStatusName: D.orderStatusName(main.ext.orderStatus),
        mrId: main.ext.mrId
      };
      return view;
    },
    act: function (params) { return Ap.act(params); },
    withdraw: function (id, reason) { return Ap.withdraw(id, reason); },
    resubmitMaterials: function (id, note) { return Ap.resubmit(id, note); },
    reviseAndResubmit: function (id, patch) { return Ap.resubmitAfterReject(id, patch); },

    /* ---------- FR-023 消息与提醒 ---------- */
    messages: function (identity) {
      var role = identity.role, pract = identity.practitioner;
      return F.search('Communication', function (c) {
        if (c.ext.category !== 'notification') return false;
        return c.ext.targetPract === pract || (c.ext.target || '').indexOf(role) >= 0 || c.ext.target === 'all';
      }).sort(function (a, b) { return (b.ext.time || '').localeCompare(a.ext.time || ''); });
    },
    unreadCount: function (identity) {
      return srs.messages(identity).filter(function (n) { return n.ext.unread; }).length;
    },
    markAllRead: function (identity) {
      srs.messages(identity).forEach(function (n) {
        var r = F.read('Communication', n.id); r.ext.unread = false; F.update(r);
      });
    },
    markRead: function (id) { var r = F.read('Communication', id); if (r) { r.ext.unread = false; return F.update(r); } },
    jump: function (comm) {
      return { route: comm.ext.linkRoute || 'approval-center', task: comm.ext.linkTask || '' };
    },

    /* ---------- 工作台（SRS §6.2） ---------- */
    workbench: function (identity) {
      var pract = identity.practitioner;
      var counters = Ap.countersFor(pract);
      var special = Ap.rows(pract, 'todo').filter(function (r) { return r.level === 'special'; });
      var emergency = srs.emergencyRecords(pract).filter(function (e) { return e.timeout.timeout || e.timeout.kind === 'near'; });
      var mine = Ap.rows(pract, 'mine').slice(0, 6);
      return {
        counters: counters, specialWaiting: special, emergencyDue: emergency,
        mine: mine, todo: Ap.rows(pract, 'todo').slice(0, 8),
        flowChanges: srs.ruleChangeLog(null, null).filter(function (p) {
          return ['流程发布', '流程回退', '等级维护', '职称权限', '科室授权', '个人授权', '授权优先级'].indexOf(p.changeType) >= 0;
        }).slice(0, 6),
        authz: Ap.authorizations(pract)
      };
    },

    /* ---------- 演示数据管理（DEMO-01 / SRS §10.2） ---------- */
    capabilities: function (force) { return FHIR.capabilities(force); },
    serverStatus: function (types) { return FHIR.serverCounts(types); },
    refresh: function (types) { return global.App.refreshFromServer(types); },
    /* 注意：必须拷贝一份再返回。Clock.state() 返回的是时钟模块自己的缓存对象，
     * 直接 Object.assign 到它上面会把 FHIR 的读写模式写成 clock.mode，
     * 「冻结演示时钟」会在任意页面渲染后被 local 覆盖而失效。 */
    clock: function () {
      var st = global.Clock.state();
      return {
        mode: st.mode, offsetMinutes: st.offsetMinutes, frozenAt: st.frozenAt,
        setBy: st.setBy, setAt: st.setAt,
        now: global.Clock.text(), instant: global.Clock.instant(), scope: R4.scopeCode(),
        base: global.AmrConfig.all().fhirBase,
        syncMode: FHIR.stats().mode, server: FHIR.stats().server
      };
    },
    setClock: function (patch) {
      var c = global.Clock;
      if (patch.mode === 'live') return c.reset();
      if (patch.mode === 'frozen') return c.freezeAt(patch.frozenAt);
      return c.setOffset(patch.offsetMinutes);
    },
    advanceClock: function (minutes) { return global.Clock.advance(minutes); },
    demoConfig: function () {
      var cfg = global.AmrConfig.all();
      return { base: cfg.fhirBase, mode: cfg.mode, scope: cfg.demoScope, autoSeed: cfg.autoSeed,
        persistUsageRecords: cfg.persistUsageRecords, anchor: 'Basic/Basic-catalog-version',
        scriptHint: 'python3 scripts/demo_data.py reset --scope ' + cfg.demoScope };
    },
    /* DEMO-15：患者 → 就诊 → 开单 → 审批任务 → 流程版本 → 留痕 的关联核查 */
    trace: function (patientId) {
      var p = patientId ? F.read('Patient', patientId) : null;
      var encs = p ? F.search('Encounter', function (e) { return e.subject.reference === 'Patient/' + p.id; }) : [];
      var mrs = p ? F.search('MedicationRequest', function (m) { return m.subject.reference === 'Patient/' + p.id; }) : [];
      var tasks = mrs.map(function (m) {
        return F.search('Task', function (t) { return t.ext && t.ext.taskKind === 'main' && t.ext.mrId === m.id; });
      }).reduce(function (a, b) { return a.concat(b); }, []);
      var pdIds = {}; tasks.forEach(function (t) { pdIds[t.ext.pdId] = true; });
      var pds = Object.keys(pdIds).map(function (id) { return F.read('PlanDefinition', id); }).filter(Boolean);
      var related = [];
      tasks.forEach(function (t) { related.push('Task/' + t.id); related.push('Task/' + Ap.nodeTaskId(t.id, 1)); });
      mrs.forEach(function (m) { related.push('MedicationRequest/' + m.id); });
      var prov = F.search('Provenance', function (pr) {
        var list = (pr.ext && pr.ext.targetList) || [];
        return list.some(function (x) { return related.indexOf(x) >= 0; });
      });
      return {
        patient: p ? { id: p.id, name: (p.name[0] || {}).text, mrn: p.ext.mrn, diagnosis: p.ext.diagnosis } : null,
        encounters: encs.map(function (e) { return { id: e.id, kind: e.ext.kindName, visitNo: e.ext.visitNo, start: e.period.start }; }),
        orders: mrs.map(function (m) {
          return { id: m.id, no: m.ext.orderNo, drug: m.ext.drugName, grade: m.ext.gradeSnapshot,
            purpose: m.ext.purpose, status: m.ext.orderStatus, emergency: !!m.ext.emergency,
            authzHit: m.ext.authzHit, authoredOn: (m.authoredOn || '').replace('T', ' ').slice(0, 16) };
        }),
        tasks: tasks.map(function (t) {
          return { id: t.id, sqno: t.ext.sqno, statusName: D.flowStatusName(t.ext.flowStatus),
            purpose: t.ext.purpose, version: 'V' + t.ext.version, pdId: t.ext.pdId,
            nodes: Ap.nodeTasksOf(t.id).length, canonical: t.instantiatesCanonical };
        }),
        flows: pds.map(function (pd) { return { id: pd.id, version: pd.version, status: pd.status, title: pd.ext.title }; }),
        provenance: prov.map(function (pr) { return { time: (pr.recorded || '').replace('T', ' ').slice(0, 16), type: pr.ext.changeType, content: pr.ext.content, operator: pr.ext.operator }; }),
        auditEvents: F.search('AuditEvent', function (ae) {
          return (ae.entity || []).some(function (en) { return related.indexOf((en.what || {}).reference) >= 0; });
        }).map(function (ae) { return { time: (ae.recorded || '').replace('T', ' ').slice(0, 16), type: (ae.subtype || [{}])[0].code, content: ae.ext.content, operator: ae.ext.operator }; }),
        unlinked: mrs.filter(function (m) { return !tasks.some(function (t) { return t.ext.mrId === m.id; }) && m.ext.orderStatus !== 'ready-to-submit'; }).map(function (m) { return m.ext.orderNo; })
      };
    },
    dataset: function () {
      var counts = {};
      FHIR.types().forEach(function (t) { counts[t] = FHIR.count(t); });
      return { counts: counts, total: Object.keys(counts).reduce(function (s, k) { return s + counts[k]; }, 0) };
    }
  };
  Svc.srs = srs;

  global.Svc = Svc;
})(window);
