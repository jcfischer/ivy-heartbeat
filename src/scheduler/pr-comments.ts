/**
 * PR comment fetching and formatting for rework feedback loops.
 *
 * Fetches review comments from GitHub PRs using the `gh api` CLI
 * with a 30-second timeout via AbortController.
 */

/**
 * A file-level inline comment from a PR review.
 */
export interface InlineComment {
  path: string;
  line: number;
  body: string;
  author: string;
  created_at: string;
}

/**
 * A top-level review on a PR.
 */
export interface Review {
  id: number;
  body: string;
  state: string;
  author: string;
  submitted_at: string;
}

/** Default timeout for gh API calls (30 seconds). */
const GH_API_TIMEOUT_MS = 30_000;

/**
 * Spawn a `gh api` command with a timeout.
 * Returns parsed JSON on success, throws on timeout or error.
 */
async function ghApi<T>(endpoint: string, timeoutMs = GH_API_TIMEOUT_MS): Promise<T> {
  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), timeoutMs);

  try {
    const proc = Bun.spawn(['gh', 'api', endpoint, '--paginate'], {
      stdout: 'pipe',
      stderr: 'pipe',
      signal: controller.signal,
    });

    const [stdout, stderr] = await Promise.all([
      new Response(proc.stdout).text(),
      new Response(proc.stderr).text(),
    ]);
    const exitCode = await proc.exited;

    if (exitCode !== 0) {
      throw new Error(`gh api ${endpoint} failed (exit ${exitCode}): ${stderr.trim()}`);
    }

    return JSON.parse(stdout) as T;
  } finally {
    clearTimeout(timeout);
  }
}

/**
 * Fetch all review comments from a PR using the GitHub API.
 *
 * Calls two endpoints:
 * - `repos/{repo}/pulls/{pr}/reviews` for top-level review bodies
 * - `repos/{repo}/pulls/{pr}/comments` for file-level inline comments
 *
 * Returns within 30 seconds per call or throws a timeout error.
 */
export async function fetchPRComments(
  repo: string,
  prNumber: number,
  timeoutMs = GH_API_TIMEOUT_MS,
): Promise<{ reviews: Review[]; inlineComments: InlineComment[] }> {
  // Fetch reviews and inline comments in parallel
  const [rawReviews, rawComments] = await Promise.all([
    ghApi<any[]>(`repos/${repo}/pulls/${prNumber}/reviews`, timeoutMs),
    ghApi<any[]>(`repos/${repo}/pulls/${prNumber}/comments`, timeoutMs),
  ]);

  const reviews: Review[] = rawReviews.map((r: any) => ({
    id: r.id,
    body: r.body ?? '',
    state: r.state ?? '',
    author: r.user?.login ?? 'unknown',
    submitted_at: r.submitted_at ?? '',
  }));

  const inlineComments: InlineComment[] = rawComments.map((c: any) => ({
    path: c.path ?? '',
    line: c.line ?? c.original_line ?? 0,
    body: c.body ?? '',
    author: c.user?.login ?? 'unknown',
    created_at: c.created_at ?? '',
  }));

  return { reviews, inlineComments };
}

/**
 * Format PR review comments into a structured prompt section.
 *
 * Produces markdown with:
 * - Top-level review summaries (from `changes_requested` reviews)
 * - File-level inline comments with paths and line numbers
 */
export function formatCommentsForPrompt(
  reviews: Review[],
  comments: InlineComment[],
): string {
  const parts: string[] = [];

  // Only include reviews that request changes and have a body
  const changesRequested = reviews.filter(
    (r) => r.state === 'CHANGES_REQUESTED' && r.body.trim(),
  );

  if (changesRequested.length > 0) {
    parts.push('## Review Comments');
    parts.push('');
    for (const r of changesRequested) {
      parts.push(`### Review by @${r.author}`);
      parts.push(r.body);
      parts.push('');
    }
  }

  if (comments.length > 0) {
    parts.push('## File-Level Comments');
    parts.push('');
    for (const c of comments) {
      parts.push(`### ${c.path}:${c.line}`);
      parts.push(`> ${c.body}`);
      parts.push(`— @${c.author}`, '');
    }
  }

  return parts.join('\n');
}
