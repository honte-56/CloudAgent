#!/usr/bin/env node
// Packages the systemd server for the runner's Node ABI. Desktop bundles use
// Electron's ABI instead and cannot be installed into this Node.js service.
import { createHash } from 'node:crypto';
import { createReadStream } from 'node:fs';
import fs from 'node:fs/promises';
import path from 'node:path';
import { spawn } from 'node:child_process';
import { fileURLToPath } from 'node:url';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../..');
const manifest = JSON.parse(await fs.readFile(path.join(root, 'package.json'), 'utf8'));
const commit = process.env.GITHUB_SHA;
if (!/^[a-f0-9]{40}$/.test(commit ?? '')) throw new Error('GITHUB_SHA must identify the source commit.');
if (process.platform !== 'linux' || process.arch !== 'x64' || process.versions.node.split('.')[0] !== '24') {
  throw new Error('Build this server bundle on Linux x64 with Node.js 24.');
}

const output = path.join(root, 'release/node-server');
const stage = path.join(output, 'stage');
const filename = `cloudcli-server-${manifest.version}-linux-x64.tar.gz`;
await fs.rm(stage, { recursive: true, force: true });
await fs.mkdir(stage, { recursive: true });

function run(command, args, cwd = stage) {
  return new Promise((resolve, reject) => {
    const child = spawn(command, args, { cwd, stdio: 'inherit', env: { ...process.env, HUSKY: '0' } });
    child.once('error', reject);
    child.once('exit', code => code === 0 ? resolve() : reject(new Error(`${command} exited with code ${code}`)));
  });
}

// An explicit input list excludes development configuration, credentials,
// databases and logs. Runtime data remains on the server outside the package.
for (const entry of ['dist', 'dist-server', 'public', 'shared', 'scripts/fix-node-pty.js', 'scripts/promote-dist-server.mjs', 'package-lock.json']) {
  await fs.cp(path.join(root, entry), path.join(stage, entry), { recursive: true });
}
const scripts = { ...manifest.scripts };
delete scripts.prepare;
delete scripts.prepublishOnly;
await fs.writeFile(path.join(stage, 'package.json'), `${JSON.stringify({ ...manifest, scripts }, null, 2)}\n`);

// Dependency install scripts build or download native modules for Node.js,
// including SQLite, the PTY and ripgrep; no compilation runs on the server.
await run('npm', ['ci', '--omit=dev', '--no-audit', '--no-fund']);
await run('npm', ['run', 'preserver']);
await run(process.execPath, ['--input-type=module', '-e', `
  import Database from 'better-sqlite3';
  import pty from 'node-pty';
  import { rgPath } from '@vscode/ripgrep';
  import { execFileSync } from 'node:child_process';
  await import('@opencode-ai/sdk/v2');
  await import('@anthropic-ai/claude-agent-sdk');
  await import('ajv-formats');
  const database = new Database(':memory:');
  database.prepare('select 1').get();
  database.close();
  await new Promise((resolve, reject) => {
    const child = pty.spawn('/usr/bin/true', [], {
      name: 'xterm', cols: 80, rows: 24, cwd: '/tmp', env: { PATH: '/usr/bin:/bin' },
    });
    child.onExit(({ exitCode }) => exitCode === 0 ? resolve() : reject(new Error('PTY preflight failed')));
  });
  execFileSync(rgPath, ['--version'], { stdio: 'inherit' });
  console.log('Server runtime preflight passed');
`]);

await fs.writeFile(path.join(stage, '.deployment.json'), `${JSON.stringify({
  commit,
  version: manifest.version,
  nodeVersion: process.versions.node,
  platform: process.platform,
  arch: process.arch,
  frontendAuthMode: process.env.VITE_IS_PLATFORM === 'true' ? 'platform' : 'jwt',
  workflowRunId: process.env.GITHUB_RUN_ID,
  builtAt: new Date().toISOString(),
}, null, 2)}\n`);
await run('tar', ['-czf', path.join(output, filename), '-C', stage, '.'], root);
const hash = createHash('sha256');
for await (const chunk of createReadStream(path.join(output, filename))) hash.update(chunk);
await fs.writeFile(path.join(output, `${filename}.sha256`), `${hash.digest('hex')}  ${filename}\n`);
await fs.rm(stage, { recursive: true, force: true });
console.log(`Created ${filename} for ${commit}`);
