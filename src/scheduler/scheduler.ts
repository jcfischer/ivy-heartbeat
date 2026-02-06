import { mkdirSync, openSync, closeSync, appendFileSync } from 'node:fs';
import type { Blackboard } from '../blackboard.ts';
import type { BlackboardWorkItem } from 'ivy-blackboard/src/types';
import { getLauncher, resolveLogDir, logPathForSession } from './launcher.ts';
import {
  isCleanBranch,
  stashIfDirty,
  popStash,
  getCurrentBranch,
  createWorktree,
  removeWorktree,
  resolveWorktreePath,
  commitAll,
  pushBranch,
  createPR,
  mergePR,
  pullMain,
  getDiffSummary,
  buildCommentPrompt,
} from './worktree.ts';
import { parseSpecFlowMeta } from './specflow-types.ts';
import { runSpecFlowPhase } from './specflow-runner.ts';
import { parseMergeFixMeta, createMergeFixWorkItem, runMergeFix } from './merge-fix.ts';
import type {
  DispatchOptions,
  DispatchResult,
  DispatchedItem,
  SkippedItem,
} from './types.ts';

/**
 * Resolve the path to the ivy-heartbeat binary.
 * Uses process.execPath for compiled binaries, falls back to bun + src/cli.ts.
 *
 * In compiled Bun binaries, process.argv[0] is just "bun" (unhelpful),
 * but process.execPath is the actual compiled binary path.
 */
function resolveWorkerBinary(): string[] {
  const ep = process.execPath;
  // If running as a compiled binary (not bun itself)
  if (ep && !ep.endsWith('/bun') && !ep.endsWith('/node')) {
    return [ep];
  }
  // Running from source: bun run src/cli.ts
  return ['bun', 'run', `${import.meta.dir}/../cli.ts`];
}

/**
 * Count currently active dispatch agents (active or idle) on the blackboard.
 * Excludes the heartbeat orchestrator agent (name='ivy-heartbeat') which
 * runs checks but is not a work-processing agent.
 */
function countActiveAgents(bb: Blackboard): number {
  const row = bb.db
    .query("SELECT COUNT(*) as count FROM agents WHERE status IN ('active', 'idle') AND agent_name != 'ivy-heartbeat'")
    .get() as { count: number };
  return row.count;
}

/**
 * Parse work item metadata to extract GitHub-specific fields.
 */
function parseGithubMeta(metadata: string | null): {
  isGithub: boolean;
  issueNumber?: number;
  repo?: string;
  author?: string;
  humanReviewRequired?: boolean;
} {
  if (!metadata) return { isGithub: false };
  try {
    const parsed = JSON.parse(metadata);
    if (parsed.github_issue_number && parsed.github_repo) {
      return {
        isGithub: true,
        issueNumber: parsed.github_issue_number,
        repo: parsed.github_repo,
        author: parsed.author,
        humanReviewRequired: parsed.human_review_required !== false,
      };
    }
  } catch {
    // Invalid metadata JSON
  }
  return { isGithub: false };
}

/**
 * Cross-project dependency instructions injected into agent prompts.
 */
const CROSS_PROJECT_DEPENDENCY_INSTRUCTIONS = `
## Cross-Project Dependencies

If you discover that completing this task requires changes in another project:
1. Create a GitHub issue in the target project: \`gh issue create --repo owner/repo --title "..." --body "..."\`
2. Output a structured dependency marker at the end of your summary:
   CROSS_PROJECT_DEPENDENCY:
   repo: owner/repo
   issue: <number>
   reason: <why this is needed>
   resume_context: <what to do when resolved>
3. Your current work item will be paused until the dependency resolves.
`;

/**
 * Build the prompt for a Claude Code session working on a work item.
 */
