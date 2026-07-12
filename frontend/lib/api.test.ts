import { z } from 'zod';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { apiGetDecoded } from '@/lib/api';

afterEach(() => vi.unstubAllGlobals());

describe('decoded browser HTTP Adapter', () => {
  it('returns data only after envelope and endpoint validation', async () => {
    vi.stubGlobal('fetch', vi.fn(async () => new Response(JSON.stringify({
      ok: true,
      data: { id: 7 },
    }), { status: 200 })));

    await expect(apiGetDecoded('/contract', z.object({ id: z.number() }).strict()))
      .resolves.toEqual({ id: 7 });
  });

  it('maps malformed success data to INVALID_RESPONSE', async () => {
    vi.stubGlobal('fetch', vi.fn(async () => new Response(JSON.stringify({
      ok: true,
      data: { id: '7' },
    }), { status: 200 })));

    await expect(apiGetDecoded('/contract', z.object({ id: z.number() }).strict()))
      .rejects.toMatchObject({ status: 200, code: 'INVALID_RESPONSE' });
  });

  it('preserves a valid error envelope and HTTP status', async () => {
    vi.stubGlobal('fetch', vi.fn(async () => new Response(JSON.stringify({
      ok: false,
      error: { code: 'CONFLICT', message: '상태가 변경되었습니다.' },
    }), { status: 409 })));

    await expect(apiGetDecoded('/contract', z.object({ id: z.number() }).strict()))
      .rejects.toMatchObject({
        status: 409,
        code: 'CONFLICT',
        message: '상태가 변경되었습니다.',
      });
  });

  it('rejects a non-2xx response even when it has a valid success envelope', async () => {
    vi.stubGlobal('fetch', vi.fn(async () => new Response(JSON.stringify({
      ok: true,
      data: { id: 7 },
    }), { status: 500 })));

    await expect(apiGetDecoded('/contract', z.object({ id: z.number() }).strict()))
      .rejects.toMatchObject({
        name: 'ApiError',
        status: 500,
        message: '요청 실패 (500)',
      });
  });

  it('preserves AbortError when reading the response body is cancelled', async () => {
    const abortError = new DOMException('요청이 취소되었습니다.', 'AbortError');
    vi.stubGlobal('fetch', vi.fn(async () => ({
      ok: true,
      status: 200,
      json: vi.fn(async () => {
        throw abortError;
      }),
    } as unknown as Response)));

    await expect(apiGetDecoded('/contract', z.object({ id: z.number() }).strict()))
      .rejects.toBe(abortError);
  });
});
