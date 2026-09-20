import { DEFAULT_SETTINGS, LIMITS, STORAGE_KEYS } from './constants';
import { DEFAULT_API_BASE_URL, normalizeApiBaseUrl } from './api-url';
import type { AppSettings, KeyRecord, Task, TaskEvent, TaskStatus, NotificationStatus } from './types';
import { clampSetting, truncateUtf8 } from './utils';
import { notificationConfigured, validateNotificationSettings, validateTaskConfig } from './task-config';

const TASK_STATUSES = new Set<TaskStatus>([
  'running', 'requesting', 'waiting', 'keepalive', 'paused', 'accepted-streaming',
  'accepted-completed', 'accepted-stream-interrupted', 'exhausted', 'cancelled',
]);
const NOTIFICATION_STATUSES = new Set<NotificationStatus>([
  'not-requested', 'queued', 'retrying', 'sent', 'dead',
]);

function safeParse<T>(raw: string | null, fallback: T): T {
  if (!raw) return fallback;
  try {
    return JSON.parse(raw) as T;
  } catch {
    return fallback;
  }
}

export function loadKeys(storage: Storage = localStorage): KeyRecord[] {
  const parsed = safeParse<unknown>(storage.getItem(STORAGE_KEYS.keys), []);
  if (!Array.isArray(parsed)) return [];

  return parsed.flatMap((candidate): KeyRecord[] => {
    if (!candidate || typeof candidate !== 'object') return [];
    const value = candidate as Partial<KeyRecord>;
    if (
      typeof value.id !== 'string' ||
      typeof value.alias !== 'string' ||
      typeof value.value !== 'string'
    ) {
      return [];
    }
    const record: KeyRecord = {
      id: value.id,
      alias: value.alias,
      value: value.value,
      baseUrl: normalizeStoredBaseUrl(value.baseUrl),
      authStatus:
        value.authStatus === 'ready' || value.authStatus === 'error'
          ? value.authStatus
          : 'checking',
      models: Array.isArray(value.models)
        ? value.models.filter((model): model is string => typeof model === 'string')
        : [],
    };
    if (typeof value.lastAuthenticatedAt === 'number') {
      record.lastAuthenticatedAt = value.lastAuthenticatedAt;
    }
    if (typeof value.error === 'string') record.error = value.error;
    return [record];
  });
}

export function saveKeys(keys: KeyRecord[], storage: Storage = localStorage): void {
  storage.setItem(STORAGE_KEYS.keys, JSON.stringify(keys));
}

export function loadTasks(storage: Storage = localStorage): Task[] {
  const parsed = safeParse<unknown>(storage.getItem(STORAGE_KEYS.tasks), []);
  if (!Array.isArray(parsed)) return [];
  return parsed.flatMap((candidate): Task[] => {
    if (!candidate || typeof candidate !== 'object') return [];
    const value = candidate as Partial<Task>;
    let config = value.config;
    if (
      typeof value.id !== 'string' || !value.id ||
      value.scheduler !== 'browser' || typeof value.sessionId !== 'string' || !value.sessionId ||
      typeof value.healthy !== 'boolean' ||
      ![value.attemptsMade, value.probeAttempts, value.successes].every(count =>
        typeof count === 'number' && Number.isInteger(count) && count >= 0) ||
      !config || typeof config !== 'object' ||
      !TASK_STATUSES.has(value.status as TaskStatus) ||
      !NOTIFICATION_STATUSES.has(value.notificationStatus as NotificationStatus) ||
      typeof value.startedAt !== 'number' || !Number.isFinite(value.startedAt) ||
      typeof value.updatedAt !== 'number' || !Number.isFinite(value.updatedAt)
    ) return [];
    try { config = validateTaskConfig(config); }
    catch { return []; }
    const events = Array.isArray(value.events)
      ? value.events.filter(validTaskEvent).slice(-200).map((event) => ({ ...event }))
      : [];
    return [{
      ...value,
      id: value.id,
      notificationConfigured: notificationConfigured(config),
      config,
      status: value.status as TaskStatus,
      startedAt: value.startedAt,
      updatedAt: value.updatedAt,
      responseSummary: truncateUtf8(
        typeof value.responseSummary === 'string' ? value.responseSummary : '',
        8 * 1024,
      ),
      events,
      notificationStatus: value.notificationStatus as NotificationStatus,
      notificationAttempts: typeof value.notificationAttempts === 'number'
        ? Math.max(0, Math.trunc(value.notificationAttempts))
        : 0,
    } as Task];
  });
}

