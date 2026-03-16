/**
 * 主 Agent 引导文件管理 — 在用户主 agent 的 AGENTS.md 和 TOOLS.md 中注入/移除 Antfarm 操作指引。
 *
 * 使用 HTML 注释标记（<!-- antfarm:workflows -->）界定 Antfarm 管理的区域，
 * 确保更新操作幂等且不会破坏用户自定义的内容。
 */
/**
 * 主 Agent 指引注入 — 在用户的主 agent 工作空间中维护 Antfarm 操作说明。
 *
 * 安装时：在 AGENTS.md 和 TOOLS.md 中插入 <!-- antfarm:workflows --> 标记块，
 *         包含 Antfarm CLI 命令参考和工作流操作策略。
 * 卸载时：移除这些标记块，不影响用户自己的内容。
 *
 * 采用 upsert 语义：重复调用会更新而非重复追加。
 */
import fs from "node:fs/promises";
import path from "node:path";
import { readOpenClawConfig } from "./openclaw-config.js";

const WORKFLOW_BLOCK_START = "<!-- antfarm:workflows -->";
const WORKFLOW_BLOCK_END = "<!-- /antfarm:workflows -->";

const CLI = "node ~/.openclaw/workspace/antfarm/dist/cli/cli.js";

const TOOLS_BLOCK = `${WORKFLOW_BLOCK_START}
# Antfarm Workflows

Antfarm CLI (always use full path to avoid PATH issues):
\`${CLI}\`

Commands:
- Install: \`${CLI} workflow install <name>\`
- Run: \`${CLI} workflow run <workflow-id> "<task>"\`
- Status: \`${CLI} workflow status "<task title>"\`
- Logs: \`${CLI} logs\`

Workflows are self-advancing via per-agent cron jobs. No manual orchestration needed.
${WORKFLOW_BLOCK_END}
`;

const AGENTS_BLOCK = `${WORKFLOW_BLOCK_START}
# Antfarm Workflow Policy

## Installing Workflows
Run: \`${CLI} workflow install <name>\`
Agent cron jobs are created automatically during install.

## Running Workflows
- Start: \`${CLI} workflow run <workflow-id> "<task>"\`
- Status: \`${CLI} workflow status "<task title>"\`
- Workflows self-advance via agent cron jobs polling SQLite for pending steps.
${WORKFLOW_BLOCK_END}
`;

function removeBlock(content: string): string {
  const start = content.indexOf(WORKFLOW_BLOCK_START);
  const end = content.indexOf(WORKFLOW_BLOCK_END);
  if (start === -1 || end === -1) return content;
  const after = end + WORKFLOW_BLOCK_END.length;
  const beforeText = content.slice(0, start).trimEnd();
  const afterText = content.slice(after).trimStart();
  if (!beforeText) return afterText ? `${afterText}\n` : "";
  if (!afterText) return `${beforeText}\n`;
  return `${beforeText}\n\n${afterText}\n`;
}

function upsertBlock(content: string, block: string): string {
  const cleaned = removeBlock(content);
  if (!cleaned.trim()) return `${block}\n`;
  return `${cleaned.trimEnd()}\n\n${block}\n`;
}

async function readFileOrEmpty(filePath: string): Promise<string> {
  try { return await fs.readFile(filePath, "utf-8"); } catch { return ""; }
}

function resolveMainAgentWorkspacePath(cfg: { agents?: { defaults?: { workspace?: string } } }) {
  const workspace = cfg.agents?.defaults?.workspace?.trim();
  if (workspace) return workspace;
  return path.join(process.env.HOME ?? "", ".openclaw", "workspace");
}

export async function updateMainAgentGuidance(): Promise<void> {
  const { config } = await readOpenClawConfig();
  const workspaceDir = resolveMainAgentWorkspacePath(config as { agents?: { defaults?: { workspace?: string } } });
  const toolsPath = path.join(workspaceDir, "TOOLS.md");
  const agentsPath = path.join(workspaceDir, "AGENTS.md");

  const toolsContent = await readFileOrEmpty(toolsPath);
  const agentsContent = await readFileOrEmpty(agentsPath);

  await fs.mkdir(workspaceDir, { recursive: true });
  await fs.writeFile(toolsPath, upsertBlock(toolsContent, TOOLS_BLOCK), "utf-8");
  await fs.writeFile(agentsPath, upsertBlock(agentsContent, AGENTS_BLOCK), "utf-8");
}

export async function removeMainAgentGuidance(): Promise<void> {
  const { config } = await readOpenClawConfig();
  const workspaceDir = resolveMainAgentWorkspacePath(config as { agents?: { defaults?: { workspace?: string } } });
  const toolsPath = path.join(workspaceDir, "TOOLS.md");
  const agentsPath = path.join(workspaceDir, "AGENTS.md");

  const toolsContent = await readFileOrEmpty(toolsPath);
  const agentsContent = await readFileOrEmpty(agentsPath);

  if (toolsContent) await fs.writeFile(toolsPath, removeBlock(toolsContent), "utf-8");
  if (agentsContent) await fs.writeFile(agentsPath, removeBlock(agentsContent), "utf-8");
}
