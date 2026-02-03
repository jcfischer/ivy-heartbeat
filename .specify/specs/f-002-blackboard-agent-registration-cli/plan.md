# F-002: Implementation Plan

## Approach

Build ivy-heartbeat's CLI framework using Commander.js, following ivy-blackboard's established patterns (formatTable, formatJson, withErrorHandling). All agent operations delegate to the Blackboard class; observe commands use the query repositories.

## Architecture

```
src/cli.ts              — Commander.js entry point (bin: "ivy-heartbeat")
src/commands/agent.ts   — agent register|heartbeat|deregister|list
src/commands/observe.ts — observe --events|--heartbeats with filters
```

Imports from ivy-blackboard:
- `formatTable`, `formatJson`, `formatRelativeTime` from `ivy-blackboard/src/output`
- `listAgents` from `ivy-blackboard/src/agent`

Imports from ivy-heartbeat:
- `Blackboard` class (wraps ivy-blackboard DB + query repos)

## Key Decisions

1. **Re-use ivy-blackboard's output helpers** — no duplication of formatTable/formatJson
2. **Lazy context pattern** — database opens on first command, closes on process exit
3. **Follow ivy-blackboard command registration pattern** — `register*Commands(parent, getBlackboard)` functions
4. **No custom error types** — use try/catch with process.exit(1) for CLI errors

## Files to Create

| File | Purpose |
|------|---------|
| `src/cli.ts` | Commander program, global options, lazy Blackboard init |
| `src/commands/agent.ts` | Agent lifecycle commands |
| `src/commands/observe.ts` | Observe commands for events/heartbeats |
| `test/cli.test.ts` | CLI command tests |

## Files to Modify

| File | Change |
|------|--------|
| `package.json` | Add commander dep, bin entry, script |

## Dependencies

- commander (^14.0.3, same version as ivy-blackboard)
- ivy-blackboard/src/output (formatTable, formatJson, formatRelativeTime)
- ivy-blackboard/src/agent (listAgents)
