export interface DispatchOptions {
  /** Max concurrent agent sessions (default: 1) */
  maxConcurrent: number;
  /** Max items to process per run (default: 1) */
  maxItems: number;
  /** Filter by priority — e.g. "P1" or "P1,P2" */
  priority?: string;
  /** Filter by project */
  project?: string;
  /** Show plan without executing */
  dryRun: boolean;
  /** Timeout per work item in minutes (default: 60) */
  timeout: number;
  /** Launch agents as detached processes and return immediately */
  fireAndForget?: boolean;
}

export interface LaunchOptions {
  /** Working directory (project local_path) */
  workDir: string;
  /** Prompt to pass to Claude Code */
  prompt: string;
  /** Timeout in milliseconds */
  timeoutMs: number;
  /** Session ID for logging */
  sessionId: string;
}

export interface LaunchResult {
  exitCode: number;
  stdout: string;
  stderr: string;
}

export type SessionLauncher = (opts: LaunchOptions) => Promise<LaunchResult>;

export interface DispatchedItem {
  itemId: string;
  title: string;
  projectId: string;
  sessionId: string;
  exitCode: number;
  completed: boolean;
  durationMs: number;
}

export interface SkippedItem {
  itemId: string;
  title: string;
  reason: string;
}

export interface DispatchResult {
  timestamp: string;
  dispatched: DispatchedItem[];
  skipped: SkippedItem[];
  errors: Array<{ itemId: string; title: string; error: string }>;
  dryRun: boolean;
}
