/* =====================================================================
 * fhir-profiles.js —— 自定义扩展与 Profile 的 StructureDefinition 定义
 * ---------------------------------------------------------------------
 * 以标准 FHIR StructureDefinition 资源「正式声明」本系统对 FHIR 的扩展与
 * 自定义，使扩展可被发现、校验与复用（对 FHIR 进行扩展/自定义的规范做法）。
 * 这些定义本身是合规的 FHIR 资源，存入内存库，可在「FHIR 资源查看器」查看。
 * ===================================================================== */
(function (global) {
  'use strict';
  var F = global.FHIR, BASE = global.FHIRExt.BASE;
  // SRS §9 给出的「建议」canonical 基址；本实现统一挂在 BASE 下（见 extDef 说明）
  var SRS_BASE = 'https://demo.example.org/fhir/StructureDefinition/';

  // 扩展定义（Extension StructureDefinition）
  function extDef(id, name, context, type, isModifier, title, valueType, srsAlias) {
    return F.seed({
      resourceType: 'StructureDefinition',
      id: id,
      url: BASE + id,
      name: name,
      title: title,
      status: 'active',
      kind: 'complex-type',
      abstract: false,
      type: 'Extension',
      context: [{ type: 'element', expression: context }],
      description: srsAlias
        ? 'SRS §9 建议地址：' + SRS_BASE + srsAlias + '；本实现 canonical：' + BASE + id
        : '本系统自定义扩展，canonical ' + BASE + id,
      differential: {
        element: [
          { id: 'Extension', path: 'Extension', isModifier: !!isModifier,
            short: title, comment: isModifier ? '修饰性扩展：影响资源含义/处理方式' : '附加扩展' },
          { id: 'Extension.url', path: 'Extension.url', fixedUri: BASE + id },
          { id: 'Extension.value[x]', path: 'Extension.value[x]', type: [{ code: valueType }] }
        ]
      }
    });
  }

  // —— Medication（抗菌药物分级目录）自定义扩展 ——
  extDef('Medication-level', 'amrMedicationLevel', 'Medication', 'code', true,
    '抗菌药物分级（非限制/限制/特殊使用级）', 'code');
  extDef('Medication-drugClass', 'amrMedicationDrugClass', 'Medication', 'string', false, '药品分类', 'string');
  extDef('Medication-allowedTitles', 'amrMedicationAllowedTitles', 'Medication', 'code', true,
    '可开具职称（修饰处方权限）', 'code');
  extDef('Medication-approvals', 'amrMedicationApprovals', 'Medication', 'code', true,
    '审批要求节点（修饰处方权限）', 'code');
  extDef('Medication-spec', 'amrMedicationSpec', 'Medication', 'string', false, '规格', 'string');
  extDef('Medication-manufacturer', 'amrMedicationManufacturer', 'Medication', 'string', false, '生产企业', 'string');

  // —— Task（处方权限申请/审批流转）自定义扩展 ——
  extDef('Task-type', 'amrApplicationType', 'Task', 'code', true,
    '申请分级类型（限制/特殊使用级，修饰审批路径）', 'code');
  extDef('Task-flow', 'amrApprovalFlow', 'Task', 'string', false,
    '审批流程节点（复杂结构，valueString 承载 JSON）', 'string');
  extDef('Task-decision', 'amrApprovalDecision', 'Task', 'string', false,
    '审批决定（valueString 承载 JSON）', 'string');

  // —— 权限映射 / 卡控规则（R4 无 Permission 类型，落到 Basic）自定义扩展 ——
  extDef('Permission-level', 'amrPermissionLevel', 'Basic', 'code', false, '适用分级', 'code');
  extDef('Permission-interceptOnTitleMismatch', 'amrInterceptTitle', 'Basic', 'code', true,
    '职称不匹配拦截动作（修饰卡控行为）', 'code');
  extDef('Permission-interceptOnNotApproved', 'amrInterceptApproval', 'Basic', 'code', true,
    '审批未通过拦截动作（修饰卡控行为）', 'code');

  // —— PlanDefinition（审批流程定义）节点配置扩展在下方 SRS 区块统一声明 ——

  // —— Profile：抗菌药物分级目录（在 Medication 上的约束） ——
  F.seed({
    resourceType: 'StructureDefinition',
    id: 'amr-medication',
    url: BASE + 'amr-medication',
    name: 'AmrMedication',
    title: '抗菌药物分级目录 Profile（Medication）',
    status: 'active',
    kind: 'resource',
    abstract: false,
    type: 'Medication',
    baseDefinition: 'http://hl7.org/fhir/StructureDefinition/Medication',
    derivation: 'constraint',
    differential: {
      element: [
        { id: 'Medication.extension:level', path: 'Medication.extension', sliceName: 'level',
          min: 1, max: '1', type: [{ code: 'Extension', profile: [BASE + 'Medication-level'] }] },
        { id: 'Medication.modifierExtension:level', path: 'Medication.modifierExtension', sliceName: 'level',
          short: '分级为修饰性扩展，影响处方权限与卡控判定' }
      ]
    }
  });

  /* ---------------- SRS §9 要求的扩展（正式声明） ----------------
   * SRS 用词为「建议 Extension」并给出 https://demo.example.org/fhir/… 形式的
   * 地址；本实现统一挂在既有 canonical 基址下（扩展的编解码按前缀过滤，换基址
   * 会让已写入服务端的资源读不回扩展），并把 SRS 地址记入 description 以便追溯。 */

  // —— 抗菌药物等级（CodeSystem/ValueSet + 药品知识） ——
  extDef('MedicationKnowledge-level', 'amrKnowledgeLevel', 'MedicationKnowledge', 'code', true,
    '抗菌药物等级（开单时的生效等级）', 'code', 'antimicrobial-grade');
  extDef('MedicationKnowledge-amrClass', 'amrKnowledgeClass', 'MedicationKnowledge', 'string', false, '药品分类', 'string');

  // —— 医师授权三层规则 ——
  extDef('Permission-subjectType', 'amrAuthzSubjectType', 'Basic', 'code', false,
    '授权对象类型（职称 / 科室 / 个人）', 'code', 'authorization-subject-type');
  extDef('Permission-levels', 'amrAuthzLevel', 'Basic', 'code', false,
    '该条规则授予的抗菌药物等级集合', 'code', 'antimicrobial-authorization-level');
  extDef('Permission-source', 'amrAuthzSource', 'Basic', 'string', false,
    '授权来源（被授权的 Practitioner / PractitionerRole / Organization）', 'string', 'authorization-source');
  extDef('Permission-grantLabel', 'amrAuthzGrantLabel', 'Basic', 'string', false, '授权名称/批注', 'string');
  extDef('Permission-expires', 'amrAuthzExpires', 'Basic', 'string', false, '授权到期日', 'string');
  extDef('Permission-before', 'amrAuthzBefore', 'Basic', 'string', false, '变更前内容', 'string');
  extDef('Permission-after', 'amrAuthzAfter', 'Basic', 'string', false, '变更后内容', 'string');

  // —— 用药目的与开单快照 ——
  extDef('MedicationRequest-purpose', 'amrRequestPurpose', 'MedicationRequest', 'string', false,
    '抗菌药物使用目的（分类 + 补充说明）', 'string', 'antimicrobial-purpose');
  extDef('MedicationRequest-purposeCodes', 'amrRequestPurposeCodes', 'MedicationRequest', 'code', false,
    '用药目的编码（可从 ValueSet 检索）', 'code', 'antimicrobial-purpose');
  extDef('MedicationRequest-gradeSnapshot', 'amrRequestGradeSnapshot', 'MedicationRequest', 'string', false,
    '开单时使用的药品等级快照（后续调整等级不影响本单）', 'string', 'antimicrobial-grade-snapshot');
  extDef('MedicationRequest-emergency', 'amrRequestEmergency', 'MedicationRequest', 'boolean', true,
    '紧急临时越级使用标识', 'boolean', 'emergency-overridden');
  extDef('MedicationRequest-emergencyReason', 'amrRequestEmergencyReason', 'MedicationRequest', 'string', false,
    '紧急使用原因及临床说明', 'string', 'emergency-overridden-reason');
  extDef('MedicationRequest-authzHit', 'amrRequestAuthzHit', 'MedicationRequest', 'string', false,
    '权限判定命中的规则来源（可追溯）', 'string');
  extDef('MedicationRequest-orderStatus', 'amrRequestOrderStatus', 'MedicationRequest', 'code', true,
    '医嘱业务状态（草稿/待审批/可提交临床系统等）', 'code');

  // —— 审批流程定义与节点 ——
  extDef('PlanDefinition-purpose', 'amrWorkflowPurpose', 'PlanDefinition', 'code', true,
    '流程用途（普通分级审批 / 紧急补审核 / 处方权限申请），二者流程标识必须不同', 'code', 'approval-workflow-purpose');
  extDef('PlanDefinition-purposeKey', 'amrWorkflowKey', 'PlanDefinition', 'string', false, '流程业务键', 'string');
  extDef('PlanDefinition-level', 'amrWorkflowLevel', 'PlanDefinition', 'code', false, '适用抗菌药物等级', 'code');
  extDef('PlanDefinition-nodes', 'amrWorkflowNodesJson', 'PlanDefinition', 'string', false,
    '审核节点配置（节点编码、展示顺序、审批对象类型与引用、允许动作、是否补审核、说明）', 'string', 'approval-node-order');
  extDef('PlanDefinition-rollbackFrom', 'amrWorkflowRollbackFrom', 'PlanDefinition', 'string', false,
    '回退恢复来源版本（FR-019.5）', 'string');
  extDef('PlanDefinition-publishInfo', 'amrWorkflowPublishInfo', 'PlanDefinition', 'string', false,
    '发布信息（版本号、生效时间、发布人）', 'string');
  extDef('Task-approvalNodeType', 'amrTaskNodeType', 'Task', 'code', false,
    '节点类型与审批对象类型', 'code', 'approval-node-type');
  extDef('Task-assignees', 'amrTaskAssignees', 'Task', 'string', false,
    '本节点解析出的审批对象及其分配依据', 'string', 'approval-assignee-reference');
  extDef('Task-assigneeIds', 'amrTaskAssigneeIds', 'Task', 'code', false, '本节点审批对象的人员 id 集合', 'code');
  extDef('Task-flowStatus', 'amrTaskFlowStatus', 'Task', 'code', true, '流程实例业务状态', 'code');
  extDef('Task-isPostReview', 'amrTaskIsPostReview', 'Task', 'boolean', true, '是否紧急越级补审核节点', 'boolean');

  // —— 通知与留痕 ——
  extDef('Communication-linkTask', 'amrCommLinkTask', 'Communication', 'string', false,
    '消息跳转到的审批实例（FR-023.5）', 'string');
  extDef('Communication-linkRoute', 'amrCommLinkRoute', 'Communication', 'string', false, '消息跳转页面', 'string');
  extDef('Communication-targetPract', 'amrCommTargetPract', 'Communication', 'string', false, '接收人', 'string');

  // —— Profile：抗菌药物开单（MedicationRequest）约束 ——
  F.seed({
    resourceType: 'StructureDefinition',
    id: 'amr-medication-request',
    url: BASE + 'amr-medication-request',
    name: 'AmrMedicationRequest',
    title: '抗菌药物开单 Profile（MedicationRequest）',
    status: 'active', kind: 'resource', abstract: false, type: 'MedicationRequest',
    baseDefinition: 'http://hl7.org/fhir/StructureDefinition/MedicationRequest',
    derivation: 'constraint',
    description: 'intent 固定为 order；medicationReference/subject/requester 必填；'
      + '抗菌药物等级快照与用药目的以扩展承载，等级调整不影响已提交单据。',
    differential: {
      element: [
        { id: 'MedicationRequest.intent', path: 'MedicationRequest.intent', min: 1, max: '1', fixedCode: 'order' },
        { id: 'MedicationRequest.extension:purpose', path: 'MedicationRequest.extension', sliceName: 'purpose',
          min: 0, max: '1', type: [{ code: 'Extension', profile: [BASE + 'MedicationRequest-purpose'] }] },
        { id: 'MedicationRequest.extension:gradeSnapshot', path: 'MedicationRequest.extension', sliceName: 'gradeSnapshot',
          min: 0, max: '1', type: [{ code: 'Extension', profile: [BASE + 'MedicationRequest-gradeSnapshot'] }] },
        { id: 'MedicationRequest.modifierExtension:emergency', path: 'MedicationRequest.modifierExtension',
          sliceName: 'emergency', min: 0, max: '1',
          type: [{ code: 'Extension', profile: [BASE + 'MedicationRequest-emergency'] }] }
      ]
    }
  });

  // —— Profile：审批流程定义（PlanDefinition）约束 ——
  F.seed({
    resourceType: 'StructureDefinition',
    id: 'amr-approval-workflow',
    url: BASE + 'amr-approval-workflow',
    name: 'AmrApprovalWorkflow',
    title: '抗菌药物审批流程定义 Profile（PlanDefinition）',
    status: 'active', kind: 'resource', abstract: false, type: 'PlanDefinition',
    baseDefinition: 'http://hl7.org/fhir/StructureDefinition/PlanDefinition',
    derivation: 'constraint',
    description: '一个业务版本一条资源：同一 url、version 递增；status 用 draft/active/retired；'
      + '发布与回退都产生新资源，历史版本不得覆盖或删除。',
    differential: {
      element: [
        { id: 'PlanDefinition.extension:purpose', path: 'PlanDefinition.extension', sliceName: 'purpose',
          min: 1, max: '1', type: [{ code: 'Extension', profile: [BASE + 'PlanDefinition-purpose'] }] },
        { id: 'PlanDefinition.extension:nodes', path: 'PlanDefinition.extension', sliceName: 'nodes',
          min: 1, max: '1', type: [{ code: 'Extension', profile: [BASE + 'PlanDefinition-nodes'] }] },
        { id: 'PlanDefinition.action', path: 'PlanDefinition.action', min: 1, max: '*',
          short: '流程节点的标准投影，与扩展中的节点配置一一对应' }
      ]
    }
  });

  // —— Profile：审批任务（Task）主/节点约束 ——
  F.seed({
    resourceType: 'StructureDefinition',
    id: 'amr-approval-task',
    url: BASE + 'amr-approval-task',
    name: 'AmrApprovalTask',
    title: '抗菌药物审批任务 Profile（Task）',
    status: 'active', kind: 'resource', abstract: false, type: 'Task',
    baseDefinition: 'http://hl7.org/fhir/StructureDefinition/Task',
    derivation: 'constraint',
    description: '流程实例＝主 Task（instantiatesCanonical 绑定发布版本，focus 指向 MedicationRequest）；'
      + '审核节点＝节点 Task（partOf 指向主 Task）。紧急补审核在 restriction.period 记录 24 小时期限。',
    differential: {
      element: [
        { id: 'Task.intent', path: 'Task.intent', min: 1, max: '1', fixedCode: 'order' },
        { id: 'Task.partOf', path: 'Task.partOf', min: 0, max: '*', short: '节点任务指向流程主任务' },
        { id: 'Task.restriction', path: 'Task.restriction', min: 0, max: '1',
          short: '补审核期限（适用时）：start=发起时间，end=+24h' }
      ]
    }
  });

  // —— 自定义资源说明：以 Basic 承载系统配置单例（FHIR 推荐的自定义资源方式） ——
  F.seed({
    resourceType: 'StructureDefinition',
    id: 'amr-config',
    url: BASE + 'amr-config',
    name: 'AmrConfig',
    title: '系统配置自定义资源（基于 Basic）',
    status: 'active',
    kind: 'resource',
    abstract: false,
    type: 'Basic',
    baseDefinition: 'http://hl7.org/fhir/StructureDefinition/Basic',
    derivation: 'constraint',
    differential: {
      element: [
        { id: 'Basic.code', path: 'Basic.code', min: 1, max: '1',
          short: '配置类型：catalog-version / kb-version / gatekeep-status / sync-params / title-change-rules / notify-config' }
      ]
    }
  });

  // —— R4 适配层使用的扩展 ——
  extDef('business-status-connStatus', 'amrEndpointConnStatus', 'Endpoint', 'code', false,
    '外部系统连接状态（业务词表：active/error/off；Endpoint.status 只承载 R4 合法码）', 'code');
  extDef('business-status-issueStatus', 'amrDetectedIssueStatus', 'DetectedIssue', 'code', false,
    '预警处理状态（业务词表；DetectedIssue.status 只承载 R4 合法码）', 'code');

  /* R4 没有 Permission / Citation / ClinicalUseDefinition 类型，本系统按 FHIR
   * 对自定义概念的规范做法把它们落到 Basic：原始元素搬进 source-element-* 扩展，
   * 原始类型记在 meta.tag（system=…/amr-source-resource-type），读回时还原。
   * 下列 StructureDefinition 把这一约定正式声明出来，保证可被发现与校验。 */
  function basicProfile(srcType, name, title) {
    var classCode = global.FHIRR4.BASIC_CLASS[srcType];
    F.seed({
      resourceType: 'StructureDefinition',
      id: classCode,
      url: BASE + classCode,
      name: name,
      title: title,
      status: 'active',
      kind: 'resource',
      abstract: false,
      type: 'Basic',
      baseDefinition: 'http://hl7.org/fhir/StructureDefinition/Basic',
      derivation: 'constraint',
      description: 'R4 无 ' + srcType + ' 类型，以 Basic 承载；meta.tag 标记原始类型 '
        + srcType + '，其非 Basic 元素搬入 extension[' + BASE + 'source-element-*]。',
      differential: {
        element: [
          { id: 'Basic.code', path: 'Basic.code', min: 1, max: '1',
            fixedCodeableConcept: { coding: [{ system: BASE + 'basic-class', code: classCode }] },
            short: '标识该 Basic 承载的自定义概念（' + srcType + '）' },
          { id: 'Basic.which', path: 'Basic.which', min: 0, max: '1',
            short: '归属组织；引用目标不存在时省略，避免服务端引用校验拒绝整单写入' }
        ]
      }
    });
  }
  basicProfile('Permission', 'AmrPermissionRule', '权限映射/卡控规则（Basic 承载）');
  basicProfile('Citation', 'AmrCitation', '参考依据（Basic 承载）');
  basicProfile('ClinicalUseDefinition', 'AmrIndication', '适应症知识库条目（Basic 承载）');

})(window);
