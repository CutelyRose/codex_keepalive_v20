import type { AppSettings } from './types';

export const DEFAULT_SETTINGS: Readonly<AppSettings> = Object.freeze({
  attempts: 300,
  intervalSeconds: 2,
  timeoutSeconds: 120,
  concurrency: 1,
  keepalive: true,
  keepaliveMinSeconds: 60,
  keepaliveMaxSeconds: 90,
  showdocPushUrl: '',
  telegramChatId: '',
  telegramBotToken: '',
  serverchanSendKey: '',
  serverchanTags: '',
});

export const LIMITS = Object.freeze({
  attempts: { min: 1 },
  intervalSeconds: { min: 0.5, max: 3_600 },
  timeoutSeconds: { min: 30, max: 600 },
  concurrency: { min: 1 },
  keepaliveMinSeconds: { min: 0.5, max: 86_400 },
  keepaliveMaxSeconds: { min: 0.5, max: 86_400 },
});

export const STORAGE_KEYS = Object.freeze({
  keys: 'anyrouter-console:keys:v1',
  settings: 'anyrouter-console:settings:v1',
  tasks: 'anyrouter-console:tasks:v1',
  theme: 'anyrouter-console:theme:v1',
});

export const MAX_EVENTS = 200;
export const MAX_RESPONSE_SUMMARY_BYTES = 8 * 1024;

export const MODEL_ID_PATTERN = String.raw`[A-Za-z0-9._:\/\[\]\-]+`;
