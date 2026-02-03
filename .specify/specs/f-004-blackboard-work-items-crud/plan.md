# F-004: Implementation Plan

## Status: FULLY DELEGATED TO ivy-blackboard

No ivy-heartbeat implementation needed. All work item CRUD operations are handled by ivy-blackboard.

Use `blackboard work create|claim|release|complete|list` CLI from ivy-blackboard directly.

Downstream features (F-017 email adapter, F-018 calendar adapter) will access work items via `Blackboard.db` handle.
