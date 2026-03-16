/**
 * 子代理白名单管理 — 控制 OpenClaw 中哪些 agent 可以相互调用。
 *
 * Antfarm 的两阶段轮询需要轮询 agent 通过 sessions_spawn 启动工作 agent，
 * 因此必须在 tools.agentToAgent.allow 中注册所有工作流 agent。
 * 如果用户已配置 "*"（允许全部），则跳过修改。
 */
type AgentToAgentConfig = {
  enabled?: boolean;
  allow?: string[];
};

type ToolsConfig = {
  agentToAgent?: AgentToAgentConfig;
};

// Use Record to allow additional properties from the full config
type OpenClawConfig = Record<string, unknown> & {
  tools?: ToolsConfig;
};

function normalizeAllow(value: unknown): string[] {
  if (!Array.isArray(value)) {
    return [];
  }
  return value.filter((entry): entry is string => typeof entry === "string");
}

function uniq(values: string[]): string[] {
  return Array.from(new Set(values));
}

function ensureAgentToAgent(config: OpenClawConfig): AgentToAgentConfig {
  if (!config.tools) {
    config.tools = {};
  }
  if (!config.tools.agentToAgent) {
    config.tools.agentToAgent = { enabled: true };
  }
  return config.tools.agentToAgent;
}

export function addSubagentAllowlist(config: OpenClawConfig, agentIds: string[]): void {
  if (agentIds.length === 0) {
    return;
  }
  const agentToAgent = ensureAgentToAgent(config);
  const existing = normalizeAllow(agentToAgent.allow);
  // If "*" is in the list, all agents are already allowed
  if (existing.includes("*")) {
    return;
  }
  agentToAgent.allow = uniq([...existing, ...agentIds]);
}

export function removeSubagentAllowlist(config: OpenClawConfig, agentIds: string[]): void {
  if (agentIds.length === 0) {
    return;
  }
  const agentToAgent = ensureAgentToAgent(config);
  const existing = normalizeAllow(agentToAgent.allow);
  if (existing.includes("*")) {
    return;
  }
  const next = existing.filter((entry) => !agentIds.includes(entry));
  agentToAgent.allow = next.length > 0 ? next : undefined;
}
