/**
 * VCS Provider Abstraction
 *
 * Provides a unified interface for GitHub and GitLab operations,
 * allowing the dispatch pipeline to work with either platform.
 */

export type VCSPlatform = 'github' | 'gitlab';

export interface CreateMROptions {
  cwd: string;
  title: string;
  body: string;
  base: string;
  head?: string; // defaults to current branch
}

export interface MRResult {
  number: number;
  url: string;
}

export type MRState = 'MERGED' | 'OPEN' | 'CLOSED';
export type ReviewEvent = 'APPROVE' | 'REQUEST_CHANGES';

export interface Review {
  id: string;
  state: 'APPROVED' | 'CHANGES_REQUESTED' | 'COMMENTED';
  body: string;
  author: string;
  submittedAt: string;
}

export interface InlineComment {
  id: string;
  path: string;
  line: number;
  body: string;
  author: string;
  createdAt: string;
}

export interface IssueStatus {
  number: number;
  state: 'open' | 'closed';
  title: string;
  body: string;
  author: string;
  labels: string[];
}

/**
 * VCS Provider Interface
 *
 * All platform-specific operations are abstracted behind this interface.
 * Implementations: GitHubProvider (wraps gh CLI), GitLabProvider (wraps glab CLI)
 */
export interface VCSProvider {
  /** Platform identifier */
  platform: VCSPlatform;

  // Pull/Merge Request operations
  createMR(opts: CreateMROptions): Promise<MRResult>;
  mergeMR(cwd: string, mrNumber: number): Promise<boolean>;
  getMRState(cwd: string, mrNumber: number): Promise<MRState | null>;
  getMRDiff(cwd: string, mrNumber: number): Promise<string>;
  getMRFiles(cwd: string, mrNumber: number): Promise<string[]>;

  // Review operations
  postReviewComment(cwd: string, mrNumber: number, body: string): Promise<void>;
  submitReview(
    cwd: string,
    mrNumber: number,
    event: ReviewEvent,
    body: string
  ): Promise<void>;
  fetchReviews(cwd: string, mrNumber: number): Promise<Review[]>;
  fetchInlineComments(cwd: string, mrNumber: number): Promise<InlineComment[]>;

  // Issue operations
  commentOnIssue(cwd: string, issueNumber: number, body: string): Promise<void>;
  getIssueStatus(ownerRepo: string, issueNumber: number): Promise<IssueStatus | null>;

  // API escape hatch for platform-specific operations
  api<T>(endpoint: string, timeoutMs?: number): Promise<T>;
}
