/**
 * Agent Cron 管理 — 工作流的自动轮询调度层。
 *
 * Antfarm 使用 OpenClaw 的 cron 工具来驱动工作流执行。每个 agent 对应一个
 * cron 作业，定期（默认 5 分钟）触发一个轻量级的"两阶段轮询"：
 *
 * 阶段一（轮询）：使用廉价模型运行 `step peek`，检查是否有待处理工作。
 *   - 无工作 → 回复 HEARTBEAT_OK → 结束（消耗极少 token）
 *   - 有工作 → 进入阶段二
 *
 * 阶段二（执行）：运行 `step claim` 认领步骤，然后通过 sessions_spawn
 *   启动一个独立的工作会话（使用配置的工作模型），执行实际任务。
 *
 * 这种两阶段设计大幅降低了空闲时的 token 消耗。
 *
 * Cron 生命周期：
 *   - 工作流运行开始时创建（ensureWorkflowCrons）
 *   - 运行结束且无其他活跃运行时移除（teardownWorkflowCronsIfIdle）
 *   - 多个运行共享同一组 cron（不重复创建）
 */
import { createAgentCronJob, deleteAgentCronJobs, listCronJobs, checkCronToolAvailable } from "./gateway-api.js";
import type { WorkflowSpec } from "./types.js";
import { resolveAntfarmCli } from "./paths.js";
import { getDb } from "../db.js";
import { readOpenClawConfig } from "./openclaw-config.js";

const DEFAULT_EVERY_MS = 300_000; // 5 分钟轮询间隔
const DEFAULT_AGENT_TIMEOUT_SECONDS = 30 * 60; // 30 分钟工作超时

/**
 * 构建单阶段 agent prompt（旧模式，保留供参考）。
 * 该 prompt 指导 agent 执行：peek → claim → 执行工作 → complete/fail。
 */
function buildAgentPrompt(workflowId: string, agentId: string): string {
  const fullAgentId = `${workflowId}_${agentId}`;
  const cli = resolveAntfarmCli();

  return `You are an Antfarm workflow agent. Check for pending work and execute it.

⚠️ CRITICAL: You MUST call "step complete" or "step fail" before ending your session. If you don't, the workflow will be stuck forever. This is non-negotiable.

Step 1 — Check for pending work:
\`\`\`
node ${cli} step claim "${fullAgentId}"
\`\`\`

If output is "NO_WORK", reply HEARTBEAT_OK and stop.

Step 2 — If JSON is returned, it contains: {"stepId": "...", "runId": "...", "input": "..."}
Save the stepId — you'll need it to report completion.
The "input" field contains your FULLY RESOLVED task instructions. Read it carefully and DO the work.

Step 3 — Do the work described in the input. Format your output with KEY: value lines as specified.

Step 4 — MANDATORY: Report completion (do this IMMEDIATELY after finishing the work):
\`\`\`
cat <<'ANTFARM_EOF' > /tmp/antfarm-step-output.txt
STATUS: done
CHANGES: what you did
TESTS: what tests you ran
ANTFARM_EOF
cat /tmp/antfarm-step-output.txt | node ${cli} step complete "<stepId>"
\`\`\`

If the work FAILED:
\`\`\`
node ${cli} step fail "<stepId>" "description of what went wrong"
\`\`\`

RULES:
1. NEVER end your session without calling step complete or step fail
2. Write output to a file first, then pipe via stdin (shell escaping breaks direct args)
3. If you're unsure whether to complete or fail, call step fail with an explanation

The workflow cannot advance until you report. Your session ending without reporting = broken pipeline.`;
}

/**
 * 构建工作 prompt — 两阶段模式的第二阶段，包含完整的任务执行指令。
 * 该 prompt 会被嵌入到 sessions_spawn 调用中，由独立的工作会话执行。
 */
