import type { AnyRecord } from '@/shared/types.js';

/** Shared by Codex live notifications and typed transcript items so tool identities and results agree. */
export function transformCodexItem(item: AnyRecord): AnyRecord | null {
  const type = item.type ? item.type[0].toLowerCase() + item.type.slice(1) : '';
  const base = { type: 'item', itemId: item.id, status: item.status === 'inProgress' ? 'in_progress' : item.status };
  switch (type) {
    case 'subAgentActivity': return { ...base, itemType: 'subagent_activity' };
    case 'agentMessage': return { ...base, itemType: 'agent_message', message: { content: item.text } };
    case 'reasoning': return { ...base, itemType: 'reasoning', message: { content: [...(item.summary || []), ...(item.content || [])].join('\n') } };
    case 'commandExecution': return { ...base, itemType: 'command_execution', command: Array.isArray(item.command) ? item.command.map((part: string) => `'${part.replace(/'/g, `'\"'\"'`)}'`).join(' ') : item.command, output: item.aggregatedOutput ?? item.aggregated_output ?? item.formatted_output ?? '', exitCode: item.exitCode ?? item.exit_code };
    case 'fileChange': {
      const changes = Array.isArray(item.changes) ? item.changes : Object.entries(item.changes || {}).map(([path, value]) => ({ ...(value as AnyRecord), path }));
      return { ...base, itemType: 'file_change', output: item.stderr || item.stdout || '', changes: changes.map((change: AnyRecord) => ({ ...change, kind: change.kind?.type || change.kind || change.type, diff: change.diff ?? change.unified_diff })) };
    }
    case 'mcpToolCall': return { ...base, itemType: 'mcp_tool_call', server: item.server, tool: item.tool, arguments: item.arguments, result: item.result, error: item.error };
    case 'webSearch': return { ...base, itemType: 'web_search', query: item.action?.query || '' };
    // User echoes already exist in the composer; hooks are not user messages.
    case 'userMessage': case 'hookPrompt': return null;
    default: return { ...base, itemType: item.type, item };
  }
}

