# F-004: Blackboard Work Items CRUD

## Status: FULLY DELEGATED TO ivy-blackboard

### What Changed

The original spec assumed ivy-heartbeat would own work item CRUD operations with its own CLI (`blackboard work claim|release|complete|list`). With the architecture change:

- **ivy-blackboard** now owns the work_items table schema, all CRUD operations, stale lock detection, and the `blackboard work` CLI commands.
- **ivy-heartbeat** does NOT provide work item operations. It uses ivy-blackboard's work items indirectly (e.g., agents can reference work_item_id in heartbeats).

### What's Implemented

| Capability | Owner | Status |
|-----------|-------|--------|
| Work items table schema | ivy-blackboard | Done |
| Create/Claim/Release/Complete | ivy-blackboard | Done |
| Work items CLI (`blackboard work`) | ivy-blackboard | Done |
| Stale lock detection | ivy-blackboard (`sweep` command) | Done |

### ivy-heartbeat's Role

ivy-heartbeat does not need its own work item commands. The downstream features that use work items (F-017 email digest adapter, F-018 calendar awareness adapter) will create work items via ivy-blackboard's API directly through the `Blackboard.db` handle.

### No Remaining Work in ivy-heartbeat

This feature is fully satisfied by ivy-blackboard. No ivy-heartbeat implementation needed.

### Schema Differences from Original Spec

| Original ivy-heartbeat | ivy-blackboard (canonical) |
|------------------------|---------------------------|
| status: pending/in_progress/completed/blocked | status: available/claimed/completed/blocked |
| source: github/local/operator/email/calendar | source: github/local/operator |
| priority: INTEGER (1-5) | priority: TEXT (P1/P2/P3) |

Note: email and calendar sources are not supported by ivy-blackboard's CHECK constraint. F-017 and F-018 may need to use 'local' as source with metadata indicating the actual origin, or request ivy-blackboard to extend the source enum.
