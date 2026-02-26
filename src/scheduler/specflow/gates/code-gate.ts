import { getChangedFiles } from '../infra/worktree.ts';

/**
 * Files/directories excluded from source code change detection.
 * If all changed files match these patterns, the code gate fails
 * (PR would contain only spec artifacts, not implementation).
 */
export const CODE_GATE_EXCLUSIONS = [
  '.specify/',
  'CHANGELOG.md',
  'Plans/',
  'docs/',
  'README.md',
  '.claude/',
  'verify.md',
  '.specflow/',
];

export interface CodeGateResult {
  passed: boolean;
  changedFiles: string[];
  sourceFiles: string[];
  reason: string;
}

/**
 * Check that the worktree contains real source code changes (not just spec artifacts).
 * Runs git diff and filters out documentation-only files.
 *
 * Directly fixes FM-3: docs-only PRs slip through because spec artifacts pass the old filter.
 */
export async function checkCodeGate(
  worktreePath: string,
  mainBranch: string,
): Promise<CodeGateResult> {
  let changedFiles: string[];
  try {
    changedFiles = await getChangedFiles(worktreePath, mainBranch);
  } catch (err) {
    return {
      passed: false,
      changedFiles: [],
      sourceFiles: [],
      reason: `Failed to get changed files: ${err}`,
    };
  }

  const sourceFiles = changedFiles.filter(
    (f) => !CODE_GATE_EXCLUSIONS.some((excl) => f.startsWith(excl) || f === excl.replace(/\/$/, '')),
  );

  const passed = sourceFiles.length > 0;
  return {
    passed,
    changedFiles,
    sourceFiles,
    reason: passed
      ? `${sourceFiles.length} source file(s) changed`
      : `No source files changed (only spec/docs: ${changedFiles.join(', ') || 'empty diff'})`,
  };
}
