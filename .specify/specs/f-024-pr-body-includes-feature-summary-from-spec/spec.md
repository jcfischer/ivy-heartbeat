# Feature Specification: PR Body Includes Feature Summary from Spec

## Overview

SpecFlow's `complete` phase currently generates pull request bodies that contain only stub references to `spec.md` and `plan.md` files on the feature branch. This makes it difficult for external reviewers to quickly understand what a PR does without navigating to branch files. This feature enhances PR body generation to include:

1. A summary of what the feature does (extracted from spec's Problem Statement)
2. Key implementation decisions (extracted from plan)
3. Files changed summary with line counts

The original spec/plan file references will remain as supplementary links for reviewers who want full detail.

## Problem Statement

**Current State:**
The `complete` phase in SpecFlow generates PR bodies that look like this:

```
Feature: F-XXX Name

See spec.md and plan.md on this branch for details.
```

**Pain Points:**
- External reviewers (open-source contributors, stakeholders) cannot assess PRs without clicking through to branch files
- PR bodies lack searchable context—historical PRs become hard to understand if spec files are later moved or deleted
- Stub format appears unprofessional and low-effort
- No quick way to understand implementation approach without reading full plan

**Desired State:**
PR bodies should provide meaningful standalone summaries while preserving links to full documentation.

## User Scenarios

### Scenario 1: External Reviewer Assesses PR

**Given:** A contributor opens a SpecFlow-generated PR for review
**When:** The reviewer opens the PR on GitHub
**Then:** The PR body contains:
- A 2-3 sentence summary of what the feature does
- Bullet points listing key implementation decisions
- A "Files Changed" section showing modified files and line counts
- Links to full spec.md and plan.md as "See full details" section

**Acceptance Criteria:**
- Reviewer can understand feature intent without leaving PR page (FR-1)
- Implementation approach is clear from PR body (FR-2)
- Full documentation remains accessible via links (FR-4)

### Scenario 2: Historical PR Search

**Given:** A user searches GitHub for PRs related to "embedding" features
**When:** The search returns a closed PR from 3 months ago
**Then:** The PR body contains the feature summary inline, not just a link to files that may no longer exist

**Acceptance Criteria:**
- PR body text is searchable on GitHub (FR-1)
- PR remains understandable even if branch is deleted (FR-1)

### Scenario 3: Spec File Missing Problem Statement

**Given:** A spec.md file exists but lacks a "Problem Statement" section
**When:** The `complete` phase generates the PR body
**Then:** The PR body generation does not crash and includes fallback text like "See spec.md for feature details"

**Acceptance Criteria:**
- Missing sections handled gracefully without errors (FR-5)
- PR body still generated successfully (FR-5)

## Functional Requirements

**FR-1: Extract Problem Statement from Spec**
- Read spec.md from feature branch
- Locate "Problem Statement" section (support variations: `## Problem Statement`, `# Problem`, `## Problem`)
- Extract first 2-3 sentences or up to 300 characters
- Include in PR body under "## Summary" heading

**FR-2: Extract Key Decisions from Plan**
- Read plan.md from feature branch
- Locate sections related to technical decisions (e.g., "Technical Approach", "Key Decisions", "Implementation Strategy")
- Extract 3-5 bullet points of key decisions
- Include in PR body under "## Implementation Approach" heading

**FR-3: Include Files Changed Summary**
- Run `git diff --stat` against base branch
- Format as markdown table or list showing:
  - File path
  - Lines added/removed
- Include in PR body under "## Files Changed" heading

**FR-4: Preserve Existing Spec/Plan References**
- Original links to spec.md and plan.md must remain in PR body
- Place under "## Full Documentation" or similar heading at end of PR body

**FR-5: Handle Missing Sections Gracefully**
- If Problem Statement section not found in spec: use fallback text "See spec.md for full feature details"
- If plan.md not found or has no decision sections: use fallback text "See plan.md for implementation details"
- Never crash PR body generation due to missing or malformed spec/plan files

**FR-6: Maintain Backward Compatibility**
- Changes scoped to `specflow-runner.ts` around line 1358 where `prBody` is constructed
- No changes to spec.md or plan.md formats required
- Existing tests for PR body generation must continue to pass

## Non-Functional Requirements

**NFR-1: Performance**
- PR body generation should add < 2 seconds to `complete` phase execution time

**NFR-2: Maintainability**
- Extraction logic should be modular (separate functions for spec extraction, plan extraction, files changed)
- Use markdown parsing library if needed for robust heading detection

**NFR-3: Size Limit**
- PR body should remain under 4000 characters to avoid GitHub truncation
- If extracted content exceeds limits, truncate gracefully with "..." indicator

## Success Criteria

1. **Usability:** External reviewers can understand PR intent without leaving GitHub PR page
2. **Searchability:** PR body text is searchable on GitHub for historical PRs
3. **Robustness:** PR generation succeeds even with missing or malformed spec/plan files
4. **Consistency:** All future SpecFlow complete-phase PRs use the enhanced format
5. **No Regression:** Existing PR body tests pass, no breaking changes to SpecFlow workflows

## Assumptions

1. Spec.md files follow SpecFlow spec format with markdown headings
2. Plan.md files contain sections describing technical decisions
3. Git is available in the execution environment for `git diff --stat`
4. Feature branch has spec.md and plan.md in `.specify/specs/<feature-dir>/` directory

## Out of Scope

- Customizing PR body format per-project (use single default format)
- Parsing complex markdown tables or code blocks from specs
- Generating PR descriptions for non-SpecFlow workflows
- Automatically updating existing PR bodies (only applies to new PRs)

---

**Feature ID:** F-024
**Phase:** Specify
**Created:** 2026-02-25
