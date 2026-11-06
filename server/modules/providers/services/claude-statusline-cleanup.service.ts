import { readFile, rename, unlink, writeFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';

/** Used by server startup to retire CloudCLI's previous statusline capture hook. */
export async function removeClaudeStatuslineCapture(configDirectory = process.env.CLAUDE_CONFIG_DIR ?? path.join(os.homedir(), '.claude')): Promise<void> {
  const settingsPath = path.join(configDirectory, 'settings.json');
  let original: string;
  try { original = await readFile(settingsPath, 'utf8'); }
  catch (error) { if ((error as NodeJS.ErrnoException).code === 'ENOENT') return; throw error; }
  const settings = JSON.parse(original);
  const command = settings?.statusLine?.command;
  if (typeof command !== 'string' || !command.includes('--cloudcli-statusline')) return;
  // The old installer stored the previous command as the final quoted base64 argument.
  const encoded = command.match(/['"]([A-Za-z0-9+/=]*)['"]\s*$/)?.[1];
  if (encoded === undefined) throw new Error('Cannot restore the previous Claude statusline command');
  if (encoded) settings.statusLine.command = Buffer.from(encoded, 'base64').toString('utf8');
  else delete settings.statusLine;
  if (await readFile(settingsPath, 'utf8') !== original) throw new Error('Claude settings changed during cleanup');
  const temporary = `${settingsPath}.${process.pid}.cleanup-tmp`;
  try {
    await writeFile(temporary, JSON.stringify(settings, null, 2) + '\n', { mode: 0o600 });
    await rename(temporary, settingsPath);
  } finally { await unlink(temporary).catch(() => {}); }
}
