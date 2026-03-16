/**
 * 前端变更检测器 — 判断一组文件变更是否涉及前端代码。
 *
 * 用于 verify / review 步骤中条件性地触发浏览器视觉检查。
 * 检测依据：文件扩展名（.html .css .jsx .tsx .vue .svelte）和目录名（components/ pages/ 等）。
 * 忽略测试文件（.test. .spec. __tests__/），因为测试文件的变更不需要视觉验证。
 */

const FRONTEND_EXTENSIONS = new Set([
  '.html', '.css', '.scss', '.less', '.jsx', '.tsx', '.vue', '.svelte',
]);

const FRONTEND_DIRS = [
  'public/', 'static/', 'assets/', 'components/', 'pages/', 'views/', 'styles/',
];

const TEST_PATTERNS = ['.test.', '.spec.', '__tests__/'];

function isTestFile(file: string): boolean {
  return TEST_PATTERNS.some(p => file.includes(p));
}

/**
 * Returns true if any of the given file paths represent frontend changes.
 * Ignores test files even if they have frontend extensions.
 */
export function isFrontendChange(files: string[]): boolean {
  return files.some(file => {
    if (isTestFile(file)) return false;

    // Check extension
    const dot = file.lastIndexOf('.');
    if (dot !== -1) {
      const ext = file.slice(dot).toLowerCase();
      if (FRONTEND_EXTENSIONS.has(ext)) return true;
    }

    // Check directory
    const normalized = file.replace(/\\/g, '/');
    return FRONTEND_DIRS.some(dir => normalized.includes(`/${dir}`) || normalized.startsWith(dir));
  });
}
