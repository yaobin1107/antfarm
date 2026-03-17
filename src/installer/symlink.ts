/**
 * CLI 符号链接管理 — 确保 `antfarm` 命令在 PATH 中可用。
 *
 * 在 ~/.local/bin/ 创建指向 dist/cli/cli.js 的符号链接。
 * 幂等操作：重复调用跳过已正确的链接，更新过时的链接，
 * 不覆盖用户手动创建的非符号链接文件。
 */
import { existsSync, mkdirSync, symlinkSync, unlinkSync, readlinkSync, lstatSync } from "fs";
import { join } from "path";
import { fileURLToPath } from "url";

const BINARY_NAME = "antfarm";

/**
 * Ensure `antfarm` is available on PATH by symlinking into ~/.local/bin.
 * Safe to call repeatedly — skips if already correct, updates if stale.
 */
export function ensureCliSymlink(): void {
  const home = process.env.HOME;
  if (!home) return;

  const localBin = join(home, ".local", "bin");
  const linkPath = join(localBin, BINARY_NAME);

  // Resolve the actual CLI entry point (dist/cli/cli.js)
  const cliEntry = join(
    fileURLToPath(import.meta.url),
    "..",
    "..",
    "cli",
    "cli.js",
  );

  try {
    mkdirSync(localBin, { recursive: true });
  } catch {
    // already exists
  }

  // Check existing path
  if (existsSync(linkPath)) {
    try {
      const stats = lstatSync(linkPath);
      if (!stats.isSymbolicLink()) {
        // Don't overwrite user-created files (e.g. bash wrappers for node resolution)
        console.warn(`  ⚠ ${linkPath} exists and is not a symlink — skipping (remove it manually to let antfarm manage it)`);
        return;
      }
      const current = readlinkSync(linkPath);
      if (current === cliEntry) return; // already correct
    } catch {
      // unreadable — skip to be safe
      return;
    }
    try {
      unlinkSync(linkPath);
    } catch {
      console.warn(`  ⚠ Could not update symlink at ${linkPath}`);
      return;
    }
  }

  try {
    symlinkSync(cliEntry, linkPath);
    console.log(`  ✓ Symlinked ${BINARY_NAME} → ${localBin}`);
  } catch (err) {
    console.warn(`  ⚠ Could not create symlink: ${err instanceof Error ? err.message : String(err)}`);
  }
}

/**
 * Remove the CLI symlink (used during uninstall).
 */
export function removeCliSymlink(): void {
  const home = process.env.HOME;
  if (!home) return;

  const linkPath = join(home, ".local", "bin", BINARY_NAME);
  if (existsSync(linkPath)) {
    try {
      unlinkSync(linkPath);
      console.log(`  ✓ Removed symlink ${linkPath}`);
    } catch {
      console.warn(`  ⚠ Could not remove symlink at ${linkPath}`);
    }
  }
}
