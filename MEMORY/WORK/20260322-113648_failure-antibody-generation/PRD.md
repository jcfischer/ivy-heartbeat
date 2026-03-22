---
task: Failure antibody generation in Algorithm LEARN phase
slug: 20260322-113648_failure-antibody-generation
effort: standard
phase: complete
progress: 13/13
mode: interactive
started: 2026-03-22T11:36:48+01:00
updated: 2026-03-22T11:40:58+01:00
---

## Context

GitHub Issue #50 requests integration of a "failure antibody" pattern inspired by AI Team OS's Failure Alchemy. The goal is to transform Algorithm LEARN phase reflections into proactive prevention rules stored in Tana that surface during future OBSERVE phases.

Currently, Algorithm reflections are stored as JSONL entries in `~/.claude/MEMORY/LEARNING/REFLECTIONS/algorithm-reflections.jsonl`. These are mined periodically via MineReflections but don't proactively surface during work that could benefit from them.

This feature adds two integration points:
1. **LEARN phase generation**: After reflection questions, analyze the failure pattern and optionally generate 0-2 antibody rules as Tana #ai-memory nodes with category "antibody"
2. **OBSERVE phase retrieval**: Add a step to the mandatory OBSERVE checklist to search Tana for antibodies relevant to the current task type

### Request Analysis

**What was explicitly requested:**
- Structured antibody format stored in Tana #ai-memory nodes
- Generation in LEARN phase only when clear prevention pattern exists
- Retrieval in OBSERVE phase as part of mandatory checklist
- 90-day decay mechanism (flag for review if not referenced)
- Inspired by CronusL-1141/AI-company Failure Alchemy pattern

**What was NOT requested:**
- Generating antibodies for every reflection
- Storing antibodies outside Tana
- Blocking execution on antibody failures

### Risks

**Supertag CLI field setting:** The Category field may not have an "antibody" option yet. Mitigation: use Tana Paste format with import_tana_paste instead of direct field setting, or document that option must be added manually first.

**Antibody generation heuristic:** Determining "actionable prevention pattern" vs generic learning is subjective. Mitigation: provide clear examples in Algorithm instructions (e.g., "missing prerequisite check" vs "should have thought harder").

**OBSERVE phase noise:** Antibody search might return irrelevant matches. Mitigation: keep search narrow with task-type keywords, limit to 3-5 results max.

## Criteria

- [x] ISC-1: Antibody generation step added to Algorithm LEARN phase after reflection questions
- [x] ISC-2: Antibody generation only triggers when failure pattern is actionable
- [x] ISC-3: Antibody format follows Tana #ai-memory schema with category "antibody"
- [x] ISC-4: Antibody nodes include confidence field (high/medium)
- [x] ISC-5: Antibody nodes include source field set to "algorithm-reflection"
- [x] ISC-6: Antibody context field links to original PRD slug and date
- [x] ISC-7: Antibody constraint text uses imperative voice ("Before X, check Y")
- [x] ISC-8: Antibody creation uses supertag CLI create command
- [x] ISC-9: OBSERVE phase checklist includes antibody search step
- [x] ISC-10: Antibody search queries by category "antibody" and task-relevant keywords
- [x] ISC-11: Retrieved antibodies display in OBSERVE output before reverse engineering
- [x] ISC-12: Algorithm v3.7.0.md updated with LEARN phase antibody generation instructions
- [x] ISC-13: Algorithm v3.7.0.md updated with OBSERVE phase antibody retrieval instructions

## Decisions

## Verification

### ISC-1 through ISC-8: LEARN phase antibody generation
**Evidence:** Algorithm v3.7.0.md lines 390-432 contain complete antibody generation section
- When to generate / when not to generate criteria (lines 392-400)
- Generation process with 4 steps (lines 402-407)
- JSON format example with all required fields (lines 411-422)
- supertag CLI create command (line 424)
- Imperative constraint phrasing examples (lines 427-430)
- Max 2 antibodies per reflection limit (line 432)

**Verified with:** Read tool at lines 382-441

### ISC-9 through ISC-11: OBSERVE phase antibody retrieval
**Evidence:** Algorithm v3.7.0.md line 157 contains antibody search as check #5
- Search queries by --tag ai-memory --field "Category=antibody"
- Returns top 5 results with --limit 5
- Output formatted with emoji and node names
- Instructs to "review their constraints before planning"

**Verified with:** Read tool at lines 150-161

### ISC-12 and ISC-13: Algorithm documentation updates
**Evidence:** Both LEARN and OBSERVE sections updated with antibody instructions
- LEARN: lines 390-432 (42 lines of antibody generation guidance)
- OBSERVE: line 157 (antibody search command as mandatory checklist item)

**Verified with:** Read tool and grep confirmation

### Antibody creation syntax verification
**Evidence:** Dry-run test with supertag CLI succeeded
- Test JSON passed validation
- Command syntax confirmed: `supertag create ai-memory -f <json-file>`
- Field mapping works: Category, Confidence, Source, Context all mapped correctly
- Payload structure validated by CLI's dry-run mode

**Command output:** "✅ Validation passed - ready to post"

### Antibody search syntax verification
**Evidence:** Search command executed successfully
- Command: `~/bin/supertag search --tag ai-memory --field "Category=antibody" --json --limit 5`
- Piped through bun for formatting works correctly
- Returns "🧬 No relevant antibodies found" when empty (expected — no antibodies exist yet)
- Command will work when antibodies are created during future LEARN phases

**Verified with:** Bash execution showing successful search with empty result set
