import { readFileSync, existsSync } from 'node:fs';
import { join } from 'node:path';
import type { Blackboard } from '../blackboard.ts';
import type { BlackboardWorkItem } from 'ivy-blackboard/src/types';
import { getLauncher, logPathForSession } from './launcher.ts';
import { createReworkWorkItem } from './rework.ts';
import { createPRMergeWorkItem } from './pr-merge.ts';
import type { BlockingIssue } from './types.ts';

interface ReviewContext {
  prNumber: number;
  repo: string;
  branch: string;
  projectPath: string;
  specPath?: string;
  priorBlockingIssues?: BlockingIssue[];
}

/**
 * Metadata shape for code review work items.
 * Contains PR information and blocking issues from prior review cycles.
 */
export interface ReviewMetadata {
  pr_number: number;
  pr_url?: string;
  repo: string;
  branch: string;
  main_branch?: string;
  implementation_work_item_id?: string;
  rework_cycle?: number;
  worktree_path?: string;
  review_status?: string | null;
  blocking_issues?: BlockingIssue[];
  /**
   * When true, the PR was created for an issue opened by someone other than
   * the repo owner. Review still runs, but approval does NOT auto-create a
   * merge work item — Jens-Christian must merge manually.
   */
  human_review_required?: boolean;
}

/**
 * Parse work item metadata to extract review fields.
 * Returns null if the metadata does not represent a review item.
 */
export function parseReviewMeta(metadata: string | null): ReviewMetadata | null {
  if (!metadata) return null;
  try {
    const parsed = JSON.parse(metadata);
    // A review item must have at minimum: pr_number and repo
    // source='code_review' is the primary indicator, but we check required fields
    if (parsed.pr_number && parsed.repo) {
      return {
        pr_number: parsed.pr_number,
        pr_url: parsed.pr_url,
        repo: parsed.repo,
        branch: parsed.branch ?? '',
        main_branch: parsed.main_branch,
        implementation_work_item_id: parsed.implementation_work_item_id,
        rework_cycle: typeof parsed.rework_cycle === 'number' ? parsed.rework_cycle : undefined,
        worktree_path: parsed.worktree_path,
        review_status: parsed.review_status !== undefined ? parsed.review_status : undefined,
        blocking_issues: Array.isArray(parsed.blocking_issues) ? parsed.blocking_issues : undefined,
        human_review_required: typeof parsed.human_review_required === 'boolean' ? parsed.human_review_required : undefined,
      };
    }
  } catch {
    // Invalid metadata JSON
  }
  return null;
}

/**
 * Build the review agent prompt.
 * The agent reviews a PR against its spec/plan using 6 dimensions.
 */
