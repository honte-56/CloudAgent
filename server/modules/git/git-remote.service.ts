import type { resolveProjectGithubAuthentication } from '@/modules/github-auth/index.js';
import type { GitProcessRunner } from '@/shared/index.js';
import { AppError, getGitErrorDetails } from '@/shared/index.js';

type RemoteOperationInput = {
  action: 'fetch' | 'pull' | 'push' | 'publish';
  userId: number;
  projectId: string;
  branch?: string;
};

type RemoteOperationDependencies = {
  resolveProjectPath(projectId: string): Promise<string>;
  validateRepository(projectPath: string): Promise<void>;
  getCurrentBranch(projectPath: string): Promise<string>;
  validateBranch(branch: string): unknown;
  validateRemote(remote: string): unknown;
  runCommand: GitProcessRunner;
  resolveAuthentication: typeof resolveProjectGithubAuthentication;
};

function sanitizeDiagnostic(message: string, environment?: NodeJS.ProcessEnv): string {
  let safe = message;
  for (const token of [environment?.GH_TOKEN, environment?.GITHUB_TOKEN, environment?.CLOUDCLI_GITHUB_TOKEN]) {
    if (token) {
      safe = safe.split(token).join('[REDACTED]').split(encodeURIComponent(token)).join('[REDACTED]');
    }
  }
  return safe
    .replace(/(https?:\/\/)[^\s/@]+@/gi, '$1[REDACTED]@')
    .replace(/\b(?:gh[pousr]_[A-Za-z0-9_]+|github_pat_[A-Za-z0-9_]+)\b/g, '[REDACTED]');
}

/** Used by Git's HTTP routes for all remote operations with the authenticated user's project binding. */
export async function runProjectRemoteOperation(input: RemoteOperationInput, dependencies: RemoteOperationDependencies) {
  if (!Number.isSafeInteger(input.userId) || input.userId <= 0) {
    throw new AppError('Authentication required', { code: 'UNAUTHORIZED', statusCode: 401 });
  }

  let environment: NodeJS.ProcessEnv | undefined;
  try {
    const projectPath = await dependencies.resolveProjectPath(input.projectId);
    // Resolve afresh on every operation. An unavailable bound credential throws;
    // it must never fall through to the service's default GitHub account.
    const authentication = await dependencies.resolveAuthentication(input.userId, projectPath);
    environment = authentication?.environment ?? { ...process.env, GIT_TERMINAL_PROMPT: '0' };
    await dependencies.validateRepository(projectPath);
    const branch = await dependencies.getCurrentBranch(projectPath);
    dependencies.validateBranch(branch);
    const run = (args: string[]) => dependencies.runCommand('git', args, { cwd: projectPath, env: environment });
    let remoteName = 'origin';
    let remoteBranch = branch;

    if (input.action === 'publish') {
      if (input.branch !== branch) {
        throw new AppError(`Branch mismatch. Current branch is ${branch}, but trying to publish ${input.branch}`, {
          code: 'GIT_BRANCH_MISMATCH', statusCode: 400,
        });
      }
      const { stdout } = await run(['remote']);
      const remotes = stdout.trim().split('\n').filter(Boolean);
      if (!remotes.length) {
        throw new AppError('No remote repository configured.', { code: 'GIT_REMOTE_MISSING', statusCode: 400 });
      }
      remoteName = remotes.includes('origin') ? 'origin' : remotes[0];
    } else {
      try {
        const { stdout } = await run(['rev-parse', '--abbrev-ref', `${branch}@{upstream}`]);
        const tracking = stdout.trim();
        remoteName = tracking.split('/')[0];
        remoteBranch = tracking.split('/').slice(1).join('/');
      } catch (error) {
        // Only a missing upstream permits the existing origin/branch fallback.
        if (!/no upstream|upstream branch.*not stored|unknown revision|ambiguous argument/i.test(getGitErrorDetails(error))) throw error;
      }
    }

    dependencies.validateRemote(remoteName);
    dependencies.validateBranch(remoteBranch);
    // A configured upstream can have a different branch name. Push the current
    // branch to that destination, rather than accidentally pushing a local namesake.
    const args = input.action === 'fetch' ? ['fetch', remoteName]
      : input.action === 'pull' ? ['pull', remoteName, remoteBranch]
        : input.action === 'publish' ? ['push', '--set-upstream', remoteName, branch]
          : ['push', remoteName, `HEAD:refs/heads/${remoteBranch}`];
    const { stdout, stderr } = await run(args);
    return {
      success: true,
      output: sanitizeDiagnostic(stdout || stderr || `${input.action} completed successfully`, environment),
      remoteName,
      ...(input.action === 'publish' ? { branch } : { remoteBranch }),
    };
  } catch (error) {
    if (error instanceof AppError) throw error;
    const details = sanitizeDiagnostic(getGitErrorDetails(error), environment);
    let message = `${input.action[0].toUpperCase()}${input.action.slice(1)} failed`;
    let code = 'GIT_REMOTE_FAILED';
    if (/authentication failed|permission.*denied|\b403\b|could not read username|publickey/i.test(details)) {
      message = 'GitHub authentication or repository permission denied. Check the project’s bound credential.';
      code = 'GIT_REMOTE_AUTH_FAILED';
    } else if (/non-fast-forward|\[rejected\]/i.test(details)) {
      message = 'Push rejected. Fetch and review the remote changes before pushing.';
      code = 'GIT_PUSH_REJECTED';
    } else if (/could not resolve (host|hostname)|failed to connect|connection timed out/i.test(details)) {
      message = 'Unable to connect to the remote repository.';
      code = 'GIT_REMOTE_NETWORK_FAILED';
    }
    // Throw only the sanitized diagnostic, without retaining the raw subprocess
    // error/environment in a cause that a logger could accidentally serialize.
    throw new AppError(message, { code, statusCode: 500, details });
  }
}
