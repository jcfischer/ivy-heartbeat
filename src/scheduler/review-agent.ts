import { readFileSync, existsSync } from 'node:fs';
import { join } from 'node:path';
import type { Blackboard } from '../blackboard.ts';
import type { BlackboardWorkItem } from 'ivy-blackboard/src/types';
import { getLauncher, logPathForSession } from './launcher.ts';

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
    '## Output',
    '',
    'After reviewing, execute EXACTLY these steps:',
    '',
    '1. Post your review as a GitHub PR review:',
    `   - If NO critical or high issues: gh pr review ${ctx.prNumber} --repo ${ctx.repo} --approve --body "AI Review: APPROVED\\n\\n[your review summary]"`,
    `   - If critical/high issues: gh pr review ${ctx.prNumber} --repo ${ctx.repo} --request-changes --body "AI Review: CHANGES REQUESTED\\n\\n[your findings]"`,
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

  return {
    success: result.exitCode === 0,
    reviewStatus: review.status,
  };
}