export function saveTasks(tasks: Task[], storage: Storage = localStorage): void {
  storage.setItem(STORAGE_KEYS.tasks, JSON.stringify(tasks));
}

function validTaskEvent(value: unknown): value is TaskEvent {
  if (!value || typeof value !== 'object') return false;
  const event = value as Partial<TaskEvent>;
  return typeof event.id === 'string' && typeof event.at === 'number' &&
    typeof event.type === 'string' && typeof event.title === 'string' &&
    typeof event.detail === 'string' &&
    ['neutral', 'info', 'success', 'warning', 'danger'].includes(String(event.tone));
}

export function loadSettings(storage: Storage = localStorage): AppSettings {
  const parsed = safeParse<Partial<AppSettings>>(storage.getItem(STORAGE_KEYS.settings), {});
  return {
    keepalive: parsed.keepalive ?? DEFAULT_SETTINGS.keepalive,
    keepaliveMinSeconds: clampSetting('keepaliveMinSeconds', parsed.keepaliveMinSeconds ?? DEFAULT_SETTINGS.keepaliveMinSeconds),
    keepaliveMaxSeconds: clampSetting('keepaliveMaxSeconds', parsed.keepaliveMaxSeconds ?? DEFAULT_SETTINGS.keepaliveMaxSeconds),
    attempts: clampSetting(
      'attempts',
      typeof parsed.attempts === 'number' ? parsed.attempts : DEFAULT_SETTINGS.attempts,
    ),
    intervalSeconds: clampSetting(
      'intervalSeconds',
      typeof parsed.intervalSeconds === 'number'
        ? parsed.intervalSeconds
        : DEFAULT_SETTINGS.intervalSeconds,
    ),
    timeoutSeconds: clampSetting(
      'timeoutSeconds',
      typeof parsed.timeoutSeconds === 'number'
        ? parsed.timeoutSeconds
        : DEFAULT_SETTINGS.timeoutSeconds,
    ),
    concurrency: clampSetting(
      'concurrency',
      typeof parsed.concurrency === 'number' ? parsed.concurrency : DEFAULT_SETTINGS.concurrency,
    ),
    telegramChatId:
      typeof parsed.telegramChatId === 'string' ? parsed.telegramChatId.slice(0, 128) : '',
    showdocPushUrl: typeof parsed.showdocPushUrl === 'string' ? parsed.showdocPushUrl.slice(0, 1024) : '',
    telegramBotToken:
      typeof parsed.telegramBotToken === 'string' ? parsed.telegramBotToken.slice(0, 256) : '',
    serverchanSendKey: typeof parsed.serverchanSendKey === 'string' ? parsed.serverchanSendKey.slice(0, 256) : '',
    serverchanTags: typeof parsed.serverchanTags === 'string' ? parsed.serverchanTags.slice(0, 128) : '',
  };
}

export function saveSettings(settings: AppSettings, storage: Storage = localStorage): void {
  const normalized: AppSettings = {
    keepalive: settings.keepalive,
    keepaliveMinSeconds: clampSetting('keepaliveMinSeconds', settings.keepaliveMinSeconds),
    keepaliveMaxSeconds: clampSetting('keepaliveMaxSeconds', settings.keepaliveMaxSeconds),
    attempts: clampSetting('attempts', settings.attempts),
    intervalSeconds: Math.min(
      LIMITS.intervalSeconds.max,
      Math.max(LIMITS.intervalSeconds.min, settings.intervalSeconds),
    ),
    timeoutSeconds: Math.min(
      LIMITS.timeoutSeconds.max,
      Math.max(LIMITS.timeoutSeconds.min, settings.timeoutSeconds),
    ),
    concurrency: clampSetting('concurrency', settings.concurrency),
    ...validateNotificationSettings(settings),
  };
  storage.setItem(STORAGE_KEYS.settings, JSON.stringify(normalized));
}

function normalizeStoredBaseUrl(value: unknown): string {
  if (typeof value !== 'string') return DEFAULT_API_BASE_URL;
  try {
    return normalizeApiBaseUrl(value);
  } catch {
    return DEFAULT_API_BASE_URL;
  }
}