function buildPrompt(item: BlackboardWorkItem, sessionId: string): string {
  const parts = [
    `You are an autonomous agent working on: ${item.title}`,
  ];

  if (item.description) {
    parts.push(`\nDescription: ${item.description}`);
  }

  parts.push(
    `\nWork item ID: ${item.item_id}`,
    `Session ID: ${sessionId}`,
    CROSS_PROJECT_DEPENDENCY_INSTRUCTIONS,
    `\nWhen you are done, summarize what you accomplished.`,
  );

  return parts.join('\n');
}

/**
 * Dispatch available work items to Claude Code sessions.
 *
 * Pipeline:
 * 1. Query blackboard for available work, ordered by priority
 * 2. Filter by project/priority if specified
 * 3. Check concurrency limits
 * 4. For each item (up to maxItems):
 *    a. Look up project local_path
 *    b. Register agent + claim work
 *    c. Launch Claude Code session
 *    d. On success: complete work + deregister
 *    e. On failure: release work + deregister
 */
export async function dispatch(
  bb: Blackboard,
  opts: DispatchOptions
): Promise<DispatchResult> {
  const result: DispatchResult = {
    timestamp: new Date().toISOString(),
    dispatched: [],
    skipped: [],
    errors: [],
    dryRun: opts.dryRun,
  };

  // Query available work items
  const items = bb.listWorkItems({
    status: 'available',
    priority: opts.priority,
    project: opts.project,
  });

  if (items.length === 0) {
    return result;
  }

  // Check concurrency limit (pre-existing agents, not ones we'll create)
  if (!opts.dryRun) {
    const activeCount = countActiveAgents(bb);
    if (activeCount >= opts.maxConcurrent) {
      for (const item of items) {
        result.skipped.push({
          itemId: item.item_id,
          title: item.title,
          reason: `concurrency limit reached (${activeCount}/${opts.maxConcurrent} active)`,
        });
      }
      return result;
    }
  }

  // Cap by maxItems only — sequential processing means each completion frees the slot
  const itemsToProcess = items.slice(0, opts.maxItems);
  const itemsSkipped = items.slice(opts.maxItems);

  // Skip remaining items beyond limit
  for (const item of itemsSkipped) {
    result.skipped.push({
      itemId: item.item_id,
      title: item.title,
      reason: 'exceeds max items per run',
    });
  }

  // Dry run: report what would be dispatched
  if (opts.dryRun) {
    for (const item of itemsToProcess) {
      const project = item.project_id ? bb.getProject(item.project_id) : null;
      const workDir = project?.local_path ?? process.env.HOME ?? '/tmp';
      result.dispatched.push({
        itemId: item.item_id,
        title: item.title,
        projectId: item.project_id ?? '(none)',
        sessionId: '(dry-run)',
        exitCode: 0,
        completed: false,
        durationMs: 0,
      });
    }
    return result;
  }

  // Dispatch items
  for (const item of itemsToProcess) {
    // Resolve project (may be null for general tasks like tana todos)
    const project = item.project_id ? bb.getProject(item.project_id) : null;
    const resolvedWorkDir = project?.local_path ?? process.env.HOME ?? '/tmp';

    // Register agent and claim work
    let sessionId: string;
    try {
      const agent = bb.registerAgent({
        name: `dispatch-${item.item_id}`,
        project: item.project_id ?? 'general',
        work: item.item_id,
      });
      sessionId = agent.session_id;

      // Store log path in agent metadata
      const logPath = logPathForSession(sessionId);
      bb.db
        .query("UPDATE agents SET metadata = ? WHERE session_id = ?")
        .run(JSON.stringify({ logPath }), sessionId);
    } catch (err: unknown) {
      const msg = err instanceof Error ? err.message : String(err);
      result.errors.push({
        itemId: item.item_id,
        title: item.title,
        error: `Failed to register agent: ${msg}`,
      });
      continue;
    }

    const claimResult = bb.claimWorkItem(item.item_id, sessionId);
    if (!claimResult.claimed) {
      result.skipped.push({
        itemId: item.item_id,
        title: item.title,
        reason: 'could not claim (already claimed by another agent)',
      });
      bb.deregisterAgent(sessionId);
      continue;
    }

    // Log dispatch event
    bb.appendEvent({
      actorId: sessionId,
      targetId: item.item_id,
      summary: `Dispatching "${item.title}" to Claude Code in ${resolvedWorkDir}`,
      metadata: {
        itemId: item.item_id,
        projectId: item.project_id,
        priority: item.priority,
        workDir: resolvedWorkDir,
        fireAndForget: !!opts.fireAndForget,
      },
    });

    if (opts.fireAndForget) {
      // Fire-and-forget: spawn a detached worker process and return immediately.
      // The worker handles its own lifecycle (run claude, complete/release, deregister).
      try {
        const bin = resolveWorkerBinary();
        const args = [...bin];

        // --db is a global option on the parent command, so it goes before the subcommand
        const dbPath = bb.db.filename;
        if (dbPath) {
          args.push('--db', dbPath);
        }

        args.push(
          'dispatch-worker',
          '--session-id', sessionId,
          '--item-id', item.item_id,
          '--timeout-ms', String(opts.timeout * 60 * 1000),
        );

        // Redirect worker stderr to the session log file so startup crashes
        // are captured instead of silently discarded.
        const logDir = resolveLogDir();
        mkdirSync(logDir, { recursive: true });
        const logPath = logPathForSession(sessionId);

        appendFileSync(logPath, [
          `=== Worker Spawned ===`,
          `Time: ${new Date().toISOString()}`,
          `Item: ${item.item_id} — ${item.title}`,
          `Work Dir: ${resolvedWorkDir}`,
          `===`,
          '',
        ].join('\n'));

        const logFd = openSync(logPath, 'a');
        try {
          const proc = Bun.spawn(args, {
            cwd: resolvedWorkDir,
            stdout: 'ignore',
            stderr: logFd,
            stdin: 'ignore',
          });
          proc.unref();
        } finally {
          // Close parent's copy; child inherits its own fd
          closeSync(logFd);
        }

        result.dispatched.push({
          itemId: item.item_id,
          title: item.title,
          projectId: item.project_id ?? '(none)',
          sessionId,
          exitCode: 0,
          completed: false, // Not yet — worker will handle it
          durationMs: 0,
        });
      } catch (err: unknown) {
        const msg = err instanceof Error ? err.message : String(err);
        // Clean up on spawn failure
        try { bb.releaseWorkItem(item.item_id, sessionId); } catch { /* best effort */ }
        try { bb.deregisterAgent(sessionId); } catch { /* best effort */ }
        result.errors.push({
          itemId: item.item_id,
          title: item.title,
          error: `Failed to spawn worker: ${msg}`,
        });
      }
    } else {
      // Synchronous mode: run launcher inline and wait for completion.
      const launcher = getLauncher();
      const startTime = Date.now();

      // SpecFlow detection: delegate to specflow runner
      const sfMeta = parseSpecFlowMeta(item.metadata);
      if (sfMeta) {
        try {
          const success = await runSpecFlowPhase(bb, item, {
            project_id: item.project_id!,
            local_path: project?.local_path ?? resolvedWorkDir,
          }, sessionId);

          const durationMs = Date.now() - startTime;

          if (success) {
            bb.completeWorkItem(item.item_id, sessionId);
            bb.appendEvent({
              actorId: sessionId,
              targetId: item.item_id,
              summary: `SpecFlow phase "${sfMeta.specflow_phase}" completed for ${sfMeta.specflow_feature_id} (${Math.round(durationMs / 1000)}s)`,
              metadata: { phase: sfMeta.specflow_phase, durationMs },
            });

            result.dispatched.push({
              itemId: item.item_id,
              title: item.title,
              projectId: item.project_id!,
              sessionId,
              exitCode: 0,
              completed: true,
              durationMs,
            });
          } else {
            try { bb.releaseWorkItem(item.item_id, sessionId); } catch { /* best effort */ }
            bb.appendEvent({
              actorId: sessionId,
              targetId: item.item_id,
              summary: `SpecFlow phase "${sfMeta.specflow_phase}" failed for ${sfMeta.specflow_feature_id} (${Math.round(durationMs / 1000)}s)`,
              metadata: { phase: sfMeta.specflow_phase, durationMs },
            });

            result.errors.push({
              itemId: item.item_id,
              title: item.title,
              error: `SpecFlow phase "${sfMeta.specflow_phase}" failed`,
            });
          }
        } catch (err: unknown) {
          const msg = err instanceof Error ? err.message : String(err);
          const durationMs = Date.now() - startTime;
          try { bb.releaseWorkItem(item.item_id, sessionId); } catch { /* best effort */ }

          bb.appendEvent({
            actorId: sessionId,
            targetId: item.item_id,
            summary: `SpecFlow phase "${sfMeta.specflow_phase}" error: ${msg}`,
            metadata: { error: msg, durationMs },
          });

          result.errors.push({
            itemId: item.item_id,
            title: item.title,
            error: msg,
          });
        } finally {
          bb.deregisterAgent(sessionId);
        }
        continue;
      }

      // Determine if this is a merge-fix recovery work item
      const mfMeta = parseMergeFixMeta(item.metadata);
      if (mfMeta && project) {
        const mfWorktreePath = resolveWorktreePath(project.local_path, mfMeta.branch, mfMeta.project_id);
        try {
          await runMergeFix(bb, item, mfMeta, project, sessionId, launcher, opts.timeout * 60 * 1000);
          bb.completeWorkItem(item.item_id, sessionId);

          const durationMs = Date.now() - startTime;
          bb.appendEvent({
            actorId: sessionId,
            targetId: item.item_id,
            summary: `Merge-fix completed for PR #${mfMeta.pr_number} (${Math.round(durationMs / 1000)}s)`,
            metadata: { prNumber: mfMeta.pr_number, durationMs },
          });

          result.dispatched.push({
            itemId: item.item_id,
            title: item.title,
            projectId: item.project_id ?? '(none)',
            sessionId,
            exitCode: 0,
            completed: true,
            durationMs,
          });
        } catch (err: unknown) {
          const msg = err instanceof Error ? err.message : String(err);
          const durationMs = Date.now() - startTime;
          try { bb.releaseWorkItem(item.item_id, sessionId); } catch { /* best effort */ }
          bb.appendEvent({
            actorId: sessionId,
            targetId: item.item_id,
            summary: `Merge-fix failed for PR #${mfMeta.pr_number}: ${msg}`,
            metadata: { error: msg, durationMs },
          });
          result.errors.push({
            itemId: item.item_id,
            title: item.title,
            error: `Merge-fix failed: ${msg}`,
          });
        } finally {
          try { await removeWorktree(project.local_path, mfWorktreePath); } catch { /* best effort */ }
          bb.deregisterAgent(sessionId);
        }
        continue;
      }

      const prompt = buildPrompt(item, sessionId);

      // Worktree setup for GitHub items
      const ghMeta = parseGithubMeta(item.metadata);
      let workDir = resolvedWorkDir;
      let worktreePath: string | null = null;
      let branch: string | null = null;
      let mainBranch: string | null = null;

      let didStash = false;

      if (ghMeta.isGithub && ghMeta.issueNumber) {
        try {
          didStash = await stashIfDirty(project.local_path);
          if (didStash) {
            bb.appendEvent({
              actorId: sessionId,
              targetId: item.item_id,
              summary: `Auto-stashed uncommitted changes in ${project.local_path} before worktree creation`,
            });
          }

          mainBranch = await getCurrentBranch(project.local_path);
          branch = `fix/issue-${ghMeta.issueNumber}`;
          worktreePath = await createWorktree(project.local_path, branch, item.project_id ?? undefined);
          workDir = worktreePath;
        } catch (err: unknown) {
          const msg = err instanceof Error ? err.message : String(err);
          result.errors.push({
            itemId: item.item_id,
            title: item.title,
            error: `Failed to create worktree: ${msg}`,
          });
          bb.releaseWorkItem(item.item_id, sessionId);
          bb.deregisterAgent(sessionId);
          continue;
        }
      }

      try {
        const launchResult = await launcher({
          workDir,
          prompt,
          timeoutMs: opts.timeout * 60 * 1000,
          sessionId,
          disableMcp: true,
        });

        const durationMs = Date.now() - startTime;

        if (launchResult.exitCode === 0) {
          // Post-agent git operations for GitHub items
          if (ghMeta.isGithub && worktreePath && branch && mainBranch) {
            try {
              const sha = await commitAll(
                worktreePath,
                `Fix #${ghMeta.issueNumber}: ${item.title}`
              );

              if (sha) {
                await pushBranch(worktreePath, branch);

                const prBody = [
                  `Fixes #${ghMeta.issueNumber}`,
                  '',
                  `Automated fix for: ${item.title}`,
                ].join('\n');

                const pr = await createPR(
                  worktreePath,
                  `Fix #${ghMeta.issueNumber}: ${item.title}`,
                  prBody,
                  mainBranch
                );

                bb.appendEvent({
                  actorId: sessionId,
                  targetId: item.item_id,
                  summary: `Created PR #${pr.number} for "${item.title}"`,
                  metadata: { prNumber: pr.number, prUrl: pr.url, commitSha: sha },
                });

                // Auto-merge for trusted contributors (non-fatal)
                if (!ghMeta.humanReviewRequired) {
                  try {
                    const merged = await mergePR(worktreePath, pr.number);
                    if (merged) {
                      bb.appendEvent({
                        actorId: sessionId,
                        targetId: item.item_id,
                        summary: `Auto-merged PR #${pr.number} (squash) for "${item.title}"`,
                        metadata: { prNumber: pr.number, autoMerge: true },
                      });

                      // Pull merged changes into main repo
                      try {
                        await pullMain(project.local_path, mainBranch);
                        bb.appendEvent({
                          actorId: sessionId,
                          targetId: item.item_id,
                          summary: `Pulled merged changes into ${project.local_path}`,
                          metadata: { mainBranch, pullAfterMerge: true },
                        });
                      } catch (pullErr: unknown) {
                        const pullMsg = pullErr instanceof Error ? pullErr.message : String(pullErr);
                        bb.appendEvent({
                          actorId: sessionId,
                          targetId: item.item_id,
                          summary: `Pull after merge failed (non-fatal): ${pullMsg}`,
                          metadata: { error: pullMsg },
                        });
                      }
                    } else {
                      // Create recovery work item for merge failure
                      const mergeFixId = createMergeFixWorkItem(bb, {
                        originalItemId: item.item_id,
                        prNumber: pr.number,
                        prUrl: pr.url,
                        branch: branch!,
                        mainBranch: mainBranch!,
                        issueNumber: ghMeta.issueNumber,
                        projectId: item.project_id!,
                        originalTitle: item.title,
                        sessionId,
                      });
                      bb.appendEvent({
                        actorId: sessionId,
                        targetId: item.item_id,
                        summary: `Auto-merge failed for PR #${pr.number} — created recovery item ${mergeFixId}`,
                        metadata: { prNumber: pr.number, autoMerge: false, mergeFixItemId: mergeFixId },
                      });
                    }
                  } catch (mergeErr: unknown) {
                    const mergeMsg = mergeErr instanceof Error ? mergeErr.message : String(mergeErr);
                    // Create recovery work item for merge error
                    const mergeFixId = createMergeFixWorkItem(bb, {
                      originalItemId: item.item_id,
                      prNumber: pr.number,
                      prUrl: pr.url,
                      branch: branch!,
                      mainBranch: mainBranch!,
                      issueNumber: ghMeta.issueNumber,
                      projectId: item.project_id!,
                      originalTitle: item.title,
                      sessionId,
                    });
                    bb.appendEvent({
                      actorId: sessionId,
                      targetId: item.item_id,
                      summary: `Auto-merge error for PR #${pr.number}: ${mergeMsg} — created recovery item ${mergeFixId}`,
                      metadata: { prNumber: pr.number, error: mergeMsg, mergeFixItemId: mergeFixId },
                    });
                  }
                }

                // Launch commenter agent (non-fatal)
                try {
                  const diffSummary = await getDiffSummary(worktreePath, mainBranch);
                  const commentPrompt = buildCommentPrompt(
                    {
                      number: ghMeta.issueNumber!,
                      title: item.title,
                      body: item.description ?? undefined,
                      author: ghMeta.author ?? 'unknown',
                    },
                    pr.url,
                    diffSummary
                  );

                  await launcher({
                    workDir: worktreePath,
                    prompt: commentPrompt,
                    timeoutMs: 120_000,
                    sessionId: `${sessionId}-comment`,
                  });
                } catch {
                  // Commenter failure is non-fatal
                }
              }
            } catch (gitErr: unknown) {
              const msg = gitErr instanceof Error ? gitErr.message : String(gitErr);
              bb.releaseWorkItem(item.item_id, sessionId);
              bb.deregisterAgent(sessionId);
              result.errors.push({
                itemId: item.item_id,
                title: item.title,
                error: `Post-agent git ops failed: ${msg}`,
              });
              // Clean up worktree before continuing
              if (worktreePath) {
                try { await removeWorktree(project.local_path, worktreePath); } catch { /* best effort */ }
              }
              continue;
            }
          }

          bb.completeWorkItem(item.item_id, sessionId);

          bb.appendEvent({
            actorId: sessionId,
            targetId: item.item_id,
            summary: `Completed "${item.title}" (exit 0, ${Math.round(durationMs / 1000)}s)`,
            metadata: { itemId: item.item_id, exitCode: 0, durationMs },
          });

          result.dispatched.push({
            itemId: item.item_id,
            title: item.title,
            projectId: item.project_id ?? '(none)',
            sessionId,
            exitCode: 0,
            completed: true,
            durationMs,
          });
        } else {
          bb.releaseWorkItem(item.item_id, sessionId);

          bb.appendEvent({
            actorId: sessionId,
            targetId: item.item_id,
            summary: `Failed "${item.title}" (exit ${launchResult.exitCode}, ${Math.round(durationMs / 1000)}s)`,
            metadata: {
              itemId: item.item_id,
              exitCode: launchResult.exitCode,
              durationMs,
              stderr: launchResult.stderr.slice(0, 500),
            },
          });

          result.errors.push({
            itemId: item.item_id,
            title: item.title,
            error: `Claude exited with code ${launchResult.exitCode}`,
          });
        }

        bb.deregisterAgent(sessionId);
      } catch (err: unknown) {
        const msg = err instanceof Error ? err.message : String(err);
        const durationMs = Date.now() - startTime;

        try { bb.releaseWorkItem(item.item_id, sessionId); } catch { /* best effort */ }
        try { bb.deregisterAgent(sessionId); } catch { /* best effort */ }

        bb.appendEvent({
          actorId: sessionId,
          targetId: item.item_id,
          summary: `Error dispatching "${item.title}": ${msg}`,
          metadata: { itemId: item.item_id, error: msg, durationMs },
        });

        result.errors.push({
          itemId: item.item_id,
          title: item.title,
          error: msg,
        });
      } finally {
        // Always clean up worktree if created
        if (worktreePath) {
          try { await removeWorktree(project.local_path, worktreePath); } catch { /* best effort */ }
        }
        // Restore stashed changes
        if (didStash) {
          const restored = await popStash(project.local_path);
          bb.appendEvent({
            actorId: sessionId,
            targetId: item.item_id,
            summary: restored
              ? `Restored stashed changes in ${project.local_path}`
              : `Failed to restore stash in ${project.local_path} — run 'git stash pop' manually`,
          });
        }
      }
    }
  }

  return result;
}
