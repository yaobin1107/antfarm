/**
 * OpenClaw 配置读写 — 管理 openclaw.json 的序列化/反序列化。
 *
 * 使用 JSON5 解析（支持注释和尾逗号），但写入时使用标准 JSON。
 * 类型约束覆盖 Antfarm 需要操作的配置字段（agents、cron、session、tools）。
 */
/**
 * OpenClaw 配置文件读写 — 操作 openclaw.json（JSON5 格式）。
 *
 * openclaw.json 是 OpenClaw 平台的核心配置文件，Antfarm 在安装/卸载时
 * 修改其中的 agents.list、tools.agentToAgent、cron、session 等配置节。
 * 使用 JSON5 解析以兼容用户手写的注释和尾逗号。
 */
import fs from "node:fs/promises";
import JSON5 from "json5";
import { resolveOpenClawConfigPath } from "./paths.js";

export type OpenClawConfig = {
  cron?: {
    sessionRetention?: string | false;
  };
  session?: {
    maintenance?: {
      mode?: "enforce" | "warn";
      pruneAfter?: string | number;
      pruneDays?: number;
      maxEntries?: number;
      rotateBytes?: number | string;
    };
  };
  agents?: {
    defaults?: {
      model?: string | { primary?: string };
      subagents?: {
        allowAgents?: string[];
      };
    };
    list?: Array<Record<string, unknown>>;
  };
};

export async function readOpenClawConfig(): Promise<{ path: string; config: OpenClawConfig }> {
  const path = resolveOpenClawConfigPath();
  try {
    const raw = await fs.readFile(path, "utf-8");
    const config = JSON5.parse(raw) as OpenClawConfig;
    return { path, config };
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    throw new Error(`Failed to read OpenClaw config at ${path}: ${message}`);
  }
}

export async function writeOpenClawConfig(
  path: string,
  config: OpenClawConfig,
): Promise<void> {
  const content = `${JSON.stringify(config, null, 2)}\n`;
  await fs.writeFile(path, content, "utf-8");
}
