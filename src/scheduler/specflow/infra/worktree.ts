/**
 * Re-exports from the worktree module for use by orchestrator components.
 * Phase executors import from here to stay decoupled from the runner layer.
 */
export {
  createWorktree,
  ensureWorktree,
  removeWorktree,
  commitAll,
  commitFiles,
  pushBranch,
  createPR,
  getCurrentBranch,
  hasCommitsAhead,
  isCleanBranch,
  getDiffSummary,
  getChangedFiles,
} from '../../worktree.ts';
