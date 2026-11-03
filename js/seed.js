/* =====================================================================
 * seed.js —— 初始化基础数据（编造符合业务逻辑的数据，写入 FHIR 内存库）
 * 所有数据以 FHIR 资源形式存储，供各页面通过 FHIR CRUD 接口读写。
 * ===================================================================== */
(function (global) {
  'use strict';

  var F = global.FHIR;
  var R4 = global.FHIRR4;

  // 审批节点角色 -> 中文
  var NODE_ROLE = { dept: '科室负责人', pharmacy: '药学部门', expert: '审批专家' };

  /* -------------------- 1. 科室 / 部门（Organization） -------------------- */
  global.Domain.DEPARTMENTS.forEach(function (d, i) {
    F.seed({ resourceType: 'Organization', id: 'Organization-dept-' + (i + 1), name: d, type: [{ text: '临床科室' }] });
  });
  F.seed({ resourceType: 'Organization', id: 'Organization-pharmacy', name: '药学部', type: [{ text: '职能部门' }] });
  F.seed({ resourceType: 'Organization', id: 'Organization-quality', name: '医疗质量管理部', type: [{ text: '职能部门' }] });

  /* -------------------- 2. 医务人员（Practitioner + 角色） -------------------- */
  function pract(id, name, dept, title, roleType) {
    F.seed({
      resourceType: 'Practitioner', id: id,
      name: [{ text: name }],
      ext: { dept: dept, title: title, roleType: roleType, active: true }
    });
  }
  // 演示账号
  pract('Practitioner-9001', '李建国', '信息中心', null, 'admin');
  pract('Practitioner-9002', '张玉梅', '药学部', null, 'pharmacy');
  pract('Practitioner-9003', '王伟', '内科', 'associate', 'doctor');
  pract('Practitioner-9004', '陈志远', '感染科', 'chief', 'expert');
  pract('Practitioner-9005', '赵敏', '医疗质量管理部', null, 'quality');
  // 临床医师（用于审批列表 / 报表）
  pract('Practitioner-1001', '张建华', '外科', 'chief', 'doctor');
  pract('Practitioner-1002', '李娜', '呼吸科', 'attending', 'doctor');
  pract('Practitioner-1003', '赵磊', '骨科', 'attending', 'doctor');
  pract('Practitioner-1004', '刘洋', 'ICU', 'associate', 'doctor');
  pract('Practitioner-1005', '孙倩', '普外科', 'attending', 'doctor');
  pract('Practitioner-1006', '周强', '妇产科', 'chief', 'doctor');
  // 药师 / 审批专家
  pract('Practitioner-1101', '李药师', '药学部', null, 'pharmacy');
  pract('Practitioner-1102', '王建明', '感染科', 'chief', 'expert');
  // 科室负责人
  pract('Practitioner-1201', '陈主任', '内科', 'chief', 'leader');
  pract('Practitioner-1202', '黄主任', '外科', 'chief', 'leader');

  /* -------------------- 3. 患者（Patient） -------------------- */
  function patient(id, name, mrn, dx, infection) {
    F.seed({ resourceType: 'Patient', id: id, name: [{ text: name }], ext: { mrn: mrn, diagnosis: dx, infection: infection } });
  }
  patient('Patient-1', '陈秀英', 'ZY20260615001', '肺炎', '双肺感染，痰培养ESBLs阳性，白细胞持续升高');
  patient('Patient-2', '王富贵', 'ZY20260612008', '腹腔感染', '腹腔脓肿，引流液培养示多重耐药菌');
  patient('Patient-3', '李秀兰', 'ZY20260608015', '脓毒症', '血培养阳性，疑似产ESBLs菌');
  patient('Patient-4', '赵德胜', 'ZY20260528022', '皮肤软组织感染', 'MRSA阳性创面感染');
  patient('Patient-5', '周丽', 'ZY20260520031', '尿路感染', '尿培养示大肠埃希菌，药敏敏感');
  patient('Patient-6', '孙建国', 'ZY20260614005', '重症肺炎', '呼吸衰竭，痰培养多重耐药鲍曼不动杆菌');

  /* -------------------- 4. 抗菌药物分级目录（Medication） -------------------- */
  // 默认分级映射（与权限映射 / 卡控规则联动）
  var LEVEL_DEFAULT = {
    'non-restricted': { titles: ['chief', 'associate', 'attending', 'resident'], approvals: [] },
    restricted: { titles: ['chief', 'associate', 'attending'], approvals: ['dept', 'pharmacy'] },
    special: { titles: ['chief'], approvals: ['dept', 'pharmacy', 'expert'] }
  };

  // 药品补充信息（规格 / 商品名 / 生产企业 / 医保 / 库存），提升数据真实度
  var MED_INFO = {
    '阿莫西林': ['0.25g×24粒', '阿莫仙', '联邦制药', '医保甲类', '充足'],
    '氨苄西林': ['0.5g×10支', '—', '华北制药', '医保甲类', '充足'],
    '青霉素G': ['80万U×10支', '—', '华北制药', '医保甲类', '充足'],
    '头孢氨苄': ['0.25g×24粒', '先锋4号', '白云山制药', '医保甲类', '充足'],
    '头孢拉定': ['0.25g×24粒', '泛捷复', '齐鲁制药', '医保甲类', '充足'],
    '头孢唑林': ['1g×10支', '先锋5号', '哈药集团', '医保甲类', '充足'],
    '阿奇霉素': ['0.25g×6片', '希舒美', '辉瑞制药', '医保乙类', '充足'],
    '红霉素': ['0.25g×24粒', '—', '东北制药', '医保甲类', '紧张'],
    '甲硝唑': ['0.2g×21片', '—', '湖南科伦', '医保甲类', '充足'],
    '多西环素': ['0.1g×10片', '—', '上海现代制药', '医保乙类', '充足'],
    '头孢呋辛': ['1.5g×10支', '西力欣', '葛兰素史克', '医保乙类', '充足'],
    '头孢克洛': ['0.25g×12粒', '希刻劳', '礼来制药', '医保乙类', '充足'],
    '头孢曲松': ['1g×10支', '罗氏芬', '罗氏制药', '医保乙类', '充足'],
    '头孢他啶': ['1g×10支', '复达欣', '葛兰素史克', '医保乙类', '紧张'],
    '头孢吡肟': ['1g×10支', '马斯平', '百时美施贵宝', '医保乙类', '充足'],
    '左氧氟沙星': ['0.5g×7片', '可乐必妥', '第一三共', '医保乙类', '充足'],
    '莫西沙星': ['0.4g×7片', '拜复乐', '拜耳医药', '医保乙类', '充足'],
    '环丙沙星': ['0.2g×10支', '西普乐', '拜耳医药', '医保乙类', '充足'],
    '哌拉西林他唑巴坦': ['4.5g×10支', '特治星', '辉瑞制药', '医保乙类', '充足'],
    '阿米卡星': ['0.2g×10支', '丁胺卡那', '齐鲁制药', '医保乙类', '充足'],
    '美罗培南': ['0.5g×10支', '美平', '住友制药', '医保乙类（限二线）', '紧张'],
    '亚胺培南西司他丁': ['0.5g×10支', '泰能', '默沙东', '医保乙类（限二线）', '紧张'],
    '比阿培南': ['0.3g×10支', '安信', '正大天晴', '医保乙类（限二线）', '充足'],
    '万古霉素': ['0.5g×1支', '稳可信', '礼来制药', '医保乙类（限二线）', '紧张'],
    '替考拉宁': ['0.2g×1支', '他格适', '赛诺菲', '医保乙类（限二线）', '充足'],
    '利奈唑胺': ['0.6g×10片', '斯沃', '辉瑞制药', '医保乙类（限二线）', '紧张'],
    '替加环素': ['50mg×10支', '泰阁', '辉瑞制药', '医保乙类（限二线）', '充足'],
    '多黏菌素B': ['50万U×1支', '—', '上海上药', '自费', '紧张'],
    '头孢他啶阿维巴坦': ['2.5g×10支', '思福妥', '辉瑞制药', '自费', '充足'],
    '达托霉素': ['0.5g×1支', '克必信', '默沙东', '自费', '充足']
  };

  function drug(id, name, drugClass, level, indication, usage, override) {
    var def = LEVEL_DEFAULT[level];
    var info = MED_INFO[name] || ['—', '—', '—', '医保乙类', '充足'];
    F.seed({
      resourceType: 'Medication', id: id,
      code: { text: name },
      status: 'active',
      ext: {
        drugClass: drugClass,
        level: level,
        spec: info[0],
        brand: info[1],
        manufacturer: info[2],
        indicationSummary: indication,
        usage: usage,
        allowedTitles: (override && override.titles) || def.titles.slice(),
        approvals: (override && override.approvals) || def.approvals.slice(),
        overridden: !!override,
        insurance: info[3],
        stock: info[4]
      }
    });
  }
  // 非限制使用级
  drug('Medication-1', '阿莫西林', '青霉素类', 'non-restricted', '敏感菌感染', '口服，成人0.5g/次，每8小时1次');
  drug('Medication-2', '氨苄西林', '青霉素类', 'non-restricted', '敏感菌感染', '静脉滴注，成人2~4g/日');
  drug('Medication-3', '青霉素G', '青霉素类', 'non-restricted', '敏感菌感染', '肌注/静滴，按医嘱');
  drug('Medication-4', '头孢氨苄', '头孢菌素类（一代）', 'non-restricted', '敏感菌感染', '口服，0.25~0.5g/次');
  drug('Medication-5', '头孢拉定', '头孢菌素类（一代）', 'non-restricted', '敏感菌感染', '口服，0.25~0.5g/次');
  drug('Medication-6', '头孢唑林', '头孢菌素类（一代）', 'non-restricted', '手术预防用药', '静脉滴注，1~2g/次');
  drug('Medication-7', '阿奇霉素', '大环内酯类', 'non-restricted', '呼吸道感染', '口服，0.5g/日');
  drug('Medication-8', '红霉素', '大环内酯类', 'non-restricted', '敏感菌感染', '口服，按医嘱');
  drug('Medication-9', '甲硝唑', '硝基咪唑类', 'non-restricted', '厌氧菌感染', '静滴/口服，按医嘱');
  drug('Medication-10', '多西环素', '四环素类', 'non-restricted', '敏感菌感染', '口服，0.1g/次');
  // 限制使用级
  drug('Medication-11', '头孢呋辛', '头孢菌素类（二代）', 'restricted', '敏感菌感染', '静滴，0.75~1.5g/次');
  drug('Medication-12', '头孢克洛', '头孢菌素类（二代）', 'restricted', '敏感菌感染', '口服，0.25g/次');
  drug('Medication-13', '头孢曲松', '头孢菌素类（三代）', 'restricted', '敏感菌感染', '静滴，1~2g/日');
  drug('Medication-14', '头孢他啶', '头孢菌素类（三代）', 'restricted', '铜绿假单胞菌感染', '静滴，1~2g/次');
  drug('Medication-15', '头孢吡肟', '头孢菌素类（四代）', 'restricted', '中重度感染', '静滴，1~2g/次，每12小时');
  drug('Medication-16', '左氧氟沙星', '喹诺酮类', 'restricted', '敏感菌感染', '静滴/口服，0.5g/日',
    { titles: ['chief', 'associate', 'attending'], approvals: ['dept', 'pharmacy', 'expert'] }); // 单独覆盖：需专家审批
  drug('Medication-17', '莫西沙星', '喹诺酮类', 'restricted', '呼吸道感染', '静滴/口服，0.4g/日');
  drug('Medication-18', '环丙沙星', '喹诺酮类', 'restricted', '敏感菌感染', '静滴，0.2~0.4g/次');
  drug('Medication-19', '哌拉西林他唑巴坦', '青霉素类复方', 'restricted', '中重度混合感染', '静滴，4.5g/次，每8小时');
  drug('Medication-20', '阿米卡星', '氨基糖苷类', 'restricted', '革兰阴性菌感染', '静滴，0.4g/日');
  // 特殊使用级
  drug('Medication-21', '美罗培南', '碳青霉烯类', 'special', '产ESBLs细菌感染、多重耐药菌感染、重症社区获得性肺炎', '静脉滴注，成人0.5~1g/次，每8小时1次');
  drug('Medication-22', '亚胺培南西司他丁', '碳青霉烯类', 'special', '严重感染、产ESBLs细菌感染、腹腔感染', '静脉滴注，0.5g/次，每6~8小时');
  drug('Medication-23', '比阿培南', '碳青霉烯类', 'special', '严重感染', '静脉滴注，0.3g/次，每12小时');
  drug('Medication-24', '万古霉素', '糖肽类', 'special', 'MRSA感染、伪膜性肠炎', '静脉滴注，1g/次，每12小时');
  drug('Medication-25', '替考拉宁', '糖肽类', 'special', '革兰阳性菌严重感染', '静滴，按医嘱负荷给药');
  drug('Medication-26', '利奈唑胺', '噁唑烷酮类', 'special', 'VRE感染、MRSA肺炎', '静滴/口服，0.6g/次，每12小时');
  drug('Medication-27', '替加环素', '甘氨酰环素类', 'special', '复杂腹腔/皮肤软组织感染', '静滴，首剂100mg，后50mg/12h');
  drug('Medication-28', '多黏菌素B', '多肽类', 'special', '多重耐药革兰阴性菌感染', '静滴，按体重给药');
  drug('Medication-29', '头孢他啶阿维巴坦', '酶抑制剂复方', 'special', '碳青霉烯耐药肠杆菌感染', '静滴，2.5g/次，每8小时');
  drug('Medication-30', '达托霉素', '脂肽类', 'special', '革兰阳性菌血流感染', '静滴，4~6mg/kg/日');

  // 标记目录中尚待复核更新的药品（用于"目录版本信息"待更新药品数的真实统计，而非写死数字）
  ['头孢他啶阿维巴坦', '达托霉素', '多黏菌素B'].forEach(function (name) {
    var m = F.search('Medication', function (x) { return x.code.text === name; })[0];
    if (m) { m.ext.pendingUpdate = true; F.update(m); }
  });

  /* -------------------- 5. 参考依据（Citation） -------------------- */
  function citation(id, title, publisher, date, linked) {
    F.seed({ resourceType: 'Citation', id: id, title: title, status: 'active', ext: { publisher: publisher, date: date, linked: linked, url: 'https://guideline.example.org/' + id } });
  }
  citation('Citation-1', '抗菌药物临床应用指导原则(2025版)', '国家卫健委', '2025-06', 45);
  citation('Citation-2', '热带病学会ESBLs感染诊疗指南(2024版)', '中华医学会', '2024-03', 12);
  citation('Citation-3', '中国多重耐药菌感染诊疗专家共识(2025版)', '中华医学会', '2025-01', 8);
  citation('Citation-4', '社区获得性肺炎诊疗指南(2024版)', '中华呼吸分会', '2024-09', 6);
  citation('Citation-5', 'MRSA感染诊疗专家共识(2023版)', '中华医学会', '2023-11', 4);

  /* -------------------- 6. 适应症知识库（ClinicalUseDefinition） -------------------- */
  function indication(id, drug, desc, standard, citations) {
    F.seed({
      resourceType: 'ClinicalUseDefinition', id: id, type: 'indication',
      ext: { drug: drug, description: desc, standard: standard, citations: citations }
    });
  }
  indication('ClinicalUseDefinition-1', '美罗培南', '产ESBLs细菌感染', '确诊+药敏', ['Citation-2']);
  indication('ClinicalUseDefinition-2', '美罗培南', '多重耐药菌感染', '确诊+药敏', ['Citation-3', 'Citation-1']);
  indication('ClinicalUseDefinition-3', '美罗培南', '重症社区获得性肺炎', '确诊+影像', ['Citation-4']);
  indication('ClinicalUseDefinition-4', '亚胺培南西司他丁', '产ESBLs细菌感染', '确诊+药敏', ['Citation-2']);
  indication('ClinicalUseDefinition-5', '亚胺培南西司他丁', '腹腔感染', '确诊+培养', ['Citation-1', 'Citation-3']);
  indication('ClinicalUseDefinition-6', '万古霉素', 'MRSA感染', '确诊+药敏', ['Citation-5', 'Citation-1']);
  indication('ClinicalUseDefinition-7', '万古霉素', '伪膜性肠炎', '确诊+毒素检测', ['Citation-1']);
  indication('ClinicalUseDefinition-8', '左氧氟沙星', '敏感菌所致尿路感染', '确诊+药敏', ['Citation-1']);
  indication('ClinicalUseDefinition-9', '头孢吡肟', '中重度感染', '确诊+病原学', ['Citation-1']);
  indication('ClinicalUseDefinition-10', '利奈唑胺', 'VRE感染', '确诊+药敏', ['Citation-5']);

  /* -------------------- 7. 权限映射规则（Permission, 按分级） -------------------- */
  global.Domain.LEVELS.forEach(function (lv) {
    var def = LEVEL_DEFAULT[lv.code];
    F.seed({
      resourceType: 'Permission', id: 'Permission-map-' + lv.code, status: 'active',
      ext: { category: 'level-mapping', level: lv.code, allowedTitles: def.titles.slice(), approvals: def.approvals.slice() }
    });
  });

  /* -------------------- 8. 卡控规则（Permission, gatekeeping） -------------------- */
  global.Domain.LEVELS.forEach(function (lv) {
    var def = LEVEL_DEFAULT[lv.code];
    F.seed({
      resourceType: 'Permission', id: 'Permission-gate-' + lv.code, status: 'active',
      ext: {
        category: 'gatekeeping', level: lv.code,
        titleCheck: true,
        approvalCheck: def.approvals.slice(),
        interceptOnTitleMismatch: 'block',   // block | warn
        interceptOnNotApproved: def.approvals.length ? 'block' : 'none'
      }
    });
  });

    /* -------------------- 9. 审批流程定义：改由第 18 节经 Approval 引擎按版本发布 -------------------- */

  /* -------------------- 10. 处方权限申请（Task） -------------------- */
  // 工作流节点：根据申请类型生成
  function makeFlow(type) {
    var roles = type === 'special' ? ['dept', 'pharmacy', 'expert'] : ['dept', 'pharmacy'];
    return roles.map(function (r, i) {
      return { seq: i + 1, role: r, roleName: NODE_ROLE[r], status: 'pending', approver: '', time: '' };
    });
  }
  function setFlowProgress(flow, passedCount, currentNode) {
    flow.forEach(function (n, i) {
      if (i < passedCount) { n.status = 'approved'; }
      else if (i === passedCount && currentNode) { n.status = 'current'; }
    });
    return flow;
  }

  function task(opts) {
    var flow = makeFlow(opts.type);
    // 设置流程进度
    flow = setFlowProgress(flow, opts.passed || 0, opts.status === 'in-progress');
    if (opts.flowOverride) flow = opts.flowOverride;
    F.seed({
      resourceType: 'Task', id: opts.id,
      identifier: [{ value: opts.sqno }],
      status: opts.status,            // requested | in-progress | completed | rejected | cancelled
      intent: 'order',
      authoredOn: R4.toInstant(opts.time),
      businessStatus: opts.businessStatus,
      for: { reference: 'Patient/' + opts.patient },
      requester: { reference: 'Practitioner/' + opts.requester, display: opts.requesterName },
      ext: {
        type: opts.type,            // restricted | special
        drug: opts.drug,
        dept: opts.dept,
        requesterTitle: opts.requesterTitle,
        useStart: opts.useStart, useEnd: opts.useEnd,
        reason: opts.reason,
        patientName: opts.patientName, mrn: opts.mrn, diagnosis: opts.diagnosis, infection: opts.infection,
        flow: flow,
        decision: opts.decision || null
      }
    });
  }

  // —— 医师“王伟”本人历史申请（处方权限申请页 L3-1-1） ——
  task({
    id: 'Task-1001', sqno: 'SQ-20260612', type: 'special', status: 'completed', passed: 3,
    time: '2026-06-12 09:20', drug: '美罗培南', dept: '内科', requester: 'Practitioner-9003', requesterName: '王伟', requesterTitle: 'associate',
    patient: 'Patient-2', patientName: '王富贵', mrn: 'ZY20260612008', diagnosis: '腹腔感染', infection: '腹腔脓肿，引流液培养示多重耐药菌',
    useStart: '2026-06-13', useEnd: '2026-06-20', reason: '腹腔多重耐药菌感染，经验性治疗无效，依据药敏结果申请使用',
    businessStatus: { text: '已通过' },
    decision: { result: 'approved', by: '陈志远', time: '2026-06-12 15:30', reason: '' },
    flowOverride: [
      { seq: 1, role: 'dept', roleName: '科室负责人', status: 'approved', approver: '陈主任', time: '2026-06-12 10:00' },
      { seq: 2, role: 'pharmacy', roleName: '药学部门', status: 'approved', approver: '张玉梅', time: '2026-06-12 13:00' },
      { seq: 3, role: 'expert', roleName: '审批专家', status: 'approved', approver: '陈志远', time: '2026-06-12 15:30' }
    ]
  });
  task({
    id: 'Task-1002', sqno: 'SQ-20260608', type: 'special', status: 'in-progress', passed: 2,
    time: '2026-06-08 11:00', drug: '亚胺培南西司他丁', dept: '内科', requester: 'Practitioner-9003', requesterName: '王伟', requesterTitle: 'associate',
    patient: 'Patient-3', patientName: '李秀兰', mrn: 'ZY20260608015', diagnosis: '脓毒症', infection: '血培养阳性，疑似产ESBLs菌',
    useStart: '2026-06-09', useEnd: '2026-06-16', reason: '脓毒症，疑似产ESBLs菌，病情危重申请特殊使用级用药',
    businessStatus: { text: '审批中·审批专家终审' }
  });
  task({
    id: 'Task-1003', sqno: 'SQ-20260528', type: 'special', status: 'rejected', passed: 2,
    time: '2026-05-28 14:10', drug: '万古霉素', dept: '内科', requester: 'Practitioner-9003', requesterName: '王伟', requesterTitle: 'associate',
    patient: 'Patient-4', patientName: '赵德胜', mrn: 'ZY20260528022', diagnosis: '皮肤软组织感染', infection: 'MRSA阳性创面感染',
    useStart: '2026-05-29', useEnd: '2026-06-05', reason: '创面感染，申请万古霉素治疗',
    businessStatus: { text: '已驳回' },
    decision: { result: 'rejected', by: '陈志远', time: '2026-05-28 16:40', reason: '缺少药敏报告，建议先完善病原学检查；当前可先用利奈唑胺经验治疗' },
    flowOverride: [
      { seq: 1, role: 'dept', roleName: '科室负责人', status: 'approved', approver: '陈主任', time: '2026-05-28 14:40' },
      { seq: 2, role: 'pharmacy', roleName: '药学部门', status: 'approved', approver: '张玉梅', time: '2026-05-28 15:30' },
      { seq: 3, role: 'expert', roleName: '审批专家', status: 'rejected', approver: '陈志远', time: '2026-05-28 16:40' }
    ]
  });
  task({
    id: 'Task-1004', sqno: 'SQ-20260520', type: 'restricted', status: 'completed', passed: 2,
    time: '2026-05-20 08:30', drug: '头孢曲松', dept: '内科', requester: 'Practitioner-9003', requesterName: '王伟', requesterTitle: 'associate',
    patient: 'Patient-5', patientName: '周丽', mrn: 'ZY20260520031', diagnosis: '尿路感染', infection: '尿培养示大肠埃希菌',
    useStart: '2026-05-20', useEnd: '2026-05-27', reason: '尿路感染，依据药敏申请头孢曲松',
    businessStatus: { text: '已通过' },
    decision: { result: 'approved', by: '张玉梅', time: '2026-05-20 11:00', reason: '' },
    flowOverride: [
      { seq: 1, role: 'dept', roleName: '科室负责人', status: 'approved', approver: '陈主任', time: '2026-05-20 09:10' },
      { seq: 2, role: 'pharmacy', roleName: '药学部门', status: 'approved', approver: '张玉梅', time: '2026-05-20 11:00' }
    ]
  });
  task({
    id: 'Task-1005', sqno: 'SQ-20260515', type: 'restricted', status: 'completed', passed: 3,
    time: '2026-05-15 10:00', drug: '左氧氟沙星', dept: '内科', requester: 'Practitioner-9003', requesterName: '王伟', requesterTitle: 'associate',
    patient: 'Patient-5', patientName: '周丽', mrn: 'ZY20260515009', diagnosis: '尿路感染', infection: '尿培养示大肠埃希菌，药敏敏感',
    useStart: '2026-05-15', useEnd: '2026-05-22', reason: '敏感菌尿路感染，申请左氧氟沙星',
    businessStatus: { text: '已通过' },
    decision: { result: 'approved', by: '陈志远', time: '2026-05-15 14:00', reason: '' },
    flowOverride: [
      { seq: 1, role: 'dept', roleName: '科室负责人', status: 'approved', approver: '陈主任', time: '2026-05-15 10:40' },
      { seq: 2, role: 'pharmacy', roleName: '药学部门', status: 'approved', approver: '张玉梅', time: '2026-05-15 12:30' },
      { seq: 3, role: 'expert', roleName: '审批专家', status: 'approved', approver: '陈志远', time: '2026-05-15 14:00' }
    ]
  });

  // —— 待审批专家审批的申请（处方权限审批页 L3-1-2，停留在 expert 节点） ——
  function pendingExpert(id, sqno, time, drug, dept, reqId, reqName, reqTitle, patient, pName, mrn, dx, inf, useStart, useEnd, reason) {
    task({
      id: id, sqno: sqno, type: 'special', status: 'in-progress', passed: 2,
      time: time, drug: drug, dept: dept, requester: reqId, requesterName: reqName, requesterTitle: reqTitle,
      patient: patient, patientName: pName, mrn: mrn, diagnosis: dx, infection: inf,
      useStart: useStart, useEnd: useEnd, reason: reason,
      businessStatus: { text: '待审批专家终审' }
    });
  }
  pendingExpert('Task-2001', 'SQ-20260615', '2026-06-15 10:30', '美罗培南', '内科', 'Practitioner-9003', '王伟', 'associate',
    'Patient-1', '陈秀英', 'ZY20260615001', '肺炎', '双肺感染，痰培养ESBLs阳性，白细胞持续升高',
    '2026-06-16', '2026-06-23', '患者ESBLs阳性，重症社区获得性肺炎，常规抗生素治疗无效，依据药敏申请美罗培南');
  pendingExpert('Task-2002', 'SQ-20260614', '2026-06-14 09:15', '亚胺培南西司他丁', '外科', 'Practitioner-1001', '张建华', 'chief',
    'Patient-6', '孙建国', 'ZY20260614005', '重症肺炎', '呼吸衰竭，痰培养多重耐药鲍曼不动杆菌',
    '2026-06-15', '2026-06-22', '术后重症肺炎，多重耐药鲍曼不动杆菌，申请亚胺培南');
  pendingExpert('Task-2003', 'SQ-20260611', '2026-06-11 16:20', '万古霉素', 'ICU', 'Practitioner-1004', '刘洋', 'associate',
    'Patient-4', '赵德胜', 'ZY20260611030', '脓毒性休克', '血培养MRSA阳性',
    '2026-06-12', '2026-06-19', 'ICU脓毒性休克，血培养MRSA阳性，申请万古霉素');

  // —— 审批专家已处理记录（已通过/已驳回） ——
  task({
    id: 'Task-2010', sqno: 'SQ-20260610', type: 'special', status: 'completed', passed: 3,
    time: '2026-06-10 13:00', drug: '利奈唑胺', dept: '呼吸科', requester: 'Practitioner-1002', requesterName: '李娜', requesterTitle: 'attending',
    patient: 'Patient-6', patientName: '孙建国', mrn: 'ZY20260610012', diagnosis: 'MRSA肺炎', infection: '痰培养MRSA阳性',
    useStart: '2026-06-10', useEnd: '2026-06-17', reason: 'MRSA肺炎，申请利奈唑胺',
    businessStatus: { text: '已通过' },
    decision: { result: 'approved', by: '陈志远', time: '2026-06-10 15:20', reason: '' },
    flowOverride: [
      { seq: 1, role: 'dept', roleName: '科室负责人', status: 'approved', approver: '李主任', time: '2026-06-10 13:30' },
      { seq: 2, role: 'pharmacy', roleName: '药学部门', status: 'approved', approver: '张玉梅', time: '2026-06-10 14:30' },
      { seq: 3, role: 'expert', roleName: '审批专家', status: 'approved', approver: '陈志远', time: '2026-06-10 15:20' }
    ]
  });
  task({
    id: 'Task-2011', sqno: 'SQ-20260609', type: 'special', status: 'rejected', passed: 3,
    time: '2026-06-09 11:30', drug: '替加环素', dept: '骨科', requester: 'Practitioner-1003', requesterName: '赵磊', requesterTitle: 'attending',
    patient: 'Patient-4', patientName: '赵德胜', mrn: 'ZY20260609018', diagnosis: '骨髓炎', infection: '创面培养待回报',
    useStart: '2026-06-09', useEnd: '2026-06-16', reason: '骨髓炎经验性治疗',
    businessStatus: { text: '已驳回' },
    decision: { result: 'rejected', by: '陈志远', time: '2026-06-09 14:00', reason: '尚无病原学依据，建议完善培养后再评估，暂不符合特殊使用级用药指征' },
    flowOverride: [
      { seq: 1, role: 'dept', roleName: '科室负责人', status: 'approved', approver: '骨科主任', time: '2026-06-09 12:00' },
      { seq: 2, role: 'pharmacy', roleName: '药学部门', status: 'approved', approver: '李药师', time: '2026-06-09 13:00' },
      { seq: 3, role: 'expert', roleName: '审批专家', status: 'rejected', approver: '陈志远', time: '2026-06-09 14:00' }
    ]
  });

  /* -------------------- 11. 预警（DetectedIssue） -------------------- */
  function issue(id, time, type, dept, summary, severity, detail) {
    F.seed({
      resourceType: 'DetectedIssue', id: id, status: 'preliminary', severity: severity,
      ext: { time: time, type: type, dept: dept, summary: summary, detail: detail, handled: false }
    });
  }
  issue('DetectedIssue-1', '2026-06-15 14:30', '用药指征不合理', '内科', '美罗培南使用无药敏依据', 'high',
    { patient: '陈秀英', drug: '美罗培南', reason: '未见药敏报告即使用特殊使用级药物', advice: '补充病原学送检，复核用药指征' });
  issue('DetectedIssue-2', '2026-06-15 11:45', '用药指征不合理', 'ICU', '万古霉素超适应症使用', 'high',
    { patient: '赵德胜', drug: '万古霉素', reason: '使用指征与适应症知识库标准不符', advice: '复核诊断与用药方案' });
  issue('DetectedIssue-3', '2026-06-14 16:30', '手术预防用药违规', '普外科', '术后预防用药超过48h', 'moderate',
    { patient: '王富贵', drug: '头孢唑林', reason: '胆囊切除术后预防用药持续96h，超过48h标准', advice: '术后24~48h内停药' });
  issue('DetectedIssue-4', '2026-06-14 10:15', '用药指征不合理', '呼吸科', '头孢吡肟无病原学依据', 'moderate',
    { patient: '孙建国', drug: '头孢吡肟', reason: '缺少病原学检查依据', advice: '完善病原学检查' });
  issue('DetectedIssue-5', '2026-06-13 15:40', '用药时长超限', '外科', '美罗培南持续使用>14天', 'high',
    { patient: '孙建国', drug: '美罗培南', reason: '碳青霉烯类持续使用超过14天', advice: '评估降阶梯治疗' });
  issue('DetectedIssue-6', '2026-06-12 09:10', '送检率偏低预警', '骨科', '骨科本月送检率低于50%', 'low',
    { dept: '骨科', reason: '治疗性使用抗菌药物前病原学送检率偏低', advice: '加强送检管理' });

  /* -------------------- 12. 手术预防用药监测（Observation） -------------------- */
  function surgery(id, dept, type, timing, duration, rational) {
    F.seed({ resourceType: 'Observation', id: id, status: 'final', ext: { category: 'surgical-prophylaxis', dept: dept, surgeryType: type, timing: timing, duration: duration, rational: rational } });
  }
  surgery('Observation-s1', '外科', '阑尾切除术', '术前30min内', '24h', 'reasonable');
  surgery('Observation-s2', '骨科', '关节置换术', '术前30min内', '48h', 'reasonable');
  surgery('Observation-s3', 'ICU', '开颅手术', '术前1h', '72h', 'long');
  surgery('Observation-s4', '普外科', '胆囊切除术', '术后用药', '96h', 'violation');
  surgery('Observation-s5', '妇产科', '剖宫产', '术前30min内', '24h', 'reasonable');

  /* -------------------- 13. 抗菌药物使用记录（MedicationAdministration） --------------------
   * 监测分析（监测概览 / 统计报表）中的全部统计数据均由此处生成的原始给药记录实时聚合计算得出
   * （见 services.js 的 computeOverview / computeReportTables），而非写死的展示数字。 */
  (function seedUsageRecords() {
    // 固定种子的确定性伪随机数生成器，保证演示数据每次加载一致（mulberry32）
    function mulberry32(seed) {
      return function () {
        seed |= 0; seed = seed + 0x6D2B79F5 | 0;
        var t = Math.imul(seed ^ seed >>> 15, 1 | seed);
        t = t + Math.imul(t ^ t >>> 7, 61 | t) ^ t;
        return ((t ^ t >>> 14) >>> 0) / 4294967296;
      };
    }
    var rnd = mulberry32(20260615);
    var beds = global.Domain.DEPT_BEDS, doctorsMap = global.Domain.DEPT_DOCTORS;
    // 用药记录是聚合统计的原始数据、量大；默认只进本地镜像，
    // 由 fhir-config.json 的 persistUsageRecords 决定是否落服务端
    var usageLocal = { local: !(global.AmrConfig && global.AmrConfig.get('persistUsageRecords')) };
    var medsByLevel = { 'non-restricted': [], restricted: [], special: [] };
    F.search('Medication').forEach(function (m) { medsByLevel[m.ext.level].push(m); });

    // 各科室三级用药占比（ICU 危重症患者特殊使用级占比明显更高，符合临床实际）
    var LEVEL_WEIGHT = {
      '内科': { 'non-restricted': 0.55, restricted: 0.35, special: 0.10 },
      '外科': { 'non-restricted': 0.50, restricted: 0.38, special: 0.12 },
      'ICU': { 'non-restricted': 0.20, restricted: 0.40, special: 0.40 },
      '呼吸科': { 'non-restricted': 0.45, restricted: 0.40, special: 0.15 },
      '骨科': { 'non-restricted': 0.60, restricted: 0.32, special: 0.08 },
      '妇产科': { 'non-restricted': 0.65, restricted: 0.30, special: 0.05 }
    };
    var SUBMIT_P = { 'non-restricted': 0.55, restricted: 0.72, special: 0.88 }; // 分级越高，病原学送检率越高
    var DDD_RANGE = { 'non-restricted': [0.4, 0.9], restricted: [0.8, 1.6], special: [1.2, 2.4] };

    function pickLevel(weights) {
      var x = rnd(), acc = 0, codes = ['non-restricted', 'restricted', 'special'];
      for (var i = 0; i < codes.length; i++) { acc += weights[codes[i]]; if (x <= acc) return codes[i]; }
      return 'non-restricted';
    }
    function fmtDate(d) { function p(n) { return String(n).padStart(2, '0'); } return d.getFullYear() + '-' + p(d.getMonth() + 1) + '-' + p(d.getDate()); }

    var END = new Date(2026, 5, 15); // 数据集"当前时间"对齐全局演示日期 2026-06-15
    var DAYS = 30, seq = 0;
    for (var day = DAYS - 1; day >= 0; day--) {
      var d = new Date(END); d.setDate(END.getDate() - day);
      var dateStr = fmtDate(d);
      Object.keys(beds).forEach(function (dept) {
        var n = 15 + Math.floor(rnd() * 25); // 每科每日 15~39 条给药记录，用药强度落在贴近真实院内基准（约 40 DDD/百床日）的区间
        for (var k = 0; k < n; k++) {
          var level = pickLevel(LEVEL_WEIGHT[dept]);
          var pool = medsByLevel[level].length ? medsByLevel[level] : medsByLevel['non-restricted'];
          var med = pool[Math.floor(rnd() * pool.length)];
          var docs = doctorsMap[dept];
          var doc = docs[rnd() < 0.65 ? 0 : 1];
          var range = DDD_RANGE[level];
          seq++;
          F.seed({
            resourceType: 'MedicationAdministration', id: 'MedicationAdministration-' + seq, status: 'completed',
            ext: {
              date: dateStr, dept: dept, drug: med.code.text, drugClass: med.ext.drugClass, level: level,
              ddd: +(range[0] + rnd() * (range[1] - range[0])).toFixed(2),
              submitted: rnd() < SUBMIT_P[level],
              doctor: doc.name, doctorTitle: doc.title
            }
          }, usageLocal);
        }
      });
    }
  })();

  /* -------------------- 14. 近期动态 / 公告 / 通知（Communication） -------------------- */
  function comm(id, category, time, type, content, target, unread) {
    F.seed({ resourceType: 'Communication', id: id, status: 'completed', ext: { category: category, time: time, type: type, content: content, target: target, unread: !!unread } });
  }
  // 近期动态
  comm('Communication-d1', 'dynamic', '2026-06-15 14:30', '通过', '张建华-特殊使用级申请（亚胺培南）已通过', 'expert,admin');
  comm('Communication-d2', 'dynamic', '2026-06-15 14:15', '驳回', '李娜-美罗培南申请被驳回', 'expert,admin');
  comm('Communication-d3', 'dynamic', '2026-06-15 13:50', '预警', '内科-用药指征不合理预警', 'quality,admin');
  comm('Communication-d4', 'dynamic', '2026-06-15 13:20', '通过', '王建明-碳青霉烯类申请已通过', 'expert,admin');
  comm('Communication-d5', 'dynamic', '2026-06-15 10:30', '提交', '王伟-美罗培南特殊使用级申请已提交', 'doctor');
  // 系统公告
  comm('Communication-a1', 'announcement', '2026-06-01', '公告', '抗菌药物分级目录已更新至 v3.2（国家卫健委目录2026版）', 'all');
  comm('Communication-a2', 'announcement', '2026-06-10', '公告', '权限映射规则于 06-10 完成更新，请相关人员知悉', 'all');
  comm('Communication-a3', 'announcement', '2026-06-18', '公告', '系统将于本周六 22:00-24:00 进行例行维护', 'all');
  // 通知中心（未读 3）
  comm('Communication-n1', 'notification', '2026-06-15 10:31', '审批待办', '您有 3 件特殊使用级申请待审批', 'expert', true);
  comm('Communication-n2', 'notification', '2026-06-15 14:30', '预警提醒', '内科美罗培南使用无药敏依据，请关注', 'quality', true);
  comm('Communication-n3', 'notification', '2026-06-15 02:00', '同步异常告警', '合理用药系统同步异常，请检查接口配置', 'admin', true);

  /* -------------------- 15. 变更记录（Provenance） -------------------- */
  function prov(id, time, ptype, content, operator) {
    F.seed({ resourceType: 'Provenance', id: id, recorded: R4.toInstant(time), ext: { changeType: ptype, content: content, operator: operator } });
  }
  // 系统参数变更记录
  prov('Provenance-p1', '2026-06-16 10:30', '职称权限', '副主任医师开放特殊使用级权限', '管理员李建国');
  prov('Provenance-p2', '2026-06-15 14:00', '同步参数', '同步频率从每日改为每6小时', '管理员李建国');
  prov('Provenance-p3', '2026-06-14 09:20', '通知配置', '预警提醒新增短信通知渠道', '管理员李建国');
  prov('Provenance-p4', '2026-06-10 16:00', '外部系统', '合理用药系统接口地址变更', '管理员李建国');
  // 目录版本历史
  prov('Provenance-c1', '2026-06-01', '目录版本', '同步国家卫健委目录2026版，更新至 v3.2', '管理员李建国');
  prov('Provenance-c2', '2026-04-15', '目录版本', '新增达托霉素等3种特殊使用级药品，更新至 v3.1', '药学部·张玉梅');
  prov('Provenance-c3', '2026-02-20', '目录版本', '调整喹诺酮类药品分级，更新至 v3.0', '管理员李建国');
  // 权限映射变更
  prov('Provenance-m1', '2026-06-10 14:30', '权限映射', '限制使用级移除住院医师开具权限', '管理员李建国');
  prov('Provenance-m2', '2026-05-22 09:00', '权限映射', '左氧氟沙星单独配置为需专家审批', '药学部·张玉梅');
  // 卡控规则变更
  prov('Provenance-g1', '2026-06-10 14:30', '卡控规则', '特殊使用级启用审批专家审批前置校验，审批未通过拦截提交', '管理员李建国');
  prov('Provenance-g2', '2026-05-30 11:20', '卡控规则', '限制使用级职称不匹配由「仅提示」调整为「拦截提交」', '管理员李建国');

  /* -------------------- 16. 外部系统对接（Endpoint） -------------------- */
  function endpoint(id, name, conn, status, lastSync) {
    F.seed({ resourceType: 'Endpoint', id: id, status: status, name: name, ext: { conn: conn, lastSync: lastSync, address: 'https://' + id + '.hospital.com/api/v1', auth: 'OAuth2.0' } });
  }
  endpoint('Endpoint-his', 'HIS系统', 'API', 'active', '2026-06-16 08:30');     // 正常
  endpoint('Endpoint-qual', '医师资质系统', 'API', 'active', '2026-06-16 02:00'); // 正常
  endpoint('Endpoint-rational', '合理用药系统', 'API', 'error', '2026-06-15 14:00'); // 异常
  endpoint('Endpoint-emr', '电子病历系统', 'API', 'off', '2026-06-10 09:00');    // 断开

  /* -------------------- 17. 配置单例（Basic） -------------------- */
  function basic(code, payload) {
    F.seed({ resourceType: 'Basic', id: 'Basic-' + code, code: { text: code }, ext: payload });
  }
  basic('catalog-version', { version: 'v3.2', updatedAt: '2026-06-01', source: '国家卫健委目录2026版' });
  basic('kb-version', { version: 'v2.1', updatedAt: '2026-05-20', count: 10, catalogUpdatedAt: '2026-06-01', pendingSync: true });
  basic('gatekeep-status', {
    active: true, lastModified: '2026-06-10 14:30', operator: '管理员李建国',
    scope: '全院抗菌药物医嘱提交时实时校验',
    interceptMode: 'popup',
    insufficientText: '您的处方权限不足，无法开具该级别抗菌药物。请申请对应处方权限后再行开具。',
    notApprovedText: '该药品的处方权限申请尚未通过审批，无法提交医嘱。请等待审批完成后再行开具。'
  });
  basic('sync-params', {
    enabled: true, frequency: '每日', time: '02:00',
    scope: { title: true, dept: true, onDuty: true, exam: false },
    onFail: '保持原数据不变', failThreshold: 3,
    records: [
      { time: '2026-06-16 02:00', status: '成功', amount: 1248, cost: '12s' },
      { time: '2026-06-15 02:00', status: '成功', amount: 1245, cost: '11s' },
      { time: '2026-06-14 02:00', status: '失败', amount: '-', cost: '-' }
    ]
  });
  basic('title-change-rules', {
    promoteTiming: 'immediate', demoteTiming: 'nextday',
    rules: { autoMatchOnPromote: true, autoRevokeOnDemote: true, keepSpecialOnDemote: false, notifyOnChange: true, stopApprovalOnRevoke: true },
    onLeave: 'revoke', onReturn: 'restore'
  });
  basic('notify-config', {
    items: [
      { type: '审批待办通知', inApp: true, sms: false, email: true, target: '审批角色', repeatEnabled: false, repeatInterval: 24, repeatMax: 3, content: '您有新的处方权限申请（${药品名称}）待审批，请及时处理。' },
      { type: '审批结果通知', inApp: true, sms: false, email: true, target: '申请医师', repeatEnabled: false, repeatInterval: 24, repeatMax: 3, content: '您申请的「${药品名称}」处方权限已${审批结果}，详见处方权限申请记录。' },
      { type: '权限变更通知', inApp: true, sms: false, email: true, target: '受影响医师', repeatEnabled: false, repeatInterval: 24, repeatMax: 3, content: '您的处方权限范围已调整为：${处方权限范围}，如有疑问请联系药学部门。' },
      { type: '预警提醒通知', inApp: true, sms: true, email: true, target: '质控部门', repeatEnabled: true, repeatInterval: 24, repeatMax: 3, content: '科室[${科室名称}]出现[${预警类型}]预警：${详情摘要}，请及时核查处理。' },
      { type: '同步异常告警', inApp: true, sms: true, email: true, target: '系统管理员', repeatEnabled: true, repeatInterval: 6, repeatMax: 5, content: '外部系统[${系统名称}]同步异常，请检查接口配置并处理。' },
      { type: '卡控拦截通知', inApp: true, sms: false, email: false, target: '开医嘱医师', repeatEnabled: false, repeatInterval: 24, repeatMax: 3, content: '您开具的「${药品名称}」医嘱因${拦截原因}被系统拦截，请申请对应处方权限后再行开具。' }
    ]
  });
  basic('role-permissions', {
    pages: {
      'home': ['admin', 'ruleadmin', 'doctor', 'expert', 'pharmacy', 'flowviewer', 'quality'],
      'auth-apply': ['doctor'],
      'auth-approve': ['expert', 'pharmacy'],
      'catalog': ['admin', 'pharmacy'],
      'perm-mapping': ['admin', 'pharmacy'],
      'indication': ['admin', 'pharmacy'],
      'monitor': ['quality', 'pharmacy'],
      'report': ['quality', 'pharmacy'],
      'gatekeep': ['admin'],
      'workflow-config': ['admin', 'ruleadmin'],
      'sys-params': ['admin'],
      'grade-rules': ['admin', 'ruleadmin'],
      'physician-perm': ['admin', 'ruleadmin'],
      'workflow-designer': ['admin', 'ruleadmin'],
      'workflow-versions': ['admin', 'ruleadmin', 'flowviewer'],
      'approval-center': ['expert', 'pharmacy', 'doctor', 'admin', 'ruleadmin', 'flowviewer'],
      'mobile-approval': ['expert', 'pharmacy', 'doctor', 'admin', 'ruleadmin'],
      'order-demo': ['doctor', 'admin', 'ruleadmin'],
      'emergency-review': ['doctor', 'expert', 'admin', 'ruleadmin'],
      'demo-data': ['admin', 'ruleadmin', 'flowviewer']
    }
  });

  /* =====================================================================
   * 18. SRS 演示数据集（SRS §11）：虚构医院与科室、PractitionerRole、患者与
   *     门诊/住院/急诊就诊、MedicationKnowledge、等级与用药目的字典、三层授权
   *     与合并优先级、版本化审批流程、以及经引擎生成的审批实例。
   *     流程与实例一律调用 Approval 引擎生成 —— 初始化数据与运行时写入走同一条
   *     代码路径，装载种子即等于验证了一遍引擎。
   * ===================================================================== */
  var A = global.Approval, LV = global.Domain;
  function roleTitle(c) {
    return { admin: '系统管理员', ruleadmin: '规则管理员', pharmacy: '药学部门', doctor: '医师',
      expert: '审批专家', leader: '科室负责人', infection: '感染科医师', quality: '质控人员' }[c] || c;
  }

  /* 18.1 虚构医院与科室（名称一律带「演示」，SRS §11.1） */
  F.seed({ resourceType: 'Organization', id: 'Organization-hospital-demo',
    name: '演示医院（虚构）', identifier: [{ system: A.SYS.id, value: 'HOSP-DEMO' }],
    type: [{ coding: [{ code: 'HOSP' }], text: '医院' }],
    ext: { orgKind: 'hospital', kindDesc: '医院', demo: true, note: '仅用于演示，非真实医院' } });
  var DEMO_ORGS = [
    ['Organization-dept-demo-1', '呼吸内科（演示）', '临床科室'],
    ['Organization-dept-demo-2', '普通外科（演示）', '临床科室'],
    ['Organization-dept-demo-3', '重症医学科（演示）', '临床科室'],
    ['Organization-dept-demo-4', '药事管理科（演示）', '药事管理 / 抗菌药物管理'],
    ['Organization-dept-demo-5', '医务管理科（演示）', '医务管理'],
    ['Organization-dept-demo-6', '感染科（演示）', '临床科室 / 审批科室'],
    ['Organization-dept-demo-7', '医疗质量管理部（演示）', '质量管理']
  ];
  DEMO_ORGS.forEach(function (o) {
    F.seed({ resourceType: 'Organization', id: o[0], name: o[1],
      partOf: { reference: 'Organization/Organization-hospital-demo' },
      identifier: [{ system: A.SYS.id, value: o[0].replace('Organization-', '') }],
      type: [{ coding: [{ code: 'DEPT' }], text: o[2] }],
      ext: { orgKind: 'department', kindDesc: o[2], demo: true, parent: 'Organization-hospital-demo' } });
  });

  /* 18.2 人员岗位 PractitionerRole：SRS §9.4 要求授权能反向查到
   *      Practitioner / PractitionerRole / Organization。 */
  var PRACT_PLACEMENT = [
    ['Practitioner-9001', '李建国', 'Organization-dept-demo-5', null, ['admin', 'leader'], '演示医院管理办公室'],
    ['Practitioner-9011', '王素芬', 'Organization-dept-demo-4', null, ['ruleadmin', 'pharmacy'], '药事管理科（演示）'],
    ['Practitioner-9002', '张玉梅', 'Organization-dept-demo-4', null, ['pharmacy'], '药事管理科（演示）'],
    ['Practitioner-1101', '李药师', 'Organization-dept-demo-4', null, ['pharmacy'], '药事管理科（演示）'],
    ['Practitioner-9003', '王伟', 'Organization-dept-demo-1', 'attending', ['doctor'], '呼吸内科（演示）'],
    ['Practitioner-1201', '陈慧兰', 'Organization-dept-demo-1', 'chief', ['leader', 'expert'], '呼吸内科（演示）'],
    ['Practitioner-1002', '李娜', 'Organization-dept-demo-1', 'attending', ['doctor'], '呼吸内科（演示）'],
    ['Practitioner-1001', '张建华', 'Organization-dept-demo-2', 'chief', ['doctor', 'leader'], '普通外科（演示）'],
    ['Practitioner-1003', '赵磊', 'Organization-dept-demo-2', 'attending', ['doctor'], '普通外科（演示）'],
    ['Practitioner-1005', '孙倩', 'Organization-dept-demo-2', 'attending', ['doctor'], '普通外科（演示）'],
    ['Practitioner-1006', '周强', 'Organization-dept-demo-2', 'chief', ['doctor'], '普通外科（演示）'],
    ['Practitioner-1004', '刘洋', 'Organization-dept-demo-3', 'associate', ['doctor'], '重症医学科（演示）'],
    ['Practitioner-1202', '黄主任', 'Organization-dept-demo-3', 'chief', ['leader'], '重症医学科（演示）'],
    ['Practitioner-9004', '陈志远', 'Organization-dept-demo-6', 'chief', ['expert', 'infection'], '感染科（演示）'],
    ['Practitioner-1102', '王建明', 'Organization-dept-demo-6', 'chief', ['expert', 'infection'], '感染科（演示）'],
    ['Practitioner-9005', '赵敏', 'Organization-dept-demo-7', null, ['quality'], '医疗质量管理部（演示）']
  ];
  PRACT_PLACEMENT.forEach(function (p) {
    var exist = F.read('Practitioner', p[0]);
    if (exist) {
      exist.name = [{ text: p[1] }];
      exist.ext = Object.assign({}, exist.ext, { dept: p[5], title: p[3], roleType: p[4][0], active: true, demo: true });
      F.update(exist);
    } else {
      F.seed({ resourceType: 'Practitioner', id: p[0], name: [{ text: p[1] }],
        ext: { dept: p[5], title: p[3], roleType: p[4][0], active: true, demo: true } });
    }
    F.seed({
      resourceType: 'PractitionerRole', id: 'PractitionerRole-' + p[0].replace('Practitioner-', ''),
      active: true,
      practitioner: { reference: 'Practitioner/' + p[0], display: p[1] },
      organization: { reference: 'Organization/' + p[2] },
      code: p[4].map(function (c) {
        return { coding: [{ system: A.CANON + '/CodeSystem/amr-role', code: c, display: roleTitle(c) }], text: roleTitle(c) };
      }),
      period: { start: '2026-01-01' },
      ext: { roleType: p[4][0], roles: p[4], title: p[3] || '', orgId: p[2], orgName: p[5],
        canApprove: p[4].some(function (c) { return ['leader', 'pharmacy', 'expert', 'infection'].indexOf(c) >= 0; }) }
    });
  });

  /* 18.3 等级 / 用药目的 / 岗位角色字典（SRS §9.2 CodeSystem + ValueSet） */
  F.seed({ resourceType: 'CodeSystem', id: 'CodeSystem-amr-level',
    url: A.CANON + '/CodeSystem/amr-level', name: 'AntimicrobialGrade', title: '抗菌药物等级',
    status: 'active', experimental: false, content: 'complete',
    description: 'SRS §3.1 三级编码：non-restricted / restricted / special',
    concept: LV.LEVELS.map(function (l) { return { code: l.code, display: l.name, definition: l.desc }; }) });
  F.seed({ resourceType: 'ValueSet', id: 'ValueSet-amr-level',
    url: A.CANON + '/ValueSet/amr-level', name: 'AntimicrobialGradeVS', title: '抗菌药物等级值集',
    status: 'active', experimental: false,
    compose: { include: [{ system: A.CANON + '/CodeSystem/amr-level' }] } });
  F.seed({ resourceType: 'CodeSystem', id: 'CodeSystem-amr-purpose',
    url: A.CANON + '/CodeSystem/amr-purpose', name: 'AntimicrobialPurpose', title: '抗菌药物使用目的（演示字典）',
    status: 'active', experimental: false, content: 'complete',
    description: 'SRS FR-010.7：演示用途分类为可维护示例，不代表采购文件规定了具体用途字典',
    concept: LV.PURPOSES.map(function (p) { return { code: p.code, display: p.name, definition: p.desc }; }) });
  F.seed({ resourceType: 'ValueSet', id: 'ValueSet-amr-purpose',
    url: A.CANON + '/ValueSet/amr-purpose', name: 'AntimicrobialPurposeVS', title: '抗菌药物使用目的值集',
    status: 'active', experimental: false,
    compose: { include: [{ system: A.CANON + '/CodeSystem/amr-purpose' }] } });
  var ROLE_CODES = LV.APPROVAL_ROLES.map(function (r) { return r; })
    .concat([{ code: 'doctor', name: '医师' }, { code: 'admin', name: '系统管理员' },
             { code: 'ruleadmin', name: '规则管理员' }, { code: 'quality', name: '质控人员' }]);
  F.seed({ resourceType: 'CodeSystem', id: 'CodeSystem-amr-role',
    url: A.CANON + '/CodeSystem/amr-role', name: 'AmrPractitionerRole',
    title: '演示岗位角色（审批节点可按角色配置）',
    status: 'active', experimental: false, content: 'complete',
    concept: ROLE_CODES.map(function (r) { return { code: r.code, display: r.name }; }) });
  F.seed({ resourceType: 'ValueSet', id: 'ValueSet-amr-role',
    url: A.CANON + '/ValueSet/amr-role', name: 'AmrPractitionerRoleVS', title: '演示岗位角色值集',
    status: 'active', experimental: false,
    compose: { include: [{ system: A.CANON + '/CodeSystem/amr-role' }] } });

  /* 18.4 MedicationKnowledge：药品知识与等级分类（SRS §9.3）。
   * 目录内全部药品各建一条；其中三种作为 SRS §11.4 的演示用药 A/B/C。 */
  var SRS_DEMO_DRUGS = {
    '阿莫西林': { code: 'DEMO-AMR-A', grade: 'non-restricted', form: '胶囊' },
    '头孢呋辛': { code: 'DEMO-AMR-B', grade: 'restricted', form: '注射剂' },
    '美罗培南': { code: 'DEMO-AMR-C', grade: 'special', form: '注射剂' }
  };
  F.search('Medication').forEach(function (m, i) {
    var demo = SRS_DEMO_DRUGS[m.code.text];
    var form = demo ? demo.form : (m.ext.spec || '').indexOf('片') >= 0 ? '片剂'
      : (m.ext.spec || '').indexOf('胶囊') >= 0 ? '胶囊' : '注射剂';
    F.seed({
      resourceType: 'MedicationKnowledge', id: 'MedicationKnowledge-' + (i + 1),
      code: demo
        ? { coding: [{ system: A.CANON + '/CodeSystem/amr-demo-drug', code: demo.code, display: m.code.text }], text: m.code.text }
        : { text: m.code.text },
      status: 'active',
      synonym: [(m.ext.brand && m.ext.brand !== '—') ? m.ext.brand : m.code.text + '（演示）'],
      doseForm: { coding: [{ code: 'df-' + i, display: form }], text: form },
      amount: { description: { text: m.ext.spec || '—' } },
      associatedMedication: [{ reference: 'Medication/' + m.id, display: m.code.text }],
      medicineClassification: [{
        type: { coding: [{ system: 'http://who.int/Classification/atc', code: 'atc', display: 'ATC 分类' }], text: 'ATC 分类' },
        classification: { coding: [{ system: A.CANON + '/CodeSystem/amr-level', code: m.ext.level, display: LV.levelName(m.ext.level) }], text: m.ext.drugClass }
      }],
      ext: { level: m.ext.level, amrClass: m.ext.drugClass, demoCode: demo ? demo.code : '', demo: !!demo }
    });
    if (demo) {
      m.ext.drugCode = demo.code;
      m.ext.demoMark = '演示用药 ' + demo.code.slice(-1);
      m.ext.doseFormCode = form;
      F.update(m);
    }
  });

  /* 18.5 患者与就诊（SRS §11.3） */
  function encounter(id, patient, kind, practId, chief, bed, start, end) {
    var cls = { outpatient: ['AMB', '门诊'], inpatient: ['IMP', '住院'], emergency: ['EMER', '急诊'] }[kind];
    F.seed({
      resourceType: 'Encounter', id: id, status: end ? 'finished' : 'in-progress',
      class: { coding: [{ system: 'http://terminology.hl7.org/CodeSystem/v3-ActCode', code: cls[0], display: cls[1] }], text: cls[1] },
      type: [{ coding: [{ code: kind, display: cls[1] }], text: cls[1] }],
      subject: { reference: 'Patient/' + patient },
      participant: [{ type: [{ coding: [{ code: 'LI', display: '主管医师' }] }], individual: { reference: 'Practitioner/' + practId } }],
      period: end ? { start: start, end: end } : { start: start },
      reasonCode: [{ text: chief }],
      ext: { visitNo: id.replace('Encounter-', 'V'), kind: kind, kindName: cls[1], bed: bed || '', chief: chief, demo: true }
    });
  }
  encounter('Encounter-1', 'Patient-1', 'outpatient', 'Practitioner-9003', '社区获得性肺炎，痰培养待回报', '', '2026-06-15T08:30:00', '');
  encounter('Encounter-2', 'Patient-2', 'inpatient', 'Practitioner-1001', '腹腔感染，脓肿引流术后', 'A-1203', '2026-06-12T10:00:00', '');
  encounter('Encounter-3', 'Patient-3', 'emergency', 'Practitioner-1004', '脓毒症休克，血培养阳性', 'E-01', '2026-06-14T22:10:00', '');
  encounter('Encounter-4', 'Patient-6', 'inpatient', 'Practitioner-1004', '重症肺炎，呼吸衰竭', 'ICU-07', '2026-06-14T09:00:00', '');
  encounter('Encounter-5', 'Patient-4', 'inpatient', 'Practitioner-9003', '皮肤软组织感染，MRSA 阳性', 'B-0312', '2026-05-28T14:00:00', '');
  encounter('Encounter-6', 'Patient-5', 'outpatient', 'Practitioner-1002', '尿路感染', '', '2026-05-20T09:00:00', '');

  /* 18.6 三层授权：职称规则（第 7 节）+ 科室授权 + 个人授权 + 合并优先级 */
  function deptPerm(orgId, levels, note) {
    var o = F.read('Organization', orgId);
    F.seed({ resourceType: 'Permission', id: 'Permission-dept-' + orgId, status: 'active',
      ext: { category: 'authorization', subjectType: 'department', level: '',
        subjectRef: 'Organization/' + orgId, deptName: o ? o.name : orgId,
        levels: levels, grantLabel: '科室授权', note: note, source: o ? o.name : orgId,
        before: null, after: levels.map(LV.levelName).join('、') } });
  }
  function personPerm(practId, levels, grantLabel, expires, note) {
    var p = F.read('Practitioner', practId);
    F.seed({ resourceType: 'Permission', id: 'Permission-person-' + practId, status: 'active',
      ext: { category: 'authorization', subjectType: 'person', level: '',
        subjectRef: 'Practitioner/' + practId, practitionerName: p ? p.name[0].text : practId,
        levels: levels, grantLabel: grantLabel, expires: expires || '', note: note,
        source: p ? p.name[0].text : practId, before: null, after: levels.map(LV.levelName).join('、') } });
  }
  deptPerm('Organization-dept-demo-1', ['non-restricted', 'restricted'], '呼吸内科科室级授权：不含特殊使用级');
  deptPerm('Organization-dept-demo-2', ['non-restricted', 'restricted', 'special'], '普通外科科室级授权：含特殊使用级（演示配置）');
  deptPerm('Organization-dept-demo-3', ['non-restricted', 'restricted'], '重症医学科科室级授权：特殊使用级须审批');
  deptPerm('Organization-dept-demo-6', ['non-restricted', 'restricted', 'special'], '感染科科室级授权：可承担特殊使用级审批');
  personPerm('Practitioner-1004', ['non-restricted', 'restricted', 'special'], '重症感染专项特批（演示）', '2027-12-31',
    '演示「个人授权」层：特批有效期内可直接开立特殊使用级');

  /* 18.7 审批流程：版本化 PlanDefinition，全部经引擎发布为 V1 */
  function publishFlow(purpose, level, title, nodes) {
    var pd = A.newDraft({ purpose: purpose, level: level, title: title, nodes: nodes });
    return A.publish(pd.id, { operator: '规则管理员·王素芬（演示初始化）', note: '演示初始流程' });
  }
  publishFlow('tier-approval', 'non-restricted', '非限制使用审批流程',
    [A.mkNode(1, '药学部门备案', 'role', ['pharmacy'], { deadlineHours: 24 })]);
  publishFlow('tier-approval', 'restricted', '限制使用审批流程',
    [A.mkNode(1, '科室负责人审核', 'auto', [], { deadlineHours: 24, nodeCode: 'leader' }),
     A.mkNode(2, '药学部门审核', 'role', ['pharmacy'], { deadlineHours: 48 })]);
  publishFlow('tier-approval', 'special', '特殊使用审批流程',
    [A.mkNode(1, '科室负责人审核', 'auto', [], { deadlineHours: 24, nodeCode: 'leader' }),
     A.mkNode(2, '药学部门审核', 'role', ['pharmacy'], { deadlineHours: 48, actions: ['approve', 'reject', 'return'] }),
     A.mkNode(3, '审批专家终审', 'role', ['expert'], { deadlineHours: 72, actions: ['approve', 'reject', 'return'] })]);
  publishFlow('emergency-review', '', '紧急越级补审核流程',
    [A.mkNode(1, '科室负责人补审核', 'auto', [], { isPostReview: true, deadlineHours: 24, nodeCode: 'leader',
      description: 'SRS FR-008：紧急临时越级使用后 24 小时内补审核；节点与审批对象由流程配置确定' })]);
  publishFlow('rx-permission', 'restricted', '限制使用级处方权限申请流程',
    [A.mkNode(1, '科室负责人审核', 'auto', [], { deadlineHours: 24, nodeCode: 'leader' }),
     A.mkNode(2, '药学部门审核', 'role', ['pharmacy'], { deadlineHours: 48 })]);
  publishFlow('rx-permission', 'special', '特殊使用级处方权限申请流程',
    [A.mkNode(1, '科室负责人审核', 'auto', [], { deadlineHours: 24, nodeCode: 'leader' }),
     A.mkNode(2, '药学部门审核', 'role', ['pharmacy'], { deadlineHours: 48 }),
     A.mkNode(3, '审批专家终审', 'role', ['expert'], { deadlineHours: 72 })]);
  // DEMO-08 要「拖选新增人员/科室/角色节点并发布 V2」，这里留一份未发布草稿作为起点
  A.newDraft({ purpose: 'tier-approval', level: 'special', title: '特殊使用审批流程（待扩展）',
    fromId: A.currentVersion('tier-approval', 'special').id });

  /* 18.8 经引擎生成的审批实例
   * 演示口径：王伟（呼吸内科·主治）与李娜（呼吸内科·主治）对特殊使用级权限不足，
   * 走审批流程；刘洋（ICU·副主任医师）持个人特批，可直接开立（DEMO-05）。 */
  function seededOrder(practId, medId, opts) {
    var med = F.read('Medication', medId);
    var chk = A.check({ practitioner: practId, medicationId: medId });
    var mr = A.createMedicationRequest({
      medicationId: medId, requesterPractId: practId, patientId: opts.patient, encounterId: opts.encounter,
      patientName: opts.patientName, mrn: opts.mrn, diagnosis: opts.diagnosis,
      purposeCode: opts.purposeCode, purposeNote: opts.purposeNote, dosageText: med.ext.usage,
      applicationReason: opts.reason, check: chk, orderStatus: 'pending-approval'
    });
    var inst = A.createInstance({ mr: mr, purpose: 'tier-approval', requesterPractId: practId,
      applicationReason: opts.reason, check: chk });
    return { mr: mr, chk: chk, inst: inst };
  }

  // —— 实例①：特殊使用级，三个节点全部通过（供 DEMO-15 关联核查） ——
  var s1 = seededOrder('Practitioner-9003', 'Medication-21', {
    patient: 'Patient-1', encounter: 'Encounter-1', patientName: '陈秀英', mrn: 'ZY20260615001',
    diagnosis: '肺炎', purposeCode: 'mdr', purposeNote: '痰培养 ESBLs 阳性，经验治疗无效',
    reason: '患者 ESBLs 阳性，重症社区获得性肺炎，常规抗菌治疗无效，依据药敏申请美罗培南'
  });
  A.act({ taskId: s1.inst.id, action: 'approve', operatorPractId: 'Practitioner-1201', comment: '同意，感染指标持续升高' });
  A.act({ taskId: s1.inst.id, action: 'approve', operatorPractId: 'Practitioner-9002', comment: '符合特殊使用级用药指征' });
  A.act({ taskId: s1.inst.id, action: 'approve', operatorPractId: 'Practitioner-9004', comment: '同意使用，7 天后评估降阶梯' });

  // —— 实例②：停在药学部门节点（供 DEMO-10 开场即有待办） ——
  var s2 = seededOrder('Practitioner-1002', 'Medication-27', {
    patient: 'Patient-6', encounter: 'Encounter-4', patientName: '孙建国', mrn: 'ZY20260614005',
    diagnosis: '重症肺炎', purposeCode: 'severe', purposeNote: '呼吸衰竭，痰培养多重耐药鲍曼不动杆菌',
    reason: '重症肺炎伴呼吸衰竭，痰培养多重耐药鲍曼不动杆菌，申请替加环素'
  });
  A.act({ taskId: s2.inst.id, action: 'approve', operatorPractId: 'Practitioner-1201', comment: '病情危重，同意上报' });

  // —— 实例③：被驳回（保留驳回原因，供 FR-007.8「修改后重新提交」） ——
  var s3 = seededOrder('Practitioner-9003', 'Medication-22', {
    patient: 'Patient-3', encounter: 'Encounter-3', patientName: '李秀兰', mrn: 'ZY20260608015',
    diagnosis: '脓毒症', purposeCode: 'empirical', purposeNote: '血培养阳性，疑似产 ESBLs 菌',
    reason: '脓毒症疑似产 ESBLs 菌，申请亚胺培南西司他丁'
  });
  A.act({ taskId: s3.inst.id, action: 'approve', operatorPractId: 'Practitioner-1201', comment: '同意上报' });
  A.act({ taskId: s3.inst.id, action: 'reject', operatorPractId: 'Practitioner-9002',
    comment: '缺少药敏报告，建议先完善病原学检查；当前可先用哌拉西林他唑巴坦覆盖' });

  // —— 实例④：退回补充（演示节点配置的第三种动作） ——
  var s4 = seededOrder('Practitioner-1002', 'Medication-21', {
    patient: 'Patient-5', encounter: 'Encounter-6', patientName: '周丽', mrn: 'ZY20260520031',
    diagnosis: '尿路感染', purposeCode: 'empirical', purposeNote: '尿培养大肠埃希菌，药敏待回报',
    reason: '复杂尿路感染，经验性治疗效果不佳'
  });
  A.act({ taskId: s4.inst.id, action: 'approve', operatorPractId: 'Practitioner-1201', comment: '同意' });
  A.act({ taskId: s4.inst.id, action: 'return', operatorPractId: 'Practitioner-9002', comment: '请补充近期尿培养与药敏结果' });

  // —— 实例⑤：紧急越级临时使用 + 24 小时补审核（供 DEMO-12） ——
  var em = A.createEmergency({
    requesterPractId: 'Practitioner-9003', medicationId: 'Medication-24',
    patientId: 'Patient-4', encounterId: 'Encounter-5', patientName: '赵德胜', mrn: 'ZY20260528022',
    diagnosis: '皮肤软组织感染', purposeCode: 'mdr', purposeNote: '创面 MRSA 阳性',
    dosageText: '静脉滴注，1g/次，每12小时',
    emergencyReason: '患者感染性休克早期，创面培养 MRSA 阳性，情况紧急来不及完成事前审批',
    clinicalNote: '已留取血培养 2 套与创面分泌物培养，按体重负荷给药，拟 48 小时后依据药敏调整',
    applicationReason: '紧急越级使用万古霉素'
  });
  A.submitPostReviewMaterials(em.mainTask.id, {
    病原学送检: '血培养 2 套 + 创面分泌物培养（已采集）',
    用药前评估: 'GCS 13，MAP 62 mmHg，乳酸 4.1 mmol/L',
    临床说明: '万古霉素 1g q12h 负荷给药，拟行血药浓度监测'
  });

  /* 18.9 演示配置单例 */
  F.seed({ resourceType: 'Basic', id: 'Basic-demo-clock', code: { text: 'demo-clock' },
    ext: { mode: 'live', offsetMinutes: 0, frozenAt: '', setBy: '演示初始化', setAt: '' } });
  F.seed({ resourceType: 'Basic', id: 'Basic-authz-merge-priority', code: { text: 'authz-merge-priority' },
    ext: { order: ['person', 'department', 'title'], emptyMeans: 'deny',
      label: '个人授权 ＞ 科室授权 ＞ 职称规则（按顺序取第一个已配置且非空的层生效）',
      note: 'SRS BR-002：采购文件未定义多条规则冲突时的优先级，故作为演示配置项并在界面展示命中层' } });
  F.seed({ resourceType: 'Basic', id: 'Basic-emergency-config', code: { text: 'emergency-config' },
    ext: { hours: 24, nearHours: 4, purpose: 'emergency-review',
      note: 'SRS FR-008.4/FR-023.3：补审核期限与临近提醒阈值，可按医院制度调整' } });

  console.log('[seed] FHIR 内存库初始化完成：',
    Object.keys(F.dump()).map(function (t) { return t + '×' + F.count(t); }).join('  '));

})(window);
