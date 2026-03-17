/**
 * Medic Cron 管理 — 安装/卸载 Medic 看门狗的定时检查 cron 作业。
 *
 * Medic 每 5 分钟运行一次健康检查，通过 OpenClaw 的 cron 工具触发。
 * 检查发现问题后可自动修复（重置卡住的步骤）或上报到主 agent 会话。
 */
import { createAgentCronJob, deleteCronJob, listCronJobs } from "../installer/gateway-api.js";
import { resolveAntfarmCli } from "../installer/paths.js";
import { readOpenClawConfig, writeOpenClawConfig } from "../installer/openclaw-config.js";

const MEDIC_CRON_NAME = "antfarm/medic";
const MEDIC_EVERY_MS = 5 * 60 * 1000; // 5 minutes
const MEDIC_MODEL = "default";
const MEDIC_TIMEOUT_SECONDS = 120;

function buildMedicPrompt(): string {
  const cli = resolveAntfarmCli();
  return `You are the Antfarm Medic — a health watchdog for workflow runs.

Run the medic check:
\`\`\`
node ${cli} medic run --json
\`\`\`

If the check output contains "issuesFound": 0, reply HEARTBEAT_OK and stop.
If issues were found, summarize what was detected and what actions were taken.

If there are critical unremediated issues, use sessions_send to alert the main session:
\`\`\`
sessions_send(sessionKey: "agent:main:main", message: "🚑 Antfarm Medic Alert: <summary of critical issues>")
\`\`\`

Do NOT attempt to fix issues yourself beyond what the medic check already handles.`;
}

async function ensureMedicAgent(): Promise<void> {
  try {
    const { path, config } = await readOpenClawConfig();
    const agents = config.agents?.list ?? [];
    if (agents.some((a: any) => a.id === "antfarm-medic")) return;

    if (!config.agents) config.agents = {};
    if (!config.agents.list) config.agents.list = [];
    config.agents.list.push({
      id: "antfarm-medic",
      name: "Antfarm Medic",
      model: MEDIC_MODEL,
    });
    await writeOpenClawConfig(path, config);
  } catch {
    // best-effort — cron will still work without agent provisioning
  }
}

async function removeMedicAgent(): Promise<void> {
  try {
    const { path, config } = await readOpenClawConfig();
    const agents = config.agents?.list ?? [];
    const idx = agents.findIndex((a: any) => a.id === "antfarm-medic");
    if (idx === -1) return;
    agents.splice(idx, 1);
    await writeOpenClawConfig(path, config);
  } catch {
    // best-effort
  }
}

export async function installMedicCron(): Promise<{ ok: boolean; error?: string }> {
  // Check if already installed
  const existing = await findMedicCronJob();
  if (existing) {
    return { ok: true }; // already installed
  }

  // Ensure agent is provisioned in OpenClaw config
  await ensureMedicAgent();

  const result = await createAgentCronJob({
    name: MEDIC_CRON_NAME,
    schedule: { kind: "every", everyMs: MEDIC_EVERY_MS },
    sessionTarget: "isolated",
    agentId: "antfarm-medic",
    payload: {
      kind: "agentTurn",
      message: buildMedicPrompt(),
      model: MEDIC_MODEL,
      timeoutSeconds: MEDIC_TIMEOUT_SECONDS,
    },
    delivery: { mode: "none" },
    enabled: true,
  });

  return result;
}

export async function uninstallMedicCron(): Promise<{ ok: boolean; error?: string }> {
  const job = await findMedicCronJob();
  if (!job) {
    await removeMedicAgent();
    return { ok: true }; // nothing to remove
  }
  const result = await deleteCronJob(job.id);
  if (result.ok) {
    await removeMedicAgent();
  }
  return result;
}

export async function isMedicCronInstalled(): Promise<boolean> {
  const job = await findMedicCronJob();
  return job !== null;
}

async function findMedicCronJob(): Promise<{ id: string; name: string } | null> {
  const result = await listCronJobs();
  if (!result.ok || !result.jobs) return null;
  return result.jobs.find(j => j.name === MEDIC_CRON_NAME) ?? null;
}
