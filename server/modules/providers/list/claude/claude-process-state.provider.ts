import { spawn } from 'node:child_process';
import type { ChildProcessWithoutNullStreams } from 'node:child_process';
import { StringDecoder } from 'node:string_decoder';
import type { SpawnOptions } from '@anthropic-ai/claude-agent-sdk';

/** Used by Claude's runtime to observe the CLI's authoritative idle signal, which the SDK hides from its public iterator. */
export function createClaudeProcessStateObserver(
  onState: (state: 'idle' | 'running' | 'requires_action') => void,
  onSpawn?: (child: ChildProcessWithoutNullStreams) => void,
) {
  return (options: SpawnOptions) => {
    const child = spawn(options.command, options.args, {
      cwd: options.cwd, env: options.env, signal: options.signal,
      stdio: ['pipe', 'pipe', 'pipe'], windowsHide: true,
    });
    onSpawn?.(child);
    // The SDK's custom-spawn contract only reads stdout; drain stderr so a
    // warning cannot fill the pipe and block the CLI.
    child.stderr.resume();
    const decoder = new StringDecoder('utf8');
    let line = '';
    let oversized = false;
    // Observe without consuming/replacing stdout. Limit buffering: tool results can
    // be huge, while session_state_changed is a small standalone JSON frame.
    child.stdout.on('data', (chunk: Buffer) => {
      const parts = decoder.write(chunk).split('\n');
      for (let index = 0; index < parts.length; index++) {
        if (!oversized) {
          line += parts[index];
          if (line.length > 16_384) { oversized = true; line = ''; }
        }
        if (index === parts.length - 1) continue;
        if (!oversized && line.includes('session_state_changed')) {
          try {
            const event = JSON.parse(line);
            if (event.type === 'system' && event.subtype === 'session_state_changed'
              && ['idle', 'running', 'requires_action'].includes(event.state)) onState(event.state);
          } catch { /* The SDK reports malformed protocol frames itself. */ }
        }
        line = '';
        oversized = false;
      }
    });
    return child;
  };
}
