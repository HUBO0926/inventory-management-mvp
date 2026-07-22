# 库存管理系统业务流程

这张角色泳道图说明系统管理员、生产人员和仓库管理员如何围绕 RAW 原材料库、FG 成品库及统一库存引擎完成库存与生产闭环。

```mermaid
%%{init: {'theme':'base','flowchart':{'curve':'basis','nodeSpacing':28,'rankSpacing':34},'themeVariables':{'background':'#FFFFFF','fontFamily':'Microsoft YaHei, Arial','primaryTextColor':'#0B1F3A','lineColor':'#6B7C93','clusterBkg':'#FFFFFF','clusterBorder':'#CBD5E1'}}}%%
flowchart TB
  START([登录系统])

  subgraph ADMIN[系统管理员]
    direction LR
    A1[账号与角色] --> A2[统一物料主数据] --> A3[启用单层 BOM]
  end

  subgraph PROD[生产人员]
    direction LR
    P1[创建任务<br/>复制 BOM 快照<br/>DRAFT] --> P2[缺料检查] --> D1{RAW 是否充足?}
    D1 -- 充足 --> P3[发布<br/>RELEASED] --> P4[生产执行<br/>IN_PROGRESS] --> P5[分次完工报产] --> D2{累计完成计划量?}
    D2 -- 否 --> P4
    D2 -- 是 --> P6[自动完工入库<br/>FG 增加<br/>COMPLETED]
  end

  subgraph WH[仓库管理员]
    direction LR
    W1[原材料入库<br/>草稿 → 过账<br/>RAW 增加]
    W2[多次生产领料<br/>RAW 减少]
    W3[可选生产退料<br/>RAW 增加]
    W4[独立成品入库<br/>仅非生产来源<br/>FG 增加]
    W5[成品出库<br/>草稿 → 过账<br/>FG 减少]
  end

  subgraph ENGINE[统一库存引擎]
    direction LR
    S1[InventoryPostingService] --> S2[幂等键 · 行锁<br/>负库存与状态校验] --> S3[更新余额<br/>追加不可修改流水] --> Q[驾驶舱 · 当前库存 · 库存流水<br/>按仓库 / 物料 / 单据追溯]
    S4[已过账单据冲销<br/>生成 REVERSAL] --> S2
  end

  START --> A1
  A3 --> P1
  D1 -- 缺料 --> W1
  W1 -- 入库后重新检查 --> P2
  P3 --> W2 --> P4
  P4 -- 多余材料 --> W3 --> P4
  P6 --> W5 --> Q
  START -. 非生产来源 .-> W4 --> Q
  START -. 全角色查询 .-> Q

  W1 -. 库存变化 .-> S1
  W2 -. 库存变化 .-> S1
  W3 -. 库存变化 .-> S1
  W4 -. 库存变化 .-> S1
  W5 -. 库存变化 .-> S1
  P5 -. 每次报产自动增加 FG .-> S1
  S3 -. 需要撤回 .-> S4

  classDef admin fill:#EAF2FF,stroke:#1677FF,color:#0B1F3A,stroke-width:1px;
  classDef production fill:#EDF9F1,stroke:#16A34A,color:#0B1F3A,stroke-width:1px;
  classDef warehouse fill:#FFF7E8,stroke:#F59E0B,color:#0B1F3A,stroke-width:1px;
  classDef engine fill:#F3F6FA,stroke:#6B7C93,color:#0B1F3A,stroke-width:1px;
  class A1,A2,A3 admin;
  class P1,P2,D1,P3,P4,P5,D2,P6 production;
  class W1,W2,W3,W4,W5 warehouse;
  class S1,S2,S3,S4,Q engine;
```

![库存管理系统业务流程图](assets/business-process.png)

## 读图要点

1. 基础数据先行：必须先维护物料和启用 BOM，生产任务创建时会复制 BOM 快照。
2. 缺料不发布：发布任务前按 RAW 当前库存检查需求量；缺料时先完成原材料入库并重新检查。
3. 库存统一过账：所有库存增减都经过 `InventoryPostingService`，草稿不会改变库存。
4. 生产允许分次执行：领料、退料和完工报产都可多次提交；达到计划数量后任务自动完成。
5. 两类成品入库不能混用：完工报产自动进入 FG；“成品入库”页面只处理不关联生产任务的其他来源。
6. 过账后不可改：已过账单据不能编辑或删除，只能冲销；冲销同样执行负库存和业务状态校验。
7. 余额可追溯：每次过账都会同时更新余额并写入不可修改流水，流水累计应与当前库存一致。

## 状态速查

| 对象 | 状态流转 |
| --- | --- |
| 库存单据 | `DRAFT 草稿 → POSTED 已过账 → VOIDED 已冲销` |
| 生产任务 | `DRAFT 草稿 → RELEASED 已发布 → IN_PROGRESS 生产中 → COMPLETED 已完成` |
| 任务取消 | 未完成任务可进入 `CANCELLED`；存在未退净领料时必须先退料 |

详细点击步骤见[《库存管理系统操作手册》](user-guide.md)。
