import webPush from 'web-push';

import { notificationPreferencesDb, pushSubscriptionsDb, sessionsDb } from '@/modules/database/index.js';
import { sendDesktopNotification as sendDesktopNotificationToClients } from '@/modules/notifications/services/desktop-notification-clients.service.js';
import { webhookNotificationsService } from '@/modules/notifications/services/webhook-notifications.service.js';


// ---------------------------
//----------------- RUN NOTIFICATION EVENTS ------------
/**
 * Provider lifecycle event delivered by the notifications module. Session IDs
 * may be native on input; the orchestrator resolves them to app IDs before
 * delivery. Metadata is display information, never the run environment.
 */
type RunNotificationEvent = {
  provider: string;
  sessionId: string | null;
  kind: string;
  code: string;
  meta: Record<string, unknown>;
  severity: string;
  requiresUserAction: boolean;
  dedupeKey: string | null;
  createdAt: string;
};

type NotificationPreferences = ReturnType<typeof notificationPreferencesDb.getPreferences>;
type RunNotificationInput = { userId: number | string | null; provider: string; sessionId?: string | null; sessionName?: string | null; stopReason?: string; error?: unknown };

const KIND_TO_PREF_KEY: Record<string, keyof NotificationPreferences['events']> = {
  action_required: 'actionRequired',
  stop: 'stop',
  error: 'error'
};

const PROVIDER_LABELS: Record<string, string> = {
  claude: 'Claude',
  cursor: 'Cursor',
  codex: 'Codex',
  system: 'System'
};

const recentEventKeys = new Map<string, number>();
const DEDUPE_WINDOW_MS = 20000;

const cleanupOldEventKeys = () => {
  const now = Date.now();
  for (const [key, timestamp] of recentEventKeys.entries()) {
    if (now - timestamp > DEDUPE_WINDOW_MS) {
      recentEventKeys.delete(key);
    }
  }
};

function isNotificationEventEnabled(preferences: NotificationPreferences, event: RunNotificationEvent) {
  const prefEventKey = KIND_TO_PREF_KEY[event.kind];
  const eventEnabled = prefEventKey ? Boolean(preferences?.events?.[prefEventKey]) : true;

  return eventEnabled;
}

function isDuplicate(event: RunNotificationEvent) {
  cleanupOldEventKeys();
  const key = event.dedupeKey || `${event.provider}:${event.kind || 'info'}:${event.code || 'generic'}:${event.sessionId || 'none'}`;
  if (recentEventKeys.has(key)) {
    return true;
  }
  recentEventKeys.set(key, Date.now());
  return false;
}

/** Used by provider runtimes and Settings to create a notification event. */
export function createNotificationEvent({
  provider,
  sessionId = null,
  kind = 'info',
  code = 'generic.info',
  meta = {},
  severity = 'info',
  dedupeKey = null,
  requiresUserAction = false
}: Partial<Omit<RunNotificationEvent, 'createdAt'>> & Pick<RunNotificationEvent, 'provider'>): RunNotificationEvent {
  return {
    provider,
    sessionId,
    kind,
    code,
    meta,
    severity,
    requiresUserAction,
    dedupeKey,
    createdAt: new Date().toISOString()
  };
}

function normalizeErrorMessage(error: unknown): string {
  if (typeof error === 'string') {
    return error;
  }

  if (error && typeof error === 'object' && 'message' in error && typeof error.message === 'string') {
    return error.message;
  }

  if (error == null) {
    return 'Unknown error';
  }

  return String(error);
}

function normalizeSessionName(sessionName: unknown): string | null {
  if (typeof sessionName !== 'string') {
    return null;
  }

  const normalized = sessionName.replace(/\s+/g, ' ').trim();
  if (!normalized) {
    return null;
  }

  return normalized.length > 80 ? `${normalized.slice(0, 77)}...` : normalized;
}

function rowMatchesProvider(row: { provider: string } | null | undefined, provider: string) {
  return row && (!provider || row.provider === provider);
}

