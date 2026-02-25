/**
 * PR body extraction utilities for SpecFlow complete phase.
 * Extracts feature summaries from spec.md and plan.md files.
 */

export interface FileChange {
  path: string;
  additions: number;
  deletions: number;
}

/**
 * Extract content between a matched heading and the next heading.
 * @param content - The full markdown content
 * @param match - RegExp match result containing the heading
 * @returns Section content between this heading and the next, trimmed
 */
function extractSectionContent(content: string, match: RegExpMatchArray): string {
  const startIdx = match.index! + match[0].length;
  const remainingContent = content.substring(startIdx);
  const nextHeadingMatch = remainingContent.match(/^##?\s+/m);
  const endIdx = nextHeadingMatch ? nextHeadingMatch.index! : remainingContent.length;
  return remainingContent.substring(0, endIdx).trim();
}

/**
 * Extract Problem Statement section from spec markdown.
 * @param specContent - Raw markdown content from spec.md
 * @returns Extracted problem statement (up to 300 chars) or fallback text
 */
export function extractProblemStatement(specContent: string): string {
  // Try various Problem Statement heading formats
  const headingPatterns = [
    /^##\s+Problem\s+Statement\s*$/im,
    /^#\s+Problem\s+Statement\s*$/im,
    /^##\s+Problem\s*$/im,
    /^#\s+Problem\s*$/im
  ];

  for (const pattern of headingPatterns) {
    const match = specContent.match(pattern);
    if (match) {
      const sectionContent = extractSectionContent(specContent, match);

      if (sectionContent.length > 0) {
        // Extract first 2-3 sentences or up to 300 characters
        const sentences = sectionContent.split(/[.!?]\s+/).slice(0, 3).join('. ');
        const truncated = sentences.length > 300
          ? sentences.substring(0, 297) + '...'
          : sentences;

        // Ensure it ends with punctuation
        return truncated.endsWith('.') || truncated.endsWith('...')
          ? truncated
          : truncated + '.';
      }
    }
  }

  // Fallback if no Problem Statement section found
  return "See spec.md for full feature details";
}

/**
 * Extract key technical decisions from plan markdown.
 * @param planContent - Raw markdown content from plan.md
 * @returns Array of decision bullet points (up to 5) or fallback array
 */
export function extractKeyDecisions(planContent: string): string[] {
  // Look for sections related to technical decisions
  const decisionSections = [
    /^##\s+(?:Technical\s+)?(?:Approach|Decisions|Strategy|Implementation)/im,
    /^#\s+(?:Technical\s+)?(?:Approach|Decisions|Strategy|Implementation)/im,
    /^##\s+Key\s+Decisions/im,
    /^##\s+Implementation\s+(?:Phases|Strategy)/im
  ];

  const decisions: string[] = [];

  for (const pattern of decisionSections) {
    const match = planContent.match(pattern);
    if (match) {
      const sectionContent = extractSectionContent(planContent, match);

      // Extract bullet points (lines starting with - or *)
      const bulletPattern = /^[\s]*[-*]\s+(.+)$/gm;
      let bulletMatch;

      while ((bulletMatch = bulletPattern.exec(sectionContent)) !== null) {
        const decision = bulletMatch[1].trim();
        // Avoid duplicates and limit to 5 decisions
        if (!decisions.includes(decision) && decisions.length < 5) {
          decisions.push(decision);
        }
      }

      // If we found decisions in this section, stop looking
      if (decisions.length > 0) {
        break;
      }
    }
  }

  // Return fallback if no decisions found
  return decisions.length > 0
    ? decisions
    : ["See plan.md for implementation details"];
}

/**
 * Get files changed summary from git diff.
 * @param baseBranch - Base branch to compare against
 * @param featureBranch - Feature branch with changes
 * @returns Array of file changes or empty array on failure
 */
export async function getFilesChangedSummary(
  baseBranch: string,
  featureBranch: string
): Promise<FileChange[]> {
  try {
    const proc = Bun.spawn(['git', 'diff', '--stat', `${baseBranch}...${featureBranch}`], {
      stdout: 'pipe',
      stderr: 'pipe'
    });

    const output = await new Response(proc.stdout).text();
    const exitCode = await proc.exited;

    if (exitCode !== 0) {
      return [];
    }

    // Parse git diff --stat output
    // Format: " path/to/file.ts | 10 +++++++---"
    const lines = output.trim().split('\n');
    const changes: FileChange[] = [];

    for (const line of lines) {
      // Skip summary line (last line with "X files changed")
      if (line.includes('file') && line.includes('changed')) {
        continue;
      }

      const match = line.match(/^\s*(.+?)\s+\|\s+(\d+)\s+([+-]+)/);
      if (match) {
        const [, path, totalChanges, plusMinus] = match;
        const additions = (plusMinus.match(/\+/g) || []).length;
        const deletions = (plusMinus.match(/-/g) || []).length;

        changes.push({
          path: path.trim(),
          additions,
          deletions
        });
      }
    }

    return changes;
  } catch (error) {
    // Gracefully handle any errors
    return [];
  }
}

/**
 * Format file changes as markdown table.
 * @param files - Array of file changes
 * @returns Formatted markdown table or fallback message
 */
export function formatFilesChanged(files: FileChange[]): string {
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
