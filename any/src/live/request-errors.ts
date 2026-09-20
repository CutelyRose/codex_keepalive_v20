export class ModelRequestError extends Error {
  constructor(message: string, readonly retryable = true, readonly retryAfterMs?: number) {
    super(message);
    this.name = 'ModelRequestError';
  }
}

export function retryAfterMilliseconds(value: string | null, now = Date.now()): number | undefined {
  if (!value) return undefined;
  const seconds = Number(value);
  if (Number.isFinite(seconds) && seconds >= 0) return Math.ceil(seconds * 1_000);
  const at = Date.parse(value);
  return Number.isFinite(at) ? Math.max(0, at - now) : undefined;
}

export function retryableModelError(detail: string, status?: number): boolean {
  if (/insufficient_quota|quota exceeded|insufficient credit|credit balance|billing limit|额度不足|配额不足|余额不足/i.test(detail)) return false;
  if (/invalid[ _](?:token|api[ _]key|request)|authentication_error|permission_error|not_found_error|unauthorized|令牌无效|无效的令牌|model_not_found/i.test(detail)) return false;
  const code = status ?? Number(/\bHTTP (\d{3})\b/.exec(detail)?.[1]);
  if (code) return [408, 409, 425, 429, 500, 502, 503, 504, 529].includes(code);
  return true; // Network/timeout/incomplete stream: keep the configured cadence.
}