export function buildReviewPrompt(ctx: ReviewContext): string {
  const parts: string[] = [
    `You are a code review agent for the PAI system. You are reviewing PR #${ctx.prNumber} in ${ctx.repo}.`,
    '',
  ];

  // If prior blocking issues exist, require explicit verification
  if (ctx.priorBlockingIssues && ctx.priorBlockingIssues.length > 0) {
    const unresolvedCritical = ctx.priorBlockingIssues.filter(i => !i.resolved && i.severity === 'critical');
    const unresolvedHigh = ctx.priorBlockingIssues.filter(i => !i.resolved && i.severity === 'high');
    const unresolvedOther = ctx.priorBlockingIssues.filter(i => !i.resolved && (i.severity === 'medium' || i.severity === 'low'));

    // Only show the section if there are unresolved issues
    const hasUnresolvedIssues = unresolvedCritical.length > 0 || unresolvedHigh.length > 0 || unresolvedOther.length > 0;
    if (hasUnresolvedIssues) {

    parts.push(
      '## CRITICAL: Unresolved Blocking Issues from Prior Cycles',
      '',
      '⚠️  **Prior review cycles identified blocking issues that MUST be resolved before approval.**',
      '',
      'You MUST explicitly verify each issue below is resolved. Do not approve until ALL critical',
      'and high-severity issues are addressed. If any remain unresolved, you MUST request changes.',
      '',
    );

    if (unresolvedCritical.length > 0) {
      parts.push('### Critical Issues (MUST be resolved):', '');
      unresolvedCritical.forEach((issue, idx) => {
        parts.push(`${idx + 1}. [Cycle ${issue.cycle}] ${issue.description}`);
      });
      parts.push('');
    }

    if (unresolvedHigh.length > 0) {
      parts.push('### High-Severity Issues (MUST be resolved):', '');
      unresolvedHigh.forEach((issue, idx) => {
        parts.push(`${idx + 1}. [Cycle ${issue.cycle}] ${issue.description}`);
      });
      parts.push('');
    }

    if (unresolvedOther.length > 0) {
      parts.push('### Other Issues (should be resolved):', '');
      unresolvedOther.forEach((issue, idx) => {
        parts.push(`${idx + 1}. [Cycle ${issue.cycle}] ${issue.description}`);
      });
      parts.push('');
    }

      parts.push(
        '**You MUST include in your review output:**',
        '- For each unresolved issue: whether it is NOW resolved (yes/no)',
        '- Evidence supporting your resolution determination (file/line references)',
        '',
        '---',
        '',
      );
    }
  }

  parts.push(
    '## Instructions',
    '',
    '1. First, fetch the PR diff and file list:',
    `   gh pr diff ${ctx.prNumber} --repo ${ctx.repo}`,
    `   gh pr view ${ctx.prNumber} --repo ${ctx.repo} --json files`,
    '',
  );

  // Try to include spec/plan context
  if (ctx.specPath) {
    const specFile = join(ctx.specPath, 'spec.md');
    const planFile = join(ctx.specPath, 'plan.md');
    const tasksFile = join(ctx.specPath, 'tasks.md');

    if (existsSync(specFile)) {
      parts.push('## Original Feature Specification', '', readFileSync(specFile, 'utf-8'), '');
    }
    if (existsSync(planFile)) {
      parts.push('## Technical Plan', '', readFileSync(planFile, 'utf-8'), '');
    }
    if (existsSync(tasksFile)) {
      parts.push('## Implementation Tasks', '', readFileSync(tasksFile, 'utf-8'), '');
    }
  }

  parts.push(
    '## Review Dimensions',
    '',
    'Evaluate the PR against these 6 dimensions:',
    '',
    '### 1. Spec Compliance',
    '- Does the implementation match what was specified?',
    '- Are all requirements addressed?',
    '- Are there additions not covered by the spec?',
    '',
    '### 2. Plan Adherence',
    '- Does the code follow the technical plan?',
    '- Are architectural decisions respected?',
    '',
    '### 3. Security Review',
    '- Input validation on external boundaries',
    '- No hardcoded secrets or credentials',
    '- Proper error handling (no information leakage)',
    '- SQL injection, XSS, command injection checks',
    '',
    '### 4. Code Quality',
    '- TypeScript strict compliance',
    '- Consistent patterns with existing codebase',
    '- No dead code or debug artifacts',
    '- Error handling completeness',
    '',
    '### 5. Architecture Integrity',
    '- Respects existing module boundaries',
    '- Appropriate dependencies',
    '- Follows project patterns',
    '',
    '### 6. Edge Cases & Robustness',
    '- Null/undefined handling',
    '- Boundary conditions',
    '- Graceful degradation',
    '',
    '### 7. Code Duplication & Redundancy',
    '- Are there copy-pasted or near-identical code blocks across files?',
    '- Are there multiple code paths that do the same or very similar thing?',
    '- Could shared logic be extracted into a utility, helper, or base function?',
    '- Does the PR introduce code that already exists elsewhere in the codebase?',
    '- Are there patterns (error handling, validation, data transformation) repeated instead of reused?',
    '',
    '## Output',
    '',
    'After reviewing, execute EXACTLY these steps:',
    '',
    '1. Post your review verdict to GitHub. Try in this order:',
    `   a) First attempt: gh pr review ${ctx.prNumber} --repo ${ctx.repo} --approve --body "..."  OR  gh pr review ${ctx.prNumber} --repo ${ctx.repo} --request-changes --body "..."`,
    "      (This may fail with \"Can't request changes on own PR\" or \"You can't approve your own pull request\" — that is expected and OK.)",
    `   b) If step (a) fails: gh pr comment ${ctx.prNumber} --repo ${ctx.repo} --body "AI Review: <APPROVED or CHANGES REQUESTED>\\n\\n[your full review]"`,
    '      (Comments always work, even on your own PRs. Use this as the fallback.)',
    '',
    '   HARD RULE: Any code duplication or redundant implementations MUST result in changes_requested.',
    '   Even minor duplication is not acceptable — request extraction to shared code before approving.',
    '',
    '2. ALWAYS output a structured summary regardless of whether step 1 succeeded or failed:',
    '   REVIEW_RESULT: <approved or changes_requested>',
    '   FINDINGS_COUNT: <number>',
    '   SEVERITY: <low or medium or high or critical>',
    '   SUMMARY: <one paragraph summary>',
    '   BLOCKING_ISSUES: <JSON array of new blocking issues, or empty array []>',
    '',
    '   Format for BLOCKING_ISSUES (one per line, each as valid JSON):',
    '   BLOCKING_ISSUES: [{"severity":"critical","description":"No implementation code found"},{"severity":"high","description":"Missing error handling"}]',
    '',
    '   Include only NEW blocking issues found in THIS review cycle.',
    '   Severity levels: critical (no implementation, broken functionality), high (security, data loss),',
    '   medium (code quality, tech debt), low (style, documentation).',
    '',
    'CRITICAL: Output the structured summary (step 2) NO MATTER WHAT — even if the gh command failed.',
    'IMPORTANT: You must NEVER merge the PR. You must NEVER modify any code. You only review and comment.',
  );

  return parts.join('\n');
}

