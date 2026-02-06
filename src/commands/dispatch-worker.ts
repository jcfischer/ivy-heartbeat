import { Command } from 'commander';
import type { CliContext } from '../cli.ts';
import { getLauncher, logPathForSession } from '../scheduler/launcher.ts';
import {
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
} from '../scheduler/worktree.ts';
import { parseSpecFlowMeta } from '../scheduler/specflow-types.ts';
import { runSpecFlowPhase } from '../scheduler/specflow-runner.ts';
import { parseMergeFixMeta, createMergeFixWorkItem, runMergeFix } from '../scheduler/merge-fix.ts';
import { getTanaAccessor } from '../evaluators/tana-accessor.ts';

/**
 * Parse work item metadata to extract GitHub-specific fields.
 */
function parseGithubMeta(metadata: string | null): {
  isGithub: boolean;
  issueNumber?: number;
  repo?: string;
  author?: string;
  issueBody?: string;
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
 * Parse work item metadata to extract Tana-specific fields.
 */
export function parseTanaMeta(metadata: string | null): {
  isTana: boolean;
  nodeId?: string;
  workspaceId?: string;
  tagId?: string;
} {
  if (!metadata) return { isTana: false };
  try {
    const parsed = JSON.parse(metadata);
    if (parsed.tana_node_id) {
      return {
        isTana: true,
        nodeId: parsed.tana_node_id,
        workspaceId: parsed.tana_workspace_id,
        tagId: parsed.tana_tag_id,
      };
    }
  } catch {
    // Invalid metadata JSON
  }
  return { isTana: false };
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

const TOOL_HINTS = `
## Tool Hints — Tana Access via supertag CLI

MCP is disabled in this session. Use \`supertag\` CLI (~/bin/supertag) for ALL Tana operations.
Commands marked (local API) talk directly to the running Tana app — no stale data.

### Search & Read

\`\`\`bash
# Full-text search
supertag search "meeting notes" --limit 10

# Find nodes by supertag
supertag search --tag person --limit 20
supertag search "Zurich" --tag company

# Filter by field value
supertag search --tag person --field "Location=Zurich"

# Show a specific node (with children)
supertag nodes show <nodeId> --depth 2

# Show node as JSON
supertag nodes show <nodeId> --json --depth 2

# List all supertags
supertag tags list

# Show supertag schema (fields, types, options)
supertag tags show <tagname>

# Natural language query
supertag query "find task where Status = Done"
\`\`\`

### Create & Write

\`\`\`bash
# Create a tagged node (posts to Tana Input API)
supertag create <supertag> "Node name" --field1 "value" --field2 "value"

# Example: create a person
supertag create person "Jane Doe" --email "jane@example.com" --company "Acme"

# Create with children
supertag create meeting "Q1 Review" -c "Discussed roadmap" -c "Action: follow up"

# Post to a specific target node
supertag create todo "Buy groceries" -t <parentNodeId>
\`\`\`

### Edit & Update (requires local API)

\`\`\`bash
# Edit node name
supertag edit <nodeId> --name "New name"

# Edit node description
supertag edit <nodeId> --description "Updated description"

# Set a field value on a node
supertag set-field <nodeId> <fieldName> "value"

# Set an option field by option ID
supertag set-field <nodeId> Status "Done" --option-id <optionId>

# Add a tag to a node
supertag tag add <nodeId> <tagNameOrId>

# Remove a tag
supertag tag remove <nodeId> <tagNameOrId>

# Mark node as done (check off)
supertag done <nodeId>

# Mark node as not done
supertag undone <nodeId>

# Move node to trash
supertag trash <nodeId>
\`\`\`

### Tips
- Use \`--json\` on any read command for machine-parseable output
- Use \`--depth N\` to control how many levels of children to fetch
- Use \`supertag tags show <name>\` to discover field names before setting them
- The local API commands (edit, set-field, tag, done) require Tana Desktop to be running
`;

/**
 * Build the prompt for a Claude Code session working on a work item.
 * No git instructions — the dispatch worker handles all git operations.
 */
function buildPrompt(
  title: string,
  description: string | null,
  itemId: string,
  sessionId: string
): string {
  const parts = [`You are an autonomous agent working on: ${title}`];

  if (description) {
    parts.push(`\nDescription: ${description}`);
  }

  parts.push(
    `\nWork item ID: ${itemId}`,
    `Session ID: ${sessionId}`,
    CROSS_PROJECT_DEPENDENCY_INSTRUCTIONS,
    TOOL_HINTS,
    `\nWhen you are done, summarize what you accomplished.`
  );

  return parts.join('\n');
}

/**
 * Hidden dispatch-worker subcommand.
 *
 * Spawned as a detached process by dispatch() in fire-and-forget mode.
 * Handles the full agent lifecycle:
 *   1. Read work item + project from blackboard
 *   2. For GitHub items: create isolated worktree
 *   3. Run Claude Code via the launcher (in worktree or project dir)
 *   4. For GitHub items on success: commit, push, create PR, comment on issue
 *   5. On success: complete work item + deregister agent
 *   6. On failure: release work item + deregister agent
 *   7. Always: clean up worktree if created
 */
export function registerDispatchWorkerCommand(
  parent: Command,
  getContext: () => CliContext
): void {
  parent
    .command('dispatch-worker')
    .description('[internal] Run a single dispatched work item')
    .option('--session-id <id>', 'Agent session ID')
    .option('--item-id <id>', 'Work item ID')
    .option('--timeout-ms <ms>', 'Timeout in milliseconds', '3600000')
    .action(async (opts) => {
      const sessionId = opts.sessionId;
      const itemId = opts.itemId;
      const timeoutMs = parseInt(opts.timeoutMs, 10);

      if (!sessionId || !itemId) {
        console.error('dispatch-worker: --session-id and --item-id are required');
        process.exit(1);
      }

      const ctx = getContext();
      const bb = ctx.bb;
      const launcher = getLauncher();

      // Fix PID: the scheduler registered this agent with its own PID, but the
      // scheduler exits after spawning us. Update to our PID so sweepStaleAgents
      // checks the correct (alive) process.
      bb.db.query('UPDATE agents SET pid = ?, last_seen_at = ? WHERE session_id = ?')
        .run(process.pid, new Date().toISOString(), sessionId);

      // Read work item from blackboard
      const items = bb.listWorkItems({ status: 'claimed' });
      const item = items.find((i) => i.item_id === itemId);

      if (!item) {
        bb.appendEvent({
          actorId: sessionId,
          targetId: itemId,
          summary: `Worker: work item "${itemId}" not found or not claimed`,
        });
        try { bb.deregisterAgent(sessionId); } catch { /* best effort */ }
        process.exit(1);
      }

      // Resolve project path (fallback to $HOME for project-less items like tana todos)
      const project = item.project_id ? bb.getProject(item.project_id) : null;
      const resolvedWorkDir = project?.local_path ?? process.env.HOME ?? '/tmp';

      // Determine if this is a SpecFlow work item
      const sfMeta = parseSpecFlowMeta(item.metadata);
      if (sfMeta) {
        try {
          const success = await runSpecFlowPhase(bb, item, {
            project_id: item.project_id!,
            local_path: project?.local_path ?? resolvedWorkDir,
          }, sessionId);

          if (success) {
            bb.completeWorkItem(itemId, sessionId);
            bb.appendEvent({
              actorId: sessionId,
              targetId: itemId,
              summary: `SpecFlow phase "${sfMeta.specflow_phase}" completed for ${sfMeta.specflow_feature_id}`,
            });
          } else {
            try { bb.releaseWorkItem(itemId, sessionId); } catch { /* best effort */ }
            bb.appendEvent({
              actorId: sessionId,
              targetId: itemId,
              summary: `SpecFlow phase "${sfMeta.specflow_phase}" failed for ${sfMeta.specflow_feature_id}`,
            });
          }
        } catch (err: unknown) {
          const msg = err instanceof Error ? err.message : String(err);
          try { bb.releaseWorkItem(itemId, sessionId); } catch { /* best effort */ }
          bb.appendEvent({
            actorId: sessionId,
            targetId: itemId,
            summary: `SpecFlow phase "${sfMeta.specflow_phase}" error: ${msg}`,
            metadata: { error: msg },
          });
        } finally {
          try { bb.deregisterAgent(sessionId); } catch { /* best effort */ }
        }
        return;
      }

      // Determine if this is a merge-fix recovery work item
      const mfMeta = parseMergeFixMeta(item.metadata);
      if (mfMeta && project) {
        const mfWorktreePath = resolveWorktreePath(project.local_path, mfMeta.branch, mfMeta.project_id);
        try {
          await runMergeFix(bb, item, mfMeta, project, sessionId, launcher, timeoutMs);
          bb.completeWorkItem(itemId, sessionId);
        } catch (err: unknown) {
          const msg = err instanceof Error ? err.message : String(err);
          try { bb.releaseWorkItem(itemId, sessionId); } catch { /* best effort */ }
          bb.appendEvent({
            actorId: sessionId,
            targetId: itemId,
            summary: `Merge-fix failed for PR #${mfMeta.pr_number}: ${msg}`,
            metadata: { error: msg },
          });
        } finally {
          try { await removeWorktree(project.local_path, mfWorktreePath); } catch { /* best effort */ }
          try { bb.deregisterAgent(sessionId); } catch { /* best effort */ }
        }
        return;
      }

      // Determine if this is a GitHub work item
      const ghMeta = parseGithubMeta(item.metadata);
      let workDir = resolvedWorkDir;
      let worktreePath: string | null = null;
      let branch: string | null = null;
      let mainBranch: string | null = null;
      let didStash = false;

      // Set up worktree for GitHub items
      if (ghMeta.isGithub && ghMeta.issueNumber) {
        try {
          // Stash uncommitted changes if main is dirty
          didStash = await stashIfDirty(project.local_path);
          if (didStash) {
            bb.appendEvent({
              actorId: sessionId,
              targetId: itemId,
              summary: `Auto-stashed uncommitted changes in ${project.local_path} before worktree creation`,
            });
          }

          mainBranch = await getCurrentBranch(project.local_path);
          branch = `fix/issue-${ghMeta.issueNumber}`;
          worktreePath = await createWorktree(project.local_path, branch, item.project_id ?? undefined);
          workDir = worktreePath;

          bb.appendEvent({
            actorId: sessionId,
            targetId: itemId,
            summary: `Created worktree for "${item.title}" at ${worktreePath}`,
            metadata: { branch, worktreePath },
          });
        } catch (err: unknown) {
          const msg = err instanceof Error ? err.message : String(err);
          bb.appendEvent({
            actorId: sessionId,
            targetId: itemId,
            summary: `Failed to create worktree for "${item.title}": ${msg}`,
            metadata: { error: msg },
          });
          // Restore stash before exiting
          if (didStash) {
            await popStash(project.local_path);
          }
          try { bb.releaseWorkItem(itemId, sessionId); } catch { /* best effort */ }
          try { bb.deregisterAgent(sessionId); } catch { /* best effort */ }
          process.exit(1);
        }
      }

      const prompt = buildPrompt(item.title, item.description, itemId, sessionId);
      const startTime = Date.now();

      bb.appendEvent({
        actorId: sessionId,
        targetId: itemId,
        summary: `Worker started for "${item.title}" in ${workDir}`,
        metadata: { itemId, projectId: item.project_id, pid: process.pid, workDir },
      });

      // Send periodic heartbeats to prevent stale sweep during long-running agents.
      // sweepStaleAgents checks last_seen_at; heartbeats refresh it every 60s.
      const heartbeatInterval = setInterval(() => {
        try {
          const elapsed = Math.round((Date.now() - startTime) / 1000);
          bb.sendHeartbeat({
            sessionId,
            progress: `Working on "${item.title}" (${elapsed}s)`,
            workItemId: itemId,
          });
        } catch {
          // Non-fatal: best effort heartbeat
        }
      }, 60_000);

      try {
        const result = await launcher({
          workDir,
          prompt,
          timeoutMs,
          sessionId,
          disableMcp: true,
        });

        const durationMs = Date.now() - startTime;

        if (result.exitCode === 0) {
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
                  targetId: itemId,
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
                        targetId: itemId,
                        summary: `Auto-merged PR #${pr.number} (squash) for "${item.title}"`,
                        metadata: { prNumber: pr.number, autoMerge: true },
                      });

                      // Pull merged changes into main repo
                      try {
                        await pullMain(project.local_path, mainBranch);
                        bb.appendEvent({
                          actorId: sessionId,
                          targetId: itemId,
                          summary: `Pulled merged changes into ${project.local_path}`,
                          metadata: { mainBranch, pullAfterMerge: true },
                        });
                      } catch (pullErr: unknown) {
                        const pullMsg = pullErr instanceof Error ? pullErr.message : String(pullErr);
                        bb.appendEvent({
                          actorId: sessionId,
                          targetId: itemId,
                          summary: `Pull after merge failed (non-fatal): ${pullMsg}`,
                          metadata: { error: pullMsg },
                        });
                      }
                    } else {
                      // Create recovery work item for merge failure
                      const mergeFixId = createMergeFixWorkItem(bb, {
                        originalItemId: itemId,
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
                        targetId: itemId,
                        summary: `Auto-merge failed for PR #${pr.number} — created recovery item ${mergeFixId}`,
                        metadata: { prNumber: pr.number, autoMerge: false, mergeFixItemId: mergeFixId },
                      });
                    }
                  } catch (mergeErr: unknown) {
                    const mergeMsg = mergeErr instanceof Error ? mergeErr.message : String(mergeErr);
                    // Create recovery work item for merge error
                    const mergeFixId = createMergeFixWorkItem(bb, {
                      originalItemId: itemId,
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
                      targetId: itemId,
                      summary: `Auto-merge error for PR #${pr.number}: ${mergeMsg} — created recovery item ${mergeFixId}`,
                      metadata: { prNumber: pr.number, error: mergeMsg, mergeFixItemId: mergeFixId },
                    });
                  }
                }

                // Launch commenter agent to post on the issue (non-fatal)
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

                  const commentResult = await launcher({
                    workDir: worktreePath,
                    prompt: commentPrompt,
                    timeoutMs: 120_000, // 2 minute timeout
                    sessionId: `${sessionId}-comment`,
                    disableMcp: true,
                  });

                  if (commentResult.exitCode === 0) {
                    bb.appendEvent({
                      actorId: sessionId,
                      targetId: itemId,
                      summary: `Posted issue comment for #${ghMeta.issueNumber}`,
                    });
                  }
                } catch (commentErr: unknown) {
                  const msg = commentErr instanceof Error ? commentErr.message : String(commentErr);
                  bb.appendEvent({
                    actorId: sessionId,
                    targetId: itemId,
                    summary: `Commenter agent failed (non-fatal): ${msg}`,
                    metadata: { error: msg },
                  });
                }
              } else {
                bb.appendEvent({
                  actorId: sessionId,
                  targetId: itemId,
                  summary: `Agent produced no changes for "${item.title}" — skipping PR`,
                });
              }
            } catch (gitErr: unknown) {
              const msg = gitErr instanceof Error ? gitErr.message : String(gitErr);
              bb.appendEvent({
                actorId: sessionId,
                targetId: itemId,
                summary: `Post-agent git ops failed for "${item.title}": ${msg}`,
                metadata: { error: msg },
              });
              // Release instead of complete — branch may exist for manual PR
              bb.releaseWorkItem(itemId, sessionId);
              bb.appendEvent({
                actorId: sessionId,
                targetId: itemId,
                summary: `Released "${item.title}" after git failure (${Math.round(durationMs / 1000)}s)`,
                metadata: { itemId, exitCode: 0, durationMs, gitError: msg },
              });
              return; // Skip the completeWorkItem below
            }
          }

          // Tana write-back on success (non-fatal)
          const tanaMeta = parseTanaMeta(item.metadata);
          if (tanaMeta.isTana && tanaMeta.nodeId) {
            try {
              const tanaAccessor = getTanaAccessor();
              const resultContent = `- ✅ Ivy completed this task\n  - **Result:** Completed "${item.title}"\n  - **Completed:** ${new Date().toISOString()}`;
              await tanaAccessor.addChildContent(tanaMeta.nodeId, resultContent);
              await tanaAccessor.checkNode(tanaMeta.nodeId);
              bb.appendEvent({
                actorId: sessionId,
                targetId: itemId,
                summary: `Tana write-back: checked off node ${tanaMeta.nodeId}`,
                metadata: { tanaNodeId: tanaMeta.nodeId, writeBack: 'success' },
              });
            } catch (tanaErr: unknown) {
              const tanaMsg = tanaErr instanceof Error ? tanaErr.message : String(tanaErr);
              bb.appendEvent({
                actorId: sessionId,
                targetId: itemId,
                summary: `Tana write-back failed (non-fatal): ${tanaMsg}`,
                metadata: { tanaNodeId: tanaMeta.nodeId, error: tanaMsg },
              });
            }
          }

          bb.completeWorkItem(itemId, sessionId);
          bb.appendEvent({
            actorId: sessionId,
            targetId: itemId,
            summary: `Completed "${item.title}" (exit 0, ${Math.round(durationMs / 1000)}s)`,
            metadata: { itemId, exitCode: 0, durationMs },
          });
        } else {
          // Tana write-back on failure (non-fatal)
          const tanaMeta = parseTanaMeta(item.metadata);
          if (tanaMeta.isTana && tanaMeta.nodeId) {
            try {
              const tanaAccessor = getTanaAccessor();
              const errorContent = `- ❌ Ivy encountered an error\n  - **Error:** Agent exited with code ${result.exitCode}\n  - **Attempted:** ${new Date().toISOString()}\n  - **Status:** Task left pending for retry or manual action`;
              await tanaAccessor.addChildContent(tanaMeta.nodeId, errorContent);
              // Do NOT check off the node — leave it unchecked for retry
              bb.appendEvent({
                actorId: sessionId,
                targetId: itemId,
                summary: `Tana write-back: added error context to node ${tanaMeta.nodeId}`,
                metadata: { tanaNodeId: tanaMeta.nodeId, writeBack: 'error_reported' },
              });
            } catch (tanaErr: unknown) {
              const tanaMsg = tanaErr instanceof Error ? tanaErr.message : String(tanaErr);
              bb.appendEvent({
                actorId: sessionId,
                targetId: itemId,
                summary: `Tana write-back failed (non-fatal): ${tanaMsg}`,
                metadata: { tanaNodeId: tanaMeta.nodeId, error: tanaMsg },
              });
            }
          }

          bb.releaseWorkItem(itemId, sessionId);
          bb.appendEvent({
            actorId: sessionId,
            targetId: itemId,
            summary: `Failed "${item.title}" (exit ${result.exitCode}, ${Math.round(durationMs / 1000)}s)`,
            metadata: {
              itemId,
              exitCode: result.exitCode,
              durationMs,
              stderr: result.stderr.slice(0, 500),
            },
          });
        }
      } catch (err: unknown) {
        const msg = err instanceof Error ? err.message : String(err);
        const durationMs = Date.now() - startTime;

        try { bb.releaseWorkItem(itemId, sessionId); } catch { /* best effort */ }

        bb.appendEvent({
          actorId: sessionId,
          targetId: itemId,
          summary: `Worker error for "${item.title}": ${msg}`,
          metadata: { itemId, error: msg, durationMs },
        });
      } finally {
        clearInterval(heartbeatInterval);
        // Always clean up worktree
        if (worktreePath) {
          try {
            await removeWorktree(project.local_path, worktreePath);
            bb.appendEvent({
              actorId: sessionId,
              targetId: itemId,
              summary: `Cleaned up worktree at ${worktreePath}`,
            });
          } catch (cleanupErr: unknown) {
            const msg = cleanupErr instanceof Error ? cleanupErr.message : String(cleanupErr);
            bb.appendEvent({
              actorId: sessionId,
              targetId: itemId,
              summary: `Worktree cleanup failed (non-fatal): ${msg}`,
              metadata: { worktreePath, error: msg },
            });
          }
        }
        // Restore stashed changes
        if (didStash) {
          const restored = await popStash(project.local_path);
          bb.appendEvent({
            actorId: sessionId,
            targetId: itemId,
            summary: restored
              ? `Restored stashed changes in ${project.local_path}`
              : `Failed to restore stash in ${project.local_path} — run 'git stash pop' manually`,
          });
        }
        try { bb.deregisterAgent(sessionId); } catch { /* best effort */ }
      }
    });
}


