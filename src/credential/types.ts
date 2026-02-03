export interface CredentialAccessEvent {
  skill: string;
  credentialType: string;
  outcome: 'accessed' | 'denied';
  reason?: string;
  timestamp?: string;
}

export interface CredentialScopeConfig {
  /** Default policy when no specific rule matches */
  defaultPolicy: 'allow' | 'deny';
  /** Per-skill rules: skill name → allowed credential types */
  rules: Record<string, string[]>;
}

export const DEFAULT_SCOPE_CONFIG: CredentialScopeConfig = {
  defaultPolicy: 'allow',
  rules: {},
};
