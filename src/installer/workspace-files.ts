/**
 * 工作空间文件写入 — 安全地将引导文件复制到 agent 工作空间。
 *
 * 默认不覆盖已存在的文件（保护用户自定义修改）。
 * 通过 overwrite 参数可强制更新。
 */
import fs from "node:fs/promises";
import path from "node:path";

export type WorkflowFileWriteResult = {
  path: string;
  status: "created" | "skipped" | "updated";
};

async function ensureDir(dir: string): Promise<void> {
  await fs.mkdir(dir, { recursive: true });
}

async function readFileIfExists(filePath: string): Promise<string | null> {
  try {
    return await fs.readFile(filePath, "utf-8");
  } catch {
    return null;
  }
}

export async function writeWorkflowFile(params: {
  destination: string;
  source: string;
  overwrite: boolean;
}): Promise<WorkflowFileWriteResult> {
  const destination = params.destination;
  const existing = await readFileIfExists(destination);
  if (existing !== null && !params.overwrite) {
    return { path: destination, status: "skipped" };
  }
  await ensureDir(path.dirname(destination));
  await fs.copyFile(params.source, destination);
  return { path: destination, status: existing === null ? "created" : "updated" };
}
