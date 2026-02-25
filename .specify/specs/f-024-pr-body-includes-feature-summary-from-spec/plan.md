# Technical Plan: PR Body Includes Feature Summary from Spec

## Architecture Overview

```
┌─────────────────┐     ┌──────────────────┐     ┌─────────────────┐
│ specflow-runner │────>│ Extraction Utils │────>│  Git Commands   │
│   (line ~1358)  │     │  - extractProblem│     │  git diff --stat│
│                 │     │  - extractPlan   │     └─────────────────┘
│                 │     │  - getFilesStat  │
└─────────────────┘     └──────────────────┘
         │
         v
   ┌─────────────┐
   │  PR Body    │
   │  Template   │
   └─────────────┘
```

**Flow:**
1. Complete phase reads spec.md and plan.md from feature branch
2. Extraction utilities parse markdown to find specific sections
3. Git command generates files changed summary
4. Template assembles all pieces into final PR body
5. Existing tests verify format and fallback behavior

## Technology Stack

| Component | Choice | Rationale |
|-----------|--------|-----------|
| Runtime | Bun | Project standard, existing in codebase |
| File I/O | `Bun.file()` | Native Bun API for reading spec/plan |
| Git | `git diff --stat` | Standard git tooling, already available |
| Markdown parsing | Regex-based | Simple heading detection, no external deps needed |
| Testing | Bun test | Project standard |

**No new dependencies required** - all functionality uses existing Node/Bun APIs and git.

## Data Model

No persistent data model needed. All data flows through in-memory processing:

```typescript
interface PRBodyData {
  featureName: string;
  featureId: string;
  summary: string;           // Extracted from spec Problem Statement
  approach: string[];        // Bullet points from plan decisions
  filesChanged: FileChange[]; // From git diff --stat
  specPath: string;          // Link to spec.md
  planPath: string;          // Link to plan.md
}

interface FileChange {
  path: string;
  additions: number;
  deletions: number;
}
```

## Implementation Phases

### Phase 1: Extraction Utilities (Core Logic)

**File:** `src/lib/pr-body-extractor.ts` (new file)

Create three extraction functions:

1. **`extractProblemStatement(specContent: string): string`**
   - Use regex to find Problem Statement heading (flexible matching: `## Problem Statement`, `# Problem`, etc.)
   - Extract first 2-3 sentences or up to 300 characters
   - Return extracted text or fallback: "See spec.md for full feature details"

2. **`extractKeyDecisions(planContent: string): string[]`**
   - Find sections like "Technical Approach", "Key Decisions", "Implementation Strategy"
   - Extract bullet points (lines starting with `-` or `*`)
   - Return up to 5 key points or fallback: ["See plan.md for implementation details"]

3. **`getFilesChangedSummary(baseBranch: string, featureBranch: string): FileChange[]`**
   - Execute `git diff --stat ${baseBranch}...${featureBranch}`
   - Parse output into structured data
   - Format as markdown table

**Edge cases:**
- Heading not found → return fallback text
- No bullet points in plan → return fallback array
- Git command fails → return empty array with note "Files changed: see PR diff"

### Phase 2: PR Body Template

**File:** Modify `src/scheduler/specflow-runner.ts` around line 1358

Current code structure:
```typescript
const prBody = `Feature: ${feature.name}\n\nSee spec.md and plan.md on this branch for details.`;
```

**New structure:**
```typescript
import { extractProblemStatement, extractKeyDecisions, getFilesChangedSummary } from '../lib/pr-body-extractor';

// Read spec and plan
const specContent = await Bun.file(specPath).text();
const planContent = await Bun.file(planPath).text();

// Extract sections
const summary = extractProblemStatement(specContent);
const approach = extractKeyDecisions(planContent);
const filesChanged = getFilesChangedSummary(baseBranch, featureBranch);

// Assemble PR body
const prBody = `# Feature: ${feature.name}

## Summary

${summary}

## Implementation Approach

${approach.map(point => `- ${point}`).join('\n')}

## Files Changed

${formatFilesChanged(filesChanged)}

## Full Documentation