/**
 * Parse review result from agent output.
 *
 * Preprocessing handles two failure modes:
 * 1. Agent wraps field names in markdown bold: **REVIEW_RESULT:** changes_requested
 *    → strip ** so the regex can match
 * 2. Prompt template bleeds through with placeholder: REVIEW_RESULT: <approved or changes_requested>
 *    → strip <...> angle-bracket placeholders so the template doesn't false-match "approved"
 */
export function parseReviewResult(output: string): {
  status: 'approved' | 'changes_requested' | 'unknown';
  findingsCount: number;
  severity: string;
  summary: string;
  blockingIssues: BlockingIssue[];
} {
  // Preprocess: strip markdown bold and angle-bracket placeholders
  const cleaned = output
    .replace(/\*\*/g, '')       // **REVIEW_RESULT:** → REVIEW_RESULT:
    .replace(/<[^>]*>/g, '');   // <approved or changes_requested> → (empty)

  // Use matchAll to find the LAST occurrence of each field.
  // The agent's stdout may contain the prompt template (which has example values)
  // followed by the actual output. We want the last match — the agent's real answer.
  const statusMatches = [...cleaned.matchAll(/REVIEW_RESULT:\s*(approved|changes_requested)/gi)];
  const countMatches = [...cleaned.matchAll(/FINDINGS_COUNT:\s*(\d+)/gi)];
  const severityMatches = [...cleaned.matchAll(/SEVERITY:\s*(\w+)/gi)];
  const summaryMatches = [...cleaned.matchAll(/SUMMARY:\s*(.+)/gi)];
  const blockingMatches = [...cleaned.matchAll(/BLOCKING_ISSUES:\s*(\[.*?\])/gi)];

  const lastStatus = statusMatches.at(-1);
  const lastCount = countMatches.at(-1);
  const lastSeverity = severityMatches.at(-1);
  const lastSummary = summaryMatches.at(-1);
  const lastBlocking = blockingMatches.at(-1);

  // Parse blocking issues JSON array
  let blockingIssues: BlockingIssue[] = [];
  if (lastBlocking?.[1]) {
    try {
      const parsed = JSON.parse(lastBlocking[1]);
      if (Array.isArray(parsed)) {
        blockingIssues = parsed
          .filter((item: any) => item.severity && item.description)
          .map((item: any) => ({
            severity: item.severity as 'critical' | 'high' | 'medium' | 'low',
            description: item.description,
            cycle: 0, // Will be set by caller
            resolved: false,
          }));
      }
    } catch {
      // Invalid JSON — ignore blocking issues
    }
  }

  let status = (lastStatus?.[1]?.toLowerCase() as 'approved' | 'changes_requested') ?? 'unknown';

  // Safety override: if the agent says "approved" but also reported critical or high
  // blocking issues, treat it as changes_requested. This catches inconsistent agent
  // output where the REVIEW_RESULT field contradicts the BLOCKING_ISSUES list.
  if (status === 'approved' && blockingIssues.some(i => i.severity === 'critical' || i.severity === 'high')) {
    status = 'changes_requested';
  }

  return {
    status,
    findingsCount: lastCount ? parseInt(lastCount[1], 10) : 0,
    severity: lastSeverity?.[1] ?? 'unknown',
    summary: lastSummary?.[1] ?? 'No summary available',
    blockingIssues,
  };
}

/**
 * Dispatch a code review agent for a work item.
 * Returns true if the review was dispatched successfully.
 */
