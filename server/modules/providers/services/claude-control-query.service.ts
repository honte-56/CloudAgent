import { mkdtemp, rm } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { query } from '@anthropic-ai/claude-agent-sdk';
import type { Query, SDKUserMessage } from '@anthropic-ai/claude-agent-sdk';
import { AppError, resolveClaudeCodeExecutablePath } from '@/shared/index.js';

/** Used by Providers' model and usage readers for ephemeral CLI control requests without a user turn. */
export async function queryClaudeControl<T>(run: (instance: Query) => Promise<T>, options: {
  createQuery?: typeof query;
  timeoutMs?: number;
} = {}): Promise<T> {
  const cwd = await mkdtemp(path.join(os.tmpdir(), 'cloudcli-control-'));
  let releaseInput!: () => void;
  const heldInput = new Promise<void>(resolve => { releaseInput = resolve; });
  // Keep stdin open for control requests. This generator never emits a user message.
  // eslint-disable-next-line require-yield -- A yielded message would start model generation.
  async function* prompt(): AsyncGenerator<SDKUserMessage> { await heldInput; }
  let instance: Query | undefined;
  let timer: ReturnType<typeof setTimeout> | undefined;
  try {
    instance = (options.createQuery ?? query)({
      prompt: prompt(),
      options: {
        cwd,
        env: { ...process.env },
        pathToClaudeCodeExecutable: resolveClaudeCodeExecutablePath(),
        settingSources: ['user'],
        settings: { disableAllHooks: true },
        tools: [],
        mcpServers: {},
        strictMcpConfig: true,
        persistSession: false,
        stderr: () => {},
      },
    });
    return await Promise.race([
      run(instance),
      new Promise<never>((_resolve, reject) => {
        timer = setTimeout(() => reject(new AppError('Claude control query timed out.', {
          code: 'CLAUDE_CONTROL_TIMEOUT', statusCode: 504,
        })), options.timeoutMs ?? 20_000);
      }),
    ]);
  } finally {
    clearTimeout(timer);
    releaseInput();
    try { instance?.close(); }
    finally { await rm(cwd, { recursive: true, force: true }); }
  }
}
