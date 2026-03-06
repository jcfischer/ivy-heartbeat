# Documentation Updates — F-028: dead-letter-queue-typed-failure-states

Generated: 2026-03-06

## CHANGELOG

Entry added to CHANGELOG.md:
> - **F-028 dead-letter-queue-typed-failure-states**: The merge-fix loop (issue #41) is the canonical failure: a transient `gh pr merge` failure creates a merge-fix work item, which also fails, and the loop never terminates. The blackboard has no:

## User-Facing Changes

### CLI Changes
- ----
- ---------
- -----------
- ------
- --------
- -------
- ---

### API Changes
- GET /api/work-items/quarantined

## README Update

User-facing changes detected. Consider updating README.md with:

- New CLI commands/options in the Usage section
- New API endpoints in the API Reference section
