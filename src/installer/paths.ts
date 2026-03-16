/**
 * 路径解析器 — 统一管理 Antfarm 各目录的路径计算。
 *
 * 目录结构：
 *   ~/.openclaw/
 *     ├─ openclaw.json                    OpenClaw 主配置
 *     ├─ antfarm/
 *     │   ├─ antfarm.db                   SQLite 数据库
 *     │   ├─ events.jsonl                 事件日志
 *     │   ├─ logs/workflow.log            运行时日志
 *     │   ├─ dashboard.pid                Dashboard PID 文件
 *     │   └─ workflows/<id>/             安装的工作流定义
 *     ├─ workspaces/workflows/<id>/       Agent 工作空间
 *     ├─ agents/<agent_id>/agent/         Agent 元数据
 *     └─ skills/                          用户技能目录
 *
 * 支持环境变量覆盖：
 *   OPENCLAW_STATE_DIR    → 覆盖 ~/.openclaw
 *   OPENCLAW_CONFIG_PATH  → 覆盖 openclaw.json 路径
 */
/**
 * 路径解析器 — Antfarm 所有文件系统路径的集中管理。
 *
 * 目录结构：
 *   ~/.openclaw/                          OpenClaw 主目录
 *     ├─ openclaw.json                    OpenClaw 配置文件
 *     ├─ antfarm/                         Antfarm 运行时数据
 *     │   ├─ antfarm.db                   SQLite 数据库
 *     │   ├─ events.jsonl                 事件日志
 *     │   ├─ dashboard.pid                Dashboard 进程 PID
 *     │   ├─ logs/workflow.log            运行日志
 *     │   └─ workflows/                   已安装的工作流副本
 *     │       ├─ feature-dev/
 *     │       ├─ bug-fix/
 *     │       └─ security-audit/
 *     ├─ workspaces/workflows/            Agent 工作空间
 *     └─ agents/                          Agent 配置目录
 *
 * 支持通过环境变量覆盖：
 *   OPENCLAW_STATE_DIR    → 自定义 .openclaw 目录
 *   OPENCLAW_CONFIG_PATH  → 自定义 openclaw.json 路径
 */
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";

const __dirname = path.dirname(fileURLToPath(import.meta.url));

// Bundled workflows ship with antfarm (in the repo's workflows/ directory)
export function resolveBundledWorkflowsDir(): string {
  // From dist/installer/paths.js -> ../../workflows
  return path.resolve(__dirname, "..", "..", "workflows");
}

export function resolveBundledWorkflowDir(workflowId: string): string {
  return path.join(resolveBundledWorkflowsDir(), workflowId);
}

export function resolveOpenClawStateDir(): string {
  const env = process.env.OPENCLAW_STATE_DIR?.trim();
  if (env) {
    return env;
  }
  return path.join(os.homedir(), ".openclaw");
}

export function resolveOpenClawConfigPath(): string {
  const env = process.env.OPENCLAW_CONFIG_PATH?.trim();
  if (env) {
    return env;
  }
  return path.join(resolveOpenClawStateDir(), "openclaw.json");
}

export function resolveAntfarmRoot(): string {
  return path.join(resolveOpenClawStateDir(), "antfarm");
}

export function resolveWorkflowRoot(): string {
  return path.join(resolveAntfarmRoot(), "workflows");
}

export function resolveWorkflowDir(workflowId: string): string {
  return path.join(resolveWorkflowRoot(), workflowId);
}

export function resolveWorkflowWorkspaceRoot(): string {
  return path.join(resolveOpenClawStateDir(), "workspaces", "workflows");
}

export function resolveWorkflowWorkspaceDir(workflowId: string): string {
  return path.join(resolveWorkflowWorkspaceRoot(), workflowId);
}

export function resolveRunRoot(): string {
  return path.join(resolveAntfarmRoot(), "runs");
}

export function resolveAntfarmCli(): string {
  // From dist/installer/paths.js -> ../../dist/cli/cli.js
  return path.resolve(__dirname, "..", "cli", "cli.js");
}