export function buildWorkPrompt(workflowId: string, agentId: string): string {
  const fullAgentId = `${workflowId}_${agentId}`;
  const cli = resolveAntfarmCli();

  return `You are an Antfarm workflow agent. Execute the pending work below.

⚠️ CRITICAL: You MUST call "step complete" or "step fail" before ending your session. If you don't, the workflow will be stuck forever. This is non-negotiable.

The claimed step JSON is provided below. It contains: {"stepId": "...", "runId": "...", "input": "..."}
Save the stepId — you'll need it to report completion.
The "input" field contains your FULLY RESOLVED task instructions. Read it carefully and DO the work.

Do the work described in the input. Format your output with KEY: value lines as specified.

MANDATORY: Report completion (do this IMMEDIATELY after finishing the work):
\`\`\`
cat <<'ANTFARM_EOF' > /tmp/antfarm-step-output.txt
STATUS: done
CHANGES: what you did
TESTS: what tests you ran
ANTFARM_EOF
cat /tmp/antfarm-step-output.txt | node ${cli} step complete "<stepId>"
\`\`\`

If the work FAILED:
\`\`\`
node ${cli} step fail "<stepId>" "description of what went wrong"
\`\`\`

RULES:
1. NEVER end your session without calling step complete or step fail
2. Write output to a file first, then pipe via stdin (shell escaping breaks direct args)
3. If you're unsure whether to complete or fail, call step fail with an explanation

The workflow cannot advance until you report. Your session ending without reporting = broken pipeline.`;
}

const DEFAULT_POLLING_TIMEOUT_SECONDS = 120;
/**
 * 默认模型标记。值为 undefined 表示"不指定模型，让 OpenClaw 使用全局默认"。
 * 之前使用 "default" 字符串会导致 OpenClaw 尝试解析 "anthropic/default" 而报错。
 */
const DEFAULT_POLLING_MODEL: string | undefined = undefined;

function extractModel(value: unknown): string | undefined {
  if (!value) return undefined;
  if (typeof value === "string") return value;
  if (typeof value === "object" && value !== null) {
    const primary = (value as { primary?: unknown }).primary;
    if (typeof primary === "string") return primary;
  }
  return undefined;
}

/**
 * 解析 agent 的 cron 模型。
 * 优先级：显式请求 → openclaw.json agent 配置 → openclaw.json defaults → undefined（让 OpenClaw 选默认）。
 * 值 "default" 被视为"未指定"，等同于 undefined。
 */
async function resolveAgentCronModel(agentId: string, requestedModel?: string): Promise<string | undefined> {
  // 如果有明确的模型名（非 "default"），直接使用
  if (requestedModel && requestedModel !== "default") {
    return requestedModel;
  }

  // 尝试从 openclaw.json 读取该 agent 或全局默认的模型配置
  try {
    const { config } = await readOpenClawConfig();
    const agents = config.agents?.list;
    if (Array.isArray(agents)) {
      const entry = agents.find((a: any) => a?.id === agentId);
      const configured = extractModel(entry?.model);
      if (configured && configured !== "default") return configured;
    }

    const defaults = config.agents?.defaults;
    const fallback = extractModel(defaults?.model);
    if (fallback && fallback !== "default") return fallback;
  } catch {
    // best-effort — fallback below
  }

  // 返回 undefined 而非 "default"，让 OpenClaw 使用其全局默认模型
  return undefined;
}

/**
 * 构建轮询 prompt — 两阶段模式的第一阶段。
 *
 * 指导 agent：
 *   1. 运行 `step peek` 轻量检查
 *   2. 如果 NO_WORK → HEARTBEAT_OK 并结束
 *   3. 如果 HAS_WORK → `step claim` → sessions_spawn 启动工作会话
 *
 * 使用廉价的轮询模型执行，避免空闲时浪费昂贵模型的 token。
 *
 * 模型选择策略（三级优先级）：
 *   claim JSON 中的 model 字段 → fallbackWorkModel 参数 → "default"
 *   这允许每个 step 在 workflow.yml 中指定不同的模型，
 *   例如 plan/implement/review 用强模型，setup/pr 用标准模型。
 */
export function buildPollingPrompt(workflowId: string, agentId: string, fallbackWorkModel?: string): string {
  const fullAgentId = `${workflowId}_${agentId}`;
  const cli = resolveAntfarmCli();
  const workPrompt = buildWorkPrompt(workflowId, agentId);

  // 构建模型指令：优先用 claim JSON 中的 model，其次用 fallback，都没有则不指定
  const modelInstruction = fallbackWorkModel
    ? `- model: Use the "model" field from the claim JSON if present; otherwise use "${fallbackWorkModel}"`
    : `- model: Use the "model" field from the claim JSON if present; otherwise omit the model parameter (let OpenClaw use its default)`;

  return `Step 1 — Quick check for pending work (lightweight, no side effects):
\`\`\`
node ${cli} step peek "${fullAgentId}"
\`\`\`
If output is "NO_WORK", reply HEARTBEAT_OK and stop immediately. Do NOT run step claim.

Step 2 — If "HAS_WORK", claim the step:
\`\`\`
node ${cli} step claim "${fullAgentId}"
\`\`\`
If output is "NO_WORK", reply HEARTBEAT_OK and stop.

If JSON is returned, parse it to extract stepId, runId, input, and optional model fields.
Then call sessions_spawn with these parameters:
- agentId: "${fullAgentId}"
${modelInstruction}
- task: The full work prompt below, followed by "\\n\\nCLAIMED STEP JSON:\\n" and the exact JSON output from step claim.

Full work prompt to include in the spawned task:
---START WORK PROMPT---
${workPrompt}
---END WORK PROMPT---

Reply with a short summary of what you spawned.`;
}

