import { ApiEnvelope } from '@/lib/types';

export class ApiError extends Error {
  status: number;
  code?: string;

  constructor(message: string, status: number, code?: string) {
    super(message);
    this.name = 'ApiError';
    this.status = status;
    this.code = code;
  }
}

export async function apiRequest<T>(
  path: string,
  options?: RequestInit & { responseType?: 'json' | 'raw' },
): Promise<T> {
  const headers = new Headers(options?.headers as HeadersInit | undefined);
  if (options?.body) {
    headers.set('Content-Type', 'application/json');
  }

  const response = await fetch(path, {
    credentials: 'include',
    cache: 'no-store',
    headers,
    ...options,
  });

  const bodyText = await response.text();
  const body: ApiEnvelope<T> | undefined = bodyText
    ? (() => {
        try {
          return JSON.parse(bodyText) as ApiEnvelope<T>;
        } catch {
          return undefined;
        }
      })()
    : undefined;

  if (!response.ok) {
    const message = body && 'error' in body ? body.error.message : `요청 실패 (${response.status})`;
    const code = body && 'error' in body ? body.error.code : undefined;
    throw new ApiError(message, response.status, code);
  }

  if (body?.ok === false) {
    throw new ApiError(body.error.message, response.status, body.error.code);
  }

  if (!body) {
    throw new ApiError('응답을 해석할 수 없습니다.', response.status, 'INVALID_RESPONSE');
  }

  return body.data;
}

function normalizePath(path: string) {
  if (path.startsWith('http://') || path.startsWith('https://')) {
    return path;
  }
  if (path.startsWith('/')) {
    return path;
  }
  return `/${path}`;
}

export function getApiPath(path: string) {
  return normalizePath(path);
}

export function apiGet<T>(path: string, signal?: AbortSignal): Promise<T> {
  return apiRequest<T>(getApiPath(path), { method: 'GET', signal });
}

export function apiPost<T>(path: string, body?: unknown): Promise<T> {
  return apiRequest<T>(getApiPath(path), {
    method: 'POST',
    body: body == null ? undefined : JSON.stringify(body),
  });
}

export function apiPatch<T>(path: string, body?: unknown): Promise<T> {
  return apiRequest<T>(getApiPath(path), {
    method: 'PATCH',
    body: body == null ? undefined : JSON.stringify(body),
  });
}

export function apiDelete<T>(path: string): Promise<T> {
  return apiRequest<T>(getApiPath(path), { method: 'DELETE' });
}
