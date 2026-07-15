import { describe, expect, it } from 'vitest';

import {
  AUTH_COOKIE,
  authClearCookie,
  authSetCookie,
  parseAuthCookie,
} from '../src/identity/http-cookie';

describe('Identity HTTP cookie adapter', () => {
  it('keeps the established cookie name and exact serialization', () => {
    expect(AUTH_COOKIE).toBe('isorder_sid');
    expect(authSetCookie('token /+?=', false)).toEqual([
      'Set-Cookie',
      'isorder_sid=token%20%2F%2B%3F%3D; HttpOnly; Path=/; Max-Age=2592000; SameSite=Strict',
    ]);
    expect(authSetCookie('token /+?=', true)).toEqual([
      'Set-Cookie',
      'isorder_sid=token%20%2F%2B%3F%3D; HttpOnly; Path=/; Max-Age=2592000; SameSite=Strict; Secure',
    ]);
    expect(authClearCookie(false)).toEqual([
      'Set-Cookie',
      'isorder_sid=; HttpOnly; Path=/; Max-Age=0; SameSite=Strict',
    ]);
    expect(authClearCookie(true)).toEqual([
      'Set-Cookie',
      'isorder_sid=; HttpOnly; Path=/; Max-Age=0; SameSite=Strict; Secure',
    ]);
  });

  it('returns the final decoded auth value while preserving URL-cookie edge behavior', () => {
    expect(parseAuthCookie(undefined)).toBeUndefined();
    expect(parseAuthCookie('')).toBeUndefined();
    expect(parseAuthCookie('other=value; fragment; =ignored')).toBeUndefined();
    expect(parseAuthCookie('isorder_sid=first; other=a=b=c; isorder_sid=second%20token'))
      .toBe('second token');
    expect(parseAuthCookie('isorder_sid=a+b')).toBe('a+b');
    expect(parseAuthCookie('isorder_sid=first; isorder_sid=')).toBe('');
  });

  it('continues decoding every syntactic pair before returning', () => {
    for (const header of [
      'bad=%E0%A4%A; isorder_sid=token',
      'isorder_sid=%E0%A4%A',
      'isorder_sid=token; unrelated=%E0%A4%A',
    ]) {
      expect(() => parseAuthCookie(header)).toThrow(URIError);
    }
    expect(parseAuthCookie('broken-%E0%A4%A; isorder_sid=token')).toBe('token');
  });
});
