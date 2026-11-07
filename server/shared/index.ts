export { appendFilesInputTag, buildCodexInputItems, normalizeImageDescriptors } from './image-attachments.js';
export { createCompleteMessage, createNormalizedMessage } from './utils.js';
// WebSocket authentication and Agent routes use the existing upgrade/provider contracts.
export type { AuthenticatedWebSocketRequest, ProviderRunFunction } from './types.js';
export type { AnyRecord, ProviderRuntimeContext, ProviderRuntimeWriter, SessionExecutionOwner, ProviderRunReservation } from './types.js';
// Providers' task-progress reader and tests share the normalized conversation contract.
export type { LLMProvider, NormalizedMessage, TaskProgressSnapshot } from './types.js';
// GitHub authentication and Projects routes use the shared error/HTTP contract.
export { AppError, asyncHandler, filterAttachmentsToUploadStore, normalizeProjectPath, validateWorkspacePath } from './utils.js';

// Providers uses the same CLI executable for chats and on-demand quota queries.
export { resolveClaudeCodeExecutablePath } from './claude-cli-path.js';

export type { ProjectGithubCredentialSelection } from './types.js';

// Codex runtime and its input bridge share the native interaction contract.
export type { CodexServerRequestHandler, ProviderPermissionDecision, NativeQueuedMessage } from './types.js';

// GitHub auth and Providers share the non-secret runtime instruction envelope.
export { LEGACY_GITHUB_AUTH_INSTRUCTIONS, prependRuntimeInstructions } from './utils.js';
