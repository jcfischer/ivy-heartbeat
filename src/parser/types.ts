import { z } from 'zod';

export const CheckTypeSchema = z.enum(['calendar', 'email', 'github_issues', 'agent_dispatch', 'custom']);
export const SeveritySchema = z.enum(['low', 'medium', 'high', 'critical']);
export const ChannelSchema = z.enum(['voice', 'terminal', 'email']);

export const ChecklistItemSchema = z.object({
  name: z.string().min(1),
  type: CheckTypeSchema,
  severity: SeveritySchema.default('medium'),
  channels: z.array(ChannelSchema).default(['terminal']),
  enabled: z.boolean().default(true),
  description: z.string().min(1),
  config: z.record(z.string(), z.unknown()).default({}),
});

export type CheckType = z.infer<typeof CheckTypeSchema>;
export type Severity = z.infer<typeof SeveritySchema>;
export type Channel = z.infer<typeof ChannelSchema>;
export type ChecklistItem = z.infer<typeof ChecklistItemSchema>;
