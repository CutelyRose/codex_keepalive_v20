import type {
  NotificationClient,
  NotificationPayload,
  NotificationReceipt,
} from '../core/types';
import { serverFetch } from '../core/api-client';

export interface NotificationApiClientOptions {
  fetchImpl?: typeof fetch;
  baseUrl?: string;
}

export class NotificationReadError extends Error {
  constructor(message: string, readonly status: number) {
    super(message);
    this.name = 'NotificationReadError';
  }
}

export class NotificationApiClient implements NotificationClient {
  private readonly fetchImpl: typeof fetch;
  private readonly baseUrl: string;

  constructor(options: NotificationApiClientOptions = {}) {
    this.fetchImpl = options.fetchImpl ?? serverFetch;
    this.baseUrl = options.baseUrl ?? '';
  }

  async enqueue(payload: NotificationPayload): Promise<NotificationReceipt> {
    const response = await this.fetchImpl(`${this.baseUrl}/api/notifications`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(payload),
      signal: AbortSignal.timeout(20_000),
    });
    if (!response.ok) throw new Error(`通知入队失败：HTTP ${response.status}`);
    return parseReceipt(await response.json());
  }

  async get(id: string): Promise<NotificationReceipt> {
    const response = await this.fetchImpl(`${this.baseUrl}/api/notifications/${encodeURIComponent(id)}`, {
      cache: 'no-store',
      signal: AbortSignal.timeout(20_000),
    });
    if (!response.ok) throw new NotificationReadError(`通知状态读取失败：HTTP ${response.status}`, response.status);
    const result = parseReceipt(await response.json());
    if (result.id !== id) throw new Error('通知回执 ID 不匹配');
    return result;
  }
}

function parseReceipt(value: unknown): NotificationReceipt {
  if (!value || typeof value !== 'object' || Array.isArray(value)) throw new Error('通知回执格式无效');
  const input = value as Record<string, unknown>;
  if (
    typeof input.id !== 'string' || !input.id || input.id.length > 160 ||
    typeof input.status !== 'string' || !['queued', 'retrying', 'sent', 'dead'].includes(input.status) ||
    !Number.isSafeInteger(input.attempts) || (input.attempts as number) < 0 ||
    (input.error !== undefined && typeof input.error !== 'string') ||
    (input.nextAttemptAt !== undefined && (
      typeof input.nextAttemptAt !== 'number' || !Number.isFinite(input.nextAttemptAt) ||
      input.nextAttemptAt < 0 || input.nextAttemptAt > Number.MAX_SAFE_INTEGER
    ))
  ) throw new Error('通知回执格式无效');
  return {
    id: input.id,
    status: input.status as NotificationReceipt['status'],
    attempts: input.attempts as number,
    ...(typeof input.error === 'string' ? { error: input.error.slice(0, 500) } : {}),
    ...(input.nextAttemptAt === undefined ? {} : { nextAttemptAt: input.nextAttemptAt as number }),
  };
}
