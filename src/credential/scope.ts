import { existsSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { homedir } from 'node:os';
import type { CredentialScopeConfig } from './types.ts';
import { DEFAULT_SCOPE_CONFIG } from './types.ts';

const CONFIG_PATH = join(homedir(), '.pai', 'credential-scopes.json');

/**
 * Load credential scope config from ~/.pai/credential-scopes.json.
 * Returns default allow-all config if file doesn't exist.
 */
export function loadScopeConfig(path?: string): CredentialScopeConfig {
  const configPath = path ?? CONFIG_PATH;

  if (!existsSync(configPath)) {
    return DEFAULT_SCOPE_CONFIG;
  }

  try {
    const raw = readFileSync(configPath, 'utf-8');
    const parsed = JSON.parse(raw);
    return {
      defaultPolicy: parsed.defaultPolicy ?? 'allow',
      rules: parsed.rules ?? {},
    };
  } catch {
    return DEFAULT_SCOPE_CONFIG;
  }
}

/**
 * Check if a skill is allowed to access a credential type.
 */
export function isCredentialAllowed(
  skill: string,
  credentialType: string,
  config?: CredentialScopeConfig
): boolean {
  const cfg = config ?? loadScopeConfig();

  // Check if skill has specific rules
  const allowedTypes = cfg.rules[skill];

  if (allowedTypes) {
    // Skill has explicit rules — check if credential type is in the list
    return allowedTypes.includes(credentialType) || allowedTypes.includes('*');
  }

  // No specific rules — fall back to default policy
  return cfg.defaultPolicy === 'allow';
}
