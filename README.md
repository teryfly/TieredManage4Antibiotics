# 抗菌药物分级管理制度闭环管理系统 · 仿真原型

依据 `ux-design.docx` 的用户故事、用户旅程、信息架构图与低保真线框图实现的**可演示前端原型**。
全部数据基于 **FHIR 标准资源**在浏览器内存（缓存）中模拟 **增删改查（CRUD）**，并预置了一套**符合业务逻辑的初始化基础数据**。面向客户演示时，可通过顶部的**演示角色切换**一键切换 5 种角色，走通全部业务流程。

## 一、如何运行

本原型为纯静态前端，**无需构建、无需联网**（Vue 已本地化在 `lib/`）。

方式 A（推荐，避免浏览器对本地文件的限制）：

```bash
cd KJYWFJ
python3 -m http.server 8137
# 浏览器打开 http://localhost:8137
```

方式 B：直接用浏览器打开 `index.html` 亦可（已全部使用经典脚本，无 ES Module 跨域限制）。

## 二、演示角色切换

页面顶部黄色条「🎭 演示角色切换」可在以下角色间即时切换，导航、首页内容、页面可见性、操作权限随之变化：

| 角色 | 可见模块 | 演示要点 |
|---|---|---|
| 系统管理员 | 目录综合管理、系统管理 | 目录维护、权限映射、卡控规则、审批流程、系统参数 |
| 药学部门 | 目录综合管理、监测分析 | 目录/适应症维护（不可删除药品）、监测（无预警/手术监测）|
| 医师 | 处方权限管理 | 提交限制/特殊使用级处方权申请 |
| 审批专家 | 处方权限管理 | 审批特殊使用级申请（通过/驳回）|
| 医疗质量管理部门 | 监测分析 | 监测概览、统计报表 |

## 三、推荐演示主流程（闭环）

1. 切换为 **医师** → 进入「处方权限申请」→「+ 新建申请」→ 选择「特殊使用级」→ 选药品（如美罗培南）→ 填写患者信息 → 提交。
   - 系统模拟科室负责人、药学部门节点自动通过，流转至审批专家节点。
2. 切换为 **审批专家** → 「处方权限审批」→ 待审批列表出现该申请 → 点击「审批」→ 查阅适应症校验 → 通过/驳回。
3. 切换回 **医师** → 「处方权限申请」可见该申请状态已更新（已通过/已驳回）。
4. 切换为 **系统管理员** → 「分级目录管理」新增/编辑药品（目录版本自动递增）→「权限映射配置」调整规则（卡控规则联动）→「权限卡控规则」用「规则测试」验证拦截效果。
5. 切换为 **医疗质量管理部门** → 「监测概览 / 统计报表」查看 DDD、送检率、特殊使用占比、预警与多维报表。

## 四、技术与架构

- **框架**：Vue 3（全局构建，本地 `lib/vue.global.prod.js`），Options API，零构建。
- **数据层（FHIR）**：`js/fhir-store.js` 实现类 FHIR RESTful 的内存资源库（`create/read/update/delete/search/bundle`）。
- **种子数据**：`js/seed.js` 以 FHIR 资源编造业务一致的初始化数据。
- **服务层**：`js/services.js` 在 FHIR CRUD 之上封装业务操作与跨资源联动（如目录变更→版本递增、映射变更→卡控同步、提交申请→生成 Task 与通知）。

### FHIR 扩展与自定义（重要）

基础 FHIR 资源无法表达的业务数据，**严格按 FHIR 规范通过扩展机制承载**，而非塞入非标准字段：

- **`extension`**：为资源补充的附加数据（不改变资源原义），如药品规格、生产企业、药品分类。
- **`modifierExtension`**：会改变资源含义/处理方式的数据 —— 抗菌药物**分级(level)**、**可开具职称**、**审批要求**、申请**类型**、卡控**拦截动作**等均归入此类（典型的 modifier 场景）。
- **`StructureDefinition`**：以正式的 FHIR 资源**声明**每一个自定义扩展（canonical url、context、value 类型、是否 modifier）及 Profile（如「抗菌药物分级目录 Profile」约束 Medication）。
- **`Basic` + StructureDefinition**：FHIR 推荐的「自定义资源」方式，承载系统配置等无对应资源的概念。
- **复杂嵌套结构**（审批流程节点、报表数据集等）无对应 FHIR 元素时，以 `valueString` 承载 JSON，并在 Profile 注册表中显式声明。

