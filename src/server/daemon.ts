#!/usr/bin/env node
/**
 * Dashboard 守护进程入口 — 由 daemonctl.ts 以 detached 模式启动。
 * 写入 PID 文件以便后续停止/状态查询，并处理 SIGTERM 清理。
 */
import fs from "node:fs";
import path from "node:path";
import os from "node:os";
import { startDashboard } from "./dashboard.js";

const port = parseInt(process.argv[2], 10) || 3333;

const pidDir = path.join(os.homedir(), ".openclaw", "antfarm");
const pidFile = path.join(pidDir, "dashboard.pid");

fs.mkdirSync(pidDir, { recursive: true });
fs.writeFileSync(pidFile, String(process.pid));

process.on("SIGTERM", () => {
  try { fs.unlinkSync(pidFile); } catch {}
  process.exit(0);
});

startDashboard(port);
