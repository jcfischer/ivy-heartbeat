---
task: Create sift CLI project wrapping ragent API
slug: 20260309-075053_create-sift-cli-project
effort: advanced
phase: complete
progress: 26/26
mode: interactive
started: 2026-03-09T07:50:53Z
updated: 2026-03-09T07:51:30Z
---

## Context

Create `~/work/sift` — a standalone, public-ready CLI tool that wraps the ragent API at getsift.ch.
The Plan agent designed the full architecture in the prior session. This session implements it.

Key decisions from prior design:
- TypeScript + Bun, compiled to `~/bin/sift`
- OAuth2 client credentials: exchange `client_id`+`client_secret` for JWT, cache with 60s buffer
- Commander.js with lazy `getClient()` factory (not loaded for `--help`/`--version`)
- Global `--json` flag for machine output
- Config: env vars > `~/.config/sift/config.json`
- Token cache: `~/.config/sift/token.json`

## Criteria

- [x] ISC-1: `~/work/sift/` directory created
- [x] ISC-2: `package.json` includes `bun build --compile` script targeting `~/bin/sift`
- [x] ISC-3: `tsconfig.json` present with strict mode
- [x] ISC-4: `src/config.ts` loads `CLIENT_ID` from env var `SIFT_CLIENT_ID`
- [x] ISC-5: `src/config.ts` loads `CLIENT_SECRET` from env var `SIFT_CLIENT_SECRET`
- [x] ISC-6: `src/config.ts` falls back to `~/.config/sift/config.json` when env vars absent
- [x] ISC-7: `src/config.ts` throws clear error when credentials missing from both sources
- [x] ISC-8: `src/token-cache.ts` reads cached token from `~/.config/sift/token.json`
- [x] ISC-9: `src/token-cache.ts` returns cached token if valid (60s buffer before expiry)
- [x] ISC-10: `src/token-cache.ts` exchanges credentials for new JWT via `POST /v1/auth/token`
- [x] ISC-11: `src/token-cache.ts` writes new token to `~/.config/sift/token.json` after exchange
- [x] ISC-12: `src/client.ts` exposes `search(query, limit?)` method
- [x] ISC-13: `src/client.ts` exposes `ask(question, mode?)` method with polling
- [x] ISC-14: `src/client.ts` exposes `topics(params?)` method
- [x] ISC-15: `src/client.ts` exposes `sources(params?)` method
- [x] ISC-16: `src/client.ts` sends `Authorization: Bearer <token>` header on every request
- [x] ISC-17: `src/main.ts` defines `sift search <query>` command
- [x] ISC-18: `src/main.ts` defines `sift ask <question>` command
- [x] ISC-19: `src/main.ts` defines `sift topics` command
- [x] ISC-20: `src/main.ts` defines `sift sources` command
- [x] ISC-21: `src/main.ts` defines global `--json` flag for machine-readable output
- [x] ISC-22: `getClient()` factory is lazy — not called during `--help` or `--version`
- [x] ISC-23: `scripts/build.sh` compiles to `~/bin/sift` via `bun build --compile`
- [x] ISC-24: `.gitignore` excludes `.env`, `*.bun-build`, `node_modules`
- [x] ISC-25: `README.md` documents installation, configuration, and all commands
- [x] ISC-26: `LICENSE` file contains MIT license text

## Decisions

## Verification
