# 抗菌药物分级管理系统 · 前端演示程序

零构建 Vue 3 前端（全局脚本 + 本地 `lib/vue.global.prod.js`），数据全部以 **HL7 FHIR R4**
资源表达，读写真实 FHIR 服务端（默认 SRS 指定的 `https://hapi.fhir.org/baseR4`）。

功能范围 = `抗菌药物分级管理系统前端程序_SRS.md`（23 条功能需求、15 个演示用例）**∪** 原
`UX-BA-design-KJYWFJ.md` 原型（目录/权限映射/适应症/监测分析/卡控/系统参数/处方权限申请）；
两者冲突处一律以 SRS 为准（见 [冲突裁定](#二与既有原型的冲突裁定)）。

## 一、快速开始

```bash
cd KJYWFJ
npm start                     # python3 -m http.server 8137 → 打开 http://localhost:8137
```

服务端地址按优先级解析：URL 参数 `?fhir=…&mode=…&scope=…` ＞ 顶部「🔌 已连接 FHIR」设置
（localStorage）＞ `fhir-config.json` ＞ 内置默认 `https://hapi.fhir.org/baseR4`。
`mode=local` 时是纯内存演示，不发任何请求；服务端不可达可一键「以本地演示模式继续」，不会白屏。

推荐用本地 HAPI 做演示（公共实例是共享的、无鉴权、会被别人读写或定期清库）：

```bash
npm run fhir:up                                        # docker 起 HAPI，端口 8081，R4
python3 scripts/init_demo_data.py --base http://localhost:8081/fhir --yes
npm start                                              # 打开 http://localhost:8137?fhir=http://localhost:8081/fhir
```

## 二、演示数据初始化和清理脚本

**单一数据源**：演示数据只定义在 `js/seed.js`。`scripts/export_seed.js` 在 Node 里装载前端
数据层、跑一遍种子与审批引擎，导出「与浏览器写穿字节一致」的线上形态资源包；Python 脚本只负责
上传与清理，不重抄任何业务数据。

```bash
npm run seed:export                    # → build/seed-bundle.json（当前 393 条）
npm run demo:init                      # 初始化导入（默认公共 baseR4）
npm run demo:status                    # 服务端上本系统数据概况 + CapabilityStatement 支持性
npm run demo:clean                     # 清理本系统写入的数据
npm run demo:reset                     # 清理 + 重新导入（演示前一键复位）

python3 scripts/init_demo_data.py --base <URL> --scope <作用域> [--only Task] [--dry-run]
python3 scripts/clean_demo_data.py --base <URL> --scope <作用域> [--dry-run] [--yes]
```

脚本要点：

- **只认自己的数据**。共享实例上人人都在写 `Patient`/`Task`，因此前端读、写、清理都以
  `meta.tag[https://fhir.amr-demo.example/demo-scope=<scope>]` 为准：「服务端是否已初始化」用带
  本作用域标签的锚点资源判定，`_tag` 索引滞后时的按 id 兜底读回也会逐条核对标签，别的 scope 的
  同名资源不会进本地镜像、也不会被删除。
- **只删自己写的数据**。清理按该标签检索后逆引用顺序删除；`--scope` 不给就拒绝执行，
  **不存在类型级全量清空**。为解除服务端引用保护而额外删除的资源，会先用 `meta.tag[…/id]` 确认归属本系统。
- 写入按引用依赖顺序（Patient → Encounter → MedicationRequest → Task → Communication →
  Provenance/AuditEvent），用事务 Bundle 批量提交，单条失败自动回退逐条 `PUT` 并打印 HAPI 错误码。
- HAPI 的搜索索引有秒级滞后，`_tag` 检索可能读不全；清理脚本会再用种子包里的语义化 id 逐个
  `GET` 补一遍，避免公共服务器上留下删不掉的尾巴。
- 目标是公共演示服务器时会二次确认并提示其无鉴权、数据公开。

`fhir-config.json` 的 `demoScope`（默认 `kjywfj-demo-v2`）就是部署的作用域标识，改成别的值即可
在同一台服务端上隔离多套演示。注意本系统使用固定语义化 id，同一台服务端上换 scope 重灌会改写
已有资源的标签，脚本会检测并提示，建议先清理旧 scope。

## 三、推荐演示主线（对应 SRS 第 7/8 节 DEMO-01 ~ DEMO-15）

顶部演示条可切换 **7 个角色 / 12 个演示身份**（SRS §11.2 要求权限满足与权限不足的医师、
按人员/科室/角色的审批人、流程管理员必须是不同账号）。右侧「🔄 刷新数据」重新查询服务端，
「📱 移动端审批」新开窗口看同一条 FHIR Task。

| 步骤 | 身份 | 操作 |
|---|---|---|
| DEMO-01 | 系统管理员 | 「演示数据管理」→ CapabilityStatement 支持性、DEMO-01 一键核对、演示时钟、数据关联核查 |
| DEMO-02 | 规则管理员 | 「抗菌药物等级规则」→ 三级等级维护 + 药品等级调整（带快照影响提示） |
| DEMO-03 | 规则管理员 | 同页「职称使用权限」→ 勾选矩阵，先出变更摘要再保存，可「用某医师验证」 |
| DEMO-04 | 规则管理员 | 「医师权限管理」→ 科室授权、个人授权（含到期）、合并优先级可调 |
| DEMO-05 | 医师·张建华 | 「临床开单演示」→ 权限符合 → 选用药目的 → 直接提交，生成演示 MedicationRequest |
| DEMO-06 | 医师·王伟 | 选特殊使用级药品 → 自动弹权限不足提示（药品/等级/医师/授权/原因/缺少的等级） |
| DEMO-07 | 医师·王伟 | 提交审批 → 未选用药目的被拦住 → 选目的后提交，工作台显示编号/状态/当前节点 |
| DEMO-08 | 规则管理员 | 「审批流程设计」→ 从工具栏**拖拽**审核节点入画布，分别按人员/科室/角色配置 |
| DEMO-09 | 规则管理员 | 校验 → 发布前节点清单摘要 → 发布；不退出会话，切回开单页发起新申请即用新版本 |
| DEMO-10 | 三类审批人 | 「审批中心」待办出现新增节点 → 依次用人员/科室/角色账号按序通过 → 医师侧看到已通过 |
| DEMO-11 | 审批人员·张玉梅 | 「移动端审批」处理同一条 FHIR Task → 回桌面端刷新看到状态变化 |
| DEMO-12 | 医师·王伟 | 权限不足弹框选「紧急情况临时越级使用」→ 填原因 → 24h 期限；「演示数据管理」推进时钟 25h → **补审核超时**；补材料 → 完成补审核 |
| DEMO-13 | 流程审阅人员 | 「流程版本管理」→ 版本清单、节点详情、任意两版本差异比较、实例绑定的版本 |
| DEMO-14 | 流程审阅人员 | 回退恢复 → 生成新的当前版本；新申请走恢复版本，旧实例仍按原版本执行 |
| DEMO-15 | 系统管理员 | 「演示数据管理 → 数据关联核查」：患者 → 就诊 → 开单 → 审批实例 → 流程版本 → Provenance/AuditEvent |

紧急补审核的「超时」用 `js/clock.js` 的演示时钟复现：全系统时间统一取自该时钟，状态持久化在
`Basic/Basic-demo-clock` 并写穿服务端，刷新页面仍在。超时状态是**计算**出来的，不会自动把任务
写成「补审核完成」（SRS FR-008.8）。

## 四、代码结构

| 文件 | 职责 |
|---|---|
| `js/config.js` | 运行时配置（fhirBase / mode / autoSeed / demoScope / persistUsageRecords） |
| `js/fhir-client.js` | R4 REST：`PUT {type}/{id}`、事务 Bundle、`_tag` 检索、CapabilityStatement 解析 |
| `js/fhir-r4.js` | 内部资源 ⇄ 线上形态：R5 类型降级、业务状态词表、点分日期路径、悬空引用、语义 id 与作用域标签 |
| `js/fhir-store.js` | 本地镜像 + 写穿队列（按引用依赖分阶段）+ 增量刷新 + 能力检查 |
| `js/fhir-ext.js` | `ext` 投影 ⇄ 标准 `extension/modifierExtension` 编解码 |
| `js/domain.js` | 等级/职称/用药目的/审批对象/流程与医嘱状态词表、演示身份、导航信息架构 |
| `js/clock.js` | 演示时钟（24 小时补审核与超时的唯一时源） |
| `js/approval.js` | 分级授权判定 + 审批流程引擎（版本、发布、回退、实例、任务、消息、留痕） |
| `js/seed.js` | 初始化数据；流程与审批实例都经引擎生成，装载即验证引擎 |
| `js/services.js` | 业务服务层；`Svc.srs.*` 是 SRS 侧服务，`Svc.*` 保留既有原型能力 |
| `js/components/*.js` | 21 个页面组件（SRS §6.1 的 10 个入口 + 移动端审批 + 既有原型页面） |

页面组件约定（模板必须通过 computed 暴露领域常量、computed 首行订阅 `App.state.refresh` 等）见
`js/components/common.js` 与各页面头部注释；`test/render-test.js` 会编译全部页面模板并用
「每个身份 × 每个可访问页面」做渲染回归。

## 五、SRS 功能对照

| SRS | 实现位置 |
|---|---|
| FR-001 等级维护 | `grade-rules.js` + `Svc.srs.grades/saveGrade/addGrade/gradeImpact` |
| FR-002 职称权限 | `grade-rules.js` + `Svc.srs.titleRules/titleRuleDiff/saveTitleRule` |
| FR-003 科室与个人权限 | `physician-perm.js` + `Svc.srs.departments/departmentDoctors/saveDeptGrant/savePersonGrant/doctorDetail`、`Approval.authorizations` |
| FR-004 药物目录 | `catalog.js` + `Svc.srs.searchDrugs/setDrugGrade/drugPermissionView` |
| FR-005/006 开立判定与提示 | `order-demo.js` + `Approval.check`（选药与提交各判一次） |
| FR-007 超权限触发审批 | `Approval.createInstance` + 主/节点 Task |
| FR-008 紧急越级与 24h 补审核 | `emergency-review.js`、`clock.js`、`Approval.createEmergency` |
| FR-009 嵌入临床与实时提醒 | `order-demo`/`approval-center`/工作台/消息，跨身份同步用 `App.refreshFromServer()` |
| FR-010 用药目的弹窗 | `order-demo.js` + `Svc.srs.submitOrder`（未选目的抛 `PURPOSE_REQUIRED`） |
| FR-011~015 流程设计器与发布 | `workflow-designer.js` + `Approval.newDraft/saveDraft/validate/publish` |
| FR-016/020/021/022 审批中心 | `approval-center.js`、`mobile-approval.js` + `Approval.rows/flowView/act` |
| FR-017 移动端审核 | `mobile-approval.js`（同一路由体系，共用同一条 FHIR Task） |
| FR-018/019 版本查看与回退 | `workflow-versions.js` + `Approval.versions/compare/rollback` |
| FR-023 消息与提醒 | `Approval.notify`（CommunicationRequest + Communication）、`Svc.srs.messages/jump` |
| SRS §10.2 能力检查 | `FHIR.capabilities()` + 「演示数据管理」页表格，不支持项显式标红 |
| DEMO-01/15 | `demo-data.js`（一键核对、数据关联核查、初始化与时钟） |

## 六、FHIR 数据映射

| 业务对象 | FHIR 资源 |
|---|---|
| 患者 / 就诊 | `Patient` / `Encounter`（门诊 `AMB`、住院 `IMP`、急诊 `EMER`） |
| 医师 / 岗位 / 医院科室 | `Practitioner` / `PractitionerRole` / `Organization` |
| 药物知识与药品 | `MedicationKnowledge`（等级分类）/ `Medication` |
| 等级与用药目的字典 | `CodeSystem` + `ValueSet`（`amr-level`、`amr-purpose`、`amr-role`） |
| 授权规则（职称/科室/个人） | `Permission`（R4 无此类型 → 降级 `Basic` + 扩展，见第七节） |
| 抗菌药物开单 | `MedicationRequest`（等级快照、用药目的、紧急标识、权限命中来源在扩展） |
| 审批流程定义与版本 | `PlanDefinition`（一版本一资源，同 `url` 递增 `version`，`action[]` 为节点投影） |
| 审批流程实例与节点任务 | 主 `Task`（`instantiatesCanonical` 绑版本）+ 节点 `Task`（`partOf`、`owner`、`output`、`restriction.period`） |
| 通知 | `CommunicationRequest`（该通知谁）+ `Communication`（已发出、可跳转） |
| 留痕 | `Provenance` + `AuditEvent`（发布、回退、审批、授权变更） |
| 监测与报表 | `MedicationAdministration`（4870 条，默认只留本地镜像）、`DetectedIssue`、`Observation` |
| 扩展与 Profile 声明 | `StructureDefinition` |

## 七、为通过真实 R4 服务端所做的处理

实测 `hapi.fhir.org/baseR4`（FHIR 4.0.1 / HAPI 8.13）会拒绝下列写法，转换只发生在收发边界：

| 问题 | 处理 |
|---|---|
| `Permission` / `Citation` / `ClinicalUseDefinition` 是 R5 类型（`HAPI-0302`） | 降级为 `Basic`，原始元素搬入 `extension[source-element-*]`，原始类型记在 `meta.tag`，读回还原 |
| `HAPI-0931` `Communication(Request).subject` 不接受 `Task` 引用 | 「关于哪个审批实例」改走 `about`，`subject` 放患者 |
| `MedicationRequestStatus` 不认 `revoked` | 医嘱业务态一律映射到 R4 合法码（`draft/active/on-hold/cancelled/completed`），业务状态另存 `statusReason` + 扩展 |
| `AuditEventOutcome` 码表是 `0/4/8/12` | `outcome` 用 `'0'` |
| `PlanDefinition.action.id` 必须是 `[A-Za-z0-9-]{1,64}` | 中文节点名放 `title/description`，`id` 用 `node-N` |
| `HAPI-1821` 非法日期 | 日期统一 ISO；`DATE_ELEMENTS` 支持点分路径（`Task.restriction.period.end`、`Encounter.period.*` 等） |
| `HAPI-1094` 悬空引用 | 写队列按引用依赖分阶段；只保留 `Task.focus → MedicationRequest` 单向，不写 `basedOn` 回指；引用目标类型白名单校验 |
| `HAPI-0506` 引用指向 R5 专有类型（`AuditEvent.entity.what → Permission/…`） | 收发边界把引用改写到降级后的类型（`Basic/…`），原类型记在 `Reference.type`，读回还原，本地镜像看到的仍是 `Permission/…` |
| 扩展数组退化 | 单元素数组会被编解码退化成标量，所有数组字段必须在 `fhir-ext.js` 的 REGISTRY 声明为 `list` |
| 内容雷同被 `HTTP 412` 判重 | 审计时间戳精确到秒并写 `activity`；版本化 `PlanDefinition` 每版内嵌版本标记 |
| 客户端自带 id 被忽略 | 一律 `PUT {type}/{id}`，语义化 id（`Basic-catalog-version` 等）得以保留，同时写入 `identifier` 与 `meta.tag` 作为回退键 |

## 八、自动化验证

```bash
npm test              # 全部页面模板编译 + 每个身份×每个可访问页面渲染 + 引擎/服务写路径 + FHIR 规范化
npm run test:demo:local   # DEMO-01~15 业务链路（纯内存，快速）
npm run test:demo         # DEMO-01~15 连真实 FHIR 服务端（含写穿与服务端读回，结束自动清理本轮数据）
npm run test:roundtrip    # 全量资源线上形态检查 + 真实服务端无损往返（含 SRS 新增类型）
npm run test:e2e          # 需本地 HAPI：首启初始化 → 二次读回 → 引擎链路落库 → 版本发布回退
```

## 九、边界与诚实性说明

- 患者、医师、科室、药品、审批结论全部是**虚构演示数据**；任何演示结果都不构成真实临床处方、
  用药建议或审批决定（SRS BR-010）。
- 界面上的「可提交临床系统」只代表本演示流程已满足审批条件，不代表已发药或实际执行（SRS §3.4）。
- HAPI FHIR 只是资源存储与 REST 服务，不是采购条款里的流程引擎：规则判定、任务分配、节点推进、
  版本绑定都由前端引擎完成再写回 FHIR（SRS §10.7）。
- 跨身份的数据同步通过**重新查询 FHIR 服务端**实现，不包含医院短信或统一消息平台（SRS FR-009.8）。
- 采购文件未规定的规则（权限冲突优先级、补审核节点构成、用途字典、演示药品分级）全部做成可调
  配置项并在界面标注「演示配置」，不被固化为医院正式制度。
- 公共演示实例 `hapi.fhir.org` 无鉴权、数据公开、任何人可读写删除、可能定期清库；正式演示建议
  用本地 HAPI 并加 SMART on FHIR / OAuth2。
