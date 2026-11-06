import { promises as fs } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { sessionsDb } from '@/modules/database/index.js';
import { sessionsService } from '@/modules/providers/services/sessions.service.js';
import { providerRegistry } from '@/modules/providers/provider.registry.js';
import { AppError } from '@/shared/index.js';
import type { AnyRecord, LLMProvider, TaskProgressSnapshot } from '@/shared/index.js';

type Dependencies = {
  getSession: typeof sessionsDb.getSessionById;
  getNativeSession: typeof sessionsDb.getSessionByProviderSessionId;
  history: typeof sessionsService.fetchHistory;
  provider: typeof providerRegistry.resolveProvider;
};
const defaults: Dependencies = {
  getSession: id => sessionsDb.getSessionById(id),
  getNativeSession: id => sessionsDb.getSessionByProviderSessionId(id),
  history: (id, options) => sessionsService.fetchHistory(id, options),
  provider: id => providerRegistry.resolveProvider(id),
};
function object(value: unknown): AnyRecord {
  if (typeof value === 'string') { try { return object(JSON.parse(value)); } catch { return {}; } }
  return value && typeof value === 'object' && !Array.isArray(value) ? value as AnyRecord : {};
}
function text(value: unknown): string {
  if (typeof value === 'string') return value;
  if (Array.isArray(value)) return value.map(part => object(part).text ?? '').join('\n');
  return '';
}
const inside = (root: string, file: string) => file === root || file.startsWith(root + path.sep);

