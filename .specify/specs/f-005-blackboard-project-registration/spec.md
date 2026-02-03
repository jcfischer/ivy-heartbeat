# F-005: Blackboard Project Registration

## Status: FULLY DELEGATED TO ivy-blackboard

### What Changed

The original spec assumed ivy-heartbeat would own project registration with its own CLI (`blackboard project register|list|status`). With the architecture change:

- **ivy-blackboard** now owns the projects table schema, all registration/update operations, and the `blackboard project` CLI commands.
- **ivy-heartbeat** does NOT provide project commands.

### What's Implemented

| Capability | Owner | Status |
|-----------|-------|--------|
| Projects table schema | ivy-blackboard | Done |
| Register/List | ivy-blackboard | Done |
| Project CLI (`blackboard project`) | ivy-blackboard | Done |

### Schema Differences from Original Spec

| Original ivy-heartbeat | ivy-blackboard (canonical) |
|------------------------|---------------------------|
| name TEXT | display_name TEXT |
| description TEXT | (no description field) |
| status: active/paused/completed | (no status field) |
| created_at TIMESTAMP | registered_at TEXT |
| — | local_path TEXT |
| — | remote_repo TEXT |
| — | metadata TEXT |

ivy-blackboard's project model is path/repo-oriented (linking to local directories and remote repos) rather than status-oriented. The pause/resume/complete workflow from the original spec doesn't apply.

### No Remaining Work in ivy-heartbeat

This feature is fully satisfied by ivy-blackboard. No ivy-heartbeat implementation needed.