/**
 * 为工作流的所有 agent 创建 cron 轮询作业。
 * 每个 agent 的 cron 间隔错开 1 分钟（anchorMs），避免同时触发造成竞争。
 */
export async function setupAgentCrons(workflow: WorkflowSpec): Promise<void> {
  const agents = workflow.agents;
  // Allow per-workflow cron interval via cron.interval_ms in workflow.yml
  const everyMs = (workflow as any).cron?.interval_ms ?? DEFAULT_EVERY_MS;

  // Resolve polling model: per-agent > workflow-level > default
  const workflowPollingModel = workflow.polling?.model ?? DEFAULT_POLLING_MODEL;
  const workflowPollingTimeout = workflow.polling?.timeoutSeconds ?? DEFAULT_POLLING_TIMEOUT_SECONDS;

  for (let i = 0; i < agents.length; i++) {
    const agent = agents[i];
    const anchorMs = i * 60_000; // stagger by 1 minute each
    const cronName = `antfarm/${workflow.id}/${agent.id}`;
    const agentId = `${workflow.id}_${agent.id}`;

    // Two-phase: Phase 1 uses cheap polling model + minimal prompt
    const requestedPollingModel = agent.pollingModel ?? workflowPollingModel;
    const pollingModel = await resolveAgentCronModel(agentId, requestedPollingModel);
    const requestedWorkModel = agent.model ?? workflowPollingModel;
    const workModel = await resolveAgentCronModel(agentId, requestedWorkModel);
    const prompt = buildPollingPrompt(workflow.id, agent.id, workModel);
    const timeoutSeconds = workflowPollingTimeout;

    const payload: { kind: string; message: string; model?: string; timeoutSeconds?: number } = {
      kind: "agentTurn",
      message: prompt,
      timeoutSeconds,
    };
    // 仅当有明确模型时才传 model 字段，避免传 "default" 导致 OpenClaw 报错
    if (pollingModel) payload.model = pollingModel;

    const result = await createAgentCronJob({
      name: cronName,
      schedule: { kind: "every", everyMs, anchorMs },
      sessionTarget: "isolated",
      agentId,
      payload,
      delivery: { mode: "none" },
      enabled: true,
    });

    if (!result.ok) {
      throw new Error(`Failed to create cron job for agent "${agent.id}": ${result.error}`);
    }
  }
}

export async function removeAgentCrons(workflowId: string): Promise<void> {
  await deleteAgentCronJobs(`antfarm/${workflowId}/`);
}

// ── Run-scoped cron lifecycle ───────────────────────────────────────

/**
 * Count active (running) runs for a given workflow.
 */
function countActiveRuns(workflowId: string): number {
  const db = getDb();
  const row = db.prepare(
    "SELECT COUNT(*) as cnt FROM runs WHERE workflow_id = ? AND status = 'running'"
  ).get(workflowId) as { cnt: number };
  return row.cnt;
}

/**
 * Check if crons already exist for a workflow.
 */
async function workflowCronsExist(workflowId: string): Promise<boolean> {
  const result = await listCronJobs();
  if (!result.ok || !result.jobs) return false;
  const prefix = `antfarm/${workflowId}/`;
  return result.jobs.some((j) => j.name.startsWith(prefix));
}

/**
 * Start crons for a workflow when a run begins.
 * No-ops if crons already exist (another run of the same workflow is active).
 */
export async function ensureWorkflowCrons(workflow: WorkflowSpec): Promise<void> {
  if (await workflowCronsExist(workflow.id)) return;

  // Preflight: verify cron tool is accessible before attempting to create jobs
  const preflight = await checkCronToolAvailable();
  if (!preflight.ok) {
    throw new Error(preflight.error!);
  }

  await setupAgentCrons(workflow);
}

/**
 * Tear down crons for a workflow when a run ends.
 * Only removes if no other active runs exist for this workflow.
 */
export async function teardownWorkflowCronsIfIdle(workflowId: string): Promise<void> {
  const active = countActiveRuns(workflowId);
  if (active > 0) return;
  await removeAgentCrons(workflowId);
}
