# Contributing to ivy-heartbeat

Thank you for your interest in contributing to ivy-heartbeat! This document provides guidelines for contributing.

## Getting Started

1. Fork the repository
2. Clone your fork: `git clone https://github.com/YOUR_USERNAME/ivy-heartbeat.git`
3. Install dependencies: `bun install`
4. Create a feature branch: `git checkout -b feature/your-feature`

## Development

### Prerequisites

- [Bun](https://bun.sh) v1.1 or later
- [ivy-blackboard](https://github.com/jcfischer/ivy-blackboard) (peer dependency)

### Running Tests

```bash
bun test
```

### Code Style

- TypeScript with strict types
- Use Bun APIs over Node.js equivalents (see `CLAUDE.md`)
- Keep evaluators injectable for testing (fetcher pattern)
- Use Zod for schema validation

### Project Structure

- `src/commands/` — CLI command handlers
- `src/evaluators/` — Check evaluator implementations
- `src/check/` — Check pipeline (runner, due, guard)
- `src/alert/` — Alert dispatch channels
- `src/parser/` — Checklist markdown parser
- `test/` — Test files (mirror src/ structure)

## Submitting Changes

### Pull Requests

1. Ensure all tests pass: `bun test`
2. Write tests for new functionality
3. Keep PRs focused — one feature or fix per PR
4. Write a clear PR description explaining what and why

### Commit Messages

Use clear, descriptive commit messages:
- `Add calendar conflict threshold config`
- `Fix email evaluator timeout handling`
- `Update README with new CLI commands`

### Issues

- Use the bug report template for bugs
- Use the feature request template for new features
- Check existing issues before creating a new one

## Evaluator Development

To add a new check evaluator:

1. Create `src/evaluators/your-evaluator.ts`
2. Implement the evaluator function: `(item: ChecklistItem) => Promise<CheckResult>`
3. Use the injectable fetcher pattern for external dependencies
4. Register it in `src/check/evaluators.ts`
5. Add tests in `test/your-evaluator.test.ts`
6. Document the YAML config keys in the README

## License

By contributing, you agree that your contributions will be licensed under the MIT License.
