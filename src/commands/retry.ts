import { Command } from 'commander';
import type { CliContext } from '../cli.ts';
import type { BlackboardWorkItem } from '../blackboard.ts';

/**
 * `ivy-heartbeat retry <item-id>`
 *
 * Requeue a failed or quarantined work item for dispatch.
 * Resets failure_count to 0, clears failure_reason and failed_at,
 * sets status back to 'available'.
 */
export function registerRetryCommand(
  parent: Command,
  getContext: () => CliContext
): void {
  parent
    .command('retry <item-id>')
    .description('Requeue a failed or quarantined work item for dispatch')
    .action((itemId: string) => {
      const ctx = getContext();
      const bb = ctx.bb;

      const item = bb.db
        .query<BlackboardWorkItem>('SELECT * FROM work_items WHERE item_id = ?')
        .get(itemId);

      if (!item) {
        console.error(`Error: work item ${itemId} not found`);
        process.exit(1);
      }

      if (item.status !== 'failed' && item.status !== 'quarantined') {
        console.error(
          `Error: work item is not failed or quarantined (status: ${item.status})`
        );
        process.exit(1);
      }

      console.log(`Requeuing ${itemId} (was ${item.status} after ${item.failure_count} failure(s))`);
      if (item.failure_reason) {
        console.log(`  Failure reason: ${item.failure_reason}`);
      }

      bb.requeueWorkItem(itemId);

      console.log(`Requeued ${itemId} — will be picked up on next dispatch cycle`);
    });
}
