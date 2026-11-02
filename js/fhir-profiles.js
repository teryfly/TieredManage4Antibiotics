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

  // 扩展定义（Extension StructureDefinition）
  function extDef(id, name, context, type, isModifier, title, valueType) {
    F.seed({
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

  // —— PlanDefinition（审批流程定义）自定义扩展 ——
  extDef('PlanDefinition-nodes', 'amrWorkflowNodes', 'PlanDefinition', 'string', false,
    '审批流程节点配置（valueString 承载 JSON）', 'string');

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