function resolveSessionRow(sessionId: string | null, provider: string) {
  if (!sessionId) {
    return null;
  }

  const appSessionRow = sessionsDb.getSessionById(sessionId);
  if (rowMatchesProvider(appSessionRow, provider)) {
    return appSessionRow;
  }

  const providerSessionRow = sessionsDb.getSessionByProviderSessionId(sessionId);
  if (rowMatchesProvider(providerSessionRow, provider)) {
    return providerSessionRow;
  }

  return null;
}

function normalizeNotificationSession(event: RunNotificationEvent) {
  if (!event?.sessionId || !event.provider || event.provider === 'system') {
    return event;
  }

  const row = resolveSessionRow(event.sessionId, event.provider);
  if (!row || row.session_id === event.sessionId) {
    return event;
  }

  return {
    ...event,
    sessionId: row.session_id
  };
}

function resolveSessionName(event: RunNotificationEvent) {
  const explicitSessionName = normalizeSessionName(event.meta?.sessionName);
  if (explicitSessionName) {
    return explicitSessionName;
  }

  if (!event.sessionId || !event.provider) {
    return null;
  }

  return normalizeSessionName(sessionsDb.getSessionName(event.sessionId, event.provider));
}

/** Used by delivery channels and notification tests to format a lifecycle event. */
export function buildNotificationPayload(event: Partial<RunNotificationEvent> & Pick<RunNotificationEvent, 'provider'>) {
  const normalizedEvent = normalizeNotificationSession(createNotificationEvent(event));
  const CODE_MAP: Record<string, unknown> = {
    'permission.required': normalizedEvent.meta?.toolName
      ? `Action Required: Tool "${normalizedEvent.meta.toolName}" needs approval`
      : 'Action Required: A tool needs your approval',
    'run.stopped': normalizedEvent.meta?.stopReason || 'Run Stopped: The run has stopped',
    'run.background_completed': 'Background work finished',
    'run.failed': normalizedEvent.meta?.error ? `Run Failed: ${normalizedEvent.meta.error}` : 'Run Failed: The run encountered an error',
    'agent.notification': normalizedEvent.meta?.message ? String(normalizedEvent.meta.message) : 'You have a new notification',
    'push.enabled': 'Push notifications are now enabled!'
  };
  const providerLabel = PROVIDER_LABELS[normalizedEvent.provider] || 'Assistant';
  const sessionName = resolveSessionName(normalizedEvent);
  const message = CODE_MAP[normalizedEvent.code] || 'You have a new notification';

  return {
    title: sessionName || 'CloudCLI',
    body: `${providerLabel}: ${message}`,
    data: {
      sessionId: normalizedEvent.sessionId || null,
      code: normalizedEvent.code,
      provider: normalizedEvent.provider || null,
      sessionName,
      tag: `${normalizedEvent.provider || 'assistant'}:${normalizedEvent.sessionId || 'none'}:${normalizedEvent.code}`
    }
  };
}

function sendWebPushPayload(userId: number, payload: ReturnType<typeof buildNotificationPayload>) {
  const subscriptions = pushSubscriptionsDb.getSubscriptions(userId);
  if (!subscriptions.length) return Promise.resolve();

  const serializedPayload = JSON.stringify(payload);
  return Promise.allSettled(
    subscriptions.map((sub) =>
      webPush.sendNotification(
        {
          endpoint: sub.endpoint,
          keys: {
            p256dh: sub.keys_p256dh,
            auth: sub.keys_auth
          }
        },
        serializedPayload
      )
    )
  ).then((results) => {
    results.forEach((result, index) => {
      if (result.status === 'rejected') {
        const statusCode = result.reason?.statusCode;
        if (statusCode === 410 || statusCode === 404) {
          pushSubscriptionsDb.removeSubscription(subscriptions[index].endpoint);
        }
      }
    });
  });
}