export async function dispatchReviewAgent(
  bb: Blackboard,
  item: BlackboardWorkItem,
  ctx: ReviewContext,
  sessionId: string,
  timeoutMs: number = 10 * 60 * 1000, // 10 min default
): Promise<{ success: boolean; reviewStatus: string }> {
  const launcher = getLauncher();
  const prompt = buildReviewPrompt(ctx);

  const result = await launcher({
    workDir: ctx.projectPath,
    prompt,
    timeoutMs,
    sessionId: `${sessionId}-review`,
    disableMcp: true,
  });

  const review = parseReviewResult(result.stdout);

  // Merge with prior blocking issues from metadata
  const existingMeta = item.metadata ? JSON.parse(item.metadata) : {};
  const priorBlockingIssues: BlockingIssue[] = Array.isArray(existingMeta.blocking_issues)
    ? existingMeta.blocking_issues
    : [];

  // Set cycle number on newly found blocking issues
  const currentCycle = (existingMeta.rework_cycle ?? 0) + 1;
  const newBlockingIssues = review.blockingIssues.map(issue => ({
    ...issue,
    cycle: currentCycle,
  }));

  // Combine: keep prior unresolved issues + add new ones
  const allBlockingIssues = [...priorBlockingIssues, ...newBlockingIssues];

  const updatedMeta = {
    ...existingMeta,
    review_status: review.status,
    review_findings_count: review.findingsCount,
    review_severity: review.severity,
    reviewer_session_id: sessionId,
    blocking_issues: allBlockingIssues,
  };

  // Complete the review work item
  bb.completeWorkItem(item.item_id, sessionId);

  // Emit appropriate event on the ORIGINAL implementation work item
  const targetId = existingMeta.implementation_work_item_id ?? item.item_id;
  const eventType = review.status === 'approved' ? 'work_approved' : 'work_rejected';

  bb.appendEvent({
    actorId: sessionId,
    targetId,
    summary: `Code review ${review.status}: ${review.summary}`,
    metadata: { ...updatedMeta, eventType },
  });

  // On approval: create a merge work item so the PR gets merged in the next dispatch cycle.
  // Skip for non-owner issues (human_review_required === true) — those require manual merge.
  if (review.status === 'approved' && existingMeta.repo && existingMeta.branch && !existingMeta.human_review_required) {
    try {
      createPRMergeWorkItem(bb, {
        prNumber: existingMeta.pr_number ?? ctx.prNumber,
        prUrl: existingMeta.pr_url ?? `https://github.com/${ctx.repo}/pull/${ctx.prNumber}`,
        repo: existingMeta.repo ?? ctx.repo,
        branch: existingMeta.branch ?? ctx.branch,
        mainBranch: existingMeta.main_branch ?? 'main',
        implementationWorkItemId: targetId,
        projectId: item.project_id ?? '',
        originalTitle: item.title.replace(/^Code review:\s*/i, ''),
        sessionId,
      });
    } catch {
      // Merge item creation failed (non-fatal — PR can be merged manually)
    }
  }

  // On unknown: re-queue the review work item (agent failed to produce structured output)
  if (review.status === 'unknown') {
    const retryCount = (existingMeta.review_retry_count ?? 0) + 1;
    if (retryCount <= 3 && existingMeta.repo && existingMeta.branch) {
      try {
        bb.createWorkItem({
          id: `review-${item.project_id}-pr-${ctx.prNumber}-retry-${retryCount}`,
          title: item.title,
          description: `${item.description ?? ''}\n\n[Retry ${retryCount}/3: previous review produced no structured output]`,
          project: item.project_id ?? '',
          source: 'code_review',
          sourceRef: existingMeta.pr_url ?? `https://github.com/${ctx.repo}/pull/${ctx.prNumber}`,
          priority: 'P1',
          metadata: JSON.stringify({ ...existingMeta, review_retry_count: retryCount }),
        });
      } catch {}
    }
  }

  // On changes_requested: create a rework work item so the feedback loop continues
  if (review.status === 'changes_requested' && existingMeta.repo && existingMeta.branch) {
    const nextCycle = (existingMeta.rework_cycle ?? 0) + 1;
    createReworkWorkItem(bb, {
      prNumber: existingMeta.pr_number ?? ctx.prNumber,
      prUrl: existingMeta.pr_url ?? `https://github.com/${ctx.repo}/pull/${ctx.prNumber}`,
      repo: existingMeta.repo ?? ctx.repo,
      branch: existingMeta.branch ?? ctx.branch,
      mainBranch: existingMeta.main_branch ?? 'main',
      implementationWorkItemId: targetId,
      reviewFeedback: review.summary,
      reworkCycle: nextCycle,
      projectId: item.project_id ?? '',
      originalTitle: item.title.replace(/^Code review:\s*/i, ''),
      sessionId,
      blockingIssues: allBlockingIssues,
    });
  }

  return {
    success: result.exitCode === 0,
    reviewStatus: review.status,
  };
}
