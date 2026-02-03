/**
 * Simple heuristic fact extraction from assistant messages.
 * Looks for decision language, patterns, and key phrases.
 */

const FACT_PATTERNS = [
  /decided to (.+)/i,
  /key (?:decision|insight|finding): (.+)/i,
  /changed from (.+) to (.+)/i,
  /root cause (?:is|was) (.+)/i,
  /important: (.+)/i,
  /the (?:fix|solution|approach) (?:is|was) (.+)/i,
];

const PATTERN_INDICATORS = [
  /pattern: (.+)/i,
  /always (.+) before (.+)/i,
  /never (.+) without (.+)/i,
  /(?:best practice|convention): (.+)/i,
  /this project (?:uses|follows) (.+)/i,
];

export interface ExtractedFact {
  type: 'fact' | 'pattern';
  text: string;
  source: string; // The full message snippet where it was found
}

/**
 * Extract facts and patterns from assistant messages using simple heuristics.
 */
export function extractFacts(messages: string[]): ExtractedFact[] {
  const facts: ExtractedFact[] = [];

  for (const message of messages) {
    // Split into sentences for more granular matching
    const sentences = message.split(/[.!?\n]+/).filter((s) => s.trim().length > 10);

    for (const sentence of sentences) {
      const trimmed = sentence.trim();

      // Check fact patterns
      for (const pattern of FACT_PATTERNS) {
        const match = trimmed.match(pattern);
        if (match) {
          facts.push({
            type: 'fact',
            text: match[1]?.trim() ?? trimmed,
            source: trimmed.slice(0, 200),
          });
          break; // One fact per sentence
        }
      }

      // Check pattern indicators
      for (const pattern of PATTERN_INDICATORS) {
        const match = trimmed.match(pattern);
        if (match) {
          facts.push({
            type: 'pattern',
            text: match[1]?.trim() ?? trimmed,
            source: trimmed.slice(0, 200),
          });
          break;
        }
      }
    }
  }

  // Deduplicate by text
  const seen = new Set<string>();
  return facts.filter((f) => {
    if (seen.has(f.text)) return false;
    seen.add(f.text);
    return true;
  });
}