type NotificationChannel = {
  id: string;
  bypassesDedupe?: boolean;
  isEnabled(preferences: NotificationPreferences): boolean;
  send(input: { userId: number; event: RunNotificationEvent; payload: ReturnType<typeof buildNotificationPayload> }): unknown;
};
const notificationChannels: NotificationChannel[] = [
  {
    id: 'webPush',
    // TODO: Web push still uses push_subscriptions. Do not remove that table until
    // browser push subscriptions are migrated into notification_channel_endpoints.
    isEnabled: (preferences) => Boolean(preferences?.channels?.webPush),
    send: ({ userId, payload }) => sendWebPushPayload(userId, payload)
  },
  {
    id: 'desktop',
    isEnabled: (preferences) => Boolean(preferences?.channels?.desktop),
    send: ({ userId, payload }) => sendDesktopNotificationToClients(userId, payload)
  },
  {
    id: 'webhook',
    // Gated by the webhook endpoint row's own `enabled` flag instead of
    // preferences.channels, which the Settings client rewrites with only its
    // known keys. The channel sends run lifecycle events only.
    isEnabled: () => true,
    // The dedupe window keeps a person from being pinged twice, but it also
    // swallows a second run of the same session that ends the same way within
    // 20 s. Each run reports its end once at the source, and receivers dedupe
    // on the event id, so every run is sent.
    bypassesDedupe: true,
    send: ({ userId, event }) => webhookNotificationsService.sendForEvent({ userId, event })
  }
];

/** Used by provider runtimes and Settings to dispatch enabled notification channels. */
export function notifyUserIfEnabled({ userId, event }: { userId: number | string | null; event: unknown }) {
  if (!userId || !event || typeof event !== 'object' || !('provider' in event) || typeof event.provider !== 'string') {
    return;
  }

  const normalizedEvent = normalizeNotificationSession(createNotificationEvent(event as Partial<RunNotificationEvent> & Pick<RunNotificationEvent, 'provider'>));
  const numericUserId = Number(userId);
  if (!Number.isSafeInteger(numericUserId) || numericUserId <= 0) return;
  const preferences = notificationPreferencesDb.getPreferences(numericUserId);
  if (!isNotificationEventEnabled(preferences, normalizedEvent)) {
    return;
  }
  const duplicate = isDuplicate(normalizedEvent);

  const payload = buildNotificationPayload(normalizedEvent);
  for (const channel of notificationChannels) {
    if ((duplicate && !channel.bypassesDedupe) || !channel.isEnabled(preferences)) {
      continue;
    }
    Promise.resolve(channel.send({ userId: numericUserId, event: normalizedEvent, payload })).catch((err) => {
      console.error(`Notification channel "${channel.id}" send error:`, err);
    });
  }
}

/** Used by provider runtimes to announce completion or cancellation. */
export function notifyRunStopped({ userId, provider, sessionId = null, stopReason = 'completed', sessionName = null }: RunNotificationInput) {
  notifyUserIfEnabled({
    userId,
    event: createNotificationEvent({
      provider,
      sessionId,
      kind: 'stop',
      code: 'run.stopped',
      meta: { stopReason, sessionName },
      severity: 'info',
      dedupeKey: `${provider}:run:stop:${sessionId || 'none'}:${stopReason}`
    })
  });
}

/**
 * Reports background work that finished after its turn had already completed.
 *
 * Uses the `stop` kind so it rides the existing "run stopped" preference rather
 * than needing a new opt-in that would default to off. No explicit dedupeKey, so
 * the default composite key collapses repeats inside the dedupe window (on the
 * channels that dedupe; the webhook sends each).
 */
export function notifyBackgroundWorkCompleted({ userId, provider, sessionId = null, sessionName = null }: RunNotificationInput) {
  notifyUserIfEnabled({
    userId,
    event: createNotificationEvent({
      provider,
      sessionId,
      kind: 'stop',
      code: 'run.background_completed',
      meta: { sessionName },
      severity: 'info'
    })
  });
}

/** Used by provider runtimes to announce a failed run. */
export function notifyRunFailed({ userId, provider, sessionId = null, error, sessionName = null }: RunNotificationInput) {
  const errorMessage = normalizeErrorMessage(error);

  notifyUserIfEnabled({
    userId,
    event: createNotificationEvent({
      provider,
      sessionId,
      kind: 'error',
      code: 'run.failed',
      meta: { error: errorMessage, sessionName },
      severity: 'error',
      dedupeKey: `${provider}:run:error:${sessionId || 'none'}:${errorMessage}`
    })
  });
}

