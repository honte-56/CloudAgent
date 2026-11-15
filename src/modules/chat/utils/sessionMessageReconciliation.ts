import { stripRuntimeInstructions } from '@/shared/utils';
import type { NormalizedMessage } from '@/shared/types';

/**
 * How long after a live user row its persisted copy may land. Long, because a
 * message typed while the CLI is busy is only written to the transcript when
 * the CLI gets to it, which for a long tool run can be well into the turn.
 * Matching stays one-to-one and closest-in-time, so a repeated short reply
 * inside the window still retires exactly one row per echo.
 */
const LIVE_USER_DEDUPE_WINDOW_MS = 30 * 60 * 1000;
const LIVE_USER_DEDUPE_CLOCK_SKEW_MS = 10_000;
const LIVE_ATTACHMENT_ONLY_DEDUPE_WINDOW_MS = 30_000;

type UserTurnFingerprint = {
  text: string;
  imageCount: number;
  fileCount: number;
};

function userTurnFingerprint(message: NormalizedMessage): UserTurnFingerprint | null {
  if (message.kind !== 'text' || message.role !== 'user') return null;

  const content = message.content || '';
  const text = (message.id.startsWith('local_') || message.runtimeContextStripped ? content : stripRuntimeInstructions(content)).trim();
  const imageCount = Array.isArray(message.images) ? message.images.length : 0;
  const fileCount = Array.isArray(message.files) ? message.files.length : 0;
  if (!text && imageCount === 0 && fileCount === 0) return null;

  return { text, imageCount, fileCount };
}

function userTurnFingerprintsMatch(
  local: UserTurnFingerprint,
  server: UserTurnFingerprint,
): boolean {
  return (
    local.text === server.text
    && local.imageCount === server.imageCount
    && local.fileCount === server.fileCount
  );
}

function readMessageTime(message: NormalizedMessage): number | null {
  const time = Date.parse(message.timestamp);
  return Number.isFinite(time) ? time : null;
}

function findServerEchoForLocalUser(
  localMessage: NormalizedMessage,
  serverMessages: NormalizedMessage[],
  claimedServerIds: Set<string>,
): NormalizedMessage | null {
  const localFingerprint = userTurnFingerprint(localMessage);
  const localTime = readMessageTime(localMessage);
  if (!localFingerprint || localTime === null) {
    return null;
  }

  // The echo of an edited message may only be retired by a row that was not
  // in the transcript when the cut was made. Text and a time window are not
  // enough for it: a rewind that branches re-stamps every surviving turn to
  // the moment of the copy, so an earlier turn with the same words — "yes",
  // "continue", the typo being corrected — lands inside the window and would
  // retire the message the user just sent.
  const firstEligibleIndex = localMessage.replacesAfterRowCount ?? 0;

  const dedupeWindow = localFingerprint.text
    ? LIVE_USER_DEDUPE_WINDOW_MS
    : LIVE_ATTACHMENT_ONLY_DEDUPE_WINDOW_MS;
  let closestMatch: NormalizedMessage | null = null;
  let closestTimeDifference = Number.POSITIVE_INFINITY;

  for (let index = firstEligibleIndex; index < serverMessages.length; index++) {
    const serverMessage = serverMessages[index];
    if (claimedServerIds.has(serverMessage.id)) {
      continue;
    }

    const serverFingerprint = userTurnFingerprint(serverMessage);
    if (!serverFingerprint || !userTurnFingerprintsMatch(localFingerprint, serverFingerprint)) {
      continue;
    }

    const serverTime = readMessageTime(serverMessage);
    if (
      serverTime === null
      || serverTime < localTime - LIVE_USER_DEDUPE_CLOCK_SKEW_MS
      || serverTime - localTime > dedupeWindow
    ) {
      continue;
    }

    const timeDifference = Math.abs(serverTime - localTime);
    if (timeDifference < closestTimeDifference) {
      closestMatch = serverMessage;
      closestTimeDifference = timeDifference;
    }
  }

  return closestMatch;
}

/**
 * Matches live user rows to their persisted copies for the chat session store.
 * Retaining the correspondence lets the store anchor following replies to the
 * persisted prompt before it retires the live echo.
 *
 * Every user row that reaches the store live is an echo of something the
 * transcript will hold under its own row id: the composer's optimistic copy
 * (`local_…`), and the copy a provider sends back when it accepts a message
 * typed mid-run. Neither shares an id with the persisted row, so the match is
 * by text and attachment counts within a time window. Matches are one-to-one
 * so repeated sends cannot claim one row.
 */
export function matchPersistedUserEchoes(
  serverMessages: NormalizedMessage[],
  realtimeMessages: NormalizedMessage[],
): Map<NormalizedMessage, NormalizedMessage> {
  const claimedServerIds = new Set<string>();
  const matches = new Map<NormalizedMessage, NormalizedMessage>();

  for (const message of realtimeMessages) {
    if (message.kind !== 'text' || message.role !== 'user') {
      continue;
    }

    const serverEcho = findServerEchoForLocalUser(message, serverMessages, claimedServerIds);
    if (!serverEcho) {
      continue;
    }

    claimedServerIds.add(serverEcho.id);
    matches.set(message, serverEcho);
  }
  return matches;
}
