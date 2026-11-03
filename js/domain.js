/* =====================================================================
 * domain.js —— 业务领域常量与工具
 * 抗菌药物分级管理系统（SRS 功能 ∪ 既有原型功能，冲突以 SRS 为准）
 * ===================================================================== */
(function (global) {
  'use strict';

  /* 抗菌药物等级（SRS §3.1：编码与名称均与采购文件一致）
   * rank 越大级别越高，用于「医师可用等级 vs 药品等级」比较。 */
  var LEVELS = [
    { code: 'non-restricted', name: '非限制使用', legacy: '非限制使用级', rank: 1, color: '#16a34a', desc: '医师在一般授权下即可使用' },
    { code: 'restricted', name: '限制使用', legacy: '限制使用级', rank: 2, color: '#d97706', desc: '需具备相应授权或经审批' },
    { code: 'special', name: '特殊使用', legacy: '特殊使用级', rank: 3, color: '#dc2626', desc: '严格控制，超权限须审批或紧急越级' }
  ];

  /* 既有原型（main 分支）用 unrestricted，SRS 用 non-restricted。
   * 读取侧一律先规范化，保证历史数据与旧页面继续可用。 */
  var LEVEL_ALIAS = { unrestricted: 'non-restricted' };
  function normalizeLevel(code) { return LEVEL_ALIAS[code] || code; }

  // 医师职称
  var TITLES = [
    { code: 'chief', name: '主任医师', rank: 4 },
    { code: 'associate', name: '副主任医师', rank: 3 },
    { code: 'attending', name: '主治医师', rank: 2 },
    { code: 'resident', name: '住院医师', rank: 1 }
  ];

  /* 审批节点可承担的岗位角色（CodeSystem/amr-role）。
   * 旧原型的 dept/pharmacy/expert 三个审批角色并入这里，语义不变。 */
  var APPROVAL_ROLES = [
    { code: 'leader', name: '科室负责人' },
    { code: 'pharmacy', name: '药学部门' },
    { code: 'expert', name: '审批专家' },
    { code: 'infection', name: '感染科医师' }
  ];

  /* 系统角色（顶部演示身份切换的一级分组）。
   * 前 5 个沿用既有原型，其余按 SRS §2 补齐；SRS 的「移动端审批人员」不是独立
   * 角色，而是「审批人员」走移动端路由（SRS §11.2 允许同一人兼任多个演示角色）。 */
  var ROLES = [
    { code: 'admin', name: '系统管理员', desc: '维护演示数据、系统参数与外部对接', icon: '⚙️' },
    { code: 'ruleadmin', name: '规则管理员', desc: '维护药物等级、职称/科室/个人授权与审批流程', icon: '📐' },
    { code: 'doctor', name: '开单医师', desc: '临床开单、查看权限、发起审批与紧急越级', icon: '🩺' },
    { code: 'expert', name: '审批人员', desc: '在审批中心处理分配给人/科室/角色的任务', icon: '✅' },
    { code: 'pharmacy', name: '药学部门', desc: '目录与适应症维护、药学审批、用药监测', icon: '💊' },
    { code: 'flowviewer', name: '流程审阅人员', desc: '查看流程版本、比较差异并执行回退恢复', icon: '🗂️' },
    { code: 'quality', name: '医疗质量管理部门', desc: '合理用药监督与统计分析', icon: '📊' }
  ];

  /* 用药目的字典（SRS FR-010.7：演示用途分类为可维护示例，采购文件未规定
   * 具体用途字典，故此处以 CodeSystem-amr-purpose 承载，可增删调整）。 */
  var PURPOSES = [
    { code: 'perioperative', name: '围手术期预防用药', desc: '清洁/清洁-污染手术预防切口感染' },
    { code: 'empirical', name: '经验性治疗', desc: '病原学未回报前依病情经验用药' },
    { code: 'targeted', name: '目标性治疗', desc: '依据病原学与药敏结果针对性用药' },
    { code: 'severe', name: '重症/抢救治疗', desc: '脓毒症、呼吸衰竭等危重情形' },
    { code: 'mdr', name: '多重耐药菌治疗', desc: 'MRSA、产 ESBLs、CRE 等耐药菌感染' },
    { code: 'combination', name: '联合用药', desc: '协同抗菌或扩大抗菌谱的联合方案' }
  ];

  /* 审批节点的审批对象类型（SRS FR-012/013/014 + 既有原型的自动匹配） */
  var ASSIGNEE_TYPES = [
    { code: 'person', name: '指定人员', hint: '从演示人员列表检索并选择审批人' },
    { code: 'department', name: '科室', hint: '从医院组织科室列表选择目标科室' },
    { code: 'role', name: '角色', hint: '从演示岗位角色列表选择目标角色' },
    { code: 'auto', name: '自动匹配', hint: '按开单医师所属科室自动匹配科室负责人' }
  ];

  /* 节点允许的处理动作（SRS FR-022.3：节点未配置的动作，界面不得显示该按钮） */
  var NODE_ACTIONS = [
    { code: 'approve', name: '通过' },
    { code: 'reject', name: '驳回' },
    { code: 'return', name: '退回补充' }
  ];

  /* 流程实例状态（SRS §3.3）。task 为 R4 Task.status 合法码，
   * biz 为本系统业务码（落 Task.businessStatus 与扩展）。 */
  var FLOW_STATUS = [
    { code: 'pending-submit', name: '待提交', task: 'draft', tone: 'gray' },
    { code: 'approving', name: '审批中', task: 'in-progress', tone: 'orange' },
    { code: 'waiting-node', name: '待节点审批', task: 'requested', tone: 'orange' },
    { code: 'approved', name: '已通过', task: 'completed', tone: 'green' },
    { code: 'rejected', name: '已驳回', task: 'rejected', tone: 'red' },
    { code: 'returned', name: '退回补充', task: 'on-hold', tone: 'orange' },
    { code: 'withdrawn', name: '已撤回', task: 'cancelled', tone: 'gray' },
    { code: 'cancelled', name: '已取消', task: 'cancelled', tone: 'gray' },
    { code: 'post-review-pending', name: '紧急越级待补审核', task: 'draft', tone: 'red' },
    { code: 'post-review-running', name: '补审核中', task: 'in-progress', tone: 'orange' },
    { code: 'post-review-done', name: '补审核完成', task: 'completed', tone: 'green' },
    { code: 'post-review-timeout', name: '补审核超时', task: 'on-hold', tone: 'red' }
  ];

  /* 医嘱/处方状态（SRS §3.4）。「可提交临床系统」仅代表本演示流程已满足审批
   * 条件，不代表药品已真实发药或实际执行。mr 为 R4 MedicationRequest.status 码。 */
  var ORDER_STATUS = [
    { code: 'draft', name: '草稿', mr: 'draft' },
    { code: 'pending-approval', name: '待审批', mr: 'draft' },
    { code: 'approved', name: '审批通过', mr: 'active' },
    { code: 'rejected', name: '审批驳回', mr: 'cancelled' },
    { code: 'ready-to-submit', name: '可提交临床系统', mr: 'active' },
    { code: 'emergency-temp', name: '紧急临时使用', mr: 'active' },
    { code: 'post-review-pending', name: '待补审核', mr: 'on-hold' },
    { code: 'post-reviewed', name: '已补审核', mr: 'completed' },
    { code: 'cancelled', name: '已取消', mr: 'cancelled' }
  ];

  /* 流程用途（SRS FR-008.10：普通权限审批与紧急补审核应采用不同的流程标识） */
  var FLOW_PURPOSES = [
    { code: 'tier-approval', name: '抗菌药物分级审批', levelBound: true },
    { code: 'emergency-review', name: '紧急越级补审核', levelBound: false },
    { code: 'rx-permission', name: '处方权限申请审批', levelBound: true }
  ];

  // 科室（既有原型监测分析的科室维度，按名称聚合，不引用 Organization 资源）
  var DEPARTMENTS = ['内科', '外科', 'ICU', '呼吸科', '骨科', '妇产科', '普外科', '感染科', '神经内科', '泌尿外科'];

  // 监测分析用药记录统计口径：纳入统计的科室及其核定床位数（用于计算用药强度 DDD/百床日）
  var DEPT_BEDS = { '内科': 100, '外科': 90, 'ICU': 30, '呼吸科': 60, '骨科': 70, '妇产科': 50 };
  // 各科室对应的示例处方医师（用于生成可追溯到具体医师的真实统计数据）
  var DEPT_DOCTORS = {
    '内科': [{ name: '王伟', title: 'associate' }, { name: '张明远', title: 'chief' }],
    '外科': [{ name: '张建华', title: 'chief' }, { name: '陈刚', title: 'attending' }],
    'ICU': [{ name: '刘洋', title: 'associate' }, { name: '高峰', title: 'attending' }],
    '呼吸科': [{ name: '李娜', title: 'attending' }, { name: '吴敏', title: 'associate' }],
    '骨科': [{ name: '赵磊', title: 'attending' }, { name: '孙浩', title: 'associate' }],
    '妇产科': [{ name: '周强', title: 'chief' }, { name: '林芳', title: 'attending' }]
  };

  /* 演示身份（SRS §11.2 最小集：一名权限满足的开单医师、一名权限不足的开单医师、
   * 按人员/按科室/按角色的审批人各一名、流程管理员）。同一 role 可有多个身份，
   * 切换身份即切换当前登录人 —— DEMO-10 要求依次用「人员/科室/角色」三种审批人
   * 账号打开待办，单角色单用户无法满足。 */
  var DEMO_IDENTITIES = [
    { id: 'id-admin', role: 'admin', name: '李建国', display: '系统管理员·李建国', dept: '演示医院管理办公室', title: null, practitioner: 'Practitioner-9001', roleType: 'admin', note: '维护演示用户、科室与演示数据' },
    { id: 'id-ruleadmin', role: 'ruleadmin', name: '王素芬', display: '规则管理员·王素芬', dept: '药事管理科（演示）', title: null, practitioner: 'Practitioner-9011', roleType: 'ruleadmin', note: '维护等级规则、授权与审批流程' },
    { id: 'id-doctor-ok', role: 'doctor', name: '张建华', display: '医师·张建华（权限满足）', dept: '普通外科（演示）', title: 'chief', practitioner: 'Practitioner-1001', roleType: 'doctor', note: '主任医师，三个等级均可直接开立' },
    { id: 'id-doctor-low', role: 'doctor', name: '王伟', display: '医师·王伟（权限不足）', dept: '呼吸内科（演示）', title: 'attending', practitioner: 'Practitioner-9003', roleType: 'doctor', note: '主治医师，特殊使用级须审批或紧急越级' },
    { id: 'id-doctor-icu', role: 'doctor', name: '刘洋', display: '医师·刘洋（ICU）', dept: '重症医学科（演示）', title: 'associate', practitioner: 'Practitioner-1004', roleType: 'doctor', note: '副主任医师，可开限制使用级' },
    { id: 'id-expert-role', role: 'expert', name: '陈志远', display: '审批人员·陈志远（角色）', dept: '感染科（演示）', title: 'chief', practitioner: 'Practitioner-9004', roleType: 'expert', note: '命中「按角色」配置的审批节点' },
    { id: 'id-expert-person', role: 'expert', name: '王建明', display: '审批人员·王建明（人员）', dept: '感染科（演示）', title: 'chief', practitioner: 'Practitioner-1102', roleType: 'expert', note: '被「按人员」节点直接指定的审批人' },
    { id: 'id-expert-dept', role: 'expert', name: '陈慧兰', display: '审批人员·陈慧兰（科室）', dept: '呼吸内科（演示）', title: 'chief', practitioner: 'Practitioner-1201', roleType: 'leader', note: '命中「按科室」配置（呼吸内科负责人）' },
    { id: 'id-expert-pharmacy', role: 'expert', name: '张玉梅', display: '审批人员·张玉梅（药学）', dept: '药事管理科（演示）', title: null, practitioner: 'Practitioner-9002', roleType: 'pharmacy', note: '药学部门审批人，可用移动端审批' },
    { id: 'id-flowviewer', role: 'flowviewer', name: '赵敏', display: '流程审阅·赵敏', dept: '医疗质量管理部', title: null, practitioner: 'Practitioner-9005', roleType: 'quality', note: '查看版本、比较差异、执行回退恢复' },
    { id: 'id-quality', role: 'quality', name: '赵敏', display: '质控科·赵敏', dept: '医疗质量管理部', title: null, practitioner: 'Practitioner-9005', roleType: 'quality', note: '监测概览与统计报表' },
    { id: 'id-pharmacy', role: 'pharmacy', name: '张玉梅', display: '药学部·张玉梅', dept: '药事管理科（演示）', title: null, practitioner: 'Practitioner-9002', roleType: 'pharmacy', note: '目录/适应症维护与用药监测' }
  ];

  /* 信息架构：SRS §6.1 要求的 10 个主导航入口 + 既有原型的目录/监测/系统管理页面。
   * route 与 AMS.pages 键、Domain.MODULES、Basic-role-permissions.pages 三处一致。 */
  var MODULES = [
    {
      code: 'M-0', name: '工作台', icon: '🏠', roles: ['admin', 'ruleadmin', 'doctor', 'expert', 'pharmacy', 'flowviewer', 'quality'],
      pages: [
        { code: 'P-0-1', name: '工作台', route: 'home', roles: ['admin', 'ruleadmin', 'doctor', 'expert', 'pharmacy', 'flowviewer', 'quality'] }
      ]
    },
    {
      code: 'M-1', name: '抗菌药物目录', icon: '📑', roles: ['admin', 'ruleadmin', 'pharmacy', 'doctor'],
      pages: [
        { code: 'P-1-1', name: '抗菌药物目录', route: 'catalog', roles: ['admin', 'ruleadmin', 'pharmacy', 'doctor'] },
        { code: 'P-1-2', name: '适应症知识库', route: 'indication', roles: ['admin', 'ruleadmin', 'pharmacy'] }
      ]
    },
    {
      code: 'M-2', name: '分级规则与权限', icon: '📐', roles: ['admin', 'ruleadmin', 'pharmacy'],
      pages: [
        { code: 'P-2-1', name: '抗菌药物等级规则', route: 'grade-rules', roles: ['admin', 'ruleadmin'] },
        { code: 'P-2-2', name: '医师权限管理', route: 'physician-perm', roles: ['admin', 'ruleadmin'] },
        { code: 'P-2-3', name: '权限映射配置', route: 'perm-mapping', roles: ['admin', 'ruleadmin', 'pharmacy'] }
      ]
    },
    {
      code: 'M-3', name: '审批流程', icon: '🧩', roles: ['admin', 'ruleadmin', 'flowviewer'],
      pages: [
        { code: 'P-3-1', name: '审批流程设计', route: 'workflow-designer', roles: ['admin', 'ruleadmin'] },
        { code: 'P-3-2', name: '流程版本管理', route: 'workflow-versions', roles: ['admin', 'ruleadmin', 'flowviewer'] },
        { code: 'P-3-3', name: '审批流程配置', route: 'workflow-config', roles: ['admin', 'ruleadmin'] }
      ]
    },
    {
      code: 'M-4', name: '临床业务', icon: '🩺', roles: ['doctor', 'admin', 'ruleadmin', 'expert'],
      pages: [
        { code: 'P-4-1', name: '临床开单演示', route: 'order-demo', roles: ['doctor', 'admin', 'ruleadmin'] },
        { code: 'P-4-2', name: '紧急越级补审核', route: 'emergency-review', roles: ['doctor', 'expert', 'admin', 'ruleadmin'] },
        { code: 'P-4-3', name: '处方权限申请', route: 'auth-apply', roles: ['doctor'] }
      ]
    },
    {
      code: 'M-5', name: '审批中心', icon: '📋', roles: ['expert', 'pharmacy', 'doctor', 'admin', 'ruleadmin', 'flowviewer'],
      pages: [
        { code: 'P-5-1', name: '审批中心', route: 'approval-center', roles: ['expert', 'pharmacy', 'doctor', 'admin', 'ruleadmin', 'flowviewer'] },
        { code: 'P-5-2', name: '移动端审批', route: 'mobile-approval', roles: ['expert', 'pharmacy', 'doctor', 'admin', 'ruleadmin'] },
        { code: 'P-5-3', name: '处方权限审批', route: 'auth-approve', roles: ['expert', 'pharmacy'] }
      ]
    },
    {
      code: 'M-6', name: '监测分析', icon: '📊', roles: ['quality', 'pharmacy', 'admin'],
      pages: [
        { code: 'P-6-1', name: '监测概览', route: 'monitor', roles: ['quality', 'pharmacy', 'admin'] },
        { code: 'P-6-2', name: '统计报表', route: 'report', roles: ['quality', 'pharmacy', 'admin'] }
      ]
    },
    {
      code: 'M-7', name: '系统管理', icon: '⚙️', roles: ['admin', 'ruleadmin', 'flowviewer'],
      pages: [
        { code: 'P-7-1', name: '演示数据管理', route: 'demo-data', roles: ['admin', 'ruleadmin', 'flowviewer'] },
        { code: 'P-7-2', name: '权限卡控规则', route: 'gatekeep', roles: ['admin'] },
        { code: 'P-7-3', name: '系统参数设置', route: 'sys-params', roles: ['admin'] }
      ]
    }
  ];

  function find(list, code) {
    for (var i = 0; i < list.length; i++) if (list[i].code === code) return list[i];
    return null;
  }

  // 用户角色权限配置（系统管理 → 用户角色权限）可在运行时覆盖各页面默认可见角色；
  // 覆盖数据存放于 FHIR Basic-role-permissions 资源，此处按需读取，未配置时回退到 page.roles 默认值。
  function pageRoleOverrideMap() {
    var b = global.FHIR && global.FHIR.read ? global.FHIR.read('Basic', 'Basic-role-permissions') : null;
    return (b && b.ext && b.ext.pages) || null;
  }
  function effectivePageRoles(page) {
    var map = pageRoleOverrideMap();
    if (map && map[page.route]) return map[page.route];
    return page.roles;
  }

  var Domain = {
    LEVELS: LEVELS,
    LEVEL_ALIAS: LEVEL_ALIAS,
    TITLES: TITLES,
    ROLES: ROLES,
    PURPOSES: PURPOSES,
    ASSIGNEE_TYPES: ASSIGNEE_TYPES,
    NODE_ACTIONS: NODE_ACTIONS,
    FLOW_STATUS: FLOW_STATUS,
    ORDER_STATUS: ORDER_STATUS,
    FLOW_PURPOSES: FLOW_PURPOSES,
    APPROVAL_ROLES: APPROVAL_ROLES,
    DEPARTMENTS: DEPARTMENTS,
    DEPT_BEDS: DEPT_BEDS,
    DEPT_DOCTORS: DEPT_DOCTORS,
    DEMO_USERS: DEMO_IDENTITIES,
    DEMO_IDENTITIES: DEMO_IDENTITIES,
    MODULES: MODULES,

    normalizeLevel: normalizeLevel,
    level: function (code) { return find(LEVELS, normalizeLevel(code)); },
    levelName: function (code) { var l = find(LEVELS, normalizeLevel(code)); return l ? l.name : (code || '—'); },
    levelFull: function (code) { var l = find(LEVELS, normalizeLevel(code)); return l ? l.legacy : (code || '—'); },
    levelColor: function (code) { var l = find(LEVELS, normalizeLevel(code)); return l ? l.color : '#666'; },
    levelRank: function (code) { var l = find(LEVELS, normalizeLevel(code)); return l ? l.rank : 0; },
    levelDesc: function (code) { var l = find(LEVELS, normalizeLevel(code)); return l ? l.desc : ''; },
    titleName: function (code) { var t = find(TITLES, code); return t ? t.name : (code || '—'); },
    titleRank: function (code) { var t = find(TITLES, code); return t ? t.rank : 0; },
    roleName: function (code) { var r = find(ROLES, code); return r ? r.name : code; },
    role: function (code) { return find(ROLES, code); },
    purpose: function (code) { return find(PURPOSES, code); },
    purposeName: function (code) { var p = find(PURPOSES, code); return p ? p.name : (code || '—'); },
    assigneeType: function (code) { return find(ASSIGNEE_TYPES, code); },
    assigneeTypeName: function (code) { var a = find(ASSIGNEE_TYPES, code); return a ? a.name : code; },
    approvalRoleName: function (code) { var a = find(APPROVAL_ROLES, code); return a ? a.name : code; },
    flowStatus: function (code) { return find(FLOW_STATUS, code) || { code: code, name: code, task: 'requested', tone: 'gray' }; },
    flowStatusName: function (code) { return Domain.flowStatus(code).name; },
    flowStatusTask: function (code) { return Domain.flowStatus(code).task; },
    orderStatus: function (code) { return find(ORDER_STATUS, code) || { code: code, name: code, mr: 'draft' }; },
    orderStatusName: function (code) { return Domain.orderStatus(code).name; },
    flowPurpose: function (code) { return find(FLOW_PURPOSES, code); },
    flowPurposeName: function (code) { var p = find(FLOW_PURPOSES, code); return p ? p.name : code; },

    /** 等级 → tag 配色（既有页面沿用） */
    levelTone: function (code) {
      return { 'non-restricted': 'green', 'restricted': 'orange', 'special': 'red' }[normalizeLevel(code)] || 'gray';
    },

    /* ---------- 演示身份 ---------- */
    identities: function (role) {
      return DEMO_IDENTITIES.filter(function (u) { return !role || u.role === role; });
    },
    identity: function (id) {
      for (var i = 0; i < DEMO_IDENTITIES.length; i++) if (DEMO_IDENTITIES[i].id === id) return DEMO_IDENTITIES[i];
      return null;
    },
    firstIdentityOfRole: function (role) {
      var list = DEMO_IDENTITIES.filter(function (u) { return u.role === role; });
      return list[0] || DEMO_IDENTITIES[0];
    },
    identitiesOfPractitioner: function (practId) {
      return DEMO_IDENTITIES.filter(function (u) { return u.practitioner === practId; });
    },

    // 角色可见模块：模块下至少有一个页面对该角色可见时，模块本身可见
    visibleModules: function (role) {
      return MODULES.filter(function (m) {
        return m.pages.some(function (p) { return effectivePageRoles(p).indexOf(role) >= 0; });
      });
    },
    // 某页面当前生效的可见角色（含用户角色权限配置的覆盖结果）
    pageRoles: function (route) {
      var pr = this.pageByRoute(route);
      return pr ? effectivePageRoles(pr.page) : [];
    },
    // 根据 route 找页面定义
    pageByRoute: function (route) {
      for (var i = 0; i < MODULES.length; i++) {
        for (var j = 0; j < MODULES[i].pages.length; j++) {
          if (MODULES[i].pages[j].route === route) {
            return { module: MODULES[i], page: MODULES[i].pages[j] };
          }
        }
      }
      return null;
    },
    canAccess: function (role, route) {
      var pr = this.pageByRoute(route);
      return pr ? effectivePageRoles(pr.page).indexOf(role) >= 0 : false;
    }
  };

  global.Domain = Domain;
})(window);
