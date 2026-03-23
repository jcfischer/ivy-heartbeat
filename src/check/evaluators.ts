import type { ChecklistItem, CheckType } from '../parser/types.ts';
import type { CheckResult } from './types.ts';
import { evaluateEmail } from '../evaluators/email.ts';
import { evaluateCalendar } from '../evaluators/calendar.ts';
import { evaluateGithubIssues } from '../evaluators/github-issues.ts';
import { evaluateAgentDispatch } from '../evaluators/agent-dispatch.ts';
import { evaluateSpecFlowCleanup } from '../evaluators/specflow-cleanup.ts';
import { evaluateTanaTodos } from '../evaluators/tana-todos.ts';
import { evaluateGithubIssueWatcher } from '../evaluators/github-issue-watcher.ts';
import { evaluateGithubPrReview } from '../evaluators/github-pr-review.ts';
import { evaluateSpecFlowOrchestrate } from '../evaluators/specflow-orchestrate.ts';
import { evaluateAgentWatchdog } from '../evaluators/agent-watchdog.ts';
import { evaluateExperimentTracker } from '../evaluators/experiment-tracker.ts';
import { evaluateLadderBridge } from '../evaluators/ladder-bridge.ts';

export type Evaluator = (item: ChecklistItem) => Promise<CheckResult>;

/**
 * Evaluator registry.
 */
const evaluators: Record<CheckType, Evaluator> = {
  calendar: evaluateCalendar,

  email: evaluateEmail,

  github_issues: evaluateGithubIssues,

  github_issue_watcher: evaluateGithubIssueWatcher,

  github_pr_review: evaluateGithubPrReview,

  tana_todos: evaluateTanaTodos,

  agent_dispatch: evaluateAgentDispatch,

  agent_watchdog: evaluateAgentWatchdog,

  specflow_cleanup: evaluateSpecFlowCleanup,

  specflow_orchestrate: evaluateSpecFlowOrchestrate,

  experiment_tracker: evaluateExperimentTracker,

  ladder_bridge: evaluateLadderBridge,

  custom: async (item) => ({
    item,
    status: 'ok',
    summary: `Custom check: ${item.name} (stub — ok)`,
  }),
};

/**
 * Get the evaluator for a check type.
 */
export function getEvaluator(type: CheckType): Evaluator {
  return evaluators[type];
}

/**
 * Register a custom evaluator (for testing or future override).
 */
export function registerEvaluator(type: CheckType, evaluator: Evaluator): void {
  evaluators[type] = evaluator;
}
