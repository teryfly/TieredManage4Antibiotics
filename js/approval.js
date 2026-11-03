/* =====================================================================
 * approval.js —— 分级授权判定 + 审批流程引擎（window.Approval）
 * ---------------------------------------------------------------------
 * SRS §10.7 明确：HAPI FHIR 只是资源存储与 REST 服务，不是采购条款里的流程
 * 引擎。读规则、判权限、建 Task、派任务、推节点、汇总结果、记版本与截止时间
 * 全部由本模块在前端完成，再把状态写回 FHIR。
 *
 * 全部函数对本地镜像同步取数（与 services.js 一致的约束），不返回 Promise。
 *
 * 数据约定：
 *   流程定义/版本 = PlanDefinition（同一业务 url、version 递增，一个版本一条资源）
 *   流程实例      = 主 Task（instantiatesCanonical 绑定版本，节点完成情况汇总于斯）
 *   审核节点任务  = 节点 Task（partOf 指向主 Task，负责人与意见在 output 里）
 *   开单          = MedicationRequest（等级快照、用药目的、紧急标识在扩展里）
 * ===================================================================== */
(function (global) {
  'use strict';

  var F = global.FHIR, D = global.Domain;
  var CANON = 'https://fhir.amr-demo.example';
  var SYS = {
    key: CANON + '/workflow-key',
    sqno: CANON + '/approval-no',
    order: CANON + '/medication-request-no',
    level: CANON + '/CodeSystem/amr-level',
    purpose: CANON + '/CodeSystem/amr-purpose',
    role: CANON + '/CodeSystem/amr-role',
    flowStatus: CANON + '/CodeSystem/amr-flow-status',
    orderStatus: CANON + '/CodeSystem/amr-order-status',
    taskCode: CANON + '/CodeSystem/amr-task-code'
  };
  var EMERGENCY_HOURS = 24;      // SRS FR-008：事后 24 小时内完成补审核
  var NEAR_TIMEOUT_HOURS = 4;    // FR-023.4 接近截止时间的提醒阈值
  var OPEN_NODE = ['requested', 'accepted', 'in-progress'];
  var CLOSED_MAIN = ['approved', 'rejected', 'withdrawn', 'cancelled', 'post-review-done'];

  function pad(n) { return String(n).padStart(2, '0'); }
  // 扩展编解码只支持「同名扩展重复」来表达数组，单元素数组会被读回成标量；
  // 所有可能是数组的字段一律先过 asArray，避免 roles.some is not a function 这类故障。
  function asArray(v) { return v == null ? [] : (Array.isArray(v) ? v : [v]); }
  function nowText() { return global.Clock.text(); }
  function nowInstant() { return global.Clock.instant(); }
  function actor() {
    var u = global.App && global.App.currentUser ? global.App.currentUser() : null;
    return u ? { display: u.display, name: u.name, practitioner: u.practitioner }
      : { display: '系统', name: '系统', practitioner: '' };
  }
  function ref(type, id, display) {
    if (!id) return undefined;
    var r = { reference: type + '/' + id };
    if (display) r.display = display;
    return r;
  }
  function coding(system, code, display) {
    var c = { system: system, code: code };
    if (display) c.display = display;
    return c;
  }
  function idOf(reference) { var m = /\/(.+)$/.exec(reference || ''); return m ? m[1] : ''; }
  function purposeDef(p) { return D.flowPurpose(p) || { code: p, name: p, levelBound: false }; }

  /* ---------------------------------------------------------------- 留痕 */
  function auditLog(changeType, content, targets) {
    var a = actor();
    var agent = [{ who: a.practitioner ? ref('Practitioner', a.practitioner, a.name) : { display: a.name } }];
    var p = F.create({
      resourceType: 'Provenance', recorded: nowInstant(),
      activity: { coding: [{ system: CANON + '/activity', code: 'amr-' + changeType, display: changeType }] },
      agent: agent,
      entity: (targets || []).map(function (t) { return { what: { reference: t } }; }),
      ext: { changeType: changeType, content: content, operator: a.display, targetList: targets || [] }
    });
    // AuditEvent 是 R4 必填元素最多的资源：type / agent.who / recorded / source.observer
    F.create({
      resourceType: 'AuditEvent', recorded: nowInstant(), occurred: nowInstant(),
      type: coding('http://hl7.org/fhir/audit-event-type', 'instance-usage', '资源使用留痕'),
      subtype: [{ coding: [{ code: changeType, display: changeType }] }],
      action: 'E', outcome: '0',   // R4 AuditEventOutcome 码表是 0/4/8/12
      agent: [{ who: a.practitioner ? ref('Practitioner', a.practitioner, a.name) : { display: a.name }, requestor: true }],
      source: { observer: ref('Organization', 'Organization-hospital-demo', '前端演示程序') },
      entity: (targets || []).map(function (t) { return { what: { reference: t }, type: { coding: [{ code: 'resource' }] }, detail: changeType }; }),
      ext: { changeType: changeType, content: content, operator: a.display }
    });
    return p;
  }

  /* ------------------------------------------------------ 消息（FR-023） */
  /* 通知落两条：CommunicationRequest 记「该通知谁」，Communication 记「已发出」
   * 并供通知中心/角标读取。targetRole 沿用旧页面按角色过滤的语义，targetPract
   * 让消息能精确到人（审批对象含人员/科室/角色三种）。 */
  function notify(opts) {
    var category = opts.category || 'notification';
    var comm = F.create({
      resourceType: 'Communication', status: 'completed', sent: nowInstant(),
      // R4 里 Communication.subject 只允许 Patient/Group/Practitioner/Device/Medication/Substance，
      // 「这条消息关于哪个审批实例」应走 about（服务端实测会拒 subject→Task）
      subject: opts.patientRef,
      about: opts.subjectRef,
      basedOn: opts.basedOnRef ? [opts.basedOnRef] : undefined,
      ext: {
        category: category, time: nowText(), type: opts.type || '提醒',
        content: opts.content, target: opts.targetRole || 'all',
        targetPract: opts.toPractitioner || '', unread: !!opts.unread,
        linkRoute: opts.linkRoute || '', linkTask: opts.linkTask || ''
      }
    });
    if (opts.toPractitioner) {
      F.create({
        resourceType: 'CommunicationRequest', status: 'active', requestedOn: nowInstant(),
        category: { coding: [coding(CANON + '/comm-category', category, category)], text: category },
        priority: { coding: [{ code: 'urgent', display: 'urgent' }] },
        recipient: [ref('Practitioner', opts.toPractitioner, opts.toName)],
        sender: ref('Practitioner', actor().practitioner, actor().name),
        subject: opts.patientRef,
        about: opts.subjectRef,
        ext: { category: category, content: opts.content, targetPract: opts.toPractitioner, linkTask: opts.linkTask || '' }
      });
    }
    return comm;
  }

  /* ------------------------------------------------------- 流程定义与版本 */
  function slug(purpose, level) {
    var bound = purposeDef(purpose).levelBound;
    return 'amr-' + purpose + (bound && level ? '-' + D.normalizeLevel(level) : '');
  }
  function pdUrl(key) { return CANON + '/PlanDefinition/' + key; }
  function versionLabel(pd) { return pd ? 'V' + pd.version : '—'; }

  function allVersions() {
    return F.search('PlanDefinition').sort(function (a, b) {
      var ka = (a.ext && a.ext.purposeKey) || '', kb = (b.ext && b.ext.purposeKey) || '';
      if (ka !== kb) return ka < kb ? -1 : 1;
      return (parseInt(a.version, 10) || 0) - (parseInt(b.version, 10) || 0);
    });
  }
  function versions(purpose, level) {
    var key = slug(purpose, level);
    return allVersions().filter(function (p) { return p.ext && p.ext.purposeKey === key; });
  }
  function nextVersionNumber(key) {
    return F.search('PlanDefinition', function (p) { return p.ext && p.ext.purposeKey === key; })
      .reduce(function (m, p) { return Math.max(m, parseInt(p.version, 10) || 0); }, 0) + 1;
  }

  /* 当前发布版本：先读指针，再退回集合计算。公共服务器上同一 url 的多版本检索
   * 行为不完全可控（SRS §10.6），指针是权威，集合计算兜底。 */
  function currentVersion(purpose, level) {
    var key = slug(purpose, level);
    var ptr = F.read('Basic', 'Basic-workflow-current-' + key);
    if (ptr && ptr.ext && ptr.ext.pdId) {
      var pd = F.read('PlanDefinition', ptr.ext.pdId);
      if (pd && pd.status === 'active') return pd;
    }
    var list = versions(purpose, level).filter(function (p) { return p.status === 'active'; });
    return list.length ? list[list.length - 1] : null;
  }
  function setPointer(key, pd, operator) {
    var id = 'Basic-workflow-current-' + key;
    var ext = { pdId: pd.id, version: pd.version, purposeKey: key,
      publishedAt: nowText(), operator: operator || actor().display };
    var cur = F.read('Basic', id);
    if (!cur) return F.create({ resourceType: 'Basic', id: id, created: nowInstant(), code: { text: 'workflow-current' }, ext: ext });
    cur.ext = ext; return F.update(cur);
  }

  /* 节点 → PlanDefinition.action 标准投影（SRS §9.6）。
   * R4 里 action.id 须匹配 [A-Za-z0-9\-]{1,64}，中文名只能进 title/description。 */
  function toActions(nodes) {
    return (nodes || []).filter(function (n) { return n.type !== 'start' && n.type !== 'end'; })
      .map(function (n) {
        return {
          id: n.key || ('node-' + n.seq),
          label: n.name,
          title: n.name,
          description: '第 ' + n.seq + ' 个审核节点：' + n.name
            + '（审批对象 ' + D.assigneeTypeName(n.assigneeType)
            + '，办理时限 ' + (n.deadlineHours || 24) + ' 小时'
            + (n.isPostReview ? '，补审核节点' : '') + '）',
          code: { coding: [coding(CANON + '/CodeSystem/amr-node', n.nodeCode || n.assigneeType, n.name)] },
          timingTiming: { duration: Number(n.deadlineHours || 24), durationUnit: 'h' },
          priority: { coding: [{ code: n.isPostReview ? 'PRN' : 'Routine' }] }
        };
      });
  }
  function nodesFromActions(pd) {
    return ((pd.ext && pd.ext.nodes) || []).map(function (n) { return Object.assign({}, n); });
  }
  function renumber(nodes) {
    return (nodes || []).map(function (n, i) {
      var c = Object.assign({}, n, { seq: i + 1 });
      c.key = 'node-' + (i + 1);
      return c;
    });
  }
  function pascal(s) {
    return String(s).replace(/[^a-zA-Z0-9]+/g, ' ').split(' ').filter(Boolean)
      .map(function (w) { return w.charAt(0).toUpperCase() + w.slice(1); }).join('');
  }
  function mkNode(seq, name, assigneeType, assignees, extra) {
    return Object.assign({
      seq: seq, key: 'node-' + seq, name: name, type: 'approval',
      nodeCode: assigneeType === 'role' ? (assignees[0] || 'approver') : 'approval',
      assigneeType: assigneeType, assignees: assignees || [], assigneeLabels: [],
      mode: 'or', deadlineHours: 48, onTimeout: '提醒并标记超时待办',
      actions: ['approve', 'reject'], isPostReview: false, description: ''
    }, extra || {});
  }
  function defaultNodes(purpose, level) {
    if (purpose === 'emergency-review') {
      return [mkNode(1, '科室负责人补审核', 'auto', [], { isPostReview: true, deadlineHours: EMERGENCY_HOURS, nodeCode: 'leader' })];
    }
    if (purpose === 'rx-permission') {
      return [mkNode(1, '药学部门审核', 'role', ['pharmacy'], {}),
      mkNode(2, '审批专家终审', 'role', ['expert'], {})];
    }
    var arr = [mkNode(1, '科室负责人审核', 'auto', [], { nodeCode: 'leader' }),
    mkNode(2, '药学部门审核', 'role', ['pharmacy'], {})];
    if (level === 'special') arr.push(mkNode(3, '审批专家终审', 'role', ['expert'], {}));
    return arr;
  }

  /* 设计器保存草稿：已发布版本不可被草稿覆盖（SRS FR-011.10），须另起版本 */
  function newDraft(opts) {
    var purpose = opts.purpose || 'tier-approval';
    var level = opts.level ? D.normalizeLevel(opts.level) : '';
    var key = slug(purpose, level);
    var from = opts.fromId ? F.read('PlanDefinition', opts.fromId) : null;
    var n = nextVersionNumber(key);
    var nodes = from ? nodesFromActions(from) : renumber(opts.nodes || defaultNodes(purpose, level));
    var ext = Object.assign({
      purposeKey: key, purpose: purpose, level: level,
      title: opts.title || (D.flowPurposeName(purpose) + (level ? '（' + D.levelName(level) + '）' : '')),
      nodes: nodes,
      scopeDrug: '该分级全部药品', scopeDept: '全院', applyTitles: [], extraCond: '',
      rollbackFrom: null, publishInfo: null
    }, opts.patch || {});
    return F.create({
      resourceType: 'PlanDefinition', id: 'PlanDefinition-' + key + '-v' + n,
      url: pdUrl(key), identifier: [{ system: SYS.key, value: key }],
      version: String(n), name: 'Amr' + pascal(key) + 'V' + n,
      title: ext.title + '（草稿）', status: 'draft', date: nowInstant(),
      publisher: '演示医院 药事管理科（演示数据）',
      description: '抗菌药物审批流程定义 业务键 ' + key + ' 版本 ' + n + '（草稿）',
      action: toActions(ext.nodes), ext: ext
    });
  }
  function saveDraft(pdId, patch) {
    var pd = F.read('PlanDefinition', pdId);
    if (!pd) throw new Error('流程版本不存在：' + pdId);
    if (pd.status === 'active') throw new Error('已发布版本不可直接覆盖，请基于它新建草稿版本');
    var ext = Object.assign({}, pd.ext, patch || {});
    if (patch && patch.nodes) {
      ext.nodes = renumber(patch.nodes);
      pd.action = toActions(ext.nodes);
    }
    pd.title = (ext.title || pd.title) + '（草稿）';
    pd.description = '抗菌药物审批流程定义 业务键 ' + ext.purposeKey + ' 版本 ' + pd.version + '（草稿）';
    pd.date = nowInstant();
    pd.ext = ext;
    return F.update(pd);
  }

  /* SRS FR-011.9：至少一个审核节点，否则禁止发布 */
  function validate(input) {
    var nodes = Array.isArray(input) ? input : (input && input.ext && input.ext.nodes) || [];
    var errors = [];
    var approvals = nodes.filter(function (n) { return n.type !== 'start' && n.type !== 'end'; });
    if (!approvals.length) errors.push({ code: 'NO_NODE', field: 'nodes', message: '流程至少需要一个审核节点' });
    approvals.forEach(function (n, i) {
      var at = '第 ' + (i + 1) + ' 节点';
      if (!n.name) errors.push({ code: 'NO_NAME', field: 'node-' + (i + 1), message: at + '未填写名称' });
      if (!n.assigneeType) errors.push({ code: 'NO_ASSIGNEE_TYPE', field: 'node-' + (i + 1), message: at + '未选择审批对象类型' });
      if (n.assigneeType !== 'auto' && !asArray(n.assignees).length) {
        errors.push({ code: 'NO_ASSIGNEE', field: 'node-' + (i + 1), message: at + '未指定' + D.assigneeTypeName(n.assigneeType) + '对象' });
      }
      if (n.assigneeType === 'person') {
        (n.assignees || []).forEach(function (id) {
          if (!F.read('Practitioner', id)) errors.push({ code: 'BAD_REF', field: 'node-' + (i + 1), message: at + '引用的审批人不存在：' + id });
        });
      }
      if (n.assigneeType === 'department') {
        (n.assignees || []).forEach(function (id) {
          if (!F.read('Organization', id)) errors.push({ code: 'BAD_REF', field: 'node-' + (i + 1), message: at + '引用的科室不存在：' + id });
        });
      }
      if (!(Number(n.deadlineHours) > 0)) errors.push({ code: 'BAD_DEADLINE', field: 'node-' + (i + 1), message: at + '办理时限须大于 0' });
      if (!(n.actions || []).length) errors.push({ code: 'NO_ACTION', field: 'node-' + (i + 1), message: at + '未配置任何处理动作' });
      if (n.assigneeType !== 'auto') {
        var who = resolveAssignees(n, {});
        if (!who.length) errors.push({ code: 'NO_RESOLVABLE_ASSIGNEE', field: 'node-' + (i + 1),
          message: at + '「' + D.assigneeTypeName(n.assigneeType) + '」当前解析不到任何审批人，发布会导致无人可处理' });
      }
    });
    var seqs = approvals.map(function (n) { return n.seq; });
    if (new Set(seqs).size !== seqs.length) errors.push({ code: 'DUP_SEQ', field: 'nodes', message: '节点顺序号重复' });
    return { ok: errors.length === 0, errors: errors };
  }

  /* 发布前节点清单与配置摘要（SRS FR-011.8） */
  function diffSummary(nodes) {
    var a = (nodes || []).filter(function (n) { return n.type !== 'start' && n.type !== 'end'; });
    return [
      { label: '审核节点数', value: a.length + ' 个' },
      { label: '节点顺序', value: a.map(function (n) { return n.seq + '. ' + n.name; }).join(' → ') || '—' },
      { label: '按人员配置', value: a.filter(function (n) { return n.assigneeType === 'person'; }).length + ' 个' },
      { label: '按科室配置', value: a.filter(function (n) { return n.assigneeType === 'department'; }).length + ' 个' },
      { label: '按角色配置', value: a.filter(function (n) { return n.assigneeType === 'role'; }).length + ' 个' },
      { label: '含补审核节点', value: a.some(function (n) { return n.isPostReview; }) ? '是' : '否' },
      { label: '最长办理时限', value: (Math.max.apply(null, [0].concat(a.map(function (n) { return Number(n.deadlineHours) || 0; })))).toFixed(0) + ' 小时' }
    ];
  }

  /* SRS FR-015：发布即成为当前有效版本；被替代版本置 retired 但不删除 */
  function publish(pdId, opts) {
    opts = opts || {};
    var pd = F.read('PlanDefinition', pdId);
    if (!pd) throw new Error('流程版本不存在');
    var v = validate(pd);
    if (!v.ok) { var e = new Error(v.errors[0].message); e.errors = v.errors; throw e; }
    var key = pd.ext.purposeKey, retiredId = null;
    versions(pd.ext.purpose, pd.ext.level).forEach(function (p) {
      if (p.status === 'active' && p.id !== pd.id) {
        p.status = 'retired'; p.replacedBy = pd.id; p.ext = Object.assign({}, p.ext, { replacedBy: pd.id });
        retiredId = p.id; F.update(p);
      }
    });
    pd.status = 'active';
    pd.title = pd.ext.title || pd.title;
    pd.date = nowInstant();
    pd.publisher = opts.operator || actor().display;
    pd.ext.publishedAt = nowText();
    pd.ext.publishedBy = opts.operator || actor().display;
    pd.ext.publishInfo = { version: pd.version, publishedAt: nowText(), operator: pd.ext.publishedBy, note: opts.note || '' };
    if (opts.rollbackFrom) pd.ext.rollbackFrom = opts.rollbackFrom;
    pd.ext = Object.assign({}, pd.ext, { retiredId: retiredId });
    F.update(pd);
    setPointer(key, pd, opts.operator);
    auditLog('流程发布', D.flowPurposeName(pd.ext.purpose) + ' V' + pd.version + ' 已发布'
      + (opts.note ? '（' + opts.note + '）' : '') + (retiredId ? '，替代 ' + retiredId : ''),
      ['PlanDefinition/' + pd.id, 'Basic/Basic-workflow-current-' + key]);
    notify({ category: 'dynamic', type: '发布', targetRole: 'all',
      content: D.flowPurposeName(pd.ext.purpose) + ' 发布新版本 V' + pd.version + '，后续新申请即使用该版本',
      linkRoute: 'workflow-versions' });
    return { pd: F.read('PlanDefinition', pd.id), retiredId: retiredId, version: pd.version, publishedAt: pd.ext.publishedAt };
  }

  /* SRS FR-019：回退 = 把历史内容复制为「新的当前发布版本」，
   * 不删除中间版本、不改写历史审批实例（BR-006）。 */
  function rollback(pdId, opts) {
    opts = opts || {};
    var target = F.read('PlanDefinition', pdId);
    if (!target) throw new Error('目标历史版本不存在');
    var current = currentVersion(target.ext.purpose, target.ext.level);
    var from = { fromId: target.id, fromVersion: target.version, note: opts.note || '' };
    var d = newDraft({
      purpose: target.ext.purpose, level: target.ext.level, title: target.ext.title,
      fromId: target.id, patch: { rollbackFrom: from }
    });
    var r = publish(d.id, {
      operator: opts.operator, rollbackFrom: from,
      note: opts.note || ('由 V' + target.version + ' 回退恢复')
    });
    auditLog('流程回退', '回退恢复：目标版本 V' + target.version + '（' + target.id + '）→ 新发布版本 V' + r.version
      + (opts.note ? '；说明：' + opts.note : ''), ['PlanDefinition/' + target.id, 'PlanDefinition/' + r.pd.id]);
    return { pd: r.pd, version: r.version, fromVersion: target.version, fromId: target.id,
      retiredId: current ? current.id : null, operator: opts.operator || actor().display, at: nowText() };
  }

  /* SRS FR-018.4：比较任意两个版本的节点新增/删除/顺序/审批对象变化 */
  function compare(aId, bId) {
    var a = F.read('PlanDefinition', aId), b = F.read('PlanDefinition', bId);
    var empty = { added: [], removed: [], moved: [], changed: [], aNodes: [], bNodes: [] };
    if (!a || !b) return empty;
    var strip = function (list) { return (list || []).filter(function (n) { return n.type !== 'start' && n.type !== 'end'; }); };
    var an = strip(a.ext.nodes), bn = strip(b.ext.nodes);
    var keyOf = function (n) { return n.name + '|' + n.assigneeType + '|' + (n.assignees || []).join(','); };
    var sameSlot = function (n) { return an.filter(function (m) { return m.seq === n.seq; })[0]; };
    var sameName = function (n) {
      return an.filter(function (m) { return m.name === n.name && m.assigneeType === n.assigneeType; })[0];
    };
    return {
      a: a, b: b, aNodes: an, bNodes: bn,
      added: bn.filter(function (n) { return !sameSlot(n) && !sameName(n); }),
      removed: an.filter(function (n) { return !bn.some(function (m) { return m.seq === n.seq || keyOf(m) === keyOf(n); }); }),
      moved: bn.filter(function (n) { var m = sameName(n); return m && m.seq !== n.seq; })
        .map(function (n) { var m = sameName(n); return { node: n, from: m.seq, to: n.seq }; }),
      changed: bn.map(function (n) {
        var m = sameSlot(n);
        if (!m) return null;
        var fields = [];
        if (m.name !== n.name) fields.push('名称');
        if (m.assigneeType !== n.assigneeType) fields.push('审批对象类型');
        if ((m.assignees || []).join() !== (n.assignees || []).join()) fields.push('审批对象');
        if (Number(m.deadlineHours) !== Number(n.deadlineHours)) fields.push('办理时限');
        if ((m.actions || []).join() !== (n.actions || []).join()) fields.push('处理动作');
        if (!!m.isPostReview !== !!n.isPostReview) fields.push('补审核标识');
        return fields.length ? { node: n, from: m, fields: fields } : null;
      }).filter(Boolean)
    };
  }

  /* ------------------------------------------------------------ 三层授权 */
  function levelsOfMap(map) {
    return Object.keys(map || {}).filter(function (k) { return map[k]; })
      .sort(function (a, b) { return D.levelRank(a) - D.levelRank(b); });
  }
  var LAYER_LABEL = { person: '个人授权', department: '科室授权', title: '职称规则' };
  function mergePriority() {
    var b = F.read('Basic', 'Basic-authz-merge-priority');
    var order = (b && b.ext && b.ext.order) || ['person', 'department', 'title'];
    return {
      order: order,
      emptyMeans: (b && b.ext && b.ext.emptyMeans) || 'deny',
      label: (b && b.ext && b.ext.label) || order.map(function (c) { return LAYER_LABEL[c] || c; }).join(' ＞ ')
        + '（按顺序取第一个已配置且非空的层生效）'
    };
  }
  function setMergePriority(order, opts) {
    var id = 'Basic-authz-merge-priority';
    var ext = {
      order: order, emptyMeans: (opts && opts.emptyMeans) || 'deny',
      label: order.map(function (c) { return LAYER_LABEL[c] || c; }).join(' ＞ ')
        + '（按顺序取第一个已配置且非空的层生效）'
    };
    var cur = F.read('Basic', id);
    if (!cur) F.create({ resourceType: 'Basic', id: id, created: nowInstant(), code: { text: 'authz-merge-priority' }, ext: ext });
    else { cur.ext = ext; F.update(cur); }
    auditLog('授权优先级', '权限合并优先级调整为 ' + ext.label);
    return ext;
  }
  function titleRuleMatrix(titleCode) {
    var out = {};
    D.LEVELS.forEach(function (lv) {
      var p = F.read('Permission', 'Permission-map-' + lv.code);
      out[lv.code] = !!(p && p.ext && (p.ext.allowedTitles || []).indexOf(titleCode) >= 0);
    });
    return out;
  }
  function deptRule(orgId) { return F.read('Permission', 'Permission-dept-' + orgId); }
  function personRule(practId) { return F.read('Permission', 'Permission-person-' + practId); }

  function practitionerRole(practId) {
    return F.search('PractitionerRole', function (r) {
      return r.practitioner && r.practitioner.reference === 'Practitioner/' + practId;
    })[0] || null;
  }
  function practitionerInfo(practId) {
    var p = F.read('Practitioner', practId);
    if (!p) return null;
    var role = practitionerRole(practId);
    var orgId = role && role.organization ? idOf(role.organization.reference) : '';
    var org = orgId ? F.read('Organization', orgId) : null;
    return {
      id: practId, name: (p.name && p.name[0] && p.name[0].text) || practId,
      title: p.ext && p.ext.title,
      roleType: (role && role.ext && role.ext.roleType) || (p.ext && p.ext.roleType) || 'doctor',
      dept: (org && org.name) || (p.ext && p.ext.dept) || '',
      orgId: orgId, roleId: role ? role.id : '', active: !(p.ext && p.ext.active === false)
    };
  }

  /* 三层规则 + 命中的那一层（SRS FR-003.4、FR-005.6、BR-002） */
  function authorizations(practId) {
    var info = typeof practId === 'object' ? practId : practitionerInfo(practId);
    if (!info) return null;
    var mp = mergePriority();
    var tr = titleRuleMatrix(info.title);
    var dr = info.orgId ? deptRule(info.orgId) : null;
    var pr = personRule(info.id);
    var expired = !!(pr && pr.ext.expires && pr.ext.expires < global.Clock.date());
    var layers = {
      title: {
        layer: 'title', label: '职称规则', configured: !!info.title,
        source: info.title ? ('职称「' + D.titleName(info.title) + '」的等级授权矩阵') : '医师无职称，职称规则不适用',
        levels: levelsOfMap(tr), matrix: tr, ruleId: info.title ? 'Permission-map-*' : ''
      },
      department: {
        layer: 'department', label: '科室授权', configured: !!(dr && dr.status === 'active'),
        source: dr ? ('科室「' + (dr.ext.deptName || info.dept) + '」的科室级授权') : '所在科室未配置科室授权',
        levels: dr ? (dr.ext.levels || []).map(D.normalizeLevel) : [], ruleId: dr ? dr.id : ''
      },
      person: {
        layer: 'person', label: '个人授权', configured: !!(pr && pr.status === 'active' && !expired),
        source: pr ? ('个人授权：' + (pr.ext.grantLabel || '特批') + (expired ? '（已于 ' + pr.ext.expires + ' 到期）' : '')) : '未配置个人授权',
        levels: (pr && !expired) ? (pr.ext.levels || []).map(D.normalizeLevel) : [],
        expires: pr ? pr.ext.expires : '', expired: expired, ruleId: pr ? pr.id : ''
      }
    };
    function pick(wantLevels) {
      var hit = null;
      mp.order.forEach(function (name) {
        if (hit) return;
        var L = layers[name];
        if (L && L.configured && (wantLevels ? L.levels.length : true)) {
          hit = { layer: name, srcId: L.ruleId, srcLabel: L.label, ruleText: L.source, levels: L.levels.slice() };
        }
      });
      return hit;
    }
    var hit = pick(true) || pick(false) || { layer: 'none', srcId: '', srcLabel: '无命中规则',
      ruleText: '三层授权均未配置有效规则，按「' + (mp.emptyMeans === 'deny' ? '禁止使用' : '仅非限制使用') + '」处理',
      levels: mp.emptyMeans === 'deny' ? [] : ['non-restricted'] };
    return { practitioner: info, priority: mp.order, priorityLabel: mp.label,
      layers: layers, hit: hit, levels: hit.levels };
  }

  /* -------------------------------------------------------- 等级与权限判定 */
  function drugGrade(medication) {
    var mk = F.search('MedicationKnowledge', function (k) {
      return (k.associatedMedication || []).some(function (a) { return idOf(a.reference) === medication.id; });
    })[0];
    var level = D.normalizeLevel(medication.ext && medication.ext.level);
    if (mk && mk.ext && mk.ext.level) level = D.normalizeLevel(mk.ext.level);
    return { level: level, sourceId: mk ? mk.id : medication.id, sourceLabel: mk ? 'MedicationKnowledge（药品知识）' : 'Medication（药品）' };
  }

  /* FR-005：选择药品时与提交时都调用本函数（判定不是一次性的） */
  function check(params) {
    var practId = typeof params.practitioner === 'string' ? params.practitioner
      : (params.practitioner && params.practitioner.practitioner);
    var med = typeof params.medicationId === 'string' ? F.read('Medication', params.medicationId) : params.medication;
    if (!med) return { error: '药品不存在：' + params.medicationId };
    var grade = drugGrade(med);
    var authz = authorizations(practId);
    if (!authz) return { error: '医师档案不存在：' + practId };
    var maxRank = Math.max.apply(null, [0].concat(authz.levels.map(D.levelRank)));
    var allowed = authz.levels.indexOf(grade.level) >= 0;
    var missing = D.LEVELS.filter(function (l) {
      return D.levelRank(l.code) > maxRank && D.levelRank(l.code) <= D.levelRank(grade.level);
    }).map(function (l) { return l.code; });
    var purpose = params.isEmergency ? 'emergency-review' : 'tier-approval';
    var pd = currentVersion(purpose, grade.level);
    return {
      allowed: allowed,
      grade: grade.level, gradeName: D.levelName(grade.level), gradeRank: D.levelRank(grade.level),
      gradeSource: grade.sourceLabel, gradeSourceId: grade.sourceId,
      allowedLevels: authz.levels.slice(), maxRank: maxRank, missingLevels: missing,
      hit: authz.hit, layers: authz.layers, priority: authz.priority, priorityLabel: authz.priorityLabel,
      practitioner: authz.practitioner, practitionerId: practId,
      medicationId: med.id, medicationName: med.code.text, medicationCode: (med.ext || {}).drugCode || med.id,
      reason: allowed ? '药品等级「' + D.levelName(grade.level) + '」在医师可使用范围内（命中' + authz.hit.srcLabel + '）'
        : '药品等级「' + D.levelName(grade.level) + '」高于医师当前授权（'
          + (authz.levels.length ? authz.levels.map(D.levelName).join('/') : '无有效授权')
          + '）；命中规则：' + authz.hit.srcLabel + ' — ' + authz.hit.ruleText,
      suggestion: allowed ? '权限符合，可直接提交（提交时仍须选择用药目的）'
        : (pd ? '需经「' + (pd.ext.title || D.flowPurposeName(purpose)) + ' V' + pd.version + '」审批；紧急情况可选择临时越级使用'
          : '该等级尚未发布审批流程，请先在「审批流程设计」中发布版本'),
      route: pd ? { purpose: purpose, purposeKey: pd.ext.purposeKey, pdId: pd.id, version: pd.version,
        url: pd.url, nodes: (pd.ext.nodes || []).slice(), label: 'V' + pd.version,
        title: pd.ext.title || pd.title } : null,
      triggersApproval: !allowed && !!pd,
      emergencyDeadline: global.Clock.deadline(nowInstant(), EMERGENCY_HOURS)
    };
  }

  /* ---------------------------------------------------------------- 开单 */
  function genNo(type) {
    var d = new Date(global.Clock.now().getTime());
    var s = d.getFullYear() + pad(d.getMonth() + 1) + pad(d.getDate());
    if (type === 'order') return 'RX' + s + '-' + (F.count('MedicationRequest') + 1);
    return 'SP' + s + '-' + (F.count('Task', function (t) { return t.ext && t.ext.taskKind === 'main'; }) + 1001);
  }

  /* SRS §9.5：MedicationRequest 表达医师开立的抗菌药物。等级快照、用药目的、
   * 紧急标识、权限命中依据全部留痕。不写 basedOn→Task，只保留 Task.focus→MR
   * 单向，否则因 MedicationRequest 先于 Task 落库而触发悬空引用丢弃。 */
  function createMedicationRequest(p) {
    var med = typeof p.medicationId === 'string' ? F.read('Medication', p.medicationId) : p.medication;
    if (!med) throw new Error('药品不存在');
    var grade = drugGrade(med);
    var no = genNo('order');
    var orderStatus = p.orderStatus || (p.check && p.check.allowed ? 'approved' : 'pending-approval');
    var who = practitionerInfo(p.requesterPractId) || { name: '' };
    return F.create({
      resourceType: 'MedicationRequest',
      identifier: [{ system: SYS.order, value: no }],
      status: D.orderStatus(orderStatus).mr,
      statusReason: { coding: [coding(SYS.orderStatus, orderStatus, D.orderStatusName(orderStatus))], text: D.orderStatusName(orderStatus) },
      intent: 'order',
      medicationReference: ref('Medication', med.id, med.code.text),
      subject: ref('Patient', p.patientId, p.patientName),
      encounter: p.encounterId ? ref('Encounter', p.encounterId) : undefined,
      requester: ref('Practitioner', p.requesterPractId, who.name),
      authoredOn: nowInstant(),
      reasonCode: (p.diagnosis ? [{ text: p.diagnosis }] : undefined),
      dosageInstruction: [{
        text: p.dosageText || (med.ext && med.ext.usage) || '',
        route: p.route ? { coding: [{ code: p.route, display: p.route }] } : undefined
      }],
      note: [{ text: [p.applicationReason, p.purposeNote, p.emergencyReason].filter(Boolean).join('；') }],
      ext: {
        orderNo: no, orderStatus: orderStatus,
        purpose: p.purposeCode ? { code: p.purposeCode, name: D.purposeName(p.purposeCode), note: p.purposeNote || '' } : null,
        purposeCodes: p.purposeCode ? [p.purposeCode] : [],
        gradeSnapshot: { level: grade.level, name: D.levelName(grade.level), at: nowText(), source: grade.sourceId, sourceId: grade.sourceId },
        authzHit: p.check ? { layer: p.check.hit.layer, srcId: p.check.hit.srcId, srcLabel: p.check.hit.srcLabel,
          ruleText: p.check.hit.ruleText, allowedLevels: p.check.allowedLevels, reason: p.check.reason } : null,
        emergency: !!p.isEmergency, emergencyReason: p.emergencyReason || '',
        dosage: { text: p.dosageText || '', frequency: p.frequency || '', days: p.days || '', route: p.route || '' },
        patientName: p.patientName || '', mrn: p.mrn || '', diagnosis: p.diagnosis || '',
        drugName: med.code.text, drugCode: (med.ext || {}).drugCode || med.id,
        deptName: p.deptName || (who ? who.dept : ''), applicationReason: p.applicationReason || '',
        createdAt: nowText()
      }
    });
  }

  /* ------------------------------------------------- 审批对象解析（BR-008） */
  /* 角色 → 人员：优先看 PractitionerRole.code 的 coding（标准元素，FHIR 原生客户端
   * 也能按 role= 检索），再看本系统 ext.roles。 */
  function roleCodesOf(r) {
    var out = asArray(r.code).map(function (c) {
      return asArray(c && c.coding).map(function (cd) { return cd.code; });
    }).reduce(function (a, b) { return a.concat(b); }, []);
    return out.concat(asArray(r.ext && r.ext.roles));
  }
  function practitionersOfRole(roleCode) {
    return F.search('PractitionerRole', function (r) {
      return roleCodesOf(r).indexOf(roleCode) >= 0 || (r.ext && r.ext.roleType === roleCode);
    }).map(function (r) { return practitionerInfo(idOf(r.practitioner.reference)); }).filter(Boolean);
  }
  function practitionersOfDept(orgId) {
    var inOrg = F.search('PractitionerRole', function (r) {
      return r.organization && r.organization.reference === 'Organization/' + orgId;
    }).map(function (r) { return practitionerInfo(idOf(r.practitioner.reference)); }).filter(Boolean);
    // 科室节点优先取承担审批职责的人员（科室负责人/药学/专家/感染科）
    var approvable = inOrg.filter(function (p) {
      var roles = (F.read('PractitionerRole', p.roleId) || { ext: {} }).ext.roles || [p.roleType];
      return roles.some(function (c) { return ['leader', 'pharmacy', 'expert', 'infection'].indexOf(c) >= 0; });
    });
    return approvable.length ? approvable : inOrg;
  }
  function resolveAssignees(node, ctx) {
    var out = [];
    ctx = ctx || {};
    if (node.assigneeType === 'person') {
      out = asArray(node.assignees).map(function (id) {
        var p = practitionerInfo(id);
        if (!p) return null;
        p.basis = 'person'; p.via = '节点直接指定人员：' + p.name; return p;
      }).filter(Boolean);
    } else if (node.assigneeType === 'department') {
      asArray(node.assignees).forEach(function (orgId) {
        var org = F.read('Organization', orgId);
        practitionersOfDept(orgId).forEach(function (p) {
          p.basis = 'department'; p.viaOrg = orgId;
          p.via = '科室「' + (org ? org.name : orgId) + '」内具备审批职责的人员';
          out.push(p);
        });
      });
    } else if (node.assigneeType === 'role') {
      asArray(node.assignees).forEach(function (roleCode) {
        practitionersOfRole(roleCode).forEach(function (p) {
          p.basis = 'role'; p.viaRole = roleCode;
          p.via = '角色「' + D.approvalRoleName(roleCode) + '」的全部在岗人员';
          out.push(p);
        });
      });
    } else if (node.assigneeType === 'department') {
      // 兜底：该科室若没有具备审批岗位的人员，则科室内在岗人员均可处理，
      // 否则流程会卡在「没有人能审批」的死节点上（演示中更难排查）。
      out.forEach(function (p) { if (!p.via) p.via = '科室成员'; });
    } else {
      var pool = practitionersOfDept(ctx.orgId).filter(function (p) { return p.roleType === 'leader'; });
      out = (pool.length ? pool : practitionersOfRole('leader')).map(function (p) {
        p.basis = 'auto'; p.via = '按开单医师所属科室自动匹配的科室负责人'; return p;
      });
    }
    var seen = {};
    return out.filter(function (p) { if (seen[p.id]) return false; seen[p.id] = 1; return true; });
  }

  /* ------------------------------------------------------- 流程实例创建 */
  function nodeTaskId(mainId, seq) { return mainId + '-N' + seq; }
  function nodeTasksOf(mainId) {
    return F.search('Task', function (t) { return t.ext && t.ext.taskKind === 'node' && t.ext.mainTask === mainId; })
      .sort(function (a, b) { return a.ext.seq - b.ext.seq; });
  }

  function createInstance(p) {
    var mr = p.mr || F.read('MedicationRequest', p.medicationRequestId);
    if (!mr) throw new Error('开单记录不存在');
    var level = (mr.ext.gradeSnapshot || {}).level;
    var pd = p.pd || currentVersion(p.purpose, level);
    if (!pd) throw new Error('未找到「' + D.flowPurposeName(p.purpose) + '」已发布流程版本，请先发布');
    var v = validate(pd);
    if (!v.ok) throw new Error('流程定义不完整：' + v.errors[0].message);
    var nodes = renumber((pd.ext.nodes || []).filter(function (n) { return n.type !== 'start' && n.type !== 'end'; }));
    var no = genNo('approval');
    var ctx = practitionerInfo(p.requesterPractId) || {};
    var isPost = p.purpose === 'emergency-review';
    var flowStatus = isPost ? 'post-review-pending' : 'waiting-node';
    var mainId = 'Task-flow-' + no.replace(/\D+/g, '');
    var deadlineEnd = global.Clock.deadline(mr.authoredOn || nowInstant(),
      nodes.length ? (nodes[0].deadlineHours || EMERGENCY_HOURS) : EMERGENCY_HOURS);

    var main = F.create({
      resourceType: 'Task', id: mainId,
      identifier: [{ system: SYS.sqno, value: no }],
      status: D.flowStatusTask(flowStatus),
      businessStatus: { coding: [coding(SYS.flowStatus, flowStatus, D.flowStatusName(flowStatus))], text: D.flowStatusName(flowStatus) },
      intent: 'order',
      code: { coding: [coding(SYS.taskCode, isPost ? 'amr-emergency-review' : 'amr-tier-approval',
        isPost ? '紧急越级补审核' : '抗菌药物分级审批')], text: D.flowPurposeName(p.purpose) },
      instantiatesCanonical: pd.url + '|' + pd.version,
      for: mr.subject, encounter: mr.encounter,
      focus: ref('MedicationRequest', mr.id),
      requester: mr.requester,
      authoredOn: nowInstant(), lastModified: nowInstant(),
      input: [
        { type: { coding: [coding(CANON + '/task-input', 'purpose', '用药目的')], text: '用药目的' },
          valueString: mr.ext.purpose ? (mr.ext.purpose.name + (mr.ext.purpose.note ? '：' + mr.ext.purpose.note : '')) : '' },
        { type: { coding: [coding(CANON + '/task-input', 'reason', '申请原因')], text: '申请原因' }, valueString: p.applicationReason || '' },
        { type: { coding: [coding(CANON + '/task-input', 'authz', '权限校验结论')], text: '权限校验' }, valueString: (p.check || {}).reason || '' }
      ],
      ext: {
        taskKind: 'main', purpose: p.purpose, purposeKey: pd.ext.purposeKey, level: level,
        flowStatus: flowStatus, sqno: no, pdId: pd.id, version: pd.version, pdUrl: pd.url, pdTitle: pd.ext.title,
        mrId: mr.id, drug: mr.ext.drugName, drugCode: mr.ext.drugCode,
        gradeSnapshot: mr.ext.gradeSnapshot, authzHit: mr.ext.authzHit,
        emergency: !!p.isEmergency, emergencyReason: p.emergencyReason || '', clinicalNote: p.clinicalNote || '',
        patientName: mr.ext.patientName, mrn: mr.ext.mrn, diagnosis: mr.ext.diagnosis,
        dept: ctx.dept || '', requesterTitle: ctx.title || '', requesterName: ctx.name || '',
        applicationReason: p.applicationReason || '',
        purposeInfo: mr.ext.purpose,
        postReviewDeadline: isPost ? deadlineEnd : '',
        nodeSeqs: nodes.map(function (n) { return n.seq; }),
        currentNodeSeq: 1, flow: [], decision: null, createdAt: nowText()
      }
    });

    // 节点 Task 必须晚于主 Task 创建：服务端校验 partOf 引用目标存在
    nodes.forEach(function (n, i) {
      createNodeTask(main, pd, n, i === 0 ? 'requested' : 'draft', mr, ctx);
    });
    refreshMain(main.id);
    return F.read('Task', main.id);
  }

  function createNodeTask(main, pd, node, status, mr, ctx) {
    var assignees = resolveAssignees(node, { orgId: (ctx || {}).orgId });
    var hours = node.isPostReview ? (node.deadlineHours || EMERGENCY_HOURS) : (node.deadlineHours || 24);
    var period = { start: main.authoredOn || nowInstant(), end: global.Clock.deadline(main.authoredOn || nowInstant(), hours) };
    var t = F.create({
      resourceType: 'Task', id: nodeTaskId(main.id, node.seq),
      identifier: [{ system: SYS.sqno, value: main.ext.sqno + '-N' + node.seq }],
      status: status,
      businessStatus: { text: status === 'draft' ? '未到达' : (status === 'requested' ? '待' + node.name + '处理' : status) },
      intent: 'order',
      code: { coding: [coding(SYS.taskCode, 'amr-approval-node', node.name)], text: node.name },
      description: node.description || node.name,
      partOf: [ref('Task', main.id)],
      instantiatesCanonical: pd.url + '|' + pd.version,
      focus: mr ? ref('MedicationRequest', mr.id) : main.focus,
      for: main.for, encounter: main.encounter, requester: main.requester,
      owner: assignees.length ? ref('Practitioner', assignees[0].id, assignees[0].name) : undefined,
      authoredOn: nowInstant(), lastModified: nowInstant(),
      restriction: { period: period, repetitions: { count: 1 } },
      input: [{ type: { coding: [coding(CANON + '/task-input', 'node-config', '节点配置')], text: '节点配置' },
        valueString: JSON.stringify(node) }],
      ext: {
        taskKind: 'node', mainTask: main.id, seq: node.seq, isPostReview: !!node.isPostReview,
        node: node, assignees: assignees, assigneeIds: assignees.map(function (a) { return a.id; }),
        actedBy: null, deadlineStart: period.start, deadlineEnd: period.end
      }
    });
    if (status === 'requested') notifyAssignees(main, t);
    return t;
  }
  function notifyAssignees(main, nodeTask) {
    var n = nodeTask.ext.node || {};
    (nodeTask.ext.assignees || []).forEach(function (a) {
      notify({ category: 'notification', type: n.isPostReview ? '补审核待办' : '审批待办',
        content: '【' + (n.isPostReview ? '紧急补审核 · 24 小时' : D.levelName(main.ext.level)) + '】'
          + main.ext.patientName + ' · ' + main.ext.drug + ' 待您在「' + n.name + '」处理（截止 '
          + (nodeTask.ext.deadlineEnd || '').replace('T', ' ').slice(0, 16) + '）',
        toPractitioner: a.id, toName: a.name, subjectRef: ref('Task', nodeTask.id), patientRef: main.for,
        linkRoute: n.isPostReview ? 'emergency-review' : 'approval-center', linkTask: main.id, unread: true });
    });
  }

  /* ext.flow 是给旧页面与流程图用的派生投影，真相源始终是节点 Task。 */
  function materializeProjection(mainId) {
    var main = F.read('Task', mainId);
    if (!main || main.ext.taskKind !== 'main') return null;
    main.ext.flow = nodeTasksOf(mainId).map(function (t) {
      var n = t.ext.node || {}, acted = t.ext.actedBy || {};
      return {
        seq: t.ext.seq, role: n.nodeCode || n.assigneeType, roleName: n.name, name: n.name,
        role2: n.nodeCode || n.assigneeType,
        assigneeType: n.assigneeType, isPostReview: !!t.ext.isPostReview,
        status: nodeProjectionStatus(t),
        approver: acted.by || (OPEN_NODE.indexOf(t.status) >= 0
          ? asArray(t.ext.assignees).map(function (a) { return a.name; }).join('、') : ''),
        time: acted.time || '', comment: acted.comment || '',
        nodeTaskId: t.id, deadlineEnd: t.ext.deadlineEnd || ''
      };
    });
    return F.update(main);
  }
  function nodeProjectionStatus(t) {
    if (t.status === 'completed') return 'approved';
    if (t.status === 'rejected') return 'rejected';
    if (t.status === 'on-hold') return 'returned';
    if (t.status === 'cancelled') return 'cancelled';
    if (OPEN_NODE.indexOf(t.status) >= 0) return 'current';
    return 'pending';
  }

  /* 依据节点完成情况刷新主任务、医嘱状态与流程图 */
  function refreshMain(mainId) {
    var main = F.read('Task', mainId);
    if (!main) return null;
    var nodes = nodeTasksOf(mainId);
    if (!nodes.length) return main;
    var current = nodes.filter(function (t) { return OPEN_NODE.indexOf(t.status) >= 0; })[0];
    var rejected = nodes.filter(function (t) { return t.status === 'rejected'; })[0];
    var returned = nodes.filter(function (t) { return t.status === 'on-hold'; })[0];
    var allDone = nodes.every(function (t) { return t.status === 'completed'; });
    var isPost = main.ext.purpose === 'emergency-review';
    var flowStatus;
    if (rejected) flowStatus = 'rejected';
    else if (returned) flowStatus = 'returned';
    else if (allDone) flowStatus = isPost ? 'post-review-done' : 'approved';
    else if (current) flowStatus = isPost ? 'post-review-running' : 'waiting-node';
    else flowStatus = isPost ? 'post-review-pending' : 'pending-submit';

    var order = flowStatus === 'approved' ? 'ready-to-submit'
      : flowStatus === 'rejected' ? 'rejected'
        : flowStatus === 'post-review-done' ? 'post-reviewed'
          : isPost && flowStatus.indexOf('post-review') === 0 ? 'post-review-pending' : null;

    main.ext.flowStatus = flowStatus;
    main.status = D.flowStatusTask(flowStatus);
    main.businessStatus = {
      coding: [coding(SYS.flowStatus, flowStatus, D.flowStatusName(flowStatus))],
      text: current ? ('待' + (current.ext.node ? current.ext.node.name : '审核') + '审批') : D.flowStatusName(flowStatus)
    };
    main.ext.currentNodeSeq = current ? current.ext.seq : null;
    if (rejected) {
      main.ext.decision = { result: 'rejected', by: (rejected.ext.actedBy || {}).by,
        time: (rejected.ext.actedBy || {}).time, reason: (rejected.ext.actedBy || {}).comment };
    } else if (allDone) {
      var last = nodes[nodes.length - 1];
      main.ext.decision = { result: 'approved', by: (last.ext.actedBy || {}).by,
        time: (last.ext.actedBy || {}).time, reason: (last.ext.actedBy || {}).comment || '' };
    }
    if (order) main.ext.orderStatus = order;
    main.lastModified = nowInstant();
    F.update(main);
    if (order && main.ext.mrId) applyOrderStatus(main.ext.mrId, order, flowStatus);
    materializeProjection(mainId);
    return F.read('Task', mainId);
  }
  function applyOrderStatus(mrId, orderStatus, flowStatus) {
    var mr = F.read('MedicationRequest', mrId);
    if (!mr) return null;
    mr.status = D.orderStatus(orderStatus).mr;
    mr.statusReason = { coding: [coding(SYS.orderStatus, orderStatus, D.orderStatusName(orderStatus))], text: D.orderStatusName(orderStatus) };
    mr.ext.orderStatus = orderStatus;
    if (flowStatus) mr.ext.flowStatus = flowStatus;
    return F.update(mr);
  }

  /* ------------------------------------------------------------------ 审批 */
  function actionableNodeTasks(practId) {
    if (!practId) return [];
    return F.search('Task', function (t) {
      if (!t.ext || t.ext.taskKind !== 'node') return false;
      if (OPEN_NODE.indexOf(t.status) < 0) return false;
      var main = F.read('Task', t.ext.mainTask);
      if (!main || CLOSED_MAIN.indexOf(main.ext.flowStatus) >= 0) return false;
      return asArray(t.ext.assigneeIds).indexOf(practId) >= 0;
    }).sort(function (a, b) { return (b.authoredOn || '').localeCompare(a.authoredOn || ''); });
  }
  function firstActionableNode(mainId, practId) {
    var nodes = nodeTasksOf(mainId).filter(function (t) { return OPEN_NODE.indexOf(t.status) >= 0; });
    if (!practId) return nodes[0] || null;
    return nodes.filter(function (t) { return asArray(t.ext.assigneeIds).indexOf(practId) >= 0; })[0] || null;
  }

  /* SRS FR-022：动作集合来自节点配置；通过后激活下一节点；全部通过则实例通过；
   * 每次操作记录操作人、时间、类型与意见。 */
  function act(params) {
    var action = params.action;
    var nodeTask = params.nodeTaskId ? F.read('Task', params.nodeTaskId)
      : firstActionableNode(params.taskId, params.operatorPractId);
    if (!nodeTask) throw new Error('当前没有待您处理的审批节点');
    if (nodeTask.ext.taskKind !== 'node') throw new Error('所选任务不是节点任务');
    var main = F.read('Task', nodeTask.ext.mainTask);
    var node = nodeTask.ext.node || {};
    var allowed = (node.actions || ['approve', 'reject']);
    if (allowed.indexOf(action) < 0) {
      throw new Error('节点「' + (node.name || '') + '」未配置「' + actionName(action) + '」操作');
    }
    if (action === 'reject' && !params.comment) throw new Error('驳回必须填写原因');
    var practId = params.operatorPractId || actor().practitioner;
    if (!practId) throw new Error('缺少审批操作人身份');
    var who = practitionerInfo(practId);
    if (!who) throw new Error('审批操作人档案不存在：' + practId);

    nodeTask.ext.actedBy = { by: who.name, practitioner: practId, time: nowText(),
      comment: params.comment || (action === 'approve' ? '同意' : ''), action: action };
    nodeTask.output = [
      { type: { coding: [coding(CANON + '/task-output', 'decision', '审批结论')], text: '审批结论' }, valueString: actionName(action) },
      { type: { coding: [coding(CANON + '/task-output', 'comment', '审批意见')], text: '审批意见' }, valueString: nodeTask.ext.actedBy.comment },
      { type: { coding: [coding(CANON + '/task-output', 'approver', '审批人')], text: '审批人' }, valueString: who.name },
      { type: { coding: [coding(CANON + '/task-output', 'time', '处理时间')], text: '处理时间' }, valueString: nodeTask.ext.actedBy.time }
    ];
    if (action === 'approve') nodeTask.status = 'completed';
    else if (action === 'reject') nodeTask.status = 'rejected';
    else nodeTask.status = 'on-hold';
    nodeTask.businessStatus = { text: actionName(action) };
    nodeTask.lastModified = nowInstant();
    F.update(nodeTask);

    var nextTask = null;
    if (action === 'approve') {
      var nodes = nodeTasksOf(main.id);
      var idx = nodes.map(function (t) { return t.id; }).indexOf(nodeTask.id);
      nextTask = nodes.slice(idx + 1).filter(function (t) { return t.status === 'draft'; })[0] || null;
      if (nextTask) {
        nextTask.status = 'requested';
        nextTask.businessStatus = { text: '待' + nextTask.ext.node.name + '处理' };
        nextTask.authoredOn = nowInstant();
        nextTask.lastModified = nowInstant();
        F.update(nextTask);
        notifyAssignees(main, nextTask);
      }
    } else if (action === 'reject') {
      nodeTasksOf(main.id).forEach(function (t) {
        if (t.status === 'draft') {
          t.status = 'cancelled'; t.businessStatus = { text: '因驳回未执行' }; F.update(t);
        }
      });
    }
    var m = refreshMain(main.id);
    var isPost = m.ext.purpose === 'emergency-review';
    var requesterPract = idOf(m.requester.reference);
    var nodeName = node.name || '';

    notify({ category: 'notification', type: isPost ? '补审核进展' : '审批进展',
      content: '『' + m.ext.drug + '』' + (isPost ? '紧急越级补审核' : '抗菌药物申请') + '：'
        + (action === 'approve'
          ? (nextTask ? '「' + nodeName + '」已通过，流转至「' + nextTask.ext.node.name + '」' : '全部节点通过，可提交临床系统（演示）')
          : action === 'reject' ? '「' + nodeName + '」驳回：' + params.comment
            : '「' + nodeName + '」退回补充：' + (params.comment || '请补充材料'))
        + '（处理人 ' + who.name + '）',
      toPractitioner: requesterPract, toName: practitionerInfo(requesterPract).name,
      subjectRef: ref('Task', m.id), patientRef: m.for, linkRoute: isPost ? 'emergency-review' : 'order-demo',
      linkTask: m.id, unread: true });
    notify({ category: 'dynamic', type: actionName(action), targetRole: 'all',
      content: m.ext.drug + '（' + D.levelName(m.ext.level) + '）' + (isPost ? '补审核' : '审批')
        + '·' + nodeName + ' ' + actionName(action) + '（' + who.name + '）',
      linkRoute: 'approval-center', linkTask: m.id });
    auditLog(isPost ? '补审核处理' : '审批处理',
      '『' + m.ext.sqno + '』节点 ' + nodeTask.ext.seq + '·' + nodeName + ' ' + actionName(action)
      + '；操作人 ' + who.name + '；意见 ' + (nodeTask.ext.actedBy.comment || '—')
      + '；实例状态 ' + D.flowStatusName(m.ext.flowStatus),
      ['Task/' + nodeTask.id, 'Task/' + m.id, 'MedicationRequest/' + m.ext.mrId]);

    return { nodeTask: F.read('Task', nodeTask.id), mainTask: m, orderStatus: m.ext.orderStatus,
      flowStatus: m.ext.flowStatus,
      next: nextTask ? { seq: nextTask.ext.seq, name: nextTask.ext.node.name, assignees: nextTask.ext.assignees } : null };
  }
  function actionName(a) { return { approve: '通过', reject: '驳回', return: '退回补充' }[a] || a; }

  function withdraw(mainId, reason) {
    var main = F.read('Task', mainId);
    nodeTasksOf(mainId).forEach(function (t) {
      if (['draft'].indexOf(t.status) >= 0 || OPEN_NODE.indexOf(t.status) >= 0) {
        t.status = 'cancelled'; t.businessStatus = { text: '申请人撤回' }; F.update(t);
      }
    });
    main.ext.withdrawReason = reason || '';
    main.ext.flowStatus = 'withdrawn';
    main.status = D.flowStatusTask('withdrawn');
    main.businessStatus = { coding: [coding(SYS.flowStatus, 'withdrawn', '已撤回')], text: '已撤回' };
    main.lastModified = nowInstant();
    F.update(main);
    if (main.ext.mrId) applyOrderStatus(main.ext.mrId, 'cancelled', 'withdrawn');
    materializeProjection(mainId);
    auditLog('审批撤回', '『' + main.ext.sqno + '』已由医师撤回' + (reason ? '：' + reason : ''), ['Task/' + mainId]);
    return F.read('Task', mainId);
  }
  /* 退回补充后医师补齐材料重新提交：同一实例继续，原审批记录保留 */
  function resubmit(mainId, comment) {
    var held = nodeTasksOf(mainId).filter(function (t) { return t.status === 'on-hold'; })[0];
    if (!held) throw new Error('当前申请没有待补充的节点');
    held.status = 'requested';
    held.businessStatus = { text: '待' + held.ext.node.name + '处理（已补充材料）' };
    held.ext.resubmitNote = comment || '';
    held.ext.resubmitAt = nowText();
    F.update(held);
    var m = refreshMain(mainId);
    notify({ category: 'notification', type: '补充已提交',
      content: '『' + m.ext.drug + '』申请已补充材料，重新提交至「' + held.ext.node.name + '」',
      toPractitioner: (held.ext.assignees[0] || {}).id, toName: (held.ext.assignees[0] || {}).name,
      subjectRef: ref('Task', m.id), patientRef: m.for, linkRoute: 'approval-center', linkTask: m.id, unread: true });
    auditLog('审批补充', '『' + m.ext.sqno + '』补充材料后重新提交：' + (comment || ''), ['Task/' + m.id]);
    return F.read('Task', m.id);
  }
  /* 被驳回后修改重提：新建实例，原实例与其审批记录完整保留（FR-007.8） */
  function resubmitAfterReject(mainId, patch) {
    var old = F.read('Task', mainId);
    var mr = F.read('MedicationRequest', old.ext.mrId);
    if (!mr) throw new Error('原开单记录不存在，无法修改重提');
    old.ext.revised = true;
    old.ext.revisedTo = '(待生成)';
    F.update(old);
    var base = {
      medicationId: idOf(mr.medicationReference.reference),
      patientId: idOf(mr.subject.reference),
      encounterId: mr.encounter ? idOf(mr.encounter.reference) : '',
      requesterPractId: idOf(mr.requester.reference),
      purposeCode: mr.ext.purpose ? mr.ext.purpose.code : '',
      purposeNote: mr.ext.purpose ? mr.ext.purpose.note : '',
      dosageText: mr.ext.dosage ? mr.ext.dosage.text : '',
      diagnosis: mr.ext.diagnosis, patientName: mr.ext.patientName, mrn: mr.ext.mrn,
      applicationReason: old.ext.applicationReason,
      orderStatus: 'pending-approval'
    };
    var created = createMedicationRequest(Object.assign({}, base, patch || {}));
    var recheck = null;
    try {
      recheck = check({ practitioner: base.requesterPractId, medicationId: base.medicationId,
        isEmergency: !!old.ext.emergency });
    } catch (_) { recheck = null; }
    var inst = createInstance({
      mr: created, purpose: old.ext.purpose, requesterPractId: base.requesterPractId,
      applicationReason: (patch && patch.applicationReason) || base.applicationReason,
      check: recheck
    });
    inst.ext.revisedFrom = old.id;
    old.ext.revisedTo = inst.id;
    F.update(old);
    F.update(inst);
    auditLog('审批重提交', '『' + old.ext.sqno + '』驳回后修改重提，新申请编号 ' + inst.ext.sqno + '；原申请与审批记录保留',
      ['Task/' + old.id, 'Task/' + inst.id]);
    return F.read('Task', inst.id);
  }

  /* 紧急越级：先允许临时使用，再生成 24 小时补审核（FR-008 / BR-005） */
  function createEmergency(p) {
    if (!p.emergencyReason) throw new Error('紧急使用原因与临床说明为必填');
    var created = createMedicationRequest(Object.assign({}, p, { orderStatus: 'emergency-temp', isEmergency: true }));
    var inst = createInstance({
      mr: created, purpose: 'emergency-review', requesterPractId: p.requesterPractId,
      applicationReason: p.emergencyReason, isEmergency: true,
      emergencyReason: p.emergencyReason, clinicalNote: p.clinicalNote
    });
    inst = F.read('Task', inst.id);
    var nodes = nodeTasksOf(inst.id);
    inst.ext.postReviewDeadline = (nodes[0] || { ext: {} }).ext.deadlineEnd || inst.ext.postReviewDeadline;
    inst.ext.clinicalNote = p.clinicalNote || '';
    F.update(inst);
    applyOrderStatus(created.id, 'post-review-pending', 'post-review-pending');
    auditLog('紧急越级', '医师『' + practitionerInfo(p.requesterPractId).name + '』对『' + created.ext.drugName + '』（'
      + D.levelName(inst.ext.level) + '）发起紧急临时越级使用；补审核截止 ' + inst.ext.postReviewDeadline
      + '；原因：' + p.emergencyReason, ['MedicationRequest/' + created.id, 'Task/' + inst.id]);
    return { mr: F.read('MedicationRequest', created.id), mainTask: F.read('Task', inst.id) };
  }
  function submitPostReviewMaterials(mainId, materials) {
    var main = F.read('Task', mainId);
    main.ext.postReview = Object.assign({}, main.ext.postReview || {}, materials || {});
    main.ext.postReviewSubmittedAt = nowText();
    auditLog('补审核材料', '『' + main.ext.sqno + '』提交补审核补充材料：'
      + Object.keys(materials || {}).map(function (k) { return k + '=' + materials[k]; }).join('；'),
      ['Task/' + mainId]);
    return F.update(main);
  }

  /* -------------------------------------------------------------- 视图模型 */
  function timeoutState(main) {
    if (!main || main.ext.taskKind !== 'main') return { kind: 'none', deadline: '', text: '—', timeout: false };
    var nodes = nodeTasksOf(main.id);
    var cur = nodes.filter(function (t) { return OPEN_NODE.indexOf(t.status) >= 0 || t.status === 'on-hold'; })[0];
    var deadline = cur ? cur.ext.deadlineEnd : (main.ext.postReviewDeadline || '');
    if (!deadline) return { kind: 'none', deadline: '', text: '—', timeout: false };
    var rem = global.Clock.remaining(deadline);
    var done = ['post-review-done', 'approved'].indexOf(main.ext.flowStatus) >= 0;
    var kind = done ? 'none' : rem < 0 ? 'timeout' : rem < NEAR_TIMEOUT_HOURS * 36e5 ? 'near' : 'due';
    var hr = global.Clock.humanRemaining(deadline);
    return { kind: kind, deadline: deadline, remainingMs: rem, text: hr.text,
      timeout: rem < 0 && !done, nodeSeq: cur ? cur.ext.seq : 1,
      label: done ? '已完成，不再计时' : hr.text };
  }

  var STATE_NAMES = { unreached: '未到达', doing: '待处理', passed: '已通过', rejected: '已驳回', returned: '退回补充', cancelled: '已取消' };
  function orgName(orgId) { var o = F.read('Organization', orgId); return o ? o.name : orgId; }

  /* 流程图：待处理 / 处理中 / 已通过 / 已驳回 / 未到达（SRS FR-016.5） */
  function flowView(mainId) {
    var main = F.read('Task', mainId);
    if (!main) return null;
    var nodes = nodeTasksOf(mainId);
    var pd = F.read('PlanDefinition', main.ext.pdId);
    var t = timeoutState(main);
    return {
      mainId: main.id, sqno: main.ext.sqno,
      flowStatus: main.ext.flowStatus, flowStatusName: D.flowStatusName(main.ext.flowStatus),
      tone: D.flowStatus(main.ext.flowStatus).tone,
      purpose: main.ext.purpose, purposeName: D.flowPurposeName(main.ext.purpose),
      version: main.ext.version, versionLabel: 'V' + main.ext.version,
      pdId: main.ext.pdId, pdUrl: main.ext.pdUrl, pdTitle: main.ext.pdTitle,
      pdExists: !!pd, boundVersionStillActive: !!(pd && pd.status === 'active'),
      nodeCount: nodes.length, currentSeq: main.ext.currentNodeSeq, timeout: t,
      orderStatus: main.ext.orderStatus, emergency: !!main.ext.emergency,
      nodes: nodes.map(function (n) {
        var cfg = n.ext.node || {}, acted = n.ext.actedBy || {};
        var state = n.status === 'completed' ? 'passed' : n.status === 'rejected' ? 'rejected'
          : n.status === 'cancelled' ? 'cancelled' : n.status === 'on-hold' ? 'returned'
            : OPEN_NODE.indexOf(n.status) >= 0 ? 'doing' : 'unreached';
        return {
          seq: n.ext.seq, name: cfg.name, assigneeType: cfg.assigneeType,
          assigneeLabel: assigneeLabel(cfg, n),
          mode: cfg.mode, modeName: cfg.mode === 'and' ? '会签' : '或签',
          deadlineHours: cfg.deadlineHours, actions: cfg.actions || [],
          onTimeout: cfg.onTimeout, isPostReview: !!n.ext.isPostReview, description: cfg.description || '',
          state: state, stateName: STATE_NAMES[state],
          actedBy: acted.by || '', actedAt: acted.time || '', comment: acted.comment || '',
          actionKind: acted.action || '',
          assignees: n.ext.assignees || [],
          basis: asArray(n.ext.assignees).map(function (a) { return a.via; }).filter(Boolean),
          nodeTaskId: n.id, nodeTaskStatus: n.status,
          deadlineEnd: n.ext.deadlineEnd || '',
          remaining: n.ext.deadlineEnd ? global.Clock.humanRemaining(n.ext.deadlineEnd).text : ''
        };
      })
    };
    function assigneeLabel(cfg, n) {
      if (cfg.assigneeType === 'person') return '指定人员：' + asArray(n.ext.assignees).map(function (a) { return a.name; }).join('、');
      if (cfg.assigneeType === 'department') return '科室：' + asArray(cfg.assignees).map(orgName).join('、');
      if (cfg.assigneeType === 'role') return '角色：' + asArray(cfg.assignees).map(D.approvalRoleName).join('、');
      return '自动匹配：开单医师所属科室负责人';
    }
  }

  function mainTasks(filter) {
    filter = filter || {};
    var list = F.search('Task', function (t) { return t.ext && t.ext.taskKind === 'main'; });
    var eq = function (key, val) { return !val || val === 'all'; };
    if (!eq('purpose', filter.purpose)) list = list.filter(function (t) { return t.ext.purpose === filter.purpose; });
    if (!eq('level', filter.level)) list = list.filter(function (t) { return t.ext.level === D.normalizeLevel(filter.level); });
    if (!eq('status', filter.status)) list = list.filter(function (t) { return t.ext.flowStatus === filter.status; });
    if (filter.patientName) list = list.filter(function (t) { return (t.ext.patientName || '').indexOf(filter.patientName) >= 0; });
    if (filter.drug) list = list.filter(function (t) { return (t.ext.drug || '').indexOf(filter.drug) >= 0; });
    if (filter.requester) list = list.filter(function (t) { return t.requester.reference === 'Practitioner/' + filter.requester; });
    if (filter.dept && filter.dept !== 'all') list = list.filter(function (t) { return t.ext.dept === filter.dept; });
    if (filter.version && filter.version !== 'all') list = list.filter(function (t) { return String(t.ext.version) === String(filter.version); });
    if (filter.dateStart) list = list.filter(function (t) { return (t.ext.createdAt || '').slice(0, 10) >= filter.dateStart; });
    if (filter.dateEnd) list = list.filter(function (t) { return (t.ext.createdAt || '').slice(0, 10) <= filter.dateEnd; });
    return list.sort(function (a, b) { return (b.authoredOn || '').localeCompare(a.authoredOn || ''); });
  }

  /* scope: todo（待我审批）| done（我已审批）| mine（我发起）| emergency（紧急补审核）| all */
  function tasksFor(practId, scope) {
    scope = scope || 'todo';
    if (scope === 'mine') return mainTasks({ requester: practId });
    if (scope === 'all') return mainTasks({});
    var byNode = F.search('Task', function (t) {
      if (!t.ext || t.ext.taskKind !== 'node') return false;
      if (scope === 'done') return (t.ext.actedBy || {}).practitioner === practId;
      if (scope === 'emergency') return asArray(t.ext.assigneeIds).indexOf(practId) >= 0 || (t.ext.actedBy || {}).practitioner === practId;
      return OPEN_NODE.indexOf(t.status) >= 0 && asArray(t.ext.assigneeIds).indexOf(practId) >= 0;
    });
    var map = {};
    byNode.forEach(function (t) { map[t.ext.mainTask] = t; });
    var list = mainTasks(scope === 'emergency' ? { purpose: 'emergency-review' } : {}).filter(function (m) {
      var t = map[m.id];
      if (!t) return false;
      if (scope === 'todo') return OPEN_NODE.indexOf(t.status) >= 0 && CLOSED_MAIN.indexOf(m.ext.flowStatus) < 0;
      return true;
    });
    if (scope === 'emergency') {
      return list.filter(function (m) { return m.ext.emergency; });
    }
    return list;
  }

  function countersFor(practId) {
    var todo = tasksFor(practId, 'todo');
    return {
      todo: todo.length,
      timeout: todo.filter(function (m) { return timeoutState(m).timeout; }).length,
      special: todo.filter(function (m) { return m.ext.level === 'special'; }).length,
      emergency: tasksFor(practId, 'emergency').filter(function (m) { return CLOSED_MAIN.indexOf(m.ext.flowStatus) < 0; }).length,
      mine: tasksFor(practId, 'mine').filter(function (m) { return CLOSED_MAIN.indexOf(m.ext.flowStatus) < 0; }).length
    };
  }

  /* 列表行（FR-016.2 / FR-020.4） */
  function rows(practId, scope, filter) {
    var list = tasksFor(practId, scope);
    var f = filter || {};
    if (f.drug) list = list.filter(function (m) { return (m.ext.drug || '').indexOf(f.drug) >= 0; });
    if (f.level && f.level !== 'all') list = list.filter(function (m) { return m.ext.level === f.level; });
    if (f.status && f.status !== 'all') list = list.filter(function (m) { return m.ext.flowStatus === f.status; });
    if (f.patient) list = list.filter(function (m) { return ((m.ext.patientName || '') + (m.ext.mrn || '')).indexOf(f.patient) >= 0; });
    if (f.version && f.version !== 'all') list = list.filter(function (m) { return String(m.ext.version) === String(f.version); });
    if (f.requester) list = list.filter(function (m) { return (m.ext.requesterName || '').indexOf(f.requester) >= 0; });
    if (f.dept && f.dept !== 'all') list = list.filter(function (m) { return m.ext.dept === f.dept; });
    if (f.dateStart) list = list.filter(function (m) { return (m.ext.createdAt || '').slice(0, 10) >= f.dateStart; });
    if (f.dateEnd) list = list.filter(function (m) { return (m.ext.createdAt || '').slice(0, 10) <= f.dateEnd; });
    return list.map(function (m) {
      var cur = firstActionableNode(m.id, null);
      var t = timeoutState(m);
      return {
        id: m.id, sqno: m.ext.sqno, patient: m.ext.patientName, mrn: m.ext.mrn, diagnosis: m.ext.diagnosis,
        drug: m.ext.drug, drugCode: m.ext.drugCode, level: m.ext.level, levelName: D.levelName(m.ext.level),
        requester: m.ext.requesterName || '', dept: m.ext.dept, createdAt: m.ext.createdAt,
        purpose: m.ext.purpose, purposeName: D.flowPurposeName(m.ext.purpose),
        flowStatus: m.ext.flowStatus, flowStatusName: D.flowStatusName(m.ext.flowStatus),
        tone: D.flowStatus(m.ext.flowStatus).tone,
        currentNode: cur ? cur.ext.node.name : (m.ext.flowStatus === 'approved' ? '全部通过' : '—'),
        currentSeq: cur ? cur.ext.seq : null,
        currentAssignees: cur ? (cur.ext.assignees || []).map(function (a) { return a.name; }) : [],
        version: 'V' + m.ext.version, pdId: m.ext.pdId, waitingHours: waitingHours(m), timeout: t,
        orderStatus: m.ext.orderStatus, emergency: !!m.ext.emergency,
        actionable: !!firstActionableNode(m.id, practId),
        mrId: m.ext.mrId
      };
    });
  }
  function firstActionableSeq(mainId) {
    var t = nodeTasksOf(mainId).filter(function (n) { return OPEN_NODE.indexOf(n.status) >= 0; })[0];
    return t ? t.ext.seq : null;
  }
  function waitingHours(main) {
    var cur = nodeTasksOf(main.id).filter(function (t) { return OPEN_NODE.indexOf(t.status) >= 0; })[0];
    var from = global.Clock.parse((cur && cur.authoredOn) || main.authoredOn);
    if (!from) return 0;
    return Math.max(0, Math.round((global.Clock.now().getTime() - from.getTime()) / 36e5 * 10) / 10);
  }

  var Approval = {
    CANON: CANON, SYS: SYS, EMERGENCY_HOURS: EMERGENCY_HOURS, NEAR_TIMEOUT_HOURS: NEAR_TIMEOUT_HOURS,
    slug: slug, pdUrl: pdUrl, versionLabel: versionLabel, idOf: idOf,
    allVersions: allVersions, versions: versions, currentVersion: currentVersion, setPointer: setPointer,
    newDraft: newDraft, saveDraft: saveDraft, defaultNodes: defaultNodes, mkNode: mkNode, renumber: renumber,
    validate: validate, diffSummary: diffSummary, publish: publish, rollback: rollback, compare: compare,
    toActions: toActions, nodesFromActions: nodesFromActions,
    coding: coding, ref: ref, auditLog: auditLog, notify: notify,
    titleRuleMatrix: titleRuleMatrix, deptRule: deptRule, personRule: personRule,
    mergePriority: mergePriority, setMergePriority: setMergePriority,
    practitionerInfo: practitionerInfo, practitionerRole: practitionerRole,
    practitionersOfRole: practitionersOfRole, practitionersOfDept: practitionersOfDept,
    authorizations: authorizations, drugGrade: drugGrade, check: check,
    createMedicationRequest: createMedicationRequest, createInstance: createInstance,
    createEmergency: createEmergency, submitPostReviewMaterials: submitPostReviewMaterials,
    nodeTaskId: nodeTaskId, nodeTasksOf: nodeTasksOf, materializeProjection: materializeProjection,
    refreshMain: refreshMain, applyOrderStatus: applyOrderStatus,
    resolveAssignees: resolveAssignees, actionableNodeTasks: actionableNodeTasks,
    firstActionableNode: firstActionableNode, firstActionableSeq: firstActionableSeq,
    act: act, withdraw: withdraw, resubmit: resubmit, resubmitAfterReject: resubmitAfterReject,
    timeoutState: timeoutState, flowView: flowView, mainTasks: mainTasks,
    tasksFor: tasksFor, countersFor: countersFor, rows: rows, waitingHours: waitingHours,
    actionName: actionName, orgName: orgName, STATE_NAMES: STATE_NAMES,
    LAYER_LABEL: LAYER_LABEL, CLOSED_MAIN: CLOSED_MAIN, OPEN_NODE: OPEN_NODE
  };
  global.Approval = Approval;
})(window);