// Parse literal stdout/stderr destinations only. Nothing is executed or
// expanded. Only destinations recorded in this task's persisted command are
// eligible for the explicit-output exception in readOutput.
function redirectedFiles(command: string, cwd: string): string[] {
  const token = `(?:"([^"\\n]+)"|'([^'\\n]+)'|([^\\s;&|<>]+))`;
  const cd = new RegExp(`(?:^|&&|;)\\s*cd\\s+${token}`).exec(command);
  const directory = cd ? path.resolve(cwd, cd[1] ?? cd[2] ?? cd[3]) : cwd;
  const results: string[] = [];
  const redirects = new RegExp(`(?:^|\\s)(?:[12])?>>?\\s*${token}`, 'g');
  for (const match of command.matchAll(redirects)) {
    const file = match[1] ?? match[2] ?? match[3];
    if (!file || /[$`*?]/.test(file) || !/\.(?:log|out|output|jsonl|txt)$/i.test(file)) continue;
    results.push(path.resolve(directory, file));
  }
  return results;
}
async function readOutput(file: string, roots: string[], explicitDestination = false) {
  const real = await fs.realpath(file);
  const allowed = await Promise.all(roots.map(root => fs.realpath(root).catch(() => root)));
  if (!allowed.some(root => inside(root, real))) {
    // CLI launches often redirect to /tmp or a sibling worktree. The exact
    // persisted destination is evidence of ownership; it does not grant access
    // to neighboring files or to a file symlink pointing outside allowed roots.
    if (!explicitDestination) return null;
    const directory = await fs.realpath(path.dirname(file));
    if (real !== path.join(directory, path.basename(file))) return null;
  }
  const handle = await fs.open(real, 'r');
  try {
    const stat = await handle.stat();
    if (!stat.isFile()) return null;
    const headSize = Math.min(stat.size, 32 * 1024), tailSize = Math.min(stat.size, 128 * 1024);
    const head = Buffer.alloc(headSize), tail = Buffer.alloc(tailSize);
    await handle.read(head, 0, headSize, 0);
    await handle.read(tail, 0, tailSize, Math.max(0, stat.size - tailSize));
    return { head: head.toString('utf8'), tail: tail.toString('utf8'), truncated: stat.size > tailSize };
  } finally { await handle.close(); }
}
function codexThreadIds(output: string): string[] {
  const ids = new Set<string>();
  const cleaned = output.replace(/\x1b\[[0-9;]*[A-Za-z]/g, '');
  const uuid = /^[a-f\d]{8}-[a-f\d]{4}-[a-f\d]{4}-[a-f\d]{4}-[a-f\d]{12}$/i;
  for (const line of cleaned.split('\n')) {
    const header = /^\s*session id:\s*([a-f\d-]{36})\s*$/i.exec(line);
    if (header && uuid.test(header[1])) ids.add(header[1]);
    try { const event = JSON.parse(line); if (event.type === 'thread.started' && uuid.test(event.thread_id)) ids.add(event.thread_id); } catch { /* Text-mode CLI output. */ }
  }
  return [...ids];
}

/** Provider routes and isolated tests use this reader; it never starts, resumes, or takes over an agent. */
export function createTaskProgressService(deps: Dependencies = defaults) {
  return {
    async read(parentSessionId: string, requestedToolId: string, options: { agentId?: string; limit?: number } = {}): Promise<TaskProgressSnapshot> {
      const parent = deps.getSession(parentSessionId);
      if (!parent) throw new AppError('Parent session not found.', { code: 'SESSION_NOT_FOUND', statusCode: 404 });
      const limit = Math.max(20, Math.min(500, options.limit ?? 100));
      const provider = deps.provider(parent.provider);
      const history = await deps.history(parentSessionId, { limit: null });
      const launch = history.messages.find(row => row.kind === 'tool_use' && (row.toolId === requestedToolId
        || object(object(row.toolResult).toolUseResult).backgroundTaskId === requestedToolId));
      if (!launch?.toolId) throw new AppError('任务记录尚未写入，正在等待同步。', { code: 'TASK_NOT_FOUND', statusCode: 404 });
      const input = object(launch.toolInput), result = object(launch.toolResult), extra = object(result.toolUseResult);
      const active = provider.runtime.listBackgroundWork?.().find(entry => entry.sessionId === parentSessionId || entry.sessionId === parent.provider_session_id)?.tasks.find(task => task.toolUseId === launch.toolId);
      const snapshot: TaskProgressSnapshot = {
        parentSessionId, toolUseId: launch.toolId, provider: parent.provider as LLMProvider,
        title: String(input.description ?? launch.subagent?.description ?? active?.description ?? launch.toolName ?? 'Task'),
        kind: 'command', status: active ? 'running' : launch.workflow?.status ?? launch.subagent?.status ?? 'unknown', updatedAt: new Date().toISOString(),
      };
      if (launch.workflow?.runId) {
        snapshot.kind = 'workflow';
        const agents = await provider.sessions.readWorkflowAgents?.(parentSessionId, launch.workflow.runId) ?? launch.workflow.agents;
        snapshot.agents = agents;
        const selected = options.agentId ? agents.find(agent => agent.id === options.agentId) : agents.find(agent => agent.status === 'running') ?? agents.at(-1);
        if (options.agentId && !selected) throw new AppError('Agent does not belong to this workflow.', { code: 'AGENT_NOT_FOUND', statusCode: 404 });
        if (selected) {
          snapshot.selectedAgentId = selected.id;
          const detail = await provider.sessions.readWorkflowAgentActivity?.(parentSessionId, launch.workflow.runId, selected.id, limit);
          if (detail) { snapshot.activity = detail.activity; snapshot.activityCount = detail.activityCount; }
        }
        if (!snapshot.activity?.length) snapshot.notice = '正在等待子智能体写入进展。';
        return snapshot;
      }
      if (launch.subagent?.id) {
        snapshot.kind = 'agent';
        const detail = await provider.sessions.readSubagentActivity?.(parentSessionId, launch.subagent.id, limit);
        if (detail?.agent.status && detail.agent.status !== 'running') snapshot.status = detail.agent.status;
        snapshot.activity = detail?.activity ?? launch.subagentTools ?? [];
        snapshot.activityCount = detail?.activityCount ?? launch.subagent.activityCount;
        if (!snapshot.activity.length) snapshot.notice = '正在等待子智能体写入进展。';
        return snapshot;
      }
      if (launch.toolName !== 'Bash') {
        snapshot.notice = '这个任务尚未提供独立的进展记录。';
        return snapshot;
      }
      const project = parent.project_path || '';
      const taskRoot = path.join(os.tmpdir(), `claude-${process.getuid?.() ?? 0}`);
      // A task's SDK output must include the exact parent-native directory;
      // an arbitrary /tmp filename supplied by the browser is never accepted.
      const nativeId = parent.provider_session_id ?? '';
      const content = text(result.content);
      const sdkOutput = /(?:Output is being written to:|output file:)\s*([^\n]+?\.output)\b/i.exec(content)?.[1];
      const files = project ? redirectedFiles(String(input.command ?? ''), project) : [];
      const explicitOutputs = new Set(files);
      if (sdkOutput && nativeId && sdkOutput.includes(`/${nativeId}/tasks/`) && inside(taskRoot, path.resolve(sdkOutput))) files.push(sdkOutput);
      const roots = [...(project ? [path.resolve(project)] : []), ...(sdkOutput && files.includes(sdkOutput) ? [path.dirname(sdkOutput)] : [])];
      let fallback = [text(extra.stdout), text(extra.stderr), content].filter(Boolean).join('\n');
      for (const file of [...new Set(files)]) {
        let output;
        try { output = await readOutput(file, roots, explicitOutputs.has(file)); } catch { continue; }
        if (!output) continue;
        if (output.tail.trim()) { fallback = output.tail; snapshot.outputTruncated = output.truncated; }
        const ids = codexThreadIds(output.head + '\n' + output.tail);
        if (ids.length !== 1) continue;
        const child = deps.getNativeSession(ids[0]);
        if (!child || child.provider !== 'codex' || child.session_id === parentSessionId) continue;
        const childHistory = await deps.history(child.session_id, { limit });
        snapshot.kind = 'conversation'; snapshot.provider = 'codex'; snapshot.childSessionId = child.session_id;
        snapshot.messages = childHistory.messages; snapshot.totalMessages = childHistory.total;
        snapshot.notice = '正在查看后台 Codex 会话，不会启动新的执行实例。';
        return snapshot;
      }
      snapshot.output = fallback.slice(-128 * 1024).replace(/\x1b\[[0-9;]*[A-Za-z]/g, '');
      snapshot.notice = '未发现可关联的独立会话，显示该任务的命令输出。';
      return snapshot;
    },
  };
}

/** Authenticated task-progress route's shared reader. */
export const taskProgressService = createTaskProgressService();
