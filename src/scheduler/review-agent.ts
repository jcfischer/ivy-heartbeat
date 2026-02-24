import { readFileSync, existsSync } from 'node:fs';
import { join } from 'node:path';
import type { Blackboard } from '../blackboard.ts';
import type { BlackboardWorkItem } from 'ivy-blackboard/src/types';
import { getLauncher, logPathForSession } from './launcher.ts';
import { createReworkWorkItem } from './rework.ts';
import { createPRMergeWorkItem } from './pr-merge.ts';
import { getPRState } from './worktree.ts';

interface ReviewContext {
  prNumber: number;
  repo: string;
  branch: string;
  projectPath: string;
  specPath?: string;
}

/**
 * Build the review agent prompt.
 * The agent reviews a PR against its spec/plan using 6 dimensions.
 */
export function buildReviewPrompt(ctx: ReviewContext): string {
  const parts: string[] = [
    `You are a code review agent for the PAI system. You are reviewing PR #${ctx.prNumber} in ${ctx.repo}.`,
    '',
    '## Instructions',
    '',
    '1. First, fetch the PR diff and file list:',
    `   gh pr diff ${ctx.prNumber} --repo ${ctx.repo}`,
    `   gh pr view ${ctx.prNumber} --repo ${ctx.repo} --json files`,
    '',
  ];

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
    '1. Post your review as a GitHub PR review:',
    `   - If NO critical or high issues AND no code duplication: gh pr review ${ctx.prNumber} --repo ${ctx.repo} --approve --body "AI Review: APPROVED\\n\\n[your review summary]"`,
    `   - If critical/high issues OR any code duplication found: gh pr review ${ctx.prNumber} --repo ${ctx.repo} --request-changes --body "AI Review: CHANGES REQUESTED\\n\\n[your findings]"`,
    '',
    '   HARD RULE: Any code duplication or redundant implementations MUST result in changes_requested.',
    '   Even minor duplication is not acceptable — request extraction to shared code before approving.',
    '',
    '2. Output a structured summary:',
    '   REVIEW_RESULT: approved | changes_requested',
    '   FINDINGS_COUNT: N',
    '   SEVERITY: low | medium | high | critical',
    '   SUMMARY: One paragraph summary',
    '',
    'IMPORTANT: You must NEVER merge the PR. You must NEVER modify any code. You only review and comment.',
  );

  return parts.join('\n');
}

/**
 * Parse review result from agent output.
 */
export function parseReviewResult(output: string): {
  status: 'approved' | 'changes_requested' | 'unknown';
  findingsCount: number;
  severity: string;
  summary: string;
} {
  const statusMatch = output.match(/REVIEW_RESULT:\s*(approved|changes_requested)/i);
  const countMatch = output.match(/FINDINGS_COUNT:\s*(\d+)/i);
  const severityMatch = output.match(/SEVERITY:\s*(\w+)/i);
  const summaryMatch = output.match(/SUMMARY:\s*(.+)/i);

  return {
    status: (statusMatch?.[1]?.toLowerCase() as 'approved' | 'changes_requested') ?? 'unknown',
    findingsCount: countMatch ? parseInt(countMatch[1], 10) : 0,
    severity: severityMatch?.[1] ?? 'unknown',
    summary: summaryMatch?.[1] ?? 'No summary available',
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
  // Check PR state before dispatching review — skip if PR is no longer open
  const prState = await getPRState(ctx.projectPath, ctx.prNumber);
  if (prState === 'CLOSED' || prState === 'MERGED') {
    bb.completeWorkItem(item.item_id, sessionId);
    bb.appendEvent({
      actorId: sessionId,
      targetId: item.item_id,
      summary: `Skipping review — PR #${ctx.prNumber} is ${prState.toLowerCase()}, review no longer applicable`,
      metadata: { prNumber: ctx.prNumber, prState, skipped: true },
    });
    return { success: true, reviewStatus: 'skipped' };
  }

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

  // Update work item metadata with review results
  const existingMeta = item.metadata ? JSON.parse(item.metadata) : {};
  const updatedMeta = {
    ...existingMeta,
    review_status: review.status,
    review_findings_count: review.findingsCount,
    review_severity: review.severity,
    reviewer_session_id: sessionId,
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

  // On approval: create a merge work item so the PR gets merged in the next dispatch cycle
  if (review.status === 'approved' && existingMeta.repo && existingMeta.branch) {
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

  // On changes_requested: create a rework work item so the feedback loop continues
  if (review.status === 'changes_requested' && existingMeta.repo && existingMeta.branch) {
    const currentCycle = (existingMeta.rework_cycle ?? 0) + 1;
    createReworkWorkItem(bb, {
      prNumber: existingMeta.pr_number ?? ctx.prNumber,
      prUrl: existingMeta.pr_url ?? `https://github.com/${ctx.repo}/pull/${ctx.prNumber}`,
      repo: existingMeta.repo ?? ctx.repo,
      branch: existingMeta.branch ?? ctx.branch,
      mainBranch: existingMeta.main_branch ?? 'main',
      implementationWorkItemId: targetId,
      reviewFeedback: review.summary,
      reworkCycle: currentCycle,
      projectId: item.project_id ?? '',
      originalTitle: item.title.replace(/^Code review:\s*/i, ''),
      sessionId,
    });
  }

  return {
    success: result.exitCode === 0,
    reviewStatus: review.status,
  };
}