- [Specification](${specPath})
- [Technical Plan](${planPath})
`;

// Truncate if over 4000 characters
const finalPRBody = prBody.length > 4000
  ? prBody.substring(0, 3997) + '...'
  : prBody;
```

### Phase 3: Formatting Utilities

**File:** `src/lib/pr-body-extractor.ts` (add to existing file)

```typescript
function formatFilesChanged(files: FileChange[]): string {
  if (files.length === 0) {
    return "_See PR diff for file changes_";
  }

  const table = [
    "| File | Changes |",
    "|------|---------|",
    ...files.map(f => `| \`${f.path}\` | +${f.additions} -${f.deletions} |`)
  ];

  return table.join('\n');
}
```

### Phase 4: Testing

**File:** `tests/pr-body-extractor.test.ts` (new file)

Test cases:
1. **Happy path:** Spec with Problem Statement, plan with decisions → full PR body
2. **Missing Problem Statement:** Spec without section → fallback text
3. **Missing plan sections:** Plan without decisions → fallback text
4. **Malformed markdown:** Random text → graceful fallback
5. **Character limit:** Very long content → truncation to 4000 chars
6. **Git command fails:** No files changed data → fallback message

**File:** Update existing `tests/specflow-runner.test.ts`

Verify:
- Existing PR body tests still pass
- New PR body format matches expected structure
- No regression in complete phase behavior

## File Structure

```
src/
├── lib/
│   └── pr-body-extractor.ts      # NEW: Extraction and formatting logic
├── scheduler/
│   └── specflow-runner.ts         # MODIFIED: Use extractor in complete phase
tests/
├── pr-body-extractor.test.ts      # NEW: Unit tests for extraction
└── specflow-runner.test.ts        # MODIFIED: Integration tests for complete phase
```

## Dependencies

### Existing (No New Dependencies)
- Bun runtime (file I/O)
- Git (already required by SpecFlow)
- Bun test framework

### Assumptions
- Git is available in PATH
- Feature branch exists with spec.md and plan.md
- User has read access to feature branch files

## Risk Assessment

| Risk | Impact | Mitigation |
|------|--------|------------|
| **Markdown parsing fragility** | High - Could fail on heading variations | Use flexible regex patterns, extensive test coverage for heading variations |
| **Git command failure** | Medium - No files changed data | Graceful fallback to "See PR diff" message, don't crash |
| **Character limit exceeded** | Low - GitHub truncates | Proactive truncation at 4000 chars with "..." indicator |
| **Spec/plan files missing** | Medium - Can't extract content | Try/catch around file reads, use fallback text |
| **Breaking existing tests** | High - Regression risk | Run full test suite before commit, verify PR body format matches expectations |
| **Performance degradation** | Low - Extra file reads | File reads are fast, target < 2s addition per spec (NFR-1) |

## Implementation Checklist

- [ ] Create `src/lib/pr-body-extractor.ts` with extraction functions
- [ ] Add `formatFilesChanged()` utility
- [ ] Add `extractProblemStatement()` with regex heading detection
- [ ] Add `extractKeyDecisions()` with bullet point extraction
- [ ] Add `getFilesChangedSummary()` with git diff parsing
- [ ] Modify `specflow-runner.ts` to use extraction utilities
- [ ] Add character limit truncation (4000 chars)
- [ ] Create `tests/pr-body-extractor.test.ts` with unit tests
- [ ] Update `tests/specflow-runner.test.ts` integration tests
- [ ] Verify existing tests pass (no regression)
- [ ] Manual test: Create PR with enhanced body, verify on GitHub

## Success Metrics

1. **Usability:** PR reviewers can understand feature from PR body alone (no clicks to spec files)
2. **Robustness:** Zero crashes when spec/plan sections missing
3. **Performance:** < 2 seconds added to complete phase execution
4. **Coverage:** All edge cases tested (missing sections, malformed markdown, character limits)
5. **Adoption:** All future SpecFlow PRs use enhanced format automatically

---

**Feature ID:** F-024
**Phase:** Plan
**Created:** 2026-02-25
