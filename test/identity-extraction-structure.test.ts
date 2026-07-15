import { env } from 'cloudflare:workers';
import { beforeEach, describe, expect, it } from 'vitest';

import { credentialKnownAnswer } from '../scripts/identity-credential-conformance.mjs';
import {
  AUTH_COOKIE,
  authClearCookie,
  authSetCookie,
  parseAuthCookie,
} from '../src/identity/http-cookie';
import { createAuthenticatedIdentity } from './helpers/identity-fixture';

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

describe('authenticated Identity fixture', () => {
  beforeEach(async () => {
    await env.DB.batch([
      env.DB.prepare('DELETE FROM audit_logs'),
      env.DB.prepare('DELETE FROM sessions'),
      env.DB.prepare('DELETE FROM users'),
    ]);
  });

  it('creates one real Runtime session and returns the exact frozen projection', async () => {
    const fixture = await createAuthenticatedIdentity({
      role: 'staff',
      username: 'fixture-staff',
      name: 'Fixture Staff',
    });

    expect(Object.keys(fixture)).toEqual([
      'user',
      'principal',
      'rawToken',
      'cookie',
    ]);
    expect(Object.isFrozen(fixture)).toBe(true);
    expect(Object.isFrozen(fixture.user)).toBe(true);
    expect(Object.isFrozen(fixture.principal)).toBe(true);
    expect(fixture.rawToken).toMatch(
      /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/,
    );
    expect(fixture.cookie).toBe(
      `isorder_sid=${encodeURIComponent(fixture.rawToken)}`,
    );
    expect(fixture.user).toEqual({
      id: fixture.principal.userId,
      username: fixture.principal.username,
      name: fixture.principal.name,
      role: fixture.principal.role,
    });

    const user = await env.DB.prepare(
      `SELECT username, name, role, is_active, is_deleted
         FROM users
        WHERE id = ?`,
    ).bind(fixture.user.id).first();
    expect(user).toEqual({
      username: 'fixture-staff',
      name: 'Fixture Staff',
      role: 'staff',
      is_active: 1,
      is_deleted: 0,
    });
    const session = await env.DB.prepare(
      'SELECT token, user_id FROM sessions',
    ).first();
    expect(session).toEqual({
      token: fixture.rawToken,
      user_id: fixture.user.id,
    });
    const loginAudit = await env.DB.prepare(
      `SELECT actor_user_id, action, entity_type, entity_id
         FROM audit_logs`,
    ).first();
    expect(loginAudit).toEqual({
      actor_user_id: fixture.user.id,
      action: 'login',
      entity_type: 'user',
      entity_id: fixture.user.id,
    });
  });

  it('replaces every setup failure with one generic non-leaking error', async () => {
    const username = 'duplicate-fixture-user';
    const first = await createAuthenticatedIdentity({ username });

    let failure: unknown;
    try {
      await createAuthenticatedIdentity({ username });
    } catch (error) {
      failure = error;
    }

    expect(failure).toBeInstanceOf(Error);
    expect((failure as Error).message).toBe(
      'Failed to create authenticated Identity fixture.',
    );
    const rendered = String(failure);
    for (const sensitiveValue of [
      username,
      first.rawToken,
      first.cookie,
      credentialKnownAnswer.password,
      credentialKnownAnswer.currentHash,
    ]) {
      expect(rendered).not.toContain(sensitiveValue);
    }
    const counts = await env.DB.prepare(
      `SELECT
         (SELECT COUNT(*) FROM users) AS users,
         (SELECT COUNT(*) FROM sessions) AS sessions,
         (SELECT COUNT(*) FROM audit_logs WHERE action = 'login') AS login_audits`,
    ).first();
    expect(counts).toEqual({ users: 1, sessions: 1, login_audits: 1 });
  });
});
