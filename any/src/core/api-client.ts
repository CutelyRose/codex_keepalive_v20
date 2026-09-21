export async function serverFetch(input: RequestInfo | URL, init?: RequestInit): Promise<Response> {
  const response = await fetch(input, { ...init, credentials: 'same-origin' });
  if (response.status === 401 && !String(input).startsWith('/api/auth/')) {
    globalThis.dispatchEvent?.(new Event('authentication-required'));
  }
  return response;
}

export async function serverRequest<T>(path: string, method = 'GET', body?: unknown): Promise<T> {
  const response = await serverFetch(path, {
    method, cache: 'no-store', signal: AbortSignal.timeout(30_000),
    ...(body === undefined ? {} : { headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body) }),
  });
  const data = await response.json();
  if (!response.ok) throw Object.assign(new Error(data.error || `服务请求失败：HTTP ${response.status}`), { status: response.status });
  return data as T;
}
