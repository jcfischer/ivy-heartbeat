/**
 * Safe JSON parsing utilities
 */

/**
 * Safely parse JSON string, returning undefined if parsing fails
 * @param json JSON string to parse
 * @returns Parsed object or undefined if parse fails
 */
export function safeJSONParse<T>(json: string): T | undefined {
  try {
    return JSON.parse(json);
  } catch {
    return undefined;
  }
}