实现位于 `js/fhir-ext.js`（编解码 + Profile 注册表）与 `js/fhir-profiles.js`（StructureDefinition 定义）。内存库内部存储的是**纯 FHIR 资源**（仅含 `extension`/`modifierExtension`），读取时再投影出开发友好的访问对象，写入时编码回标准扩展。

> **可视化验证**：顶部演示条右侧「🔍 FHIR 资源」可打开**FHIR 资源查看器**，实时查看任意资源的规范化原文（含 extension/modifierExtension 与 canonical url），向客户直观证明数据的 FHIR 合规性。

示例（美罗培南 Medication 的分级，作为 modifierExtension）：

```json
"modifierExtension": [
  { "url": "https://fhir.amr-demo.example/StructureDefinition/Medication-level", "valueCode": "special" },
  { "url": "https://fhir.amr-demo.example/StructureDefinition/Medication-allowedTitles", "valueCode": "chief" },
  { "url": "https://fhir.amr-demo.example/StructureDefinition/Medication-allowedTitles", "valueCode": "associate" }
]
```

### FHIR 资源映射

| 业务对象 | FHIR 资源 |
|---|---|
| 抗菌药物分级目录 | `Medication` |
| 医务人员 / 患者 / 科室 | `Practitioner` / `Patient` / `Organization` |
| 处方权限申请（审批流转） | `Task`（status / businessStatus / 流程节点）|
| 适应症知识库 / 参考依据 | `ClinicalUseDefinition` / `Citation` |
| 权限映射规则 / 卡控规则 | `Permission`（category 区分）|
| 审批流程定义 | `PlanDefinition` |
| 预警 / 手术预防用药监测 | `DetectedIssue` / `Observation` |
| 监测指标 / 统计报表 | `MeasureReport` |
| 动态 / 公告 / 通知 | `Communication` |
| 变更记录（目录/参数/映射） | `Provenance` |
| 外部系统对接 | `Endpoint` |
| 系统参数等配置单例 | `Basic`（+ `StructureDefinition` 约束） |
| 自定义扩展 / Profile 定义 | `StructureDefinition` |

## 五、信息架构覆盖

L1 首页 + 4 个 L2 模块 + 10 个 L3 页面，全部实现（含线框图中的各类弹框）：

- 处方权限管理：处方权限申请、处方权限审批
- 目录综合管理：分级目录管理、权限映射配置、适应症知识库
- 监测分析：监测概览、统计报表
- 系统管理：权限卡控规则、审批流程配置、系统参数设置（6 个 Tab）

## 六、自检测试（可选）

`test/render-test.js` 使用 jsdom 真实执行整个前端，遍历全部「角色 × 页面」渲染并跑通核心业务流，校验无运行时错误：

```bash
npm install jsdom@24   # 仅测试需要
node test/render-test.js
```

## 七、对照设计文档的细节实现

已逐条对照文档「页面字段清单（FD）」「页面流程图（PF）」「交互规范（IX）」查缺补漏，覆盖：

- **数据真实化**：每种抗菌药物补充规格、商品名、生产企业、医保类别、库存状态（列表/详情/编辑全链路展示）。
- **处方权限审批**：支持勾选 + 批量通过/批量驳回（PF-2），新增申请科室、申请时间筛选。
- **处方权限申请**：新增「申请须知」（申请条件/审批时长/有效期）与「保存草稿」。
- **系统参数·职称权限**：编辑时展示「变更影响预览」（在岗医师数 + 受影响科室分布）。
- **权限卡控规则**：新增「规则变更日志」卡片，规则保存自动留痕（Provenance）。
- **监测概览**：预警支持按类型/科室筛选，预警可「标记已处理」或「忽略（需填理由）」。
- **适应症知识库**：新增「审核结果统计」（各药品通过率柱状图 + 驳回原因分布）。
- **审批流程配置**：停用流程时校验并提示该分级下进行中的审批数量。

> 说明：原型用于需求演示，部分外部交互（导出 Excel/PDF、下载模板、连接测试、短信/邮件发送等）以提示（Toast）形式模拟。

## 八、自动化验证

- `test/render-test.js`：遍历全部「角色 × 页面」渲染 + 核心业务流 + 30 项服务写路径冒烟，零运行时错误。
- 另用 jsdom 模拟点击验证了弹框交互（药品详情、新建申请、批量审批等）均正常。
