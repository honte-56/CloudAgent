import type { query, SDKControlGetUsageResponse } from '@anthropic-ai/claude-agent-sdk';
import { queryClaudeControl } from '@/modules/providers/services/claude-control-query.service.js';

/** Used by Providers' usage reader and tests to query the CLI without sending a prompt. */
export async function queryClaudePlanUsage(options: {
  createQuery?: typeof query;
  timeoutMs?: number;
} = {}): Promise<SDKControlGetUsageResponse> {
  return queryClaudeControl(
    (instance) => instance.usage_EXPERIMENTAL_MAY_CHANGE_DO_NOT_RELY_ON_THIS_API_YET({ skipBehaviors: true }),
    options,
  );
}
