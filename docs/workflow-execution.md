# Antfarm 多 Agent 工作流执行逻辑

> 本文档详细描述 Antfarm 的多 Agent 工作流编排架构、执行流程和状态机。

---

## 目录

1. [架构概览](#1-架构概览)
2. [核心概念](#2-核心概念)
3. [工作流定义（workflow.yml）](#3-工作流定义workflowyml)
4. [安装流程](#4-安装流程)
5. [运行启动](#5-运行启动)
6. [两阶段 Cron 轮询调度](#6-两阶段-cron-轮询调度)
7. [步骤执行引擎（step-ops）](#7-步骤执行引擎step-ops)
8. [Loop 步骤与 Story 机制](#8-loop-步骤与-story-机制)
9. [Verify-Each 双循环](#9-verify-each-双循环)
10. [流水线推进（advancePipeline）](#10-流水线推进advancepipeline)
11. [失败处理与重试策略](#11-失败处理与重试策略)
12. [超时与遗弃清理](#12-超时与遗弃清理)
13. [Medic 健康看门狗](#13-medic-健康看门狗)
14. [事件系统与可观测性](#14-事件系统与可观测性)
15. [数据模型](#15-数据模型)
16. [内置工作流详解](#16-内置工作流详解)
17. [文件系统布局](#17-文件系统布局)

---

## 1. 架构概览

```
┌──────────────────────────────────────────────────────────────────┐
│                        用户 / 主 Agent                            │
│                                                                  │
│   antfarm workflow run feature-dev "实现用户认证"                  │
│          │                                                       │
│          ▼                                                       │
│   ┌─────────────┐                                                │
│   │  CLI 入口    │  src/cli/cli.ts                               │
│   └──────┬──────┘                                                │
│          │                                                       │
│          ▼                                                       │
│   ┌─────────────┐   创建 run + steps 记录                        │
│   │  runWorkflow │  src/installer/run.ts                         │
│   └──────┬──────┘                                                │
│          │                                                       │
│          ├── 写入 SQLite（runs 表 + steps 表）                    │
│          └── 启动 Agent Cron 轮询作业                             │
│                    │                                             │
│                    ▼                                             │
│   ┌────────────────────────────────────────────┐                 │
│   │          OpenClaw Cron 调度器                │                │
│   │  每 5 分钟触发每个 agent 的轮询 session       │                │
│   └────────────────────────────────────────────┘                 │
│          │                                                       │
│          ▼                                                       │
│   ┌───────────────────────────────────────────────────┐          │
│   │              两阶段轮询                             │          │
│   │                                                   │          │
│   │  Phase 1: peek (廉价模型)                          │          │
│   │    └─ NO_WORK → HEARTBEAT_OK → 结束               │          │
│   │    └─ HAS_WORK → Phase 2                          │          │
│   │                                                   │          │
│   │  Phase 2: claim → sessions_spawn (工作模型)        │          │
│   │    └─ 独立会话执行任务                              │          │
│   │    └─ step complete / step fail                   │          │
│   └───────────────────────────────────────────────────┘          │
│          │                                                       │
│          ▼                                                       │
│   ┌─────────────┐                                                │
│   │ step-ops    │  步骤状态管理 + 流水线推进                       │
│   │ (核心引擎)   │  src/installer/step-ops.ts                     │
│   └──────┬──────┘                                                │
│          │                                                       │
│          ├── completeStep() → 合并输出到 context → advancePipeline│
│          └── failStep()     → 重试 / 失败 / 升级                  │
│                                                                  │
└──────────────────────────────────────────────────────────────────┘
```

### 设计原则

- **无服务器编排**：不需要 Redis / Kafka / 容器编排器。只用 YAML + SQLite + Cron。
- **新鲜上下文**：每个 agent 在独立会话中运行，避免上下文窗口膨胀。
- **Agent 互相验证**：Developer 的工作由独立的 Verifier 检查。
- **自动重试与升级**：失败步骤自动重试，重试耗尽后升级到人类。

---

## 2. 核心概念

| 概念 | 说明 | 数据表 |
|------|------|--------|
| **Workflow** | 工作流定义，描述 agent 团队和有序步骤 | workflow.yml（文件） |
| **Run** | 一次工作流执行实例 | `runs` |
| **Step** | Run 中的一个执行步骤，绑定到特定 agent | `steps` |
| **Story** | 用户故事（由 planner 分解产出），用于 loop 步骤迭代 | `stories` |
| **Agent** | AI 代理，拥有独立工作空间和角色权限 | `openclaw.json` |
| **Cron** | 定时轮询作业，驱动 agent 检查并执行工作 | OpenClaw Cron |
| **Context** | 运行时上下文（键值对），在步骤间传递数据 | `runs.context` |

---

## 3. 工作流定义（workflow.yml）

每个工作流由一个 YAML 文件定义，包含以下结构：

```yaml
id: feature-dev              # 工作流唯一标识（不能含下划线）
name: Feature Development     # 人类可读名称
version: 5                    # 版本号

polling:
  model: cheap-model          # 轮询阶段使用的廉价模型
  timeoutSeconds: 120         # 轮询超时

working:
  model: powerful-model       # 工作阶段使用的强力模型

agents:                       # Agent 定义列表
  - id: planner
    role: analysis            # 角色决定工具权限
    workspace:
      baseDir: agents/planner
      files:
        AGENTS.md: agents/planner/AGENTS.md
        SOUL.md: agents/planner/SOUL.md

steps:                        # 有序步骤列表
  - id: plan
    agent: planner
    input: |                  # 模板输入（支持 {{key}} 占位符）
      分解以下任务...
      TASK: {{task}}
    expects: "STATUS: done"   # 期望输出（用于验证完成）
    max_retries: 2
    on_fail:
      escalate_to: human      # 重试耗尽后升级目标
```

### Agent 角色与权限

| 角色 | 典型 Agent | 文件写入 | 代码执行 | 浏览器 | 网络搜索 | 超时 |
|------|-----------|---------|---------|-------|---------|------|
| analysis | planner, reviewer, triager | ✗ | ✓ | ✗ | ✗ | 20min |
| coding | developer, fixer, setup | ✓ | ✓ | ✗ | ✗ | 30min |
| verification | verifier | ✗ | ✓ | ✗ | ✗ | 20min |
| testing | tester | ✗ | ✓ | ✓ | ✓ | 30min |
| pr | pr creator | ✗ | ✓ | ✗ | ✗ | 20min |
| scanning | scanner | ✗ | ✓ | ✗ | ✓ | 20min |

---

## 4. 安装流程

```
antfarm install
    │
    ▼
listBundledWorkflows()          # 扫描 workflows/ 目录
    │
    ▼ (对每个工作流)
installWorkflow(workflowId)
    │
    ├── fetchWorkflow()          # 复制 workflow 到 ~/.openclaw/antfarm/workflows/
    ├── loadWorkflowSpec()       # 解析 workflow.yml
    ├── provisionAgents()        # 创建 agent 工作空间 + 部署引导文件
    │     ├── 创建工作空间目录
    │     ├── 复制 AGENTS.md / SOUL.md / IDENTITY.md
    │     └── 安装技能文件
    ├── 更新 openclaw.json
    │     ├── 确保主 agent 在列表中（防止被覆盖）
    │     ├── 注册工作流 agent（含工具策略）
    │     ├── 配置子代理白名单
    │     └── 设置 cron session 保留策略
    ├── updateMainAgentGuidance() # 注入操作指引到主 agent
    └── installAntfarmSkill()     # 安装技能文件
```

---

## 5. 运行启动

```
antfarm workflow run feature-dev "实现用户认证功能"
    │
    ▼
runWorkflow()
    │
    ├── 加载 workflow.yml
    ├── 创建 run 记录（status: running）
    ├── 创建 step 记录：
    │     step[0].status = "pending"    ← 第一步立即可执行
    │     step[1].status = "waiting"
    │     step[2].status = "waiting"
    │     ...
    ├── 初始化 context = { task: "实现用户认证功能", ...workflow.context }
    ├── ensureWorkflowCrons()    ← 启动 cron 轮询（如不存在）
    └── emitEvent("run.started")
```

### 初始状态

```
Run #1 [running]
  step[0] plan      (planner)    [pending]   ← 等待被认领
  step[1] setup     (setup)      [waiting]
  step[2] implement (developer)  [waiting]   type=loop
  step[3] verify    (verifier)   [waiting]
  step[4] test      (tester)     [waiting]
  step[5] pr        (developer)  [waiting]
  step[6] review    (reviewer)   [waiting]
```

---

## 6. 两阶段 Cron 轮询调度

### 为什么需要两阶段？

传统方式：每个 agent 每 5 分钟启动一个完整会话执行 `step claim`。
问题：大部分时间 agent 无工作可做，但仍消耗昂贵模型的 token。

**两阶段方案**：

```
┌─────────────────────────────────────────────────┐
│ Phase 1: 轮询（廉价模型，~100 tokens）            │
│                                                 │
│   step peek "feature-dev_planner"               │
│   └─ NO_WORK → "HEARTBEAT_OK" → session 结束   │
│   └─ HAS_WORK → 进入 Phase 2                   │
│                                                 │
│ Phase 2: 认领 + 启动工作会话                      │
│                                                 │
│   step claim "feature-dev_planner"              │
│   └─ 获取 JSON {stepId, runId, input}           │
│   └─ sessions_spawn(agentId, model, task)       │
│        └─ 独立工作会话（使用强力模型）              │
│             └─ 执行任务                          │
│             └─ step complete <stepId>            │
└─────────────────────────────────────────────────┘
```

### Cron 配置

每个 agent 的 cron 作业间隔错开 1 分钟，避免同时触发造成数据库竞争：

```
agent[0] planner    → anchorMs: 0       (T+0:00 触发)
agent[1] setup      → anchorMs: 60000   (T+1:00 触发)
agent[2] developer  → anchorMs: 120000  (T+2:00 触发)
agent[3] verifier   → anchorMs: 180000  (T+3:00 触发)
...
```

---

## 7. 步骤执行引擎（step-ops）

### peekStep(agentId) — 轻量工作检查

```sql
SELECT COUNT(*) FROM steps s JOIN runs r ON r.id = s.run_id
WHERE s.agent_id = ? AND s.status IN ('pending', 'waiting')
  AND r.status = 'running'
```

返回 `"HAS_WORK"` 或 `"NO_WORK"`。单条 COUNT 查询，无副作用。

### claimStep(agentId) — 认领步骤

```
claimStep()
    │
    ├── 节流清理超时步骤（每 5 分钟最多一次）
    │     └── cleanupAbandonedSteps()
    │
    ├── 查找可认领步骤：
    │     WHERE agent_id = ?
    │       AND status = 'pending'
    │       AND run.status NOT IN ('failed', 'cancelled')
    │       AND 所有前置步骤已完成（step_index < 当前 AND status IN ('done','skipped')）
    │     ORDER BY step_index ASC
    │
    ├── 构建模板上下文：
    │     context = run.context + { run_id, has_frontend_changes, progress }
    │
    ├── [如果是 loop 步骤]
    │     ├── 找到下一个 pending 的 story
    │     ├── 注入 story 模板变量
    │     │     current_story, current_story_id, completed_stories,
    │     │     stories_remaining, progress, verify_feedback
    │     └── 标记 story 为 running
    │
    ├── 解析模板：{{key}} → context[key]
    ├── 标记步骤为 running
    └── 返回 { stepId, runId, resolvedInput }
```

### completeStep(stepId, output) — 完成步骤

```
completeStep()
    │
    ├── 解析 KEY: value 行 → 合并到 run context
    │     例：STATUS: done
    │          REPO: /path/to/repo
    │          BRANCH: feature-auth
    │
    ├── 解析 STORIES_JSON（如有）→ 插入 stories 表
    │
    ├── [如果是 loop 步骤]
    │     ├── 标记当前 story 为 done
    │     ├── [如果配置了 verify_each]
    │     │     └── 将 verify 步骤设为 pending → 触发验证
    │     └── [否则] checkLoopContinuation()
    │           ├── 有更多 pending story → loop 步骤回到 pending
    │           └── 所有 story 完成 → loop 步骤标记 done → advancePipeline()
    │
    ├── [如果是 verify_each 的验证步骤]
    │     └── handleVerifyEachCompletion()
    │
    └── [普通 single 步骤]
          ├── 标记步骤为 done
          └── advancePipeline()
```

### failStep(stepId, error) — 步骤失败

```
failStep()
    │
    ├── [loop 步骤] → per-story 重试
    │     ├── story.retryCount < maxRetries → story 重置为 pending，步骤重置为 pending
    │     └── 重试耗尽 → story failed → step failed → run failed → 通知升级
    │
    └── [single 步骤] → per-step 重试
          ├── step.retryCount < maxRetries → 步骤重置为 pending
          └── 重试耗尽 → step failed → run failed → 通知升级
```

---

## 8. Loop 步骤与 Story 机制

### 什么是 Loop 步骤？

Loop 步骤用于迭代处理一组 story。典型场景：Developer 逐个实现由 Planner 分解出的 user stories。

```yaml
- id: implement
  agent: developer
  type: loop
  loop:
    over: stories           # 遍历 stories 表
    completion: all_done    # 所有 story 完成时步骤完成
    fresh_session: true     # 每个 story 使用新鲜会话
    verify_each: true       # 每完成一个 story 触发验证
    verify_step: verify     # 指定验证步骤 ID
```

### Story 生命周期

```
Planner 输出 STORIES_JSON
    │
    ▼
stories 表: [S1: pending, S2: pending, S3: pending, ...]
    │
    ▼ (Developer 认领 loop 步骤)
S1: pending → running    ← claimStep() 认领第一个 pending story
    │
    ▼ (Developer 完成实现)
S1: running → done       ← completeStep() 标记 story 完成
    │
    ▼ (如果 verify_each=true)
Verify 步骤: waiting → pending   ← 触发 Verifier
    │
    ▼ (Verifier 验证)
    ├── STATUS: done → S1 验证通过 → 继续 S2
    └── STATUS: retry → S1 重置为 pending → Developer 重新实现
```

### STORIES_JSON 格式

由 Planner 步骤输出，格式如下：

```json
STORIES_JSON: [
  {
    "id": "S1",
    "title": "用户注册 API",
    "description": "实现 POST /api/auth/register 端点...",
    "acceptanceCriteria": [
      "POST /api/auth/register 接受 email 和 password",
      "密码使用 bcrypt 哈希存储",
      "返回 JWT token",
      "相关测试通过",
      "类型检查通过"
    ]
  },
  ...
]
```

---

## 9. Verify-Each 双循环

Verify-each 是 Antfarm 的核心质量保障机制：每个 story 实现后都由独立的 Verifier 检查。

```
               ┌──────────────────────────────────┐
               │                                  │
               ▼                                  │
┌─────────────────────────┐                       │
│ Developer: implement    │                       │
│ (loop step)             │                       │
│                         │                       │
│  认领 story → 实现 →     │                       │
│  step complete          │                       │
└──────────┬──────────────┘                       │
           │                                      │
           ▼                                      │
┌─────────────────────────┐                       │
│ Verifier: verify        │                       │
│ (verify_each step)      │                       │
│                         │                       │
│  检查代码 → 运行测试 →   │                       │
│  step complete          │                       │
└──────────┬──────────────┘                       │
           │                                      │
           ├── STATUS: done                       │
           │     └── story 验证通过               │
           │          └── 有更多 story?            │
           │               ├── 是 → loop 回 pending ──┘
           │               └── 否 → loop done → advancePipeline
           │
           └── STATUS: retry
                 └── story 重置为 pending
                      └── verify_feedback 写入 context
                           └── Developer 重新实现（带反馈）──┘
```

### 状态流转细节

```
初始：                         认领 S1:                  完成 S1:
  implement [pending]           implement [running]       implement [running]
  verify    [waiting]           verify    [waiting]       verify    [pending] ← 触发验证
  story S1  [pending]           story S1  [running]       story S1  [done]

验证 S1 通过:                  认领 S2:                  所有完成:
  implement [pending] ← 继续    implement [running]       implement [done]
  verify    [waiting]           verify    [waiting]       verify    [done]
  story S1  [done]              story S2  [running]       story S1  [done]
  story S2  [pending]           ...                       story S2  [done]
```

---

## 10. 流水线推进（advancePipeline）

当一个步骤完成时，`advancePipeline()` 决定下一步：

```
advancePipeline(runId)
    │
    ├── 检查 run 状态（failed/cancelled → 不推进）
    │
    ├── 检查是否有 running 步骤 → 有则等待
    │
    ├── 查找下一个 waiting 步骤
    │     ├── 找到 → 设为 pending → 发射 pipeline.advanced 事件
    │     │
    │     └── 没有更多步骤
    │           ├── 有 failed/pending 步骤 → 等待
    │           └── 全部完成 → run 标记 completed
    │                 ├── 归档进度文件
    │                 ├── 清理 cron 作业
    │                 └── 发射 run.completed 事件
    │
    └── 返回 { advanced, runCompleted }
```

---

## 11. 失败处理与重试策略

### 三级重试机制

```
Level 1: Story 重试（Loop 步骤内）
  └── 每个 story 独立计数，默认 max_retries: 2
  └── 一个 story 失败不影响其他 story 的重试配额

Level 2: Step 重试（Single 步骤）
  └── per-step 计数，默认 max_retries: 2

Level 3: 遗弃重试（abandoned 步骤）
  └── agent 未报告 complete/fail 就结束了 session
  └── 使用独立的 abandoned_count 计数，max: 5
  └── 不消耗正常重试配额
```

### 升级策略（on_fail.escalate_to）

```yaml
on_fail:
  retry_step: implement       # 失败后从哪个步骤重试
  max_retries: 2              # 最大重试次数
  on_exhausted:
    escalate_to: human        # 重试耗尽后升级到人类
```

升级目标：
- `human` / `main` → 发送消息到主 agent 会话（`agent:main:main`）
- `agent:<id>` → 发送消息到指定 agent 会话

---

## 12. 超时与遗弃清理

Agent 可能在执行过程中崩溃、超时或被 OpenClaw 终止，导致步骤永远处于 `running` 状态。

### cleanupAbandonedSteps()

```
检测条件：
  step.status = 'running'
  AND (当前时间 - step.updated_at) > maxRoleTimeout + 5分钟缓冲

处理逻辑：
  Loop 步骤（有 current_story）：
    └── story 重试（per-story retry count）
    └── 重试耗尽 → story failed → step failed → run failed

  Single 步骤：
    └── abandoned_count += 1
    └── abandoned_count < 5 → 重置为 pending（不消耗 retry_count）
    └── abandoned_count >= 5 → step failed → run failed
```

### 触发时机

- `claimStep()` 时节流触发（每 5 分钟最多一次）
- Medic 健康检查独立触发

---

## 13. Medic 健康看门狗

Medic 是独立的健康监控系统，每 5 分钟运行一次全面检查。

### 检查项

| 检查 | 严重程度 | 自动修复 |
|------|---------|---------|
| **Stuck Steps** — 运行时间超过阈值的步骤 | Warning | 重置为 pending |
| **Stalled Runs** — 长时间无进展的运行 | Critical | 仅告警 |
| **Dead Runs** — 僵尸运行（所有步骤终止但 run 仍 running） | Critical | 标记 run failed |
| **Orphaned Crons** — 无活跃运行但 cron 仍在跑 | Warning | 清理 cron |

### 自动修复流程

```
runMedicCheck()
    │
    ├── 收集所有 findings（同步 + 异步检查）
    │
    ├── 对每个有 action 的 finding：
    │     ├── reset_step  → 重置步骤为 pending（增加 abandoned_count）
    │     ├── fail_run    → 标记 run 为 failed
    │     └── teardown_crons → 清理孤儿 cron
    │
    ├── 记录检查结果到 medic_checks 表
    └── 返回摘要
```

---

## 14. 事件系统与可观测性

### 事件类型

| 事件 | 触发时机 |
|------|---------|
| `run.started` | 运行创建 |
| `run.completed` | 所有步骤完成 |
| `run.failed` | 运行失败 |
| `step.pending` | 步骤变为待处理 |
| `step.running` | 步骤被认领 |
| `step.done` | 步骤完成 |
| `step.failed` | 步骤失败 |
| `step.timeout` | 步骤超时 |
| `story.started` | Story 被认领 |
| `story.done` | Story 实现完成 |
| `story.verified` | Story 验证通过 |
| `story.retry` | Story 需要重试 |
| `story.failed` | Story 失败 |
| `pipeline.advanced` | 流水线推进到下一步 |

### 数据流

```
emitEvent()
    │
    ├── 追加到 events.jsonl 文件（10MB 自动轮转）
    │     └── Dashboard API 读取此文件
    │     └── CLI `antfarm logs` 读取此文件
    │
    └── 触发 Webhook（如 run 配置了 notify_url）
          └── POST JSON 到指定 URL
          └── 支持 URL fragment 嵌入 auth token
```

---

## 15. 数据模型

### runs 表

| 列 | 类型 | 说明 |
|---|------|------|
| id | TEXT PK | UUID |
| run_number | INTEGER | 自增编号（#1, #2, ...） |
| workflow_id | TEXT | 工作流 ID |
| task | TEXT | 任务描述 |
| status | TEXT | running / completed / failed / cancelled |
| context | TEXT | JSON 格式的运行时上下文 |
| notify_url | TEXT | Webhook 通知 URL |
| created_at | TEXT | 创建时间 |
| updated_at | TEXT | 更新时间 |

### steps 表

| 列 | 类型 | 说明 |
|---|------|------|
| id | TEXT PK | UUID（内部标识） |
| run_id | TEXT FK | 所属 run |
| step_id | TEXT | 步骤 ID（如 "plan", "implement"） |
| agent_id | TEXT | Agent ID（如 "feature-dev_planner"） |
| step_index | INTEGER | 步骤顺序 |
| input_template | TEXT | 输入模板（含 {{}} 占位符） |
| expects | TEXT | 期望输出 |
| status | TEXT | waiting / pending / running / done / failed / skipped |
| output | TEXT | 步骤输出 |
| type | TEXT | single / loop |
| loop_config | TEXT | JSON 格式的 loop 配置 |
| current_story_id | TEXT | 当前正在处理的 story ID |
| retry_count | INTEGER | 重试次数 |
| max_retries | INTEGER | 最大重试次数 |
| abandoned_count | INTEGER | 遗弃次数（独立于 retry_count） |

### stories 表

| 列 | 类型 | 说明 |
|---|------|------|
| id | TEXT PK | UUID |
| run_id | TEXT FK | 所属 run |
| story_index | INTEGER | Story 顺序 |
| story_id | TEXT | Story ID（如 "S1"） |
| title | TEXT | Story 标题 |
| description | TEXT | Story 描述 |
| acceptance_criteria | TEXT | JSON 数组 |
| status | TEXT | pending / running / done / failed |
| output | TEXT | Story 输出 |
| retry_count | INTEGER | 重试次数 |
| max_retries | INTEGER | 最大重试次数 |

### 状态机图

```
Steps:
  waiting ──[advancePipeline]──► pending ──[claimStep]──► running
                                    ▲                       │
                                    │                       ├──[completeStep]──► done
                                    │                       │
                                    └──[retry]──────────────┤
                                                            └──[failStep]──► failed

Stories:
  pending ──[claimStep]──► running ──[completeStep]──► done
     ▲                        │
     │                        └──[failStep/retry]──► pending (retry)
     │                                                  │
     └──────────────────────────────────────────────────┘
                                                    or ──► failed (exhausted)

Runs:
  running ──[all steps done]──► completed
     │
     ├──[step failed + retries exhausted]──► failed
     └──[user cancel]──► cancelled
```

---

## 16. 内置工作流详解

### feature-dev（功能开发）— 7 Agents

```
plan ──► setup ──► implement ──► verify ──► test ──► pr ──► review
 │                    │             │
 │                    └─loop(stories)
 │                    └─verify_each ──► verify
 │
 └─ 输出 STORIES_JSON
```

| 步骤 | Agent | 角色 | 任务 |
|------|-------|------|------|
| plan | planner | analysis | 分解任务为有序 user stories |
| setup | setup | coding | 创建分支、建立构建/测试基线 |
| implement | developer | coding | **Loop**: 逐个实现 stories |
| verify | verifier | verification | **Verify-each**: 检查每个 story |
| test | tester | testing | 集成/E2E 测试 |
| pr | developer | coding | 创建 Pull Request |
| review | reviewer | analysis | 代码审查 |

### bug-fix（Bug 修复）— 6 Agents

```
triage ──► investigate ──► setup ──► fix ──► verify ──► pr
```

| 步骤 | Agent | 任务 |
|------|-------|------|
| triage | triager | 分析 bug 报告、复现、分类严重程度 |
| investigate | investigator | 追溯根因、提出修复方案 |
| setup | setup | 创建修复分支 |
| fix | fixer | 实现修复 + 回归测试 |
| verify | verifier | 验证修复正确性 |
| pr | pr | 创建 Pull Request |

### security-audit（安全审计）— 7 Agents

```
scan ──► prioritize ──► setup ──► fix ──► verify ──► test ──► pr
                          │         │        │
                          │         └─loop(stories)
                          │         └─verify_each ──► verify
                          │
                          └─ 输出 STORIES_JSON
```

| 步骤 | Agent | 任务 |
|------|-------|------|
| scan | scanner | 全面安全扫描 |
| prioritize | prioritizer | 去重、排序、生成修复计划 |
| setup | setup | 创建安全分支 |
| fix | fixer | **Loop**: 逐个修复漏洞 |
| verify | verifier | **Verify-each**: 验证每个修复 |
| test | tester | 最终集成测试 + 审计对比 |
| pr | pr | 创建 PR（含审计报告） |

---

## 17. 文件系统布局

```
~/.openclaw/
├── openclaw.json                          # OpenClaw 配置（Antfarm 会修改）
├── antfarm/
│   ├── antfarm.db                         # SQLite 数据库（runs/steps/stories）
│   ├── antfarm.db-wal                     # WAL 日志
│   ├── events.jsonl                       # 事件日志
│   ├── dashboard.pid                      # Dashboard 进程 PID
│   ├── dashboard.log                      # Dashboard 日志
│   ├── logs/
│   │   └── workflow.log                   # 结构化运行日志
│   └── workflows/                         # 已安装的工作流副本
│       ├── feature-dev/
│       │   ├── workflow.yml
│       │   ├── metadata.json
│       │   ├── agents/planner/AGENTS.md
│       │   └── ...
│       ├── bug-fix/
│       └── security-audit/
├── workspaces/workflows/                  # Agent 工作空间
│   ├── feature-dev/
│   │   ├── agents/planner/
│   │   │   ├── AGENTS.md
│   │   │   ├── SOUL.md
│   │   │   └── IDENTITY.md
│   │   ├── agents/developer/
│   │   │   ├── AGENTS.md
│   │   │   ├── progress-<runId>.txt       # 进度文件（运行时）
│   │   │   └── archive/<runId>/           # 归档的进度文件
│   │   └── ...
│   └── ...
├── agents/                                # Agent 配置目录
│   ├── feature-dev_planner/agent/
│   ├── feature-dev_developer/agent/
│   └── ...
├── skills/
│   └── antfarm-workflows/SKILL.md         # Antfarm 技能文件
└── workspace/                             # 用户主 agent 工作空间
    ├── AGENTS.md                          # 含 Antfarm 指引块
    └── TOOLS.md                           # 含 Antfarm 命令参考
```
