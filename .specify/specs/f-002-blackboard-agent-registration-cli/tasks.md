# F-002: Tasks

## T-1: Add commander dependency
- [ ] `bun add commander@^14.0.3`
- [ ] Update package.json with bin entry: `"ivy-heartbeat": "src/cli.ts"`

## T-2: Create CLI entry point (src/cli.ts)
- [ ] Commander program with name, version, description
- [ ] Global options: `--json`, `--db <path>`
- [ ] Lazy Blackboard initialization with process exit cleanup
- [ ] Register agent and observe command groups

## T-3: Implement agent commands (src/commands/agent.ts)
- [ ] `register --name <name> [--project] [--work] [--parent]`
- [ ] `heartbeat --session <id> [--progress]`
- [ ] `deregister --session <id>`
- [ ] `list [--all] [--status]`
- [ ] Text and JSON output modes for each command

## T-4: Implement observe command (src/commands/observe.ts)
- [ ] `observe --events [--type] [--limit]`
- [ ] `observe --heartbeats [--session] [--limit]`
- [ ] Default limit: 20
- [ ] Text table and JSON output modes

## T-5: Write tests (test/cli.test.ts)
- [ ] Agent register returns session_id
- [ ] Agent heartbeat updates correctly
- [ ] Agent deregister completes session
- [ ] Agent list shows active agents
- [ ] Observe events with type filter
- [ ] Observe heartbeats with session filter
- [ ] Error handling for unknown sessions
