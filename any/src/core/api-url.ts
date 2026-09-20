export const DEFAULT_API_BASE_URL = 'https://anyrouter.top';

const ENDPOINT_NAMES = new Set(['models', 'responses', 'messages']);

export class ApiUrlError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'ApiUrlError';
  }
}

/**
 * Store service bases without the conventional trailing /v1. SDK-style URLs
 * ending in /v1 remain accepted and resolve to the same API endpoints.
 */
export function normalizeApiBaseUrl(value: string): string {
  const input = value.trim();
  if (!input) throw new ApiUrlError('API Base URL 不能为空');

  let url: URL;
  try {
    url = new URL(input);
  } catch {
    throw new ApiUrlError('API Base URL 格式无效');
  }
  if (url.protocol !== 'http:' && url.protocol !== 'https:') {
    throw new ApiUrlError('API Base URL 仅支持 http 或 https');
  }
  if (url.username || url.password) {
    throw new ApiUrlError('API Base URL 不能包含账号或密码');
  }
  if (url.search || url.hash) {
    throw new ApiUrlError('API Base URL 不能包含查询参数或锚点');
  }

  const segments = url.pathname.split('/').filter(Boolean);
  const decodedLast = decodeSegment(segments.at(-1))?.toLowerCase();
  if (decodedLast && ENDPOINT_NAMES.has(decodedLast)) {
    throw new ApiUrlError('请填写服务地址，不要填写 models、responses 或 messages 接口');
  }
  while (decodeSegment(segments.at(-1))?.toLowerCase() === 'v1') segments.pop();

  const path = segments.length ? `/${segments.join('/')}` : '';
  return `${url.origin}${path}`;
}

export type ApiEndpoint = 'models' | 'responses' | 'messages';

export function apiEndpoint(baseUrl: string, endpoint: ApiEndpoint): string {
  return `${normalizeApiBaseUrl(baseUrl)}/v1/${endpoint}`;
}

export function apiHost(baseUrl: string): string {
  return new URL(normalizeApiBaseUrl(baseUrl)).host;
}

function decodeSegment(value: string | undefined): string | undefined {
  if (value === undefined) return undefined;
  try {
    return decodeURIComponent(value);
  } catch {
    return value;
  }
}
