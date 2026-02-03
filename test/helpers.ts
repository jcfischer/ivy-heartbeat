import { mkdtempSync, rmSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { Blackboard } from '../src/blackboard.ts';

export interface TestContext {
  tmpDir: string;
  dbPath: string;
  bb: Blackboard;
}

export function createTestContext(): TestContext {
  const tmpDir = mkdtempSync(join(tmpdir(), 'bb-test-'));
  const dbPath = join(tmpDir, 'test.db');
  const bb = new Blackboard(dbPath);
  return { tmpDir, dbPath, bb };
}

export function cleanupTestContext(ctx: TestContext): void {
  ctx.bb.close();
  rmSync(ctx.tmpDir, { recursive: true, force: true });
}
