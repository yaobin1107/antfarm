/**
 * Antfarm 技能安装 — 将 antfarm-workflows 技能部署到用户的 OpenClaw 技能目录。
 *
 * 技能文件（SKILL.md）提供给用户的主 agent 使用，包含工作流操作的参考文档。
 * 安装路径：~/.openclaw/skills/antfarm-workflows/SKILL.md
 */
import fs from "node:fs/promises";
import path from "node:path";
import os from "node:os";

/**
 * Get the path to the antfarm skills directory (bundled with antfarm).
 */
function getAntfarmSkillsDir(): string {
  // Skills are in the antfarm package under skills/
  return path.join(import.meta.dirname, "..", "..", "skills");
}

/**
 * Get the user's OpenClaw skills directory.
 */
function getUserSkillsDir(): string {
  return path.join(os.homedir(), ".openclaw", "skills");
}

/**
 * Install the antfarm-workflows skill to the user's skills directory.
 */
export async function installAntfarmSkill(): Promise<{ installed: boolean; path: string }> {
  const srcDir = path.join(getAntfarmSkillsDir(), "antfarm-workflows");
  const destDir = path.join(getUserSkillsDir(), "antfarm-workflows");
  
  // Ensure user skills directory exists
  await fs.mkdir(getUserSkillsDir(), { recursive: true });
  
  // Copy skill files
  try {
    // Check if source exists
    await fs.access(srcDir);
    
    // Create destination directory
    await fs.mkdir(destDir, { recursive: true });
    
    // Copy SKILL.md
    const skillContent = await fs.readFile(path.join(srcDir, "SKILL.md"), "utf-8");
    await fs.writeFile(path.join(destDir, "SKILL.md"), skillContent, "utf-8");
    
    return { installed: true, path: destDir };
  } catch (err) {
    // Source doesn't exist or copy failed
    return { installed: false, path: destDir };
  }
}

/**
 * Uninstall the antfarm-workflows skill from the user's skills directory.
 */
export async function uninstallAntfarmSkill(): Promise<void> {
  const destDir = path.join(getUserSkillsDir(), "antfarm-workflows");
  
  try {
    await fs.rm(destDir, { recursive: true, force: true });
  } catch {
    // Already gone
  }
}
