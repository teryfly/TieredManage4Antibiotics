/* =====================================================================
 * domain.js —— 业务领域常量与工具
 * 抗菌药物分级管理制度闭环管理系统
 * ===================================================================== */
(function (global) {
  'use strict';

  // 抗菌药物分级（三级）
  var LEVELS = [
    { code: 'unrestricted', name: '非限制使用级', color: '#16a34a' },
    { code: 'restricted', name: '限制使用级', color: '#d97706' },
    { code: 'special', name: '特殊使用级', color: '#dc2626' }
  ];

  // 医师职称
  var TITLES = [
    { code: 'chief', name: '主任医师', rank: 4 },
    { code: 'associate', name: '副主任医师', rank: 3 },
    { code: 'attending', name: '主治医师', rank: 2 },
    { code: 'resident', name: '住院医师', rank: 1 }
  ];

  // 系统角色（用于演示角色切换）
  var ROLES = [
    { code: 'admin', name: '系统管理员', desc: '负责系统配置与规则管理', icon: '⚙️' },
    { code: 'pharmacy', name: '药学部门', desc: '药物分级目录维护与用药监测', icon: '💊' },
    { code: 'doctor', name: '医师', desc: '开具抗菌药物医嘱、申请处方权', icon: '🩺' },
    { code: 'expert', name: '审批专家', desc: '审批特殊使用级抗菌药物申请', icon: '✅' },
    { code: 'quality', name: '医疗质量管理部门', desc: '合理用药监督与统计分析', icon: '📊' }
  ];

  // 科室
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

  // 演示用户（每个角色一个登录身份，支持随时切换）
  var DEMO_USERS = [
    { id: 'user-admin', role: 'admin', name: '李建国', display: '管理员·李建国', dept: '信息中心', title: null, practitioner: 'Practitioner-9001' },
    { id: 'user-pharmacy', role: 'pharmacy', name: '张玉梅', display: '药学部·张玉梅', dept: '药学部', title: null, practitioner: 'Practitioner-9002' },
    { id: 'user-doctor', role: 'doctor', name: '王伟', display: '医师·王伟', dept: '内科', title: 'associate', practitioner: 'Practitioner-9003' },
    { id: 'user-expert', role: 'expert', name: '陈志远', display: '审批专家·陈志远', dept: '感染科', title: 'chief', practitioner: 'Practitioner-9004' },
    { id: 'user-quality', role: 'quality', name: '赵敏', display: '质控科·赵敏', dept: '医疗质量管理部', title: null, practitioner: 'Practitioner-9005' }
  ];

  // 模块 / 页面信息架构（站点地图）
  var MODULES = [
    {
      code: 'L2-1', name: '处方权限管理', icon: '📋', roles: ['doctor', 'expert', 'pharmacy'],
      pages: [
        { code: 'L3-1-1', name: '处方权限申请', route: 'auth-apply', roles: ['doctor'] },
        { code: 'L3-1-2', name: '处方权限审批', route: 'auth-approve', roles: ['expert', 'pharmacy'] }
      ]
    },
    {
      code: 'L2-2', name: '目录综合管理', icon: '📑', roles: ['admin', 'pharmacy'],
      pages: [
        { code: 'L3-2-1', name: '分级目录管理', route: 'catalog', roles: ['admin', 'pharmacy'] },
        { code: 'L3-2-2', name: '权限映射配置', route: 'perm-mapping', roles: ['admin', 'pharmacy'] },
        { code: 'L3-2-3', name: '适应症知识库', route: 'indication', roles: ['admin', 'pharmacy'] }
      ]
    },
    {
      code: 'L2-3', name: '监测分析', icon: '📊', roles: ['quality', 'pharmacy'],
      pages: [
        { code: 'L3-3-1', name: '监测概览', route: 'monitor', roles: ['quality', 'pharmacy'] },
        { code: 'L3-3-2', name: '统计报表', route: 'report', roles: ['quality', 'pharmacy'] }
      ]
    },
    {
      code: 'L2-4', name: '系统管理', icon: '⚙️', roles: ['admin'],
      pages: [
        { code: 'L3-4-1', name: '权限卡控规则', route: 'gatekeep', roles: ['admin'] },
        { code: 'L3-4-2', name: '审批流程配置', route: 'workflow-config', roles: ['admin'] },
        { code: 'L3-4-3', name: '系统参数设置', route: 'sys-params', roles: ['admin'] }
      ]
    }
  ];

  function byCode(list, code) {
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
    TITLES: TITLES,
    ROLES: ROLES,
    DEPARTMENTS: DEPARTMENTS,
    DEPT_BEDS: DEPT_BEDS,
    DEPT_DOCTORS: DEPT_DOCTORS,
    DEMO_USERS: DEMO_USERS,
    MODULES: MODULES,
    levelName: function (code) { var l = byCode(LEVELS, code); return l ? l.name : code; },
    levelColor: function (code) { var l = byCode(LEVELS, code); return l ? l.color : '#666'; },
    titleName: function (code) { var t = byCode(TITLES, code); return t ? t.name : code; },
    titleRank: function (code) { var t = byCode(TITLES, code); return t ? t.rank : 0; },
    roleName: function (code) { var r = byCode(ROLES, code); return r ? r.name : code; },
    role: function (code) { return byCode(ROLES, code); },
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
