import type { Database } from 'bun:sqlite';
import type { Blackboard } from '../../blackboard.ts';
import type { SpecFlowFeature } from 'ivy-blackboard/src/types';

export type { SpecFlowFeature };

export interface PhaseExecutorOptions {
  worktreePath: string;
  projectPath: string;
  timeoutMs: number;
  sessionId: string;
  db: Database;
}

export interface PhaseResult {
  status: 'succeeded' | 'failed';
  error?: string;
  artifacts?: string[];
  sourceChanges?: boolean;
  evalScore?: number;
  metadata?: Record<string, unknown>;
}

export interface PhaseExecutor {
  /** Check if this executor can handle the given feature's current phase. */
  canRun(feature: SpecFlowFeature): boolean;

  /** Execute the phase. Never throws — errors are returned in PhaseResult. */
  execute(
    feature: SpecFlowFeature,
    bb: Blackboard,
    opts: PhaseExecutorOptions,
  ): Promise<PhaseResult>;
}
