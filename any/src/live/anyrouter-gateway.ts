import type { AuthResult } from '../core/types';
import { apiEndpoint, apiHost, DEFAULT_API_BASE_URL } from '../core/api-url';

interface ModelRecord {
  id?: unknown;
}

export interface AnyRouterGatewayOptions {
  fetchImpl?: typeof fetch;
  baseUrl?: string;
}

export class AnyRouterGateway {
  private readonly fetchImpl: typeof fetch;
  private readonly baseUrl: string;

  constructor(options: AnyRouterGatewayOptions = {}) {
    this.fetchImpl = options.fetchImpl ?? fetch.bind(globalThis);
    this.baseUrl = options.baseUrl ?? DEFAULT_API_BASE_URL;
  }

  async authenticate(key: string, baseUrl = this.baseUrl): Promise<AuthResult> {
    const host = apiHost(baseUrl);
    try {
      const response = await this.fetchImpl(apiEndpoint(baseUrl, 'models'), {
        method: 'GET',
        headers: {
          Authorization: `Bearer ${key}`,
          Accept: 'application/json',
        },
        cache: 'no-store',
      });
      if (!response.ok) {
        return { ok: false, models: [], error: `${host} · ${await errorMessage(response)}` };
      }
      const payload: unknown = await response.json();
      const data = payload && typeof payload === 'object' && 'data' in payload
        ? (payload as { data?: unknown }).data
        : undefined;
      const models = Array.isArray(data)
        ? data.flatMap((candidate): string[] => {
            const record = candidate as ModelRecord;
            return typeof record?.id === 'string' ? [record.id] : [];
          })
        : [];
      return { ok: true, models: [...new Set(models)].sort() };
    } catch (error) {
      return {
        ok: false,
        models: [],
        error: error instanceof Error ? `${host} · 网络错误：${error.message}` : `${host} · 未知网络错误`,
      };
    }
  }
}

async function errorMessage(response: Response): Promise<string> {
  let detail = '';
  try {
    const text = await response.text();
    if (text) {
      try {
        const parsed: unknown = JSON.parse(text);
        if (parsed && typeof parsed === 'object') {
          const record = parsed as { error?: { message?: unknown } | string; message?: unknown };
          detail = typeof record.error === 'string'
            ? record.error
            : typeof record.error?.message === 'string'
              ? record.error.message
              : typeof record.message === 'string'
                ? record.message
                : text;
        } else detail = text;
      } catch {
        detail = text;
      }
    }
  } catch {
    // Ignore unreadable error bodies.
  }
  const compact = detail.replace(/\s+/g, ' ').slice(0, 320);
  return `HTTP ${response.status}${compact ? ` · ${compact}` : ''}`;
}
