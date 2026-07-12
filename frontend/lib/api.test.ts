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
});
